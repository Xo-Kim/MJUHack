package com.example.hack.chat;

import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;

import com.anthropic.core.JsonValue;
import com.anthropic.models.messages.CacheControlEphemeral;
import com.anthropic.models.messages.ContentBlock;
import com.anthropic.models.messages.ContentBlockParam;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.OutputConfig;
import com.anthropic.models.messages.StopReason;
import com.anthropic.models.messages.TextBlockParam;
import com.anthropic.models.messages.ToolResultBlockParam;
import com.anthropic.models.messages.ToolUseBlock;
import com.example.hack.chat.ChatDtos.ChatReply;
import com.example.hack.chat.ChatDtos.Location;
import com.example.hack.chat.ChatDtos.MessageResponse;
import com.example.hack.common.ApiException;
import com.example.hack.course.CourseDtos.CourseResponse;
import com.example.hack.course.CourseService;
import com.example.hack.session.SessionDtos.SessionResponse;
import com.example.hack.session.SessionService;

/**
 * 챗봇과 AI 코스 추천의 대화 처리. 서버가 대화 기록과 사용자 상태를 들고 있다가 매 요청에 함께 보낸다.
 * 장소 필터링과 계산은 도구(서버)가 하고 Claude 는 설명과 대화만 맡는다.
 */
@Service
public class ChatService {

    private static final Logger log = LoggerFactory.getLogger(ChatService.class);
    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final int MAX_CONTENT_LENGTH = 2000;
    private static final Pattern SPOT_TAG = Pattern.compile("\\[((?:SDM|MPO|EPY|JNG)\\d{2}|[A-Z]{2,4}\\d{2,3})\\]");
    private static final Pattern SPOT_ID = Pattern.compile("\\b(?:SDM|MPO|EPY|JNG)\\d{2}\\b");

    static final String REFUSAL_REPLY = "죄송합니다. 이 요청에는 답변을 드리기 어렵습니다. 장소나 코스에 대해 다시 물어봐 주세요.";
    static final String ROUNDS_REPLY = "요청을 처리하는 데 단계가 너무 많이 필요했습니다. 조건을 조금 나눠서 다시 말씀해 주세요.";
    static final String EMPTY_REPLY = "답변을 만들지 못했습니다. 다시 한 번 말씀해 주세요.";

    private final ClaudeGateway claude;
    private final ClaudeProperties props;
    private final ChatTools tools;
    private final ChatPrompts prompts;
    private final SessionService sessions;
    private final CourseService courses;
    private final JdbcClient jdbc;

    public ChatService(ClaudeGateway claude, ClaudeProperties props, ChatTools tools, ChatPrompts prompts,
            SessionService sessions, CourseService courses, JdbcClient jdbc) {
        this.claude = claude;
        this.props = props;
        this.tools = tools;
        this.prompts = prompts;
        this.sessions = sessions;
        this.courses = courses;
        this.jdbc = jdbc;
    }

    /** 사용자 메시지 하나에 답한다. Claude 호출이 실패하면 대화 기록은 바뀌지 않는다 (코스 도구 결과는 이미 저장되었을 수 있다). */
    public ChatReply send(String sessionId, String content, Location location) {
        if (content == null || content.isBlank()) {
            throw ApiException.badRequest("내용을 입력해 주세요.");
        }
        if (content.length() > MAX_CONTENT_LENGTH) {
            throw ApiException.badRequest("내용은 " + MAX_CONTENT_LENGTH + "자 이내로 입력해 주세요.");
        }
        validate(location);
        SessionResponse before = sessions.get(sessionId);
        List<StoredMessage> history = recentMessages(sessionId);

        MessageCreateParams.Builder request = baseRequest(before, location);
        history.forEach(m -> {
            if ("USER".equals(m.role())) {
                request.addUserMessage(m.content());
            } else {
                request.addAssistantMessage(m.content());
            }
        });
        request.addUserMessage(content);

        Set<String> allowedIds = new HashSet<>();
        history.forEach(m -> allowedIds.addAll(spotIdsIn(m.content())));
        if (before.currentCourseId() != null) {
            courses.get(before.currentCourseId()).stops().forEach(s -> allowedIds.add(s.spot().id()));
        }

        String reply = runToolLoop(request, new ChatTools.Turn(sessionId, location), allowedIds);
        String cleaned = removeUnverifiedSpotTags(reply, allowedIds);

        insert(sessionId, "USER", content);
        long messageId = insert(sessionId, "ASSISTANT", cleaned);
        sessions.touch(sessionId);

        SessionResponse after = sessions.get(sessionId);
        CourseResponse course = after.currentCourseId() != null
                && !Objects.equals(after.currentCourseId(), before.currentCourseId())
                ? courses.get(after.currentCourseId()) : null;
        return new ChatReply(sessionId, findMessage(messageId), after, course,
                new ArrayList<>(new LinkedHashSet<>(tagsIn(cleaned))));
    }

    public List<MessageResponse> messages(String sessionId) {
        sessions.requireActive(sessionId);
        return jdbc.sql("""
                SELECT id, role, content, created_at FROM chat_message
                WHERE session_id = ? AND role <> 'TOOL' ORDER BY id
                """).param(sessionId).query((rs, i) -> toMessage(rs.getLong("id"), rs.getString("role"),
                        rs.getString("content"), rs.getTimestamp("created_at"))).list();
    }

    // ---- 도구 반복 ------------------------------------------------------------------------------------

    private String runToolLoop(MessageCreateParams.Builder request, ChatTools.Turn turn, Set<String> allowedIds) {
        for (int round = 0; round < props.maxToolRounds(); round++) {
            Message response = claude.create(request.build());
            StopReason stop = response.stopReason().orElse(null);

            if (StopReason.REFUSAL.equals(stop)) {
                log.warn("Claude refused: {}", response.stopDetails().map(Object::toString).orElse("(no details)"));
                return REFUSAL_REPLY;
            }
            if (!StopReason.TOOL_USE.equals(stop)) {
                String text = textOf(response);
                if (StopReason.MAX_TOKENS.equals(stop)) {
                    log.warn("Claude hit max_tokens");
                }
                return text.isBlank() ? EMPTY_REPLY : text;
            }

            // 응답 전체(thinking 포함)를 그대로 되돌려 보낸다
            request.addMessage(response);
            List<ContentBlockParam> results = new ArrayList<>();
            for (ContentBlock block : response.content()) {
                block.toolUse().ifPresent(use -> results.add(runTool(use, turn, allowedIds)));
            }
            request.addUserMessageOfContentBlockParams(results);
        }
        log.warn("Tool loop exceeded {} rounds for session {}", props.maxToolRounds(), turn.sessionId());
        return ROUNDS_REPLY;
    }

    @SuppressWarnings("unchecked")
    private ContentBlockParam runTool(ToolUseBlock use, ChatTools.Turn turn, Set<String> allowedIds) {
        ToolResultBlockParam.Builder result = ToolResultBlockParam.builder().toolUseId(use.id());
        try {
            Map<String, Object> input = use._input().convert(Map.class);
            String output = tools.execute(use.name(), input == null ? Map.of() : input, turn);
            allowedIds.addAll(spotIdsIn(output));
            result.content(output);
        } catch (ApiException e) {
            // 조건 불일치 등은 Claude 가 사용자에게 설명하거나 다른 방법을 찾게 돌려준다
            result.content(e.getMessage()).isError(true);
        } catch (RuntimeException e) {
            log.error("Tool {} failed", use.name(), e);
            result.content("도구 실행 중 서버 오류가 났습니다. 이 정보 없이 답하고, 필요하면 사용자에게 다시 시도를 안내하세요.").isError(true);
        }
        return ContentBlockParam.ofToolResult(result.build());
    }

    private MessageCreateParams.Builder baseRequest(SessionResponse session, Location location) {
        MessageCreateParams.Builder b = MessageCreateParams.builder()
                .model(props.model())
                .maxTokens(props.maxTokens())
                .outputConfig(OutputConfig.builder().effort(OutputConfig.Effort.of(props.effort())).build())
                // 안전 분류기가 거절하면 서버가 권장 모델로 다시 시도한다
                .putAdditionalHeader("anthropic-beta", "server-side-fallback-2026-07-01")
                .putAdditionalBodyProperty("fallbacks", JsonValue.from("default"))
                .systemOfTextBlockParams(List.of(
                        // 고정 부분만 캐시한다. 상태는 매번 바뀌므로 그 뒤에 둔다
                        TextBlockParam.builder().text(prompts.stable())
                                .cacheControl(CacheControlEphemeral.builder().build()).build(),
                        TextBlockParam.builder().text(prompts.state(session, location)).build()));
        tools.definitions().forEach(b::addTool);
        return b;
    }

    // ---- 응답 다듬기 -----------------------------------------------------------------------------------

    private static String textOf(Message response) {
        return response.content().stream()
                .flatMap(block -> block.text().stream())
                .map(t -> t.text())
                .collect(Collectors.joining("\n"))
                .trim();
    }

    /** 도구 결과나 이전 대화에 없던 장소 ID 는 지운다. 없는 장소로 지도를 연결하지 않기 위해서다. */
    static String removeUnverifiedSpotTags(String text, Set<String> allowed) {
        Matcher m = SPOT_TAG.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            boolean ok = allowed.contains(m.group(1));
            if (!ok) {
                log.warn("Removed unverified spot id from reply: {}", m.group(1));
            }
            m.appendReplacement(out, ok ? Matcher.quoteReplacement(m.group()) : "");
        }
        m.appendTail(out);
        return out.toString().replaceAll(" +([.,!?。])", "$1").trim();
    }

    private static List<String> tagsIn(String text) {
        List<String> ids = new ArrayList<>();
        Matcher m = SPOT_TAG.matcher(text);
        while (m.find()) {
            ids.add(m.group(1));
        }
        return ids;
    }

    private static Set<String> spotIdsIn(String text) {
        Set<String> ids = new HashSet<>();
        Matcher m = SPOT_ID.matcher(text);
        while (m.find()) {
            ids.add(m.group());
        }
        return ids;
    }

    private static void validate(Location l) {
        if (l == null) {
            return;
        }
        if (l.latitude() == null || l.longitude() == null || Math.abs(l.latitude()) > 90 || Math.abs(l.longitude()) > 180) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "location 좌표가 올바르지 않습니다.");
        }
    }

    // ---- 저장 -----------------------------------------------------------------------------------------

    private record StoredMessage(String role, String content) {
    }

    /** 최근 대화. 첫 메시지가 사용자 메시지가 되도록 앞을 잘라낸다. */
    private List<StoredMessage> recentMessages(String sessionId) {
        List<StoredMessage> rows = new ArrayList<>(jdbc.sql("""
                SELECT role, content FROM chat_message
                WHERE session_id = ? AND role IN ('USER', 'ASSISTANT') ORDER BY id DESC LIMIT ?
                """).params(sessionId, props.historyMessages())
                .query((rs, i) -> new StoredMessage(rs.getString("role"), rs.getString("content"))).list());
        java.util.Collections.reverse(rows);
        while (!rows.isEmpty() && !"USER".equals(rows.get(0).role())) {
            rows.remove(0);
        }
        return rows;
    }

    private long insert(String sessionId, String role, String content) {
        GeneratedKeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql("INSERT INTO chat_message (session_id, role, content) VALUES (?, ?, ?)")
                .params(sessionId, role, content).update(keys);
        return keys.getKey().longValue();
    }

    private MessageResponse findMessage(long id) {
        return jdbc.sql("SELECT id, role, content, created_at FROM chat_message WHERE id = ?").param(id)
                .query((rs, i) -> toMessage(rs.getLong("id"), rs.getString("role"), rs.getString("content"),
                        rs.getTimestamp("created_at"))).single();
    }

    private static MessageResponse toMessage(long id, String role, String content, Timestamp createdAt) {
        LocalDateTime t = createdAt.toLocalDateTime();
        return new MessageResponse(id, role, content, t.atZone(SEOUL).toOffsetDateTime());
    }
}

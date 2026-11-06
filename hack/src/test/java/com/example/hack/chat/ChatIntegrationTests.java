package com.example.hack.chat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.notNullValue;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import com.anthropic.core.ObjectMappers;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.example.hack.TestcontainersConfiguration;
import com.example.hack.common.ApiException;
import com.jayway.jsonpath.JsonPath;

/** 실제 Claude 대신 미리 적어 둔 응답으로 도구 반복, 저장, 검증 흐름을 확인한다. */
@SpringBootTest
@AutoConfigureMockMvc
@Import({TestcontainersConfiguration.class, ChatIntegrationTests.FakeConfig.class})
class ChatIntegrationTests {

    static class FakeClaude implements ClaudeGateway {
        final Deque<Object> replies = new ArrayDeque<>();
        final List<MessageCreateParams> requests = new ArrayList<>();

        @Override
        public Message create(MessageCreateParams params) {
            requests.add(params);
            Object next = replies.removeFirst();
            if (next instanceof RuntimeException e) {
                throw e;
            }
            return (Message) next;
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class FakeConfig {
        @Bean
        @Primary
        FakeClaude fakeClaude() {
            return new FakeClaude();
        }
    }

    @Autowired
    MockMvc mvc;

    @Autowired
    FakeClaude claude;

    @BeforeEach
    void reset() {
        claude.replies.clear();
        claude.requests.clear();
    }

    private static Message message(String stopReason, String contentJson) throws Exception {
        return ObjectMappers.jsonMapper().readValue("""
                {"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5",
                 "content":%s,"stop_reason":"%s","stop_sequence":null,
                 "usage":{"input_tokens":1,"output_tokens":1}}
                """.formatted(contentJson, stopReason), Message.class);
    }

    private static Message toolCall(String name, String inputJson) throws Exception {
        return message("tool_use", """
                [{"type":"text","text":"잠시만요."},
                 {"type":"tool_use","id":"toolu_1","name":"%s","input":%s}]
                """.formatted(name, inputJson));
    }

    private static Message answer(String text) throws Exception {
        return message("end_turn", "[{\"type\":\"text\",\"text\":\"" + text + "\"}]");
    }

    private String newSession(String body) throws Exception {
        String created = mvc.perform(post("/api/chat/sessions").contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse().getContentAsString();
        return JsonPath.read(created, "$.id");
    }

    @Test
    void recommendFromFreeTextBuildsCourseThenRemovesUnverifiedIds() throws Exception {
        claude.replies.add(toolCall("recommend_course", """
                {"user_types":["WHEELCHAIR"],"k_content_id":5,"start_spot_id":"SDM10","start_label":"명지대"}
                """));
        claude.replies.add(answer("「1987」의 시대를 걸어요. 강경대 민주광장 [SDM01]에서 시작합니다. 가짜 장소 [SDM99]도 있어요."));

        String res = mvc.perform(post("/api/courses/recommend").contentType(MediaType.APPLICATION_JSON).content("""
                {"context":"휠체어 타요. 1987 봤어요. 명지대에서 출발해요."}
                """))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.sessionId").value(notNullValue()))
                .andExpect(jsonPath("$.course.id").value(notNullValue()))
                .andExpect(jsonPath("$.course.eraIds[0]").value("MODERN"))
                .andExpect(jsonPath("$.session.userTypes[0]").value("WHEELCHAIR"))
                .andExpect(jsonPath("$.session.kContentId").value(5))
                .andExpect(jsonPath("$.session.startLabel").value("명지대"))
                .andExpect(jsonPath("$.message.role").value("ASSISTANT"))
                // 서버 데이터에 없는 ID 는 답변과 목록에서 빠진다
                .andExpect(jsonPath("$.referencedSpotIds", is(List.of("SDM01"))))
                .andReturn().getResponse().getContentAsString();
        assertThat(JsonPath.<String>read(res, "$.message.content")).contains("[SDM01]").doesNotContain("SDM99");

        // 두 번째 요청에 도구 결과가 실려 갔고, 설명 근거(이야기·접근성)가 들어 있다
        assertThat(claude.requests).hasSize(2);
        String second = claude.requests.get(1).toString();
        assertThat(second).contains("toolu_1").contains("강경대").contains("server_reason");

        // 대화는 사용자·답변 두 개만 저장되고 도구 기록은 보이지 않는다
        String sessionId = JsonPath.read(res, "$.sessionId");
        mvc.perform(get("/api/chat/sessions/" + sessionId + "/messages"))
                .andExpect(jsonPath("$", hasSize(2)))
                .andExpect(jsonPath("$[0].role").value("USER"))
                .andExpect(jsonPath("$[1].role").value("ASSISTANT"));
    }

    @Test
    void followUpEditsCourseAndSendsHistoryAndState() throws Exception {
        String sessionId = newSession("""
                {"userTypes":["WHEELCHAIR"],"eraId":"JOSEON","startSpotId":"SDM10","startLabel":"명지대"}
                """);
        claude.replies.add(toolCall("recommend_course", "{\"stop_count\":3}"));
        claude.replies.add(answer("코스를 만들었어요."));
        String first = send(sessionId, "코스 짜줘", 200);
        String secondSpot = JsonPath.read(first, "$.course.stops[1].spot.id");
        Integer firstCourseId = JsonPath.read(first, "$.course.id");

        claude.replies.add(toolCall("update_course", "{\"action\":\"replace\",\"position\":2,\"spot_id\":\"JNG12\"}"));
        claude.replies.add(answer("두 번째를 경복궁 [JNG12]으로 바꿨어요."));
        String second = send(sessionId, "두 번째 장소 빼고 경복궁 넣어줘", 200);

        assertThat(JsonPath.<Integer>read(second, "$.course.id")).isNotEqualTo(firstCourseId);
        assertThat(JsonPath.<String>read(second, "$.course.stops[1].spot.id")).isEqualTo("JNG12").isNotEqualTo(secondSpot);
        assertThat(JsonPath.<String>read(second, "$.course.reason")).contains("수정");

        // 이전 대화와 현재 코스 상태가 함께 전달된다
        String sent = claude.requests.get(2).toString();
        assertThat(sent).contains("코스 짜줘").contains("코스를 만들었어요.").contains("현재 코스: 1.");
    }

    @Test
    void cannotAddSpotThatFailsRequiredAccessibility() throws Exception {
        String sessionId = newSession("""
                {"userTypes":["WHEELCHAIR"],"eraId":"JOSEON","startSpotId":"SDM10"}
                """);
        claude.replies.add(toolCall("recommend_course", "{\"stop_count\":3}"));
        claude.replies.add(answer("코스예요."));
        send(sessionId, "코스 짜줘", 200);

        // 안산 봉수대는 휠체어 접근로 '없음'이다. 서버가 막고 Claude 에게 오류로 돌려준다
        claude.replies.add(toolCall("update_course", "{\"action\":\"add\",\"spot_id\":\"SDM07\"}"));
        claude.replies.add(answer("안산 봉수대는 휠체어로 갈 수 없어 넣지 못했어요."));
        String reply = send(sessionId, "안산 봉수대 넣어줘", 200);

        assertThat(JsonPath.<Object>read(reply, "$.course")).isNull();
        String retry = claude.requests.get(claude.requests.size() - 1).toString();
        assertThat(retry).contains("이용자 조건에 맞지 않습니다").contains("isError=true");
    }

    @Test
    void exactLocationIsUsedForDistanceButNeverSentToClaudeOrStored() throws Exception {
        String sessionId = newSession("{\"eraId\":\"MODERN\"}");
        claude.replies.add(toolCall("recommend_course", "{\"use_current_location\":true,\"stop_count\":3}"));
        claude.replies.add(answer("현재 위치에서 가까운 코스예요."));

        String body = """
                {"content":"여기서 가까운 코스","location":{"latitude":37.58123456,"longitude":126.92345678}}
                """;
        String reply = mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.course.startLabel").value("현재 위치"))
                .andReturn().getResponse().getContentAsString();

        assertThat(claude.requests.get(0).toString()).contains("현재 위치: 있음").doesNotContain("37.58123456");
        assertThat(claude.requests.get(1).toString()).doesNotContain("37.58123456").doesNotContain("126.92345678");
        assertThat(reply).doesNotContain("37.58123456");
    }

    @Test
    void mccFallbackLocationReachesToolsAndPromptWithoutCoordinates() throws Exception {
        String sessionId = newSession("{\"eraId\":\"MODERN\"}");
        claude.replies.add(toolCall("recommend_course", "{\"use_current_location\":true,\"stop_count\":3}"));
        claude.replies.add(answer("명지대 MCC 기준 코스예요."));
        mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages").contentType(MediaType.APPLICATION_JSON).content("""
                {"content":"코스 짜줘","location":{"latitude":37.58,"longitude":126.9238,"fallback":true}}
                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.course.startLabel").value("명지대 MCC"))
                .andExpect(jsonPath("$.course.stops[0].spot.id").value("SDM02"));
        assertThat(claude.requests.get(0).toString()).contains("명지대 MCC 를 기준점으로").doesNotContain("126.9238");
    }

    @Test
    void nearbySearchMarksPlacesWithoutEvidence() throws Exception {
        String sessionId = newSession("{}");
        claude.replies.add(toolCall("search_nearby_places", "{\"category\":\"restaurant\",\"near_spot_id\":\"JNG12\",\"radius_km\":2}"));
        claude.replies.add(answer("근처 식당을 찾았어요. 접근성은 확인되지 않았어요."));
        send(sessionId, "경복궁 근처 식당", 200);
        assertThat(claude.requests.get(1).toString()).contains("distance_km").contains("접근성 근거가 없다");
    }

    @Test
    void refusalAndToolLimitGiveSafeRepliesAndLlmFailureKeepsHistoryClean() throws Exception {
        String sessionId = newSession("{}");

        claude.replies.add(message("refusal", "[]"));
        mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"안녕\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.message.content").value(ChatService.REFUSAL_REPLY))
                .andExpect(jsonPath("$.course").value(nullValue()));

        for (int i = 0; i < 6; i++) {
            claude.replies.add(toolCall("find_spots", "{\"era_id\":\"MODERN\"}"));
        }
        mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"계속 찾아줘\"}"))
                .andExpect(jsonPath("$.message.content").value(ChatService.ROUNDS_REPLY));

        // Claude 호출이 실패하면 502 를 주고 이번 메시지는 저장하지 않는다
        claude.replies.add(new ApiException(HttpStatus.BAD_GATEWAY, "LLM_UNAVAILABLE", "AI 응답을 받지 못했습니다."));
        mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"실패할 메시지\"}"))
                .andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.code").value("LLM_UNAVAILABLE"));
        mvc.perform(get("/api/chat/sessions/" + sessionId + "/messages")).andExpect(jsonPath("$", hasSize(4)));
    }

    @Test
    void requestUsesConfiguredModelFallbackAndCachedSystemPrompt() throws Exception {
        String sessionId = newSession("{\"userTypes\":[\"VISUAL\"]}");
        claude.replies.add(answer("안녕하세요."));
        send(sessionId, "안녕", 200);

        MessageCreateParams sent = claude.requests.get(0);
        assertThat(sent.model().asString()).isEqualTo("claude-opus-5-5");
        assertThat(sent.tools().orElseThrow()).hasSize(6);
        String text = sent.toString();
        assertThat(text).contains("server-side-fallback-2026-07-01").contains("fallbacks")
                .contains("촬영지라고 말하지 않는다").contains("1987").contains("VISUAL");
    }

    @Test
    void invalidInputIsRejectedWithoutCallingClaude() throws Exception {
        String sessionId = newSession("{}");
        mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"  \"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"hi\",\"location\":{\"latitude\":999,\"longitude\":0}}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/courses/recommend").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());
        mvc.perform(post("/api/chat/sessions/00000000-0000-0000-0000-000000000000/messages")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"content\":\"hi\"}"))
                .andExpect(status().isNotFound());
        assertThat(claude.requests).isEmpty();
    }

    private String send(String sessionId, String content, int expected) throws Exception {
        return mvc.perform(post("/api/chat/sessions/" + sessionId + "/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"" + content + "\"}"))
                .andExpect(status().is(expected))
                .andReturn().getResponse().getContentAsString();
    }
}

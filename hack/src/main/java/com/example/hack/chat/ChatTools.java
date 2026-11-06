package com.example.hack.chat;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

import com.anthropic.core.JsonValue;
import com.anthropic.models.messages.Tool;
import com.example.hack.chat.ChatDtos.Location;
import com.example.hack.common.ApiException;
import com.example.hack.common.GeoUtils;
import com.example.hack.course.CourseDtos.CourseRequest;
import com.example.hack.course.CourseDtos.CourseResponse;
import com.example.hack.course.CourseDtos.Start;
import com.example.hack.course.CourseDtos.Stop;
import com.example.hack.course.CourseService;
import com.example.hack.kto.BarrierFreeNormalizer;
import com.example.hack.reference.ReferenceRepository;
import com.example.hack.session.SessionDtos.SessionRequest;
import com.example.hack.session.SessionDtos.SessionResponse;
import com.example.hack.session.SessionService;
import com.example.hack.spot.SpotDtos.AccessibilityItem;
import com.example.hack.spot.SpotDtos.SpotDetail;
import com.example.hack.spot.SpotRepository;

import tools.jackson.databind.json.JsonMapper;

/**
 * Claude 가 부를 수 있는 도구. 장소 필터링·접근성 판단·거리 계산은 모두 여기(서버)에서 하고,
 * Claude 는 그 결과를 설명만 한다. 사용자의 실제 좌표는 도구 입력·결과 어디에도 드러나지 않는다.
 */
@Component
public class ChatTools {

    /** 이번 답변 한 번의 맥락. */
    public record Turn(String sessionId, Location location) {
    }

    private static final Map<String, String> CATEGORY_TYPES = Map.of(
            "restaurant", "39", "attraction", "12", "culture", "14", "shopping", "38", "lodging", "32");
    private static final double DEFAULT_RADIUS_KM = 1.0;
    private static final double MAX_RADIUS_KM = 5.0;
    private static final int NEARBY_LIMIT = 5;

    private final SpotRepository spots;
    private final ReferenceRepository reference;
    private final CourseService courses;
    private final SessionService sessions;
    private final JdbcClient jdbc;
    private final JsonMapper json;

    public ChatTools(SpotRepository spots, ReferenceRepository reference, CourseService courses,
            SessionService sessions, JdbcClient jdbc, JsonMapper json) {
        this.spots = spots;
        this.reference = reference;
        this.courses = courses;
        this.sessions = sessions;
        this.jdbc = jdbc;
        this.json = json;
    }

    // ---- 도구 정의 (순서가 바뀌면 프롬프트 캐시가 깨지므로 고정) ---------------------------------------

    public List<Tool> definitions() {
        Map<String, Object> userTypes = Map.of("type", "array", "description", "이용자 유형 코드 목록",
                "items", Map.of("type", "string", "enum", List.of("WHEELCHAIR", "ELDERLY", "STROLLER", "VISUAL", "HEARING")));
        Map<String, Object> eraId = Map.of("type", "string", "enum", List.of("JOSEON", "OPENING_COLONIAL", "MODERN"));
        Map<String, Object> str = Map.of("type", "string");
        Map<String, Object> intg = Map.of("type", "integer");

        return List.of(
                tool("find_spots", "역사 장소 목록을 시대·작품·구로 찾는다. 코스에 없는 장소를 추천하거나 대체 후보를 고를 때 쓴다.",
                        props("era_id", eraId, "k_content_id", desc(intg, "작품 ID"),
                                "district_id", Map.of("type", "string", "enum", List.of("SDM", "MPO", "EPY", "JNG"))),
                        List.of()),
                tool("get_spot_detail", "장소 하나의 이야기, 접근성 원문, 출처, 시기 연결을 조회한다. 시설이나 역사를 설명하기 전에 쓴다.",
                        props("spot_id", desc(str, "예: SDM09")), List.of("spot_id")),
                tool("recommend_course",
                        "사용자 조건으로 코스(장소 3~5곳)를 만들고 현재 코스로 저장한다. 시대나 작품, 출발지 중 빠진 것이 있으면 먼저 사용자에게 묻는다."
                                + " 이미 세션에 저장된 조건은 다시 넣지 않아도 된다.",
                        props("user_types", userTypes, "era_id", eraId, "k_content_id", desc(intg, "작품 ID"),
                                "start_spot_id", desc(str, "출발지가 우리 장소일 때의 ID"),
                                "start_label", desc(str, "출발지 표시 이름 (예: 명지대 정문)"),
                                "use_current_location", Map.of("type", "boolean",
                                        "description", "사용자의 현재 위치에서 출발. 상태에 현재 위치 있음일 때만 true"),
                                "time_budget_min", desc(intg, "여유 시간(분)"),
                                "stop_count", desc(intg, "장소 수 3~5")),
                        List.of()),
                tool("update_course", "현재 코스에서 장소를 빼거나 넣거나 바꾼다. 넣는 장소는 서버가 접근성 조건을 다시 검사한다.",
                        props("action", Map.of("type", "string", "enum", List.of("remove", "add", "replace")),
                                "position", desc(intg, "1부터 시작하는 순서. add 에서 생략하면 맨 뒤"),
                                "spot_id", desc(str, "add, replace 에서 넣을 장소 ID")),
                        List.of("action")),
                tool("update_user_state", "대화에서 알게 된 조건(이용자 유형, 시대, 작품, 출발지, 여유 시간)을 세션에 저장한다.",
                        props("user_types", userTypes, "era_id", eraId, "k_content_id", desc(intg, "작품 ID"),
                                "start_spot_id", str, "start_label", str, "time_budget_min", intg),
                        List.of()),
                tool("search_nearby_places",
                        "장소나 현재 위치 주변의 식당·관광지 등을 관광공사 데이터에서 찾는다. 접근성 근거가 없는 곳은 access 가 비어 있으며, 그런 곳은 접근 가능하다고 말하면 안 된다.",
                        props("category", Map.of("type", "string", "enum", List.of("restaurant", "attraction", "culture", "shopping", "lodging")),
                                "near_spot_id", desc(str, "기준 장소 ID. 생략하면 현재 위치, 없으면 출발지"),
                                "radius_km", Map.of("type", "number", "description", "반경 km, 최대 5")),
                        List.of("category")));
    }

    private static Tool tool(String name, String description, Map<String, Object> properties, List<String> required) {
        Tool.InputSchema.Properties.Builder p = Tool.InputSchema.Properties.builder();
        properties.forEach((k, v) -> p.putAdditionalProperty(k, JsonValue.from(v)));
        return Tool.builder()
                .name(name)
                .description(description)
                .inputSchema(Tool.InputSchema.builder().properties(p.build()).required(required)
                        .putAdditionalProperty("additionalProperties", JsonValue.from(false)).build())
                .build();
    }

    private static Map<String, Object> desc(Map<String, Object> base, String description) {
        Map<String, Object> m = new LinkedHashMap<>(base);
        m.put("description", description);
        return m;
    }

    /** 키 순서를 고정한 속성 맵. */
    private static Map<String, Object> props(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    // ---- 실행 ---------------------------------------------------------------------------------------

    /** @return JSON 문자열. 잘못된 입력·조건 불일치는 {@link ApiException} 으로 던진다 (호출자가 is_error 로 돌려준다) */
    public String execute(String name, Map<String, Object> input, Turn turn) {
        Object result = switch (name) {
            case "find_spots" -> findSpots(input);
            case "get_spot_detail" -> spotDetail(text(input, "spot_id"));
            case "recommend_course" -> recommendCourse(input, turn);
            case "update_course" -> courseView(courses.edit(turn.sessionId(), text(input, "action"),
                    integer(input, "position"), text(input, "spot_id")));
            case "update_user_state" -> sessions.update(turn.sessionId(), stateFrom(input));
            case "search_nearby_places" -> searchNearby(input, turn);
            default -> throw ApiException.badRequest("알 수 없는 도구입니다: " + name);
        };
        return json.writeValueAsString(result);
    }

    private Object findSpots(Map<String, Object> input) {
        String eraId = text(input, "era_id");
        Long kContentId = number(input, "k_content_id");
        List<String> eraIds = null;
        if (eraId != null) {
            eraIds = List.of(eraId);
        } else if (kContentId != null) {
            eraIds = reference.findEraIdsOfKContent(kContentId)
                    .orElseThrow(() -> ApiException.badRequest("알 수 없는 작품 ID: " + kContentId));
        }
        var found = spots.search(eraIds, text(input, "district_id"), false);
        var access = spots.accessibilityBySpot(found.stream().map(s -> s.id()).toList());
        List<Map<String, Object>> out = new ArrayList<>();
        for (var s : found) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", s.id());
            m.put("name", s.name());
            m.put("era_id", s.eraId());
            m.put("district_id", s.districtId());
            m.put("can_be_in_course", s.latitude() != null);
            m.put("story_short", s.storyShort());
            m.put("cross_link_ids", s.crossLinkIds());
            Map<String, String> statuses = new LinkedHashMap<>();
            access.getOrDefault(s.id(), List.of()).forEach(a -> statuses.put(a.featureCode(), a.status()));
            m.put("access", statuses);
            out.add(m);
        }
        return Map.of("spots", out, "note", "access 에 없는 항목은 미확인이다.");
    }

    private Object spotDetail(String spotId) {
        if (spotId == null) {
            throw ApiException.badRequest("spot_id 가 필요합니다.");
        }
        SpotDetail d = spots.findDetail(spotId)
                .orElseThrow(() -> ApiException.badRequest("없는 장소입니다: " + spotId + ". find_spots 로 찾으세요."));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", d.id());
        m.put("name", d.name());
        m.put("district", d.districtName());
        m.put("era_id", d.eraId());
        m.put("era_detail", d.eraDetail());
        m.put("year", d.yearLabel());
        m.put("category", d.category());
        m.put("address", d.address());
        m.put("story_short", d.storyShort());
        m.put("hidden_fact", d.hiddenFact());
        m.put("verify_note", d.verifyNote());
        m.put("review_status", d.reviewStatus());
        m.put("accessibility", d.accessibility().stream().map(ChatTools::accessView).toList());
        m.put("cross_links", d.crossLinks());
        m.put("sources", d.sources());
        m.put("articles", d.articles());
        return m;
    }

    private static Map<String, Object> accessView(AccessibilityItem a) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("feature", a.featureName());
        m.put("status", a.status());
        m.put("text", a.rawText());
        m.put("provider", a.provider());
        m.put("checked_at", a.checkedAt() == null ? null : a.checkedAt().toString());
        return m;
    }

    private Object recommendCourse(Map<String, Object> input, Turn turn) {
        // 조건을 먼저 세션에 저장한다. 후속 대화가 같은 조건을 쓰게 하기 위해서다.
        sessions.update(turn.sessionId(), stateFrom(input));
        Start start = null;
        if (Boolean.TRUE.equals(input.get("use_current_location"))) {
            Location l = turn.location();
            if (l == null || l.latitude() == null || l.longitude() == null) {
                throw ApiException.badRequest("현재 위치를 받지 못했습니다. 사용자에게 출발지를 물어보세요.");
            }
            start = new Start(null, l.isFallback() ? "명지대 MCC" : "현재 위치", l.latitude(), l.longitude());
        } else if (text(input, "start_spot_id") != null) {
            start = new Start(text(input, "start_spot_id"), text(input, "start_label"), null, null);
        }
        return courseView(courses.create(new CourseRequest(turn.sessionId(), null, null, null, start, null,
                integer(input, "stop_count"))));
    }

    /** 코스 + 설명에 필요한 근거. Claude 는 이 안에서만 설명한다. */
    private Object courseView(CourseResponse c) {
        List<Map<String, Object>> stops = new ArrayList<>();
        for (Stop s : c.stops()) {
            SpotDetail d = spots.findDetail(s.spot().id()).orElseThrow();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("order", s.order());
            m.put("id", d.id());
            m.put("name", d.name());
            m.put("era_id", d.eraId());
            m.put("year", d.yearLabel());
            m.put("distance_from_prev_km", s.distanceFromPrevKm());
            m.put("story_short", d.storyShort());
            m.put("hidden_fact", d.hiddenFact());
            m.put("access_memo", s.accessMemo());
            m.put("unknown_required", s.unknownFeatures());
            m.put("accessibility", d.accessibility().stream().map(ChatTools::accessView).toList());
            m.put("cross_link", d.crossLinks().stream().filter(l -> l.id().equals(s.crossLinkId())).findFirst().orElse(null));
            stops.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("course_id", c.id());
        out.put("era_ids", c.eraIds());
        out.put("user_types", c.userTypes());
        out.put("start_label", c.startLabel());
        out.put("server_reason", c.reason());
        out.put("stops", stops);
        out.put("excluded", c.excluded());
        out.put("warnings", c.warnings());
        return out;
    }

    private SessionRequest stateFrom(Map<String, Object> input) {
        return new SessionRequest(strings(input, "user_types"), text(input, "era_id"), number(input, "k_content_id"),
                text(input, "start_spot_id"), text(input, "start_label"), integer(input, "time_budget_min"));
    }

    private Object searchNearby(Map<String, Object> input, Turn turn) {
        String type = CATEGORY_TYPES.get(String.valueOf(input.get("category")));
        if (type == null) {
            throw ApiException.badRequest("category 는 " + Set.copyOf(CATEGORY_TYPES.keySet()) + " 중 하나여야 합니다.");
        }
        double[] origin = nearbyOrigin(text(input, "near_spot_id"), turn);
        double radius = input.get("radius_km") instanceof Number n
                ? Math.min(Math.max(n.doubleValue(), 0.1), MAX_RADIUS_KM) : DEFAULT_RADIUS_KM;

        record Row(String id, String title, String addr, String tel, double lat, double lng, String raw) {
        }
        List<Row> rows = jdbc.sql("""
                SELECT p.content_id, p.title, p.addr1, p.tel, p.latitude, p.longitude, b.raw
                FROM kto_place p LEFT JOIN kto_barrier_free b ON b.content_id = p.content_id
                WHERE p.content_type_id = ? AND p.latitude IS NOT NULL
                """).param(type)
                .query((rs, i) -> new Row(rs.getString("content_id"), rs.getString("title"), rs.getString("addr1"),
                        rs.getString("tel"), rs.getDouble("latitude"), rs.getDouble("longitude"), rs.getString("raw")))
                .list();

        List<Map<String, Object>> out = rows.stream()
                .map(r -> Map.entry(r, GeoUtils.distanceKm(origin[0], origin[1], r.lat(), r.lng())))
                .filter(e -> e.getValue() <= radius)
                .sorted(Comparator.comparingDouble(Map.Entry::getValue))
                .limit(NEARBY_LIMIT)
                .map(e -> {
                    Row r = e.getKey();
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("kto_content_id", r.id());
                    m.put("name", r.title());
                    m.put("address", r.addr());
                    m.put("tel", r.tel());
                    m.put("distance_km", GeoUtils.round2(e.getValue()));
                    m.put("access", r.raw() == null ? List.of() : BarrierFreeNormalizer.normalize(json.readTree(r.raw())));
                    return m;
                })
                .toList();
        return Map.of("places", out, "radius_km", radius,
                "note", "access 가 비어 있으면 접근성 근거가 없다는 뜻이다. 방문 전 전화 확인을 안내한다.");
    }

    private double[] nearbyOrigin(String nearSpotId, Turn turn) {
        if (nearSpotId != null) {
            return spotCoords(nearSpotId);
        }
        Location l = turn.location();
        if (l != null && l.latitude() != null && l.longitude() != null) {
            return new double[] {l.latitude(), l.longitude()};
        }
        SessionResponse s = sessions.get(turn.sessionId());
        if (s.startSpotId() != null) {
            return spotCoords(s.startSpotId());
        }
        throw ApiException.badRequest("기준 위치가 없습니다. near_spot_id 를 넣거나 사용자에게 위치를 물어보세요.");
    }

    private double[] spotCoords(String spotId) {
        var row = spots.findRow(spotId).orElseThrow(() -> ApiException.badRequest("없는 장소입니다: " + spotId));
        if (!row.hasCoords()) {
            throw ApiException.badRequest(row.name() + " 의 좌표가 없습니다.");
        }
        return new double[] {row.latitude().doubleValue(), row.longitude().doubleValue()};
    }

    // ---- 입력 읽기: 모델 입력은 스키마를 벗어날 수 있으므로 타입을 직접 확인한다 --------------------------

    private static String text(Map<String, Object> input, String key) {
        return input.get(key) instanceof String s && !s.isBlank() ? s.trim() : null;
    }

    private static Integer integer(Map<String, Object> input, String key) {
        return input.get(key) instanceof Number n ? n.intValue() : null;
    }

    private static Long number(Map<String, Object> input, String key) {
        return input.get(key) instanceof Number n ? n.longValue() : null;
    }

    private static List<String> strings(Map<String, Object> input, String key) {
        if (input.get(key) instanceof List<?> list) {
            return list.stream().filter(String.class::isInstance).map(String.class::cast).toList();
        }
        return null;
    }
}

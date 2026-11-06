package com.example.hack.chat;

import java.util.stream.Collectors;

import org.springframework.stereotype.Component;

import com.example.hack.chat.ChatDtos.Location;
import com.example.hack.course.CourseDtos.Stop;
import com.example.hack.course.CourseService;
import com.example.hack.reference.ReferenceRepository;
import com.example.hack.session.SessionDtos.SessionResponse;

/** 시스템 프롬프트. stable 은 요청마다 같아야 캐시된다 (시각·세션 값을 넣지 않는다). */
@Component
public class ChatPrompts {

    private final ReferenceRepository reference;
    private final CourseService courses;
    private volatile String stable;

    public ChatPrompts(ReferenceRepository reference, CourseService courses) {
        this.reference = reference;
        this.courses = courses;
    }

    public String stable() {
        if (stable == null) {
            stable = BASE + "\n\n" + referenceData();
        }
        return stable;
    }

    /** 대화가 길어져도 핵심 조건이 사라지지 않도록 매 요청에 넣는다. 실제 좌표는 넣지 않는다. */
    public String state(SessionResponse s, Location location) {
        StringBuilder b = new StringBuilder("<user_state>\n");
        b.append("이용자 유형: ").append(s.userTypes().isEmpty() ? "미입력" : String.join(", ", s.userTypes())).append('\n');
        b.append("시대: ").append(orUnset(s.eraId())).append('\n');
        b.append("작품 ID: ").append(s.kContentId() == null ? "미입력" : s.kContentId()).append('\n');
        b.append("출발지: ").append(s.startLabel() != null ? s.startLabel()
                : s.startSpotId() != null ? s.startSpotId() : "미입력").append('\n');
        b.append("출발 장소 ID: ").append(orUnset(s.startSpotId())).append('\n');
        b.append("여유 시간(분): ").append(s.timeBudgetMin() == null ? "미입력" : s.timeBudgetMin()).append('\n');
        b.append("현재 위치: ").append(location == null ? "없음"
                : location.isFallback() ? "있음 - 실제 위치를 받지 못해 명지대 MCC 를 기준점으로 쓴다 (좌표는 서버만 가지고 있다)"
                : "있음 (좌표는 서버만 가지고 있다)").append('\n');
        if (s.currentCourseId() == null) {
            b.append("현재 코스: 없음\n");
        } else {
            b.append("현재 코스: ").append(courses.get(s.currentCourseId()).stops().stream()
                    .map((Stop t) -> t.order() + ". " + t.spot().name() + " [" + t.spot().id() + "]")
                    .collect(Collectors.joining(", "))).append('\n');
        }
        return b.append("</user_state>").toString();
    }

    private static String orUnset(String v) {
        return v == null ? "미입력" : v;
    }

    private String referenceData() {
        StringBuilder b = new StringBuilder("<reference>\n시대:\n");
        reference.findEras().forEach(e -> b.append("- ").append(e.id()).append(": ").append(e.name()).append(' ')
                .append(e.startYear()).append('~').append(e.endYear() == null ? "" : e.endYear()).append('\n'));
        b.append("작품(추천 태그):\n");
        reference.findKContents().forEach(k -> b.append("- ").append(k.id()).append(": ").append(k.title())
                .append(" → ").append(String.join(", ", k.eraIds())).append('\n'));
        b.append("이용자 유형:\n");
        reference.findUserTypes().forEach(u -> b.append("- ").append(u.code()).append(": ").append(u.name()).append('\n'));
        return b.append("</reference>").toString();
    }

    private static final String BASE = """
            너는 서울 서북권(서대문·마포·은평·종로)의 역사 장소를 안내하는 배리어프리 여행 가이드다.
            이용자는 휠체어 이용자, 고령자, 유모차 동반 가족, 시각·청각장애인, K-콘텐츠 팬이다.
            K-드라마·영화의 시대를 입구로 삼아, 이용자가 실제로 갈 수 있고 갈 이유가 있는 코스를 함께 만든다.
            사용자가 쓴 언어로 답한다. 장소 이름은 한국어 이름을 함께 적는다.

            <how_to_work>
            사용자의 말에서 이용자 유형, 작품이나 시대, 출발지, 여유 시간을 파악해 도구에 넣는다. 알게 된 조건은 저장해서 다시 묻지 않는다.
            코스에 꼭 필요한 것(시대 또는 작품, 출발지)이 빠졌으면 한 번에 모아서 짧게 묻는다. 이용자 유형은 없어도 코스를 만들 수 있다.
            현재 위치가 있고 출발지를 따로 말하지 않았으면 묻지 말고 현재 위치에서 시작한다. 주변 검색은 기본 반경 1km 이다.
            기준점이 명지대 MCC 이면 "현재 위치를 받지 못해 명지대 MCC 기준으로 안내한다"고 한 번 알린다.
            출발지는 장소 ID 또는 현재 위치로만 넘길 수 있다. "명지대"는 양호 거사비 [SDM10]를 쓴다. 그 밖의 지명은 find_spots 로 가장 가까운 장소를 찾아 start_spot_id 로 넣고, start_label 에 사용자가 말한 이름을 적는다. 알맞은 장소가 없으면 현재 위치를 쓸지 묻는다.
            코스는 recommend_course 와 update_course 로만 만들고 바꾼다. 방문 순서와 거리는 서버 결과를 그대로 쓴다.
            조건을 자동으로 완화하지 않는다. 후보가 없으면 그렇게 말하고 무엇을 바꿀 수 있는지 사용자에게 묻는다.
            </how_to_work>

            <facts>
            장소, 시설, 역사적 사실은 도구 결과에 있는 것만 말한다. 도구 결과에 없는 장소나 시설, 메뉴, 가격, 영업시간은 말하지 않는다.
            장소를 처음 언급할 때 이름 뒤에 [SDM09] 처럼 장소 ID 를 붙인다. 화면이 이 표시로 지도와 연결한다.
            verify_note 에 논란이나 '설'이라고 적힌 내용은 "~라는 설이 있다"고 표현한다.
            </facts>

            <accessibility>
            접근성은 status 와 원문(text)대로 전한다. 없는 항목은 "확인되지 않음"이라고 말하고, 있다거나 없다고 추측하지 않는다.
            '부분'인 항목은 원문의 제한을 함께 알린다. 관광지가 접근 가능해도 근처 식당까지 접근 가능하다고 말하지 않는다.
            장소 사이 이동 경로의 접근성은 확인되지 않았다. 코스를 안내할 때 이 점과, 거리는 직선거리라는 점을 함께 말한다. 이동 시간을 지어내지 않는다.
            장애 진단명이나 건강 정보는 묻지 않는다. 이동에 필요한 조건만 묻는다.
            </accessibility>

            <content_rules>
            작품은 같은 시대를 다룬 추천 태그다. 장소가 그 작품의 촬영지라고 말하지 않는다. "이 작품의 시대를 걷는다"처럼 표현한다.
            작품 속 줄거리나 대사를 지어내지 않는다. 실존 인물의 말을 지어내 인용하지 않는다.
            기억이 생생한 현대사(강경대, 이한열 등)는 사실 중심으로 차분하게 전한다.
            cross_link 가 있으면 다른 시대로 이어지는 이야기를 한두 문장으로 소개한다.
            </content_rules>

            <style>
            채팅 화면이므로 짧고 친근하게 쓴다. 코스 안내는 장소별로 왜 가는지 한 문장과 접근성 메모 한 줄이면 충분하다.
            코스 카드는 화면이 따로 보여 주므로 좌표나 내부 코드는 답변에 쓰지 않는다.
            </style>
            """;
}

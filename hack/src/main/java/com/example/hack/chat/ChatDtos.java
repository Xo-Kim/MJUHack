package com.example.hack.chat;

import java.time.OffsetDateTime;
import java.util.List;

import com.example.hack.course.CourseDtos.CourseResponse;
import com.example.hack.session.SessionDtos.SessionResponse;

public final class ChatDtos {

    private ChatDtos() {
    }

    /**
     * 이번 요청의 거리 계산에만 쓴다. 저장하지 않고 Claude 에게도 보내지 않는다.
     *
     * @param fallback 실제 위치를 못 받아 명지대 MCC 를 기준점으로 쓰는 경우 true
     */
    public record Location(Double latitude, Double longitude, Boolean fallback) {

        public boolean isFallback() {
            return Boolean.TRUE.equals(fallback);
        }
    }

    public record ChatRequest(String content, Location location) {
    }

    /** @param context 사용자가 자유롭게 쓴 조건 (예: "휠체어 타고, 1987 봤어요. 명지대에서 3시간") */
    public record RecommendRequest(String context, String sessionId, Location location) {
    }

    public record MessageResponse(long id, String role, String content, OffsetDateTime createdAt) {
    }

    /**
     * @param course           이번 답변으로 코스가 바뀐 경우에만 채운다
     * @param referencedSpotIds 답변에 언급된 장소 ID. 서버 데이터에서 확인된 것만 들어 있다
     */
    public record ChatReply(String sessionId, MessageResponse message, SessionResponse session,
            CourseResponse course, List<String> referencedSpotIds) {
    }
}

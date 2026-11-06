# API 명세서 v0.5

서북권 역사 배리어프리 여행 서비스 · 백엔드(Spring Boot) REST API

- 기준 문서: `서북권 역사 배리어프리 여행 서비스 기획서` (2026-11-06), DB 스키마 `hack/src/main/resources/db/migration/V1__init_schema.sql`
- 상태 표기: ✅ 구현됨 · 🛠 설계만 (아직 구현 전)
- 구현된 API 는 실제 동작 기준이고, 필드를 바꾸면 이 문서와 [DB-SCHEMA.md](DB-SCHEMA.md)를 함께 수정한다.

## 0. 공통 규칙

| 항목 | 규칙 |
| --- | --- |
| Base URL | 개발: `http://localhost:8080` · 프론트 개발 서버는 `/api` 요청을 프록시하므로 `fetch('/api/...')` 로 호출 |
| 형식 | 요청·응답 모두 `application/json; charset=UTF-8` |
| 필드 이름 | camelCase. ID는 DB 값 그대로 (`SDM01`, `JOSEON`, `X3`) |
| 시간 | ISO-8601, Asia/Seoul (`2026-11-06T14:30:00+09:00`) |
| CORS | `ALLOWED_ORIGINS` 환경변수에 등록한 주소만 허용 (`GET`, `POST`, `PATCH`) |
| 인증 | 없음. 챗봇은 익명 `sessionId`(UUID)로 구분 |
| 개인정보 | 정확한 사용자 좌표는 거리 계산에만 쓰고 저장하지 않는다. 장애 진단명 등 건강정보는 받지 않는다 |
| 빈 값 | 모르는 값은 `null`. 접근성은 `UNKNOWN` 으로 표시하며 "가능/불가"로 추정하지 않는다 |

### 공통 열거값

| 이름 | 값 |
| --- | --- |
| `eraId` | `JOSEON`(조선 1392~1875) · `OPENING_COLONIAL`(개화기·일제강점기 1876~1945) · `MODERN`(현대 1945~) |
| `districtId` | `SDM`(서대문구) · `MPO`(마포구) · `EPY`(은평구) · `JNG`(종로구) |
| `userType` | `WHEELCHAIR` · `ELDERLY` · `STROLLER` · `VISUAL` · `HEARING` |
| `accessStatus` | `AVAILABLE`(있음) · `PARTIAL`(부분) · `UNAVAILABLE`(없음) · `UNKNOWN`(미확인) |
| `coordStatus` | `VERIFIED` · `PROVIDED` · `APPROX` · `AREA`(권역 대표점) · `KTO`(관광공사 좌표로 채움) · `MISSING` |
| `reviewStatus` | `DRAFT` · `NEEDS_SOURCE`(출처 보강 필요) · `REVIEWED` |

### 오류 응답

```json
{
  "code": "SPOT_NOT_FOUND",
  "message": "장소를 찾을 수 없습니다: SDM99",
  "timestamp": "2026-11-06T14:30:00+09:00"
}
```

| HTTP | code 예시 | 상황 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 필수 값 누락, 잘못된 열거값 |
| 404 | `SPOT_NOT_FOUND`, `SESSION_NOT_FOUND`, `COURSE_NOT_FOUND` | 없는 ID |
| 410 | `SESSION_EXPIRED` | 만료된 챗봇 세션 |
| 422 | `NO_CANDIDATES` | 조건을 만족하는 장소가 없음 (조건을 자동으로 완화하지 않음) |
| 502 | `LLM_UNAVAILABLE` | Claude 호출 실패. 이미 만든 코스와 장소 정보는 유지 |
| 503 | `LLM_NOT_CONFIGURED` | `ANTHROPIC_API_KEY` 없음 또는 키 오류 |

---

## 1. 상태 확인

### ✅ `GET /api/health`

```json
{ "status": "ok" }
```

---

## 2. 기준 데이터

화면의 선택지(시대, 작품, 이용자 유형)를 그리는 데 쓴다. 자주 바뀌지 않으므로 프론트에서 캐시해도 된다.

### ✅ `GET /api/eras`

```json
[
  { "id": "JOSEON", "name": "조선", "startYear": 1392, "endYear": 1875, "spotCount": 25 },
  { "id": "OPENING_COLONIAL", "name": "개화기·일제강점기", "startYear": 1876, "endYear": 1945, "spotCount": 12 },
  { "id": "MODERN", "name": "현대", "startYear": 1945, "endYear": null, "spotCount": 5 }
]
```

### ✅ `GET /api/k-contents`

작품은 시대를 고르는 **추천 태그**다. 응답에 촬영지 정보는 없다. 포스터·장면 이미지 URL도 제공하지 않는다.

```json
[
  { "id": 5, "title": "1987", "type": "MOVIE", "eraIds": ["MODERN"] },
  { "id": 3, "title": "미스터 션샤인", "type": "DRAMA", "eraIds": ["OPENING_COLONIAL"] }
]
```

### ✅ `GET /api/user-types`

이용자 유형과, 그 유형에서 확인하는 접근성 항목.

```json
[
  {
    "code": "WHEELCHAIR",
    "name": "휠체어 이용자",
    "requirements": [
      { "featureCode": "ACCESS_ROUTE", "featureName": "계단·급경사 없는 접근로", "required": true },
      { "featureCode": "ACCESSIBLE_TOILET", "featureName": "장애인 화장실", "required": false }
    ]
  }
]
```

- `required: true`: 확인된 `UNAVAILABLE` 이면 코스 후보에서 제외한다. `UNKNOWN` 은 제외하지 않고 경고를 붙인다.
- `required: false`: 정렬 가중치로만 쓴다.

---

## 3. 장소

### ✅ `GET /api/spots`

| 쿼리 | 필수 | 설명 |
| --- | --- | --- |
| `eraId` | – | 시대 필터 |
| `kContentId` | – | 작품의 시대로 필터 (`eraId` 와 같이 오면 `eraId` 우선) |
| `districtId` | – | 구 필터 |
| `hasCoords` | – | `true` 면 좌표 있는 장소만 (지도용) |

```json
[
  {
    "id": "SDM10",
    "name": "양호 거사비",
    "districtId": "SDM",
    "eraId": "JOSEON",
    "category": "비석",
    "latitude": 37.5806,
    "longitude": 126.9234,
    "coordStatus": "APPROX",
    "storyShort": "정유재란 때 조선에 온 명나라 장수 양호를 기리는 송덕비…",
    "crossLinkIds": ["X3"],
    "hasArticle": false,
    "reviewStatus": "DRAFT"
  }
]
```

### ✅ `GET /api/spots/{spotId}`

장소 상세. 출처, 접근성, 시기 연결, 게시된 기사를 함께 준다. 접근성은 관광공사 무장애 정보 수집(`provider: "KTO"`, `sourceUrl` 은 대한민국 구석구석 상세 페이지)과 팀 판단(`TEAM`, 예: 안산 봉수대 접근로)에서 온다. 수집 전에는 엑셀 메모에 근거가 있는 4행만 있다. 수집 방법은 [DB-SCHEMA.md](DB-SCHEMA.md#관광공사-무장애-정보-수집).

```json
{
  "id": "SDM07",
  "name": "무악산 동봉수대 터(안산 봉수대)",
  "districtId": "SDM",
  "districtName": "서대문구",
  "eraId": "JOSEON",
  "eraDetail": "조선 전기",
  "yearLabel": "1438 / 1994 복원",
  "category": "유적터",
  "address": "서울 서대문구 봉원동 산1 안산 정상",
  "latitude": 37.5745,
  "longitude": 126.9478,
  "coordStatus": "APPROX",
  "storyShort": "조선시대 횃불과 연기로 급보를 전하던 봉수대…",
  "hiddenFact": "터만 남아 있던 것을 1994년 서울 정도 600년 기념사업으로 복원했다…",
  "ktoContentId": "126531",
  "accessibilityNote": "관광공사 데이터: 주차 불가, 유모차 대여 불가. 정상부라 휠체어 접근 어려움…",
  "accessibility": [
    {
      "featureCode": "ACCESS_ROUTE",
      "featureName": "계단·급경사 없는 접근로",
      "status": "UNAVAILABLE",
      "rawText": "정상부 산길",
      "provider": "TEAM",
      "checkedAt": "2026-11-06"
    }
  ],
  "sources": [
    { "url": "https://www.ktriptips.com/kor/tourspot/126531", "label": null }
  ],
  "crossLinks": [],
  "articles": [],
  "reviewStatus": "DRAFT",
  "verifyNote": "배리어프리 필터 '제외' 시연용 사례로 활용 가능"
}
```

- `accessibility` 에는 근거가 있는 항목만 들어간다. 목록에 없는 항목은 `UNKNOWN` 으로 취급한다.
- `articles[]` 는 `status = PUBLISHED` 인 것만 준다. 형식은 [5절](#5-뉴스형-장소-소개)을 따른다.

---

## 4. 시기를 넘는 연결

### ✅ `GET /api/cross-links`

| 쿼리 | 설명 |
| --- | --- |
| `spotId` | 이 장소가 포함된 연결만 |

```json
[
  {
    "id": "X3",
    "title": "명지대 캠퍼스, 정유재란과 1991년",
    "eraFlow": "조선 → 현대",
    "story": "정유재란 때 명나라 장수 양호를 기린 비(1598년 처음 세움, 1835년 다시 새김)와 1991년 강경대 열사를 기리는 광장·거리가 같은 캠퍼스에 있다.",
    "spots": [
      { "id": "SDM10", "name": "양호 거사비", "eraId": "JOSEON" },
      { "id": "SDM01", "name": "강경대 민주광장(추모 동판)", "eraId": "MODERN" },
      { "id": "SDM02", "name": "강경대 열사 거리·표지석(사건 현장)", "eraId": "MODERN" }
    ]
  }
]
```

### ✅ `GET /api/cross-links/{crossLinkId}`

같은 형식으로 하나만 반환한다.

---

## 5. 뉴스형 장소 소개

장소 상세(`GET /api/spots/{spotId}`)의 `articles[]` 로 함께 내려간다. 따로 조회할 때는 아래 API를 쓴다.

### ✅ `GET /api/spots/{spotId}/articles`

| 쿼리 | 설명 |
| --- | --- |
| `language` | 기본 `ko` |

```json
[
  {
    "id": 12,
    "spotId": "SDM13",
    "language": "ko",
    "headline": "…",
    "body": "…",
    "eventDate": "1987-06-09",
    "imageUrl": "/images/articles/SDM13.png",
    "imageAlt": "연세대 정문 앞 보도에 놓인 동판과 꽃",
    "reconstructed": true
  }
]
```

- `reconstructed` 는 항상 `true` 다. 화면에 "실제 보도가 아닌 재구성 기사" 안내를 표시한다.
- `imageUrl` 이 있으면 `imageAlt` 도 반드시 있다 (DB 제약).

---

## 6. 코스 생성

### ✅ `POST /api/courses`

챗봇 없이 조건만으로 코스를 만든다. 챗봇 대화 중에도 내부적으로 같은 로직을 쓴다.

요청:

```json
{
  "sessionId": "8f3c2c1e-1f0b-4c55-9a51-0d6b3a3d2e10",
  "userTypes": ["WHEELCHAIR"],
  "eraId": null,
  "kContentId": 5,
  "start": { "spotId": null, "label": "명지대 정문", "latitude": 37.5800, "longitude": 126.9238 },
  "timeBudgetMin": 180,
  "stopCount": 4
}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `sessionId` | – | 있으면 코스를 저장하고 세션의 `currentCourseId` 로 지정한다. 아래 필드가 비어 있으면 세션 상태 값을 쓴다. 없으면 저장하지 않고 결과만 반환 (`id: null`) |
| `userTypes` | – | 생략하면 세션 값, 세션도 없으면 `[]` (접근성 조건 없음) |
| `eraId` / `kContentId` | 둘 중 하나 ✔ | `eraId` 가 우선. 작품을 주면 작품의 시대로 바꾼다. 세션에 있으면 생략 가능 |
| `start` | ✔ | `spotId` 또는 `latitude`+`longitude`. 좌표는 거리 계산에만 쓰고 저장하지 않는다. 세션에 `startSpotId` 가 있으면 생략 가능. `label` 은 화면 표시용 |
| `timeBudgetMin` | – | `stopCount` 가 없을 때 `분 ÷ 40` 을 3~5로 맞춰 장소 수로 쓴다 (임시 규칙) |
| `stopCount` | – | 3~5, 기본 4 |

처리 순서 (기획서 기준):
1. 시대로 후보를 거른다.
2. 이용자 유형의 `required` 항목이 `UNAVAILABLE` 인 장소를 뺀다 → `excluded`. `UNKNOWN`·기록 없음은 빼지 않고 `unknownFeatures` 로 표시한다.
3. 좌표가 없는 장소는 뺀다 (경고로 개수만 알림).
4. 출발지에서 시작해 "가장 가까운 다음 장소"를 반복해서 고른다. 거리에서 다음 보너스를 뺀 값으로 비교한다.
   - 접근성 선호 항목이 `AVAILABLE` 이면 1점(`PARTIAL` 0.5점)당 0.2km
   - 이미 고른 장소와 같은 시기 연결에 속하면 0.5km

응답 `201 Created` (실제 응답 예시, 일부 생략):

```json
{
  "id": 7,
  "eraIds": ["JOSEON"],
  "userTypes": ["WHEELCHAIR"],
  "startLabel": "양호 거사비",
  "reason": "조선 장소 중 양호 거사비에서 가까운 순서로 4곳을 골랐습니다. 휠체어 이용자 조건을 적용했습니다. 필수 접근성 항목이 '없음'으로 확인된 2곳은 뺐습니다. '명지대 캠퍼스, 정유재란과 1991년' 이야기로 다른 시대와 이어집니다.",
  "stops": [
    {
      "order": 1,
      "spot": { "id": "SDM10", "name": "양호 거사비", "eraId": "JOSEON", "latitude": 37.5806, "longitude": 126.9234 },
      "distanceFromPrevKm": 0.0,
      "accessMemo": "캠퍼스 내 경사로·계단 여부 현장 확인 필요 / 미확인: 계단·급경사 없는 접근로",
      "unknownFeatures": ["ACCESS_ROUTE"],
      "crossLinkId": "X3"
    },
    {
      "order": 2,
      "spot": { "id": "SDM06", "name": "모래내·사천교(지명 유래)", "eraId": "JOSEON", "latitude": 37.5745, "longitude": 126.919 },
      "distanceFromPrevKm": 0.78,
      "accessMemo": "시장 골목·하천변 — 단차 현장 확인 필요 / 미확인: 계단·급경사 없는 접근로",
      "unknownFeatures": ["ACCESS_ROUTE"],
      "crossLinkId": null
    }
  ],
  "excluded": [
    { "spotId": "SDM07", "name": "무악산 동봉수대 터(안산 봉수대)", "reason": "계단·급경사 없는 접근로 없음 (정상부라 휠체어 접근 어려움)" },
    { "spotId": "EPY02", "name": "북한산성", "reason": "계단·급경사 없는 접근로 없음 (산지 — 접근 어려움)" }
  ],
  "warnings": [
    "장소 사이 이동 경로의 접근성은 확인되지 않았습니다. 이동 전 별도로 확인하세요.",
    "거리는 직선거리이며 실제 이동 거리·시간과 다릅니다.",
    "4곳은 필수 접근성 항목이 아직 확인되지 않았습니다. 방문 전 확인이 필요합니다.",
    "좌표가 아직 없는 장소 9곳은 후보에서 빠졌습니다."
  ]
}
```

- `distanceFromPrevKm` 는 직선거리다. 이동 시간이나 길찾기 경로는 주지 않는다.
- `crossLinkId` 는 그 장소에서 **다른 시대 장소로 이어지는** 연결이 있을 때만 채운다.
- `excluded` 는 "왜 빠졌는지"를 보여주는 용도다 (예: 안산 봉수대).
- 후보가 `stopCount` 보다 적으면 있는 만큼만 반환하고 경고를 붙인다. 하나도 없으면 `422 NO_CANDIDATES` 를 반환한다.
- 출발 장소에 좌표가 없으면 `400` 이다 (좌표로 다시 보내야 한다).

### ✅ `POST /api/courses/recommend` (AI 코스 추천)

사용자가 자유롭게 쓴 맥락으로 Claude 가 조건을 파악하고, 서버 로직으로 코스를 만들어 설명까지 돌려준다. 세션이 없으면 새로 만든다. 이어지는 수정 요청은 응답의 `sessionId` 로 챗봇 API(7절)를 부른다.

요청:

```json
{
  "context": "휠체어 타요. 1987 봤어요. 명지대에서 출발해요.",
  "sessionId": null,
  "location": null
}
```

응답 `201 Created`: 7절 메시지 응답과 같은 형식 (`sessionId`, `message`, `session`, `course`, `referencedSpotIds`).

필요한 조건(시대 또는 작품, 출발지)이 빠져 있으면 Claude 가 되묻고 `course` 는 `null` 이다.

### ✅ `GET /api/courses/{courseId}`

저장된 코스를 생성 당시 응답 그대로 반환한다 (`course.snapshot`).

---

## 7. 챗봇

세션은 익명이며 `expiresAt` (기본: 마지막 활동 후 24시간)이 지나면 삭제한다. 사용자 유형·시대·출발지·현재 코스는 대화 기록과 별도로 세션 상태에 저장한다.

### ✅ `POST /api/chat/sessions`

요청 (모두 선택):

```json
{
  "userTypes": ["STROLLER", "ELDERLY"],
  "eraId": null,
  "kContentId": 3,
  "startSpotId": null,
  "startLabel": "명지대 정문",
  "timeBudgetMin": 120
}
```

응답 `201 Created`: [세션 상태](#세션-상태-형식)

### ✅ `GET /api/chat/sessions/{sessionId}`

응답: 세션 상태

### ✅ `PATCH /api/chat/sessions/{sessionId}`

화면 위 조건 요약에서 사용자가 직접 바꾼 값을 반영한다. 보낸 필드만 바뀐다. 응답은 세션 상태다.

```json
{ "userTypes": ["WHEELCHAIR"], "timeBudgetMin": 90 }
```

- `null` 이거나 보내지 않은 필드는 그대로 둔다. 지금은 값을 비우는(`null` 로 되돌리는) 방법이 없다.
- `userTypes` 는 보낸 목록으로 통째로 바뀐다 (`[]` 이면 조건 없음).
- `kContentId` 를 보내고 `eraId` 를 안 보내면, 작품의 시대가 하나일 때 `eraId` 도 그 시대로 바뀐다.
- 세션을 만들거나 바꾸거나 코스를 만들면 `expiresAt` 이 그 시점부터 24시간으로 늘어난다. 만료된 세션은 1시간마다 지워지며, 지워지기 전에 접근하면 `410 SESSION_EXPIRED` 를 반환한다.

### 세션 상태 형식

```json
{
  "id": "8f3c2c1e-1f0b-4c55-9a51-0d6b3a3d2e10",
  "userTypes": ["STROLLER", "ELDERLY"],
  "eraId": "OPENING_COLONIAL",
  "kContentId": 3,
  "startSpotId": null,
  "startLabel": "명지대 정문",
  "timeBudgetMin": 120,
  "currentCourseId": 41,
  "expiresAt": "2026-11-07T14:30:00+09:00"
}
```

### ✅ `GET /api/chat/sessions/{sessionId}/messages`

```json
[
  { "id": 1, "role": "USER", "content": "두 번째 장소 빼줘", "createdAt": "2026-11-06T14:31:00+09:00" },
  { "id": 2, "role": "ASSISTANT", "content": "…", "createdAt": "2026-11-06T14:31:04+09:00" }
]
```

### ✅ `POST /api/chat/sessions/{sessionId}/messages`

요청:

```json
{
  "content": "두 번째 장소는 빼줘. 그리고 안산 봉수대를 넣어줘.",
  "location": { "latitude": 37.5801, "longitude": 126.9235 }
}
```

- `content`: 필수, 2000자 이내
- `location`: 선택. 이번 요청의 거리 계산에만 쓴다. 저장하지 않고 Claude 에게도 보내지 않는다. 실제 위치를 못 받아 명지대 MCC 를 기준점으로 쓰면 `"fallback": true` 를 함께 보낸다.

응답 `200 OK`:

```json
{
  "sessionId": "e39038b7-3da1-48f9-b147-8ad4a76dd26b",
  "message": { "id": 8, "role": "ASSISTANT", "content": "… 강경대 민주광장 [SDM01] …", "createdAt": "2026-11-06T14:32:10+09:00" },
  "session": { "...": "세션 상태" },
  "course": { "...": "코스. 이번 답변으로 바뀐 경우에만 있고, 아니면 null (6절 형식)" },
  "referencedSpotIds": ["SDM01", "SDM13"]
}
```

- 답변 안의 `[SDM01]` 표시를 프론트에서 지도·상세 링크로 바꾼다. `referencedSpotIds` 는 서버 데이터에서 확인된 ID 만 담는다.
- 답변은 마크다운으로 올 수 있다.
- Claude 호출에 수 초~수십 초가 걸릴 수 있으니 프론트에 로딩 표시를 둔다.

Claude 가 쓸 수 있는 도구: `find_spots`, `get_spot_detail`, `recommend_course`, `update_course`, `update_user_state`, `search_nearby_places`.

LLM 사용 원칙:
- 필터링·접근성 판단·거리 계산은 서버가 한다. 코스는 도구로만 만들고 바꿀 수 있다. Claude 는 조건 파악과 설명을 맡는다.
- 코스에 넣는 장소는 서버가 접근성 조건을 다시 검사한다. 맞지 않으면 도구 오류로 돌려주고, Claude 가 이유와 대안을 설명한다.
- 도구 결과나 이전 대화에 없던 장소 ID 는 서버가 답변에서 지운다.
- 대화 기록은 사용자·답변 글만 저장한다 (`chat_message`). 최근 20개와 세션 상태를 매 요청에 함께 보낸다.
- Claude 가 거절하면 200 으로 안내 문구를 준다. 호출이 실패하면 `502 LLM_UNAVAILABLE`, 키가 없으면 `503 LLM_NOT_CONFIGURED` 를 주고 이번 대화는 저장하지 않는다. 일반 코스 API(6절)는 키 없이도 동작한다.

---

## 8. 변경 이력

| 버전 | 날짜 | 내용 |
| --- | --- | --- |
| v0.1 | 2026-11-06 | 초안. DB 스키마 V1~V3 기준. `/api/health` 만 구현됨 |
| v0.2 | 2026-11-06 | 기준 데이터·장소·시기 연결·기사·코스 생성/조회·세션 상태 API 구현. 코스 응답의 `eraId` → `eraIds`(작품이 여러 시대일 수 있음), `userTypes`·`startLabel`·`excluded[].name` 추가. 챗봇 메시지 API는 LLM 미선정으로 미구현 |
| v0.3 | 2026-11-06 | 관광공사 무장애 정보 수집 연결. 접근성 항목 `ENTRANCE`(출입구 단차 없음)·`GUIDE_DOG`(보조견 동반) 추가 — `/api/user-types` 와 코스 선호 조건에 반영. 장소 좌표 상태에 `KTO` 추가 |
| v0.4 | 2026-11-06 | Claude 연동. `POST /api/courses/recommend`, 챗봇 메시지 API 구현. `distanceFromPrevKm` 은 코스 수정 후 첫 장소에서 `null` 일 수 있음. 작품 없이 시대만 바꾸면 세션의 작품이 지워짐 |
| v0.5 | 2026-11-06 | 데이터 변경: 장소 42곳, 연결 7개, 기사 42건. `coordStatus` 가 `MISSING` 인 장소 없음. 출발 장소가 후보에 있으면 코스 1번. `accessMemo` 에 선호 항목 근거도 포함 |

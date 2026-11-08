---
name: wiki-review
description: LLM Wiki의 원문 주장 검토·전문가 판단·독립 관계 추가·문서 대응·Clean Up과 되돌림을 처리한다. 본문 편집이나 단순 조회에는 사용하지 않는다.
---

# Wiki 판단과 관계 검토

사용자가 요청한 판단·관계·표시 정리의 종류를 구분하고 해당 절차만 적용한다. 본문·판본 변경은 [wiki-edit](../wiki-edit/SKILL.md)를 사용한다. [공통 보존 규칙](../../../AGENTS.md#공통-데이터-보존)과 [검토·정책 규칙](../../../docs/domains/reviews/RULES.md)이 계약의 원본이다.

## 대상과 권한

- `access_context`로 실제 tenant·허용 profile·행동 권한을 확인하고 현재 노출 도구의 스키마를 읽는다. 선택한 tenant를 모든 데이터 호출에 전달한다. profile은 권한 부여 수단이 아니다.
- 사용자의 명확한 수정 요청은 그 범위의 실행 지시로 취급한다. 검토·정책은 실제 요청한 판단만 기록한다. 요청이 단순히 “검토해 줘”라면 분석 의견을 제공하며 AI가 고른 수용/거절을 사람의 결정으로 저장하지 않는다.
- 읽기 전용 연결이면 대상·수정안을 준비하고 부족한 도구/권한과 미실행 상태를 설명한다. 도구가 없거나 접근이 거부되면 다른 토큰·legacy·파일 직접 쓰기로 우회하지 않는다. 인증 주체·tenant·시각·판단 출처는 서버가 기록한다.

## 변경 종류별 경로

| 사용자 의도 | 도구와 필요한 권한 |
| --- | --- |
| 원문에 근거한 해석 수용·수정·거절·보류 | `ontology_review_query` → `ontology_review`; `ontology_review` |
| 원문에 없는 전문가 업무 판단 반영 | `ontology_review_query` → `ontology_policy`; 별도 `ontology_policy` |
| 기존 개체 사이의 독립 관계 추가 | `ontology_review_query` → `ontology_relation_create`; source는 `ontology_review`, policy는 `ontology_policy` |
| 검토 또는 정책 되돌림 | 최신 `ontology_review_query` → 해당 `ontology_review_undo` / `ontology_policy_undo` |
| 기각·과거 원문 검토의 표시 정리와 복원 | 아래 Clean Up 절차; 조회는 `read`, 적용·되돌림은 `ontology_review` |
| 문서 간 조건·개념 대응 | 아래 대응 절차; 제안은 `ontology_write`, 원문 검토는 `ontology_review`, 업무 판단은 `ontology_policy` |

모든 변경 권한에는 `read`도 필요하다. 분석 작업에 속한 결과는 이 일반 쓰기 경로로 우회하지 않고 작업 전용 저장 도구를 사용한다.

## 문서 내 판단

- 검토·정책은 최신 검토 조회의 안정된 `claim_id`와 `state_revision`을 사용한다. 배열 위치나 임시 추출 ID로 수정하지 않는다. 원문 검토의 edit에는 전체 replacement와 실제 인용·한정어·관점·출처가 필요하다.
- 인용 없는 업무 판단은 `ontology_policy`로 기록하고 요청된 조건·범위·시점·이유를 유지한다. 현재 허용 profile의 정확한 context를 사용한다. 인용·actor·provenance를 발명하지 않는다. 기존 claim 정정과 새 관계 추가를 구분한다. 주장이 없으면 아래 독립 관계 경로를 확인하며 임의 claim ID를 만들지 않는다.
- 일반 원문 검토는 활성 전문가 정책을 덮어쓰지 못한다. 되돌림은 해당 계층·범위의 최신 `event_id`에 새 이벤트를 추가하며 과거 기록을 지우지 않는다.
- 본문 변경으로 그래프가 stale이면 재추출 필요를 알린다. 함께 요청받았을 때만 최신 원문에서 재추출하며 옛 승인을 자동 재적용하지 않는다.

## 독립 관계 추가와 되돌림

- 최신 `ontology_review_query`의 현재 개체 ID와 `state_revision`을 읽는다. `ontology_relation_create`에는 `document`, 새 32자리 소문자 hex `request_id`, `expected_state_revision`, `kind: source|policy`, 전체 `replacement`, 요청된 이유를 전달한다. 원문 관계는 실제 인용·한정어를, 전문가 판단은 정확한 업무 조건·범위를 보존한다. 종류별 중첩 필드는 현재 MCP `replacement` 필드 설명을 따른다. 로컬 계약 대조가 필요하면 [공개 입력 안내](../../../core/mcp/tools/authored_relations.py)의 `_REPLACEMENT_GUIDE`를 확인한다. 관계 방향은 주어→술어→목적어이며 원문·요청에서 방향이 불명확하면 이를 먼저 확인한다.
- 끝점은 현재 기계 그래프에 있는 개체만 사용할 수 있다. 새 개체나 문서 간 관계는 이 도구로 만들지 않는다. 단순 관계 탐색·AI 제안을 사람의 추가 판단으로 기록하지 않는다. 명확하게 요청된 추가라면 같은 승인을 반복해서 묻지 않는다.
- 응답 유실은 같은 사용자·tenant·profile·문서·`request_id`의 `ontology_relation_request`로 먼저 확인한다. 저장 성공 뒤 경고나 후속 조회 실패로 다시 쓰지 않는다. 동일 request ID의 입력 변경은 충돌이며 새 ID로 자동 재제출하지 않는다.
- 되돌림은 최신 조회의 정확한 추가 `event_id`, 현재 `expected_state_revision`, 원래 `kind`, 새 `request_id`와 이유로 `ontology_relation_undo`를 호출한다. 과거 이벤트는 남는다. 새 추출 세대의 pending 관계는 현재 승인으로 되살리지 않는다. `authored_relations`·`relation_history`는 기존 검토 조회에서 확인한다.

## 문서 간 대응

1. `ontology_correspondence_find/query`로 기존 대응·원문 위치·판단·의존 버전을 읽는다. 신규이면 완전한 `draft`를 `ontology_correspondence_query`로 준비하여 서버 ID·canonical draft·부재 기준 token을 받은 뒤 `ontology_correspondence_propose`로 미검토 제안을 만든다. 이름 일치나 양 끝점의 인용만으로 대응을 승인하지 않는다.
2. 기존 대응의 edit·policy·두 undo에는 실제 `operation`과 **전체 change**로 `ontology_correspondence_prepare`를 호출한다. 값이 바뀌지 않는 accept/reject/defer는 완전한 detail token도 사용할 수 있다. 정확히 그 변경에만 반환된 `expected_state_revision`을 사용한다. 불완전한 근거 조회는 변경 token으로 쓸 수 없다.
3. 요청된 계층의 review/policy/undo 도구를 호출한다. 새 문서로 옮긴 제안에 이전 승인·token을 복사하지 않는다. 전문가 변경은 해당 판단의 ID·최신 대체 event와 적용 범위를 확인한다.
4. 같은 ID를 다시 조회해 저장된 이벤트와 현재 `decision`·`applicability`를 구분한다. 주변 업무 규칙을 답할 때는 관련 문서의 `ontology_review_query`도 확인한다. 상세 draft/근거 형식이 필요하면 [대응 계약](../../../docs/domains/correspondences/DECISIONS.md)의 D-038 관련 절만 읽는다.

## Clean Up

- 문서 하나와 정확한 profile 범위에서 `ontology_cleanup_preview`를 읽는다. `capabilities`, 항목 근거, `complete`·`next_cursor`를 확인하고 필요한 페이지를 읽는다. 첫 페이지를 전체 결과로 취급하지 않는다. 상세 범위는 [Clean Up 계약](../../../docs/domains/ontology/PLAN.md#clean-up-공개-계약)을 따른다.
- 사용자가 명시 선택한 미리보기 항목만 적용한다. 일반적인 “정리해 줘” 요청에서 전체 항목을 자동 선택하지 않는다. 이 기능은 기각·과거 원문 검토의 표시 정리이며 원문·그래프·판단 이력을 삭제하지 않는다. 미검토·보류를 기각으로 바꾸거나 전문가 정책을 숨기거나 유사 개체를 병합하지 않는다.
- `ontology_cleanup_apply`에 같은 미리보기의 `preview_revision`, 서버의 `item_ids` 1~50개, 32자리 소문자 hex `request_id`, 요청된 정리 이유를 전달한다. `catalog_changed`·conflict이면 새 미리보기에서 선택을 재검토하며 예전 항목에 새 판본값만 붙이지 않는다.
- 응답 유실·취소 뒤에는 같은 문서·사용자·profile·`request_id`로 `ontology_cleanup_request`를 먼저 조회한다. 영수증이 없다는 응답은 진행 중 저장의 취소 확정이 아니다. 같은 요청 ID의 인자를 바꾸거나 새 ID로 자동 재제출하지 않는다. `saved`, `replayed`, `cleanup_failures`를 구별한다.
- 이력은 `ontology_cleanup_history`로 확인한다. 되돌림은 같은 범위에서 조회한 최신 `state_revision`을 `expected_state_revision`으로 전달하고 대상 apply의 `event_id`, 새 `request_id`, 이유로 `ontology_cleanup_undo`를 호출한다. 해당 적용 전체를 역이벤트로 되돌리며 일부 항목 복원이나 옛 승인 승계를 약속하지 않는다.
- 완료 후 `ontology_review_query`의 `current_claims`·`current_pending_history`로 현재 표시를 확인하고 원래 `claims`·`history`·`pending_history`는 감사 근거로 보존해 읽는다.

## 실패와 완료

- conflict는 최신 본문·그래프·검토/대응 이력을 다시 읽고 수정안을 재반영한다. 오래된 payload의 revision만 교체하지 않는다. `storage_busy`는 같은 기준으로 나중에 재시도할 수 있다.
- 성공 응답의 `cleanup_failures`는 저장 성공과 정리 경고를 나눠 보고하고 재저장하지 않는다. timeout·응답 소실은 먼저 같은 문서/대응과 이벤트를 조회한다. 본문 hash 일치만으로 해당 요청의 저장을 증명하지 않는다.
- 영향 확인이 요청 범위에 있으면 변경 전 `ontology_impact`의 source/graph/review/history 네 revision을 보관하고 저장 성공 뒤 별도 조회의 `baseline`으로 사용한다. 영향 조회 실패는 완료된 쓰기를 되돌리거나 반복할 이유가 아니다. 자동 연쇄 수정은 하지 않는다.
- 변경 대상·실제 저장 결과·출력 revision/이벤트·경고·남은 재검토만 간단히 보고한다. 모델의 판단과 형식 검증을 실제 사람 승인이나 의미적 진실로 표시하지 않는다.

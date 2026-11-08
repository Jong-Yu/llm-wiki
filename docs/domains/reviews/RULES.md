# 검토·전문가 판단 작업 규칙

해당 도메인의 동작·데이터를 읽거나 변경할 때 적용합니다. 기존 보존 규칙을 내용 변경 없이 옮겼으며 링크만 새 위치로 연결합니다.

- 원문에 근거한 검토·수정·되돌림은 tenant 모드의 `ontology_review` 권한과 `ontology_review_query`의 `claim_id`·`state_revision`을 사용합니다. 검토 수정에는 실제 인용과 모든 한정어·관점·출처를 명시합니다. 원문 정정은 `wiki_write`, AI가 새 사실을 추출하려면 출처 추가 후 재추출로 구분합니다.
- 원문 인용 없는 전문가의 업무 판단은 별도 `ontology_policy` 권한과 `ontology_policy`·`ontology_policy_undo`를 사용합니다. 사용자가 실제 요청한 판단만 기록하고 이유와 전체 한정어·적용 관점을 명시합니다. 인증 주체·tenant·시각·출처는 서버가 기록하며 임의로 위조하지 않습니다. 전문가 판단의 근거는 Action log이며 가짜 원문 인용을 붙이지 않습니다. AI가 스스로 내린 모의 판단을 사람의 승인으로 승격하지 않으며 토큰 사용을 사람이 직접 승인했다는 증명으로 과장하지 않습니다. 세부 범위와 계약은 [D-031](DECISIONS.md#d-031--전문가-정책을-기존-검토-원장에-보존하고-최신-판단으로-조회-2026-10-22-선행-1)을 따릅니다.
- 새 AI 세션도 먼저 허용 tenant와 관점을 확인하고 `wiki_search`로 관련 문서를 찾은 뒤 `ontology_review_query`의 `effective_graph`·`policies`·미검토/보류·`pending_history`를 읽어 답합니다. 기존 조회·맥락·연결의 `layer=machine`에는 전문가 판단이 적용되지 않습니다. 정책의 출처에는 `event_id`·`state_revision`을 유지하고 다른 범위·보류된 옛 판단을 현재 사실로 쓰지 않습니다. 분류 교체만으로 이전 분류의 논리적 부정을 추론하지 않습니다. 검토 이력 있는 그래프 재생성에는 `expected_revision`과 최신 `expected_state_revision` 모두 필요합니다. 충돌 시 원문·그래프·검토 이력을 대조하며 버전값만 바꾸지 않고, 재추출 뒤 옛 승인을 자동 이식하지 않습니다.
- `_knowledge/reviews/<documentId>.json`은 신규 검토 원장이고 ID 없는 MD는 `legacy-<문서경로 SHA256>.json`을 사용합니다. 기존 `_reviews/<문서경로 SHA256>.json`은 그 위치에서 호환 읽기/갱신하며 새/옛 동시 존재는 충돌로 보존합니다. 검토·전문가 판단의 이력을 보존하는 원장이므로 파생 캐시로 삭제하지 않습니다. 검토/정책 API의 원자적 저장과 새 이벤트로 되돌리는 절차를 사용합니다. 한도·검토 원장 손상·저장 실패를 자동 초기화나 재시도로 우회하지 않고, 저장 성공의 정리 경고를 별도로 보고합니다. 세부 계약은 [D-028 및 D-031](../../DECISIONS.md)을 따릅니다.

- Clean Up은 [D-075 공개 계약](../ontology/PLAN.md#clean-up-공개-계약)의 명시 미리보기/항목 선택/요청 영수증/역이벤트를 사용합니다. 원문 검토 events와 cleanup_events를 함께 보존·검증하며 기각/과거 표시 정리를 새 판단이나 승인 승계로 해석하지 않습니다. 현재 목록은 current_claims/current_pending_history, 감사·재검토 근거는 원래 claims/history/pending_history를 구분해 읽습니다.
- 사람의 독립 관계 추가는 [D-078](DECISIONS.md#d-078--사람이-추가하는-독립-관계와-현재-ui의-검토-복원-2026-10-29)을 따릅니다. 원문 근거 추가와 전문가 업무 판단을 권한·근거별로 나누며, `relation_events`도 보존 대상입니다. `authored_relations`의 active/pending/inactive/other_scope와 `relation_history`를 함께 읽고 옛 추가를 현재 사실로 승계하지 않습니다. 새 개체를 만들거나 기존 claim의 정정으로 독립 관계를 위장하지 않습니다.

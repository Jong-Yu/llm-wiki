# 검토·전문가 판단 계획

## 현재 상태

- 관계·속성 정정, 원문 검토와 전문가 업무 정책, 기록·되돌림, 사람이 추가하는 독립 관계를 현재 온톨로지 UI와 저장 경로에 연결했습니다. 원문 인용 기반 검토와 원문 밖 업무 판단은 권한·근거·출처를 구분합니다. [D-078](DECISIONS.md#d-078--사람이-추가하는-독립-관계와-현재-ui의-검토-복원-2026-10-29) · [RULES](RULES.md).
- [Clean Up](../ontology/PLAN.md#clean-up-공개-계약)은 명시 선택·요청 영수증·역이벤트로 현재 목록의 표시만 정리합니다. 원래 검토 events와 cleanup_events를 함께 보존하며 기각/보류·전문가 정책·새 세대의 재검토를 바꾸지 않습니다.
- 영향 조회의 같은 잠금·정확한 자료 기준 안에서 검증 결과와 조립을 재사용합니다. 요청 밖 공유, 손상 은폐, 원장/hash/정책/현재성 검사 생략은 하지 않으며 반환 자료를 분리합니다. 관련 성능 변경은 서버에 반영했고 [검증 기록](HISTORY.md)을 따릅니다.
- 사용자 위임 AI 팀의 해상 보류 관계 887개 검토를 source 계층 이력에 반영했습니다. 사람 전문가 승인·업무 정책으로 기록하지 않았고, 정의·경계 질문 38개와 단일 인용 표현 한계 4개는 보류했습니다. 원문·기계 그래프·기존 이력과 범위 밖 주장은 보존했습니다. [검토 기록](HISTORY.md#2026-11-06--해상-자료887관계의-위임-ai-팀-협의-적용) · [남은 질문](../../../evals/2026-11-06-maritime-corpus/execution/team-deliberation/remaining-questions.json).

## 공개 구현 계약

- 신규 원장은 `_knowledge/reviews/<documentId>.json`, ID 없는 MD는 `legacy-<경로 SHA256>.json`을 사용합니다. 기존 `_reviews/<경로 SHA256>.json`은 그 위치에서 읽기·갱신하며 새/옛 동시 존재는 KnowledgeStorageConflict로 보존합니다.
- 신규 envelope는 document_id를 보관하고 기존 envelope/event/hash/actor는 재작성하지 않습니다. 원문이 사라진 원장도 발견하되 과거 판단을 현재 사실로 적용하지 않습니다. 서버 actor의 policy_revision과 선택 access_revision을 보존하며 AI 판단을 사람 승인으로 승격하지 않습니다.
- ReviewStore의 전체파일 source_revision·graph generation·history 기반 state_revision CAS, 전체 원장 검증, 원자 교체·새 이벤트 되돌림을 유지합니다. 신규 body 추출의 인용은 본문에서 찾고 전체파일 줄로 저장합니다. 재추출 뒤 옛 검토·정책은 pending입니다.

## 남은 검증

실제 사람 전문가의 업무 판단·정책 적용과 Windows 실제 화면 검증은 남아 있습니다. 위임 AI 원문 검토와 격리 정책 검사를 실제 전문가 승인으로 표시하지 않습니다. 독립 관계의 MCP 변경·영수증은 연결했으며 새 개체 생성은 미구현입니다. 다른 실행 환경과 운영 반영은 [플랫폼 계획](../platform/PLAN.md)을 따릅니다.

## 완료 조건과 근거

구/신 원장 읽기·추가 기록, event/actor 보존, 동시 CAS, 저장 실패 전 파일 보존과 성공 후 정리 경고, 재생성 뒤 판단 보류 및 과거 원장 prefix 복원을 확인합니다.

[적용 결정](DECISIONS.md) · [상세 규칙](RULES.md) · [검증 기록](HISTORY.md)

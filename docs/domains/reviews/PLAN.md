# 검토·전문가 판단 계획

## 현재 상태

### 해상 원문 관계887개 AI 팀 협의의 운영 반영 (2026-11-06)

사용자 위임으로 두 관계 검토자와 주 에이전트가 보류887개를 교차 반론·답변하고, 수용729·정정100·반려16·보류42를 현재 source 계층 검토 이력에 실제 반영했습니다. 변경값104개와 명칭 대응2건의 최종 의견을 확인했고 실제887이벤트·원래 이력·대상 밖 주장을 보존해153문서를 새 연결에서 확인했습니다. human approval·전문가 정책 쓰기는0이며 제품 구현·발행 프롬프트·기계 그래프를 변경하지 않았습니다. 남은38개 정의·경계 질문과4개 단일 인용 표현 한계는 자동 승인하지 않습니다. [팀 협의 기록](../../../evals/2026-11-06-maritime-corpus/execution/team-deliberation/FINAL_SUMMARY.json)과 [남은 질문](../../../evals/2026-11-06-maritime-corpus/execution/team-deliberation/remaining-questions.json)을 따릅니다.

일반 검토 이벤트의 target·claim ID 검증 뒤, 같은 이벤트의 document/collection/entities/source_revision에서 이미 성공한 canonical JSON 값 검증만 재사용합니다. before/after 구조·decision과 전체 hash/chain/undo·정책·cleanup/독립 관계·현재성 검사는 유지하며 다른 이벤트/다음 요청과 공유하지 않습니다. 새7개 포함 관련49개·전체653개·독립 검토 뒤 운영 반영했습니다. [검증 기록](HISTORY.md#2026-11-06--검토-원장의-동일-값-검증-재사용)과 [실측](../platform/HISTORY.md#2026-11-06--검토-원장의-동일-값-검증-재사용)을 따릅니다.

기본 domain/viewpoint=None이고 현재·과거·undo를 포함한 일반/독립 정책이 전혀 없을 때만 동일한 source/current 그래프 조립을 공유합니다. 두 effective 검증은 계속 수행하고 정책 이력·다른 관점·legacy/비정상 상태는 기존 경로입니다. 정책 이벤트가 없는 `_apply_policies`는 검증된 기존 source 결과를 유지합니다. 전체646개·독립 검토 뒤 운영 반영했고 [검증 기록](HISTORY.md#2026-11-06--2초-목표의-영향-조회-조립메타정보-해석-재사용)과 [실측](../platform/HISTORY.md#2026-11-06--2초-목표의-영향-조회-조립메타정보-해석-재사용)을 따릅니다.

검토 조회의 값 복사를 JSON dict/list와 불변 scalar에 맞게 단순화했습니다. 복사별 memo와 비표준 값의 기존 deepcopy fallback으로 mutable 분리·내부 alias/cycle을 유지하며 hash·claim ID·원장·정책·현재성·두 effective 검증은 바꾸지 않습니다. 새6개를 포함한 핵심23개와 공통621개, 병행 변경의 추가18개·독립 검토를 통과해 같은 운영 주소에 반영했습니다. [검증 기록](HISTORY.md#2026-11-06--검토-응답의-복사-비용-감축)과 [실측](../platform/HISTORY.md#2026-11-06--검토-응답의-복사-비용-감축)을 따릅니다.

2026-11-06 영향 조회는 같은 잠금의 정확한 원문·그래프·전체 원장·이력 기준에서 검증한 machine/ledger를 재사용합니다. 관측은 immutable JSON bytes로 보관하고 render마다 새 자료로 복원하며, 불일치·손상은 기존 검증으로 돌아갑니다. 현재 정책 on/off·원문/독립 관계·다른 문서 현재성·두 유효 그래프 검증은 계속 수행합니다. [검증 기록](HISTORY.md#2026-11-06--같은-영향-관측의-검토-검증-재사용)과 [실측](../platform/HISTORY.md#2026-11-06--통합-이력과-변경-영향의-반복-검증-감축)을 따릅니다.

2026-11-06 현재 원문의 검증된 주장 재사용에 더해, render 한 번 안에서 같은 개체 정의의 정규화 결과를 공유합니다. 첫 주장과 같은 시점에만 계산해 기존 ID/hash와 오류 순서를 유지하고 다음 render는 새로 계산합니다. 세대·대상·원문 인용·정책·원장 검증은 유지한 채 서버에 반영했습니다. [검증 기록](HISTORY.md#2026-11-06--render-내-개체-정규화-재사용)과 [실계정 측정](../platform/HISTORY.md#2026-11-06--실계정-재측정과-조회-반복-계산-개선)을 따릅니다.

2026-10-29 Queue A의 관계·속성 정정, 원문 검토/전문가 정책/이력·되돌림, 독립 관계 추가를 현재 온톨로지 UI와 실제 저장 경로에 연결했습니다. 관계 정보·검토 기록 두 탭과 내부 섹션을 사용하며 기존 전체 그래프 조작은 유지합니다. [D-078](DECISIONS.md#d-078--사람이-추가하는-독립-관계와-현재-ui의-검토-복원-2026-10-29)의 원장·권한·CAS·영수증 계약을 적용합니다. 실제 검증 결과와 미실행 범위는 [HISTORY](HISTORY.md)에 기록합니다.

2026-10-29 [D-075 Clean Up](../ontology/PLAN.md#clean-up-공개-계약)을 구현했습니다. 원장의 기존 events를 보존하고 별도 cleanup_events에 명시 선택·영수증·역이벤트를 남깁니다. 현재 목록 투영만 바뀌며 기각/보류·정책 권한과 새 세대의 재검토 경계는 유지합니다. 격리 기능·전송 검증을 완료했으며 실제 전문가 판단·운영 정리는 미실행입니다.

2026-10-28 신규 _knowledge/reviews와 기존 _reviews 호환을 구현했습니다. 문서 ID/경로 충돌 시 원장을 보존하며 현재 세대의 검토와 과거 판단을 분리합니다. 공통 격리 계약 검사 26개가 통과했습니다.

## 공개 구현 계약

- 신규 원장은 `knowledge_root(root, "reviews")/<documentId>.json`, ID 없는 MD는 legacy-<경로 SHA256>.json을 사용합니다. 기존 _reviews/<경로 SHA256>.json은 같은 위치에서 호환 읽기/갱신하고 event/hash/actor/판단을 재작성하지 않습니다. 새/옛 동시 존재는 KnowledgeStorageConflict입니다.
- 신규 원장 envelope에 document_id를 보관하되 기존 envelope와 이벤트는 그대로 읽습니다. 원문이 사라진 원장도 발견하여 과거 이력을 보존하고 현재 사실로 적용하지 않습니다.
- 서버 actor의 기존 policy_revision을 유지하고 선택 access_revision을 허용합니다. 과거 actor에 새 필드를 주입하지 않으며 AI 생성 표시를 실제 사용자 판단으로 승격하지 않습니다.
- ReviewStore 공개 함수·전체파일 source_revision/graph generation/history 기반 state_revision CAS, 전체 원장 검증, 원자 교체·되돌림을 유지합니다. 신규 body 추출의 검토 인용은 본문에서만 찾고 전체파일 줄 좌표로 저장합니다. 재추출 뒤 옛 검토·전문가 정책은 pending입니다.

## 남은 검증

실제 전문가 판단·운영 원장 쓰기는 실행하지 않았습니다. 격리 정책 테스트는 모의 계약 검사입니다. 독립 관계의 tenant MCP 변경·영수증 도구는 후속 [플랫폼 개선](../platform/PLAN.md)에서 연결·검증했습니다. 새 개체 생성과 Windows 실제 화면 검증은 남습니다. 다른 화면·전역 테마·로고 및 UI 문서 정리는 Queue B 범위입니다.

## 완료 조건과 근거

구/신 원장 읽기·추가 기록, event/actor 보존, 동시 CAS 한 건 성공, 저장 실패 전 파일 보존, 재생성 뒤 acceptance/전문가 정책 보류, 과거 원장 prefix 복원을 확인했습니다.

[적용 결정](DECISIONS.md) · [상세 규칙](RULES.md) · [검증 기록](HISTORY.md)

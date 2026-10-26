# 현재 상태와 도메인 안내

현재 상태는 도메인별 PLAN 한 곳에서 갱신합니다. 작업 도메인이 이미 정해졌으면 이 색인을 반복해서 읽지 않고 해당 PLAN·DECISIONS의 관련 절로 바로 갑니다. 관련 없는 도메인과 과거 기록은 기본 입력에 넣지 않습니다.

## 제품 단계

| 단계 | 상태 | 완료 조건의 소유자 |
| --- | --- | --- |
| 0 작업 규칙 | 완료; 도메인 문서 정리 검증 완료 | workflow |
| 1 저장·버저닝 | 완료 | documents |
| 2 MCP | 완료 | platform |
| 3 CLI 로컬·원격 연결 | 완료; 후속 운영 배포와 구분 | platform · access |
| 4 온톨로지·연결 | 구현·검증 완료, 의미 한계 남음 | ontology · reviews · correspondences · knowledge |
| 5 UI·실시간 갱신 | 진행 중; Electron 골격/공통 UI 묶음 완료 기록, 업무 기능 미연결 | ui |
| 6 통합 시연 | 미착수 | workflow |

이 상태는 기존 기록을 이관한 것이며 새 제품 검증이 아닙니다. 요청받지 않은 다음 단계는 시작하지 않습니다.

## 도메인별 시작점

| 도메인 | 작업 대상 | 현재 계획·결정 |
| --- | --- | --- |
| `workflow` | 작업 규칙·계획·제품 목적 | [PLAN](domains/workflow/PLAN.md) · [DECISIONS](domains/workflow/DECISIONS.md) |
| `documents` | core/modules/documents · Wiki 읽기/쓰기/검색 | [PLAN](domains/documents/PLAN.md) · [DECISIONS](domains/documents/DECISIONS.md) |
| `sources` | core/modules/sources · 원본 등록/판본/다운로드 | [PLAN](domains/sources/PLAN.md) · [DECISIONS](domains/sources/DECISIONS.md) |
| `analysis` | 분석 작업/입력·규약·CLI 단계(D-044) | [PLAN](domains/analysis/PLAN.md) · [DECISIONS](domains/analysis/DECISIONS.md) |
| `access` | core/modules/access · tenant/profile/정책 | [PLAN](domains/access/PLAN.md) · [DECISIONS](domains/access/DECISIONS.md) |
| `ontology` | core/modules/ontology · 그래프 추출/스키마/평가 | [PLAN](domains/ontology/PLAN.md) · [DECISIONS](domains/ontology/DECISIONS.md) |
| `reviews` | core/modules/reviews · 원문 검토/전문가 정책 | [PLAN](domains/reviews/PLAN.md) · [DECISIONS](domains/reviews/DECISIONS.md) |
| `correspondences` | core/modules/correspondences · 대응 원장 | [PLAN](domains/correspondences/PLAN.md) · [DECISIONS](domains/correspondences/DECISIONS.md) |
| `knowledge` | core/modules/knowledge · 맥락/개념/연결/영향 | [PLAN](domains/knowledge/PLAN.md) · [DECISIONS](domains/knowledge/DECISIONS.md) |
| `ui` | app/ · React/Electron 화면/공통 UI | [PLAN](domains/ui/PLAN.md) · [DECISIONS](domains/ui/DECISIONS.md) |
| `platform` | core/api · core/mcp · core/runtime · tools/ · 연결/배포 | [PLAN](domains/platform/PLAN.md) · [DECISIONS](domains/platform/DECISIONS.md) |

`review`(renderer)는 `reviews`, renderer의 `knowledge` 중 추출/스키마는 `ontology`, 서버 통합 조회는 `knowledge`로 찾습니다. 문서 경계이며 소스 폴더/모델 소유권을 바꾸지 않습니다. 여러 경계에 걸친 작업만 실제 영향이 있는 도메인을 추가합니다. API/MCP 업무 계약은 해당 업무 도메인, 전송/인증 연결 변경은 platform/access를 함께 확인합니다.

## 기록 관리

- 기존 전체 문서는 [이관 전 기록](history/2026-10-25-before-domain-split/README.md)에 원본 바이트와 SHA-256으로 보존합니다. 파일·당시 검증·미결정·과거 제약을 삭제하지 않습니다.
- 이후 이력은 작업한 도메인의 `HISTORY.md`에만 추가합니다. 현재 PLAN에는 최신 상태·다음 범위·완료 조건·근거 링크를 유지합니다.
- 결정을 찾거나 새 번호를 배정할 때만 [결정 색인](DECISIONS.md)을 확인합니다. 도메인이 정해진 작은 작업에서 전체 색인/이력을 읽지 않습니다.

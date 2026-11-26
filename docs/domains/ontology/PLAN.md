# 온톨로지·의미 평가 계획

## 현재 상태

### 추출·저장

- 원문 판본에 근거한 개체·관계·속성·후보 추출과 스키마 1~6의 호환 조회를 제공합니다. 원문 명시 내용·한정어·출처를 보존하며 후보를 확정 사실이나 사람 승인으로 바꾸지 않습니다. 의미 기준은 [RULES](RULES.md)와 [추출 정책](EXTRACTION_POLICY_DRAFT.md)을 따릅니다.
- `ontology_validate_draft`는 저장 없이 발행 스키마와 전체 그래프 검사를 사용합니다. 개인 CLI는 같은 고정 원문·규약의 수정 가능한 실패만 최대 두 번 전체 재추출하며 저장 시 현재 권한·원문/검토 CAS를 다시 확인합니다. 제한된 관계 방향·끝점 역할 검사는 [D-081](DECISIONS.md#d-081--저장-없는-초안-검사와-제한된-끝점-역할-규칙-2026-10-29)을 따릅니다.
- 파생 줄 보기에는 anchor의 CR/LF 좌표와 진단/문서의 splitlines 좌표를 구별해 안내합니다. 원문·발행 규약·검증기는 유지했으며 실제 평가에서 개별 조건 손실이 남았습니다. 안내 개선을 완전 정확성·의미 동등성으로 판정하지 않습니다. [구조 검증](HISTORY.md#2026-11-21--기존-검증-계약을-유지한-좌표-안내) · [의미 평가](HISTORY.md#2026-11-21--좌표-안내-후속-실행의-익명-의미-평가) · [배포 경계](HISTORY.md#2026-11-22--좌표진단-안내의-분리-배포-경계).
- 기본 입력은 `full`입니다. 공통/단계 지침 비교는 추출 품질·반복 일관성 유지 조건에 미달해 기본값을 바꾸지 않았고 JSON 표현 축소 후보는 철회했습니다. 평가 원시 결과·실패·재현 패치는 보존합니다. [지침 비교](HISTORY.md#2026-11-18--추출-익명-평가-완료와-변동-확인) · [후보 철회](HISTORY.md#2026-11-21--사용자-결정에-따른-후보-철회).
- IMP05 별도 시간 장부·조회 엔진은 [D-084](DECISIONS.md#d-084--imp05-별도-시간-장부와-조회-엔진의-도입-제외-2026-10-30)로 도입 대상에서 제외했습니다. 기존 그래프와 IMP01·제한된 IMP02를 유지하며 후속 개발·재검증을 자동 시작하지 않습니다. 개체 설명 자동 생성과 설명 필드 확장도 도입하지 않았습니다.

### 실자료 검증 상태

- 역할 분리 소규모 파일럿에서 실제 개인 CLI 추출→독립 검사→수정1회를 확인했다. 원문1건의 고정 질문 완전 보존은18/20으로 같고 시간3.34배·보고 토큰3.45배여서 기본 흐름은 유지한다. 반복·동일 예산 자기검토 대조·다른 실문서의 개선은 확인하지 않았다. [실험 결과와 실행기 실패 기록](../../../evals/2026-11-26-role-separated-pilot/REPORT.md).

- 큰 등록 본문의 누적 구간 분석은 개발 원문2개에서 두 번 보완했으나 새 NASA 원문에서 경계에 걸린 문장의 미해결 의견으로 첫 재검토가 중단됐다. 현재 자동 분할은 비활성이며 전체 완료·일반 정확성·반복 일관성을 확인하지 못했다. 실제 모델 출력의 의미 판정과 합성 모델의 큰 본문 전송/저장 검증을 구분한다. [평가 기록](HISTORY.md#2026-11-25--누적-구간-분석의-원문-분리-평가).

- 해상 일반 원문 132개의 등록·추출·위임 AI 검토를 수행했습니다. 후속 관계 검토 뒤 보류 관계 42개와 속성 4,771개가 남았으며 사람 전문가 승인·업무 정책으로 기록하지 않았습니다. 전체 채팅 평가의 저장 실패·미확정 응답이 남아 전체 목표는 미충족입니다. [전체 보고서](../../../evals/2026-11-06-maritime-corpus/REPORT.md) · [팀 검토 기록](HISTORY.md#2026-11-06--보류-관계887개-팀-반론협의와-실제-mcp-반영).
- next-data 재검증은 평가용 6단위의 추출 저장을 확인했으나 처리 주체·예시 범위·표 대응의 의미 문제가 남았습니다. 당시 생성 실패 후 기존 자료를 재사용한 채팅/DOCX 저장은 [지식 도메인 후속 검증](../knowledge/HISTORY.md#2026-11-16--기존-데이터의-템플릿-생성저장과-원본-비교)에서 성공했습니다. 제품 자동 분할·문서 간 개체 병합과 완전한 내용/서식 재현을 확인한 것은 아닙니다. [추출 재검증](HISTORY.md#2026-11-16--next-data-재검증과-진단-실패-원인-보완).
- 전체 그래프 반복 일관성은 아직 충족하지 못했습니다. 형식·인용 검사 통과, 원문 의미 보존, 실제 사람 판단을 각각 판정합니다. 과거 표본과 비용·오류는 [HISTORY](HISTORY.md)에 보존합니다.

## 공개 구현 계약

- 공통 입력 모델과 제출 스키마는 `core/modules/ontology/submission.py`가 소유하며 기존 MCP/runtime import 경로는 호환합니다. 스키마·검증기 지문과 기본값은 유지했습니다. [검증](HISTORY.md#2026-11-25--공통-제출-스키마의-업무-소유권-정리).
- `OntologyStore.generate/query/context/connections`와 전체파일 expected_revision CAS를 유지합니다. 신규 그래프는 `_knowledge/graphs/<documentId>.json`, ID 없는 MD는 `legacy-<문서경로 SHA256>.json`을 사용합니다. 기존 `_ontology/<경로 SHA256>.json`은 그 위치에서 호환 읽기·갱신합니다.
- 신규 추출의 근거는 parse_document의 body이며 저장 인용/앵커는 전체파일 1-based 줄 좌표, source_revision은 전체파일 SHA입니다. envelope는 document_id/body_revision/body_start_line/evidence_coordinates를 보관하고 과거 envelope는 원래 근거 규약으로 읽습니다.
- query/context는 metadata와 body 지문·시작 줄을 구분합니다. evidence_scope는 신규 body와 과거 full_file을 표시하며 metadata만 바뀌어도 전체파일 revision이 다르면 stale입니다. body 지문은 전체 CAS를 대체하지 않습니다.
- 검토 이력이 있으면 expected_state_revision도 필요합니다. generation_id와 원장 epoch를 유지하고 옛 사람 판단을 새 세대에 자동 승계하지 않습니다. source_revision만 교체해 이전 근거를 현재 그래프로 만들지 않습니다.
- 새/옛 동시 존재와 문서 ID/경로 불일치는 `KnowledgeStorageConflict`로 중단합니다. 원문 없는 새 원장의 탐색은 1,000개/16MiB 이내이며 읽기로 복구하지 않습니다.

## 인계와 남은 검증

- 분석 입력이 body여도 source_anchor는 body_start_line - 1을 더한 전체파일 줄과 전체파일 revision을 제출해야 합니다. 어댑터의 source/body 필드·좌표, 발행 규약의 검증기 지문 호환을 유지합니다. 저장 충돌을 단순 재시도로 우회하지 않습니다.
- 관점·사건 분해·앵커/개체 선택의 반복 안정성, 다양한 실문서의 의미 정확성·실제 전문가 과제는 새 원문으로 확인해야 합니다. 진단의 실제 검토 항목 연결과 선택적 문서 수정은 별도 서버/UI 범위입니다.
- 개별 구현의 운영·설치 반영은 [플랫폼 계획](../platform/PLAN.md), 입력 규약과 실행 실패는 [분석 계획](../analysis/PLAN.md)을 따릅니다. 과거 담당 세션의 미실행 기록을 현재 전체 시스템 상태로 사용하지 않습니다.

## 완료 조건과 근거

변경 범위의 구/신 그래프 호환, 문서 ID/경로 충돌, 인용 위치·stale, 원문/검토 CAS와 실패 보존을 확인합니다. 의미·반복성 변경은 [원문 분리 평가](EVALUATION.md)를 거치며 옛 판단이 재생성 뒤 보류되는지 별도로 검증합니다.

[적용 결정](DECISIONS.md) · [상세 규칙](RULES.md) · [검증 기록](HISTORY.md)

## Clean Up 공개 계약

2026-10-29 서버/API/MCP 구현과 격리 기능 검증을 완료했습니다. 아래 경로와 DTO를 UI 인계 계약으로 고정합니다. 실제 UI 연결·운영 실행은 별도 범위이며 검증 결과는 [HISTORY](HISTORY.md)에 기록합니다. 앱은 서버가 반환한 가능 여부·항목 ID를 사용하며 자체 의미 판정으로 항목을 만들지 않습니다.

### 범위·보존·가능 유형

- 명시 문서 **1개**와 인증된 profile의 정확한 domain/viewpoint 조합을 한 거래로 처리합니다. 여러 문서는 각각 미리보기·적용하며 문서 간 원자 거래를 약속하지 않습니다. tenant 전체 자동 정리는 제공하지 않습니다.
- `archive_rejected`: 현재 세대에서 명시적으로 reject된 relations/relation_candidates. 활성 전문가 정책이 덮은 주장·ambiguous 주장·속성은 제외합니다. reject 판단을 새로 만들지 않습니다.
- `archive_pending_review`: 현재 `pending_history`에 있는 과거 원문 검토/되돌림 이벤트 중 relations/relation_candidates. 시간 경과만으로 정리하지 않으며 과거 판본이라는 사실과 원래 판단을 그대로 보존합니다. 전문가 정책/정책 되돌림은 이 기능으로 숨기지 않습니다.
- `exact_duplicates`: `available:false`, `reason:duplicate_claims_prevented_by_validation`. 기존 저장/유효 그래프 검증기가 동일 관계 및 관계-후보 중복을 거부하므로 병합 작업을 만들지 않습니다. 동명/유사 표현/문서 간 추정 동일성은 미지원입니다.
- `deferred_or_uncertain`: `available:false`, `reason:requires_explicit_review`. 근거 부족·defer·미검토·원문 계획/가능성·AI 추정을 기각 또는 거짓으로 바꾸지 않습니다.
- 원문·전체 히스토리·machine 그래프·기존 검토/정책 이벤트는 변경하지 않습니다. 기존 검토 원장에 별도 `cleanup_events`를 추가해 표시 상태와 요청 영수증만 보존합니다. 기존 검토와 cleanup의 합계 1,000이벤트·8MiB 제한을 적용하며 손상/초과는 거부합니다.

### HTTP와 MCP

HTTP 공통 prefix는 `/api/v1/tenants/{tenant}`이며 기존 `{data,meta}`/오류 envelope를 사용합니다. MCP는 tenant 필수·profile 선택과 기존 `{ok,...,access}`를 사용합니다. 모두 같은 `CleanupStore`를 호출합니다.

| HTTP | MCP | 입력 (tenant 제외) |
| --- | --- | --- |
| `GET /documents/cleanup-preview` | `ontology_cleanup_preview` | `document`, 선택 `profile`, `limit` 기본20/최대50, 선택 `cursor` |
| `POST /documents/cleanup` | `ontology_cleanup_apply` | `document`, 선택 `profile`, `request_id`(32자리 소문자 hex), `preview_revision`(64자리 hex), `item_ids`(서버 항목 ID 1~50개, 중복 금지), `reason`(공백 제외 1~1000자) |
| `GET /documents/cleanup-events` | `ontology_cleanup_history` | `document`, 선택 `profile`, `limit`, `cursor` |
| `GET /documents/cleanup-requests/{request_id}` | `ontology_cleanup_request` | `document`, 선택 `profile`, `request_id`(HTTP path) |
| `POST /documents/cleanup-undos` | `ontology_cleanup_undo` | `document`, 선택 `profile`, `request_id`, `event_id`(적용 이벤트의32자리 hex), `expected_state_revision`, `reason` |

미리보기/이력/영수증은 read, 적용/되돌림은 read+ontology_review를 요구합니다. 실제 저장 직전 권한·주체·관점을 재확인합니다. legacy 단일 저장소 MCP에 쓰기 도구를 추가하지 않습니다. 정책을 바꾸거나 ontology_policy 권한을 대체하지 않습니다.

### 응답·판본·명시 선택

- preview: `document`, `scope:{domain,viewpoint}`, `state_revision`, `preview_revision`, `status`(그래프 상태), `capabilities:[{kind,available,reason,count}]`, `items`, `total_items`, `next_cursor`, `complete`, `truncated:false`, `skipped:[]`, `requires_refresh:false`.
- item: `item_id`(64자리 hex), `kind`, `available:true`, `reason`, `claim_id`, `event_id`(근거 판단), `collection`, `decision`, `target`(원래 주장·개체와 근거 snapshot). 가능 항목만 items에 반환하고 미지원 유형은 capabilities에 표시합니다. 현재 근거 관계와 과거 검토를 섞어 진위 판정하지 않습니다.
- preview_revision은 전체 원문/graph/review/history state와 인증 주체·권한 판본·정확한 관점을 묶습니다. 페이지마다 동일 기준을 사용합니다. cursor도 이 범위와 전체 항목에 묶이며 중간 변경은 `catalog_changed`(409), 적용 기준 변경은 `conflict`(409)입니다. 새 미리보기를 읽고 선택을 재검토해야 합니다.
- 적용은 미리보기의 명시 item_ids만 처리합니다. 전체 자동 선택, 알 수 없는 ID, 이미 숨긴 항목, 중복 ID는 허용하지 않습니다. 한 문서 선택분을 단일 원장 교체로 모두 저장하거나 모두 거부합니다. 목록 페이지는 전체 범위 완료와 다르므로 `complete/next_cursor`를 확인합니다.
- 적용/되돌림/영수증: `document`, `request_id`, `event_id`, `event`(아래), `saved:true`, `changed`(새 저장만 true), `replayed`, `state_revision`(현재 재조회 기준), `cleanup_failures`(이번 저장의 임시 정리 경고), `retry_policy:read_receipt`.
- event: `id`, `action:cleanup_apply|cleanup_undo`, `request_id`, `request_hash`, `actor`, `scope`, `timestamp`, `reason`, `base_state_revision`, `source_revision`, `graph_revision`(null 가능), `history_revision`, `items`(적용한 전체 항목 snapshot), `undo_of`(적용은 null), `previous_hash`, `hash`. 과거 event를 현재 상태로 재작성하지 않습니다.
- history: `document`, `state_revision`, `items`(최신순 event 배열), `total_items`, `next_cursor`, `complete`, `truncated:false`, `skipped:[]`, `requires_refresh:false`. 전체 원장을 먼저 검증하고 출력만 페이지화합니다. 같은 tenant의 원장은 다른 관점도 읽을 수 있으나 영수증은 요청한 사용자와 정확한 관점에만 대응합니다.

### 현재 조회·재요청·실패·되돌림

- `ontology_review_query`와 HTTP document knowledge의 기존 `claims/history/pending_history/machine_graph`는 원시 검토 정보를 유지합니다. 추가 `current_claims`, `current_pending_history`, `cleanup:{archived_item_ids,archived_claim_ids,archived_event_ids}`가 현재 목록/검토함용 투영입니다. UI는 current_*를 우선 사용합니다. 통합 검토함과 개념의 현재 목록도 같은 투영을 사용합니다. effective_graph의 기각/과거 제외 의미는 기존과 같습니다.
- 숨김은 정확한 원문/그래프/원문 히스토리 세대·판단 이벤트·관점에만 적용됩니다. 세대나 판단이 바뀌면 새 항목에 자동 승계하지 않습니다. 감사 이력에는 이전 정리를 계속 남깁니다.
- request_id는 문서+사용자 범위에서 유일합니다. 같은 ID/같은 전체 입력/관점은 현재 쓰기 권한 확인 후 이미 저장된 영수증을 반환하고 재적용하지 않습니다. 같은 ID의 다른 입력은 conflict입니다. 응답 유실/연결 취소 뒤에는 먼저 request 조회(read 권한)로 확인합니다. 404는 현재까지 영수증 없음이며 진행 중 요청의 취소 확정이 아닙니다.
- 미리보기는 저장하지 않으므로 취소는 UI가 선택을 버리는 동작입니다. 적용 요청 전송 뒤 연결 취소는 저장 취소를 보장하지 않습니다. 저장 성공의 cleanup_failures는 성공+정리 경고이며 자동 재실행하지 않습니다. 저장 전 오류는 이전 원장·원문·그래프를 보존합니다. storage_busy는 같은 입력으로 나중에 재요청할 수 있습니다.
- undo는 최신 state_revision과 같은 정확한 관점을 요구하고, 해당 apply 전체 선택을 새 역이벤트로 되돌립니다. 이미 되돌린 이벤트는 거부합니다. 세대가 바뀌어 이미 효력이 없는 정리도 감사 상태를 되돌릴 수 있으나 과거 주장/승인을 현재로 복원하지 않습니다. 새로 적용한 다른 정리를 덮어쓰지 않습니다. 항목 일부 되돌림은 이번 범위 밖입니다.


Clean Up의 추가 저장 의미와 보존 경계는 [D-075](DECISIONS.md#d-075--판단-원장을-보존하는-문서별-clean-up-2026-10-29)를 따릅니다. 변경 영향 조회는 cleanup 필드를 포함한 과거 원장 prefix도 확인하며 추가 hash 입력 16MiB를 넘으면 기존 `baseline_review_unverified`/복원 불가로 표시합니다. 추측한 과거 상태로 대체하지 않습니다.

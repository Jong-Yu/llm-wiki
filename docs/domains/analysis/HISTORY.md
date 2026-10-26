# 분석 작업·추출 규약 작업 기록

## 2026-10-26 — 별도 의미 검사 상태 충돌과 부분 보고 보존

- 공개 [RFC9111 실패](../../../evals/rfc9111_stale_20261026/separate-check-validation.json)와 원시 assessment를 읽어 R-S02·R-S05·R-S10의 `not_run`/`schema_limit` 충돌을 재현했습니다. 원래 보고는 계속 `invalid_diagnostics`로 거부되며 기존 평가 파일·raw verdict는 바꾸지 않았습니다. 새 파생 보존 경로는 다른 7개 규칙과 원래 7개 finding을 그대로 유지하고 충돌한 3개 규칙만 `error`로 남깁니다. 이 개발 회귀 결과는 새로운 의미 정답이나 실제 모델 개선 증명이 아닙니다.
- 변경: `core/client/semantic_check.py`의 상태 지침·상태별 중첩 출력 스키마·내용 변경 없는 v2 투영과 `analysis_results/diagnostics.py`의 공통 인용/규칙 검사·부분 오류 보존. 확인한 표현 손실은 `schema_limit`/`fail`, 미확정은 `not_run`으로 구분합니다. 유효한 규칙·근거를 보존하되 잘못된 인용/대상은 raw에만 남고 해당 규칙은 `error`입니다. 전역 기준/실행/형식 오류는 전체 실패로 보존합니다. 기존 API/다섯 상태/result refs와 발행된 진단 v1/v2의 canonical SHA256은 변경 전후 동일합니다.
- **고유 27개 통과**: 개인 검사/공개 실패·상태 조합 9개, 규칙/릴리스·부분 보고·원시/파생 요청 분리 11개, 기존 진단 4개, 실제 in-process MCP/ASGI 1개, 실제 loopback 서버·별도 CLI 프로세스 2개입니다. CLI 모델만 합성 실행 파일이며 정상 저장과 잘못된 인용의 부분 보고, 남은 fail 보존, 서버/로컬 보고 일치·정확한 request/hash/인덱스·raw 보존·원문 전체 이력 1회·사람 승인 없음까지 확인했습니다. 45개 상태/verdict 조합은 원본/실제 Codex 엄격 스키마 양쪽에서 검사했습니다.
- 실행: 최초 집중 22개가 1.416초, 추가 2개·영향 검사 2개·MCP/ASGI 1개가 통과했습니다. 같은 실행의 CLI 1개는 sandbox loopback bind 거부로 미실행되어, 허용된 로컬 실행에서 정상/부분 오류 CLI 2개를 13.393초에 통과했습니다. 새 시험의 초기 괄호 오타는 수집 전에 수정했으며 제품 성공 수로 세지 않습니다. 시스템 Python에 pydantic이 없어 일회성 schema 지문 조회를 프로젝트 `.venv`로 다시 수행했습니다.
- 미실행/인계: 실제 외부 모델 호출은 0회입니다. mcp_6은 새 공개 원문 평가의 전송 승인 대기로 `not_run`을 보고했으며 이 세션에서 대신 실행하지 않았습니다. 공통 Python 전체 회귀는 fastapi_9, 앱 build/E2E는 기존 ui_11 소유입니다. 운영 발행/허용 정책·권한·위키/원장·Windows/WSL2 실기기·HTTPS/서명 검증은 변경하거나 완료로 표시하지 않습니다. [D-061](DECISIONS.md#d-061--별도-의미-검사-상태-계약과-부분-보고-보존-2026-10-26)을 따릅니다.

재현 명령(새 변경·실패에 해당하는 검사만 다시 실행했습니다):

```sh
.venv/bin/python -B -m unittest core.tests.runtime.test_semantic_check core.tests.modules.test_rule_diagnostics core.tests.modules.test_analysis_diagnostics -v
.venv/bin/python -B -m unittest core.tests.modules.test_rule_diagnostics.RuleDiagnosticTests.test_partial_report_and_rejected_original_keep_separate_exact_receipts core.tests.modules.test_rule_diagnostics.RuleDiagnosticTests.test_partial_report_never_repairs_global_binding_or_evidence core.tests.runtime.test_semantic_check.SemanticCheckTests.test_execution_failure_preserves_audit_and_error_report core.tests.runtime.test_semantic_check.SemanticCheckTests.test_invalid_quote_keeps_other_rules_and_raw_report_without_repair core.tests.api.test_rule_diagnostics_protocol core.tests.runtime.test_semantic_check_cli -v
.venv/bin/python -B -m unittest core.tests.runtime.test_semantic_check_cli -v
```

## 2026-10-25 — 규칙별 판정·별도 의미 검사

- 변경: `analysis_results/rule_checks.py`가 R-A01~10의 실제 `pass/fail/not_run/not_applicable/error`와 검사 이유를 기록합니다. 기존 canonical 검증기·저장 경계를 재사용하고, 실패 시 선행 통과와 후행 미실행을 보존합니다. `diagnostics.py`의 v2는 R-S01~10·근거 finding·미실행/오류 이유·원문/입력/규약/제출 판본·별도 검사 실행 지문·표현 한계를 보존합니다. 기존 v1 진단과 불변 v1 전용 릴리스는 계속 읽고, 새 발행만 v1/v2를 명시합니다.
- 개인 검사: `core/client/semantic_check.py`가 고정 원문 우선 감사와 중립 그래프 대조를 두 새 개인 어댑터 세션으로 실행합니다. 생성자 프롬프트/진단과 후보 reason/question은 검증 입력에서 제외하고, 원시/검증용 제출 hash와 원문 감사 기록을 보존합니다. 공통 담당이 연결한 `--semantic-check`는 기존 MCP 결과 도구의 새 request ID·`save=false`에 검사 보고를 저장한 뒤 일반 그래프 저장을 수행합니다. 모델/보고 오류는 error 보고, 취소는 로컬 not_run 보고를 남깁니다. 서버 AI/셸 실행·검토 원장 승인을 추가하지 않았습니다.
- 같은 기준의 재개 통합 요청도 처리했습니다. `repository.summary`는 같은 analysis basis의 확인된 이전 run 저장을 집계하며 `current_run/current_scope`를 구분합니다. `wiki_receipt`는 정확한 원문·전체 이력이 일치하는 같은 기준의 선행 저장을 승계합니다. 이전 run의 같은 기준 pending 영수증은 계속 차단하고, 새 rebase 이전 이력은 완료 집계에 넣지 않습니다. 공통 basis 연쇄·CLI 재개 변경은 fastapi_4 소유입니다.
- 실제 검증: 기존 진단/결과/규약 13개, 신규 규칙·릴리스/개인 검사 10개, 실제 in-process MCP/ASGI 신규·기존 4개가 통과했습니다. 추가로 같은 기준 재개·pending 보존 2개, 불확실성 보존 1개, 저장 직전 기존 경계 2개를 확인했습니다. 초기 시험의 `StorageBusyError` 인수와 이력 디렉터리 glob fixture 오류를 수정해 해당 시험만 재실행했습니다. 형식·인용·보존 시험이며 의미 정확도 평가는 아닙니다.
- 실제 프로세스: `core.tests.runtime.test_semantic_check_cli` 1개가 7.316초에 통과했습니다. 격리 loopback 서버·실제 `tools.analysis_cli --run-ai --semantic-check`·합성 Codex 실행 파일로 위키/그래프 영수증 2개와 별도 진단 초안 1개, 원문 감사·실행 hash·서버/로컬 보고 일치·토큰 비출력·수정 전 위키 전체 이력 1회를 확인했습니다. 최초 sandbox의 loopback bind 거부 후 허용된 동일 시험을 재실행했습니다. 실제 모델/운영 서버를 사용하지 않았습니다.
- 미실행: 실문서 의미 정확도/원문 분리 평가, 실제 사람 검토 승인, Windows 실제 OS, Electron 전체 동선 및 전체 제품 회귀는 이 세션에서 수행하지 않았습니다. UI/공통 Python 최종 통합 검증은 해당 담당의 별도 기록을 따릅니다. 운영 자료·규약 발행·기본/허용 정책·실서버 업데이트는 변경하지 않았습니다.

재현 명령(이번에는 필요한 묶음/사례를 나누어 실행했고 마지막에 모두 반복하지 않았습니다):

```sh
.venv/bin/python -B -m unittest core.tests.modules.test_rule_diagnostics core.tests.runtime.test_semantic_check core.tests.api.test_rule_diagnostics_protocol -q
.venv/bin/python -B -m unittest core.tests.runtime.test_semantic_check_cli -q
```

## 2026-10-25 — 서버 오류4개 수정

- 범위: 코드 점검에서 재현한 연속 관계 복구의 검토 누락, 계획의 자기 저장 후 단계 중단, 추출안 최초 상태 기록 실패 후 재접수 불가, 입력 묶음의 늦은 전체 용량 검사4개만 수정했습니다. 화면·API 입력·MCP 공개 계약·의미 스키마/배포 지문·운영 자료/정책/토큰은 변경하지 않았습니다. 새 의존성/운영 이관/실제 AI 실행은 없습니다.
- 연속 복구: `analysis_proposals/store.py`에서 각 복구 당시의 불변 후보와 최종 후보의 실제 전체 주장·인용·조건·식별자를 대조합니다. 당시 후보 참조를 최신값으로 바꾸지 않고 `recovery_bindings`로 연결을 남기며, 기존 인용 그대로 복구한 관계와 새 인용으로 ID가 바뀐 관계 모두 최종 세대의 실제 accept/edit를 요구합니다. 의미/검토 승인을 자동 복사하지 않습니다. 최종 후보에서 복구 주장이 바뀌거나 사라지면 명시 판단을 요구하고 거부합니다.
- 최초 준비 복구: 동일 모듈의 `_load_input`과 `_finish_preparation`을 최초 생성/재접수에서 공유합니다. 이미 공개한 입력·후보의 바이트를 보존하고 같은 소유자·요청 지문·후보 내용·현재 권한/원문 기준을 확인한 뒤 누락된 최초 상태만 연결합니다. 손상된 상태나 부분 후보는 초기화하지 않으며 다른 요청 내용·변경된 원문·권한 회수는 거부합니다. 마지막 근거 확인과 상태 연결은 위키 잠금 안에서 수행합니다.
- 계획 승계: `analysis_plans/store.py`와 `analysis_inputs/bundles.py`의 내부 실행 연결에서 기존 `basis.validate_captured`/`expected_after_saves`를 재사용합니다. 최초 계획과 작업 기준의 명시 맥락이 같을 때 동일 job/run/basis의 실제 저장 영수증·전체 이력 연쇄만 승계합니다. 출력 대상이 필수 맥락에도 포함된 Wiki 저장→그래프 입력/저장을 허용하고, 외부 수정과 정책 변경은 계속 거부합니다. 외부 validate/handoff의 최초 계획 비교와 불변 계획은 유지합니다.
- 읽기 예산: 공통 `analysis_inputs/files.py:load`에서 설명서도 전체 예산으로 제한하고, 구성마다 남은 예산만 읽습니다. 선언 크기의 초과는 읽기 전에 거부하고 실제 파일이 설명서보다 커진 경우에도 한도 확인용1바이트 외에는 전체 예산을 넘지 않습니다. 정상 UTF-8/빈 구성·정확한 경계·기존 revision/hash 오류 계약과 보존 파일을 유지합니다.
- 실제 검증: **신규 고유5개와 관련 기존3개, 총8개 통과**. 입력 예산/정상·변조 경계 신규2개는0.007초, 계획의 자기 저장→실제 그래프 저장/불변 계획/외부 검증·정책 변경/외부 A→B→A 이력 거부 신규1개는1.084초, 기존 같은 Wiki 재분석의 새 세대/옛 승인 보류1개는0.841초였습니다. 추출안의 최초 실패 재접수/손상·부분 후보·권한/기준 보존과 연속 복구 신규2개, 기존 단일 keep·exclude와 새ID reextract 호환2개는 합계1.801초에 통과했습니다. root의 공통 읽기 수정이 포함된 상태에서 해당 통합 경로를 실행했습니다.
- 재현/제한: 읽기 예산 검사는 수정 전 합계/설명서 초과2건의 실제 초과 읽기와 거짓 크기의 다른 오류를 확인한 뒤 수정 후 통과했습니다. 정상 판본/hash·파일 보존도 함께 확인했습니다. 전체 회귀·Electron 빌드/화면 검사·실제 사용자 자료·실문서 의미 평가는 실행하지 않았고 이미 통과한 묶음을 최종 반복하지 않았습니다. 화면의 다음 페이지 자동 선택과 별도 요청이 필요한 광범위 공통화/이력 탐색 성능 개선은 이번 범위가 아닙니다.

실제로 필요한 묶음만 나누어 실행한 명령입니다. 아래 모음을 다시 실행하지 않았습니다.

```sh
.venv/bin/python -B -m unittest core.tests.modules.test_analysis_input_files -q
.venv/bin/python -B -m unittest core.tests.api.test_planned_execution_protocol.PlannedExecutionTests.test_target_context_follows_only_own_saved_results_and_rejects_external_changes -q
.venv/bin/python -B -m unittest core.tests.api.test_planned_execution_protocol.PlannedExecutionTests.test_plan_handoff_same_graph_creates_new_generation_without_old_approval -q
.venv/bin/python -B -m unittest core.tests.api.test_analysis_proposals_api.AnalysisProposalApiTests.test_initial_state_failure_reconnects_only_the_exact_current_request core.tests.api.test_analysis_proposals_api.AnalysisProposalApiTests.test_successive_recoveries_require_every_retained_claim_review core.tests.api.test_analysis_proposals_api.AnalysisProposalApiTests.test_missing_exclusion_recovery_draft_and_actual_new_claim_review core.tests.api.test_analysis_proposals_api.AnalysisProposalApiTests.test_reextract_link_and_saved_receipt_survive_state_failure_and_write_revocation -q
```

## 2026-10-25 — MCP 우선순위1 계약 구현·검증

- 변경: `analysis_results/diagnostics.py`와 결과 저장/조회·MCP에 진단 스키마, 원문 인용/줄·초안 대상 검증, 불변 원시 제출 및 초안/거부/성공 영수증 보존을 연결했습니다. `save=false`는 자료 저장 없이 `draft`로 남고, 신고된 미독·위키 누락은 실제 저장을 막습니다. AI 의견과 `human_reported`는 client_reported이며 검토 원장/사람 승인으로 변환하지 않습니다. CLI의 위키 경고와 그래프 누락도 새 응답 봉투로 서버에 전달합니다.
- 변경: 발행 의미 원문·예시·JSON Schema를 v3~v6별 허용 술어/끝점/mapping/출처 관계에 맞추고 `diagnostics.schema.json`을 규약 구성에 추가했습니다. `analysis_inputs/basis.py`·준비/조회·API/MCP에서 규약·관점·명시 맥락과 모든 출력 대상의 상태를 최초 기준으로 고정합니다. 같은 job/run/basis의 실제 저장 영수증·전체 이력 연쇄만 후속 입력으로 승계하고, 외부 변경·맥락 생략의 재해석·옛 bundle/extraction 재사용을 차단합니다. 기존 분석 계획 연결은 유지했습니다. 단순 재claim은 기준을 바꾸지 않고 명시 rebase만 새 기준을 만듭니다.
- 보완: 다중 대상이 필수 맥락과 겹치는 경우와 ontology-only 대상도 고정합니다. 자기 저장 직후 외부 A→B→A 변경은 실제 `history_entry`와 원래 전체 이력 지문으로 구별합니다. 이전 basis의 pending은 이력에 남기되 새 기준의 완료를 막지 않습니다. draft 집계와 saved.json을 통한 진단 복원을 보완했습니다. 독립 읽기 전용 재검토에서 이 4건의 해소를 확인했고 남은 확정 결함은 없었습니다. 독립 검토는 별도 시험 통과 수에 더하지 않았습니다.
- 실제 검증: **고유 35개 통과**. 입력 기준/결과/진단/저장 경계/API/MCP·실행 신고 24개(14.619초), 발행 규약/CLI 입력/기존 tenant 도구 공개 계약 9개(1.162초), 임시 실제 MCP 서버·별도 CLI 프로세스·합성 AI 실행의 전체 저장 및 부분 실패 2개(12.790초)입니다. 마지막 진단 검사에는 잘못된 버전 타입·인용/대상·승인 필드, 존재하지 않는 입력과 다른 입력 판본의 보존/조회도 추가해 해당 1개만 재확인했습니다(0.125초, 중복 합산 없음). 기존 위키/전체 이력·그래프·검토 보존, CAS·권한 회수·취소 후 본인 조회, 불변 릴리스와 구형 릴리스 명시 거부, 기본 규약 변경/필수 맥락/재claim/rebase/옛 작업 전환을 확인했습니다.
- 화면 호환: 공유 분석 계약에 `draft` 상태를 추가하고 결과 제목을 초안 보존으로 표시했습니다. 변경 2파일의 Oxc/형식과 renderer 타입 검사가 통과했습니다. 전체 타입 검사는 이번 수정 밖의 `app/tests/e2e/document-content.spec.ts:359–361`의 nullable content 오류 3개로 통과하지 못했습니다. Electron은 실행하지 않았습니다.
- 실행 중 조정: 최초 CLI 통합은 sandbox의 loopback 포트 제한으로 실행되지 않아 허용된 로컬 실행으로 해당 2개만 수행했습니다. 최초 lint는 시스템 Node16/아키텍처 선택 때문에 실행되지 않았고, 기존 번들 Node와 그 PATH로 변경 파일 검사에 통과했습니다. 추가 입력 부재 조회 검사는 기존 계약의 pending_reconcile을 거부 예외로 잘못 기대한 시험을 바로잡았습니다. 운영 자료·정책·토큰·발행 규약은 변경하지 않았습니다.
- 남은 범위: 새 버전 발행·허용/기본 규약 설정·업데이트된 서버 실행과 공통 기준 없는 진행 작업의 명시 rebase가 운영 전환에 필요합니다. 실제 모델/실문서 의미 정확도·원격 두 PC·Electron·전체 회귀·규칙별 자동 판정 세분화는 미실행입니다. 완료는 요청받은 우선순위1 계약이며 후속 범위를 자동 시작하지 않습니다. 결정은 [D-052](DECISIONS.md#d-052--mcp-진단-보존버전별-제출작업-공통-기준-2026-10-25), 실행/전환은 [README](../../../README.md#공통-규약과-고정-입력)에 둡니다.

재현 모음(위처럼 필요한 묶음으로 나누어 실행했으며 최종 전체 반복은 하지 않음):

```sh
.venv/bin/python -B -m unittest core.tests.modules.test_analysis_basis core.tests.modules.test_analysis_inputs core.tests.modules.test_analysis_results core.tests.modules.test_analysis_diagnostics core.tests.modules.test_analysis_save_boundary core.tests.api.test_analysis_inputs_protocol core.tests.api.test_analysis_results_protocol core.tests.api.test_ai_execution_provenance -q
.venv/bin/python -B -m unittest core.tests.modules.test_extraction_rules core.tests.runtime.test_personal_ai_inputs core.tests.mcp.test_tenant_mcp.TenantMCPTests.test_tool_contract_and_access_context_only_disclose_own_memberships -q
.venv/bin/python -B -m unittest core.tests.runtime.test_personal_ai_workflow -q
```

## 2026-10-25 — MCP 추출 정책 표현 범위 점검

- 요청 범위는 정책·API·화면 설계와 현행 MCP 계약의 차이 확인입니다. D-044·D-050, 원본 계보/분석 범위/재추출 비교 설계와 실제 규약·입력·제출·CLI를 대조했습니다. 제품 코드·운영 규약/권한·위키/원장은 변경하지 않았으며 아래는 개선 제안입니다.
- **단계 간 기준 고정:** 격리된 실제 발행 규약 두 개로 read_source의 규약1/필수 definition.md → prepare_wiki의 규약2/해당 문서 미선택을 준비할 수 있고 input_ready=true임을 재현했습니다. 각 bundle의 변경 검사는 존재하지만 job 전체의 규약/필수 맥락 승계 계약은 없습니다. 현재 개인 CLI의 동일 규약/맥락 전달과 별개로, 요청 명세 revision에 규약·필수 맥락을 고정하고 변경 시 명시적인 새 준비를 요구하는 서버 계약이 필요합니다. 근거: [입력 준비](../../../core/modules/analysis_inputs/bundles.py), [접수 모델](../../../core/api/v1/analysis_jobs/schemas.py).
- **지침/스키마 정합:** 배포 의미 원문은 현재 계약을 v3로 지시하고 v4 앵커·v5 대응·v6 출처 보존의 사용 지침을 포함하지 않지만 출력 스키마는3–6을 허용합니다. v3에 requires를 넣으면 배포 JSON Schema는 통과하고 실제 OntologyStore는 거부함을 재현했습니다. 버전별 지침/예시·선택 기준과 버전별 허용 형식을 함께 발행해야 합니다. 근거: [의미 원문](../../../.agent/ontology_semantics.md), [스키마 조립](../../../core/runtime/extraction_schema.py), [규약 구성](../../../core/modules/extraction_rules/content.py).
- **누락·의미 보고:** 지침의 omissions는 그래프 제출에 넣으면 거부되며 결과 래퍼에도 별도 보고 필드가 없습니다. 원본 읽기의 문자열 omissions와 로컬 위키 응답 봉투는 존재하지만, 위키 단계 warnings는 서버 저장 인자로 전달되지 않습니다. 그래프를 바꾸지 않는 job 별도 진단 제출/조회와 원문 위치·제출 hash·Rule ID·검토 종류/범위·미해결 사유의 연결을 우선 제안합니다. AI 의미 의견을 사람 승인/기존 검토 원장으로 자동 전환하지 않습니다. 근거: [결과 입력](../../../core/mcp/tools/analysis_results.py), [CLI 인계](../../../core/client/ai/workflow.py).
- **요청 범위·출처 대응:** 현행 접수는 대상 경로/산출물만 받고 hints는 not_provided로 고정됩니다. source_extraction_submit은 whole_original만 허용하며 부분 줄 범위가 거부됨을 확인했습니다. 시안의 문서별 목적/사용 구간·해석 힌트·원본 페이지/셀→준비 본문→주장 연결을 위해 명시 요청 명세와 위치 대응 자료가 필요합니다. UTF-8 md/txt·단일 대상 CLI 및 원본/본문/입력 한도는 그대로 밝혀야 하며 파일 API의 산출물 보관을 OCR 지원으로 확대하지 않습니다. 근거: [추출물 계약](../../../core/modules/analysis_inputs/extractions.py), [분석 범위 시안](../../../app/docs/component-architecture.md#51-자료-등록cli-작업결과).
- **규칙별 판정·비교:** 릴리스는 구조화 Rule 명세 없이 지침/스키마/어휘/예시를 발행하고, 결과 보고는 여러 Rule에 동일 상태를 묶어 쓰며 semantic은 not_run입니다. D-044의 규칙별 pass/fail/not_run/not_applicable/error·검토 근거를 보존할 명세/보고가 필요합니다. D-050의 개인 비교 API는 존재하나 시안의 미저장 전체 추출 초안·미발견 유지/이번 판본 제외/재추출 결정을 실행·보존하는 계약과는 다릅니다. 조건/AND/OR 문자열 보존과 기계적 논리·수량 판정도 구분하며 표현 한계부터 기록하도록 제안합니다. 근거: [검사 보고](../../../core/modules/analysis_results/validation.py), [개인 비교 입력](../../../core/api/v1/personal/schemas.py), [재추출 시안](../../../app/docs/component-architecture.md#55-원문-변경이전새-추출미발견-대조).
- 실제 검증: `.venv/bin/python -B -m unittest core.tests.modules.test_extraction_rules core.tests.modules.test_analysis_inputs core.tests.modules.test_analysis_results core.tests.runtime.test_personal_ai_inputs -q`의 **11개 통과(0.690초)**. 별도 임시 실행에서 그래프 omissions 거부, 규약1→2/필수 맥락 누락의 단계 준비, 부분 범위 거부, v3 requires의 스키마/저장 검증 차이를 확인했습니다. 임시 자료는 정리했습니다. 실제 모델 의미 평가·원격 MCP·Electron 실행·운영 발행 규약 확인·전체 회귀는 하지 않았습니다. 이번 연결에서 노출된13개 조회 도구와 저장소의 분석 도구 구현을 구분했으며 운영 도구 허용 목록은 변경하지 않았습니다.

## 2026-10-25 — 개인 AI 실행 어댑터

- `client/ai`의 입력 조립·Codex 프로세스·사용권 갱신·결과 인계를 구현하고 `tools.analysis_cli --run-ai`에 연결했습니다. 기존 클라이언트 전송/JSON/hash/고정 입력·결과 저장 모듈을 재사용했습니다. 새 코드와 변경 부분에는 입문자용 한국어 역할/입력/결과/처리 이유 설명을 달았으며 핵심 의미 규칙·공개 그래프 형식·검증 지문은 변경하지 않았습니다.
- 현재 단일 대상·UTF-8 원본 문자 4 MiB 범위에서 위키 작성과 실제 위키 기반 그래프 추출을 새 세션으로 실행합니다. 전체 사본/관점/규약 대조, 원본 문자 그대로 제출, 두 스키마/결과 검사, 단계별 로컬 기록·선택 client_reported 실행 정보·실제 영수증 확인, 30초 heartbeat/중단/부분 성공 보존을 연결했습니다. 기존 인계 명령은 AI를 자동 실행하지 않습니다.
- **핵심 고유 9개 통과**: 가짜 CLI 경계/토큰 환경 격리·구조화 출력/시간 초과·취소 회수/잘못된 이벤트·출력 거부 3개, 입력 수신·조립/변조·규약·경로 거부 2개, 실 MCP의 실행 신고 연결·작성자/승인 위조 거부·기존 payload/hash 호환 1개, 임시 실제 서버·별도 CLI·가짜 AI의 전체 저장/그래프 실패·위키 보존·heartbeat 상실 취소 2개, 기존 고정 입력 인계의 실제 CLI 호환 1개입니다. 전체 회귀·옛 모델 평가를 실행하지 않았습니다.
- 초기 프로세스 검사는 테스트 shebang의 공백 경로를 실제 Python 경로로 수정했습니다. 통합 검사 첫 시도는 환경의 loopback 포트 제한으로 실행되지 않아 그 2개만 허용된 실행 환경에서 수행했습니다. 그래프 실패 경로에서 SDK의 예외 묶음이 알려진 오류 코드를 가리는 문제를 공통 전송 helper로 보완하고 해당 흐름만 통과했습니다(2.468초). 마지막 원본/실행 스키마 구분과 일반 관계의 mapping 생략 보완 뒤 영향받은 입력/runner/정상 통합 흐름만 재확인했습니다(정상 통합 최종 2.652초). 전체 모음을 반복하지 않았습니다.
- **실제 개인 Codex CLI 확인**: 설치 버전 `0.164.0-alpha.11.1`의 지원 옵션과 개인 로그인 상태를 확인했습니다. 처음에는 개발 중 기능의 안내가 error 항목으로 전달돼 어댑터가 거부했습니다. 안내만 이번 실행에서 억제하고 실제 오류/도구 활동은 계속 거부하도록 보완한 뒤, 기본 모델 선택·빈 임시 폴더·작은 합성 입력에서 `{status: ready}` 구조화 응답/완료 이벤트/출력 hash를 확인했습니다. 설정 파일을 변경하지 않았습니다. 실제 CLI 확인은 작은 연결 검사이며 전체 실문서 분석/의미 정확도 검증은 아닙니다.
- 위키 저장 통합은 임시 tenant·시험 토큰·합성 원문/가짜 AI를 사용했습니다. 실제 CLI에는 합성 입력만 전달했고 운영 위키/원장·서버 토큰·운영 정책/MCP 설정을 사용하지 않았습니다. 개인 CLI의 기존 로그인은 사용하되 인증 원문을 출력/문서화하지 않았습니다. 실제 문서의 의미 평가·다중 대상 분할·PDF/OCR/artifact·다른 제공자·Windows 네이티브·Electron/두 PC 실행은 미실행/후속입니다.

재현용 핵심 모음(실제로는 위와 같이 필요한 묶음으로 나눠 실행했으며 이 모음을 마지막에 반복 실행하지 않음):

```sh
.venv/bin/python -B -m unittest core.tests.runtime.test_personal_ai_runner core.tests.runtime.test_personal_ai_inputs core.tests.api.test_ai_execution_provenance core.tests.runtime.test_personal_ai_workflow core.tests.runtime.test_fixed_input_cli.FixedInputCliTests.test_published_rules_and_fixed_input_reach_actual_cli -q
```

## 2026-10-25 — 파이썬 입문자를 위한 저장 코드 설명 보강

- 결과 저장·파일 보관·형식 검사·MCP/API 입구·공통 JSON/경고·입력/작업 조회의 10개 Python 파일에 처리 순서, 주요 변수/ID/버전, 입력과 반환값을 설명했습니다. self·키워드 인자·딕셔너리 펼침·lambda·with·예외·콜백·nonlocal·집합 비교는 처음 읽을 때 필요한 위치에 한국어 설명을 덧붙였습니다. 공개 MCP 도구 설명은 그대로 두었습니다.
- 변경 전후 구문 트리에서 주석/설명문을 제외하고 비교해 10개 파일의 실행 코드가 동일함을 확인했습니다. Python 구문도 정상이며, 설명만 변경했으므로 기능 검사를 반복하지 않았습니다. 기능 상태와 다음 범위는 기존 PLAN을 유지합니다.

## 2026-10-25 — 분석 결과의 위키·그래프 저장 연결

- `analysis_results`의 저장/영수증·불변 원시 제출·자동 검사 보고·독립 저장 증거와 MCP 저장 도구 2개/결과 조회·일반 API 결과 조회를 연결했습니다. 기존 공통 JSON/hash/정리 경고·안전 파일/불변 입력 공개·작업 인가·오류 처리를 재사용했습니다. jsonschema는 이미 lock된 4.26.0을 직접 의존성에도 명시했으며 설치/업데이트는 하지 않았습니다.
- `WikiStore.save`·`OntologyStore.generate`의 기본 동작은 유지하고 같은 저장 잠금의 최종 guard를 연결했습니다. 고정 맥락/검토/관점/규약·현재 권한/원본/lease/작업 CAS와 실제 저장의 사이에 다른 위키/검토 쓰기가 끼지 않게 했습니다. 위키 영수증→실제 source/history→그래프 입력의 계보와 부분/전체 저장 집계, 실패 뒤 재쓰기 차단을 연결했습니다.
- **핵심 고유 8개 통과**: 저장 guard/경합·보존 2개(0.017초), 입력 변경/권한·규약 거부·자료 보존/위키 멱등·최종 영수증 실패/잘못된 인용·기존 검토 원장 보존·partial→complete 3개, 실제 MCP/일반 API 연결·원시 스키마/권한 거부 2개(첫 실행 0.522초), 변경된 tenant 도구 계약 1개입니다. 자료 보존 검사는 격리 임시 저장소만 사용했습니다.
- 결과 모듈 검사 첫 실행은 테스트의 영수증 오류 주입이 초기 접수까지 막아 1개 오류가 있었고, 최종 complete 영수증만 실패하도록 테스트 범위를 고친 뒤 그 1개를 통과했습니다(0.069초). 저장 후 상태 관측/실패 보존을 보완한 뒤 영향받은 위키 흐름·프로토콜 2개·도구 계약만 0.562초에 확인했고, 위키/그래프 이력 계보 보완 뒤 graph 흐름 1개만 재확인했습니다. 최종 graph 흐름에 자기 위키 저장 뒤 외부 A→B→A의 잘못된 선행 영수증 재사용 거부도 추가해 통과했습니다(0.115초). 전체 회귀/기존 의미 평가는 반복하지 않았습니다.
- 모델을 호출하거나 실제 사용자의 원문·이력·원장·운영 정책·토큰·MCP 설정을 읽거나 변경하지 않았습니다. 테스트의 검토 판단은 simulation이며 실제 사람 승인이 아닙니다. 이번 결과는 저장·자동 검사 경계의 확인으로, 실제 개인 AI 실행·의미 정확도·전체 artifact 전송·Electron·두 PC 실행·불명확한 저장의 운영 복구는 미실행/후속입니다.

위 고유 8개의 재현 명령(이번 작업에서는 필요한 묶음으로 나눠 실행했으며 이 모음을 반복 실행하지 않음):

```sh
.venv/bin/python -B -m unittest core.tests.modules.test_analysis_save_boundary core.tests.modules.test_analysis_results core.tests.api.test_analysis_results_protocol core.tests.mcp.test_tenant_mcp.TenantMCPTests.test_tool_contract_and_access_context_only_disclose_own_memberships -q
```

## 2026-10-25 — 공통 규약·고정 입력 연결

- 변경: 공통 의미 원문 `.agent/ontology_semantics.md`와 역할 참조, `extraction_rules`·실제 제출 스키마 조립/관리자 발행 도구, `analysis_inputs`의 단계별 불변 입력/문자 추출물, MCP 도구4개와 작업 조회 상태를 연결했습니다. runtime은 명시한 규약 root/policy만 주입하고 CLI의 `--prepare-input`은 규약·manifest·구성 사본을 hash 확인해 보존합니다. 기존 평가 도구의 직접 역할 로더에도 같은 의미 원문 조립을 보완했습니다.
- 핵심 검증만 수행: 규약3개(0.029초), 입력 저장3개(0.311초), MCP 연결2개(0.416초), 실제 CLI1개가 통과했습니다. 전체 회귀·기존 모델 평가·중복 광범위 검사는 하지 않았습니다. 초기 연결의 모듈 준비 순서/인가 주입을 보완한 뒤 해당 CLI 흐름만 다시 확인했고, 최종 manifest와 구성 hash의 대조를 보완한 뒤 같은 흐름1개만 재확인했습니다.
- 확인 범위: 기존 의미 연속 원문14,433 UTF-8바이트/hash 보존·현재 스키마3–6/기본3·명시적 qualifiers·불변 발행/재발행 거부·현재 허용/철회·변조/호환 오류·tenant-root 분리, read_source→불변 문자 추출물/replay→prepare_wiki 및 실제 위키의 extract_ontology 입력, 전체 원문/검토/정책·조건 맥락과 페이지 hash, A→B→A/history/profile/권한/규약 변경 차단·필수 선행/한도·실패 보존을 확인했습니다.
- 실제 CLI는 임시 정책/tenant·발행 규약의 Uvicorn 서버에서 작업 접수→read_source 고정 입력 준비→정확한 규약/입력/원본 수신→구성 hash 검증→인계 사본·진행 보고까지 확인했습니다. 운영 data·토큰·권한/설정은 접근/변경하지 않았고 AI를 호출하거나 위키/그래프를 저장하지 않았습니다.
- 현재 한도: 고정 입력8MiB, 문자 추출물 본문4MiB/수신8MiB·작업별 누적64MiB, 구성/원시 제출 보관16MiB, 묶음/추출물각100·선택 문서8개·문서별 기존1MiB입니다. 이는 전체64MiB 추출물·artifact 전송 설계의 구현 완료가 아닙니다.
- 완료 범위는 규약/고정 입력 연결 묶음입니다. Q2/R2 전체 결과 저장 래퍼·검사 보고/영수증·실제 개인 AI/Electron/두 PC 실행과 새 의미 정확도 평가는 남습니다. 입력 준비는 `can_analyze_input`, 실제 저장 미구현은 `execution_ready=false`와 후속 조건으로 구분합니다.

핵심 재현 명령(이번에는 각 파일을 나누어 실행했으며 이 모음을 반복 실행하지 않음):

```sh
.venv/bin/python -B -m unittest core.tests.modules.test_extraction_rules core.tests.modules.test_analysis_inputs core.tests.api.test_analysis_inputs_protocol core.tests.runtime.test_fixed_input_cli -q
```

## 2026-10-25 — 작업 접수·CLI 원본 인계

- 변경: `core/modules/analysis_jobs`의 store/records/commands/queries/contracts, 작업 API, tenant MCP 도구4개, API/MCP 오류와 정리 경고 변환, source/job의 request_id 충돌 검사와 본인 영수증 조회를 구현했습니다. `core/client/analysis.py`·`tools/analysis_cli.py`는 작업 PC의 인증 API/MCP 접수·고정 원본 수신·input_ready 보고를 제공합니다. 실제 사용법은 README, 계약은 analysis DECISIONS에 둡니다.
- 실제 검증: 사용자 요청에 따라 **고유13개만 실행**했습니다. 저장5개(0.124초), HTTP/MCP5개(0.683초), 개발 CLI/입력 보호2개, 변경된 기존 tenant 도구 계약1개가 통과했습니다. 실제 CLI의 첫 실행은 macOS `/var` 별칭이 symlink 보호에 걸려 실패했고 실제 private 경로로 고친 뒤 해당 흐름만 재실행해 통과했습니다(1개1.345초). 기존742개 전체 회귀를 반복하지 않았습니다.
- 실제 별도 프로세스: 임시 tenant·시험 토큰의 Uvicorn 서버에 HTTP 원본 등록/작업 생성 후 `tools.analysis_cli`를 실행했습니다. API/MCP 사용자·tenant/job 대조→claim/source_read→인증 다운로드의 원본 바이트/hash/UTF-8/CRLF→input_ready 보고→같은 API 상태/본인 영수증→heartbeat의 lease/job 분리→취소와 원본 보존을 확인했습니다. 토큰 비출력과 프로세스 종료도 확인했습니다. 개인 AI 모델은 호출하지 않았습니다.
- 보존/거부: 새 업무 흐름 안에서 권한 회수·본인 marker·다른 tenant/위조 인자·request 재전송/충돌·source/job/lease 기준·유효 run 보호/명시 reclaim·만료/취소·pending 영수증 근거·metadata 손상/한도와 원본/기존 자료 보존을 확인했습니다. 운영 자료·정책·토큰·기존 MCP/앱 설정은 접근/변경하지 않았습니다.
- 독립 읽기전용 검토: 중복 검사를 실행하지 않고 새 코드 경계를 검토했습니다. claim의 후보 state가 JSON 한도를 넘을 때 lease가 먼저 공개돼 허용 run 한도까지 불필요한 고아 lease가 쌓이는 경계1건을 재현했습니다. 완성된 state/lease를 먼저 preflight한 뒤 같은 바이트를 공개하도록 수정했고 기존 실패 흐름1개만 다시 통과했습니다(0.012초). 같은 CAS3회 실패에도 lease0·원본/state 보존을 확인했습니다. 최신 코드를 재검토한 결과 남은 확정 결함은 없습니다. 독립 재현을 별도 통과 수로 합산하지 않습니다.

```sh
.venv/bin/python -B -m unittest core.tests.modules.test_analysis_jobs core.tests.api.test_analysis_jobs_api core.tests.runtime.test_analysis_cli core.tests.mcp.test_tenant_mcp.TenantMCPTests.test_tool_contract_and_access_context_only_disclose_own_memberships -q
```

위 명령은 나누어 실행한13개의 재현 모음이며 마지막에 같은 모음을 반복 실행하지 않았습니다. 완료는 **작업 접수/원본 인계 묶음**입니다. Q1/Q2 규약·고정 입력·추출물/위키·그래프 저장, 실제 로그인된 AI CLI·모델·Electron/PTY·두 PC/WSL2/HTTPS·영구 backend identity는 미구현/미검증입니다. 다음은 Q1 공통 규약과 Q2 고정 입력 연결이며 자동 착수하지 않습니다.


## 2026-10-25 — 규약 발행·허용·전환·되돌림

- `extraction_rules.administration`과 `tools.transition_ruleset`에 inspect/plan/apply/status/rollback을 추가했습니다. 기존 reader의 정책 검증을 재사용하고 전체 정책 CAS·관리 잠금·새 불변 이력/동기화·원자 교체를 연결했습니다. 허용과 기본값 선택, 전환과 원래 전체 바이트 복원, 최초 생성의 빈 정책 되돌림을 명시 단계로 분리했습니다. 기록 실패·충돌·잠금 대기·정리 문제·교체 후 동기화 경고를 구분합니다. 기존 릴리스·사용자 자료·히스토리는 덮어쓰거나 삭제하지 않았습니다.
- **신규 관리자 검사7개 통과**: 동시 변경1회만 적용, 기존 릴리스/다른 tenant/원시 정책 보존과 정확한 되돌림, 이력 쓰기 실패 보존, 변경된 릴리스 참조·중간 정책 변경·철회 규약 거부, v1 읽기/신규 정책 CLI 왕복, 잠금·symlink 실패/동일 계획 재시도, 교체 후 동기화 경고를 확인했습니다. 기존 규약 검사6개도 초기 회귀에서 통과했습니다.
- **실제 별도 서버/CLI2개 통과(10.427초)**: 새 발행 CLI→loopback Uvicorn API/MCP 서버→인증 initialize→구 v1 작업 고정→v2 허용/기본값 전환→기존 입력 유지/명시 rebase→새 MCP 초기화→원본/작업/고정 입력→v2 별도 진단 초안→HTTP 영수증/hash 대조→정책 되돌림→구버전 바이트/기존 결과 조회 보존을 확인했습니다. 기존 개인 CLI의 별도 의미 검사 저장 연결도 통과했습니다. 모델 응답은 합성이며 실제 의미 정확도 평가가 아닙니다.
- 기존 규칙 진단9개·MCP/API 진단1개·개인 별도 검사4개도 통과했습니다. 최초 실제 서버 검사는 sandbox의 loopback bind 제한으로 중단됐고 허용된 escalation에서 실행했습니다. 테스트의 macOS `/var` 별칭을 실제 경로로 바꾸고 그래프 hash 참조를 실제 계약 `validation_report.basis.submission_sha256`로 바로잡은 뒤 해당 실패 흐름만 재실행했습니다. 전체 Python 회귀는 공통 통합 담당이 소유합니다.
- 추출안 담당의 `ensure_proposal_job_draft`를 `ResultStore._save`의 현재 job/run 확인 직후에 연결했습니다. 예약된 추출안 실행은 초안 제출만 허용하고 canonical 변경은 명시 proposal apply로 남깁니다. 기존 분석 결과/진단 동작은 위 검사로 확인했으며 추출안 고유 정상·거부·연결 검증은 담당의 최종 인계를 별도로 반영합니다.
- 격리 발행 산출물: `/private/tmp/mcp_2-ruleset-evidence-xs495a2y/releases/llm-wiki/diagnostics-v2-20261025`, revision `a72813d86e6a9bfdbf53d36102c8b56056f944262495f3bd805de268ea69fdb4`. 같은 폴더의 `allow-plan.json`은 아직 적용하지 않은 격리 정책 계획이며, `protocol-receipt.json`은 실제 시험의 반환 영수증/hash입니다. 시험 tenant는 종료 시 정리했고 이 영수증을 운영 서버의 현재 조회 결과로 사용하지 않습니다. 임시 증거는 운영 보관 위치를 대신하지 않습니다.
- 운영 미적용: 실제 `access_context`에서 `jong-yu`/`personal`의 권한은 `read`로 확인했습니다. 운영 관리 대상/권한은 미확정이라는 통합 담당의 인계를 받았고 운영 정책·MCP 설정·인증정보·Wiki를 변경하지 않았습니다. 필요한 입력과 보존/되돌림 실행법은 [RULESET_ROLLOUT](RULESET_ROLLOUT.md)에 둡니다. 실제 모델 원문 분리 평가·Windows·두 PC·운영 HTTPS/자동시작은 이 계약 시험의 완료 범위가 아닙니다.

### 같은 차수 실행기 담당의 중간 인계

- fastapi_5의 공개 인계: 기존 추출안 API8개와 새 execution→후보→진단→명시 적용/정확한 영수증 ASGI 통합1개 통과. 실제 저장 모듈을 사용했으며 모델 호출은 하지 않았습니다. 공통 ResultStore의 초안 강제 연결을 소비하는 검사입니다. 나머지 실패/취소 경로와 실제 loopback의 최종 결과는 담당이 확정한 뒤 통합 기록에 추가합니다.
- fastapi_6의 공개 인계: `tools.proposal_cli --help`와 실제 loopback의 후보·별도 의미 보고·읽기 전용 재개 첫 흐름 통과, 취소 검증은 진행 중입니다. 이 중간 인계를 전체 재추출 실행기 검증 완료로 표시하지 않습니다.
- fastapi_8의 공개 인계: runtime/배포 준비 관련 집중 검사22개 통과 보고를 받았습니다. 실제 POSIX 프로세스 경계와 보존/hash/경로 거부를 확인했으며 Windows 분기는 모의, Caddy/systemd/Windows 실환경 실행은 미실행입니다. 상세·최종 공통 Python 통합은 platform 기록이 소유합니다.

## 2026-10-26 — 별도 검사 줄 기준과 정규화 관점 명확화

- 실제 RFC9110 평가의10개 규칙은 새 상태/verdict 조합을 지켰지만 평가 하네스의 글로벌 출처 줄 번호를 발췌문 인용 위치로 사용했습니다. 원시 reviewed_range1개와 finding10개의 위치 검증 실패를 그대로 보존했습니다. 실제 제품 checker에는 이 하네스의 글로벌 provenance 입력이 없다는 차이를 기록합니다.
- core/client/semantic_check.py의 공통 지침에 source 문자열 첫 줄=1, 출처 전체 줄/페이지와 구분, viewpoints는 원문 주장에 근거한 정규화 분류라는 기준을 명확히 했습니다. 태그의 실제 의미 적합성 검사는 유지합니다. 원시 모델 판정·스키마·서버 인용 검증을 고치거나 완화하지 않았습니다.
- semantic_check·rule_diagnostics·analysis_diagnostics 관련24검사(1.544초) 통과. 기존 거부/부분 보고/취소/구규약 보존 검사를 실행했으며 이 회귀를 실제 의미 통과로 표시하지 않습니다. 원시 근거는 [개발 평가 보고](../../../evals/rfc9110_safe_20261026/REPORT.md)에 있습니다.


## 2026-10-26 — Codex·Claude 실행 기록과 기존 규약 호환

- D-065에 따라 일반 실행 및 독립 의미 검사 실행 제공자에 codex/claude를 허용했습니다. 기존에 알려진 진단 스키마의 CheckExecution.provider만 확장한 검증 사본을 사용하며, 기존 발행 바이트/hash/revision·정책·고정 입력은 바꾸지 않습니다. 신규 발행은 두 제공자를 명시합니다. 변조 스키마에는 호환 예외를 적용하지 않습니다.
- 서버 집중 검사 **38개 통과**: `.venv/bin/python -B -m unittest core.tests.modules.test_analysis_results core.tests.modules.test_analysis_diagnostics core.tests.modules.test_rule_diagnostics core.tests.modules.test_extraction_rules core.tests.api.test_analysis_results_protocol core.tests.api.test_rule_diagnostics_protocol -q`. 두 제공자의 자기진단·실행 영수증, Claude 독립 의미 보고, 잘못된 제공자 거부, 구 스키마 지문·발행/정책 바이트·revision·원문 이력을 확인했습니다.
- 독립 읽기 검토에서 분석·질문·추출안·별도 검사까지 제공자 전달, 영수증 보존, 기존 규약의 클라이언트/서버 검증 연결을 확인했습니다. 실제 CLI fixture 검증은 platform HISTORY에 기록합니다. 운영 자료·규약·정책 변경이나 실제 모델 의미 평가는 수행하지 않았습니다.

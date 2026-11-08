# 분석 작업·추출 규약 계획

## 현재 상태

### 2026-11-06 — 작업 이벤트 전용 이력 조회

[D-102](DECISIONS.md#d-102--통합-이력의-작업-이벤트-조회와-상세-결과-검증-분리-2026-11-06)에 따라 본인 작업 발견과 전체 이벤트 조회를 상세 결과·입력·변환/실행 준비 조립에서 분리했습니다. 소유·현재 상태·이벤트·lease·원본·등록 descriptor·목록/집계 한도와 커서를 유지하며 공개 작업 목록·상세는 기존 검증 경로입니다. 격리 검사와 전체 core587개, 영향 전용12개·독립 검토를 통과해 같은 운영 주소에 반영했습니다. [검증 기록](HISTORY.md#2026-11-06--작업-이벤트-전용-이력-조회)과 [실측](../platform/HISTORY.md#2026-11-06--통합-이력과-변경-영향의-반복-검증-감축)을 따릅니다.

### 2026-11-06 — 규약 기대값과 결과 입력 읽기의 중복 감축

실제 작업 목록의 상세 투영에서 반복하던 진단 스키마 생성과 같은 결과 요약 안의 고정 입력 완전 읽기를 재사용합니다. 현재 정책·릴리스/구성 hash·검증기·입력 revision/예산·owner·receipt/saved/basis 검사는 유지합니다. 한 요약의 입력 재사용은 8개/8MiB로 제한하며 요청 간 공유하지 않습니다. [검증 기록](HISTORY.md#2026-11-06--규약-기대-스키마와-결과-입력의-중복-읽기-감축)과 [운영 상태](../platform/PLAN.md)를 따릅니다.

### 2026-11-06 — 변경 기록에 따른 작업 목록 관측

[D-101](../documents/DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06)의 저장 전 변경 기록과 얇은 관측을 연결했습니다. 명시 추적 모드는 소유 목록/파일 지문을 재사용하고 변경된 작업·lease·원본만 확인합니다. 전체 SQL 요약·소유/용량 한도·현재 시각의 lease 만료·커서와 선택 페이지의 현재 상세 검사는 유지합니다. [격리 검증](HISTORY.md#2026-11-06--변경-기록에-따른-개인-작업-증분-관측)과 [운영 상태](../platform/PLAN.md)를 따릅니다.

### 변환 보고의 Pandoc 제거 (2026-11-03, [D-095](../platform/DECISIONS.md#d-095--pandoc-사용-중단과-문서-변환의-대체-2026-11-03))

DOCX 보고의 첫 단위가 `whole`이 아니라 문단(`paragraphs`)이고 XLSX 보고에는 읽기용 표 단위(`pandoc_markdown`)가 없습니다. 보고의 구조·불변 보존·D-074 단일 MD 저장·원본 판본/hash 및 최초 MD revision 연결은 같은 실제 worker/격리 API 흐름으로 다시 대조했습니다. 분석 저장/규약/프롬프트는 바꾸지 않았습니다. 아래 Pandoc 절은 당시 상태입니다.

### 추출 대화의 저장 후 대조 연결 (2026-10-29)

Codex·Claude 어댑터에 명시 세션 ID 이어 실행을 연결했습니다. 새 추출의 저장 영수증을 확인한 뒤 같은 세션으로 기존 지식 대조를 수행하며, 검색·판단·이력의 계약은 [knowledge PLAN](../knowledge/PLAN.md)을 따릅니다. 독립 의미 검사는 별도 세션을 유지합니다. 대조 실패와 로컬 요약 기록 실패가 이미 저장된 추출을 재실행하게 하지 않습니다.

실제 Codex로 원본 등록→추출 저장→동일 세션의 후속 4턴→대조 결과 보관을 확인했습니다. 세션 ID 불일치 거부·도구 차단·사용량 누적 중복 방지·Claude 작업 위치 보존과 기존 추출 흐름도 격리 검사했습니다. 2026-10-30 Claude 2.1.312의 실제 첫 요청은 제공자 사용량 제한(`ai_rate_limited`)으로 거절됐습니다. 제한 해제 뒤 Claude의 동일 세션 재개·전체 추출/자동 대조·새 실행기 수동 재대조를 확인해야 합니다. [실제 검사와 제한](HISTORY.md#2026-10-30--claude-실제-검증의-제공자-사용량-제한)

2026-10-30 운영 QA에서는 새 서버 8767과 기본 규약 `common/2026-10-30.1`을 실제 API/MCP로 확인한 뒤 신규 QA 원본을 등록했습니다. 기본 Codex의 추출·같은 세션 재검색·최종 대조 3호출과 서버 조회가 성공했고, 문서·그래프와 QA 기록을 보존했습니다. 이후 기존 공개 주소를 유지해 운영 8766 서버를 교체하고 사용자·규약·QA 원문·그래프·대조 판본 보존을 다시 확인했습니다. 원래 운영 자료는 변경하지 않았습니다. Claude 제한 해제 뒤 실제 성공 검증이 남습니다. [운영 QA 근거](../../../evals/2026-10-30-operational-smoke/REPORT.md), [교체 후 확인](../../../evals/2026-10-30-operational-smoke/ROLLOUT.json)

### D-076 허용된 이력 제외와 실제 미독의 보고 경계 (2026-10-29)

`current-review-v1`에만 과거 이벤트 제외를 조립 감사와 `diagnostics.warnings`로 알리는 지침을 추가했습니다. 실제 대상 원문/선택 맥락/현재 판단 근거의 미독은 그대로 `unread_ranges`에 신고하며 클라이언트·서버가 차단합니다. 모델 반환값의 사후 삭제/재분류는 없습니다. 보고 정책 버전·템플릿 hash를 조립과 실행 설정에 넣어 변경 전 완료 결과를 재사용하지 않으며 full의 기존 prompt/schema/assembly/config는 동일합니다.

경고의 실제 MCP 저장·조회, 진짜 미독의 초안 보존/저장 차단, 불변 입력/현재 판단 보존, 설정 변경 후 재사용 거부를 검증했습니다. 새 합성 원문의 축약 실제 실행2개 모두 제외 이력을 경고로 남겨 기존 오분류가 재현되지 않았습니다. 전체 보기1개를 더한 최종3개는 production 검사/격리 그래프 저장을 통과했고 원문 분리 검토를 마쳤습니다. 전체 job/lease/save는 합성 어댑터 HTTP/MCP 통합 시험이며 실제 모델의 운영 전송/배포 검증은 아닙니다. [보고서](../../../evals/2026-10-29-must-integration/REPORT.md)와 [HISTORY](HISTORY.md)를 따릅니다.

### 저장 전 초안 검사와 최대2회 수정 (2026-10-29)

[ontology D-081](../ontology/DECISIONS.md#d-081--저장-없는-초안-검사와-제한된-끝점-역할-규칙-2026-10-29)의 순수 검사를 개인 CLI에 연결했습니다. 고정 전체 source/발행 스키마와 원시 출력을 보존하며 수정 가능한 실패만 전체 재추출합니다. 각 호출 전후 기존 input_read로 원문·규약·프로필·맥락·검토 기준을 다시 확인하고 미독/취소/adapter 오류/저장 응답 유실은 수정 호출로 재시도하지 않습니다. 최종 추출 hash만 저장하며 검사 정책·기본 진단/자원 한도를 실행 설정에 포함합니다. Codex 완료 턴 보고와 Claude 호출 총계를 구분해 사용량을 합산합니다. 실제 검증은 [HISTORY](HISTORY.md), 원문 의미 평가는 [ontology 보고서](../../../evals/2026-10-29-adopt-imp01-02/REPORT.md)를 따릅니다.

### 1단계 Pandoc 변환 보고 연결 (2026-10-29, D-095로 대체됨)

DOCX의 `docx_text/whole`과 XLSX의 `xlsx_values/whole` 구조/표·정확한 cells 위치의 기록을 기존 불변 보고로 받아 D-074 단일 MD에 저장합니다. XLSX 병합/명시 표·집계/숨김 구조와 값·수식/원시 캐시·위치·미독·경고, 원본 판본/hash와 최초 MD revision 연결을 실제 worker/Pandoc·격리 API로 대조했습니다. 분석 저장/규약/프롬프트는 변경하지 않았습니다. 실행 결과와 범위는 [HISTORY](HISTORY.md), 변환 계약은 [sources D-080](../sources/DECISIONS.md#d-080--개인-pc의-pandoc-기본-docx-변환과-기존-보고-호환-2026-10-29)를 따릅니다.

여러 시트의 정확한 원명/순서/ID·전역/지역 이름 범위, 원본 서식/크기/색상 참조도 같은 불변 보고·MD에 보존합니다. 8시트 실제 worker/Pandoc 및 MD 판본 연결을 검증했으며 수식·조건부 서식의 재계산이나 의미 추출 규칙 변경은 없습니다.

### D-076 선택 재검토·간결 입력·검증된 재개 (2026-10-29)

개인 CLI의 명시 `--input-view current-review-v1`, 선택 작업 묶음 `--batch-jobs`, 설정 지문과 `reuse_basis`를 통한 완료 결과 재사용 검증을 구현했습니다. 전체 원문/선택 맥락·조건·규약과 전체 그래프 저장을 유지하며 불변 bundle 바이트는 바꾸지 않습니다. 전문가 판단/Clean Up은 기존 코드 경로를 사용하고 규약 승인 뒤 자동 재추출은 없습니다. 문서 단위 격리 전송·저장·재개 검증을 완료했습니다. 새 합성 자료 1쌍의 실제 같은 모델 비교에서 입력 토큰 24.2%·입출력 합계 21.0% 감소와 양쪽 의미 항목 14/14 보존을 확인했습니다. 당시 축약 결과는 의도적으로 제외한 과거 이력을 미독으로 보고해 실제 결과 저장에서 거부됐습니다. 위 후속 범위에서 보고 경계를 보완하고 새 입력으로 검증했으며, 당시 실패 결과는 그대로 보존합니다.

허용된 이력 제외/실제 필수 미독의 구분과 새 자료·새 세션 검증은 위 후속 범위에서 완료했습니다. 실제 미독의 저장 거부를 유지하며, 반복 생성 일관성과 다양한 실제 문서 정확성·운영 배포는 남아 있습니다.

완료 조건은 기본 전체 입력 호환, 명시 보기의 전체 원문/현재 판단 보존, 선택 범위 밖 쓰기 없음, 현재 기준/설정 변경 시 재사용 거부, 취소·충돌·응답 유실·부분 실패 보존입니다. 근거와 측정 범위는 [HISTORY](HISTORY.md), 계약은 [D-076](DECISIONS.md#d-076--명시-입력-보기와-검증된-재개로-분석-전송량-제한-2026-10-29), 실행은 [README](../../../README.md#선택-재검토와-전송량-절감)를 따릅니다.

### D-074 담당 구현·격리 계약 검증 · UI/MCP 공개 계약 (2026-10-28)

- 기본 등록은 `POST /api/v1/tenants/{tenant}/analysis-jobs/registrations`를 사용합니다. 요청은 `{request_id, source_ref:{source_id,source_version,source_sha256,registration_revision}, document, title, conversion_ref?:{conversion_id,conversion_revision}}`입니다. 원본 등록을 먼저 완료하며 MD/TXT에는 conversion_ref가 필요 없습니다. 바이너리는 기존 `/analysis-conversions` 결과의 참조를 사용합니다. 별도 plan·선택본문 TXT source 생성은 없습니다.
- `Job.conversion`에 방식·원본 위치·complete/unread_ranges/warnings·author=AI·실제 actor·`first_markdown:{document,revision,body_revision,document_id}`를 반환합니다. 저장 전 first_markdown은 null입니다. 개인 CLI는 기존 job ID 실행을 그대로 사용하며 보존형 MD 준비 단계는 고정 문자 전체를 전달하고 실제 AI 호출은 그 MD의 그래프 추출에서 수행합니다.
- 응답은 기존 `CreatedJob` 봉투와 같습니다. 이후 기존 job 조회/claim/input/result/cancel 및 개인 CLI 실행 계약을 재사용합니다. `Job.registration`은 `{mode:"preserve",title,conversion_ref}` 또는 과거 작업의 `null`입니다. 기본 모드는 읽힌 전체 문자를 그대로 Markdown 본문으로 보존하며 요약/AI 재작성은 기존 명시적 고급 계획 흐름에 둡니다. 변환의 미독·경고는 숨기지 않습니다.
- MCP 담당 인계: `analysis_registration_create(tenant, request_id, source_ref, document, title, conversion_ref=None)`를 `JobStore.create_registration(..., authorize=<source_write 현재 actor callback>)`에 연결합니다. HTTP 라우터는 분석 담당이 소유합니다. 기존 실행 도구의 인자는 유지합니다.
- 신규 작업은 공통 `analysis_job_root`/`analysis_request_root`를 소비합니다. 저장 담당의 `parse_document` 및 `WikiStore.save(actor,origin,reason)`를 사용합니다. 담당 계약 검증 12개가 통과했으며 실제 CLI 모델/운영 검증 완료를 뜻하지 않습니다.

신규 job은 `_personal/<userId>/analysis/<jobId>/job.json`과 conversion/lease/input/result 확인 기록을 사용합니다. 구 `_jobs`의 소유 인덱스·state/lease/input/result와 구 actor/bundle은 원래 바이트·위치로 호환합니다. 중복 위치는 오류이며 자동 이관·삭제하지 않습니다. 새 접근 비교는 본인의 access_revision이며 기존 불변 기록에 필드를 주입하지 않습니다.

기본 입력의 반복 본문은 불변 원본·변환 참조 또는 현재/전체 이력의 정확한 MD 판본 참조로 읽습니다. 응답 구성의 논리적 바이트/hash 계약은 유지하고 저장 요청 본문은 고정 입력 참조로 복원합니다. 누락 판본·지문 불일치에서는 중단합니다. 저장 증거와 job 연결이 모두 있는 최종 영수증 유실만 읽기에서 완료로 확인하며, 불명확한 중간 증거는 pending_reconcile로 보존합니다.

본문 근거에는 공통 parse_document의 document_id/body_revision/body_start_line을 전달합니다. source_revision은 전체 파일 SHA이고 인용·앵커는 전체 파일 1-based 줄 좌표입니다. 신규 보존형 등록은 요약 결과를 거부하고 WikiStore.save의 actor/ai origin을 기록합니다. 기존 고급 계획·본문 재작성·추출안·Codex/Claude 제공자 계약은 유지합니다.

## 남은 적용·검증

- 실제 Codex CLI의 앞선 합성 비교 실패를 보존하고, 이력 제외/미독 보고 경계를 보완한 새 합성 원문3개 출력의 구조·진단·격리 저장 및 원문 분리 평가를 완료했습니다. Claude·독립 반복 생성·공개 실문서·GUI 등록/Windows 실행·운영 서버 배포는 미검증입니다.
- UI/MCP 담당은 위 신규 DTO와 기존 job 실행 경로를 소비합니다. 실제 API/MCP 모듈과 개인 실행기 연결은 격리 ASGI 전송으로 확인했으며 합성 모델 응답을 실제 모델 결과로 간주하지 않습니다.
- 미확인 저장의 자동 복구·기존 작업 자동 정리·고정 보관기간·원본 재작성은 추가하지 않습니다.

## 완료 조건과 검증 근거

담당 범위의 원본 중복 미생성, 단일 MD/Front Matter·실제 actor/AI 출처, MD 판본과 그래프 기준 일치, 변환 경고/위치 보존, CAS·멱등·동시 접수·부분 성공·응답 유실·재개·취소·소유권·실제 추가 가입 뒤 본인 작업 유지, 과거 작업/고정 입력 바이트 보존을 격리 자료에서 검증했습니다.

- [실제 검증·실패·미실행 기록](HISTORY.md)
- [D-074 결정](DECISIONS.md#d-074--기본-등록의-단일-markdown과-최소-분석-기록-2026-10-28)
- [등록·저장 계약 시험](../../../core/tests/poc_analysis/test_registration.py)
- [API/MCP·개인 실행기 연결 시험](../../../core/tests/poc_analysis/test_client_integration.py)

# 화면과 API 연결 범위

현재 등록된 일반 API를 기준으로 연결합니다. 서버 계약은 [D-050](../../docs/domains/platform/DECISIONS.md#d-050--잔여-http-api와-개인-기록의-최소-계약-2026-10-25), 실제 앱 검증 결과와 남은 한계는 [UI HISTORY](../../docs/domains/ui/HISTORY.md)가 관리합니다. 아래 경로는 `/api/v1/tenants/{tenant}` 기준이며 접근 조회만 `/api/v1/access-context`입니다.

| 화면 | 실제 API 연결 |
| --- | --- |
| 서버 연결·작업 공간·관점 | `GET /access-context` |
| 문서 목록·본문·편집 | `GET /documents`, `GET/PUT /documents/content` |
| 본문 버전·변경·복원 | `GET /documents/versions`, `GET /documents/versions/{history_id}`, `POST /documents/restorations` |
| 연결된 지식·문서 연결·변경 영향 | `GET /documents/knowledge`, `GET /documents/connections`, `POST /documents/impact/query` |
| 지식 탐색·개념·문맥 | `GET /documents/search`, `GET /documents/ontology`, `POST /concepts/find`, `POST /concepts/query`, `POST /knowledge/context/query` |
| 원문 검토·전문가 판단·되돌림 | `POST /documents/reviews`, `POST /documents/review-undos`, `POST /documents/policies`, `POST /documents/policy-undos`, `GET /documents/events`, `GET /documents/events/{event_id}` |
| 검토함·변경 이력·질문 근거 준비 | `POST /review-queue/query`, `/history/query`, `/question-context/prepare` |
| 원본 등록·새 판본·미리보기·내려받기 | `GET/POST /sources`, `GET /sources/{source_id}`, `POST /sources/{source_id}/versions`, `GET /sources/{source_id}/versions/{source_version}/file`, `GET /requests/{request_id}` |
| AI 분석·작업 목록·저장 결과/진단·취소 | `/analysis-jobs`·개별 작업·결과·취소 API와 기존 개인 CLI/MCP 실행기. 실행기 내부 사용권 갱신은 화면의 임의 동작으로 공개하지 않음 |
| 분석 범위·문서별 산출물·변환 보고·인계 | `POST /analysis-conversions`, `GET /analysis-conversions/{conversion_id}`, `POST /analysis-plans`, 개별 계획 GET·`validate`·`handoffs`·인계 요청 영수증 GET |
| 추출 본문·첨부 자료 | `GET /extractions/{extraction_id}`, `GET /extractions/{extraction_id}/content`, `GET /extractions/{extraction_id}/artifacts/{artifact_id}`, `POST /analysis-jobs/{job_id}/artifacts`, 해당 요청 영수증 GET |
| 개인 대화·질문·외부 답변 | `GET/POST /conversations`, `GET /conversations/{record_id}`, `POST /conversations/{record_id}/turns` |
| 결과물·명시 주장 비교·완료/보류 | `GET/POST /saved-results`, `/comparisons`, 개별 기록 GET, `POST /comparisons/{record_id}/completions`, `GET /personal-requests/{kind}/{request_id}` |
| 개인 질문 실행·진행·취소·저장 답변 | `POST/GET /question-runs`, 개별 실행 GET·`cancel`·접수 영수증. 개인 `tools.question_cli`가 claim/input/heartbeat/progress/answers/답변 영수증 API 사용. 화면은 서버 저장 답변과 생성 중 문자를 분리 |
| 저장 전 전체 추출안·미발견·명시 적용 | `POST /analysis-proposals`, 개별 GET·`submissions`·`validation`·`apply`·`requests/{request_id}`·`missing-decisions`·`completions`. 개인 비교 기록과 별도 |
| 추출안 개인 AI 재실행·별도 검사 | `POST /analysis-proposals/{proposal_id}/executions`, 해당 실행 GET, 분석 작업 취소 API. 개인 `tools.proposal_cli`가 고정 작업을 실행하며 정확한 candidate/job/run/result/submission refs의 진단만 결합 |
| 개인 실행 환경 설정·진단 | 로컬 `runtime:execute` read/choose/save/diagnose. 네이티브 경로 선택과 `tools.runtime_doctor`, `tools.source_conversion_cli --diagnose`; 서버 변경 없음 |
| 종료 후 보호 복구 | 로컬 `recovery:execute` list/put/remove. 현재 서버·사용자·tenant·profile·정책 확인 후 OS 암호화 저장. 서버 영수증 재조회와 분리 |
| 편집 결과 초안·Wiki 반영 | `GET/POST /result-drafts`, 개별 GET·편집·`applications`·생성/편집 요청 영수증·반영 영수증. 불변 결과의 원래 문장과 고정 근거를 보존 |
| 조건·개념 대응 | `/correspondences/find`·`drafts/prepare`·제안·개별 query·`changes/prepare`·검토/정책/되돌림의 9개 동작 |

## 실제 앱 연결과 실행 경계

- `/conversations`에서 질문과 근거를 보관한 뒤 개인 AI 실행을 명시적으로 시작합니다. `/work/:tenant/question-runs/:questionRunId?` 재방문은 조회만 수행합니다. 모델이 내보낸 생성 문자는 미저장 미리보기이며 토큰 단위 스트리밍 보장은 없습니다. 저장 답변을 재조회해도 작성 중인 다음 질문과 편집 당시 CAS 기준을 보존합니다.
- `/analysis-proposals`는 문서에서 전달한 대상의 현재 원문·검토 기준을 읽어 저장 전 전체 추출안을 비교합니다. 명시 AI 재추출·취소·후보 비교·별도 의미 검사를 연결합니다. 규칙별 보고는 정확한 후보/실행 참조를 확인하고 오래된 보고와 누락을 표시합니다. 실행 성공은 명시 적용이나 새 세대 사람 검토를 대신하지 않습니다.
- `/saved-results`의 불변 결과에서 `/result-drafts?savedResultId=…`로 이동해 명시적으로 편집 초안을 만듭니다. 대상 본문과 전체 고정 근거 부록을 비교한 뒤 별도 반영하고, 실제 영수증의 문서 경로로 복귀합니다.
- 원본 형식은 MD/TXT/PDF/XLSX/DOCX/PNG/JPG/JPEG/GIF/WebP/BMP/TIF/TIFF입니다. 바이너리 원본 자체를 본문 문자로 취급하지 않습니다. 문서의 문자 변환 탭과 분석 계획은 개인 `tools.source_conversion_cli`의 실제 보고·위치·미독·영수증을 사용합니다. 완료·저장이 확인된 보고에서 질문으로 이동하면 고정 `conversion_ref`를 전달하며, 바이너리 원본만으로 질문을 준비할 수 있습니다.
- 계획 인계는 `execution_started: false`를 유지합니다. 인계된 기존 작업 ID를 앱에서 다시 확인한 뒤 명시 실행·재개하며, 조회 자체는 새 작업이나 CLI를 만들지 않습니다.
- 새 업무별 main 서비스는 같은 연결 인스턴스와 현재 tenant/profile/정책 기준을 재사용합니다. preload는 지정한 동작과 검증된 응답만 공개하며 원본 파일·경로·토큰은 main에서 처리합니다.

## 로컬 실행 환경과 검증 한계

OS 보호 저장을 선택한 연결은 앱 시작 시 현재 서버 권한을 다시 확인한 뒤 복원합니다. 안전한 보호 저장이 없으면 세션 전용으로 동작합니다. 서버 자격증명 저장 API를 추가하지 않았습니다. 초안·미확인 요청·변환 복구 자료도 같은 OS 보호 정책을 사용하며 현재 인증 범위를 확인하기 전에는 노출하지 않습니다. 종료 후 복원은 GET/영수증 조회이고 자동 AI 실행·POST 재전송·CAS 변경을 하지 않습니다.

Electron 패키징 명령과 개인 Python 경로 설정은 [앱 실행 안내](../README.md)에 있습니다. Python·Codex·OCR 도구는 앱 바이너리에 포함하지 않습니다. 실제 macOS 패키지 시작, 격리 API/CLI/Electron 검증과 합성 모델·모의 bridge 시험은 [UI HISTORY](../../docs/domains/ui/HISTORY.md)에 분리해 기록합니다. 실제 모델의 의미 정확도·OCR 정확도·실제 Windows/Linux·두 PC 운영 검증을 완료로 표시하지 않습니다.

최종 공개 원문 실모델 동선은 후보 적용 영수증·검토 보류 기록까지 확인했으며, 별도 의미 보고10규칙 error와 질문 제출 invalid_argument가 남았습니다. 미저장 질문 생성문·요청ID 보존을 확인했고 답변 저장·후속 실제 모델 결과 반영은 성공으로 처리하지 않았습니다. [실행 구간 증거](../release/verification/live-final-summary.json)와 [패키지/현재 코드 일치 기록](../release/verification/code-state.json)을 따릅니다. 변환 조회 중 첫 클릭 경쟁의 수정·재검증은 ui_9 인계 상태입니다.

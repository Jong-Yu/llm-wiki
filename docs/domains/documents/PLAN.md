# Wiki 문서·저장 계획

## 현재 상태

- Wiki 저장·읽기·검색·전체 파일 버저닝·기준 판본 검사와 HTTP 편집·이력·복원을 구현했습니다. 쓰기는 `WikiStore.save()`를 사용하며 저장 전 전체 파일 보존에 실패하면 원본을 갱신하지 않습니다.
- 문서당 크기 한도는 없습니다. HTTP·MCP 요청 본문 8 MiB 등 전송·응답·AI 입력의 별도 한도는 유지하고 큰 문서를 임의로 자르지 않습니다. [D-141](DECISIONS.md#d-141--문서당-크기-한도-없애기-2026-11-20).
- Wiki와 원본을 각각 휴지통으로 옮기고 복원합니다. 전체 파일·이력·원본 불변 판본은 보존하며 삭제 항목은 일반 목록·검색·현재 질문 근거에서 제외합니다. 삭제 경로 재생성과 복원 덮어쓰기는 충돌로 차단합니다. 0.4.0 Windows 포터블과 운영 서버에 반영했으며 이후 배포 상태는 [플랫폼 계획](../platform/PLAN.md)을 따릅니다. [D-147](DECISIONS.md#d-147--원본과-wiki의-개별-휴지통복원-2026-11-23) · [통합 검증](HISTORY.md#2026-11-24--휴지통복원-040-통합-반영).
- 문서·보관 판본 목록은 SQLite 조회 인덱스와 명시 추적 모드의 변경 관측을 사용합니다. 기본 전체 검사와 주기적 전체 대조, 같은 저장 잠금 안의 제한된 해석 재사용을 유지하며 원문·이력·권한·CAS를 캐시로 대체하지 않습니다. [D-100·D-101](DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06) · [검증 기록](HISTORY.md).
- 개인 결과는 편집 초안·원래 생성문·전체 고정 근거·답변 계보를 보존하고 명시 요청으로 Wiki에 반영합니다. 초안/대상 CAS와 최신 근거 확인·저장 영수증을 사용합니다. 화면의 현재 흐름은 [UI 계획](../ui/PLAN.md)을 따릅니다.

## 공개 구현 계약

- `parse_document(content)`는 metadata/body/body_start_line/body_revision/document_id를 구분합니다. content/revision은 전체 파일 의미입니다. Front Matter 없는 파일은 metadata `{}`, document_id `None`, 본문 시작 줄 1이며 읽기만으로 고치지 않습니다. YAML 중복 키·alias·허용되지 않은 필드를 거부합니다.
- 신뢰된 분석 생성은 `render_document()`에 고정 원본 `{id, version}`을 넘깁니다. 사용자 편집은 HTTP/MCP 모두 `prepare_edit()`를 거쳐 서버 문서 ID를 보존하고 기존 document_id/source 변경을 거부합니다. 기존 문서 갱신은 기존 ID를 사용합니다.
- `WikiStore.save()`는 expected_revision과 actor/origin/reason을 받습니다. actor는 서버 인가값을 사용합니다. origin은 human/ai/unknown 문자열 또는 `{kind, provider?, model?, tool?, job_id?, run_id?}` 객체이며 미기록 출처는 unknown입니다. `document_fields()`는 metadata/document_id/body_revision/authorship를 조립하고 상세 읽기에만 body/body_start_line을 더합니다.
- `_history/<document>/changes.json`은 저장 전 intent와 전체 파일 공개 뒤 확정을 기록합니다. 확정 실패는 저장 성공의 `audit_status=pending_reconcile`·audit_error로 반환하므로 자동 재시도하지 않습니다. 읽기는 복구하지 않고 다음 쓰기가 현재/보관 파일과 대조합니다. 손상·판정 불가에서는 쓰기를 중단합니다.
- 작성정보는 created/updated의 actor·origin·reason·시각·전후 revision·history/change ID·상태이며 과거 미기록은 unknown입니다. 새 필드를 과거 원장에 주입하지 않습니다. 입력 metadata 오류와 원장 손상/대조 불가를 구별합니다.
- 과거 Front Matter 없는 판본을 관리 문서로 복원할 때 현재 서버 ID/source와 옛 body를 결합해 새 판본으로 저장합니다. 보관 파일 바이트는 변경하지 않습니다.
- `SaveResult.cleanup_failures`는 저장 성공 뒤 정리 경고입니다. storage_busy는 같은 기준으로 재시도할 수 있지만 conflict는 최신 본문과 수정 내용을 다시 대조합니다. 검색의 truncated/skipped는 불완전 결과로 표시합니다.

Front Matter·작성 이력의 결정과 보존 경계는 [D-072](DECISIONS.md#d-072--편집-markdown의-front-matter와-작성-이력-2026-10-28)를 따릅니다.

## 남은 검증

운영 자료 자동 이관·전원 장애 내구성은 검증하지 않았습니다. 실제 사용자 자료로 쓰기 시험하지 않으며 전체 UI·실제 CLI·다른 실행 환경의 완료 여부는 각 도메인의 통합 검증으로 판단합니다.

## 완료 조건과 근거

변경한 저장 경로의 정상·충돌·권한 회수·실패 보존을 격리 데이터에서 확인합니다. 원문과 모든 과거 파일, 전체파일 revision, 저장 성공과 원장/임시 정리 실패의 구분을 유지합니다.

[적용 결정](DECISIONS.md) · [검증 기록](HISTORY.md) · [공통 저장 규칙](../../../AGENTS.md#공통-데이터-보존)

# Wiki 문서·저장 계획

## 현재 상태

영향 조회의 같은 저장 잠금 안에서만 `reuse_parsed_documents()`를 활성화했습니다. 전체 원문과 parser/loader/validator identity가 같은 성공 해석만 최대256개·입출력 UTF-8/metadata16MiB 예산으로 재사용합니다. metadata는 첫 반환/히트 모두 사본으로 분리하고 종료·오류 때 clear/reset하며 다른 thread/copied closed context는 우회합니다. 기본 읽기/쓰기는 기존 파서를 사용하고 파일 I/O·ID/본문 좌표·판본·CAS·전체 이력은 유지합니다. [검증 기록](HISTORY.md#2026-11-06--2초-목표의-영향-조회-조립메타정보-해석-재사용)과 [운영/실측](../platform/HISTORY.md#2026-11-06--2초-목표의-영향-조회-조립메타정보-해석-재사용)을 따릅니다.

2026-11-06 [D-101](DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06)의 저장 전 변경 기록·문서/보관 판본 관측을 구현·격리 검증했습니다. 명시 추적 모드는 변경 없는 전체 탐색을 생략하고 기존 문서 변경은 해당 파일·상위 폴더 이름을 대조합니다. 신규·기록 유실·정리 실패·최대30초마다 전체를 확인하며 기본 전체 검사·원문·전체 이력·CAS·커서는 유지합니다. [검증 기록](HISTORY.md#2026-11-06--변경-원장에-따른-문서이력-증분-관측)과 [운영 상태](../platform/PLAN.md)를 따릅니다.

2026-10-28 D-072 저장 담당 구현과 격리 검증을 완료했습니다. Front Matter·전체 파일 CAS/이력·작성 원장·문서 HTTP 읽기/수정/복원을 연결했습니다. 실제 수행 결과와 운영 미실행 범위는 [HISTORY](HISTORY.md)에 기록합니다. 다음은 다른 담당이 소비하는 공개 계약입니다.

- `documents.metadata.parse_document(content)` → `ParsedDocument(metadata, body, body_start_line, body_revision, document_id)`. Front Matter 없는 파일은 metadata `{}`, document_id `None`, body 원문, 시작 줄 1입니다. content/revision은 전체 파일 의미를 유지합니다.
- `documents.metadata.render_document(body, *, title, document_id=None, source=None, tags=None, description=None)`는 서버 호출용 생성 함수입니다. document_id 생략 시 UUID hex를 생성하고 source는 `{id, version}`입니다. 분석은 고정 원본 판본을 넘기며 기존 문서 갱신에는 기존 document_id를 전달합니다. 파서는 엄격한 YAML/중복 키/허용 필드 검증을 합니다.
- `WikiStore.save(..., expected_revision=..., before_commit=None, actor=None, origin=None, reason=None)`를 호환 확장합니다. actor는 기존 Access dict + 선택 `access_revision`, origin은 `human|ai|unknown` 문자열 또는 `{kind, provider?, model?, tool?, job_id?, run_id?}`입니다. 누락 출처는 unknown입니다. 신원은 HTTP/MCP/분석의 서버 인가값만 전달합니다.
- HTTP/목록 추가 필드: `metadata: dict`, `body_revision: str`, `document_id: str|null`, `authorship: {status, created, updated}`. 상세는 `body`, `body_start_line`도 제공합니다. created/updated는 `{actor, origin, reason, recorded_at, before_revision, after_revision, history_id, change_id, status}` 또는 null이며 과거 미기록은 unknown입니다. `documents.changes.authorship(store, document, revision)`를 공개합니다(이미 위키 잠금 보유 시 사용 가능, 읽기만 수행).
- 작성 원장 `_history/<document>/changes.json`에 저장 전 intent를 기록하고 전체 파일 공개 뒤 확정합니다. 확정 실패는 저장 성공과 `audit_status=pending_reconcile`을 구분합니다. 읽기는 복구하지 않으며 다음 쓰기는 현재 파일/보관 이력과 대조한 뒤 처리합니다. 손상·판정 불가에서는 쓰기를 중단합니다.
- **MCP 의존성 인계**: PyYAML `>=6.0.2,<7` 필요(안전 로더, 중복 키/alias 금지). MCP 담당이 프로젝트 venv에 PyYAML 6.0.2를 설치한 것을 확인했습니다. requirements/lock은 MCP 담당이 관리합니다.


파일 저장·읽기·전체 버저닝·CAS·잠금/크기/실패 보존 구현 완료. 일반 API의 문서 목록·전체 본문 읽기도 구현 완료.

HTTP 본문 저장·과거 버전 목록/전체 본문·복원도 기존 WikiStore와 안전한 이력 조회로 연결했습니다. 저장 직전 권한을 재확인하고 과거 전체 본문/작성 정보 미기록을 보존합니다. 계약과 실제 검사 결과는 [API 계획](../platform/PLAN.md)·API 작업 기록 (정리로 삭제된 참고 자료)에 둡니다.

개인 저장 결과의 편집 초안·원래 생성문·전체 고정 근거·답변 계보를 보존하고 Wiki에 명시 반영하는 API를 추가했습니다. 초안/대상 본문의 CAS와 최신 근거 관측값을 함께 요구하며 변경 근거의 명시 확인·저장 영수증을 제공합니다. 전체 근거 부록까지 1MiB 제한을 적용하고 임의 축약하지 않습니다. 해당 검증은 API 작업 기록 (정리로 삭제된 참고 자료)에 둡니다.

문서 목록과 본문 query에 허용된 profile 선택을 추가해 UI의 선택 관점과 실제 응답/cursor 기준을 일치시켰습니다. 관점 권한 거부·다른 관점 cursor 재사용 거부·빈/공백/1MiB 본문의 원문 보존을 포함한 읽기 API14검사가 통과했습니다. 화면 통합의 현재 범위/검증은 [ui PLAN](../ui/PLAN.md)이 관리합니다.

### 추가 연동 계약

- **분석 인계 해결**: `changes.provenance`는 기본 프로필의 `domain=None`, `viewpoint=None`를 허용하도록 수정했습니다. 실제 가입 사용자의 HTTP 저장·작성정보 검증 4개가 통과했습니다. actor의 다른 신원/판본 필드는 그대로 검증합니다.

- `documents.changes.document_fields(store, document, snapshot, *, include_body=False)`는 metadata/문서 ID/본문 revision/작성정보를 함께 반환합니다. 상세 읽기에서만 include_body=True를 사용합니다. 읽기 동안 위키 잠금을 보유하면 snapshot과 원장을 같은 기준으로 관측할 수 있습니다.
- `documents.metadata.prepare_edit(document, content, previous_content=None)`는 사용자 전체 파일 편집용입니다. 신규/구형 문서의 명시 저장에는 서버 ID를 추가하며 기존 document_id/source 변경을 거부합니다. HTTP PUT은 이 함수를 사용합니다. **MCP 사용자 수정도 이 경로를 소비합니다(실제 문서 연동 5검사 통과)**. 신뢰된 분석 생성은 render_document를 사용합니다.
- `SaveResult` 추가 필드는 `audit_status: recorded|pending_reconcile`, `audit_error: str|null`입니다. pending_reconcile도 본문 저장은 성공했으므로 자동 재시도하지 않습니다. HTTP 저장 영수증도 두 필드를 반환합니다.
- 공통 오류 매핑 인계: `documents.metadata.DocumentMetadataError`는 입력 오류, `documents.changes.AuthorshipCorruptError`는 원장 손상/대조 불가(기존 자료 보존, 서버 오류)입니다. 이력 확정 실패는 예외가 아닌 위 성공 결과 필드로 전달합니다.
- 과거 Front Matter 없는 버전을 현재 관리 문서로 복원할 때 현재 서버 ID/source 연결을 유지한 채 옛 body를 복원합니다. 보관 파일 바이트는 그대로이며, 전체 파일 revision은 새 저장값입니다.

## 다음 요청에서 확인할 범위

이 저장 담당 범위는 완료했습니다. 전체 UI·실제 CLI·운영 서버의 최종 사용자 흐름은 각 담당 통합 검증으로 판정합니다. 운영 자료 자동 이관·전원 장애 내구성 검증은 수행하지 않았습니다.

## 완료 조건

변경한 저장 경로의 정상·충돌·실패 보존을 격리 데이터로 검증합니다. 기존 원문·모든 과거 파일과 revision 계약을 유지합니다.

## 근거와 기록

- [적용 결정](DECISIONS.md)
- 이관 전 검증/계획 원문 (정리로 삭제된 참고 자료)
- 과거 시험 수는 당시 기록입니다. 이번 문서 이관에서 제품 시험을 재실행한 결과가 아닙니다.

## 이후 작업 기록

이후 완료한 작업은 별도 `HISTORY.md`에 실행한 검증과 한계를 짧게 추가하고, 위 현재 상태는 교체합니다. 이력이 생길 때 파일을 만들며 현재 상태에 과거 일지를 누적하지 않습니다.

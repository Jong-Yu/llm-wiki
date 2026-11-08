# 문서 저장 작업 기록

## 2026-11-06 — 2초 목표의 영향 조회 조립·메타정보 해석 재사용

- `metadata.parse_document`의 기존 본문을 `_parse_document`로 분리하고 기본 동작은 그대로 유지했습니다. 영향 조회의 root lock 안에 한정한 ContextVar scope에서 전체 원문 str+parser/_load/validator 함수 identity가 같은 성공 결과만 재사용합니다. 최대256개/입력·본문·metadata 인코딩16MiB 예산이며 초과·비해시 hook·캐시용 UTF-8/인코딩 불가는 기존 파서 결과를 보존합니다. 실패는 저장하지 않습니다.
- 첫 반환도 cache의 private metadata와 분리하고 히트마다 metadata/tags/source dict를 복제합니다. 본문·body_revision·줄 좌표·ID는 원래 값입니다. 중첩 scope의 token 복원, owner thread 제한, finally closed/clear/reset으로 복사 context나 다음 요청에 자료가 남아 재사용되지 않게 했습니다. Wiki read/save의 파일 I/O·전체 파일 hash/CAS·크기/전체 이력 계약은 변경하지 않았습니다.
- 새14개가 CRLF·무header·body/hash/ID/좌표, 성공/히트 변이, YAML alias/duplicate/depth/size/type/surrogate 오류와 비저장, 함수 변경·상한·중첩/예외·thread·copy_context 종료를 검증했습니다. 공통646개도 통과했습니다. 실제 profile은754 parse/_load에서 scope wrapper732회 중 실제parse/_load100회가 됐습니다. 서로 다른 시점 자료이므로 정확한 고정 문서 수 비교는 아니며 고정 fixture DTO/원본 동일과 [운영 결과](../platform/HISTORY.md#2026-11-06--2초-목표의-영향-조회-조립메타정보-해석-재사용)를 함께 봅니다.

## 2026-11-06 — 변경 원장에 따른 문서·이력 증분 관측

- [D-101](DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06)의 잠금 inode 변경 원장을 원문/작성 원장의 첫 효과 전에 기록합니다. 명시 추적 조회는 첫/최대30초 전체 확인 뒤 기존 문서 metadata만 갱신하며, 해당 상위 폴더 이름 변화·신규·한도/오류에서는 전체 확인합니다. 보관 판본은 해당 문서/작성 원장 변경에만 다시 탐색합니다. 기본 전체 검사와 CAS·전체 이력·저장 성공/정리 오류를 유지합니다.
- 공통 원장15개와 문서 추적12개를 포함한 전체 core541개가 통과했습니다. 후속 HTTP/MCP 추적 쓰기→즉시 목록 반영→권한 회수403 통합1개를 추가해 해당 파일13개도 통과했습니다. 빈 저널 chain loss와 archive/임시 정리 동시 실패의 `scanned`/탐색 한도 차이를 독립 검토에서 재현한 뒤 lock stamp·상위 이름 대조로 보완하고 두 경계를 독립 재통과했습니다.
- 격리 warm5회 중앙값: 문서500/페이지20은11.241→9.633ms, 보관 판본59/페이지20은4.820→4.906ms로 이력의 시간 이득은 확인하지 못했습니다. 두 경우 warm 전체 metadata 탐색은0건입니다. 이력 fixture 본문은208,000바이트+판본 번호(약203KiB)이며 앞 기록/측정 label의192KiB 표기를 정정합니다. 실제 운영 범위는 [platform 기록](../platform/HISTORY.md#2026-11-06--변경-기록계측과-현재-서버-반영)을 따릅니다.

## 2026-11-06 — SQLite 문서목록·보관 판본 조회 인덱스

- [D-100](DECISIONS.md#d-100--원문을-보존하는-sqlite-조회-인덱스-1단계-2026-11-06)에 따라 문서 목록 키와 보관 판본 요약을 파생 SQLite에 연결했습니다. 선택 페이지의 현재 문서는 기존 읽기를 사용하며 보관 요약은 판본 파일·작성 원장 지문으로 갱신합니다. 원문/전체 이력/CAS·작성 출처·기존 커서와 원본 손상 오류는 유지합니다.
- 전용 7개 검사에서 SQL 페이지의 현재 본문 읽기 수, warm 이력 본문 읽기 0건, 작성 원장 변경·새 판본의 cursor 거절, workspace 분리·위험 경로·캐시 오류 복귀를 확인했습니다. 독립 검토에서 발견한 연결 종료 시 캐시 오류도 기존 조회로 정확히 한 번 복귀하도록 보완했고 원본 바이트 보존을 재현했습니다.
- 격리 자료의 보관 판본 59개×192KiB/페이지20에서 warm 3회 중앙값은 기존 5.188→인덱스 4.541ms였으며 반환 결과가 같았습니다. 파일 metadata 전체 탐색과 현재 본문의 상세 검사는 남아 있습니다. 통합 검증·운영 미반영 범위는 [platform 기록](../platform/HISTORY.md#2026-11-06--sqlite-조회-인덱스-1단계-통합-검증)을 따릅니다.

## 2026-11-06 — 이력 목록의 반복 원장 읽기 개선

- 전체 API 점검의 격리 자료에서 499개 이력의 페이지50개가 같은 작성 원장을 51회 검증했고, 공간 이력 집계(limit1)는 509회 검증·4.632초였습니다. `list_versions()`가 같은 저장 잠금에서 확보한 작성 원장 entries를 항목별 작성자 조합에 재사용하도록 수정했습니다. 단일 판본 읽기·현재 작성 정보·다음 요청은 계속 독립 검증합니다.
- 신규 회귀는 10개 이력 페이지에서 항목용 원장 로드1회, 동일 반환값/전체 파일 보존을 확인합니다. 기존 CAS·복원·권한·정리 실패와 함께 수정 후 지식108개+저장/HTTP/MCP60개, 합168개가 통과했습니다. 최초 신규 시험 두 건은 시험 코드의 evidence 필드명과 기존 메서드 경계 배치 오류로 실패해 바로잡고 재통과했습니다. 원문·과거 파일·정책·서버는 변경하지 않았습니다.
- 독립 검토에서 원장 선로드가 현재 metadata와 작성 원장이 함께 손상된 경우의 오류 순서를 바꾸는 회귀를 발견했습니다. 첫 이력 읽기 성공 후 항목별 실패 경계 안에서 지연 로드하도록 보완했고, 새 복합 손상 시험과 독립 재현에서 기존 `DocumentMetadataError` 우선·모든 파일 보존을 확인했습니다.
- 검토값 중복 검사 개선을 함께 적용한 실자료 ASGI 측정에서 공간 전체 이력은 11.410→4.278초였습니다. 이는 두 수정의 합산 효과이며 이력 로드 수정 단독 효과나 운영 서버 반영 결과로 해석하지 않습니다. 전체 범위와 남은 검증은 [API 점검](../platform/HISTORY.md#2026-11-06--전체-http-api-경계와-조회-성능-점검)을 따릅니다.

## 2026-10-28 — D-072 Front Matter·작성 원장

- 변경: documents의 metadata/changes 파서·원장, WikiStore·history·listing, documents HTTP DTO/라우터와 personal 초안 반영. 전체 content/revision·1MiB·CAS·수정 전 전체 바이트를 유지하고 metadata/body/body_revision/좌표/문서 ID/작성정보를 추가했다. YAML 의존성 고정은 MCP 담당 파일에서 적용했다.
- 검증: `.venv/bin/python -m unittest discover -s core/tests/poc_storage -q` **37개 통과**(저장/개인/원본 33개 + 실제 인증 HTTP 4개). `.venv/bin/python -m unittest core.tests.poc_mcp.test_server_integration.DocumentIntegration -v` **5개 통과**. `.venv/bin/python -m unittest discover -s core/tests/poc_analysis -p test_registration.py -v` **10개 통과**. 모두 임시 디렉터리의 정책·원본·위키·이력 사용.
- 검증 범위: 제목/tags 편집과 본문 지문 분리, CRLF/한글/빈 문서, Front Matter 없는 과거 파일, 중복 키/alias/위조 ID·actor 거부, 전체 파일 동시 CAS, 보관 실패/원장 intent 실패/본문 공개 실패 보존, 확정 실패의 저장 성공 구분, 새 Store에서 pending 대조 복구, 정리 실패 구분, 이력 조회·복원, 권한 회수, 개인 초안 AI 출처와 access_revision 현재성.
- 발견·수정: 정상 기본 프로필의 domain/viewpoint null을 허용하도록 작성자 검증 보완. 처음 실패한 임시 경로 비교/서버 초기화 fixture는 macOS `/var`/`/private/var` 표기를 resolve로 일치시켜 재검증했다. 제품 저장 실패를 숨긴 것이 아니다.
- 미실행: 실제 사용자 data/.local/토큰 변경, 운영 이관·서버 전환, 실제 모델 호출, Electron 전체 흐름, 강제 종료·전원 장애/디렉터리 fsync 내구성. 원장 확정 실패는 audit_status=pending_reconcile로 남으며 읽기는 복구하지 않는다. 외부 편집기 직접 쓰기는 저장 계약 밖이다.

## 2026-11-03 — 검색 한글 정규화·원본 제목 검색

- `search_documents`가 문서 이름·본문·검색어를 NFC로 맞춘 뒤 비교한다(macOS NFD 파일명과 입력 차이). 검색 API는 `sources`로 등록 원본 제목 검색 결과도 함께 준다(본문은 읽지 않음). 격리 시험과 `poc_storage` 통과, 서버 재시작 뒤 실제 서버 읽기 검색으로 확인.

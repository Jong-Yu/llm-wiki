# Wiki 문서·저장 작업 기록

## 목록의 명시적 관점 선택 (2026-10-25)

- 변경: ListQuery에 profile을 허용하고 기존 authorized 정책으로 선택 관점을 확인합니다. 목록은 관점의 접근 경계로 새로 필터링하지 않으며 현재 사용자/정책/관점을 응답과 cursor 기준에 보존합니다. 본문 query·저장·히스토리는 변경하지 않았습니다.
- 실제 검증: 프로젝트 `.venv`의 `python -B -m unittest core.tests.api.test_read_api -v`에서 실제 loopback을 포함한13개 통과. 허용 all/business 응답 관점, 관점별 cursor 재사용 거부, 금지 관점의 저장소 생성 전 거부와 자료 보존을 확인했습니다. 초기 기본 실행의 포트 바인딩 거부 후 해당 모듈을 승인된 실행으로 재검증했습니다.
- 화면 통합 검증은 [ui HISTORY](../ui/HISTORY.md)의 문서 목록 항목을 따릅니다.

## 본문의 명시적 관점과 원문 보존 (2026-10-25)

- 변경: ContentQuery에도 profile을 허용해 기존 authorized 정책이 선택 관점을 확인하도록 했습니다. 본문 endpoint의 WikiStore.read·원문/revision·권한 확인 순서와 저장/히스토리 동작은 유지합니다.
- 실제 검증: 프로젝트 `.venv`의 `python -B -m unittest core.tests.api.test_read_api -v`에서 실제 loopback을 포함한14개 통과. 허용/금지 관점, 저장소 접근 전 권한 거부, 경로 이탈 거부와 빈 문자열·공백·CRLF·한글·탭·1MiB 제어 문자의 정확한 반환/JSON 이스케이프 및 기존 파일 바이트 보존을 확인했습니다. 실제 앱의 본문 연결/표시 검증은 [ui HISTORY](../ui/HISTORY.md)가 관리합니다.

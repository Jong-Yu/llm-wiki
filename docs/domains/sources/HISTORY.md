# 원본 저장 작업 기록

## 2026-11-06 — 변경 기록에 따른 원본 metadata 증분 관측

- 현대 카탈로그의 기존 항목 변경은 해당 metadata만 갱신하고 warm 목록/통합 요약은 디렉터리 탐색·카탈로그 metadata open0건을 확인했습니다. 신규·손상·한도·기록 유실/보유 범위 밖·30초 확인은 전체 검사입니다. 기존 전체 카탈로그 hash·cursor·판본/원본·영수증은 유지합니다.
- 추적 전용12개와 기존 인덱스14개를 포함한 전체 core541개가 통과했습니다. 구형 `_registrations/*.json` 쓰기에서 발행/정리 실패로 임시 파일이 남는 경우는 항상 전체 검사해 기존과 같은 `SourceCorruptError`를 반환하고 원본을 보존합니다. 저장 실패의 `.storage.lock` intent만 바뀌는 기존 검사 기대는 원문/전체 이력/작성 원장 바이트 비교를 유지한 채 보완했습니다.
- 카탈로그 metadata100×30판본/페이지20, warm5회 중앙값은 기본 인덱스25.329→추적 인덱스2.946ms이며 응답이 같았습니다. 모든 판본의 실제 파일을 갖춘 운영 자료 측정은 아닙니다. 변경 목록의 전체 JSON hash와 직접 외부 편집의 추적 모드 즉시 감지 한계는 [D-101](../documents/DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06), 운영 상태는 [platform 기록](../platform/HISTORY.md#2026-11-06--변경-기록계측과-현재-서버-반영)을 따릅니다.

## 2026-11-06 — SQLite 원본 목록 요약

- 원본 카탈로그의 안전한 metadata 지문과 기존 목록/통합 문서 요약을 저장하고 SQL로 페이지를 선택합니다. warm 목록은 원본 JSON 본문을 다시 읽지 않습니다. 기존 전체 카탈로그 hash·cursor를 유지하기 위해 최초/변경 목록은 전체 카탈로그를 한 번 검증하며 등록·판본·영수증 원본을 변경하지 않습니다.
- 전용 14개와 기존 원본 저장35/HTTP4개가 통과했습니다. cold/warm/변경·원본 손상·한도·cursor·scope·캐시 실패 및 앞 원본 손상과 뒤 metadata 한도가 함께 발생할 때의 기존 오류 순서를 확인했습니다.
- 카탈로그 metadata 격리 자료 100원본×30판본/페이지20의 warm 3회 중앙값은 101.242→24.821ms이고 결과는 같았습니다. 모든 판본의 실제 파일을 갖춘 운영 자료 측정은 아니며 운영 원본은 접근·변경하지 않았습니다. [D-100](../documents/DECISIONS.md#d-100--원문을-보존하는-sqlite-조회-인덱스-1단계-2026-11-06)과 [통합 검증](../platform/HISTORY.md#2026-11-06--sqlite-조회-인덱스-1단계-통합-검증)을 따릅니다.

## 2026-11-06 — 개인 변환 보고 조립 공통화

- 파서/OCR과 보고 상태의 책임을 나눠 `core/client/source_conversion_report.py`가 누적·한도·checkpoint와 빈/중단 보고를 맡습니다. 부모 worker의 기본 보고 구조 2곳과 중단/미독 꼬리 조립 3곳도 이 구현을 재사용합니다. 기존 `source_conversion_formats`의 class/상수/예외 import는 호환 alias로 유지합니다. 변환 규칙·한도·원본·등록 보고의 저장 계약은 변경하지 않았습니다.
- 작업 시작 snapshot의 기존 구현을 격리 실행해 7형식의 누적·한도·진단·빈 실패 보고 **49개 경우**의 결과와 모든 checkpoint가 canonical JSON 바이트로 동일함을 확인했습니다. 기존 변환/질문 경로를 포함한 analysis 144개가 통과했습니다. 상세 감독/실행 회귀와 미실행 환경은 [실행 환경 기록](../platform/HISTORY.md#2026-11-06--실행-감독http프로세스-경계의-구조-정리)을 따릅니다. 실제 사용자 문서·운영 자료·AI 호출·Windows 실기기는 검증에 사용하지 않았습니다.

## 2026-11-03 — 가져오기에서 Pandoc 제거(D-095)

- 변경: `source_conversion_formats.py`의 DOCX를 `python-docx` 경로로, XLSX를 구조 기록+`openpyxl` 셀 기록으로 단일화하고 `source_conversion_pandoc.py`, XLSX 입력 사본 생성(`prepare`, `canonical_workbook_prefix`, `label_sheet_headings`, `MAX_MERGE_REFS`)을 제거했다. 진단의 `pandoc` 항목과 실행 정보의 `pandoc_version`도 없앴다. 병합 범위 안 기준셀이 아닌 칸의 값 경고(`non_anchor_value_inside_merge`)는 사본 생성에 있던 판정이라 구조 기록과 셀 기록에서 계산하는 `non_anchor_issues`로 옮겨 보존했다.
- 검증: 변환 시험 3개 모듈 25개(DOCX 좌표·본문 순서, 각주/주석/변경 추적/이미지/머리말의 부분 상태, 병합·표 안의 표, XLSX 수식·캐시·위치·누락 캐시, 8시트와 복잡 병합, 실제 업로드→변환 보고 응답 유실 복구→Markdown 개정 연결 DOCX/XLSX)가 통과했다. 이전에는 Pandoc이 있는 PC에서만 도는 시험이 포함된 34개였고 Pandoc 전용 9개를 제거했다. `poc_knowledge` 93·`poc_mcp` 79·`poc_storage` 37개와 `poc_access` 28개 통과, `poc_analysis` 95개 중 실패는 Codex CLI 부재 2건뿐이다.
- 손실과 한계: DOCX 결과가 단일 Markdown(제목·목록·표·각주·주석·변경 추적)에서 문단·셀 단위 글자로 바뀌어 위키 첫 Markdown에서 제목/목록 구조가 사라진다. 각주·주석·머리말·변경 추적·표 안의 표는 읽지 않고 미독이다. XLSX의 표 모양 읽기용 보기와 병합 참조 표시는 사라졌고 셀 기록과 구조 JSON만 남는다. 기존 등록 보고는 변경하지 않았다. 실제 사용자 문서와 Windows는 검증하지 않았다.

## 2026-10-29 — 여러 시트 대응·이름 범위·서식 출처 검증

- 표본: 8시트·46셀·28수식의 합성 XLSX. workbook 표시 순서/관계 파일 순서를 다르게 두고 비연속 sheetId, 빈 시트·hidden/veryHidden, `실적`/`실적 `처럼 공백만 다른 이름, apostrophe 이름, 같은 셀 주소/표현, 시트 간·3D·전역/지역 이름 수식과 원본 캐시를 섞었다. 색 범례만으로 보류/진행을 구분하는 동일 값 셀과 크기/조건부 서식도 포함했다.
- 재현/수정: 유효한 workbook 관계 namespace 별칭에서 Pandoc 3.13의 `Missing r:id` 실패를 재현해 개인 작업 사본에서만 표기를 보완했다. 시트 번호+JSON 원명으로 MD 제목을 표시하고 실제 생성 머리글 개수/순서를 대조한다. 시트의 원래 ID/관계 ID/part/순서/정확한 이름, definedName의 전역/지역 범위를 함께 보존한다. 연결이 맞지 않으면 추정하지 않고 구조와 셀 기록을 부분 결과로 유지한다.
- 서식 판단: 현재 문서 등록/분석에 Excel 화면의 픽셀 단위 복제는 필수로 보지 않았다. 색만으로 상태를 구분하는 경우를 위해 실제 셀 style 참조·사용한 xf/font/fill/border·숫자 형식/팔레트/테마 참조와 행 높이/열 너비·조건부 서식 선언을 MD 원본 구조에 보존했다. 색의 업무 의미나 조건부 표시 결과를 자동 해석/계산하지 않았다.
- 실제 검증: `.venv/bin/python -B -m unittest core.tests.poc_analysis.test_source_conversion_xlsx_sheets core.tests.poc_analysis.test_source_conversion_xlsx_complex core.tests.poc_analysis.test_source_conversion core.tests.poc_analysis.test_registration -q` **45개 통과**(여러 시트 5·복잡 표 8·변환/연결 21·기존 등록 11). 원본 XML의 모든 sheet/part·셀/수식/캐시와 실제 Markdown→HTML의 정확한 시트 제목 및 td 대응을 대조했다. 부재·제목 불일치의 보존과 합산 출력 한도, 기존 병합/단일 형식도 통과했다.
- 연결/정적 검사: 새 8시트 원본도 실제 multipart 등록 → hash 다운로드 → worker/Pandoc → 불변 변환 보고/응답 유실 조회 → 보존형 단일 MD/first_markdown revision 연결을 확인했다. 원본 재다운로드 바이트와 MD 전체 본문/위치·미독/경고를 대조했다. 담당 Python 5개 AST/whitespace 및 변경 `git diff --check` 통과. 렌더 비교기의 HTML 개행은 브라우저와 같은 공백 규칙으로 비교하도록 시험을 고쳤으며 원문 셀 기록은 별도로 정확한 문자열을 유지한다.
- 한계: 합성 표본 검증이며 실제 사용자 Excel/GUI/Windows와 임의 문서 전체 포함/의미 정확도는 검증하지 않았다. 화면 재현·계산 엔진/서버 Office 실행·새 의존성을 추가하지 않았다. 기존 원본/운영 위키·전체 이력·권한/토큰과 재계산되지 않은 캐시를 유지한다.

## 2026-10-29 — 병합 셀·복잡 표의 Markdown 대응 검증과 수정

- 재현: 3시트·10개 병합·2개 Excel 표(실제 64셀·7수식)·다단 헤더/합계·반복 이름·숨김 행/열/시트·공유/시트 간/병합 기준셀 수식이 있는 합성 XLSX에서 셀 값/수식/캐시/좌표는 보존됐지만, 병합/표 경계가 MD에 없고 첫 설명 행이 표 머리글로 바뀌는 두 문제를 재현했다. 기존 사용자 원본이나 운영 자료를 쓰기 시험에 사용하지 않았다.
- 수정: `source_conversion_xlsx.py`에서 OOXML의 병합 범위/기준셀/값 유무, 명시 표 이름·범위·열/집계/수식 속성과 숨김 범위를 읽어 MD 구조 기록에 보존한다. v2 Pandoc 작업 보기의 머리글에는 생성 열 문자만 사용하고 원본 좌표는 문자열에 유지한다. 병합에 포함된 빈 칸에는 기준셀 참조만 두며 원문 값/수식을 복제하지 않는다. 원본 ZIP·수식·원시 캐시·실제 cells 위치는 유지한다.
- 실패 보존: Pandoc 부재/실패와 합산 출력/병합 참조 확장 한도에서도 읽은 구조와 실제 셀 기록을 남긴다. 대체 경로의 셀 기록도 가변 길이 코드 블록으로 보존해 원문 백틱·여러 줄·파이프가 렌더 과정에서 문법으로 사라지지 않음을 확인했다. 겹친 병합은 무리하게 하나를 선택하지 않고 partial로 보고하며, 비기준셀의 숨은 수식/캐시는 덮어쓰지 않고 보존/경고한다. 빈 병합 기준셀에 인접 값을 만들어 넣지 않는다.
- 실제 검증: `.venv/bin/python -B -m unittest core.tests.poc_analysis.test_source_conversion_xlsx_complex core.tests.poc_analysis.test_source_conversion core.tests.poc_analysis.test_registration -q` **39개 통과**(복잡 표 8·변환/연결 20·기존 등록 11). 원본 XML을 별도 oracle로 읽어 모든 실제 셀의 시트/주소·값·수식/공유 수식 확장·원시 캐시와 대조했고, 생성 MD를 실제 Pandoc으로 HTML로 읽은 td/th에서도 대응을 확인했다. 가로/세로/직사각 병합, Z→AA와 XFC→XFD 경계, 빈 병합, 실제 비기준셀 수식, 겹친 병합·부재/한도를 확인했다.
- 연결: 새 복잡 표도 multipart 원본 등록 → hash 검증 다운로드 → 실제 worker/Pandoc → 불변 보고 저장/응답 유실 조회 → D-074 단일 MD/first_markdown 판본 연결을 통과했다. 원본 재다운로드 바이트와 MD 전체 본문/보고 단위 위치·경고·미독을 대조했다. 담당 Python 4개 AST/whitespace와 변경 `git diff --check`도 통과했다.
- 검증 실패/수정: 초기 두 실패가 위 병합 정보 누락/설명 행 오해석을 포착했다. 렌더 검증기의 기본 Markdown reader가 smart 따옴표 변환을 수행해 원시 캐시 문자열 비교가 실패한 것은 검증 reader를 `markdown-smart`로 지정해 해결했다. 생성 MD의 원문 따옴표는 바꾸지 않았다.
- 남은 한계: 합성 표본과 명시 관계/내용 대응의 검증이며 임의 실무 문서 전체 정확성을 보장하지 않는다. 셀 크기·색·서식과 시각적 rowspan/colspan 재현, 필터/외부 객체의 전체 의미·실제 Excel/GUI/Windows·의미 추출/모델 평가는 미실행이다. 원본 전체 포함/의미 정확성은 계속 not_verified/not_run이다. 기존 보존/CAS·용량 한도와 운영 자료/정책/토큰을 변경하지 않았다.

## 2026-10-29 — XLSX 경로 오류 수정·Pandoc 표와 원본 셀 기록 보존

- 원인: [공식 Pandoc 3.13 Parse 소스](https://github.com/jgm/pandoc/blob/3.13/src/Text/Pandoc/Readers/Xlsx/Parse.hs)의 worksheet/styles/sharedStrings 조회가 관계 Target에 `xl/`을 바로 붙인다. openpyxl의 유효한 `/xl/worksheets/sheet1.xml` Target에서 `xl//xl/...` 조회 실패를 실제 재현했다. 같은 파서는 inlineStr의 `is/t`와 수식 `f`를 처리하지 않고 숫자 `v`를 부동소수로 해석한다. [표 생성 소스](https://github.com/jgm/pandoc/blob/3.13/src/Text/Pandoc/Readers/Xlsx/Sheets.hs)는 채워진 셀 범위에서 표를 만들고 첫 행을 머리글로 사용하므로 경로만 고쳐서는 원본 문자·수식·좌표의 보존을 보장하지 않는다.
- 변경: `source_conversion_xlsx.py`로 원본 formula/cache XML을 관측하고, Pandoc 전용 임시 ZIP 사본에서만 관계 경로와 셀 문자열 보기를 보정한다. source XLSX를 openpyxl로 다시 저장하지 않는다. 좌표가 붙은 shared string 표를 실제 `--from=xlsx`로 변환하고, 기존 정확한 `cells` 위치와 수식·캐시 해석값/원문/종류·수식 속성을 코드 블록에 보존한다. whole 표와 셀 기록은 같은 자료의 두 표현임을 보고하고 기존 `xlsx_values` 불변 보고/단일 MD를 사용한다.
- 실제 검증: `.venv/bin/python -B -m unittest core.tests.poc_analysis.test_source_conversion core.tests.poc_analysis.test_registration -q` **30개 통과**(변환/연결 19개·기존 등록 11개). 새 XLSX 검증 8개는 절대 경로 실패→실제 Pandoc 성공, 상대 경로, inline 한글·여러 줄·Markdown 문자·희소 셀/빈 행·두 시트/병합, 숫자/문자열/false/빈 문자열/오류/날짜/긴 소수 캐시, 배열 수식과 정확한 셀 위치, 원본 바이트/hash·미변경 ZIP part 보존, 미설치/미지원/실행 실패/출력 한도와 package 밖 URI 거부를 확인했다. 기존 DOCX 및 MD/TXT·PDF/이미지 경로와 저장/CAS/권한/구 자료 호환 검사도 통과했다.
- 연결: 격리 가입·multipart XLSX 원본 등록 → 원본 hash 다운로드 → 실제 worker/Pandoc → 불변 변환 POST/응답 유실 GET 확인 → D-074 등록 → `WikiStore.save` 경로에서 단일 MD 저장을 확인했다. 보고의 전체 unit 위치·미독/경고와 MD 본문/first_markdown revision, 원본 재다운로드 바이트를 대조했다. 처음 추가한 위치 비교 시험은 서버 모델이 채운 null 필드 때문에 실패했고, 기존 report_body 정규형과 비교하도록 시험만 수정했다.
- 한계: 캐시는 재계산/최신성 확인하지 않는다. 캐시 누락은 계속 partial, 0/false/정상 빈 문자열은 누락과 구별하며 캐시 오류 값도 그대로 보존한다. 첫 채워진 행의 머리글 표현·숫자 서식/격자/병합/외부 객체의 정확한 재현, 전체 포함·의미 정확성, 실제 사용자 Excel/GUI/Windows/운영 서버는 미검증이다. 표와 셀 기록으로 본문 크기가 늘 수 있으며 기존 합산 4MiB/1,000단위 및 MD 1MiB 한도를 우회하거나 조용히 자르지 않는다. 운영 자료·원본·위키·이력·정책·토큰은 변경하지 않았다.

## 2026-10-29 — D-080 개인 Pandoc DOCX → 보존형 MD

- 변경: `core/client/source_conversion_pandoc.py`와 기존 formats 경로를 연결했다. DOCX 기본은 Pandoc의 단일 MD이며 부재/실패는 기존 python-docx 문자 추출로 전환하고 사유·실제 변환기·버전/옵션·미독을 보존한다. 기존 `docx_text/whole` 보고, 불변 source_ref, D-074 MD 등록/최초 판본 연결을 사용하며 서버 저장/HTTP/MCP 계약은 변경하지 않았다.
- 실제 검증: `core.tests.poc_analysis.test_source_conversion` **11개**, 기존 `test_registration` **11개**, 합계 **22개 통과**. 실제 Pandoc 3.13으로 한글/따옴표·표 순서·중첩/병합/여러 줄 표·각주·미주·검토 주석·삽입/삭제 마크업·이미지 참조를 확인했다. 격리 가입/API multipart 원본 등록 → hash 검증 다운로드 → 실제 개인 worker → 변환 POST → 저장 응답 유실 GET 확인 → 등록 → 기존 Wiki 저장과 first_markdown revision 연결을 확인했다. 원본 재다운로드 바이트·미독/경고·whole 위치를 대조하고 원본 중복 생성이 없음을 확인했다.
- 실패/보존: 미설치 대체와 좌표, Pandoc 시간/출력/종료 실패·진단 코드 보존, worker 취소/시간 초과, 원본 기준 변경 거부, MD/TXT CRLF 원문·XLSX 수식/캐시/셀 위치·PDF 기존 경로를 확인했다. 이미지 내용·머리말/꼬리말은 부분 상태다. 표본의 각주 XML을 유효한 다른 namespace prefix로 표현하면 Pandoc 3.13이 각주 본문을 경고 없이 누락하는 사례가 재현되어 해당 부분을 미확인/미독으로 표시했다. 최초 fixture의 주석 필수 author/date 누락은 fixture를 고쳐 재검증했다.
- XLSX 조사: 실제 `--list-input-formats`에 xlsx가 있지만 openpyxl 생성 표본에서 `Entry not found: xl//xl/worksheets/sheet1.xml`로 실패했다. 입력 지원 목록을 기존 수식/위치 계약의 보장으로 해석하지 않고 기존 XLSX 경로를 유지했다.
- 한계/미실행: DOCX 위치는 whole이며 문단/셀/물리 페이지 매핑이 없다. 이미지 파일은 추가 업로드/렌더/OCR하지 않고 원본 DOCX `word/` 상대 참조로 남긴다. 복잡한 표의 HTML 화면 렌더·임의 실문서 전체 포함·의미 정확도·GUI/Windows 실기기·Windows 패키징은 검증하지 않았다. 운영 data/·위키/이력·정책·토큰은 수정하지 않았다. 변환 성공은 `client_reported/reported_units_only/not_verified/not_run`이다.

## 2026-10-28 — D-073 원본·개인 자료 경로

- 변경: `core/common/storage_layout.py`, sources의 catalog/version/request 경로 선택·목록·공개·검증, personal의 서버 user ID 경로/구형 hash 경로 및 workflow 요청 호환. 새 원본은 `_sources/<id>/catalog.json`과 `versions/<version>/`, 새 개인 기록/요청은 `_personal/<userId>/`에 저장한다. 기존 자료는 위치와 바이트를 유지하며 명시 갱신 때도 선택된 구형 위치를 유지한다.
- 실제 검증: 저장 담당 suite **37개 통과**(명령/공통 검증 상세는 [documents HISTORY](../documents/HISTORY.md)). 분석 등록 suite **10개 통과**로 단일 원본→현재 MD→본문 기반 그래프와 새 개인 경로/요청 충돌 연결도 확인했다.
- 보존·실패: 원본 CRLF/hash/불변 판본·구형 actor 바이트 유지, 구형 catalog/원본/영수증 읽기 무변경, 양쪽 catalog/version·개인 record 중복 거부, 원본 hash 손상·개인 원장 손상·symlink 거부, 동시 원본 판본 CAS, 카탈로그 실패 후 원본/intent 보존과 재전송, 최종 영수증 실패 후 읽기 증거 확인, 다른 사용자 개인/요청 격리, 신·구 analysis request ID 충돌, 사용자/구형 경로를 합산한 기존 요청 수 제한 및 중단 중 원본을 포함한 판본 수 제한을 검증했다.
- 범위 밖/미실행: 실제 data/.local/사용자 CLI 설정이나 토큰은 수정하지 않았다. 운영 자동 이관·원본 전체 형식 재검증·실제 모델/OCR·Windows/운영 서버/최종 UI 검증은 수행하지 않았다. 이번 HISTORY는 삭제된 과거 시험/기록의 복구가 아닌 이번 작업의 신규 기록이다.

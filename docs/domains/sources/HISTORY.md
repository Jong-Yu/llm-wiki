# 원본 등록·보관 작업 기록

## Electron 원본 등록의 실제 API 연결 (2026-10-25)

- 서버의 기존 POST /sources·GET /requests와 저장/권한/불변 판본 계약을 그대로 사용합니다. 파일과 직접 입력의 전체 hash/크기 및 실제 본인 영수증을 main에서 대조하고 조정 대기·응답 유실 뒤 재POST하지 않습니다. 선택 관점과 mutation 기본 관점의 차이는 현재 소속/선택 수명 검사로 구분합니다.
- 실제 FastAPI의 격리된 tenant에 등록하고 목록/파일을 다시 읽는 Electron 검증을 실행했습니다. 손상된 성공 응답과 실제 완료 영수증 기록 실패, 수신 뒤 source_write 회수 및 원본 바이트 보존을 포함합니다. 자세한 화면/검증 결과는 [ui HISTORY](../ui/HISTORY.md)의 원본 등록 항목을 따릅니다. 기존 서버 API15검사는 이번에 반복 실행한 수치가 아닙니다.

## 미리보기의 명시적 관점 선택 (2026-10-25)

- 변경: SourceReadQuery를 추가하고 원본 상세·선택 판본 파일 GET에만 profile query를 허용했습니다. 기존 authorized 정책이 현재 허용 관점을 저장소 접근 전에 확인합니다. 기본 관점·원본 전체 바이트/hash/MIME·불변 판본·등록/쓰기 계약은 유지합니다.
- 실제 검증: 프로젝트 `.venv`의 `python -B -m unittest core.tests.api.test_sources_api -v`에서15개 중14개가 통과했습니다. 실행 환경의 포트 바인딩 제한으로 실행되지 못한 loopback1개는 같은 Python의 해당 검사만 승인된 실행으로 재검증해 통과했습니다. 허용 all/business, 금지/잘못된 관점의 저장소 생성 전 거부·추가 경로 query 거부·파일 바이트/기존 자료 보존과 기존 등록/판본/CAS/다운로드/20MiB/취소 경로를 확인했습니다. 화면 통합은 [ui HISTORY](../ui/HISTORY.md)가 관리합니다.
- 한계: 새 형식·원본 쓰기 UI·운영 권한 변경은 포함하지 않습니다. 이전 구현/전체 검증은 [이관 전 기록](../../history/2026-10-25-before-domain-split/PLAN.md#r1-원본-등록업로드-구현검증-2026-10-25)에 보존합니다.

## 2026-10-25 — DOCX·이미지 원본 보관 확장

- 변경: [D-054](DECISIONS.md#d-054--docx이미지의-불변-원본-보관과-개인-변환-보고-2026-10-25)에 따라 DOCX·PNG·JPEG·GIF·WebP·BMP·일반 TIFF를 기존 등록/판본/다운로드/영수증 흐름에 추가했습니다. `sources/contracts.py`의 형식/MIME 목록을 ingress·metadata·download·OpenAPI가 공유하며 새 `sources/formats.py`는 이미지 서명과 크기 제한된 DOCX 패키지 표식을 확인합니다. 서버 의존성은 추가하지 않았습니다.
- 변환 연결: `analysis_plans/schemas.py`의 위치 모델/`docx_text`와 `analysis_plans/store.py`의 conversion 형식별 method/location 대조만 확장했습니다. 문단/본문 블록 범위, 별도 DOCX table/row/column, 이미지 프레임/페이지와 부분·미독 보고를 유지합니다. 보고/계획은 `client_reported`, `reported_units_only`, `not_verified`, `not_run`을 보존합니다. 온톨로지 의미·모델 프롬프트는 변경하지 않았습니다.
- 공통 통합: 신규 검사에서 `/documents`의 이전 형식 Literal 때문에 `response_invalid`500이 발생했습니다. 공통 담당 fastapi_4가 `core/api/v1/documents/schemas.py`의 형식을 확장하고 `core/modules/analysis_jobs/commands.py`에서 모든 비텍스트 원본에 변환 계획 인계를 요구하도록 반영했습니다. 소유 파일 외 변경은 인계 패치로 전달했으며 반영 후 실제 API 검사를 통과했습니다.
- 신규 검증: `.venv/bin/python -B -m unittest core.tests.modules.test_source_formats -v` **8개**, `core.tests.api.test_source_formats_api -v` **5개 통과**. 작은 생성 DOCX/PNG와 고정된 생성 이미지 fixture로 실제 원본 바이트·hash·크기·MIME·대소문자 확장자·안전한 이름·잘못된 서명/ZIP/DTD/크기·이전 판본/CAS·동시 동일 요청·현재 권한/profile·카탈로그/영수증 실패 보존을 확인했습니다. ASGI 요청 취소로 응답 유실을 주입한 뒤 본인 영수증에서 완료를 확인했으며 재저장하지 않았습니다. DOCX 표/문단 및 이미지 페이지 보고의 위치와 계획 선택, 잘못된 방법/위치·미독 완료 주장 거부도 포함합니다.
- 기존 회귀: `.venv/bin/python -B -m unittest core.tests.modules.test_sources core.tests.modules.test_source_catalogue core.tests.api.test_sources_api core.tests.api.test_sources_ingress core.tests.api.test_analysis_plans_api -v`의 **52개 중51개 통과**. 실제 loopback1개는 sandbox 포트 바인딩 제한으로 미실행되어, 승인된 같은 Python의 `core.tests.api.test_sources_api.SourceApiTests.test_actual_loopback_chunked_multipart_and_download -v`로 별도 실행해 **통과**했습니다. 이 실제 HTTP 검사는 격리 임시 tenant/정책에서 TXT·DOCX·PNG의 chunked 업로드·정확한 다운로드/MIME/hash·본인 영수증을 확인합니다. 최종 고유 검사 **65개 통과**이며 전체 제품 회귀를 실행했다는 뜻은 아닙니다.
- 한계/미실행: 이미지 식별은 전체 디코딩이나 악성 파일 검사가 아니며 DOCX 본문 전체 유효성도 검증하지 않습니다. 실제 개인 PC 변환/OCR·의미 정확도·Electron 전체 E2E·Windows/WSL2·운영 배포는 이 세션에서 검증하지 않았습니다. 개인 변환기는 fastapi_3, 공통 Python 통합은 fastapi_4, 화면 통합은 ui_7의 기록을 따릅니다. 운영 자료·원장·토큰·권한은 변경하지 않았습니다.

## 2026-10-26 — OCR 회전·한국어 품질 보완

- 변경: `source_conversion_formats.py`에 공유 40초 안의 OSD 방향 후보·조각난 문장 PSM 6 후보 비교, PDF 300 dpi 목표와 기존 픽셀 상한, TSV 신뢰도/미독 진단을 추가했습니다. EXIF·PDF 메타데이터·적용 방향·분할 모드를 페이지/프레임별로 기록하고, 원본 바이트·선택한 OCR 문자열·변환 offset 의미를 보존합니다. 전체 로컬 처리 이력과 기존 서버 경고 100항목 상한을 구분하며 새 서버/의존성/권한 계약은 없습니다.
- 실제 Tesseract 5.5.3 `kor+eng` 비교: 17개 입력의 수정 전/후 실행. 이전 회전 PDF의 첫 페이지 공백 제외 59자 편집 거리 `70→0`, 회전 PNG `18→7`; 새 한글 가로·90/180/270도 PNG 및 PDF는 `71/86/86/74/72→0`. 2단 PDF는 `42→28`이나 열 우선 읽기 순서는 계속 실패했습니다. 빈 이미지·빈 TIFF 프레임은 미독 상태를 유지했습니다.
- 별도 공개 문서: [국가데이터처 한국의 사회동향 2025](https://mods.go.kr/boardDownload.es?bid=246&list_no=442587&seq=6)의 물리 2·3쪽과 별도 회전본만 평가했습니다. 고정 발췌 3개 비교는 정상 `28/0/0→25/0/0`, 회전 `23/0/3→25/0/0`으로 **일부 구간은 악화**했습니다. 목차·영문/한글 오인식은 남아 있으며 낮은 신뢰도 목차를 partial로 표시합니다. 발췌 거리·생성 표본 통과를 원문 전체 정확도로 확대하지 않습니다.
- 검증: 변환 전용 두 unittest 모듈 **36개 통과(5.549초)**. 초기 sandbox의 ps/localhost bind 2개 실행 제한을 승인된 범위 재실행으로 확인했습니다. 실제 취소는 완료 프레임 1개·처리 이력을 보존하고 관측한 OCR 자식을 종료했으며, 2.5초 전체 시간초과는 완료 프레임 3개를 보존했습니다. 실제 worker + 격리 ASGI 공개 회전본의 저장 영수증·재조회 revision·동일 문자열·페이지·방향 경고와 원본 hash도 확인했습니다.
- 근거·한계: [전체 비교·원시 결과·재현 방법](../../../evals/ocr_rotation_korean_20261026/REPORT.md). 중간 구현의 새 한글 PDF 악화 `72→75`도 개발 기록에 남겼습니다. 독립 일반 정확도 평가, 문자 좌표, arbitrary skew/세로 쓰기/다단 읽기 순서, Windows/WSL2·운영 HTTPS·서명·Finder 앱 OCR은 검증하지 않았습니다. 공통 Python 회귀는 fastapi_9, 앱 통합은 기존 ui_11에 로컬 handoff로 전달했습니다.

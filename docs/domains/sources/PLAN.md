# 원본 등록·보관 계획

## 현재 상태

### 2026-11-06 — 원본 목록 metadata 증분 관측

[D-101](../documents/DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06)의 저장 전 변경 기록을 연결했습니다. 명시 추적 모드의 반복 목록/통합 요약은 카탈로그 metadata 탐색을 생략하고 기존 현대 카탈로그 변경만 확인합니다. 신규·구형 목록 변경·이상·기록 유실·주기 확인은 전체 검사로 복귀합니다. 기존 hash/cursor 때문에 변경 목록의 전체 JSON hash는 남습니다. [격리 검증](HISTORY.md#2026-11-06--변경-기록에-따른-원본-metadata-증분-관측)과 [운영 상태](../platform/PLAN.md)를 따릅니다.

### Pandoc 없는 DOCX·XLSX 변환 (2026-11-03, [D-095](../platform/DECISIONS.md#d-095--pandoc-사용-중단과-문서-변환의-대체-2026-11-03))

라이선스 부담으로 Pandoc을 쓰지 않습니다. DOCX는 `python-docx`로 문단·표 셀을 본문 순서대로 읽어 문단 번호·표 좌표로 보고하고, XLSX는 원본 구조 기록과 `openpyxl` 셀 기록(수식·캐시·정확한 위치)만 보존합니다. 이전에 Pandoc이 만들던 DOCX의 단일 Markdown(제목·목록·표·각주·주석·변경 추적)과 XLSX의 읽기용 표 보기는 더 이상 만들지 않으며, 각주·주석·머리말·변경 추적·표 안의 표는 미독으로 표시합니다. 이미 등록된 보고의 `converter=pandoc` 기록은 그대로 보존합니다. 병합 범위 안 기준셀이 아닌 칸의 값은 계속 부분 상태로 알립니다. 아래 Pandoc 절은 당시 상태입니다. 실제 검증과 한계는 [HISTORY](HISTORY.md)를 따릅니다.

### Pandoc DOCX·XLSX 변환 (2026-10-29, D-095로 대체됨)

개인 변환기는 준비된 Pandoc을 DOCX MD와 XLSX 표에 사용하며 부재/실패 시 기존 읽기·사유·미독을 보존합니다. XLSX의 경로/문자열/수식 손실과 병합·표 경계 누락, 첫 설명 행의 머리글 오해석을 원본 불변의 작업 사본으로 보완했습니다. 생성 열 이름과 원래 셀 주소, 병합 기준셀/범위/포함셀 참조, 명시 Excel 표/집계·숨김 범위를 MD에 보존합니다. 정확한 cells 위치의 값·수식·원시 캐시/종류/속성은 별도 기록으로 유지하며 재계산하지 않습니다.

복잡 표의 실제 Markdown→HTML 셀 연결과 원본 XML, 원본 판본/hash·영수증 응답 유실·최초 MD 판본 연결을 실제 worker/Pandoc·격리 API로 대조했습니다. 부재/실패/한도/모호한 병합에서도 원본 구조와 셀 기록을 보존합니다. DOCX의 문단/물리 페이지 매핑, 이미지 내용·원래 XLSX 서식의 표시 결과/시각적 병합 배치/외부 객체·임의 문서 전체 포함/의미 정확도는 미검증입니다. 계약은 [D-080의 병합·복잡 표 후속 검증](DECISIONS.md#병합복잡-표-후속-검증-2026-10-29), 실제 결과와 Windows 한계는 [HISTORY](HISTORY.md)를 따릅니다.

여러 시트의 순서/ID/part 연결·정확한 이름·전역/지역 이름 범위와 시트별 원문/캐시를 원본 XML·렌더 결과·MD 판본으로 대조했습니다. 공백 차이가 있는 시트명은 번호+인용 원명으로 구별하며 namespace 별칭은 작업 사본에서 보완합니다. 의미를 구분하는 색/서식 출처와 행 높이/열 너비·조건부 서식 선언은 보존합니다. 원래 표시 결과의 계산·Excel 화면 재현은 추가하지 않습니다. 계약은 [여러 시트·서식 출처](DECISIONS.md#여러-시트서식-출처-후속-검증-2026-10-29)를 따릅니다.

2026-10-28 D-073 저장 담당 구현과 격리 검증을 완료했습니다. 새/옛 원본·개인 경로를 읽기만으로 이관하지 않으며 중복 위치·손상·동시 실패에서 기존 자료를 보존합니다. 실제 결과는 [HISTORY](HISTORY.md)를 따릅니다. `core.common.storage_layout`은 Path만 계산하며 폴더를 만들지 않습니다.

- `personal_root(root,user_id)` → `_personal/<user_id>`; 사용자 ID는 기존 정책과 호환되는 `[a-z][a-z0-9_-]{0,63}` 또는 서버 UUID hex입니다.
- `source_root(root,source_id)` → `_sources/<source_id>`; `source_version_root(root,source_id,version_id)` → 그 아래 `versions/<version_id>`.
- `analysis_job_root(root,user_id,job_id)` → `_personal/<user_id>/analysis/<job_id>`; `analysis_request_root(root,user_id)` → `_personal/<user_id>/_requests/analysis`.
- `knowledge_root(root,kind)` → `_knowledge/<kind>`; kind는 graphs/reviews/correspondences만 허용합니다. source/version/job ID는 32자리 소문자 hex입니다.
- 새 원본 catalog는 `_sources/<id>/catalog.json`, 원본은 versions 아래입니다. 기존 `_registrations/<id>.json`과 `_sources/<id>/<version>`은 그 위치에서 호환 읽기/쓰기합니다. 같은 ID가 양쪽 위치에 있으면 내용이 같아도 충돌로 거부하며 자동 이관하지 않습니다.
- 새 source 요청은 `_personal/<user_id>/_requests/sources/<기존 request_key>.json`입니다. 구형 요청을 호환 조회하고 새/옛 analysis 요청 공간도 함께 중복 검사합니다. 다른 담당은 `_request_path`를 재사용할 수 있습니다.
- 개인 자료는 새 user ID 경로에 생성하고 기존 해시 사용자 경로는 자료별 호환 조회/갱신합니다. 같은 자료가 양쪽에 있으면 중단합니다. 과거 actor는 다시 쓰지 않고 새 actor의 선택 access_revision을 허용합니다. 기본 프로필의 domain/viewpoint null도 보존합니다.


원본 보관 API는 UTF-8 MD/TXT·직접 입력과 PDF·XLSX·DOCX·PNG·JPEG(`jpg/jpeg`)·GIF·WebP·BMP·일반 TIFF(`tif/tiff`)를 지원합니다. 바이너리는 multipart 파일로만 받으며 실제 바이트/hash·불변 판본·현재 권한·CAS·영수증을 유지합니다. DOCX는 제한된 OOXML 식별 표식, 이미지는 파일 서명을 확인하고 원본을 변환하거나 재인코딩하지 않습니다. 한도는 원본20MiB·요청24MiB이며 서버 OCR/전체 이미지 디코딩·변환 정확도 검증은 수행하지 않습니다.

개인 PC가 보고한 변환 본문과 미독 구간은 원본 판본에 별도 연결합니다. DOCX의 `docx_text`와 문단/본문 블록/표·행·열 위치, 이미지의 `ocr`와 프레임/페이지 위치를 기존 변환 보고 모델에 추가했습니다. 보고된 위치·문자의 원본 전체 포함 여부와 의미 정확도는 미검증 상태로 유지합니다. 실제 검증과 공통 목록/분석 연결 상태는 작업 기록 (정리로 삭제된 참고 자료)에 둡니다.

로컬 OCR은 EXIF/PDF 회전 처리 이력, 제한된 방향·문장 분할 후보 비교와 신뢰도 경고를 보존합니다. PDF는 기존 픽셀 상한 안에서 300 dpi를 목표로 읽으며 낮은 신뢰도 텍스트도 미독 범위와 함께 보존합니다. 회전·한글 생성 표본은 개선됐지만 공개 문서의 일부 구간 악화·목차/2단 읽기 순서·한국어/영문 오인식이 남았습니다. 정확도나 원본 전체 포함으로 승격하지 않으며 비교 보고 (정리로 삭제된 참고 자료)와 실행 기록 (정리로 삭제된 참고 자료)을 따릅니다.

Electron에서 실제 원본 등록 POST·본인 영수증 GET·완료 뒤 목록/미리보기까지 연결했습니다. 서버 저장/권한/불변 판본 계약은 변경하지 않고 현재 source_write·전송/응답 hash·완료/조정 대기/응답 유실을 확인합니다. 이번 실제 HTTP 쓰기 통합 검증은 ui HISTORY (정리로 삭제된 참고 자료)의 원본 등록 항목이 관리합니다.

R1 원본 등록·새 불변 판본·원본/통합 목록·다운로드·본인 요청 확인이 구현됐습니다. 최초 UTF-8 md/txt 파일·직접 입력 범위에서 원본 API15검사가 통과했고 이후 바이너리 확장은 위 기록을 따릅니다. 상세/파일 GET은 허용 profile query를 지원합니다. 이전 전체 검증 기록은 아래 근거에 보존하며 화면 미리보기의 현재 범위/검증은 [ui PLAN](../ui/PLAN.md)이 관리합니다.

### 분석 담당 추가 인계

원본 내부 직접 경로 대신 `SourceStore._version_path(source_id, source_version)`를 사용하면 새/옛 판본 위치와 중복 충돌을 일치시킬 수 있습니다. `_catalog_path(source_id)`도 새/옛 카탈로그를 검증하며, `_request_path(tenant,user_id,request_id)`는 새/옛 source 영수증 경로를 반환합니다. 원본 상세와 다운로드의 기존 DTO/registration_revision/hash는 바꾸지 않습니다. source actor는 기존 필드와 선택 access_revision/display_name을 허용하며 과거 원장은 그대로 읽습니다.

## 다음 요청에서 확인할 범위

저장 담당 범위는 완료했습니다. 작업 접수·CLI 원본 인계의 실제 모델 검증은 [analysis](../analysis/PLAN.md), 등록·판본·변환 화면의 최종 통합은 [ui](../ui/PLAN.md)에서 관리합니다. 운영 자료 자동 이관이나 실제 data/.local 변경은 수행하지 않았습니다. 원본/작업의 같은 사용자 request_id 충돌, 전체 tenant 요청 수 제한, 미완료 카탈로그의 원본까지 포함한 판본 수 제한을 유지합니다.

## 완료 조건

D-043의 불변 보관·요청 영수증·용량/동시성·실패 경계와 권한을 유지합니다. 상세/파일의 선택 관점은 저장소 접근 전에 확인하며 미리보기 때문에 기존 원본/판본을 수정하지 않습니다.

## 근거와 기록

- [적용 결정](DECISIONS.md)
- 실제 검증과 한계 (정리로 삭제된 참고 자료)
- 이관 전 검증/계획 원문 (정리로 삭제된 참고 자료)
- 과거 시험 수는 당시 기록입니다. 이번 문서 이관에서 제품 시험을 재실행한 결과가 아닙니다.

## 이후 작업 기록

이후 완료한 작업은 별도 `HISTORY.md`에 실행한 검증과 한계를 짧게 추가하고, 위 현재 상태는 교체합니다. 이력이 생길 때 파일을 만들며 현재 상태에 과거 일지를 누적하지 않습니다.

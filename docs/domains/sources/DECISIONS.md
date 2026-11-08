# 원본 등록·보관 결정

## D-080 — 개인 PC의 Pandoc 기본 DOCX 변환과 기존 보고 호환 (2026-10-29)

> 2026-11-03 [D-095](../platform/DECISIONS.md#d-095--pandoc-사용-중단과-문서-변환의-대체-2026-11-03)로 Pandoc 사용이 중단되어 이 결정의 변환 방식은 대체되었습니다. 아래는 당시 기록이며, 이미 등록된 보고는 그대로 보존합니다.

사용자가 선택한 Pandoc을 현재 등록 형식 중 DOCX의 기본 Markdown 변환기로 사용합니다. 개인 실행기의 PATH, 없으면 프로젝트 `.local/pandoc`(Windows `.exe`)을 사용하고 버전·실제 입출력 형식·준비 상태를 진단합니다. 준비되지 않았거나 변환에 실패하면 기존 python-docx 경로를 사용하며 사유·실제 변환기를 기록합니다. 실행 실패 뒤의 대체 문자 추출을 완전 변환으로 표시하지 않습니다.

- 표·각주·미주·검토 주석과 삽입/삭제 마크업을 한 Markdown에 보존하도록 `wrap=none`, `track-changes=all`, smart 문자 치환 해제를 사용합니다. 단순 표는 pipe table, 복잡한 표는 HTML로 남길 수 있습니다. 변환기는 개인 worker 안에서만 실행하며 서버는 실행하지 않습니다.
- 불변 보고의 기존 `method=docx_text`, `location.kind=whole`과 D-074 등록을 재사용합니다. 실제 Pandoc 버전·writer·추적 옵션은 로컬 execution과 서버 warnings로 전달합니다. MD를 문단별로 분할하지 않으므로 각주 정의/표 순서가 유지되며 문단·셀·물리 페이지 매핑은 제공하지 않습니다.
- 이미지 참조는 원본 DOCX의 `word/` 아래 package 경로입니다. 별도 파일을 임시 경로에 추출한 뒤 영구 참조로 제출하지 않습니다. 이미지 내용·머리말/꼬리말·객체·알려진 미확인 구간은 미독으로 남기며, Pandoc 경고도 보존합니다. `client_reported/reported_units_only/not_verified/not_run` 의미는 유지합니다.
- MD/TXT의 원문 보존, PDF·이미지의 기존 추출/OCR은 유지합니다. 최초 조사에서 Pandoc 3.13의 XLSX 파싱 실패가 재현되어 기존 수식·캐시값·셀 좌표 경로를 유지했으며, 같은 날 사용자의 추가 요청에 따라 아래 XLSX 후속 적용으로 확장했습니다. 다른 형식 등록 확대는 이번 범위가 아닙니다.
- 원본 바이트/hash·불변 판본·변환 보고 영수증·기준 판본 검증과 `WikiStore.save()`/CAS를 재사용합니다. 원본·위키·전체 이력의 자동 재작성/정리는 없습니다. 설치·실제 검증·남은 한계는 [HISTORY](HISTORY.md)에 기록합니다.

이유: 기본 등록 MD에서 표·주석·문서 구조를 더 보존하면서 현재 원본/보고/저장 계약과 실패 시 기존 문자 추출 경로를 유지하기 위해서입니다.

### XLSX 후속 적용 (2026-10-29)

- 원인은 Pandoc 3.13 XLSX reader가 workbook 관계의 절대 package 경로 앞에 `xl/`을 추가하는 것이었습니다. 또한 inline 문자열과 수식 자체를 읽지 않고 숫자 캐시를 부동소수로 표시하므로 경로 수정만으로 보존을 보장할 수 없습니다.
- 원본을 openpyxl로 다시 저장하지 않습니다. 기존 reader가 관측한 셀 기록과 원본 XML의 수식·캐시 원문/종류·배열/공유 수식 속성을 보존하고, 임시 사본에만 관계 경로를 정규화하고 좌표가 표시된 shared string 보기를 만듭니다. 이 사본은 재계산/원본 교체용이 아닙니다.
- 실제 `--from=xlsx` Pandoc 표를 `xlsx_values/whole` 단위로, 정확한 기존 `cells` 위치의 셀 기록을 별도 단위로 같은 불변 보고/단일 MD에 함께 저장합니다. 문자열의 줄바꿈·Markdown 기호와 원시 캐시는 셀 기록의 코드 블록에도 보존합니다. 두 표현을 별도의 원본 사실로 중복 해석하지 않도록 warnings에 남깁니다.
- 캐시 0/false/빈 문자열과 누락을 구별합니다. 누락·지원 실패·한도 초과는 미독/대체 사유와 기존 셀 기록을 보존합니다. 원본 판본/hash·보고 영수증·CAS·최초 MD 연결은 기존 계약을 사용하며 서버 변환/새 스키마를 추가하지 않습니다. Pandoc 준비 여부는 실제 형식별로 진단합니다.
- 최초 XLSX 경로의 첫 채워진 행 머리글 처리와 병합/표 경계 누락은 아래 후속 검증에서 수정했습니다. 원래 숫자 서식/셀 크기·시각적 병합 배치·외부 객체의 의미와 전체 포함은 미검증으로 남깁니다. 실제 검증은 [HISTORY](HISTORY.md)를 따릅니다.

### 병합·복잡 표 후속 검증 (2026-10-29)

- 원본 OOXML의 병합 범위/기준셀/값 유무, Excel table의 이름·범위·열/집계/명시 수식 속성, 숨김 행/열/시트를 같은 MD의 구조 기록에 보존합니다. 값과 수식/캐시는 기존 정확한 cells 단위를 유지합니다. 반복되는 이름이나 근접한 셀만으로 머리글·표 관계를 추정하지 않습니다.
- `xlsx_cell_records_v2` 입력 보기는 생성한 Excel 열 문자만 머리글로 쓰고 원본 행은 데이터로 전달합니다. 원래 좌표 표기는 유지하며, 병합에 포함된 빈 칸에는 기준셀/범위 참조만 표시합니다. 원본 ZIP·실제 셀 값을 수정하거나 병합 영역에 값을 복사하지 않습니다. Pandoc 표와 실제 HTML 표 셀의 시트/주소/값·수식/캐시 연결을 원본 XML과 대조합니다.
- 빈 기준셀은 빈 상태로 기록하고, 실제 비기준셀에 저장된 값/수식은 덮어쓰지 않고 모호한 상태로 보고합니다. 겹친 병합·구조 판독 실패·참조 확장 한도는 partial/미독으로 남깁니다. Pandoc 부재/실패에도 읽은 원본 구조와 셀 기록을 보존하며 기존 합산 한도를 유지합니다.
- 합성 복잡 표·다단 헤더·공유/병합 기준셀 수식·두 Excel 표·숨김 자료·열 이름 경계와 실제 등록/MD 판본 연결의 검증 결과는 [HISTORY](HISTORY.md)를 따릅니다. 시각적 셀 병합/서식의 완전 재현과 사람의 의미 판단을 완료한 것으로 표시하지 않습니다.

### 여러 시트·서식 출처 후속 검증 (2026-10-29)

- 시트의 원본 순서·ID·관계 ID/part 경로·공백을 포함한 정확한 이름과 hidden/veryHidden/빈 시트, 전역/시트별 definedName 원문/범위를 MD 구조에 보존합니다. 같은 주소/이름이 반복돼도 시트 이름을 정규화하거나 하나로 합치지 않습니다. 시트 간/3D/이름 수식은 원문/캐시를 보존하고 계산하지 않습니다.
- Pandoc의 생성 sheet-N 머리글을 원본 시트 순서와 대조해 시트 번호+JSON 원명으로 표시합니다. 개수/순서가 맞지 않으면 표 연결을 추정하지 않고 기존 구조/셀 기록의 부분 결과를 보존합니다. Pandoc이 관계 namespace 별칭에 의존해 실패하는 경우에는 임시 workbook 사본에서만 r:id 표기를 정규화합니다.
- 색만으로 상태를 구분하는 원본이 있어 서식 출처 보존은 필요하다고 판단했습니다. 실제 셀의 style 참조, 사용한 xf/font/fill/border와 숫자 형식·색상/테마/팔레트, 행 높이/열 너비·조건부 서식 원문을 MD에 보존합니다. 색의 업무 의미나 조건부 표시 결과를 자동 판단하지 않습니다.
- 문서 등록/분석의 근거 보존에는 위 구조·서식 출처가 우선이며 Excel 화면의 픽셀 단위 재현은 필수로 보지 않습니다. 새 화면 렌더러/서버 Office 실행/의존성을 추가하지 않고 실제 검증/남은 한계는 [HISTORY](HISTORY.md)에 기록합니다.

## D-073 — 원본 판본 보관과 관련 저장 폴더 통합 (2026-10-28)

상태: 사용자 승인, 구현 시작. 현재 저장 위치를 유지하며 기존 자료 삭제·운영 자동 이관은 수행하지 않습니다.

- 인증 정보는 `.local/tenancy/`, 업무 자료는 `data/<workspaceId>/`로 분리합니다. 동일 서버의 외장 SSD 연결과 자료 루트 이동은 나중에 서버 설정으로 다룹니다.
- 자료 루트의 공개 구조는 `wiki/`, `_history/`, `_sources/`, `_knowledge/`, `_personal/`로 모읍니다. 잠금·요청 확인 등 보존에 필요한 내부 파일까지 임의 삭제하는 뜻은 아닙니다.
- `_sources/<sourceId>/catalog.json`에 판본 목록을, `versions/<versionId>/original`과 `manifest.json`에 불변 원본·파일명·형식·크기·해시·등록자를 보관합니다. 기존 source ID/version과 MD의 대응을 유지하며 같은 파일명이라는 이유로 합치지 않습니다.
- `_knowledge/graphs/<documentId>.json`, `reviews/<documentId>.json`, `correspondences/<id>.json`로 현재 그래프·검토 원장·문서 간 대응을 묶습니다. 그래프와 전문가 원장의 의미·근거·판본 연결은 각 소유 도메인이 유지합니다.
- 개인 자료는 `_personal/<userId>/` 아래 analysis, conversations, question-runs, saved-results, result-drafts, comparisons, _requests로 분류합니다. userId는 서버가 발급·검증한 안정 ID이며 이름이나 임의 입력 경로가 아닙니다.
- 기존 `_registrations`, 해시 사용자 폴더, `_ontology`, `_reviews`, `_jobs` 등은 호환 읽기 또는 검증된 이관 경로를 제공합니다. 원본·문서 전체 이력·검토 원장을 삭제·초기화하지 않으며 충돌·중단 시 기존 자료를 보존합니다. 새 폴더와 옛 폴더가 동시에 존재하면 모호한 상태를 조용히 합치거나 덮어쓰지 않습니다.

이유: 원본·문서·지식·개인 작업의 소유와 용도를 폴더만으로 구별하고 이후 저장 위치를 변경하기 쉽게 만들기 위해서입니다.

현재 구현 상태는 [PLAN](PLAN.md), 작업 시 지킬 상세 규칙은 도메인에 연결된 RULES를 따릅니다. 결정 번호·이유와 상세 계약을 보존합니다. 아래 결정 안의 날짜·시험 수·운영 상태는 기록 당시 값이며, 최신 구현 상태는 PLAN을 우선합니다. 필요한 D 번호·하위 절만 읽습니다.

### D-042 — 첫 업무 자료의 선정·등록 범위와 최소 쓰기 권한 (2026-10-24)

첫 실자료 등록과 운영 정정의 기록입니다. 원문·히스토리·검토 원장을 보존하며 최소 쓰기 권한과 회수를 구분합니다. 최신 등록 기능은 D-043을 따릅니다. [D-042의 후속 스키마 계약](../ontology/DECISIONS.md#후속-스키마-계약--d-042-발췌)은 ontology에서 찾습니다. 과거의 대상별 정정안·평가·승인 대기 상태는 현재 사실로 자동 이식하지 않습니다.

기존 D-042 전체 기록 (정리로 삭제된 참고 자료)

### D-043 — 원격 문서 등록과 개인 CLI 분석·MCP 저장·UI 결과 연결 (2026-10-24)

상태: **사용자가 합의한 흐름의 상세 설계와 R1 첫 읽기·원본 등록 구현**입니다. Electron 내부 터미널의 로그인된 CLI를 유지하며, **Electron은 일반 HTTP API로 원본을 업로드하고 목록·결과를 조회하고, 개인 CLI는 MCP로 공통 지침·파일 참조를 받아 파일을 읽고 본문·온톨로지를 추출해 저장**하는 것을 목표로 합니다. 하나의 위키 백엔드가 `/api/...`와 `/mcp`를 함께 제공하고 같은 인증·권한 정책·자료 서비스·저장 모듈을 사용합니다. 첫 네 읽기와 원본 등록/판본/다운로드/요청 확인은 구현·검증했습니다. 새 MCP 도구·분석 작업·추출물과 화면 연결은 후속 계약입니다. 운영 read13 변경, 새 권한 부여, 원본 이관, 서버 배포 또는 5단계 업무 기능 착수는 포함하지 않습니다. 현재 연결/자료는 [D-041]·[D-042], 터미널 기술 기준은 [D-033]을 유지합니다.

2026-10-24 사용자 보완 결정: 앞선 서버 `source_prepare` 중심의 파일 변환 설계를 **개인 CLI의 파일 읽기·변환·AI 본문 구성**으로 바꿉니다. 이유는 개인 로그인 AI를 활용하는 실행 주체와 파일 해석을 일치시키고, Electron의 일반 화면 조회를 AI 세션/MCP 호출에 의존시키지 않기 위해서입니다. 위키 백엔드는 원본·지침·추출물·결과를 보관/제공하고 제출을 검증하며 AI를 별도로 호출하지 않습니다. 이번 개정은 문서 설계이며 기존 UI 시안의 실제 일반 API/CLI 연결을 검증했다는 뜻이 아닙니다.

여러 사용자의 CLI가 받는 공통 추출 지침·스키마·맥락과 그 불변 버전은 [D-044]를 따릅니다. 아래 작업 입력·저장 래퍼·영수증에 단계별 입력 묶음을 연결하며 규약/맥락 계약을 이 절에 중복 정의하지 않습니다.

#### FastAPI 백엔드 채택과 구현 경계 (2026-10-24)

상태: **2026-10-25 사용자 구현 요청으로 R1 첫 네 읽기 API와 단일 ASGI 결합을 구현·검증했습니다. R1 전체는 진행 중이며 운영 전환은 실행하지 않았습니다.** Python을 유지하고 일반 API에 얇은 FastAPI 계층을 추가해 기존 MCP ASGI 앱과 하나의 Uvicorn 프로세스에서 제공합니다. 초기 구성은 worker 1개이며 일반 API와 개인 CLI의 MCP가 같은 인증·tenant 정책·업무 서비스·파일 저장 모듈을 사용합니다. 첫 구현의 정확한 계약은 다음 절을 따릅니다.

| 비교한 구성 | 재사용·유지보수 판단 | 결정 |
| --- | --- | --- |
| 기존 Python·Starlette 확장 | 추가 프레임워크 없이 기존 ASGI와 저장 모듈을 재사용할 수 있지만, 늘어날 일반 API의 요청·응답 검증과 문서 계약을 직접 연결해야 함 | 가능한 대안으로 검토 |
| Python·FastAPI 추가 | 기존 Starlette·Pydantic·MCP·저장 모듈을 재사용하면서 요청·응답 모델과 OpenAPI로 Electron 계약을 관리. 새 의존성·HTTP 오류 매핑·lifespan 합성 검증이 필요 | **채택** |
| 별도 Node/TypeScript 백엔드 | Python 내부 서비스 호출이나 저장·권한 이식이 필요하고 두 런타임의 배포·장애 경계가 늘어남 | 현재 도입하지 않음 |

선택 이유는 일반 API의 규모에 맞는 계약 관리와 기존 Python 보존 로직의 재사용입니다. FastAPI의 검증·OpenAPI 기능은 [공식 기능 안내](https://fastapi.tiangolo.com/features/), MCP의 기존 앱 합성은 [공식 ASGI 안내](https://py.sdk.modelcontextprotocol.io/run/asgi/)를 근거로 삼았습니다. 프레임워크가 tenant 권한·CAS·영수증·의미 정확도를 대신 보장하는 것은 아닙니다.

조사 당시 설치 환경은 Python 3.12.14, MCP 2.3.0, Starlette 1.9.0, Uvicorn 0.54.0, Pydantic 2.14.1이며 FastAPI는 미설치입니다. [requirements.txt](../../../requirements.txt)는 MCP와 Markdown 파서만 직접 고정합니다. [FastAPI 0.162.0의 공식 의존성 선언](https://raw.githubusercontent.com/fastapi/fastapi/0.162.0/pyproject.toml)과 설치 메타데이터를 대조했을 때 기존 주요 버전은 요구 범위에 들며 기본 의존성 중 FastAPI와 annotated-doc가 추가로 필요합니다. 이는 **선언상 호환성 조사**이며 설치·결합 실행 통과나 최종 고정 버전의 확정이 아닙니다. [MCP 2.3.0의 공식 의존성](https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/v2.3.0/pyproject.toml)과 함께 구현 시 검증할 조합을 정합니다.

```text
Electron 화면 → 제한된 preload → main HTTP client → /api/v1
Electron main → 사용자 PC의 PTY → 개인 로그인 CLI → /mcp
                                                   ↓
                  단일 ASGI 앱 → 공통 인증·업무 서비스 → 같은 tenant 저장소
```

- 앱 조립·전송: FastAPI 루트가 일반 API 라우트와 기존 MCP 앱을 합성합니다. `/api/v1` 라우트 뒤에 내부 기본 경로 `/mcp`인 MCP 앱을 루트 mount로 배치해 외부 `/mcp`를 유지하는 방식을 기준으로 합니다. 부모 lifespan이 MCP session manager를 정확히 한 번 시작·종료하며 하위 lifespan의 자동 실행이나 `/mcp/mcp` 경로를 전제하지 않습니다. 기존 stdio 계약도 유지합니다.
- 공통 서비스: [MCP 도구](../../../core/mcp/tools)와 [응답 포장](../../../core/mcp/results.py) 아래에서 필요한 업무 함수를 분리하고, HTTP/MCP 어댑터가 같은 결과·도메인 오류를 각 전송 형식으로 표현합니다. 공통 검색은 [문서 서비스](../../../core/modules/documents/search.py)로 분리했습니다. 일반 API를 임의 MCP 도구 실행 프록시로 만들지 않습니다. HTTP 모델·OpenAPI에는 현재 구현한 범위만 공개하고 필드 누락·추가·타입 변환과 오류 의미를 계약으로 검증합니다.
- 접근·조회: 양쪽 모두 [AccessPolicy](../../../core/modules/access/policy.py)의 현재 사용자·tenant·행동·허용 profile 검사를 자료 접근 전에 수행합니다. HTTP 입구 인증·Host/Origin 보호와 각 업무 동작의 인가를 분리하며 FastAPI dependency가 mount된 MCP까지 자동 보호한다고 가정하지 않습니다. 본문은 [WikiStore](../../../core/modules/documents/store.py), 현재 유효 지식은 [ReviewStore.query()](../../../core/modules/reviews/store.py)를 재사용합니다. `effective_graph/policies`·미검토·pending·출처/버전을 보존하고 [OntologyStore](../../../core/modules/ontology/store.py)의 machine층으로 전문가 판단을 대신하지 않습니다.
- 저장·실행: 기존 파일 저장·CAS·전체 본문 이력·검토/정책 원장을 유지합니다. 신규 원본·카탈로그·추출물·작업/영수증은 아래 D-043 저장 계약, 고정 입력과 저장 임계구역은 D-044를 따릅니다. 서버는 개인 AI·로컬 변환기를 실행하지 않습니다. 동기 저장·정책 조회는 제한된 작업 스레드 경계에서 처리하며, 기존 MCP SDK의 동기 도구 실행도 이미 스레드를 사용한다는 점을 보존합니다.
- 전송·운영: 기존 MCP의 JSON·stateless·8 MiB 요청 계약과 별개로 파일 API의 스트리밍·실제 바이트·형식·누적 한도를 구현합니다. 초기 폴링과 단일 서버의 영속 로컬 파일 저장으로 시작하며 DB·별도 큐·추가 백엔드 서비스는 기본 구성에 넣지 않습니다. 측정된 목록 비용·잠금 경합·복구 부담 또는 다중 호스트 요구가 생길 때 별도 결정합니다. macOS 임시 서버와 향후 상시 운영의 주소·인증·프로세스 관리·백업/복구는 실제 배포 전에 검증합니다.

첫 구현은 일반 API의 읽기 경계부터 준비하며, 정확한 포함·제외 범위와 완료 검사는 PLAN의 R1 첫 구현 묶음 (정리로 삭제된 참고 자료)에 둡니다. 첫 묶음만으로 R1 전체·업로드·CLI/AI·Electron 연결이 완료된 것으로 표시하지 않습니다.

#### R1 첫 읽기 API의 구현 계약 (2026-10-25)

첫 범위는 아래 A01–A04입니다. `core/api/v1/{access,documents,knowledge}`가 전송 모델과 라우터를 맡고, `core/runtime/application.py`가 공통 보호와 MCP를 조립합니다. API와 MCP는 서로 import/호출하지 않으며 AccessPolicy·WikiStore·ReviewStore를 직접 재사용합니다. 기존 저장 의미·전체 이력·원장과 도구 인자를 변경하지 않습니다. 새 서비스 객체 연결만을 위한 빈 `services.py`는 만들지 않습니다.

- 의존성: FastAPI **0.162.0**, 기존 MCP **2.3.0**, Starlette **1.9.0**, Pydantic **2.14.1**, Uvicorn **0.54.0**. Python3.12.14/macOS의 별도 임시 환경에서 기존 버전 제약으로 해결·설치하고 `pip check`를 통과한 뒤 `.venv`에는 FastAPI와 annotated-doc만 추가했습니다. 모든 해결 버전을 `requirements.lock`으로 고정합니다. 다른 OS의 실제 배포 검증은 별도입니다. [공식 mount 안내](https://fastapi.tiangolo.com/advanced/sub-applications/)·[query 모델 안내](https://fastapi.tiangolo.com/tutorial/query-param-models/)와 설치 SDK의 실제 ASGI/lifespan 구현을 확인했습니다.
- 조립: 부모 FastAPI lifespan이 MCP 앱의 lifespan을 한 번 소유합니다. API 라우트 다음에 MCP 앱을 `/`로 mount하여 공개 `/mcp`를 유지하고 부모/자식 slash redirect를 끕니다. MCP JSON/stateless·POST·8MiB는 유지합니다. `core.runtime.http_cli`는 명시 정책/tenant-root가 필수이고 loopback·worker1·프록시 헤더 해석 비활성으로 시작합니다. 기존 stdio 런처·MCP HTTP 명령과 실제 연결 설정은 유지합니다.
- 인증: runtime의 공통 middleware가 양쪽 모든 HTTP 입구에서 단일 Bearer·Host/Origin을 검사합니다. API dependency와 MCP 도구 실행은 현재 정책의 tenant/read/profile을 저장소 생성 전에 다시 검사합니다. 정책 오류·회수에 캐시/legacy fallback은 없습니다. 입구와 MCP 내부 정책 읽기는 제한된 작업 스레드에서 실행하고, API 동기 업무/인가도 FastAPI의 작업 스레드로 처리합니다. 요청별 scope의 ContextVar 수명은 기존 호출 문맥에 유지합니다.
- 입력/공개: 네 GET만 노출하며 추가/중복 query·위조 actor/user_id·GET 본문을 거부합니다. `limit`는 ASCII 정수 문자열1–50만 파싱합니다. query 전체32KiB, document4096자, cursor16384자, profile은 기존 ID 규칙입니다. `/openapi.json`은 Bearer/Host/Origin 보호를 받으며 실제 네 API의 요청·응답·오류만 포함합니다. `/docs`·`/redoc`은 비활성화합니다. 동작하지 않는 쓰기·등록 경로를 OpenAPI에 미리 만들지 않습니다.
- 응답: 위 envelope와 `Cache-Control: no-store`를 적용하고 `data.access`에 현재 user/tenant/profile·policy_revision을 반환합니다. 본문은 WikiStore.read의 전체 content/revision, 지식은 ReviewStore.query의 **전체** machine/effective graph·claims·policies·history·pending_history·selection·원문/그래프/검토/이력/상태 revision을 모델에 보존합니다. 그래프 세대별 의미 필드는 JsonValue 객체로 그대로 전달하며 응답에서 일부를 조용히 생략하지 않습니다. 완성 JSON의 상한16MiB를 넘으면 전체를 `response_limit`500으로 거부하고 저장/재추출/원장 초기화를 실행하지 않습니다. 이 예산은 후속 고정 페이지와 별개입니다.
- 오류: 인증401, tenant/read/profile403, 문서없음404, 메서드405, 목록 기준 변경409(`retry=read_again`, `requires_refresh=true`), GET본문/query·문서크기413, Host421·Origin403, 입력/cursor422, busy503(`same_basis`), 정책불가503, 읽기/원장손상/한도500을 구분합니다. 원래 ReviewStore 계약에 따라 그래프 미생성·stale·손상은200 payload의 missing/stale/unavailable로 보존하고 빈 승인 사실로 바꾸지 않습니다. 오류는 토큰·설정 내용·서버 절대 경로와 입력값을 반사하지 않습니다.
- 목록: `documents/listing.py`는 문서1000·탐색항목10000(비md 포함)·깊이100·탐색오류50의 제한 탐색을 같은 저장 잠금 안에서 수행합니다. symlink·비정규 파일은 따라가지 않고 skipped로 남깁니다. 전체 상대 경로의 사전순으로 기본20/최대50개의 본문만 읽어 실제 revision을 얻고 `source_status=unlinked`로 반환합니다. `scanned`는 탐색한 항목 수이며 정확한 total이 아닙니다. catalog_revision은 경로·device/inode·크기·mtime_ns·ctime_ns와 탐색 상태의 hash입니다. 모든 문서 본문을 읽어 요청당1000MiB를 소비하지 않도록 파일 관측 기준을 채택했으며 저장 CAS/전역 snapshot/외부 메타데이터 위조 방어를 약속하지 않습니다.
- cursor: tenant·현재 user/profile/policy 범위 hash·catalog 기준·마지막 경로에 묶습니다. 매 페이지 현재 인가 후 다시 탐색하며 WikiStore 직접 추가·수정·삭제로 기준이 바뀌면409로 첫 페이지 재조회를 요구합니다. 다른 범위/잘못된 cursor는422입니다. 다음 페이지가 있거나 skipped/한도이면 complete=false입니다. 탐색이 잘렸으면 truncated=true·next_cursor=null로 반환하며 한도 안의 부분 결과를 전체 목록으로 표시하지 않습니다. 페이지 읽기 실패는 skipped에 남기고 전체 저장/이력은 보존합니다.

이 선택의 이유는 CLI/AI 없이 같은 tenant의 기존 지식을 읽으면서 권한·최신성·의미 보존을 유지하고, 등록/작업 계약을 첫 범위에 섞지 않기 위해서입니다. 실제 검증과 다음 범위는 PLAN (정리로 삭제된 참고 자료), 실행은 [README](../../../README.md#fastapi-첫-읽기-api와-mcp-함께-실행)에 둡니다.

아래 선택은 아직 미결입니다. 첫 읽기 구현을 이 항목들의 확정으로 확대하지 않습니다.

| 미결 사항 | 확정할 시점·조건 |
| --- | --- |
| 후속 HTTP 모델·등록 카탈로그/추출·작업 결과의 예산·페이지 | 첫 읽기 계약은 위 절에서 확정. 원본만 있는 항목과1:N 파생 문서·파일 스트리밍/다운로드는 해당 후속 구현에서 고정 |
| 원본 공개·카탈로그·영수증 사이 실패의 복구 증거·파일 내구성 범위 | R1 등록/영수증 범위에서 실패 주입·응답 유실 검증 후 확정. 같은 내용 hash만으로 요청 주체·정확히 한 번의 성공을 확정하지 않음 |
| 입력 의존 최종 대조와 save/generate의 공용 내부 실행 경계 | R2/Q2에서 조정 잠금 → 저장 잠금 순서와 비재진입 계약을 유지하며 경합 검증 후 확정 |
| 실제 배포 주소·인증 발급/회수·데이터 위치/복구, CLI별 bridge·세션 어댑터·OS별 패키징 | 해당 배포·R3/R4·Q3 범위에서 별도 결정/검증. source_write 구현과 운영 부여도 분리 |

#### 유스케이스별 FastAPI API 설계 (2026-10-24)

상태: **UC-01–19·UI 가이드 기반 API 목록이며, 잔여 B/C/D/S와 E/F의 최소 계약까지 구현했습니다.** 아래는 원래 설계 근거이며 현재 확정한 집계 범위·개인 보관·추가 권한·경로·검증은 [D-050](../platform/DECISIONS.md#d-050--잔여-http-api와-개인-기록의-최소-계약-2026-10-25)과 [API 계획](../platform/PLAN.md)을 우선합니다. 화면별로 자료를 복제하지 않고 문서·지식·검토·대응·작업 자원별 계약과 기존 모듈을 재사용합니다. UI 연결·운영 권한 부여는 별도입니다.

**공통 요청·응답 설계.** A01 외 모든 경로의 접두사는 `/api/v1/tenants/{tenant}`입니다. Bearer 전달·비밀 보관은 Electron main이 담당하고 서버의 현재 `AccessPolicy`로 인증·tenant·행동을 자료 접근 전에 검사합니다. 프로필이 필요한 조회는 허용 `profile`을 명시하며 `domain/viewpoint`는 서버가 해석합니다. `actor/user_id`를 요청으로 받지 않습니다. `document`는 기존 검증된 상대 경로 참조이며 UI의 `documentId`나 서버 절대 경로와 혼용하지 않습니다. 경로에 문서 경로를 끼워 넣지 않고 GET은 query, 변경/복합 조회는 JSON body로 받습니다. ID·revision·hash는 서로 다른 필드/타입으로 다루며 unknown 필드와 임의 타입 변환을 거부하는 요청 모델을 둡니다.

- JSON 성공 응답은 `{data: <업무 결과>, meta: {trace_id: ...}}`, 오류는 `{error: {code, message, retry, details}, meta: {trace_id: ...}}`를 기준으로 합니다. `trace_id`는 진단용이며 멱등 키/저장 영수증이 아닙니다. 실제 본문·주장·근거·한정어·정책 이벤트·버전·`cleanup_failures`는 `data`에서 보존합니다. 파일은 인증 스트리밍 응답으로 따로 취급합니다.
- 단건 읽기/기존 결과는 200, 실제 자원 생성은 201, 실제로 접수되어 조회할 수 있는 미완료 작업만 202를 사용합니다. 작업 생성 응답은 개인 AI 실행 성공이 아닙니다. 인증 실패401, tenant/행동/profile 거부403, 허용 범위의 대상 없음404, CAS/기준 버전/cursor 충돌409, 요청 바이트 초과413, 미지원 media type415, 스키마/도메인 입력 오류422, `storage_busy`503을 기준으로 매핑합니다. 정책 손상·읽기/저장 장애는 기존 오류 종류를 보존한 5xx이며 빈 성공으로 바꾸지 않습니다. 세부 매핑은 R1 계약 테스트로 고정합니다.
- `retry`는 자동 재실행 지시가 아닌 `none/read_again/same_basis/reconcile` 등 다음 조치의 분류입니다. conflict는 최신 자료와 재대조, busy는 같은 기준으로 나중에 재시도, 성공 후 정리 경고는 성공으로 유지합니다. 응답 자체를 잃은 변경 요청은 클라이언트가 `outcome_unknown`으로 표시하고 확인 전 재전송하지 않습니다.
- 새 문서·원본·작업·이력 목록은 `items/next_cursor/scope/complete/truncated/skipped`와 목록 기준 revision을 제공합니다. 기존 B04/B05·D01 등 발견/통합 조회의 `matches/results`·상한·무페이지 계약은 유지하며 cursor를 임의로 붙이지 않습니다. 제한된 발견 결과는 범위를 좁혀 다시 조회합니다. 기본20/최대50은 문서·새 일반 목록의 기준이며 기존 검색/개념 서비스의 별도 상한을 축소·확대하지 않습니다. cursor는 tenant·인가 범위·필터·정렬·목록 기준에 결합하고 재사용 시 현재 권한도 검사합니다. 다음 페이지가 있거나 탐색 실패/한도가 있으면 전체 범위 완료로 표시하지 않습니다. 변경된 기준은 재조회 필요로 반환하며 offset으로 조용히 이어붙이지 않습니다. 전체 snapshot/정확한 전역 total은 보장하지 않습니다.
- 복합 조회의 POST는 배열·버전 있는 참조·baseline을 전달하기 위한 **읽기 전용 요청**입니다. 서버 저장·AI 실행·권한 상승이 없으며 `read`만 요구합니다. OpenAPI operation에 이 성격을 표시합니다. POST/GET이라는 이유만으로 재시도·쓰기 권한을 일괄 판단하지 않습니다.
- 일반 API 응답은 공유 캐시에 저장하지 않는 `Cache-Control: no-store`를 기준으로 하고, 앱의 자료 캐시는 인증 주체·tenant·profile·조회 범위별로 구분합니다. 원문·지식·검토를 따로 읽은 결과의 revision이 다르면 혼합 snapshot으로 승인하지 않습니다. 각 서비스의 `scope/complete/truncated/skipped`·현재성·한도를 그대로 유지하며, 누락한 필드를 `complete=true`로 보충하지 않습니다. 큰 그래프/원장은 필드별 응답 예산을 정한 뒤 명시 실패 또는 버전에 묶인 출력 페이지로 전달하고 의미 필드를 조용히 자르지 않습니다.

**A. 첫 읽기 API — R1 첫 묶음.** 전체 완료 조건은 PLAN (정리로 삭제된 참고 자료)이 관리합니다.

| ID / HTTP | 입력 → 주요 반환 | 처리·권한 |
| --- | --- | --- |
| A01 `GET /api/v1/access-context` | 사용자 입력 없음 → 현재 인증 주체·허용 tenant/행동/profile·policy revision | 기존 `AccessPolicy.describe`; 인증 필요 |
| A02 `GET /documents` | `cursor?, limit?` → 문서 참조·현재 revision·원본 연결 상태·페이지/완전성 | **전용 목록 서비스 신규**, `read`; 먼저 기존 Wiki만, 원본 카탈로그 결합은 뒤 R1 |
| A03 `GET /documents/content` | `document` → 전체 `content/revision` | 기존 `WikiStore.read`, `read`; 표시 편의를 위한 요약/줄바꿈 변환 없음 |
| A04 `GET /documents/knowledge` | `document, profile` → `effective_graph/claims/policies/pending_history/history/selection`와 source·graph·review·history·state revision | 기존 `ReviewStore.query`, `read`; 미검토/보류/다른 범위도 보존 |

A02의 원본 연결 없음은 후속 등록 자료에 대한 추정 연결이 아닙니다. A04는 문서별 현재 판단의 기준 조회이며 그래프가 없거나 오래된 상태, 계산 실패를 빈 승인 그래프로 반환하지 않습니다. R1에서 전체 응답 상한을 먼저 고정하고 초과 시 수정 불가·명시 오류로 처리합니다. 후속 C09/C10의 출력 페이지가 준비되지 않았는데 이력을 생략해 정상 전체 응답처럼 표시하지 않습니다.

**B. 탐색·질문 근거 조회 — 기존 서비스의 후속 HTTP 어댑터.** 모두 `read`; 프로필을 받는 서비스는 허용 profile을 서버의 domain/viewpoint로 변환합니다.

| ID / HTTP | 입력 → 주요 반환·보존할 의미 |
| --- | --- |
| B01 `GET /documents/search` | `query, limit?` → 원문 문자열 검색·snippet·`truncated/skipped`; 기존 `wiki_search` 처리 재사용, 문서 목록/의미 검색과 구분 |
| B02 `GET /documents/ontology` | `document, profile` → **machine층** 그래프·후보·현재성/재추출 표시·source/graph revision; 현재 전문가 판단은 A04 |
| B03 `POST /knowledge/context/query` | `documents[1..8], profile` → 선택 문서의 전체 원문/전체 machine 그래프, `focus/other_context/unclassified`·출처·범위·완전성; 전문가 판단은 A04/B05와 함께 확인 |
| B04 `POST /concepts/find` | `text, profile, documents?, include_history?, application_context?, as_of?, limit?` → 버전 있는 `target_ref`·일치 출처·현재성·부분 결과; 원문에 없는 정책 용어도 기존 계약대로 구분 |
| B05 `POST /concepts/query` | `target, profile, documents?, correspondence_ids?, expansion, application_context?, as_of?, limit?` → 현재 유효 주장·정책·지도용 맥락·`resource_manifest`·snapshot/view revision·완전성 |
| B06 `GET /documents/connections` | `document, limit?` → 명시 링크/이름·유형 후보·양쪽 문서/개체/revision·근거·`ontology_states`; 검토된 의미 대응은 D계열 |
| B07 `POST /documents/impact/query` | `document, profile, baseline?, limit?` → 직접 영향 권고·변경/복원 상태·`restoration/complete/truncated/skipped`; baseline 없으면 변경을 추정하지 않음 |

B04/B05의 문서·대응 선택 상한, 직접 확인된 대응 한 단계 확장, `as_of`·판정/적용 상태는 [D-040]을 그대로 따릅니다. snapshot/view revision·영향 baseline은 쓰기 CAS가 아닙니다. UC-08은 두 명시 대상을 B03/B05로 읽어 UI에서 방향·조건·기간·근거를 병렬 표시하는 것으로 시작합니다. 자동 동치/모순 판정용 API나 단순 diff를 의미 판정으로 사용하는 API는 추가하지 않습니다.

**C. 본문 편집·판본·문서별 검토 — R1 첫 범위 밖.** 요청에서 `document`를 명시하고 검토/정책에는 허용 profile을 연결합니다. 기존 저장 의미와 일반 쓰기의 응답 유실은 아래 경계를 함께 적용합니다.

| ID / HTTP | 입력 → 결과 | 재사용·새 작업 / 권한 |
| --- | --- | --- |
| C01 `PUT /documents/content` | `document, content, expected_revision` → 저장 revision·보관 결과·정리 경고. null은 신규 생성에만 허용 | 기존 `WikiStore.save`; `write` |
| C02 `GET /documents/versions` | `document, cursor?, limit?` → 현재 본문과 과거 보관 파일의 별도 참조·hash·보관 시각·완전성 | 공개 이력 서비스 **신규**; `read` |
| C03 `GET /documents/versions/{history_id}` | `document` → 검증된 과거 전체 본문·content revision·보관 정보 | **신규**; `read`; 문서 소속·안전한 경로·크기/UTF-8 검사 |
| C04 `POST /documents/restorations` | `document, history_id, expected_revision` → 과거 전체 본문을 새 저장으로 적용한 결과 | 새 서비스가 `WikiStore.save` 재사용; `write` |
| C05 `POST /documents/reviews` | `document, profile, claim_id, action, expected_state_revision, reason, replacement?` → 새 `event_id/state_revision/changed/cleanup_failures` | 기존 원문 근거 검토; `ontology_review` |
| C06 `POST /documents/review-undos` | `document, profile, event_id, expected_state_revision, reason` → 정확한 검토의 새 역이벤트/상태 | 기존 검토 되돌림; `ontology_review` |
| C07 `POST /documents/policies` | `document, profile, claim_id, expected_state_revision, reason, replacement, entities?` → 전문가 판단 이벤트·적용 상태 | 기존 업무 판단; `ontology_policy` |
| C08 `POST /documents/policy-undos` | `document, profile, event_id, expected_state_revision, reason` → 해당 관점 판단의 새 역이벤트/상태 | 기존 정책 되돌림; `ontology_policy` |
| C09 `GET /documents/events` | `document, cursor?, limit?` → 문서 검토/정책 이벤트 목록·원장 기준·완전성 | 원장 조회 재사용, 출력 페이지 **신규**; `read` |
| C10 `GET /documents/events/{event_id}` | `document` → 당시 target/before/after·이유·인증 주체·인용·기준 revision | 단건 projection **신규**; `read`; 현재값으로 과거를 덮지 않음 |

- 판본의 `history_id`는 보관 파일의 식별자이며 내용 hash와 다릅니다. A→B→A나 중복 보관에서도 hash가 재등장할 수 있고, 보관 파일이 있다는 사실이 원본 교체 성공을 증명하지 않습니다. 기존 이력에는 작성자/편집 이유가 없으므로 null/미기록을 유지하고 보관 시각을 본문 작성 시각으로 표시하지 않습니다. 최초 생성 전 부재 복원·삭제는 제공하지 않습니다. 두 고정 본문의 텍스트 diff는 UI에서 계산하며 별도 diff API를 우선 만들지 않습니다.
- C04는 최신 `expected_revision`에서 현재 전체 파일도 이력에 남기는 새 저장입니다. 과거 그래프/승인 자동 복원은 없습니다. 검토 이벤트가 옛 전체 원문/그래프를 모두 갖고 있다고 가정하지 않으며 과거 근거 복원에 실패하면 명시합니다. 원장을 먼저 페이지로 잘라 현재 판단을 계산하지 않고, 전체 제한된 원장을 검증·계산한 뒤 출력만 페이지화합니다.
- C05의 `action=accept/edit/reject/defer`, edit는 실제 인용·모든 한정어/맥락/출처를 포함한 전체 주장 교체입니다. C07은 기존 **관계·속성 claim**의 업무 판단으로, `relation_candidates`의 정책 승격·독립 새 주장 생성은 지원하지 않습니다. 이 경로는 가짜 evidence/provenance를 받지 않고 인증 주체와 Action log를 서버가 기록합니다. 두 경로의 권한·근거·undo를 통합하지 않습니다. 새 독립 관계 생성·claim 분리·중요 누락 복구는 전체 재추출 경로와 구분합니다.
- **일반 쓰기의 멱등 영수증은 미구현·미확정**입니다. D-043의 원본/job `request_id` 계약을 C/D 쓰기에 자동 적용하지 않습니다. 현재 서비스 CAS만 노출한다면 응답 유실 후 본문/원장을 조회하되 같은 hash·actor·내용만으로 해당 요청 성공을 확정하지 않고 미확인을 유지해야 합니다. 제품 쓰기 연결 전 이 방식의 확인 절차 또는 별도 일반 mutation intent/receipt·`pending_reconcile` 계약을 결정·실패 검증합니다. 조회로 해결되지 않은 미확인을 자동 재전송으로 없애지 않습니다.

**D. 문서 간 의미 대응 — [D-038]의 별도 원장과 prepare 계약.** D01–D09는 공통 입력으로 허용 `profile`을 받고 준비→변경까지 같은 관점을 유지합니다. prepare의 CAS는 선택 관점·정책 revision에도 결합하며 관점 전환 시 새로 준비합니다. 상세 필드는 D-038을 재사용하며 source proposal·검토·업무 판단, `decision`과 `applicability`를 분리합니다.

| ID / HTTP | 입력·동작 | 권한 |
| --- | --- | --- |
| D01 `POST /correspondences/find` | `documents[1..8], text?, application_context?, as_of?, limit?`의 제한된 발견 | `read` |
| D02 `POST /correspondences/{id}/query` | `application_context?, as_of?`로 상세/의존 버전·검토/정책/이력 조회 | `read` |
| D03 `POST /correspondences/drafts/prepare` | 전체 `draft` 정규화·ID·부재 CAS 반환, **저장/예약 없음** | `read` |
| D04 `POST /correspondences` | prepare의 `correspondence_id, draft, expected_state_revision, reason`으로 제안 저장 | `ontology_write` |
| D05 `POST /correspondences/{id}/changes/prepare` | `operation, change`의 정확한 변경 내용·의존 버전에 묶인 token, **저장 없음** | `read` |
| D06 `POST /correspondences/{id}/reviews` | `action, expected_state_revision, reason, replacement?, decision?`으로 검토 | `ontology_review` |
| D07 `POST /correspondences/{id}/review-undos` | `event_id, expected_state_revision, reason`으로 검토 역이벤트 | `ontology_review` |
| D08 `POST /correspondences/{id}/policies` | `replacement, expected_state_revision, reason, judgment_id?, supersedes_event_id?`로 업무 판단 | `ontology_policy` |
| D09 `POST /correspondences/{id}/policy-undos` | `event_id, expected_state_revision, reason`으로 판단 역이벤트 | `ontology_policy` |

값 변경 없는 accept/reject/defer는 완전한 상세 조회 token도 사용할 수 있으나 edit·policy·두 undo는 정확한 변경 prepare를 요구합니다. 불완전 조회에는 변경 token이 없고 prepare의 read 권한이 변경 권한을 부여하지 않습니다. 응답 유실 때 같은 대응 ID를 조회하며 새 ID로 다시 제안하지 않습니다. D-038 condition/concept anchor와 D-040 `target.kind=anchor` 계약을 관계 subject/object의 명시 v4 `source_anchor`와 구분합니다. D-042의 격리 구현·검증 (정리로 삭제된 참고 자료) 이후, 이번 조사 도중 공유 core에도 v4 끝점·검토·개념 조회 처리 코드가 동시 반영된 것을 확인했습니다. 이는 이번 문서 작업의 변경이 아니며 최종 검증·실행 서버 적용·운영 자료 반영 여부는 별도 기록으로 확인해야 합니다. API 구현 시 확정된 schema_version과 소비자 지원을 다시 고정하고 앵커를 개체 ID로 바꾸거나 응답에서 생략하지 않습니다. 문서 정책의 replacement는 재확인 시점에도 문자열 개체 끝점만 허용하므로 v4 지원을 모든 쓰기에 확대하지 않습니다. 일반 HTTP 경로의 현재 구현은 D-050과 platform PLAN을 따릅니다.

**S. 자료 등록·개인 AI 작업·결과.** 실제 HTTP 경로·입출력·권한의 목록은 바로 아래 [업로드·목록·작업 API와 권한](#업로드목록작업-api와-권한)에 한 번만 둡니다. 원본 등록/새 판본/파일, 원본·문서 목록, job 생성·목록·상태·heartbeat·취소·요청 영수증, extraction manifest/고정 내용 페이지·artifact 전송이 필요합니다. 원본 등록과 실제 AI 분석, 추출물과 Wiki/그래프 저장의 완료는 각각 조회합니다. `GET /analysis-jobs`를 작업 목록에 추가 설계하며 상세와 같은 서버 관측 상태를 반환하고 목록의 필터·주체별 노출·페이지 예산은 구현 전에 고정합니다. 실제 개인 CLI 시작/로그인/PTY·로컬 파일 선택은 Electron main의 동작으로 남기며 일반 API에 셸/AI 실행 경로를 만들지 않습니다. 전체 그래프 제출·규약/입력 bundle은 D-043/D-044의 작업용 MCP가 담당합니다.

**E/F. 새 제품 계약이 필요했던 후보의 설계 근거.** 사용자 전체 구현 요청으로 [D-050](../platform/DECISIONS.md#d-050--잔여-http-api와-개인-기록의-최소-계약-2026-10-25)의 명시 범위 집계·질문 준비·개인 기록·비교 계약을 확정해 구현했습니다. 아래 당시 미결 사항은 현재 D-050의 확정 범위와 구분합니다.

| ID / 후보 HTTP | 필요한 설계·미결 사항 |
| --- | --- |
| E01 `POST /review-queue/query` | 명시 문서/대응 또는 허용 tenant 범위·상태/profile 필터의 검토 대기열. `read` 기반 신규 집계, 문서/원장 탐색 예산·cursor·partial 상태·현재/과거/pending 구분 필요. 빈 페이지는 전체 검토 완료가 아님 |
| E02 `POST /history/query` | 본문 보관·검토·정책·대응·job을 종류별 ref로 모은 이력. `read` 기반 신규 집계, 범위·정렬·예산·복원 불가 표시 필요. 없는 본문 편집자나 옛 전체 그래프를 발명하지 않음 |
| F01 `POST /question-context/prepare` | 명시 문서/주장/원본·profile·필수 정의/예외에서 질문용 자료/판본 manifest를 읽기 전용으로 구성. B/A/S를 재사용하는 새 조합 서비스 후보. 누락·오래된 지정 대상을 조용히 제외하지 않으며 준비는 AI 실행/영구 snapshot 저장이 아님 |
| F02 `GET /conversations`, `POST /conversations`, `GET /conversations/{id}`, `POST /conversations/{id}/turns` | 대화 목록/생성/읽기/질문·개인 CLI 답변의 명시 제출 후보. 개인/tenant 공유 범위·별도 권한·append CAS·보관/삭제·질문 당시 원문/정책 근거 snapshot·실패한 turn 상태를 먼저 정함. 클라이언트의 AI 답변을 서버 생성이나 전문가 승인으로 표시하지 않음 |
| F03 `GET /saved-results`, `GET /saved-results/{id}`, `POST /saved-results` | Wiki와 별도로 저장할 답변/작성 결과 및 당시 출처 계보가 필요한 경우의 후보. 별도 자원이 필요한지, Wiki 저장과의 연결/부분 실패·권한·원문 보존 용량을 먼저 결정. 단순 초안을 자동 Wiki 저장하지 않음 |
| F04 비교/재검토 완료 자원 — 경로 미확정 | UC-15/16의 고정 이전/새 제안·버전·옛 claim↔새 claim 명시 대응·판본별 제외·복구 초안·실제 새 claim 검토/저장 확인을 영속할지 먼저 결정. 미발견을 삭제/AI 누락으로 단정하지 않으며 명시 비교 범위의 완료만 계산. B07·C계열·job 결과는 기반일 뿐 전체 기능을 대신하지 않음 |

당시 후보의 F02/F03 권한 미결정은 D-050의 별도 명시 권한으로 확정했으며 기존 `write`나 `source_write`에서 자동 상속하지 않습니다. 당시 답변의 snapshot은 현재값으로 교체하지 않고 새 질문은 현재 허용 자료를 다시 조회합니다. 저장하지 않은 질문/편집 초안·지도 배치·접힘·선택 관점·테마는 앱 상태로 유지할 수 있어 각각의 서버 API를 만들지 않습니다. 소속 표시 A01과 계정 발급/SSO/토큰 관리·자동 알림은 별개이며 후자는 이번 API 설계의 구현 범위가 아닙니다.

**유스케이스 추적.** UI의 같은 대상/관점/판본을 API 사이에서 유지하며 다음 대응은 구현 완료를 뜻하지 않습니다.

| UC | 필요한 API / 화면 동작 |
| --- | --- |
| UC-01 자료 축적 | S 등록·작업·결과 → A02/A03/A04 |
| UC-02 경험 문서화 | F01/F02/F03 후보·개인 CLI → 명시 C01 저장; 경험/제안 구분 |
| UC-03 자료 이해 | A03/A04·B02/B03·S 추출물/경고 |
| UC-04 문서 찾기 | A02·B01 → A03 |
| UC-05 근거 있는 질문 | A01/A04·B03/B05 → F01/F02·개인 CLI |
| UC-06 개념 종합 이해 | B04 → B05·D02 |
| UC-07 관점별 이해 | A01의 허용 profile → A04/B03/B04/B05; 앱의 질문 범위 재확인 |
| UC-08 기준 비교 | B03/B05·D02의 명시 두 기준 → UI 병렬 비교; 자동 의미 판정 없음 |
| UC-09 결과물 작성 | F01/F02/F03 후보·C01; 결과와 당시 출처 보관 |
| UC-10 연결 탐색 | B06·B05·D01/D02; 링크/이름 후보/검토 대응 분리 |
| UC-11 연결 검토·선례 | D01–D09; 새 문서는 별도 제안/판단 |
| UC-12 원문 정정 | A03·C01–C04·S 새 원본 판본; 원본 교체와 Wiki 수정 구분 |
| UC-13 AI 해석 정정 | A03/A04·C05/C06; 누락/새 주장 복구는 S의 전체 재추출 |
| UC-14 전문가 판단 | A04·C07/C08·D08/D09; Action log·범위별 적용 |
| UC-15 지식 갱신 | S 작업/전체 저장·A03/A04·C계열·F04 후보 |
| UC-16 변경 후 재검토 | B07·D02·E01·C계열·F04 후보; 전역 종료로 확대하지 않음 |
| UC-17 추적·되돌림 | C02/C03/C04/C06/C08/C09/C10·D02/D07/D09·E02 |
| UC-18 다음 작업 재사용 | A01·B01/B04/B05·A04·F01/F02; 최신 판단 재조회 |
| UC-19 작업 범위 확인 | A01과 각 요청 인가; 개인 CLI/MCP 준비 상태는 호스트에서 별도 확인 |

추가 미결은 **일반 변경 요청의 영수증/미확인 해소**, **본문/원장 이력·전역 집계의 페이지와 예산**, **질문/대화/결과/비교 자원의 저장·공유·권한·완료 계약**입니다. 이들은 위 FastAPI 미결 표의 R1 항목과 구분하며 R1 첫 읽기 구현을 전체 제품 API 구현으로 확대하지 않습니다.

#### 실행 주체와 두 가지 등록 입력

| 주체 | 담당 동작 |
| --- | --- |
| Electron renderer / preload / main | 제한된 preload API를 거쳐 main의 일반 HTTP API 클라이언트가 업로드·목록·본문/그래프·작업 결과를 조회. main이 사용자 PC의 PTY에서 새 개인 CLI 터미널을 열거나 명시 선택 세션에 요청을 준비하며 파일 전송 bridge를 관리 |
| 각 사용자의 로그인된 CLI | MCP로 고정 지침·원본 참조·작업 입력을 읽고, 작업용 파일을 검증된 로컬 도구/이미지 입력과 AI로 읽어 충실한 본문을 구성한 뒤 온톨로지를 추출. 추출물 제출·본문/그래프 저장은 허용된 MCP 도구로 요청 |
| 같은 위키 백엔드의 일반 API `/api/...` | Electron의 서버 사용자/권한 확인·원본 업로드/다운로드·페이지 목록·최신 본문/유효 그래프·작업 결과 조회와 호스트 bridge의 작업용 파일 전송 |
| 같은 위키 백엔드의 MCP `/mcp` | 개인 CLI의 `access_context`·공통 지침/고정 입력·원본 참조 조회, 작업 접수·추출물 제출·위키/온톨로지 저장. 일반 API와 같은 서비스·저장 모듈을 재사용 |

파일 업로드·목록/결과 조회에는 모델 호출이 필요하지 않으며 CLI가 꺼져 있어도 동작해야 합니다. 원본에서 문자/셀/페이지를 읽는 도구 실행과, 표·이미지·문맥을 해석해 본문을 구성하는 AI 작업은 개인 CLI가 담당합니다. **본문 준비와 온톨로지 추출 모두 AI가 참여할 수 있으므로 AI 호출이 한 번이라고 약속하지 않습니다.** ChatGPT 로그인은 CLI의 AI 이용 인증이고, 서버 Bearer 인증은 위키 tenant 접근 인증입니다. 둘의 사용자 식별자나 권한을 서로 대신하지 않으며 AI 인증정보를 공유 위키 서버·작업 manifest·문서에 저장하지 않습니다. 개인 계정 CLI의 사용 범위를 상용/호스팅 AI 서비스 허용으로 확대 해석하지 않습니다.

Electron의 문서 화면은 `/api/...`를 호출하며 renderer/main의 MCP 클라이언트를 필수로 두지 않습니다. 새 터미널·CLI 프로세스는 Electron main이 사용자 PC에서 실행하고, 그 CLI가 서버 MCP에 접속합니다. 원격 MCP 서버가 다른 PC의 터미널을 직접 생성하거나 셸 명령을 밀어 넣는 구조로 설계하지 않습니다.

파일 등록은 선택한 원본 바이트를 먼저 서버에 보관합니다. 본문 직접 입력도 `kind=text`의 원본 판본으로 입력 문자열의 UTF-8 바이트·줄바꿈을 보관한 뒤 같은 분석 경로로 합칩니다. 두 입력 모두 등록 완료만으로 위키 본문·그래프가 생성됐다고 표시하지 않습니다. 기존 위키 본문을 직접 편집하는 동작은 종전 `wiki_read`/`wiki_write` 흐름이며 새 원본 등록과 구분합니다.

#### 서버 저장 위치와 자료 계보

서버 관리자가 기동 시 검증한 `tenant-root/<T>/`를 유일한 서비스 저장소로 사용합니다. D-041의 이관 이후 현재 개발/운영 확인 경로는 `<project>/data/personal/`입니다. 원본 등록도 명시 정책이 허용한 같은 tenant 경계 안에 보관합니다. 실제 배포에서는 코드 checkout 밖의 전용 데이터 루트를 설정할 수 있게 하되, 실제 서버·절대 경로·이관 시점은 별도 배포 결정입니다. 프로젝트 최상위·사용자의 다운로드 폴더·CLI 작업 디렉터리를 공식 서버 보관소로 사용하지 않습니다.

```text
<tenant-root>/<T>/
  _sources/<source_id>/<source_version>/original       원본 전체 바이트, 불변
  _sources/<source_id>/<source_version>/manifest.json  형식·hash·주체·시각, 불변
  _extractions/<extraction_id>/                        CLI 제출 본문·표·이미지·출처 대응과 manifest
  _registrations/<source_id>.json                     판본 목록·현재 원본·파생 문서 연결
  _registrations/_requests/<owner-request-hash>.json   원본 등록 intent·예약 ID·영수증
  _jobs/<job_id>/                                     입력 기준·시도·단계별 영수증·결과 참조
  _incoming/                                         원본/CLI 산출물 공개 전 staging, 비서비스
  wiki/<relative-document>.md                         최신 위키 본문, 기존 모듈
  _history/<relative-document>.md/                    수정 전 전체 본문, 기존 모듈
  _ontology/<SHA256(document)>.json                    현재 파생 그래프, 기존 모듈
  _reviews/                                          검토/정책/대응 보존 원장, 기존 모듈
```

이 트리는 전체 목표입니다. 원본 등록 범위의 `_sources`·`_registrations`·`_incoming`과 `.registration.lock`은 실제 등록 시 생성하며 `_extractions`·`_jobs`는 아직 생성하지 않습니다. 원본 보관과 요청 기록은 `_history`·`_reviews`를 대체하지 않습니다. 기존 프로젝트 최상위 Numbers 원본과 `records/source-prep-20261024T024339Z`의 보존본·준비 자료는 현재 위치에서 보존합니다. 이관을 요청받으면 원본/이력/원장·계보의 전체 보존 대조를 별도로 수행하며 등록 기능이 기존 자료를 자동 이동·중복 등록하지 않습니다.

- `source_id`는 한 등록 자료의 서버 발급 ID입니다. 파일명은 표시용 값이며 저장 경로로 쓰지 않습니다. `source_version`은 불변 판본 ID, `source_sha256`은 원본 바이트 상태값으로 서로 구분합니다. 같은 이름 재업로드는 새 판본이며 옛 파일을 덮어쓰지 않습니다. 본문 입력도 같은 원칙을 적용합니다.
- CLI의 읽기·변환 실행 제출마다 서버가 `extraction_id`를 발급하고 원본 판본/hash·job/run·도구/버전·설정·모델 자기보고·선택 범위·경고·누락/미확인 범위·입출력 hash를 불변으로 보존합니다. 원본의 페이지·절·표/셀·이미지와 준비 본문의 대응, 도구 원시 출력과 AI의 전사/재구성을 구분하고 재서술/요약을 원본 문장으로 위장하지 않습니다. 서버의 제출 수신·구조/hash 검증은 실제 파일 전체 읽기나 의미 정확도의 증명이 아닙니다. 변환물은 위키 편집과 함께 바뀌지 않습니다.
- 등록 카탈로그는 원본 판본 → 변환 실행 → 위키 `document/revision`의 명시적 1:N 연결을 보존합니다. 원본 하나를 여러 문서로 나누려면 의미가 완결된 범위와 누락/참조·목적 경로를 작업 입력에 명시하며 자동 이름 유사도 병합/분할은 하지 않습니다. 현재 원본 판본을 바꿔도 기존 본문/그래프의 기준 판본을 함께 바꾸지 않습니다.
- 그래프의 `source_revision`은 **실제 `wiki_read` 본문 revision**입니다. 원본 파일 hash·추출물 hash·원본 판본 번호를 대신 넣지 않습니다. 그래프 `graph_revision/generation_id`, 검토 `state_revision`, 작업 `job_revision`을 각각 유지하며 SHA-256 내용값을 작업 고유 ID로 사용하지 않습니다.
- `_ontology`는 현재 그래프 저장소입니다. 모든 이전 그래프가 자동 보존된다고 약속하지 않습니다. 새 분석 작업의 전체 원시 제출과 저장된 그래프/영수증을 `_jobs`의 결과 산출물로 보존해 해당 작업의 결과를 추적하도록 구현하되, 옛 그래프/승인을 현재로 복원하는 기능은 아닙니다. 영수증의 graph_revision과 일치하는 바이트만 당시 저장 스냅샷으로 기록하며 이미 다른 세대로 교체됐으면 그 현재 그래프를 옛 결과로 대신하지 않고 스냅샷 미확인을 구분합니다.
- 원본은 임시 파일에 수신·hash/형식/크기를 검증한 뒤 불변 판본으로 공개하고 마지막에 카탈로그를 갱신합니다. 동일 디스크의 staging 공개와 카탈로그/영수증 갱신은 별도 저장 단계입니다. 파일/폴더 symlink·클라이언트 절대 경로·경로 탈출을 거부하고 정책·비밀은 tenant-root 밖에 둡니다.

#### R1 원본 등록·업로드의 구현 계약 (2026-10-25)

사용자가 요청한 R1의 다음 범위를 **원본 신규 등록·새 판본·등록 목록/상세·선택 판본 다운로드·본인 요청 영수증**과 기존 문서 목록의 원본 발견으로 한정합니다. 업무는 `modules/sources`의 store·staging·commands·queries·files·validation·contracts, 전송은 `api/v1/sources`가 맡습니다. `modules/knowledge/catalogue.py`는 원본과 위키 목록의 읽기 조합입니다. 원본 수신에 python-multipart0.0.32를 직접 의존성으로 명시했으며 기존 lock/설치 버전과 같습니다. 실제 [FastAPI 파일 수신 안내](https://fastapi.tiangolo.com/tutorial/request-files/)와 설치 Starlette1.9.0의 spool/예외 정리 구현을 확인했습니다.

- 입력: `POST /sources`는 JSON `{request_id,title,format,content}` 또는 multipart의 `request_id,title,file` 하나를 받습니다. JSON은 kind=text, multipart는 kind=file이며 첫 형식은 유효한 UTF-8 md/txt입니다. 원본의 줄바꿈·BOM·UTF-8 바이트를 그대로 보존합니다. versions POST에는 양쪽 모두 `expected_registration_revision`이 필수입니다. source/version/request ID는 소문자hex32, revision/hash는hex64입니다. 같은 파일명은 표시 정보이며 신규 POST의 등록을 자동 병합하지 않습니다. 특정 등록의 새 판본은 source_id가 명시된 versions 경로만 사용합니다.
- 전송: 실제 수신 byte를 세어 전체24MiB, 원본20MiB를 각각 적용합니다. JSON escape/multipart overhead도24MiB에 포함되어 내용20MiB와 별개입니다. 파일 하나·일반 필드 최대3개·필드4096바이트·파트 헤더16KiB·완결 boundary를 검사합니다. 추가/중복 필드·중복 JSON key·원시 filename 경로/drive·지원하지 않는 형식을 거부하고 filename으로 저장 경로·명령을 만들지 않습니다. multipart는 디스크 spool과64KiB 저장 읽기를 사용하며 원본 전체를 base64/대화/MCP에 넣지 않습니다. JSON 본문은 별도24MiB의 제한된 메모리 입력이며 파싱은 작업 스레드로 보냅니다. 동시 수신은 단일 worker의4개 슬롯, 대기5초이며 초과 시 `upload_busy`503/same_basis입니다.
- 접근: 정책 version1에 `source_write`를 추가하되 기존 모든 쓰기 권한처럼 read가 필수입니다. 원본 등록/판본 추가는 source_write, 읽기/다운로드/본인 영수증은 read입니다. 기존 write·ontology_write·검토/정책 권한을 대신하지 않으며 기존 MCP 인자/도구 목록과 운영 read13을 자동 변경하지 않습니다. 수신 전에 tenant/source_write를 확인하고 공개 조정 잠금 안에서 현재 권한·인증 주체를 다시 확인합니다. 응답 access와 manifest actor는 서버가 확인한 범위를 사용하며 토큰·클라이언트 경로·임의 actor는 기록하지 않습니다.
- 저장 순서: tenant의 `.registration.lock`으로 조정하며 필요한 기존 문서 캡처는 조정→storage 잠금 순서를 지킵니다. 수신 staging·UTF-8/hash/크기 검증 후 현재 권한·CAS·한도를 대조하고 요청 intent를 먼저 원자 기록합니다. 그 intent의 예약 source/version ID·actor·payload hash·원본 manifest를 고정한 다음 불변 판본 디렉터리를 공개하고, 전체 이전 판본을 포함한 등록 카탈로그를 갱신하고, 마지막에 완료 영수증을 기록합니다. 파일은 fsync·같은 저장 루트 내 rename/원자 교체를 사용하지만 여러 파일 전체의 원자 거래·전원 장애 내구성을 보장하지 않습니다. WikiStore.save/그래프 생성은 이 등록 경로에서 호출하지 않습니다.
- 멱등/미확인: 키는 tenant·인증 주체·request_id이며 payload hash는 동작/대상·기준 revision·전체 metadata·실제 원본 hash/크기를 포함합니다. 같은 키/같은 입력의 확인된 완료는 기존 ID/영수증200, 다른 입력은409입니다. 새 등록 완료201, 영구 intent 이후 중간 실패는202와 pending_reconcile로 구분합니다. 공개 원본·옛 판본·카탈로그를 삭제하거나 자동 재저장하지 않습니다. 같은 pending POST도 예약 ID를 유지하며 자료를 다시 공개하지 않습니다. 응답 유실 시 본인 `GET /requests/{request_id}`를 먼저 읽습니다.
- 복구 증거: 원본 공개 뒤 카탈로그 연결 실패는 pending으로 남기며 다른 자료의 hash 일치로 성공을 만들지 않습니다. 완료 영수증 기록만 실패했으면 GET이 영구 intent·동일 actor/request/payload manifest·카탈로그 내 정확한 판본 연결·실제 원본 hash/크기를 대조해 `confirmation=intent_manifest_catalog`인 완료 증거를 반환할 수 있습니다. 이 GET은 저장 파일이나 pending 기록을 수정하지 않으며, 자료 재저장/새 ID/기준값 교체로 복구하지 않습니다. 카탈로그 연결이 없어 확정하지 못한 경우의 운영 조정 기능은 후속 계약입니다. 그 상태를 전체 등록 완료나 분석 성공으로 표시하지 않습니다.
- 한도: 영구 원본200MiB/tenant(공개됐지만 카탈로그가 없는 orphan도 합산), 별도 `_incoming`64MiB, 등록1000·판본100/source·요청10000/tenant·파일 탐색50000항목·개별 JSON1MiB·전체 카탈로그 metadata16MiB를 적용합니다. 원본 수신 예산과 영구 quota를 분리해 보관량이 가득 차도 같은 요청의 재확인을 막지 않습니다. 한도 초과 시 기존 자료를 삭제·잘라내거나 원장을 초기화하지 않습니다. 무제한 보관/자동 수집이 아니며 설정/확대는 별도 결정입니다.
- 조회: source 목록은 ID 순·기본20/최대50·현재 인가 범위와 카탈로그 기준에 묶인 cursor를 사용합니다. 빈 저장소의 조회는 폴더/조정 lock을 만들지 않습니다. 자료 손상·unsafe path·한도는 명시 오류로 반환하며 빈 성공으로 바꾸지 않습니다. `documents`는 등록 원본이 있으면 source 항목과 기존 unlinked wiki 항목을 함께 안정 정렬하고 두 기준을 묶습니다. 원본 등록 전의 유효한 Wiki cursor도 최초 등록 뒤에는409 재조회가 필요합니다. 계보 없는 문서는 유지하고 이름/내용 유사도로 파생 문서를 추측하지 않습니다. 아직 분석/위키 연결이 없으므로 source의 documents는빈배열·analysis_status는not_started입니다.
- 다운로드/정리: 허용 tenant의 정확한 source/version을 카탈로그·manifest·실제 원본의 hash/크기로 검증한 후 열린 descriptor에서 스트리밍합니다. 서버 경로/영구 공개 URL·redirect는 없으며 UTF-8 text MIME·attachment·크기/hash·nosniff·no-store 헤더를 제공합니다. 원본20MiB 스트림은 JSON16MiB 응답 버퍼와 분리합니다. 수신 중단/초과/취소와 전송 중단에도 이 요청의 spool·staging·열린 descriptor를 정리하며 이미 공개된 원본과 영수증은 보존합니다. 정리 실패는 저장 성공 또는 원래 오류와 구분하고 안전한 상대 경로·오류 종류·errno만 전달합니다. 기존 파일을 임의로 일괄 청소하지 않습니다.

원본 등록·판본 변경·위키 저장·AI 분석은 각각 별도 완료입니다. 새 판본 추가는 기존 본문/그래프/검토 승인과 그 기준 판본을 자동 변경하지 않습니다. 이번 구현에서 `_jobs`·추출물·공통 규약·MCP 새 도구·CLI/PTY·Electron 화면·운영 권한 부여는 시작하지 않습니다. 실행은 [README](../../../README.md#원본-등록업로드), 실제 검증과 남은 범위는 PLAN (정리로 삭제된 참고 자료)에 둡니다.

#### Electron 원본 미리보기의 관점 query 보완 (2026-10-25)

원본 상세와 정확한 판본 파일 GET에 선택적 profile query를 허용해 Electron의 선택 관점과 실제 authorized 정책 검사를 일치시킵니다. 생략 시 기존 기본 관점을 유지하며 권한 거부 뒤 기본 관점으로 우회하지 않습니다. 등록/새 판본/영수증/목록 query는 변경하지 않습니다. UI는 카탈로그의 선택 판본 정보와 파일의 실제 크기/hash를 대조하고 파일 전송 후 현재 접근 범위를 재확인합니다. 조회는 원본 저장/등록 revision·과거 판본을 갱신하지 않습니다. 구현 검증은 HISTORY (정리로 삭제된 참고 자료), 화면 표시는 [ui 결정](../ui/DECISIONS.md)을 따릅니다.

#### Electron 원본 등록 동선 (2026-10-25)

Electron main은 현재 확정된 연결/tenant에서 native 선택 파일의 UTF-8 snapshot 또는 직접 입력을 기존 POST /sources로 한 번 전송합니다. 파일 참조는 main이 발급하고 경로나 원본 전체를 IPC/base64로 노출하지 않습니다. 응답의 hash/크기와 요청 ID·주체·tenant·완료 영수증을 대조합니다. 쓰기/본인 영수증 endpoint는 기존 기본 관점 계약을 유지하고 선택 관점의 허용 여부/정책은 별도로 재확인합니다. 네트워크/응답 오류의 미확정 및202 조정 대기는 같은 본인 요청의 GET 영수증으로 확인하며 자동 재등록하지 않습니다. 저장/목록 실패·정리 경고·분석 완료를 구분하고 기존 원본 판본을 수정하지 않습니다. UI 완료 처리는 [ui 결정](../ui/DECISIONS.md)을 따릅니다.

#### 업로드·목록·작업 API와 권한

**일반 API와 MCP는 같은 위키 백엔드의 두 진입점**입니다. 별도 파일 서버·다른 데이터 사본·UI 전용 무인증 조회 경로를 만들지 않습니다. 현재 `core/mcp_server.py`의 HTTP 실행은 MCP 전송이며 아래 일반 API가 이미 구현됐다는 뜻은 아닙니다.

바이너리는 Electron main이 같은 서버의 인증된 HTTPS 파일 API로 전송합니다. MCP의 JSON 인자/대화 컨텍스트에 원본 전체 base64를 넣거나 원격 PC의 `C:\\...` 경로만 보내지 않습니다. HTTP와 MCP는 같은 자료 서비스·저장 모듈·접근 정책을 재사용하며 별도 무인증 파일 서버를 만들지 않습니다. 아래 이름/경로는 **후속 구현의 계약 이름**이며 현재 명령이나 도구 목록에 추가됐다는 뜻이 아닙니다.

| 표면 | 설계할 요청과 반환 |
| --- | --- |
| HTTP `GET /api/v1/access-context` | Electron이 현재 서버 인증 주체·허용 tenant/관점·행동을 조회. MCP `access_context`와 같은 `AccessPolicy.describe()` 계약을 사용하며 사용자 ID를 요청 인자로 대체하지 않음 |
| HTTP `POST /api/v1/tenants/{tenant}/sources` | 파일 multipart 또는 직접 입력 JSON을 수신. `request_id`, 제목/형식과 입력 바이트를 검증하고 `source_id/source_version/source_sha256/registration_revision` 및 원본 저장 영수증 반환 |
| HTTP `POST .../sources/{source_id}/versions` | `expected_registration_revision`에서 새 원본 판본 추가. 같은 request_id의 중복 전송과 원본 교체 충돌을 구분. 기존 판본/파생 본문은 보존 |
| HTTP `GET .../sources` 및 `GET .../sources/{source_id}` | 페이지 있는 등록 목록과 원본 판본/변환/파생 문서·처리 상태 조회. 아래 목록 계약을 적용 |
| HTTP `GET .../documents` | 등록 원본과 기존 위키 문서를 함께 발견하는 Electron 문서 목록. 원본만 있는 항목·1:N 파생 문서·원본 연결 없는 기존 문서를 포함하며 아래 페이지/완전성 계약을 적용 |
| HTTP `GET .../documents/content?document=...`, `GET .../documents/knowledge?document=...` | 서버가 검증한 상대 문서 참조로 최신 본문/revision 및 그래프/검토 상태를 조회. 기존 WikiStore·ReviewStore 조회를 재사용해 `effective_graph/policies`·미검토·pending·source/graph/state revision·완전성을 반환하며 machine층을 현재 유효 지식으로 대신하지 않음 |
| HTTP `GET .../sources/{source_id}/versions/{source_version}/file` | 권한 확인 후 해당 판본의 원본 스트리밍. 서버 파일 경로/영구 공개 URL을 응답하지 않음 |
| HTTP `POST .../analysis-jobs`, `GET .../analysis-jobs`, `GET .../analysis-jobs/{job_id}` | 분석할 원본 판본·예정 문서/범위·원하는 산출물에서 작업 생성, 허용 작업의 페이지 목록/단건 상태 조회. 목록은 주체·대상·상태 필터와 서버 관측 상태/영수증을 사용하며 필터별 노출·cursor/예산은 구현 전에 고정. 생성 자체로 CLI/AI를 실행하거나 성공 판정하지 않음 |
| HTTP `POST .../analysis-jobs/{job_id}/heartbeat`, `POST .../analysis-jobs/{job_id}/cancel` | heartbeat는 인증 주체·run_id·expected_lease_revision으로 서버 시각의 lease 갱신. cancel은 expected_job_revision으로 후속 단계 중단을 기록. 만료/취소된 시도의 새 저장은 거부하며 완료된 저장을 되돌리지 않음 |
| HTTP `GET .../requests/{request_id}` | 응답을 받기 전에 끊겨 source/job ID를 모를 때 인증 주체·tenant에 묶인 요청 영수증과 예약 ID/처리 상태 조회. request_id만 알아도 다른 주체의 요청을 읽을 수 있는 기능이 아님 |
| HTTP `POST .../analysis-jobs/{job_id}/artifacts` | 호스트 bridge가 CLI의 큰 표/페이지 이미지 등 산출물 파일을 같은 서버에 업로드. 현재 권한·본인 job/run·입력 묶음·job 기준·lease/취소를 검사하고 불변 artifact ID/hash·영수증 반환. 업로드만으로 본문/그래프 저장이나 입력 묶음 교체를 하지 않음 |
| HTTP `GET .../extractions/{extraction_id}`, `GET .../extractions/{extraction_id}/content` | Electron이 불변 extraction의 manifest·원본/실행 계보·범위/경고/완전성과 문자/표 내용을 조회. MCP `source_extraction_read`와 같은 자료 서비스·현재 tenant read 검사를 사용. 내용은 extraction/hash·구성에 묶인 고정 페이지/cursor로 읽고 next/complete/truncated/skipped를 반환하며 일부 페이지만 읽고 전체로 표시하지 않음 |
| HTTP `GET .../extractions/{extraction_id}/artifacts/{artifact_id}` | 허용 tenant의 공개된 불변 extraction에 실제 연결된 산출물만 인증 스트리밍. 미제출 staging 파일/다른 extraction 참조를 허용하지 않고 호스트가 반환 hash와 실제 바이트를 대조 |
| 새 MCP `source_read`, `source_extraction_read` | 고정 원본 metadata/판본/hash·파일 참조와 이미 제출된 불변 추출물의 범위/완전성·출처를 읽음. 파일 참조는 같은 서버의 인증된 파일 API로 호스트가 받으며 서버 변환을 실행하지 않음 |
| 새 MCP `source_extraction_submit` | 본인 job/run·파일 읽기 입력 묶음·`expected_job_revision`에서 CLI의 문자/표·산출물 참조·읽기/변환 manifest를 제출. 서버가 원본 기준·범위·hash·형식/한도·artifact 소속을 검증하고 불변 extraction ID/hash·새 job_revision·영수증 반환. 본문/그래프 저장과 구분 |
| 새 MCP `analysis_job_claim`, `analysis_job_query` | 해당 인증 사용자의 작업을 CLI 실행에 원자적으로 연결하고 입력 기준/시도 ID/실행 상태 조회. 작업 ID를 권한으로 사용하지 않음 |
| 새 MCP `analysis_job_update` | run_id·expected_job_revision에서 CLI의 분석 시작/중단·오류/차단 사유를 제한된 상태로 보고. CLI 보고와 서버 저장 영수증을 구분하며 완료/저장 성공을 임의 선언할 수 없음 |
| 새 MCP `analysis_job_wiki_write`, `analysis_job_ontology_generate` | job/시도·원본/등록 기준에 결과를 연결하는 저장 래퍼. 본문은 기존 `WikiStore.save()`, 그래프는 기존 `OntologyStore.generate()`를 재사용하며 현재 `wiki_write`/`ontology_generate` 인자에 임의 필드를 추가하지 않음 |

원본 읽기·다운로드·문서/등록/작업 목록·본문/지식 조회는 허용 tenant의 `read`로 처리합니다. **`source_write` 권한**의 원본 등록/판본 추가 경로와 정책 parser를 구현했습니다. CLI 추출물/산출물 제출·보관은 후속 설계이며 canonical 위키/그래프/검토 쓰기를 부여하지 않습니다. 로컬 도구 실행 능력은 서버 쓰기 권한이 아니며 read만 가진 CLI가 추출물을 서버에 제출하지 못합니다. 위키 저장에는 기존 `write`, 그래프 저장에는 기존 `ontology_write`, 검토/전문가 판단에는 종전 별도 권한을 사용합니다. 작업 생성/claim/단계 진행은 본인 작업과 그 단계에서 필요한 권한을 검사하며 권한을 다른 실행자에게 양도하는 큐로 사용하지 않습니다. 새 권한의 실제 부여는 별도 운영 요청이며 현재 read13을 이 권한으로 해석하거나 자동 확장하지 않습니다.

HTTP의 입구 인증만으로 tenant/행동을 승인하지 않습니다. 각 HTTP·MCP 요청에서 현재 `AccessPolicy.authorize()`의 사용자·tenant·행동을 확인하고 프로필은 조회 관점으로만 사용합니다. 지식 조회는 허용 profile을 선택해 기존 검토/정책의 적용 범위를 보존합니다. CLI의 claim 주체와 이후 저장 주체가 다르면 거부합니다. 작업 생성 당시 권한은 다음 단계의 권한을 보장하지 않습니다. 새 HTTP 경로에는 Host/Origin·실제 수신 바이트·형식과 파일별 요청 한도를 별도로 적용하며 기존 `/mcp`의 보호·8 MiB 요청 한도가 파일 API에도 자동으로 적합하다고 가정하지 않습니다.

다른 PC의 Electron main과 그 안의 CLI는 **같은 위키 백엔드의 일반 API/MCP 주소**를 사용하도록 각각 연결합니다. UI는 HTTP access-context, CLI는 MCP `access_context`로 실제 서버 사용자/허용 tenant를 확인하고 작업 접수 주체를 대조합니다. 각 PC에서 별도 위키 서버/공식 자료 복사본을 만들어 동기화하지 않습니다. 위키 접근 비밀은 호스트의 보호된 저장소/설정에서 읽고 renderer·요청문·PTY 입력에 넣지 않습니다. 현재 Mac의 로컬 stdio 연결이 이 원격 설정으로 자동 전환됐다는 뜻은 아니며 실제 주소·인증 발급·원격 전환은 별도 구현/배포 gate입니다.

CLI가 파일을 읽어야 할 때 MCP에서 받은 `tenant/source_id/source_version/source_sha256`을 제한된 호스트 다운로드 bridge에 전달합니다. bridge는 설정된 같은 서버의 인증된 파일 API에서 해당 판본만 받아 실제 바이트 hash를 대조하고 사용자 PC의 앱 전용 비공개 작업 디렉터리에 둡니다. 임의 URL·다른 서버 리디렉션·서버 절대 경로·파일명으로 조립한 셸 명령을 실행하지 않습니다. 로컬 작업 경로는 CLI 도구 입력으로만 쓰고 서버 계보/규약/공유 문서에 넣지 않습니다. 같은 PC에서 방금 고른 파일도 서버 영수증의 판본/hash와 실제 바이트를 확인한 뒤에만 재사용합니다. 작업용 사본은 공유 저장소나 폴더 동기화본이 아니며, 실패/미확인 초안을 보존하고 서버 제출 영수증을 확인한 뒤 해당 작업의 임시 파일만 정리합니다.

초기 설계 상한은 원본 **20 MiB**, CLI 추출 출력 합계 **64 MiB**, 로컬 읽기/변환 도구 실행 **120초/500페이지**입니다. 로컬 실행 상한은 CLI 어댑터가 적용하고 서버는 실제 수신 크기·형식/범위·manifest를 검사하며 자기보고만으로 실행 시간을 증명하지 않습니다. 이 시간은 AI 전체 작업 시간 제한이 아닙니다. 원본/추출물 한도는 기존 위키 **문서당 UTF-8 1 MiB**·현 MCP HTTP 요청 **8 MiB**와 별개입니다. 큰 산출물은 같은 파일 API로 올린 뒤 MCP로 참조/manifest를 제출하며 요청 한도를 우회하는 거대한 base64를 만들지 않습니다. 한도 초과는 자르기/기존 자료 삭제 없이 중단/범위 확인으로 표시합니다.

서버는 원본 보관 가능 여부를, 공통 규약과 CLI 어댑터는 실제 파일 읽기 지원을 각각 표시합니다. 첫 구현은 `.md/.txt`의 유효한 UTF-8이며 PDF·Word·Excel·Numbers·이미지는 별도 검증 대상입니다. PDF 문자/페이지 읽기, Excel 시트/셀/수식 읽기, 스캔 OCR·이미지/도형 해석은 지원하는 로컬 도구와 CLI 이미지 입력을 연결해 검증해야 합니다. 서버에 파일이 있다는 이유만으로 CLI가 읽었다고 표시하지 않으며 지원/입력 한도가 확인되지 않으면 `conversion_required` 또는 범위 확인으로 멈춥니다. 본문 구성은 원문의 조건·표·인용 위치를 보존하고 원문을 요약문으로 대체하지 않습니다. 이 상한·형식 경로의 실제 성능/정확도는 미검증입니다.

#### 업로드 이후 CLI 요청과 MCP 저장 순서

1. **일반 API로 등록:** Electron이 파일 또는 직접 본문을 업로드하고 원본 저장 영수증을 확인합니다. 응답에는 인증 주체·tenant·원본 ID/판본/hash/크기·카탈로그 revision·저장 상태·정리 경고를 담으며 토큰/클라이언트 절대 경로를 기록하지 않습니다. 원본만 있는 등록 항목도 일반 목록 API로 바로 표시합니다. ‘등록만’은 여기서 끝나고 ‘등록 후 추출’은 이 성공 확인 뒤 같은 후속 작업을 시작합니다. 두 동선을 별도 추출 구현으로 나누지 않습니다.
2. **일반 API로 요청 준비:** 사용자가 기존 등록의 ‘추출 시작’을 누르거나 ‘등록 후 추출’로 이어오면 Electron이 고정 원본 판본과 원하는 본문/전체 그래프·명시적 분할 범위로 작업을 만듭니다. 입력 manifest에는 `job_id`, tenant, source 참조, 관측한 registration revision, 기존 `document/source_revision/graph_revision/state_revision`, 요구 산출물과 요청 범위를 묶습니다. profile은 답변/검토 우선순위이며 전체 원문 추출 범위를 줄이지 않습니다.
3. **Electron이 로컬 터미널 인계:** 기존 xterm → 제한된 preload → main의 node-pty → 개인 CLI를 사용합니다. main이 사용자 PC에서 새 CLI 세션을 열거나 사용자가 명시 선택한 세션에 작업 ID를 포함한 요청을 준비합니다. 초기 동선은 사용자가 CLI에 제출하며 자동 전송은 해당 CLI의 입력 대기 상태를 확인하는 어댑터를 검증한 뒤에만 추가합니다. 따라서 ‘등록 후 추출’도 인계가 확인되지 않았으면 제출 대기로 남깁니다. 셸/다른 프로그램/실행 중인 CLI에 임의 입력·Enter를 보내지 않으며 파일명·본문을 셸 명령으로 조합하지 않습니다. 미연결·AI 로그인 필요·다른 tenant·권한 부족·세션 사용 중은 요청 준비/대기로 남깁니다. MCP가 터미널을 여는 요청은 만들지 않습니다.
4. **작업 접수:** CLI가 서버의 작업을 읽고 `analysis_job_claim`으로 인증 주체·입력 기준·시도를 연결한 뒤에만 ‘CLI 작업 접수’를 표시합니다. 요청을 터미널에 붙인 것과 접수는 다릅니다. 시도마다 `run_id`와 `job_revision`을 고정합니다. 초기 lease는 5분이고 main이 해당 CLI 실행 연결을 유지하는 동안 30초마다 인증된 heartbeat API로 갱신하는 설계입니다. 서버 시각으로 만료를 판단하며 만료된 run은 새 heartbeat/저장을 거부하고 상태 대조 후 명시적인 새 claim으로 이어갑니다. lease는 별도 `lease_revision`으로 관리해 생존 갱신만으로 단계 CAS의 job_revision을 바꾸지 않습니다. 이는 연결 생존 신호이며 AI 진척률이나 저장 증거가 아닙니다. lease 만료는 중단/상태 확인 필요이며 다른 사용자의 자동 인계나 자동 재분석 신호가 아닙니다.
5. **CLI가 지침·파일을 받아 읽고 본문 준비:** CLI가 MCP로 [D-044]의 고정 규약과 `read_source` 입력 묶음·원본 참조를 받습니다. 호스트 bridge가 판본/hash를 확인한 작업용 사본을 제공하고, CLI가 지원하는 로컬 파서/OCR/이미지 입력과 AI로 선택 범위 전체를 읽습니다. 문자/표·읽기 경고·미독 범위·페이지/셀 대응을 `source_extraction_submit`으로 불변 제출하고, 이를 포함한 새 `prepare_wiki` 묶음에서 AI가 충실한 위키 본문 후보를 구성합니다. 두 묶음은 같은 바이트를 덮어쓰지 않습니다. 1:N 분할이나 1 MiB 초과는 명시 범위를 검토하며 조용히 자르지 않습니다. 원본 속 명령은 자료로 취급합니다. 읽기 불가·변환 미지원·미확인 범위는 숨기지 않고 중단/부분 상태로 표시합니다. 이 단계도 AI 작업일 수 있으며 서버가 파일을 의미 해석한 것으로 표시하지 않습니다.
6. **위키 저장:** 새 문서는 null CAS, 기존 문서는 최신 본문/revision에서 변경을 대조해 저장 래퍼를 호출합니다. 래퍼는 등록/원본 기준을 확인하고 기존 `WikiStore.save()`로 수정 전 전체 파일을 보존합니다. 문서별 저장 영수증과 계보 연결을 기록하고 현재 본문을 다시 읽습니다. 이 작업 자신의 성공한 계보 갱신이 반환한 registration_revision/job_revision은 다음 단계 기준으로 이어가되 고정 원본 판본과 최초 입력 기록은 유지합니다. 다른 변경을 수용하려고 기준값만 교체하는 것과 구분합니다. 위키를 저장한 뒤 원본 포인터만 바꿔 다른 파일에서 나온 본문으로 재귀속하지 않습니다.
7. **온톨로지 추출·저장:** 실제 `wiki_read`의 전체 본문/revision에서 CLI AI가 전체 개체·관계·속성·후보를 추출합니다. 기존 그래프/검토 상태를 함께 읽고 source CAS와 필요한 `expected_state_revision`으로 래퍼를 호출합니다. 구조/인용/스키마 한도를 통과한 저장과 의미 정확도/전문가 승인은 구분합니다. 실패 때문에 이미 성공한 위키 저장을 반복하지 않습니다.
8. **Electron이 일반 API로 결과 확인:** 서버가 요청한 각 문서·단계의 영수증/실제 revision을 확인해 완료·부분 완료·결과 미확인을 구분합니다. Electron은 작업·문서 목록·본문·지식 조회 API로 화면을 갱신하며 MCP/AI 호출을 요구하지 않습니다. 백엔드가 기존 `ontology_review_query`와 같은 조회 모듈로 계산한 effective_graph/policies·미검토·pending을 사용하고, 터미널의 ‘완료’ 문구·CLI 종료 코드만으로 저장 성공/사람 승인을 만들지 않습니다.

#### 작업 상태·영수증·부분 실패

원본/본문/그래프/카탈로그의 저장을 하나의 원자 거래로 표현하지 않습니다. `_jobs`는 각 단계의 기준·payload hash·시작/결과·실제 actor·서버 시각·시도·영수증·경고를 보존하는 실행 기록이며 전문가 판단의 `_reviews` Action log가 아닙니다. 클라이언트의 완료 주장으로 저장 상태를 바꾸지 않습니다.

| 서버/화면 상태 | 뜻과 다음 동작 |
| --- | --- |
| 업로드 중 / 원본 보관 완료 | 로컬 전송 진행과 서버의 공개/영수증을 구분. 보관 완료여도 본문/그래프 없음 |
| CLI 요청 준비 / 접수 대기 | 작업 입력은 고정됐으나 CLI claim 없음. 미연결·로그인·권한·사용 중의 이유 표시 |
| CLI 작업 접수 / 본문 준비 / AI 분석 중 | 같은 인증 주체/run에 연결된 단계. 통신 유지와 의미 추출 진척률을 혼동하지 않음 |
| 본문 저장 / 그래프 저장 / 결과 확인 | 문서별 단계 영수증으로 표시. 요청의 전체 대상 수와 성공/실패/미시도 수를 함께 유지 |
| 완료·미검토 | 요청한 저장 단계를 확인한 결과. 그래프 ready는 원문 버전 일치이며 내용 정확도/전문가 승인이 아님 |
| 부분 완료 / 변환 필요 / 한도·범위 확인 필요 | 성공한 원본·본문·일부 문서를 유지. 실패/미시도 단계와 읽지 못한 범위를 표시하고 그 단계에서 재개 |
| 기준 변경 / conflict / 권한 차단 | 새 원본·본문·그래프/검토 또는 권한을 대조할 때까지 기존 초안 보존. 기준값만 갈아 끼우지 않음 |
| 실행 중단 / 취소 | CLI/PC 종료·사용자 취소 뒤 더 진행하지 않음. 완료된 서버 저장은 유지하며 자동 rollback/재실행 없음 |
| 결과 미확인 / pending_reconcile | 통신 유실 또는 자료 저장 뒤 영수증/카탈로그 갱신 실패. 재조회로 확인하기 전 쓰기 재전송 금지 |

`request_id`는 tenant·인증 주체·동작·payload hash에 연결하는 멱등 키로 구현합니다. 같은 키/같은 입력의 확인된 요청은 기존 ID/영수증을 반환하고, 같은 키/다른 입력은 거부합니다. **작업 ID만 추가한다고 정확히 한 번의 저장이 보장되지는 않습니다.** 단계별 intent를 먼저 기록하고 저장 결과를 기록하는 사이의 장애를 복구 대상으로 둡니다. 자료 저장 뒤 기록만 실패하면 자료를 되돌리거나 다시 쓰지 않고 `pending_reconcile`로 둡니다. 영수증이 없는데 현재 내용 hash가 같다는 이유만으로 이 요청의 성공/작성 주체를 확정하지 않습니다.

새 등록/작업 경로는 tenant별 별도 조정 잠금에서 원본 현재 판본 변경·claim·heartbeat·cancel과 저장 래퍼의 기준 확인/실행을 직렬화합니다. 잠금 순서는 항상 **등록/작업 조정 잠금 → 기존 저장 모듈의 잠금**이며 역순 획득을 금지합니다. 조정 잠금 안에서 현재 권한·registration/job 기준·run·취소·서버 시각의 lease를 확인하고 단계 intent를 기록한 뒤 기존 `save()`/`generate()`를 호출해 저장 결과를 기록합니다. `WikiStore.save()` 바깥에서 같은 비재진입 저장 잠금을 다시 잡는 중첩 호출로 구현하지 않습니다. 일반 기존 위키/검토 쓰기는 종전 저장 잠금과 source/state CAS로 경쟁을 검사합니다.

만료/취소/새 판본이 이 단계의 실행 승인 전에 반영됐으면 저장 호출을 거부합니다. 이미 승인해 시작한 저장은 도중 강제 rollback하지 않으며, 조정 잠금에서 기다리던 취소/새 판본은 해당 저장 결과 기록 뒤 적용해 후속 단계를 막습니다. lease 만료 직전에 시작한 저장도 실제 결과를 보존하고 다음 호출에서 만료를 검사합니다. 원본 공개·카탈로그·작업 기록과 기존 위키/그래프 저장 사이의 장애를 실제 실패 주입으로 검증하기 전에는 여러 파일의 원자성/자동 복구를 약속하지 않습니다. 오래된 실행이 새 원본/본문을 현재 결과로 덮지 않도록 registration/job 기준과 기존 source/state CAS를 함께 대조합니다.

`storage_busy`는 같은 기준으로 나중에 재시도할 수 있습니다. conflict는 최신 본문·그래프·검토와 초안을 대조해 재반영/재추출합니다. 성공의 `cleanup_failures`는 경고이며 쓰기 재전송 사유가 아닙니다. 원본 업로드·위키 저장이 성공한 뒤 그래프/영향/목록 조회가 실패해도 성공 단계를 반복하지 않습니다. 취소·앱 종료는 이미 완료된 저장을 지우지 않고, 재연결 시 job/자료를 읽어 실패/미시도만 명시적으로 재개합니다. 새 판본에서 옛 승인·후보 답·전문가 정책을 자동 이식하지 않습니다.

#### 문서 목록·결과 표시와 UI 인계

- 목록의 상위 항목은 등록 원본이며 하위에 파생 위키 문서를 펼칩니다. 제목·원본 종류·원본 판본·본문 기준 판본·작업 상태·그래프 최신/미생성/stale·미검토/재검토를 보여 줍니다. 원본만 등록된 항목과 1:N 문서도 발견 가능해야 합니다. 상세에서 원본 판본 다운로드, 준비 본문/변환 경고, 위키 전체 본문, 그래프·근거·현재 판단/이력으로 이어갑니다.
- 목록은 tenant 안의 등록 카탈로그와 기존 wiki 문서를 함께 발견합니다. 기존 세 위키처럼 원본 계보가 아직 없는 문서는 ‘원본 연결 없음’으로 표시하고 누락시키지 않습니다. 이름이 비슷하다고 기존 원본과 자동 연결하지 않습니다. `wiki_search(".md")`를 전용 전체 목록/페이지 API로 취급하지 않습니다.
- 기본 20/최대 50항목, 안정 정렬과 `catalog_revision`·마지막 키에 연결한 불투명 cursor를 설계합니다. 응답은 `next_cursor/complete/truncated/skipped`와 적용 필터를 반환합니다. 페이지 사이 자료/권한 변경은 재조회/부분 결과로 드러내며 전체 시점 고정이나 전체 영향 없음으로 과장하지 않습니다. 사용자/tenant별 캐시를 분리하고 프로필은 자료 접근 필터로 사용하지 않습니다.
- 초기 갱신은 일반 API로 실행 중 작업의 metadata를 5초 간격, 보이는 목록을 30초 간격/화면 복귀 시 다시 읽는 방식으로 설계합니다. 숨긴 화면의 불필요한 조회를 멈추고, 쓰기 직후 관련 항목을 무효화합니다. 알림 전송은 후속 선택이며 최초 구현에 SSE/WebSocket을 필수로 넣지 않습니다. 원본 파일을 주기적으로 다시 내려받아 PC 폴더와 동기화하지 않습니다. 선택한 본문/그래프의 바뀐 버전만 가져오고 편집 초안은 보존합니다. 개인 CLI를 종료해도 다른 허용 사용자의 목록·기존 결과 조회는 계속 동작해야 합니다.
- CLI 로그인/연결 상태, 서버 로그인/tenant/권한, 업로드/본문 준비/분석/저장 상태를 각각 표시합니다. 내부 ID·물리 파일 경로·프로토콜을 기본 사용자 화면에 반복하지 않고 상세/지원 정보로 제공합니다. 새 원본만 교체된 상태, 일부 문서 저장, 변환 미지원, 결과 미확인에서 다음 행동을 명확히 합니다.
- 등록 요청은 선택한 파일/입력 종류·본문·판본의 스냅샷에 묶습니다. 업로드 응답을 기다리는 동안 입력을 바꿔도 영수증을 새 입력의 결과로 붙이거나 초안을 잃지 않습니다. 파일 첨부에서 직접 본문 입력으로 전환할 때 이전 파일명/자동 읽기 본문을 새 텍스트 원본의 출처로 옮기지 않습니다. 결과 상세는 저장 당시 영수증과 현재 본문·그래프·검토 상태를 따로 보여 줍니다.
- UI 디자인 담당은 기존 **‘위키 사용 사례 목록화’** 채팅입니다. [D-039]의 1920×1080·UC-01~19·온톨로지/근거·전문가 판단 구분을 보존하면서 이 흐름을 적용합니다. 일반 API 등록/목록 → Electron의 로컬 CLI 요청 준비/접수 → CLI의 MCP 추출·저장 → 일반 API 작업/결과 → 문서/그래프/이력 이동을 기준으로 삼고 모의 연결과 실제 서버 영구 저장을 구분합니다. 앞선 시안 검증은 당시의 모의 동선이며 이번 API/CLI 책임 변경의 실제 연결 검증으로 재사용하지 않습니다. 이번 개정은 계획/결정 문서만 수정하며 다른 채팅 재지시·시안/앱 구현은 실행하지 않습니다. 구체 화면 검증 결과는 [PLAN](../../PLAN.md)에 통합하고 계약을 UI 코드/별도 문서에 중복 정의하지 않습니다.

구현 순서와 완료 조건은 PLAN의 D-043 후속 범위 (정리로 삭제된 참고 자료)에서 관리합니다. 실제 배포 위치/계정 제공자·운영 권한 부여, CLI별 로컬 파일 읽기/이미지·다운로드 bridge·추출물 업로드·자동 인계 어댑터와 패키징은 미결/미구현이며 다음 단계를 자동 시작하지 않습니다.

### D-054 — DOCX·이미지의 불변 원본 보관과 개인 변환 보고 (2026-10-25)

업무 문서와 스캔 이미지도 기존 원본 판본·실제 바이트 hash·CAS·영수증으로 보관합니다. 서버는 변환문으로 원본을 대체하지 않고 개인 PC가 보고한 문자·위치를 별도 불변 입력으로 연결합니다. 이유는 원본 보관의 검증과 문서 해석의 책임을 분리하면서 기존 저장·현재 권한·응답 유실 확인 경로를 재사용하기 위해서입니다.

- 형식: 기존 MD/TXT/PDF/XLSX에 DOCX·PNG·JPEG(`jpg/jpeg`)·GIF·WebP·BMP·일반 TIFF(`tif/tiff`)를 추가합니다. 확장자는 대소문자를 구분하지 않으며 파일명은 경로 없는 표시 이름입니다. JSON 직접 입력은 MD/TXT만 허용하고 바이너리는 기존 multipart를 사용합니다. HEIC/SVG/구형 DOC/BigTIFF 등은 이번 범위에 포함하지 않습니다.
- 형식 확인: 이미지 magic bytes, WebP의 RIFF/WEBP/chunk 표식, DOCX의 ZIP 서명과 `[Content_Types].xml`·`_rels/.rels`·`word/document.xml` 표식을 확인합니다. DOCX 압축 항목은 최대10,000개, content-types는 최대256KiB이며 중복 항목·암호화된 필수 표식·DTD·일반 ZIP/XLSX·매크로 전용 Word content-type을 거부합니다. 본문/이미지 전체 디코딩·악성 파일 검사·외부 관계 처리·OCR은 실행하지 않고 압축 파일도 디스크에 풀지 않습니다. 식별 통과가 문서 전체의 유효성·안전을 보증하지 않습니다.
- 보존: 원본20MiB·전송24MiB·tenant200MiB 등 D-043 한도를 유지합니다. staging에서 원래 바이트의 크기/hash를 계산하고 기존 commit이 현재 권한·CAS·intent·불변 판본·카탈로그·영수증을 처리합니다. 다운로드도 정확한 원본 바이트와 형식 MIME·attachment·nosniff·no-store를 반환합니다. 새로운 변환 서버/경로/의존성은 추가하지 않습니다.
- 변환 보고: `docx_text`는 `whole`, 1부터 시작하는 `paragraphs`/`blocks`의 start/end, 별도 `table_cells`의 table/row/column 위치를 받습니다. 표는 Excel sheet/A1 범위와 구분하며 본문 문단/표 순서를 위치와 제출 단위 순서에 보존합니다. 이미지 `ocr`는 `whole` 또는 프레임/페이지를 나타내는 `pages`를 받습니다. 기존 PDF/Excel/텍스트 보고의 모양은 유지합니다. 계획은 보고된 정확한 위치를 선택하고 부분 보고·미독·다른 원본 기준은 기존 규칙으로 막습니다.
- 보고의 의미: 위치와 문자는 `client_reported`, 범위는 `reported_units_only`, 원본 전체 포함은 `not_verified`, 의미 검사는 `not_run`으로 유지합니다. 형식/위치 모델 추가는 온톨로지 의미나 추출 규칙 변경이 아닙니다. 바이너리의 직접 텍스트 분석은 거부하며 고정 변환 보고와 분석 계획을 거쳐야 합니다.

일반 API는 기존 등록/판본/상세/다운로드/영수증을 재사용하며 새 MCP 도구를 복제하지 않습니다. UI·개인 변환기의 실제 통합과 운영 배포는 별도 담당 범위입니다. 실제 검증·실패 및 미실행은 HISTORY (정리로 삭제된 참고 자료)에 기록합니다.

[D-033]: ../ui/DECISIONS.md#d-033--정책을-추적한-ui-시안과-구현-경계-2026-10-23
[D-038]: ../correspondences/DECISIONS.md#d-038--문서-간-조건개념-대응-판단의-최소-계약-2026-10-23
[D-039]: ../ui/DECISIONS.md#d-039--유스케이스에-따른-ai-온톨로지-중심-화면-구성-2026-10-23
[D-040]: ../knowledge/DECISIONS.md#d-040--개념-중심-최신-지식-통합-조회-2026-10-23
[D-041]: ../access/DECISIONS.md#d-041--개인-인증-tenant-연결-전환과-보존복구-절차-2026-10-23
[D-042]: DECISIONS.md#d-042--첫-업무-자료의-선정등록-범위와-최소-쓰기-권한-2026-10-24
[D-044]: ../analysis/DECISIONS.md#d-044--mcp-공통-추출-규약맥락과-분석-입력-버전-관리-2026-10-24

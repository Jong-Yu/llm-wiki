# LLM Wiki

문서를 저장하고 관계를 추출하며, 저장된 지식에 근거해 개인 AI CLI로 질문·분석을 수행하는 프로젝트입니다. Electron 앱은 FastAPI로 자료를 조회·변경하고, 개인 실행기는 MCP의 규약과 저장 계약을 사용합니다.

제품의 목적·동작 원리·지향점은 [LLM Wiki 이해하기](docs/INTRODUCTION.md)에서 읽을 수 있습니다. 처음 사용하는 방법은 앱의 **사용자 가이드** 또는 실제 화면의 조작 위치를 짚어 주는 [화면 가이드](docs/guide/index.html)에서 확인합니다. 앱에서는 로그인 전에도 가이드를 열 수 있습니다. 기능별 상세 절차와 오류 해결은 [사용자 가이드](docs/USER_GUIDE.md), 제품 개념·기능 명세·처리 흐름·추출 방침·시스템 구조는 [제품 및 개발 명세](docs/reference/README.md)에서 확인합니다.

## 실행에 필요한 구성

Python 코드의 위치와 실행 흐름은 [core 길잡이](core/README.md)에서 설명합니다.

- `core/`: 서버, MCP, 업무 저장 모듈, 개인 AI 실행기.
- `tools/`: 설치·진단·분석·변환·규약 관리와 서버 배포 명령.
- `app/`: Electron 소스, 의존성, 빌드 설정과 `out/` 실행 결과.
- `data/<workspaceId>/`: 현재 자료, 원본 판본, 문서 전체 이력과 업무 원장.
- `.local/tenancy/access.json`, `.local/tenancy/credentials/`: 현재 권한 정책과 개인 인증정보.
- `.venv/`, `.local/python-recovery-20261027/runtime/`: 현재 이 컴퓨터의 Python 실행 환경. `.venv/bin/python3`는 해당 runtime을 가리킵니다.
- `.agent/`, `.agents/`, `.codex/`: 분석 의미 지침, 연결된 AI 스킬·역할과 로컬 MCP 연결 설정.
- `docs/domains/`: AI 스킬과 작업 규칙에서 참조하는 현재 계약·규칙·계획.

비밀 값과 개인 자료는 Git에 포함하지 않습니다. 새 컴퓨터의 실행 환경은 아래 설치 명령으로 준비하며 기존 자료·정책·토큰은 자동으로 대체하지 않습니다.

## 프로젝트 스킬

요청에 맞는 스킬을 사용하며 실제 호출 가능 여부는 연결된 MCP 도구와 현재 권한으로 확인합니다.

| 스킬 | 용도 |
| --- | --- |
| [wiki-query](.agents/skills/wiki-query/SKILL.md) | 현재 지식·질문 근거·검토함·이력 조회 |
| [wiki-edit](.agents/skills/wiki-edit/SKILL.md) | 본문 작성·수정과 판본 비교·복원 |
| [wiki-review](.agents/skills/wiki-review/SKILL.md) | 원문 검토·전문가 판단·관계 추가·Clean Up |
| [wiki-analyze](.agents/skills/wiki-analyze/SKILL.md) | 분석 작업 조회·준비·실행·취소와 온톨로지 추출 |
| [wiki-diagnose](.agents/skills/wiki-diagnose/SKILL.md) | API·MCP·개인 실행 환경의 읽기 전용 진단 |
| [wiki-maintain](.agents/skills/wiki-maintain/SKILL.md) | 기존 호출 호환과 여러 종류 변경의 절차 연결 |

## Python 실행 환경

Python 3.12 이상을 사용합니다. 기존 프로젝트에서는 현재 `.venv`를 사용합니다. 새 환경을 설치할 때는 역할에 맞춰 다음 중 하나를 실행합니다.

```sh
python3 -m tools.setup_runtime --role personal
python3 -m tools.setup_runtime --role server
```

현재 환경과 문서 변환·OCR 준비 상태를 진단합니다.

```sh
.venv/bin/python -B -m tools.runtime_doctor --skip-ai
```

AI 기능에는 사용자가 로그인한 Codex CLI 또는 Claude Code CLI가 필요합니다. OCR에는 Tesseract와 사용할 언어 데이터가 필요합니다. 진단은 실제 모델 실행이나 문서 저장을 수행하지 않습니다.

DOCX와 XLSX는 외부 변환 프로그램 없이 Python 패키지(`python-docx`, `openpyxl`)로 읽습니다. 내보내기(Word·PDF·Excel·PowerPoint)도 앱에 포함된 라이브러리로 만들며 별도 설치가 필요 없습니다. 진단의 `conversion.packages`에서 필요한 Python 패키지의 설치 여부와 버전을 확인합니다.

DOCX는 본문 순서를 유지해 문단과 표 셀을 각각 읽고, 위치는 문단 번호와 표·행·열 좌표로 보고합니다. 병합된 셀은 한 번만 읽습니다. 머리말/꼬리말·각주·미주·주석·변경 추적의 삽입/삭제·텍스트 상자·내장 개체·이미지 내용과 표 안의 표는 읽지 않고 미독으로 표시하며, 그런 부분이 있으면 결과를 완료로 보고하지 않습니다. 제목·목록 같은 서식은 Markdown으로 옮기지 않고 글자만 남기며 물리 페이지 좌표도 제공하지 않습니다. 변환 성공도 원본 전체 포함이나 의미 정확성의 검증을 뜻하지 않습니다. MD/TXT는 원문 바이트를 그대로 전달하고 PDF/이미지는 기존 문자 추출·OCR을 사용합니다.

XLSX는 원본을 다시 저장하지 않고 읽습니다. 먼저 시트·병합·표·숨김·서식 정보를 담은 원본 구조 기록을 두고, 이어서 값이 있는 셀마다 정확한 시트/셀 위치의 기록을 둡니다. 수식·캐시값·캐시 원문/종류를 보존하며 재계산하지 않습니다. 빈 문자열/false/0 캐시는 캐시 없음과 구별하고, 캐시가 없으면 미독으로 표시합니다. 셀 내용은 코드 블록에 담아 원문의 Markdown 기호가 문법으로 사라지지 않게 합니다. 표 모양으로 다시 배치한 읽기용 보기는 만들지 않습니다.

병합 범위·기준셀, Excel 표의 이름/범위/열/집계 속성과 숨김 행·열·시트 정보는 MD의 원본 구조 기록에 보존합니다. 병합에 포함된 빈 칸에는 값이나 수식을 복제하지 않습니다. 겹친 병합이나 기준셀 이외의 칸에 저장된 값은 원문을 보존하고 부분 상태로 표시합니다. 원래 서식의 표시 결과·시각적 병합 배치와 외부 객체의 의미까지 검증한 것은 아닙니다.

여러 시트는 원본 순서·ID/파일 연결·공백을 포함한 정확한 이름과 이름 정의의 전체/시트 범위를 원본 구조 기록에 보존하고, 셀 기록의 위치에 시트 원명을 그대로 담아 비슷한 이름을 구별합니다. 빈/숨김 시트도 목록에서 유지합니다. 색만으로 뜻을 구분하는 자료를 위해 셀의 서식 연결·색상/테마/팔레트 참조·행 높이/열 너비와 조건부 서식 선언도 원본 구조에 남깁니다. 표시 색이나 조건부 서식을 계산하거나 Excel 화면을 그대로 재현하는 기능은 추가하지 않습니다.

## 현재 Mac의 API·MCP 서버

서버와 Cloudflare Quick Tunnel을 함께 실행하려면 Finder에서 `tools/start-mac.command`를 더블클릭하거나 다음 한 줄을 실행합니다. 어느 폴더에서 호출해도 프로젝트의 기존 정책·자료를 사용합니다.

```sh
"/Users/jong-yu/Projects/LLM Wiki/tools/start-mac.command"
```

터널 실행 파일은 프로젝트의 `.local/cloudflared`를 사용합니다. 현재 Mac에는 공식 macOS arm64 실행 파일을 이 위치에 준비했습니다. 새 Mac에서 준비할 때는 [공식 다운로드](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/#macos)에서 Mac 종류에 맞는 압축 파일을 받아, 압축 안의 `cloudflared`를 `.local/cloudflared`에 두고 `chmod +x .local/cloudflared`로 실행 권한을 줍니다. Homebrew 설치나 Cloudflare 계정 로그인은 필요하지 않습니다. 기존 정책이나 자료가 없으면 자동 초기화하지 않고 종료합니다.

발행한 공통 규약을 사용하는 배포에서는 `.local/server-rulesets.json`에 `{"ruleset_root":"/절대/규약/폴더","ruleset_policy":"/절대/규약/허용정책.json"}`을 명시합니다. 런처는 이 파일이 있을 때만 서버에 `--ruleset-config`로 전달하며, 두 경로는 자료 폴더 밖에 있어야 합니다. 설정 파일은 이 두 키만 허용하며 상대경로·누락·손상·심볼릭 링크는 시작 오류로 처리합니다. 파일이 없으면 기존의 규약 미설정 실행을 유지합니다. 로컬 서버를 직접 시작할 때도 같은 옵션을 추가할 수 있으며, 기존 `--ruleset-root`·`--ruleset-policy` 쌍과 함께 사용할 수는 없습니다. 설정은 시작 시 읽으므로 변경 후 서버를 다시 시작합니다.

실행 창에 **앱 서버 주소**와 **MCP 주소(`/mcp`)**가 표시됩니다. 기존 개인 인증을 사용하며, 창을 열어 둔 동안 실행되고 `Ctrl+C` 또는 창 닫기로 함께 종료됩니다. 기본 포트가 사용 중이면 기존 서버를 종료하거나 `./tools/start-mac.command 8767`처럼 다른 포트를 지정합니다. 이 런처는 다른 서버 프로세스를 종료하지 않습니다. [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) 주소는 실행마다 바뀌므로 원격 앱의 서버 주소도 갱신해야 합니다. 주소 표시는 개인 인증·다른 PC 연결 검증을 뜻하지 않습니다.

로컬 서버만 실행할 때는 아래 명령을 사용합니다.

프로젝트 루트에서 실행합니다. 이미 준비된 개인 정책을 사용하며 기본 주소는 `http://127.0.0.1:8766`입니다.

```sh
.venv/bin/python -B -m core.runtime.http_cli \
  --access-config .local/tenancy/access.json \
  --tenant-root data --port 8766
```

앱에서는 같은 서버 주소로 가입·로그인합니다. `POST /api/v1/auth/signup`과 `/api/v1/auth/login`만 이름을 받는 공개 경로이며, `/mcp`와 업무 API에는 반환받은 개인 토큰이 필요합니다. 재로그인은 같은 토큰을 반환합니다. 신규 사용자는 `sdv-platform`(SDV 플랫폼)에 가입하며 기존 workspace ID와 자료를 자동 연결하지 않습니다. 다른 PC의 원격 연결에는 인증된 HTTPS 구성이 필요합니다.

복구용 토큰은 정책 옆 `credentials/<userId>.enc`에 암호화해 보관합니다. 키는 `--credential-key-file`, `LLM_WIKI_CREDENTIAL_KEY_FILE`, 정책 옆 `credential.key` 순으로 선택합니다. 기존 키를 교체하거나 잃어버린 키를 재생성하지 않습니다. 정책·키·credentials는 자료 루트 밖의 보호된 전용 폴더에 함께 보존합니다. 기존 `.token` 파일과 Bearer 인증은 호환하며, 이름 로그인으로의 기존 토큰 등록은 인증 모듈의 명시적 관리자 작업입니다. 토큰 값을 문서·명령 인수·로그에 기록하지 않습니다.

현재 운영 정책이 지정한 자료 폴더가 없거나 손상되었다면 시작을 거부합니다. 새 폴더를 만들어 오류를 숨기지 말고 기존 자료 위치를 확인해야 합니다.

기존 일반 `.token` 파일만 있고 암호화 키가 없다면 최초 키를 준비해 서버를 시작합니다. 기존 토큰·정책은 보존하며 자동 이관하지 않습니다. 암호문이나 미완료 가입 기록이 있는 상태의 키 유실은 계속 시작을 거부합니다.

Codex의 로컬 stdio 연결은 `.codex/config.toml`의 개인 런처 설정을 사용합니다. stdio는 클라이언트가 서버를 실행하므로 별도 HTTP 서버가 필요하지 않습니다. Windows 서버 코드는 WSL2/Linux에서 실행하고, 개인 실행기는 Windows 네이티브 환경도 지원합니다.

배포 설정과 규약 관리는 다음 명령의 도움말에서 확인할 수 있습니다.

```sh
.venv/bin/python -B -m tools.server_deployment --help
.venv/bin/python -B -m tools.publish_ruleset --help
```

## 새 서버 준비

처음 설치하는 서버에서만 존재하지 않는 새 절대 경로를 지정합니다. 부모 폴더는 미리 있어야 하며 기존 경로는 덮어쓰지 않습니다.

```sh
.venv/bin/python -B -m tools.initialize_server --server-root /absolute/new-wiki-server
.venv/bin/python -B -m core.runtime.http_cli \
  --access-config /absolute/new-wiki-server/.local/tenancy/access.json \
  --tenant-root /absolute/new-wiki-server/data --port 8766
```

초기화는 빈 정책·자료 루트와 보호 키를 준비합니다. 첫 가입 때 새 workspace를 만들며 기존 서버 시작에는 이 초기화 명령을 사용하지 않습니다. API와 MCP는 같은 주소에서 제공됩니다. 분석에는 별도로 발행·허용한 규약을 `--ruleset-root`와 `--ruleset-policy`로 연결합니다.

## 데스크톱 앱

Node.js 24 이상을 선택한 뒤 실행합니다. 최초 의존성 설치에는 네트워크가 필요합니다.

```sh
cd app
npm ci
npm run electron:install
npm run dev
```

기존 의존성이 설치된 환경에서는 `npm run dev`로 시작합니다. 빌드 결과를 실행하려면 `npm run build` 후 `npm start`를 사용합니다. 자세한 연결·개인 실행기·패키징 방법은 [앱 실행 안내](app/README.md)를 따릅니다.

## 저장·분석 규칙

`--tracked-read-index` 통합 서버는 Python 작업자가 기동 전 온톨로지 색인을 준비하고 저장 기록 변경 뒤 바뀐 문서만 갱신합니다. 첫 순회는 최대30초 기다리고, 준비 중/실패 시 기존 조회 검사를 유지합니다. AI 재작성은 실행하지 않으며 기동 비용·경쟁·운영 반영 범위는 [D-106](docs/domains/knowledge/DECISIONS.md#d-106--python-서버의-기동-전변경-후-온톨로지-색인-준비-2026-11-06)을 따릅니다.

문서 변경은 `WikiStore.read()`로 얻은 revision을 `WikiStore.save(expected_revision=...)`에 전달하고 수정 전 전체 본문을 보존합니다. 현재 자료의 이력·원장과 접근 정책은 실행 데이터입니다. AI의 의미 지침은 `.agent/ontology_semantics.md`, 상세 불변 규칙은 [도메인 색인](docs/PLAN.md)과 [AGENTS.md](AGENTS.md)를 따릅니다.

문서·원본·분석 작업 목록과 보관 판본 조회는 서버의 Python `sqlite3`로 `data/<workspaceId>/_index/read.sqlite3`에 파생 조회 인덱스를 만듭니다. 별도 DB 서버 설치는 필요하지 않습니다. 원문·전체 이력·업무 JSON과 권한 검증을 유지하고 파일 변경 시 해당 요약을 갱신합니다. 인덱스 오류로 조회·갱신할 수 없으면 기존 파일 조회를 사용합니다. 손상 인덱스를 다시 만들 때는 서버를 종료하고 해당 `_index` 폴더를 별도 위치에 보존한 뒤 서버를 시작해 조회합니다. `wiki/`·`_history/`·원본·업무 원장은 이동하거나 삭제하지 않습니다. 범위와 한계는 [D-100](docs/domains/documents/DECISIONS.md#d-100--원문을-보존하는-sqlite-조회-인덱스-1단계-2026-11-06)을 따릅니다.

HTTP 서버의 `--tracked-read-index`는 저장 전 변경 원장을 활용해 변경 없는 파일 탐색을 생략합니다. 같은 저장 경로를 쓰는 모든 writer가 현재 구현과 잠금 규칙을 지키는 환경에서 사용합니다. 첫 사용·기록 누락·최대30초마다 전체를 다시 확인하며, 외부 직접 편집·구형 writer의 즉시 변경 감지가 필요하면 이 옵션을 빼고 기본 전체 검사를 사용합니다. 잠금 파일은 변경 원장을 겸하므로 삭제·교체하지 않습니다. `--read-metrics`는 개인정보 없이 요청별 구간 시간·건수·캐시 복귀 사유를 stderr에 JSON으로 기록합니다. 총시간은 ASGI 처리·응답 전송을 포함하고, 단계 시간은 중첩될 수 있어 합산하지 않습니다. Mac 런처는 두 옵션을 명시해 실행합니다. 계약은 [D-101](docs/domains/documents/DECISIONS.md#d-101--변경-원장과-요청-계측으로-조회-인덱스-증분-갱신-2026-11-06)을 따릅니다.

MCP `wiki_read`의 `content/revision`은 Front Matter를 포함한 전체 파일입니다. `body/body_revision/body_start_line`을 별도로 제공하며 저장 CAS에는 전체 revision을 사용합니다. `wiki_write`에는 알려진 생성 출처를 `origin: human|ai|unknown`으로 전달합니다. 실제 사용자는 서버 인증에서 정하고 출처 생략은 unknown으로 남습니다. `audit_status: pending_reconcile`이나 정리 경고가 있어도 저장 성공이면 자동 재저장하지 않습니다.

tenant MCP에서는 `wiki_list`로 등록 원본과 Wiki 목록, `wiki_versions`/`wiki_version_read`로 보존 판본을 조회합니다. `wiki_restore`는 현재 `wiki_read`의 전체 revision과 선택 history_id를 사용해 새 판본으로 복원합니다. `analysis_job_list`/`analysis_job_cancel`/`analysis_job_heartbeat`는 자신의 작업과 현재 작업/lease revision을 사용합니다. heartbeat는 실행기가 관리하며 작업 진행 갱신과 구별합니다.

질문에 필요한 현재 근거는 `knowledge_context_prepare`, 검토 대기 항목은 `ontology_review_queue`, 통합 이력은 `wiki_history_query`로 읽습니다. 검토함·이력의 `coverage: "tenant"`는 허용 공간을 제한적으로 탐색하며 누락·다음 페이지를 함께 확인합니다. `ontology_relation_create`/`ontology_relation_undo`/`ontology_relation_request`는 기존 개체 사이의 명시적인 원문 관계·전문가 판단과 요청 영수증을 다룹니다. 새 개체를 만들거나 자동 승인하지 않습니다. 이 도구들은 legacy 서버에 추가되지 않습니다.

용어가 낯설 때는 `ontology_concept_find`에서 현재 선택 가능한 개체를 고르고, 같은 tenant/profile의 `ontology_glossary_query`에 그 `document/entity_id/state_revision`을 `expected_state_revision`으로 전달합니다. 원문 문맥·업무 범위·식별자·현재 속성/관계를 읽으며 `source_passage_status`, `totals`, `coverage`로 생략 범위를 확인합니다. 등장 구절이 정의문이라는 보장은 없습니다. 지도에서 개체를 선택해도 같은 카드를 볼 수 있습니다. 별도 생성/저장·필수 검토 업무·기본 채팅의 추가 입력은 없으며, LLM이 선택 조회한 요청/응답에는 토큰이 들 수 있습니다([D-107](docs/domains/knowledge/DECISIONS.md#d-107--기존-근거에서-읽는-선택-용어-카드와-기본-채팅-분리-2026-11-06)).

개발본의 새 앱 질문은 `mode: "on_demand"`로 접수합니다. 전체 근거는 서버에 보존하고 대화에는 참조를 저장하며, 개인 AI 실행기는 필요한 원문·관계·검토 이력을 최대6회 읽은 뒤 답변합니다. 근거가 부족하거나 조회가 제한되면 그 범위를 답변에 남깁니다. HTTP에서 mode를 생략한 기존 전체 입력과 기존 질문의 복구는 유지합니다. 실제 읽은 항목만 인용할 수 있고 응답 손실은 같은 요청 영수증으로 확인합니다. 인용 번호는 실제 근거 ID에서 자동 생성하며 요청 줄 수와 실제 읽은 범위를 구분합니다. 추가 AI 답변 검사는 기본에서 실행하지 않습니다. 운영/설치 반영 여부와 검증 범위는 [D-108 실행 기록](docs/domains/knowledge/HISTORY.md#2026-11-06--필요한-근거만-읽는-채팅-d-108)과 [D-109 후속 결과](docs/domains/knowledge/HISTORY.md#2026-11-06--인용과-읽기-방식-개선-및-추가-검사-기본-도입-보류-d-109)를 따릅니다.

기본 분석은 원본 등록 뒤 `analysis_registration_create` 또는 `POST /api/v1/tenants/{tenant}/analysis-jobs/registrations`로 접수합니다. 하나의 MD를 만들고 기존 claim/input/result 도구로 그래프를 저장합니다. 접수·입력 준비·CLI 진행 보고와 실제 문서/그래프 영수증을 구별합니다.

## 선택 재검토와 전송량 절감

전문가 판단·기각·보류와 Clean Up은 서버 코드로 기록합니다. MCP의 `ontology_review`, `ontology_policy`, 각 undo와 `analysis_job_wiki_write`, `analysis_job_ontology_generate`, `analysis_job_result_query`에 `response_mode: "compact"`를 지정하면 변경 근거·판본·경고 중심으로 받습니다. 생략하면 기존 전체 응답입니다. 상세 내용은 응답의 `detail_query`로 다시 읽고 판본을 대조합니다. 서버의 모델 호출이 없어도 호출 AI가 읽는 MCP 요청/응답은 토큰을 사용할 수 있습니다.

공통 규약을 발행/승인해도 과거 문서를 자동 실행하지 않습니다. 기존 영향 조회의 후보와 원문을 검토한 뒤 필요한 문서만 선택합니다. 관계만 재검토할 때도 선택 문서별 전체 그래프 작업(`POST /api/v1/tenants/{tenant}/analysis-jobs`, 단일 `targets`, `outputs: ["ontology"]`)을 접수합니다. 새 규약은 새 작업에서 선택하고, 필요한 예외/정의 문서는 `--context-document`로 명시합니다. 기존 작업의 규약을 조용히 바꾸지 않습니다.

```sh
.venv/bin/python -B -m tools.analysis_cli \
  --server http://127.0.0.1:8766 --tenant <workspace-id> \
  --job-id <job-id> --expected-job-revision <observed-revision> \
  --token-file /absolute/private-token --work-dir /absolute/private-work \
  --run-ai --input-view current-review-v1
```

제공자 기본값은 기존 Codex이며 필요하면 기존 `--ai-provider`/`--ai-model` 선택을 그대로 사용합니다. `current-review-v1`은 전체 선택 본문·조건·예외·규약·유효 그래프·현재 판단을 보존하면서 중복 값과 적용되지 않는 과거 이벤트의 반복 전송을 줄입니다. 서버의 전체 bundle/원장과 로컬 수신 사본은 유지합니다. 기본 `--input-view full`도 사용할 수 있습니다. 전체 맥락을 자동 발견했다는 뜻은 아닙니다.

여러 기존 작업은 `--job-id`와 `--expected-job-revision` 대신 `--batch-jobs /absolute/selected-jobs.json`으로 실행합니다. 파일은 `[{"job_id":"32자리 작업 ID","expected_job_revision":"64자리 관측 revision"}]` 형식이며 최대 8개를 명시합니다. 선택한 순서로 실행하고 실패는 개별 기록하며 자동 재시도하지 않습니다. 일부 실패는 종료 코드 1, 취소는 남은 작업 시작 중단입니다. 이미 저장한 결과/초안은 각 작업 폴더와 서버 영수증에 남습니다.

완료 결과는 원본·규약·판단·맥락·권한·실행 설정이 같은 경우에만 재사용합니다. 재사용/새 호출 여부는 결과에 구분됩니다. 옛 AI 실행에 설정 지문이 없거나 설정이 달라졌다면 과거 결과는 조회할 수 있지만 재사용하지 않습니다. `assembly.json`은 조립한 입력의 바이트/문자·보기 hash를, `ai-result.json`/`ai-failure.json`의 `usage_observations`는 호출 시도와 입출력 크기를 기록합니다. 제공자가 실제 토큰 수를 보고한 경우만 `token_usage`에 남기며 값이 없으면 null입니다. 이를 독립 반복 생성이나 실제 비용 절감률의 증거로 해석하지 않습니다.

온톨로지 추출은 저장 전에 고정 원문과 발행 스키마로 구조·본문 인용·참조를 검사합니다. 수정 가능한 검사 오류에는 전체 제출을 최대 두 번 재추출하며 각 호출의 원시 결과·검사 보고·사용량을 보존합니다. 미독, 실행/파싱 오류, 취소, 저장 실패는 이 수정 대상으로 삼지 않습니다. 수정 한도를 소진하면 그래프를 저장하지 않습니다. 의미 정확도나 사람 승인은 별도이며 최종 저장 검사를 그대로 거칩니다. 수동 MCP 작업에서도 읽기 권한의 `ontology_validate_draft(document, expected_revision, submission, max_errors=20)`로 저장 없이 진단할 수 있습니다. tenant 서버에는 기존 `tenant`와 필요한 `profile`을 함께 전달합니다.

## 저장 후 기존 지식 대조

개인 CLI의 새 추출은 저장 확인 뒤 같은 AI 대화에서 기존 지식을 검색·읽기·재검색합니다. 첫 검색부터 최대 5회이며 후보·제외 이유·미확인점과 사용한 근거를 개인 대조 이력으로 보관합니다. 추출 저장과 대조 실패는 따로 표시합니다. 같은 대화를 이어가도 누적 문맥은 모델 입력 사용량에 포함됩니다.

앱의 분석 상세에서 대조 결과를 읽고 **검색·대조 다시 실행**으로 현재 원문·주장·판단을 반영한 새 실행을 만들 수 있습니다. CLI에서는 최초 분석에 `--session-registry /absolute/private-session-refs`를 지정하고 수동 재실행에도 같은 보호 경로를 사용합니다. 생략하면 각 `--work-dir` 아래 `ai-session-refs`입니다. 실제 추출에서 보관한 로컬 세션 기록이 없거나 사용자·서버·대상 등이 다르면 다른 대화로 대신 실행하지 않습니다.

```sh
.venv/bin/python -B -m tools.comparison_cli \
  --server http://127.0.0.1:8766 --tenant <workspace-id> \
  --comparison-id <comparison-id> --request-id <new-request-id> \
  --token-file /absolute/private-token --work-dir /absolute/private-work \
  --session-registry /absolute/private-session-refs --ai-provider codex
```

최초 실행과 같은 제공자를 선택하고 관점을 명시했다면 같은 `--profile`을 전달합니다. 이전 결과와 원문·추출은 덮어쓰지 않습니다. 같은 접수의 응답이 유실되면 기존 request ID로 결과를 확인하며 새 ID로 자동 재실행하지 않습니다.

## 격리 통합 검증

```sh
.venv/bin/python -B -m unittest discover -s core/tests/poc_mcp -v
```

임시 정책·자료·키로 API/MCP·stdio·실제 loopback HTTP를 검증하므로 로컬 포트 열기 권한이 필요합니다. 운영 자료·CLI 로그인 설정은 변경하지 않으며 실제 AI 모델·Electron 화면 검증과 구분합니다.

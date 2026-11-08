# Python 코드 읽는 길잡이

`core/`에는 서버와 개인 PC 실행기의 Python 코드가 있습니다. 폴더마다 별도 프로그램을 설치하는 구조가 아니라, 책임에 따라 나눈 코드를 실행할 때 연결하는 구조입니다.

처음에는 **어디서 시작하는가 → 누가 요청을 받는가 → 어디서 실제 처리하는가** 순서로 읽으면 됩니다.

## 1. 가장 먼저 볼 파일

| 궁금한 것 | 읽을 파일 | 하는 일 |
| --- | --- | --- |
| 앱이 연결하는 서버를 어떻게 켜는가? | [runtime/http_cli.py](runtime/http_cli.py) | 명령줄 옵션과 정책 경로를 읽고 서버를 시작합니다. |
| 서버에 API와 MCP가 어떻게 붙는가? | [runtime/application.py](runtime/application.py) | FastAPI와 MCP를 같은 서버에 연결합니다. |
| 문서를 어떻게 읽고 저장하는가? | [modules/documents/store.py](modules/documents/store.py) | 본문, revision, 수정 전 전체 이력, 저장 잠금과 충돌을 처리합니다. |
| AI 질문은 어디서 실행하는가? | [client/question_ai.py](client/question_ai.py) | 개인 PC에서 질문용 AI 실행을 진행합니다. |
| Codex와 Claude를 어디서 고르는가? | [client/ai/provider.py](client/ai/provider.py) | 선택한 제공자의 실행 어댑터를 만듭니다. |

## 2. 폴더별 역할

```text
core/
  runtime/       프로그램 시작·설정·프로세스 관리
  api/           Electron 앱이 보내는 HTTP 요청을 받는 곳
  mcp/           AI 클라이언트가 보내는 MCP 요청을 받는 곳
  modules/       문서·관계·검토·권한 등의 실제 업무 처리
  client/        개인 PC에서 서버 통신·AI 실행·원본 변환
  common/        여러 폴더가 함께 쓰는 작은 공통 함수
  paths.py       프로젝트·data·.venv의 기준 경로
```

### runtime: 실행 준비와 시작

여기서 말하는 runtime은 **우리 프로그램의 실행을 준비하는 소스 코드**입니다.

- [http_cli.py](runtime/http_cli.py): 인증된 HTTP API와 MCP 서버의 시작점.
- [mcp_cli.py](runtime/mcp_cli.py): MCP 전용 서버의 실행 옵션 처리.
- [application.py](runtime/application.py): 서버 조립과 시작·종료 수명 관리.
- [personal_launcher.py](runtime/personal_launcher.py): 개인 토큰 파일과 권한을 확인하고 로컬 MCP 서버 시작.
- [desktop_bridge.py](runtime/desktop_bridge.py): Electron과 개인 Python 실행 명령 사이의 연결.
- [client_process.py](runtime/client_process.py), [client_platform.py](runtime/client_platform.py): 자식 프로세스·취소·OS별 실행과 보호 파일 처리.

`runtime/`의 모든 파일을 하나씩 실행할 필요는 없습니다. 시작점이 필요한 모듈을 불러옵니다.

### api와 mcp: 같은 업무 기능을 부르는 두 입구

Electron 앱은 주로 HTTP API를 사용하고, MCP 클라이언트는 이름이 있는 도구를 호출합니다.

```text
Electron의 문서 열기
  → api/v1/documents/router.py
  → modules/documents/store.py

AI의 wiki_read 호출
  → mcp/tools/documents.py
  → modules/documents/store.py
```

두 입구 모두 같은 저장 구현을 사용합니다. 따라서 입구가 다르더라도 권한 검사와 저장 규칙을 공유합니다. HTTP 주소 연결은 [api/router.py](api/router.py), MCP의 사용자·워크스페이스별 처리는 [mcp/tenant.py](mcp/tenant.py)에 있습니다.

### modules: 실제 업무 기능

| 폴더 | 담당하는 것 |
| --- | --- |
| [access](modules/access/) | 인증, 사용자별 워크스페이스·행동·관점 권한 |
| [documents](modules/documents/) | 편집 가능한 Wiki 본문, 검색, 목록, 전체 수정 이력 |
| [sources](modules/sources/) | 업로드한 원본 파일, 원본 판본, 문서와의 연결 |
| [ontology](modules/ontology/) | 문서에서 추출한 개체·관계·근거와 그래프 |
| [reviews](modules/reviews/) | 전문가 검토·정정·정책과 되돌림 |
| [correspondences](modules/correspondences/) | 문서 간 개념·조건의 대응 관계 |
| [knowledge](modules/knowledge/) | 여러 문서·관계·검토를 합친 탐색과 변경 영향 조회 |
| [analysis_jobs](modules/analysis_jobs/) | 분석 작업의 접수·상태·진행·취소 |
| [extraction_rules](modules/extraction_rules/) | AI에 전달할 규약·스키마·의미 지침의 버전 관리 |
| [analysis_inputs](modules/analysis_inputs/) | 특정 분석이 사용할 원문·규약·판본을 고정 |
| [analysis_results](modules/analysis_results/) | 분석 결과의 검증, Wiki·그래프 저장과 영수증 |
| [analysis_plans](modules/analysis_plans/) | 변환된 자료의 분석 계획과 작업 인계 |
| [analysis_proposals](modules/analysis_proposals/) | 저장 전 추출안의 검토·비교·적용 |
| [personal](modules/personal/) | 개인 질문·대화·결과 초안 등의 기록 |

원본 파일을 다루면 `sources`, 편집한 Markdown 본문을 다루면 `documents`, 관계를 다루면 `ontology`부터 찾습니다.

### client: 개인 PC에서 AI와 서버를 연결

서버는 자료와 작업 상태를 관리하고, 실제 AI CLI와 파일 변환은 개인 PC에서 실행합니다. `core/` 안에 있지만 `client/`가 서버에서 항상 실행되는 것은 아닙니다.

```text
Electron에서 질문 실행
  → runtime/desktop_bridge.py
  → 루트 tools/question_cli.py
  → client/question.py, client/question_ai.py
  → client/ai/provider.py
      → codex.py 또는 claude.py
  → 서버 API/MCP에 결과 전달
```

[client/transport.py](client/transport.py)는 서버 통신을, [client/source_conversion.py](client/source_conversion.py)는 원본 변환을 담당합니다. AI에 전달하는 입력과 서버에 저장하는 결과는 별도로 확인합니다.

### common과 paths.py: 공통 재료

[common/](common/)에는 정규 JSON, 해시, 정리 오류처럼 여러 기능이 공유하는 작은 처리가 있습니다. [paths.py](paths.py)는 프로젝트·자료·Python 환경의 기본 경로만 제공합니다. 이 파일을 import했다고 서버가 켜지는 것은 아닙니다.

## 3. entrypoint와 실제 구현의 차이

entrypoint는 **처음 실행하는 문과 같은 파일 또는 함수**입니다. 그 문을 통해 들어가 다른 파일의 함수를 호출합니다. 별도 Python 실행 파일이 기능마다 필요한 것은 아닙니다.

예를 들어 프로젝트 루트에서 다음 명령을 실행하면:

```sh
.venv/bin/python -B -m core.runtime.http_cli \
  --access-config .local/tenancy/access.json \
  --tenant-root data --port 8766
```

1. `.venv/bin/python`이 Python 코드를 실행합니다.
2. `-m core.runtime.http_cli`가 시작할 모듈을 지정합니다.
3. `http_cli.py`의 `main()`이 기존 정책·자료 루트를 검증하고 서버를 조립합니다. `application.py`는 인증 모듈의 `initialize_auth`로 암호화 키·가입/로그인을 준비합니다.
4. 서버는 요청을 기다리며, 요청이 오면 `api/` 또는 `mcp/`에서 `modules/`의 함수를 부릅니다.

`api`, `mcp`, `modules`가 각각 독립 서버로 뜨는 구조는 아닙니다. 반면 개인 AI 실행은 Electron이 별도 자식 프로세스로 시작할 수 있습니다.

가입·로그인은 `/api/v1/auth/signup`, `/api/v1/auth/login`이고 MCP는 같은 주소의 `/mcp`입니다. 사용자 신원·권한은 같은 `AccessPolicy`에서 가져옵니다. 전체 정책의 `policy_revision`은 감사용으로 유지하고 본인 작업의 접근 기준에는 `access_revision`을 사용합니다. 새 서버의 명시적 초기화와 키 경로·검증 명령은 [프로젝트 README](../README.md)를 따릅니다.

### core 바로 아래의 작은 Python 파일

다음 파일은 기존 명령이나 import 경로를 유지하기 위한 연결 파일입니다.

| 파일 | 연결되는 실제 구현 |
| --- | --- |
| [mcp_server.py](mcp_server.py) | `runtime/mcp_cli.py`, `mcp/` |
| [personal_launcher.py](personal_launcher.py) | `runtime/personal_launcher.py` |
| [storage.py](storage.py) | `modules/documents/store.py` |
| [reviews.py](reviews.py) | `modules/reviews/` |
| [anchors.py](anchors.py) | `modules/ontology/anchors.py` |

예전 `python -m core.mcp_server` 명령을 사용해도 실제 처리는 위 연결을 따라 진행됩니다. `storage.py` 같은 파일은 명령으로 실행하는 서버가 아니라 다른 코드가 import하는 연결입니다. 새 코드를 읽거나 수정할 때는 표 오른쪽의 실제 구현을 먼저 봅니다.

## 4. 이름이 같은 두 tools

- [mcp/tools/](mcp/tools/): MCP 서버가 공개하는 `wiki_read`, `wiki_write` 등의 도구 처리 함수.
- [프로젝트 루트 tools/](../tools/): 설치·진단·질문·분석 등을 명령으로 실행하는 입구.

예를 들어 `tools/runtime_doctor.py`는 환경 진단 명령이고, `mcp/tools/documents.py`는 AI 클라이언트의 문서 도구 요청을 처리합니다. 루트 `tools` 중 질문·분석·변환 명령은 Electron도 실행하므로 개발용 파일로만 분류하지 않습니다.

## 5. Python 본체, .venv, 두 runtime

Python으로 만든 프로그램에는 **Python 본체**와 **추가 패키지**가 필요합니다.

```text
Python 본체             Python 문장을 실제로 실행하는 프로그램 + 기본 기능
프로젝트의 .venv        이 프로젝트가 사용할 추가 패키지와 Python 연결
우리의 .py 파일         실행할 작업을 적은 소스 코드
```

비유하면 Python 본체는 작업자, 추가 패키지는 작업 도구, `.py` 파일은 작업 지시서입니다. `.venv`는 이 프로젝트용 작업 도구와 어떤 작업자를 사용할지 정해 둔 공간입니다.

현재 이 컴퓨터에서는 다음과 같이 나뉩니다.

| 위치 | 실제 내용 |
| --- | --- |
| `.local/python-recovery-20261027/runtime/` | Python 3.12 본체와 표준 라이브러리 |
| `.venv/lib/python3.12/site-packages/` | FastAPI·MCP·문서 변환 등 추가 패키지 |
| `.venv/bin/python` | 위 Python 본체로 연결되는 실행 경로 |
| `core/runtime/` | 우리가 작성한 프로그램 시작·설정 코드 |

복구용 runtime은 같은 Python을 한 번 더 실행하는 서버가 아닙니다. 현재 `.venv`가 의존하는 Python 본체입니다. 기존 공유 Python을 건드리지 않고 프로젝트 안에 본체를 복사해 연결한 구성이어서 별도 폴더가 남았습니다.

일반적인 다른 구성은 컴퓨터에 별도로 설치한 Python 본체를 사용하고, 프로젝트에는 `.venv`만 두는 것입니다. 그 구성으로 바꾸려면 사용할 Python을 확인하고 가상환경을 다시 구성해야 합니다. 현재 `.venv`만 남기고 본체 폴더를 지우면 연결 대상이 없어져 실행할 수 없습니다. [Python 공식 venv 설명](https://docs.python.org/3/library/venv.html)

## 6. 이 문서 다음에 읽을 곳

- 앱 실행과 현재 서버 시작 명령: [프로젝트 README](../README.md)
- Electron 내부 구조: [앱 README](../app/README.md)
- 업무별 계약과 저장·권한 규칙: [도메인 문서 색인](../docs/PLAN.md)
- 실제 분석 의미 지침: [.agent/ontology_semantics.md](../.agent/ontology_semantics.md)

폴더 구조를 이해하는 동안 실제 `data/`나 인증정보를 수정할 필요는 없습니다.

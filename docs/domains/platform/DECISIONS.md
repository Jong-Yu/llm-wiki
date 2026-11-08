# API·MCP·실행 환경 결정

현재 구현 상태는 [PLAN](PLAN.md), 작업 시 지킬 상세 규칙은 도메인에 연결된 RULES를 따릅니다. 결정 번호·이유와 상세 계약을 보존합니다. 아래 결정 안의 날짜·시험 수·운영 상태는 기록 당시 값이며, 최신 구현 상태는 PLAN을 우선합니다. 필요한 D 번호·하위 절만 읽습니다.

### D-055 — 개인 실행 환경과 읽기 전용 진단·안전한 재개 (2026-10-25)

- 전체 설치는 Python 3.12 이상과 `requirements.lock`을 사용한다. `tools.setup_runtime`은 프로젝트 `.venv`만 생성/설치하고 동시 설치를 배제하며 기존 환경·자료를 삭제하지 않는다. 개인 변환 의존성은 고정하고 Windows 전용 `pywin32`는 환경 marker로 분리한다. OCR 실행 파일과 언어 데이터는 별도 설치·진단한다.
- Windows 네이티브 개인 실행기는 원격 API/MCP를 소비한다. 저장 서버는 기존 POSIX 파일 잠금·전체 버저닝 계약을 유지하며 Windows에서는 WSL2의 Linux 파일시스템을 사용한다. 두 역할의 설치 경로와 명령은 README에 둔다. 실제 Windows/WSL2와 다른 PC 검증을 macOS·모의 검사로 대신하지 않는다.
- 개인 실행기 파일은 POSIX 모드 또는 Windows 소유자/DACL로 보호한다. Windows reparse point·공개/알 수 없는 ACL을 거부하고 기존 파일 권한을 자동 바꾸지 않는다. 실행별 Job Object에 연결된 bootstrap만 CLI를 생성하여 취소·시간 초과·부모 종료 시 자기 실행의 자식을 회수한다. npm shim은 알려진 Node 진입점으로 해석하며 임의 셸 문자열을 실행하지 않는다.
- `runtime_doctor`는 잠긴 의존성, CLI 기능, 로그인 정보 존재, 실제 API 읽기, 실제 MCP 초기화/도구/접근 맥락을 각각 보고한다. 로그인 정보가 존재해도 모델 사용 가능성을 인증하지 않으며 API/MCP 주체·정책·소속 대조를 영구 backend identity로 표시하지 않는다. 진단과 토큰 보호 파일 생성은 권한 발급·로그인·모델 호출·설정 교체를 실행하지 않는다.
- `CodexAdapter.run(on_event=...)`은 한도 내 공개 답변 이벤트만 전달한다. 생성 중 텍스트는 저장 영수증이 아니며 추론/오류 원문을 전달하지 않는다. 서버 토큰/API 키는 모델 환경에서 제외한다.
- 분석 실행은 사용자가 관측한 `expected_job_revision`을 claim 전에 대조한다. 명시 재개는 동일 작업 기준의 완료 영수증과 현재 출력만 승계하며 위키를 반복 저장하지 않는다. 고정 규약·관점·맥락·대상은 유지하고 미확인 영수증/외부 변경/허용 철회는 차단한다. 같은 기준의 서버 저장 연쇄를 새 run에도 검증하는 공통 연결 변경을 포함한다. 별도 의미 검사는 명시 옵션에서 수행하고 원래 자기보고와 별도 초안 영수증을 보존한다.

이유: 여러 개인 실행기가 경로·비밀·취소·재개를 중복 구현하면 OS 차이 또는 부분 성공을 잘못 처리할 수 있다. 저장 서버 계약을 보존하면서 개인 실행기의 공통 경계를 한곳에서 제공한다. 실제 검증과 미실행은 HISTORY (정리로 삭제된 참고 자료)에 기록한다.

### D-057 — PC 연결 보호 저장과 재시작 재확인 (2026-10-25)

ui_6의 구현은 D-047의 연결 수명주기를 다음과 같이 구체화한다. PC마다 사용자가 명시적으로 기억한 연결 하나를 Electron main에서 관리한다. 비동기 OS `safeStorage`로 URL·토큰·사용자·정책·선택 tenant/profile의 의미를 함께 암호화하고 `userData/connection-protection/selected.bin`에 보관한다. 평문·고정 키·Linux `basic_text`/알 수 없는 제공자 fallback은 허용하지 않으며 가능한 보호 기능이 없으면 세션 전용으로 동작한다.

앱 재시작에는 실제 `GET access-context`를 읽어 저장한 사용자·정책·read 권한·관점 의미를 대조한다. 실패하거나 범위가 바뀌면 자동 복원을 차단하고 원래 암호문을 보존한다. 다른 연결의 늦은 응답을 현재 선택에 적용하지 않는다. 세션 전용 새 연결은 인증 성공 후에만 이전의 기억한 선택을 지운다. 로그아웃/삭제는 보호 파일을 제거하고 창 종료는 메모리만 비운다. 쓰기는 잠금·CAS·암호문의 원자적 교체를 사용하며 남은 잠금을 임의 제거하지 않는다.

서버 자격증명 저장 API·토큰 발급/회수 기능을 만들지 않는다. 서버 권한과 개인 AI 로그인은 별도이며 OS 저장이 같은 사용자/관리자에 대한 완전한 비밀 격리를 보장하지 않는다. ui_6은 격리 HTTP/주입 암호 시험 13개와 실제 macOS Electron 두 프로세스의 OS 보호 저장 시험 1개를 보고했다. Windows/Linux 실기기 및 전체 앱 통합 검증은 해당 기록과 구분한다. 실제 앱 연결·최종 E2E 근거는 UI HISTORY (정리로 삭제된 참고 자료)가 소유한다.

### D-012 — 공식 Python MCP SDK와 로컬 stdio (2026-10-21, 2단계)

상태: 현재 SDK·stdio 운영 원칙과 2단계 도입 기록입니다. 후속 전송·인증은 [D-017]·[D-026]을 따릅니다.

- 결정: 공식 `mcp==2.3.0`을 프로젝트 `.venv`에 설치하고 `core/mcp_server.py`에서 `MCPServer`로 읽기·쓰기·검색 도구를 등록합니다. 의존성은 `requirements.txt`에 기록하고 SDK가 메시지 처리·입력 스키마·프로토콜 버전 호환을 맡습니다. 통신을 직접 구현하지 않습니다.
- 실행 환경: SDK는 Python 3.10 이상이 필요합니다. 현재 시스템 Python 3.9.6은 저장 모듈 검증에 유지하고, 이미 제공된 Python 3.12.14로 프로젝트 가상 환경을 만들었습니다. 전역 Python이나 패키지는 변경하지 않았습니다. 저장 모듈은 외부 의존성 없이 Python 3.9 호환을 유지합니다.
- 전송: 2단계 최초 실행 진입점은 로컬 stdio였습니다. 도구 함수는 기존 `WikiStore`를 사용하고 SDK가 동기 함수를 작업 스레드에서 실행하므로 잠금 대기가 이벤트 루프를 막지 않습니다. 표준 출력은 MCP 통신 전용, 로그는 표준 오류로 보냅니다.
- 이유와 범위: 2단계에서는 도구 기능과 실제 프로토콜을 먼저 검증하고 개인 서버 전송·인증·배포 결정을 미뤘습니다. 이후 CLI 연결은 [D-016], HTTP는 [D-017], 개인 인증 tenant 모드는 [D-026]에서 보완했습니다. SDK 클라이언트의 이전 `initialize` 방식과 새 기능 조회 방식의 검사 결과는 [PLAN](../../PLAN.md)에 보존합니다.
- 근거: [공식 Python SDK](https://github.com/modelcontextprotocol/python-sdk), [도구 개발](https://py.sdk.modelcontextprotocol.io/servers/tools/), [stdio·HTTP 전송 규약](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)을 확인하고 설치된 2.3.0의 API를 검사했습니다.

### D-015 — MCP 쓰기 계약과 오류 전달 (2026-10-21, 2단계)

상태: 현재 MCP 읽기·쓰기의 저장 결과·오류 계약입니다.

- 결정: 읽기는 본문과 버전을 함께 반환하고 쓰기는 필수 `expected_revision`을 받습니다. 신규 생성은 실제 JSON `null`, 수정은 읽기에서 받은 SHA-256 값입니다. `WikiStore.save()`의 버저닝·충돌 방지·크기 제한을 그대로 재사용합니다. 도구가 파일을 직접 덮어쓰지 않습니다.
- 입력 보완: SDK 2.3.0은 nullable 인수의 문자열 `"null"`을 실제 `null`로 사전 변환하는 동작이 확인됐습니다. `WikiMCPServer.call_tool()`의 공개 확장 지점에서 원시 값이 실제 `None` 또는 64자리 소문자 SHA-256 문자열인지 먼저 검사하고, 입력 스키마에도 형식을 표시합니다. SDK 내부 코드를 수정하지 않습니다.
- 결과: 구조화 결과와 텍스트 JSON에 같은 내용을 담습니다. 성공은 `ok: true`·`isError: false`이며 저장 후 정리만 실패해도 성공을 유지하고 `cleanup_failures`를 전달합니다. 이전 파일과 임시 파일 경로는 데이터 루트 기준 상대 경로입니다.
- 오류: 예상 가능한 도구 실행 오류는 `ok: false`·`isError: true` 및 오류 코드·설명·재시도 가능 여부로 전달합니다. SDK 입력 검증 실패는 SDK의 도구 오류 응답을 사용합니다. 저장 자체와 정리가 함께 실패하면 주 오류를 유지하고 정리 정보를 `error.cleanup_failures`에 넣습니다. 서버 내부 경로를 오류 설명으로 그대로 내보내지 않고 실제 저장 오류의 상세 로그는 stderr에 기록합니다.
- 재시도와 신뢰: 잠금 사용 중만 재시도 가능으로 표시합니다. 편집 충돌은 최신 내용 확인과 수정 재반영이 필요합니다. 저장 성공 후 정리 오류를 이유로 쓰기를 반복하지 않습니다. 읽은 위키 본문은 데이터이며 서버·에이전트 지침으로 취급하지 않습니다.

### D-016 — 맥북의 로컬 stdio 서버와 프로젝트 Codex CLI 연결 (2026-10-21, 3단계)

상태: legacy 로컬 stdio 연결의 결정·검증 당시 설정입니다. 개인 인증 tenant 모드는 [D-026]을 따릅니다.

- 사용자 확인: 별도 개인 서버가 없으므로 맥북을 임시 서버로 사용했습니다. 3단계 최초 연결에서는 로컬 stdio에 별도 MCP 인증을 두지 않았습니다.
- 실행 환경: 최초 연결 검증 당시 macOS 26.5.2 arm64, 프로젝트 Python 3.12.14, Codex CLI 0.163.0-alpha.11과 기존 ChatGPT 로그인을 사용합니다. 프로젝트의 실제 절대 경로를 지정해 Codex가 기존 `core.mcp_server`를 stdio로 실행하게 합니다. 이 로컬 연결 자체는 HTTP 포트가 필요하지 않습니다.
- 설정 범위: `.codex/config.toml`의 `mcp_servers.llm_wiki`에 연결을 둡니다. 프로젝트 전용 Python·작업 디렉터리·데이터 루트를 사용합니다. 최초 연결은 읽기·쓰기·검색 세 도구로 검증했으며, 현재 도구 목록과 실행 설정은 [README](../../../README.md)에서 관리합니다. 필요한 서버를 `required`로 지정하며 시작 대기는 20초, 도구 응답 대기는 30초로 둡니다. 전역 사용자 설정이나 다른 MCP 연결을 바꾸지 않습니다. 프로젝트 신뢰가 필요한 CLI 동작을 실행 안내에 설명합니다.
- 접근과 쓰기 확인: legacy 로컬 stdio 서버는 현재 macOS 계정 권한으로 실행하며 별도 MCP 로그인·토큰을 요구하지 않습니다. 네트워크 전송이 없기 때문에 이 구성을 인증 없는 원격 공개 서버로 해석하지 않습니다. Codex의 ChatGPT 로그인은 모델 사용 인증이며, `default_tools_approval_mode = "writes"`는 문서 쓰기 실행을 확인하는 별도 정책입니다. 이 legacy 구성은 사용자별 서버 권한이나 변경 작성자 추적을 제공하지 않습니다. 개인 인증은 [D-026], 검토·전문가 판단의 Action log는 [D-028]·[D-031]을 따르며, 이 로그가 모든 원문 저장의 작성자 추적을 제공하는 것은 아닙니다.
- 오류 경계: CLI의 도구 응답 시간 제한과 D-014의 저장 잠금 대기 제한은 다릅니다. 응답이 끊기거나 시간 초과됐을 때 서버의 저장이 취소됐다고 가정하지 않습니다. 다시 읽어 반영 여부를 확인하고 기존 충돌·재시도 규칙을 따릅니다.
- 검증 방식: 기존 저장·MCP 회귀 검증에 더해 `core/verify_codex.py`로 실제 Codex CLI의 임시 세션을 실행합니다. 검증 시에만 별도 임시 데이터 루트를 지정하고 실제 MCP 호출의 JSONL 입력·결과, 최신 내용, 수정 전 전체 히스토리 바이트와 충돌 후 보존을 검사합니다. 운영 위키에 샘플을 남기지 않으며 실제 결과는 [PLAN](../../PLAN.md)에서 관리합니다.
- 원격 방향의 후속 결정: 초기에는 소수 개발자용 SSH stdio와 여러 사용자용 HTTPS·개인 인증을 검토했습니다. 이후 임시 HTTPS는 [D-017], PoC 개인 토큰·권한은 [D-026]으로 구현했습니다. SSH 연결·MCP OAuth 2.1은 구현하지 않았으며 자체 계정/회사 SSO의 선택은 [D-030]의 미결정 범위입니다.
- 이유: 이미 검증한 저장 모듈과 MCP 도구를 그대로 연결하여 이번 단계의 CLI 호출·보존 동작에 집중할 수 있습니다. 토큰·키를 문서나 설정에 기록하지 않으며, 원격 접근 요구가 생기기 전에 인증 없는 네트워크 서비스를 열지 않습니다.
- 근거: 설치된 CLI의 명령 도움말·설정 스키마와 [공식 CLI MCP 안내](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)를 확인했습니다. 실행 명령과 설정 변경 위치는 [README](../../../README.md)에서 관리합니다.

### D-017 — Windows 원격 PoC와 임시 HTTPS 터널 (2026-10-21, 3단계 보완)

상태: legacy 공유 토큰 원격 PoC의 결정입니다. 개인 인증 tenant 모드는 [D-026]이며, 이 기록은 현재 터널 실행 상태를 보장하지 않습니다.

- 사용자 확인: Windows에서 접속하며 외부 인터넷에서도 사용할 수 있도록 준비합니다. 사용자는 사설 VPN 대신 Cloudflare 임시 HTTPS 주소를 선택했습니다. D-016의 인증 생략은 로컬 stdio에 한정하고 HTTP에는 토큰을 요구합니다. 이는 당시 원격 연결 보완의 범위이며 이후 단계의 진행 상태는 [PLAN](../../PLAN.md)을 따릅니다.
- 서버: 기존 도구와 `WikiStore`를 재사용하는 Streamable HTTP 실행 경로를 추가합니다. 기본 실행은 stdio로 유지합니다. HTTP는 `127.0.0.1:8765`에만 바인딩하고 HTTPS 터널이 연결합니다. 공유기 포트 전달이나 macOS 원격 로그인 설정은 변경하지 않습니다.
- 접근: 무작위 테스트용 Bearer 토큰을 환경변수로 전달합니다. 토큰 누락·오류·중복 Authorization 헤더는 401로 거부하며 상수 시간 비교를 사용합니다. 토큰 파일은 버전 관리 제외 `.local/mcp-token`에 0600 권한으로 보관하고 채팅·문서·프로세스 인수에 실제 값을 넣지 않습니다. 이 공유 토큰은 사용자별 신원·권한·작성자 추적을 제공하지 않습니다.
- 전송: Quick Tunnel의 SSE 미지원에 맞춰 JSON 응답과 stateless HTTP를 사용하고 `/mcp`의 비POST 요청은 인증·Host/Origin 검사 후 405로 반환합니다. SDK의 DNS rebinding 보호를 유지하고 터널이 로컬 Host 헤더를 전달합니다. HTTP 본문은 8 MiB로 제한하여 JSON 이스케이프로 커지는 입력을 수용하되 저장 모듈의 UTF-8 1 MiB 문서 제한은 그대로 적용합니다.
- HTTPS: 계정·도메인 없이 임시 `trycloudflare.com` 주소를 사용합니다. Cloudflare가 HTTPS를 종료하고 맥북으로 터널링하므로 트래픽은 이 서비스를 경유합니다. 프로세스 종료 시 주소가 동작하지 않으며 재실행 시 주소가 바뀔 수 있습니다. 상시 운영·고정 주소·가용성 보장은 이번 범위가 아닙니다. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
- 도구 설치: 공식 Cloudflare GitHub 릴리스의 `cloudflared 2026.10.3` macOS arm64 배포를 `.local/cloudflared`에만 설치했습니다. 아카이브 SHA-256 `1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55`를 릴리스 메타데이터와 대조했습니다. 시스템 전역 설치·자동 시작·자동 갱신은 추가하지 않습니다.
- 검증 데이터: 원격 확인은 `.local/remote-check/`로 격리하며 운영 `data/wiki/`·`data/_history/`를 사용하지 않습니다. Windows 확인에 필요한 실행 파일·토큰·접속 주소·프로세스 정보·테스트 저장소는 `.local/`에 모읍니다. 서버와 터널을 종료하고 검증을 마친 뒤 이 작업 소유의 런타임 산출물만 정리합니다.
- 완료 판정: 맥북에서 공개 HTTPS 주소를 호출한 결과와 별도 Windows 기기의 실제 접속 결과를 구분합니다. 후자가 없으면 원격 보완 전체를 완료로 표시하지 않습니다. 실행 방법은 [README](../../../README.md), 실제 검증 결과는 [PLAN](../../PLAN.md)에 기록합니다.

### D-046 — 업무별 백엔드 모듈과 FastAPI·MCP 분리 및 스펙 주도 개발 (2026-10-25)

상태: **기존 백엔드의 업무·전송/실행·수동 도구 이전과 불필요 호환 정리·core/tests 정합·검증 완료**입니다. 이후 R1 첫 읽기의 API/runtime 결합도 구현했으며 현재 기능 계약은 [D-043]을 따릅니다. 사용자가 정한 core 전용 검사 위치를 채택했습니다. storage/access·런처·수동 도구까지 실제 배치했고 기본 data/.venv·MCP 등록·원장/권한 계약을 보존했습니다. 남긴 직속 파일의 이유와 의도한 명령 변경은 아래 마지막 절에 기록합니다.

#### 선택한 구성과 개발 방식

**업무별 모듈로 구성한 단일 백엔드(modular monolith) + FastAPI/MCP 어댑터 분리 + 스펙 주도 개발(SDD)**을 적용합니다. 배포 단위는 D-043의 한 Python 백엔드를 유지합니다. DDD는 문서·기계 추출·검토·대응 등 업무 용어와 소유 경계를 정하는 데 사용하며, 모든 폴더를 독립 Bounded Context나 마이크로서비스로 선언하지 않습니다. SDD는 폴더 구조의 대안이 아니라 요구·계약→계획·수용 조건→검사→구현→결과 기록의 절차로 함께 적용합니다.

| 검토한 방식 | 이 PoC에 대한 판단 |
| --- | --- |
| `routers/services/models/repositories`만 전역으로 나눈 계층 구조 | 작은 시작에는 단순하지만 업무 하나의 변경 위치가 여러 전역 폴더에 흩어지고 큰 서비스 파일이 다시 생길 수 있음 |
| 모든 모듈에 Entity/Aggregate/Repository/Unit of Work를 강제하는 전면 DDD/Clean Architecture | 현재 파일 저장·규칙·잠금의 실제 결합을 한 번에 바꿔야 하며 추상화·파일 수가 늘어남. 지금의 구조 정리 범위에는 채택하지 않음 |
| 업무별 모듈 + 외부 전송 어댑터 + 하나의 조립 지점 | **채택.** 업무 위치를 찾기 쉽고 HTTP/MCP의 처리 중복을 줄이며 기존 저장 의미를 점진적으로 보존할 수 있음 |
| 스펙 주도 개발 | **개발 절차로 병행.** 기존 D-043 API 계약·PLAN 수용 조건을 먼저 고정해 같은 규칙의 전송별 동작을 확인. 별도 Spec Kit 설치·문서 체계 복제는 필요 없음 |

참고한 1차 자료는 [DDD Reference](https://www.domainlanguage.com/ddd/reference/), [Ports and Adapters 원문](https://alistair.cockburn.us/hexagonal-architecture), [FastAPI의 APIRouter 분리 안내](https://fastapi.tiangolo.com/tutorial/bigger-applications/), [GitHub의 SDD 설명](https://github.com/github/spec-kit/blob/main/spec-driven.md), [Python 3.12 패키지 안내](https://docs.python.org/3.12/tutorial/modules.html#packages)입니다. 각 자료의 원칙을 현재 코드에 맞춰 선택한 설계이며 이 디렉토리 배치가 특정 표준의 필수 형식이라는 뜻은 아닙니다.

#### 목표 디렉토리와 책임

아래는 **전체 목표 지도**입니다. 기존 common·mcp·runtime CLI/개인 런처·modules 업무·core/tests·수동 tools는 실제 이전했습니다. 이후 R1에서 application/http_security/http_cli와 첫 세 API 폴더를 구현했습니다. 나머지 후속 폴더와 아직 필요하지 않은 services/paths는 만들지 않았으며 실제 전체 목록은 README를 따릅니다. `core/` 패키지와 등록된 실행 진입을 유지합니다. `src/` 전환·배포 패키징은 포함하지 않으며 새 패키지는 실제 구현이 있을 때만 만듭니다.

```text
core/
  paths.py                       기존 프로젝트·data·.venv의 순수 경로 기준 [구현됨]
  common/                        업무/SDK에 의존하지 않는 공용 기술 코드 [구현됨]
    json_codec.py                정규 JSON 저장 바이트·LF·hash 계약
    cleanup.py                   정리 경고의 순수 응답 변환
  paths.py                       부작용 없는 공통 프로젝트/기본 경로 기준
  runtime/                       실행·설정·의존성 조립
    application.py               FastAPI 루트와 MCP mount·lifespan 조립 [R1]
    services.py                  현재 인가된 scope의 공통 서비스 구성
    mcp_cli.py                   기존 stdio/HTTP MCP 인수와 실행 분기 [구현됨]
    paths.py                     추가 실행 경로 검증이 필요할 때 [R1]
    http_security.py             양쪽 HTTP 입구의 공통 인증·Host/Origin 보호
    personal_launcher.py         보호된 개인 연결의 stdio 실행 [이전 완료]
  api/                           FastAPI 전송 어댑터 [R1부터 실제 범위만]
    router.py                    v1 라우터 결합
    dependencies.py              인증 scope 전달·요청별 의존성
    errors.py                    도메인 결과/오류 → HTTP 응답
    v1/
      access/                    router.py + schemas.py
      documents/                 router.py + schemas.py
      knowledge/                 router.py + schemas.py
      reviews/                   후속 C계열 구현 시 추가
      correspondences/           후속 D계열 구현 시 추가
      sources/                   후속 원본 등록 구현 시 추가
      analysis_jobs/             후속 작업 계약 구현 시 추가
      extractions/               후속 추출물 조회 구현 시 추가
  mcp/                           MCP 전송 어댑터 [책임 분리 완료]
    server.py                    SDK 호출 방어·legacy 도구 결합
    tenant.py                    현재 정책 인가·profile·tenant dispatch
    request_context.py           요청별 권한 ContextVar·Bearer 읽기
    schemas.py                   MCP 입력 모델
    validation.py                SDK 전처리/타입 변환에 대한 계약 방어
    results.py                   MCP CallToolResult·오류 포장
    http.py                      MCP ASGI 전송·전용 제한 설정
    tools/
      documents.py               wiki 읽기·쓰기·검색 도구
      ontology.py                그래프·맥락·연결·영향 도구
      reviews.py                 문서별 검토·정책·되돌림 도구
      correspondences.py         문서 간 대응 도구
      concepts.py                개념 발견·통합 조회 도구
  modules/                       두 전송이 공유하는 업무 처리
    access/policy.py             사용자·tenant·행동·profile 정책 [이전 완료]
    documents/store.py           WikiStore·본문·전체 이력·CAS [이전 완료]
    documents/service.py         공통 문서 조회·검색 등 필요한 업무 호출
    documents/search.py          공통 문자열 검색·탐색 예산 [구현됨]
    ontology/                    온톨로지 업무 [책임 분리 완료]
      store.py                   원문/검토 CAS·그래프 공개·공용 진입
      validation.py, values.py   개체·관계·후보·속성·인용/한정어 검증
      snapshots.py               저장 형식과 현재성 판정
      capture.py                 안전한 파일 읽기·바이트 예산
      context.py                 전체 선택 맥락·관점별 참조 그룹
      connections.py             명시 링크·이름/유형 후보·연결
      constants.py, errors.py    스키마/상한·오류의 단일 소유
      anchors.py                 원문 위치·끝점 검증
    reviews/                    검토/전문가 정책 [책임 분리 완료]
      store.py                   공용 메서드·같은 잠금의 명시 조립
      contracts.py, values.py    한도/오류·actor/입력/claim ID
      state.py, events.py        관점/정책 상태·UUID/UTC 시계
      capture.py, ledger.py      안전 캡처·전체 원장 검사/공개
      render.py, validation.py   현재 유효 판단·근거/모든 층 검사
      commands.py                원문 검토·역이벤트
      policy_values.py, policy_commands.py  전문가 정책 값·변경/역이벤트
    correspondences/             문서 간 대응 [책임 분리 완료]
      store.py                   공용 메서드와 명시 협력 호출
      contracts.py, schema.py    상한/예외·값/범위/참조 검증
      state.py, identifiers.py   의존 상태·token·ID 발급
      capture.py                 대응별 의존 탐색·캡처 예산
      ledger.py                  원장 전체 검사·이벤트/파일 공개
      evidence.py                원문·그래프 근거 대조
      applicability.py           범위·기간·의존 상태의 적용 판단
      preparation.py             변경 계획·prepare token
      queries.py                 상세/준비 조회·발견
      commands.py                제안·검토·정책·역이벤트 저장
    knowledge/                  개념/영향 읽기 조합 [책임 분리 완료]
      concepts.py                개념 발견·선택 조회의 공용 진입
      discovery.py, references.py  발견·버전/출처/끝점 참조
      queries.py, projections.py, values.py  조회·결과/완전성·검색 값
      capture.py                 요청별 공유 상태·예산의 공용 진입
      capture_io.py, capture_documents.py, capture_correspondences.py
      capture_scan.py, capture_errors.py  안전 읽기·문서/대응·제한된 탐색
      schema.py, contracts.py    버전 있는 대상·한도/오류
      impact.py                  영향 조회의 공용 진입
      impact_snapshot.py, impact_capture.py, impact_history.py
      impact_links.py, impact_references.py, impact_result.py
                                  기준/캡처·복원·현재/과거 비교·부분 결과
  mcp_server.py                  기존 명령·공개 factory의 얇은 호환 진입점
  personal_launcher.py           실제 MCP 등록의 main 위임
  storage.py, anchors.py, reviews.py  고정 과거 fixture를 위한 명시 호환
  tests/                         core 전용 회귀·계약 검사
    modules/                      업무/저장·보존·경합·구조 검사 [이전 완료]
    mcp/                          실제 MCP 계약·stdio/HTTP 검사 [이전 완료]
    api/                          실제 구현된 HTTP 계약 검사 [R1]
    runtime/                      개인 런처·기존 진입점 호환 검사 [이전 완료]
    tools/                        수동 검증/전환 점검의 회귀 [이전 완료]
    common/                       공용 JSON/정리 경고 계약 [이전 완료]
    fixtures/                     v3/v4/v5 고정 구현 [바이트 그대로 이전]
tools/                           수동 평가·전환 확인 명령 [이전 완료]
  transition_check.py
  verify_codex.py
  verify_ontology.py
  verify_answers.py
  verify_transition.py
evals/                           기존 평가 자료·기록을 그대로 유지
docs/                            기존 결정·계획이 스펙과 수용 조건 관리
```

전역 `services.py`에 모든 업무를 모으지 않습니다. `runtime/services.py`는 객체 연결만 맡고 실제 처리 함수는 담당 업무 모듈에 둡니다. `service.py`·`schema.py`·`store.py`를 모든 모듈에 의무적으로 만들지 않으며 실제 책임이 있을 때만 분리합니다. `sources/analysis_jobs/extractions` 업무 모듈은 후속 기능 구현 시 `modules/` 아래에 추가합니다. 공통 추출 규약은 D-044의 책임이며 아직 없는 rules 모듈을 이번 구조 정리에서 생성하지 않습니다.

`store.py`는 업무의 공용 진입이며 순수 파일 저장 어댑터를 뜻하지 않습니다. 온톨로지·대응은 이미 검증·캡처·판단·조회/저장 협력 책임을 분리했고, 같은 저장소와 임계구역을 공용 Store에서 조립합니다. 남은 기존 Store도 실제 결합을 보존하며 분리하고 전부 `infrastructure/`로 옮기지 않습니다. DB를 선택할 때는 본문 보존 저장, tenant의 일관성 조회, 기준을 검사한 원장/그래프 공개에 맞는 작은 port를 설계합니다. 현재는 Markdown/JSON을 유지하며 DB/ORM·범용 Repository·별도 큐·이벤트 버스를 도입하지 않습니다.

#### 의존 방향과 도메인별 FastAPI 연결

```text
runtime: 설정·공통 HTTP 보호·서비스 구성·단일 ASGI/stdio 기동
                    ↓ 조립/주입
             api                mcp
              └───────┬─────────┘
                      ↓ 명시 입력 + 서버가 확인한 scope
           modules의 공용 업무 서비스/기존 Store facade
                      ↓
          같은 tenant의 파일 저장·전체 이력·원장
```

- `api`와 `mcp`는 서로 import하거나 내부 HTTP/MCP 호출을 하지 않습니다. 어댑터는 입력 변환·전송별 형식/상태 코드만 맡고 검색·승인·정책 적용·저장 규칙을 복제하지 않습니다.
- `modules`는 FastAPI Request/Depends, MCP CallToolResult/Context, `runtime`을 import하지 않습니다. 조립이 필요한 객체·scope는 호출 인자로 전달하고 현재 정책은 각 요청에서 확인합니다. 과거 scope·job 입력의 정책 revision을 다음 요청의 허가로 재사용하지 않습니다.
- `runtime`은 모듈과 양쪽 어댑터를 구성합니다. HTTP middleware는 이 조립 지점에서 양쪽 진입점을 감싸되 MCP 전용 JSON/메서드/8 MiB 제한과 파일/일반 API 제한은 각 어댑터에 남깁니다. FastAPI dependency가 mount된 MCP를 자동 보호한다고 가정하지 않습니다.
- `modules/knowledge`는 여러 업무의 읽기 조합 계층입니다. 다른 모듈이 이를 역으로 import해 순환하게 만들지 않습니다. 현재 `ontology↔reviews` 지연 import·private 함수 공유는 이전 중 명시한 과도기 의존으로 보존하며, 순수 검증/공개 업무 경계를 좁게 추출한 뒤 제거합니다. 폴더만 나눴다고 순환 의존이 해소됐다고 표시하지 않습니다.
- Pydantic HTTP/MCP 입력 모델은 전송 계약이고 업무 검증의 원본을 대신하지 않습니다. 이름이 같은 외부 입력 모델을 공유하려고 한 어댑터가 다른 어댑터의 schema를 import하지 않습니다. 재사용할 주장·revision 규칙은 담당 업무 모듈에 둡니다. `schema_version`은 온톨로지 형식, `api/v1`은 HTTP 계약 버전이므로 별개입니다.

| FastAPI 위치 | 담당 D-043 API·업무 | 공통 처리 |
| --- | --- | --- |
| `api/v1/access` | A01 소속·허용 행동 | access 정책 |
| `api/v1/documents` | A02/A03·B01, 후속 C01–C04의 목록·본문·검색·판본 | documents |
| `api/v1/knowledge` | A04, B02–B07의 유효 지식·기계층·개념·맥락·연결·영향 | reviews·ontology·knowledge의 명시 읽기 기능 |
| `api/v1/reviews` | C05–C10의 검토·업무 판단·역이벤트·이력 | reviews |
| `api/v1/correspondences` | D01–D09 | correspondences |
| `api/v1/sources`, `analysis_jobs`, `extractions` | S 원본·작업·추출물의 실제 구현 범위 | 같은 이름의 후속 업무 모듈 |

각 API 폴더는 APIRouter와 요청/응답 schema를 함께 둡니다. **도메인 소유와 URL prefix를 동일시하지 않습니다.** 예를 들어 `/documents/knowledge`는 knowledge 어댑터가 맡을 수 있으며 D-043의 URL을 폴더 이름에 맞추려고 바꾸지 않습니다. A01의 비-tenant 경로와 나머지 tenant 경로, 버전 prefix는 라우터 결합에서 정확히 한 번 적용합니다. E/F의 전역 조회·대화·결과·비교 후보는 계약 확정 후 소유를 정하며 R1 네 읽기 경로만으로 먼저 필요한 세 API 폴더를 구현합니다.

#### 현재 파일의 이전 지도와 보존 조건

| 이전 전 위치 | 실제 위치/유지하는 진입 |
| --- | --- |
| `core/storage.py`, `core/access.py` | `modules/documents/store.py`, `modules/access/policy.py`; 기존 Store/인가 로직 재사용 |
| `core/ontology.py`, `core/anchors.py`, `core/reviews.py` | `modules/ontology/store.py`, `ontology/anchors.py`, `reviews/store.py`; 첫 이동에서 형식·원장·규칙을 함께 보존 |
| `core/correspondences.py`, `core/correspondence_schema.py` | `modules/correspondences/store.py`, `schema.py` |
| `core/concepts.py`, `concept_capture.py`, `concept_schema.py`, `impact.py` | `modules/knowledge/concepts.py`, `capture.py`, `schema.py`, `impact.py` |
| `core/mcp_server.py` | 서버/입력/도구/결과는 `mcp/`, 검색은 `modules/documents/`, 실행/공통 HTTP 조립은 `runtime/` |
| `core/personal_launcher.py` | 구현은 `runtime/`, 기존 `-m core.personal_launcher` 진입은 보존 |
| `core/test_*.py`, `core/fixtures/` | 사용자 선택인 `core/tests/`와 `core/tests/fixtures/`; import·mock·경로·자동 발견 명령 갱신 |
| `core/verify_*.py`, `core/transition_check.py` | 구현과 명령은 `tools.*`; 옛 도구 파일은 제거하고 README·내부 소비자를 갱신 |

실제 이전은 PLAN의 B0 (정리로 삭제된 참고 자료)의 한 묶음씩 수행합니다. `core.mcp_server`의 공개 factory·`core.personal_launcher` 실행 경로와 기존 설정을 보존하는 동안 호환 모듈은 명시한 공개 심볼만 위임하며 새 업무 코드를 쌓지 않습니다. 이전 완료한 내부 import는 새 경로로 맞추고 구 경로·신 경로에 구현을 복제하지 않습니다.

특히 다음은 단순 파일 이동에도 검증해야 합니다.

1. `storage.py`·개인 런처의 `__file__` 부모 계산이 새 디렉토리 때문에 data/.venv 위치를 바꾸지 않게 합니다. 공통 기본 경로는 `core/paths.py`의 전송/runtime에 의존하지 않는 좁은 기준 모듈에 두고, `runtime/paths.py`가 실행 인수·설정을 검증해 실제 경로를 명시 주입합니다. 공개 `WikiStore()`의 무인자 기본 data 계약도 같은 기준을 사용해 보존하며 modules가 runtime을 역 import하지 않습니다. 기본/명시 데이터 루트·tenant 경계·CLI 인수·환경 해석을 유지하고 실제 data/.local·정책·토큰은 이동하지 않습니다.
2. MCP 도구 이름·설명·입력·annotation·SDK 전처리 방어, 현재 코드의 확정된 온톨로지 형식/소비자 제약을 보존합니다. 구조 정리와 새 스키마 도입을 같은 변경에 섞지 않습니다.
3. 본문 CAS·전체 파일 이력·그래프의 source/state guard·원장 hash/역이벤트·손상 차단·성공 cleanup 경고와 응답 유실을 보존합니다. revision/history ID/정규 JSON hash·generation 의미도 바꾸지 않습니다.
4. ConceptCapture와 대응 캡처의 같은 잠금·공유 예산·직접 내부 읽기를 단순 public query 여러 번으로 바꾸지 않습니다. 잠금 비재진입과 시점 일관성을 유지합니다.
5. 단순 re-export한 상수/함수는 기존 `patch('core.…')`가 새 구현에 작동한다는 보장이 아닙니다. 내부 검사는 실제 소유 모듈을 대상으로 갱신하고 공개 진입 호환 검사를 별도로 유지합니다. 로그 이름·fixture import·전체 검사 발견도 확인합니다.
6. import만으로 앱 생성·정책/자료 읽기·폴더 생성·서버 기동을 하지 않습니다. stdio가 미구현 FastAPI 초기화를 요구하지 않게 하며 HTTP 부모 lifespan의 MCP 시작/종료는 D-043대로 한 번입니다.

#### SDD 적용과 남은 결정

계약의 원본은 기존 D-043/D-044, 코드 배치·의존 규칙은 이 결정, 실제 작업 묶음·수용 조건·실행 결과는 PLAN입니다. 구현 전 해당 묶음의 입력·출력·필수/null·권한·CAS·상한·오류·실패 후 상태와 예시를 고정하고, 그 계약의 검사를 준비한 다음 구현합니다. OpenAPI는 실제 구현된 HTTP 계약에서 생성하며 독립 수기 스펙과 이중 관리하지 않습니다. 스펙 문서가 있다는 이유로 테스트·업무 의미 검증을 대신하지 않습니다.

파일 저장을 DB로 바꿀 때의 테이블·트랜잭션·마이그레이션, 배포 패키징, 일반 쓰기 영수증, E/F의 저장/공유 권한은 여전히 해당 후속 결정입니다. DB 전환은 현재 파일명 기반 history revision·정규 바이트 hash·같은 잠금의 상태 계산을 보존하거나 명시 이관해야 하므로 단순 Repository 교체만으로 해결된다고 약속하지 않습니다. 새로운 업무에서 필요한 세부 모듈 내부 분리는 실제 구현 범위에서 정합니다.

#### 공용 코드와 주석의 적용 기준 (2026-10-25)

사용자의 후속 요청으로 **동일 계약의 공용 기술 코드와 한국어 설명을 구현**했습니다. 이는 B0-1–3의 전체 파일 재배치나 FastAPI 구현 완료가 아닌 선행 코드 정리입니다. 실제 공용 위치는 [core/common/json_codec.py](../../../core/common/json_codec.py)·[cleanup.py](../../../core/common/cleanup.py)이며 검사는 후속 B0-3에서 tests/common/test_common.py (정리로 삭제된 참고 자료)로 이전했습니다.

- 같은 계약을 여러 곳이 사용하는 기술 기능만 공용화합니다. 정규 JSON 인코딩/hash는 검토 업무의 private 함수에서 독립시키고, 그래프·검토·대응·MCP가 같은 정리 경고 변환을 사용합니다. 기존 `reviews._encode/_hash` import는 호환 alias로 유지하되 실제 구현은 공용 모듈 하나에만 둡니다. 공용 모듈은 업무·전송 SDK·파일 접근에 의존하지 않습니다.
- JSON의 Unicode·키 정렬·구분자·UTF-8·마지막 LF를 보존합니다. 원장 hash는 LF까지 포함하고, 그래프 인코더의 기존 `allow_nan=True` 옵션도 명시해 유지합니다. 원문/raw hash·전송 JSON·응답 크기 계산·평가 기록은 계약이 다르므로 저장 인코더로 일괄 교체하지 않습니다.
- 정리 경고의 상대 POSIX 경로·오류 종류·errno와 예외 전파를 유지합니다. 공용 변환은 `CleanupFailure`·`SaveResult`나 파일을 변경하지 않으며 정리 경고 때문에 성공한 저장을 다시 실행하지 않습니다.
- 중복 키 검출·비유한수 처리·오류 종류가 연결된 엄격 파싱, 원문/앵커의 경로 허용 범위, 요청별 공유 캡처와 잠금은 외형이 비슷하다는 이유로 합치지 않습니다. 현재 검증 차이와 같은 임계구역을 보존하고 필요할 때 해당 업무 소유 아래에서 별도로 설계합니다. 과거 형식 fixture는 회귀 기준이므로 공용화 대상에서 제외합니다.
- 각 생산 모듈은 한국어 역할 설명을 두고, 주요 진입점에는 상태/범위·입출력·부작용을 설명합니다. 권한 확인 순서·CAS·전체 이력·원장·비재진입 잠금·정리 경고 등 이해하기 어려운 선택에는 **왜 필요한지**를 적습니다. 단순 문장을 반복하거나 매 줄을 풀이하는 주석은 늘리지 않습니다. AI에 노출되는 MCP 도구 docstring은 외부 계약이므로 이번 설명 보완에서 변경하지 않습니다.

실제 회귀·저장 바이트 대조·독립 검토 결과는 PLAN에서 관리합니다. 새 저장 형식·스키마·권한·DB·API를 도입한 변경으로 해석하지 않습니다.

#### 큰 MCP 파일의 실제 책임 분리 (2026-10-25)

사용자가 공용화 후에도 1,000줄 이상의 파일이 남아 있음을 지적해 **가장 큰 MCP 파일을 먼저 실제로 분해**했습니다. 공용 함수 추출과 주석 보완만으로 책임 분리가 끝났다고 표시하지 않습니다. 초기 B0-1 선행 순서는 MCP 분해 우선으로 조정했습니다. 당시 남긴 큰 ontology/correspondences 파일은 아래 후속 요청에서 분해했으며 다른 업무와 기존 검사/평가 도구 이전은 남깁니다.

| 현재 읽을 위치 | 맡는 책임 | 분리 후 줄 수 |
| --- | --- | --- |
| `core/mcp_server.py` | 기존 공개 factory·명령의 명시적 호환 진입 | 18 |
| `core/mcp/server.py` / `tenant.py` | SDK 호출 방어·legacy 조립 / 현재 정책·tenant/profile dispatch | 47 / 220 |
| `core/mcp/schemas.py` / `validation.py` | 입력 모델·설명 / SDK 변환 전 raw 인자 방어 | 213 / 215 |
| `core/mcp/results.py` / `http.py` | 결과·오류·로그 / MCP 인증·Host/Origin·전송 구성 | 143 / 110 |
| `core/mcp/request_context.py` | 한 곳의 요청별 권한 문맥과 자격증명 읽기 | 22 |
| `core/mcp/tools/` | 문서·온톨로지·검토·대응·개념의 실제 도구 등록 | 파일별 71–241 |
| `core/runtime/mcp_cli.py` | 기존 실행 인수와 stdio/HTTP 분기 | 80 |
| `core/modules/documents/search.py` | 공통 문서 검색·snippet·탐색 한도 | 93 |

기존 1,738줄을 다른 이름의 큰 파일로 옮기거나 동적 `exec`/전체 기호 재수출로 감추지 않았습니다. 호환 진입은 공개 factory와 main만 명시적으로 연결합니다. 내부 상수 mock과 로그 검사는 실제 새 소유 위치로 갱신하며 기존 CLI/외부 factory의 동작은 보존합니다. 검색의 per-file 오류 코드는 호출자가 명시한 분류 함수를 사용해 기존 값을 유지하고 업무 모듈에서 MCP를 역 import하지 않습니다.

줄 수만으로 완료를 판단하지 않습니다. 각 파일이 하나의 읽을 만한 책임을 갖고, 새 기능을 같은 거대 서버 파일에 다시 쌓지 않으며, 입력·도구 정의·현재 권한·같은 저장 계약을 유지해야 합니다. MCP 분리 당시 남겼던 `ontology.py`1,211줄·`correspondences.py`1,005줄은 아래 후속 요청에서 분해했습니다. 백엔드 전체의 남은 업무/검사 이전은 PLAN을 따릅니다.

#### 온톨로지·문서 간 대응의 실제 책임 분리 (2026-10-25)

사용자가 지정한 두 큰 업무 파일을 정한 `core/modules/ontology`·`core/modules/correspondences`로 **실제 분해·연결·회귀 검증**했습니다. 루트의 `ontology.py/anchors.py/correspondences.py/correspondence_schema.py`는 필요한 기호를 명시적으로 재노출하는 호환 진입점만 맡습니다. 내부 소비자인 검토·개념 캡처/조회·영향 조회·MCP·검증 도구는 새 실제 소유 모듈을 직접 참조합니다. 고정된 과거 fixture와 호환성 검사만 이전 진입을 유지할 수 있습니다.

| 업무 | 공용 진입과 실제 협력 책임 | 분리 후 크기 |
| --- | --- | --- |
| 온톨로지 | [store.py](../../../core/modules/ontology/store.py)가 source/state CAS·생성/공개 순서·공유 잠금 소유. 값/주장 검증·snapshot·capture·context·connections를 명시 협력 함수/객체로 분리 | 공용 Store156줄·최대313줄, 기존 호환62줄 |
| 문서 간 대응 | [store.py](../../../core/modules/correspondences/store.py)가 저장소·인증 actor와 공용 메서드를 소유. schema/contracts·state/capture·ledger·evidence/applicability·preparation·queries/commands로 분리 | 공용 Store122줄·최대251줄, 기존 호환45줄 |

기존 긴 검증 함수도 인용/끝점·개체·관계·후보·속성의 협력 처리로 나눴습니다. Mixin·동적 메서드 부착·exec/동적 로딩·별표 재수출로 길이를 감추지 않습니다. 한도/오류는 ontology의 constants/errors와 대응의 contracts가 각각 소유하고, 한도 mock은 이 실제 위치를 대상으로 합니다. 대응 ID 생성은 identifiers의 한 지점을 사용해 제안·판단의 기존 UUID4 순서를 유지합니다.

`OntologyStore.generate()`의 lazy review guard, 이미 잠긴 조회에서 쓰는 private 캡처, `_Capture`의 요청별 공유 바이트와 root별 탐색 상태, 대응 prepare/변경의 같은 잠금·의존 closure·lane·undo는 기존 경계를 유지합니다. 협력 함수가 public query를 다시 호출하거나 잠금을 추가하지 않습니다. 저장 JSON/LF·raw hash·generation·복합 CAS·손상 차단·성공 cleanup 경고도 변경하지 않습니다. schema1–6과 스키마 기본값/한정어/원문 근거를 보존하며 새 의미나 승인을 도입하지 않습니다.

새 경계 검사는 tests/modules/test_domain_layout.py (정리로 삭제된 참고 자료)에 배치했습니다. 모든 새 업무 모듈의 import에 전송/runtime 또는 저장소/폴더 초기화가 없는지, 호환 기호가 같은 클래스인지, 실제 위임 경로가 tenant 잠금을 재획득하지 않는지 확인합니다. 기존 테스트의 assertion은 유지하고 내부 import·mock만 실제 소유에 맞춥니다. 기존 검사 전체 이전·다른 업무 모듈·일반 API·DB·운영 데이터 이관은 이번 범위에 포함하지 않으며 실제 결과는 PLAN에 기록합니다.

#### 검토·개념/영향 조회 분리와 테스트 이전 (2026-10-25)

후속 사용자 요청으로 [검토](../../../core/modules/reviews/store.py)와 [개념 조회](../../../core/modules/knowledge/concepts.py)·[공유 캡처](../../../core/modules/knowledge/capture.py)·[영향 조회](../../../core/modules/knowledge/impact.py)를 정한 업무 모듈로 분해했습니다. Store/Capture가 같은 요청 상태와 공용 계약을 소유하고 실제 협력 처리는 명시적으로 호출합니다. 기존 루트5파일은 필요한 클래스/오류/기호의 호환 import만 맡으며 내부 소비자는 실제 소유 모듈을 참조합니다.

검토는 값·actor/claim 식별, 관점/정책 상태, 원문/그래프/원장 캡처, 원장 replay/공개, 현재 판단 render, 근거/유효층 검증, 원문 검토와 전문가 정책 명령으로 나눴습니다. 공용 Store118줄·최대153줄이며 UUID/UTC 시계는 events가 소유합니다. 검토/정책의 모든 층 검증·역이벤트·복합 CAS·성공 cleanup 구분을 같은 잠금 안에서 유지합니다.

개념은 발견·선택 조회·버전/출처 참조·결과/완전성, 공유 캡처는 IO·문서·대응별 탐색·스캔·오류, 영향은 기준/캡처·과거 복원·연결/개체 비교·부분 결과로 나눴습니다. 공용 ConceptStore112줄·ConceptCapture155줄·ImpactStore42줄, 구현 최대218줄입니다. 공유 byte 예산과 root별 docs/reached/순환 stack, 한 번의 tenant 잠금, 전체 선택 맥락·현재/과거/다른 범위·조회 완전성·manifest를 보존합니다. 기준 없는 영향 변경 추정이나 자동 재추출/정책 재적용을 추가하지 않습니다.

`core/test_*.py`32파일은 책임별 `tests/{modules,mcp,runtime,tools,common}`으로 옮기고 기존32파일의 검증문을 유지합니다. v3/v4/v5 고정 fixture3개는 바이트를 바꾸지 않고 `tests/fixtures`로 이전합니다. 파일 위치를 전제로 한 프로젝트/fixture 경로·상호 import·내부 mock을 함께 갱신하고, 전체 검사는 `unittest discover -s tests -t . -v`로 자동 발견합니다. 업무/전송/실행 코드가 tests를 import하지 않도록 경계 검사도 확장합니다. 수동 검증 도구가 합성 입력을 참조하는 경로는 새 tests 위치를 사용하며 도구 구현 자체의 `tools/` 이전은 후속입니다.

온톨로지↔검토의 지연 guard와 개념 서비스의 capture 지연 import는 명시적으로 유지합니다. 폴더 분리만으로 모든 순환·결합이 제거됐다고 표시하지 않습니다. 접근 정책·WikiStore·개인 런처·수동 도구의 전체 이전과 FastAPI는 이번에 착수하지 않으며 실제 검사 결과와 남은 B0 상태는 PLAN에 기록합니다.

#### 저장·권한·런처·수동 도구 이전과 최소 호환 (2026-10-25)

남은 기존 구현을 [documents/store.py](../../../core/modules/documents/store.py)·[access/policy.py](../../../core/modules/access/policy.py)·[runtime/personal_launcher.py](../../../core/runtime/personal_launcher.py)·프로젝트 루트 [tools](../../../tools)로 이전했습니다. 실제 처리·옵션·실패 계약을 유지하고 새 추상화·저장 방식·FastAPI는 도입하지 않습니다. [core/paths.py](../../../core/paths.py)는 프로젝트/data/.venv 기준만 계산하며 파일 생성·설정 읽기·서버 기동을 하지 않습니다. 무인자 WikiStore의 default data와 런처/수동 도구의 프로젝트 기준이 같은 위치를 사용합니다.

| core 직속에 남기는 파일 | 이유 |
| --- | --- |
| `mcp_server.py`, `personal_launcher.py` | 실제 등록된 개인 MCP 실행과 그 자식 실행 진입을 유지. 서버 factory/main과 런처 main만 명시 위임하며 `SystemExit(main())`로 기존 실패 종료 코드도 전달 |
| `storage.py`, `anchors.py`, `reviews.py` | 고정 과거 v3/v4/v5 fixture가 직접 import하는 저장 타입·원문 위치 함수·review guard의 동일 객체를 제공. 고정 fixture3개의 바이트를 바꾸거나 동적 모듈 alias로 우회하지 않음 |
| `paths.py` | 업무·실행·수동 도구가 공유하는 전송 독립적인 순수 기본 경로 |

호출처가 canonical owner로 전환된 `ontology.py`·`correspondences.py`·`correspondence_schema.py`·`concepts.py`·`concept_capture.py`·`concept_schema.py`·`impact.py` 호환7파일과 이전 access 구현을 제거했습니다. 새 업무·전송은 남은 저장/검토 호환을 거치지 않습니다. 옛 수동 도구5파일도 삭제하며 **수동 명령은 `python -m tools.verify_codex`·`tools.verify_ontology`·`tools.verify_answers`·`tools.transition_check`로 변경**합니다. `tools.verify_transition`은 직접 CLI가 없는 보조 모듈이고 실제 전환 명령은 `tools.verify_codex --transition`입니다. 현재 MCP 등록과 그 실행 명령은 그대로 유지하므로 운영 설정을 고칠 필요가 없습니다.

사용자가 테스트를 core 하위로 옮긴 뜻을 반영해 **`core/tests`를 현재 공식 검사 위치**로 정했습니다. 전체는 `.venv/bin/python -B -m unittest discover -s core/tests -t . -v`입니다. module import·subprocess의 프로젝트 cwd·고정 fixture 상대 경로·실제 구현의 mock·문서 링크/명령을 함께 맞춥니다. 기존 검증문·고정 fixture와 수동 평가의 논리/실행 조건은 유지합니다. 새 경로/등록 위임/import 부작용 검사와 실제 stdio/loopback HTTP를 포함한 결과는 PLAN 한 곳에 기록하며 기존 실제 data/.local·정책/토큰·등록/서버·의존성은 변경하지 않습니다.

### D-047 — 원격 PC의 최초 연결과 설정 수명주기 (2026-10-25)

상태: **사용자가 확인한 최종 작업 환경의 요구와 설정 동선 설계**입니다. 현재 같은 PC의 실행에서 끝내지 않고, 다른 작업 PC의 Electron이 서버 PC의 FastAPI 일반 API를 호출하며 같은 작업 PC의 개인 CLI가 서버 MCP에 접속합니다. D-043의 두 진입점·공통 인증/저장 경계를 유지합니다. 기존 시안은 연결 상태 표시만 있고 서버 미설정 상태에서 시작하는 설정 동선이 없었으므로 이를 별도 사용 사례로 보완합니다. 이번 변경은 문서 설계이며 실제 서버 배포·네트워크 공개·자격 증명 발급/입력·MCP 설정 적용·UI 구현을 실행하지 않습니다.

#### 두 PC의 역할과 설정 진입점

| 위치 | 책임 |
| --- | --- |
| 서버 PC | 하나의 위키 백엔드가 일반 API와 MCP를 제공하고 같은 tenant 자료·인증/행동 정책·저장 모듈을 사용. 데이터 위치·상시 실행·HTTPS 주소와 운영 관리는 서버 측 책임 |
| 작업 PC | Electron의 일반 API 연결, 개인 CLI/AI 실행과 MCP 연결, 필요한 작업용 파일의 수신. 서버 PC의 Python 환경·절대 파일 경로·위키 저장소를 작업 PC에 복제하는 것을 전제로 하지 않음 |

최초 실행·서버 미설정·인증 실패 때는 tenant 접근 확인 전에 **연결 설정**을 열 수 있어야 합니다. `WorkspaceBoundary` 안의 작업 공간 화면만을 진입점으로 두지 않습니다. API 연결만 완료한 사용자는 저장된 자료 조회를 시작할 수 있으며 개인 AI 준비를 나중에 이어갈 수 있습니다. 작업 공간 설정에서는 연결 관리로 돌아오는 경로를 제공합니다. 화면 배치·책임은 [앱 설계의 최초 연결](../../../app/docs/component-architecture.md#31-원격-pc의-최초-연결과-연결-관리)에서 관리합니다.

#### 최초 연결과 변경 사용 사례

기존 UC-19와 대화에서 정의한 ‘작업 범위 확인/개인 AI 준비’의 세부 흐름이며 기존 UC 번호를 바꾸지 않습니다. 아래 CON 번호는 이 설정 설계 안의 참조입니다.

| 참조 | 사용자 상황·목표 | 완료 결과 |
| --- | --- | --- |
| CON-01 처음 자료 서버 연결 | 새 작업 PC에서 원격 서버 주소와 서버용 개인 인증을 설정 | 일반 API에서 확인한 자기 소속·허용 행동·관점으로 작업 공간을 선택하고 읽기 시작. 인증/조회 실패를 빈 공간으로 표시하지 않음 |
| CON-02 개인 AI·MCP 연결 | 자료는 읽을 수 있으나 새 질문/분석을 실행하려 함 | 선택한 로컬 CLI의 실행/AI 로그인과 실제 MCP 인증·허용 행동을 각각 확인. API/MCP 대상 일치의 확인 수준을 표시하고 준비된 범위만 명시 실행 |
| CON-03 저장한 연결 다시 사용 | 앱 재시작·다른 PC의 새 설치·인증 변경 뒤 재접속 | 해당 PC의 연결/인증을 다시 확인하고 같은 허용 서버 자료를 읽음. 기기 간 인증정보 자동 복제·자료 동기화를 가정하지 않음 |
| CON-04 서버·인증·공간 변경 | 서버 주소나 사용자/소속이 달라짐 | 적용 전 변경 대상을 확인하고 이전 요청/캐시/초안과 분리. 성공한 기존 작업은 보존하고 새 연결을 검증한 뒤 전환 |
| CON-05 연결 진단·복구 | API만 연결됨, MCP 실패, 권한 회수, 지원 버전 불일치 등 | 실패한 계층과 다음 행동을 식별하고 다시 확인. 재연결로 새 분석·쓰기·권한 상승을 자동 실행하지 않음 |
| CON-06 원격 접속 준비·인계 | 운영자가 새 작업 PC에 접속 방법을 제공해야 함 | 서버 주소·지원 경로/클라이언트·자격 증명 전달/회수·허용 공간/행동과 운영 담당을 인계. 실제 값·배포 방법은 운영 준비 때 확정 |

#### 입력·확인·저장 경계

- **자료 서버 설정:** 연결 표시명, 서버 기본 주소와 일반 API/MCP의 실제 경로를 하나의 연결 대상으로 관리합니다. D-043의 `/api/v1`·`/mcp`를 기본 설계로 제시하되 reverse proxy의 경로 prefix 등 실제 배포 경로는 확인해야 합니다. 두 URL의 문자열 유사성만으로 같은 저장소라고 승인하지 않습니다. 원격에서는 검증된 HTTPS 연결을 사용하며 임시 legacy 터널 절차를 개인 인증 운영 연결로 그대로 간주하지 않습니다.
- **인증:** 현행 PoC의 개인 서버 자격 증명과 개인 AI 로그인을 구분합니다. 서버 인증은 Electron main/CLI의 각각 정한 보호된 경로에서 다루며 URL·채팅·작업 본문·위키·로그·일반 앱 상태에 비밀을 저장하지 않습니다. 보호 저장소의 구체 구현·CLI별 비밀 전달·발급/회전 방법은 후속 설계/검증 사항입니다. 같은 인증 주체를 확인하는 것과 같은 토큰 바이트를 공유하는 것은 다릅니다. OAuth/SSO·관리자 발급 UI가 구현됐다고 표시하지 않습니다.
- **공간 선택:** 일반 API의 예정된 access-context와 MCP의 실제 `access_context`로 자기 소속·허용 profile·행동을 각각 확인합니다. 입력한 tenant나 화면의 권한 체크박스가 권한을 부여하지 않습니다. 서버 권한 오류를 다른 주소/legacy/과거 정책으로 우회하지 않습니다.
- **CLI 설정:** 지원할 CLI/어댑터·설치 경로·개인 AI 로그인 상태를 확인하고 MCP 설정의 대상·변경 전후·적용 범위를 보여줍니다. 기존 다른 MCP 등록을 보존하고 확인되지 않은 셸/실행 중 CLI에 임의 입력을 보내지 않습니다. 자동 설정 편집의 지원 범위·백업/충돌·취소/복구·재시작 필요 여부는 어댑터별 구현 전에 고정합니다. 일반 API 연결 성공을 CLI의 실제 MCP 초기화/인증 성공으로 대신하지 않습니다.
- **연결 시험:** API 도달/인증/소속 확인, 실제 MCP 프로토콜 초기화·도구/접근 맥락 확인, 지원 계약·버전과 허용 행동을 분리해 표시합니다. 설정 검증은 기본적으로 읽기만 사용합니다. 쓰기 권한이 있다는 응답을 저장 성공 증거로 표시하지 않으며 실제 쓰기 시험은 격리 자료·별도 실행 범위로 다룹니다. 개인 AI 준비도 새 모델 호출이나 분석 실행과 구분합니다.
- **대상 일치:** API와 MCP의 동일 백엔드·인증 주체·tenant 여부를 확인하는 안정된 식별/호환성 handshake는 아직 제공되는 계약이 아닙니다. 구체 반환 필드·검증 방법을 후속으로 정하고 정책 hash나 hostname만으로 완료를 선언하지 않습니다. 필수 대조가 미확인이면 그 상태를 유지하고 새 AI 저장 실행을 허용하지 않습니다. 확인된 API 읽기는 별도로 이용할 수 있습니다.
- **수명주기:** 연결 저장·서버 변경·인증 교체·로그아웃/연결 해제·재시작 뒤 재확인을 설계합니다. 주체/서버/tenant가 달라지면 이전 요청의 늦은 응답과 자료를 새 공간에 표시하지 않습니다. 초안은 원래 범위에서 보존하며 연결 전환이 운영 자료를 이동/삭제하지 않습니다. 앱 자격 증명 제거와 서버의 실제 토큰 회수는 다른 동작입니다.

#### Electron 첫 연결 구현 범위 (2026-10-25)

CON-01의 첫 구현은 기존 access-context의 조회/선택 재확인입니다. 보호 저장소 계약이 아직 없으므로 토큰은 main 세션 메모리에만 두고 제출 직후 입력을 비웁니다. 새로고침은 공개 snapshot으로 복원하고 재시작에는 재입력합니다. HTTPS/loopback HTTP·정확한 호출자/인자·응답 검사·redirect 거부와 선택 전 재조회/연결 세대 검사로 회수된 범위·늦은 응답을 거부합니다. OS 보호 저장·자동 재접속·CLI/MCP 대상 일치와 운영 정책 변경은 후속입니다.

#### 설정 시안 반영 (2026-10-25)

이후 요청에 따라 기존 1920×1080 HTML에 최초 연결·연결 관리를 반영했습니다. 전역 진입점은 tenant 확인 전에도 열리며, API 확인 후 자료 읽기와 개인 AI 준비를 분기합니다. 서버 설정 초안/적용 연결·CLI/MCP 모의 등록과 확인 수준을 분리하고, 취소·주소 전환·실패·재연결에서 기존 초안/성공 작업과 다른 MCP 등록을 보존합니다. 새 연결에 옛 범위 자료를 섞지 않으며 대상 일치 계약이 미확인이면 새 AI 요청·저장을 허용하지 않습니다.

이는 화면과 메모리 상태의 시연입니다. 서버 인증 필드는 비활성화했고 실제 비밀 입력/저장·네트워크·CLI 설정 적용·권한 변경을 수행하지 않습니다. 실제 두 PC 연결 완료와 구분하며 확인한 동선·검사·소스 hash는 PLAN의 별도 시안 검증 기록을 따릅니다. 위 문서 설계 당시의 미실행 기록은 보존합니다.

#### 미결 계약과 실제 완료 기준

서버 공개 주소·배포/인증서 운영, 자격 증명 발급/회수·PC별 보호 저장/전달, API/MCP의 안정된 대상 식별과 호환성 handshake, 지원 CLI/OS별 설정 어댑터와 변경 복구, 작업용 파일 전송의 실제 연결은 미구현/미검증입니다. 이 목록은 각각 D-026/041/043/044의 계약을 연결하며 새 권한을 도입하지 않습니다.

설정 UI 시연, 같은 PC의 loopback 확인, 과거 공유 토큰의 Windows MCP 시험, 새 개인 인증의 실제 두 PC 통합을 각각 기록합니다. 최종 연결 완료는 **다른 작업 PC에서 개인 인증 API 읽기와 CLI의 MCP 연결을 실제로 확인**해야 합니다. AI 분석/저장·파일 전달의 완료는 그 후 별도 범위로 검증하며 초기 읽기 연결과 합산하지 않습니다. 검증 조건과 실행 결과는 PLAN (정리로 삭제된 참고 자료)에서 관리합니다.

### D-048 — 서버 노트북의 WSL2와 Electron 중앙 저장 (2026-10-25)

상태: **사용자가 채택한 운영 방향과 가이드 문서화 / 서버 설치·배포·자료 이전·앱 연결은 미실행**입니다. 사용하지 않는 Windows 노트북을 서버로 두고 여러 작업 PC의 Electron 앱이 같은 서버 자료를 저장·활용하려는 요구에 따라 결정했습니다. 설치·운영 절차는 WSL2 서버 가이드 (정리로 삭제된 참고 자료), 구현 순서·검증 결과는 PLAN (정리로 삭제된 참고 자료)에서 관리합니다.

- **실행 환경:** 서버 노트북에 WSL2·Ubuntu를 설치하고 기존 Python 백엔드를 Linux 환경에서 실행합니다. 작업 PC에는 서버용 WSL2/Python/tenant 자료의 복제를 요구하지 않습니다. 개인 AI CLI의 설치 환경은 해당 클라이언트 지원 조건을 따릅니다. 현재 POSIX 파일 잠금·안전한 파일 읽기·권한 검사를 유지해 Windows 네이티브 이식을 선행 조건으로 추가하지 않는 것이 선택 이유입니다.
- **중앙 자료와 서비스:** WSL의 Linux 파일시스템에 tenant별 자료와 전체 이력·검토/정책/대응 원장을 함께 보관합니다. D-043/D-046의 한 백엔드가 FastAPI와 MCP를 제공하고 같은 현재 인증/권한·업무 서비스·저장소를 사용합니다. Electron 일반 요청은 API, 개인 CLI의 AI 분석/제출은 MCP를 사용하며 저장된 자료 읽기는 개인 AI 실행과 독립적으로 구현합니다.
- **서버 로컬 LLM은 후속 검토:** 사용자는 로컬 LLM의 추가 구축·운영 부담을 고려해 현재 정책으로 먼저 진행하기로 했습니다. 추출·보완은 각 작업 PC의 개인 AI가 수행하고 서버는 공통 지침·맥락 제공과 저장·조회·검증을 맡는 기존 방향을 유지합니다. 서버 로컬 LLM의 1차 추출은 현재 구현 범위와 선행 조건에 추가하지 않으며, 추후 별도 요청에서 필요성·모델·자원·추출/보완 이력 계약을 검토합니다. 도입 시점과 제품은 아직 정하지 않았습니다.
- **배포와 접속:** 백엔드는 loopback과 HTTPS 프록시/터널 경계를 유지하고, 상시 접속에는 고정 HTTPS 주소와 부팅 후 자동 시작·장애 재시작을 준비합니다. Windows 작업 스케줄러가 WSL 전경 프로세스를 실행하는 배치 예시를 가이드에 둡니다. 실제 도메인·터널 제공자/계정·경로·운영 사용자·자격 증명/백업과 재부팅 후 도달 여부는 배포에서 확정·검증합니다.
- **보존과 권한:** 실제 Mac 연결은 이번에 바꾸지 않습니다. 이전 시 D-041의 쓰기 동결·전체 보존/대조·동일 tenant 귀속과 복구 기준을 지킵니다. 과거 data/원격 시험 자료를 운영 자료에 합치거나 read 정책을 자동 승격하지 않습니다. D-047의 최초 설정·개인 인증·API/MCP 대상 대조와 D-043의 저장 성공/실패 경계도 유지합니다.
- **완료의 범위:** 가이드·방향 합의를 WSL 실기기 실행, FastAPI/Electron 구현, 두 PC의 개인 인증 연결이나 AI/쓰기 성공으로 표시하지 않습니다. 실제 일반 API와 통합 실행 진입점은 R1에서 구현하며 현재 없는 명령/설치 파일을 배포된 기능으로 안내하지 않습니다.

[D-016]: DECISIONS.md#d-016--맥북의-로컬-stdio-서버와-프로젝트-codex-cli-연결-2026-10-21-3단계
[D-017]: DECISIONS.md#d-017--windows-원격-poc와-임시-https-터널-2026-10-21-3단계-보완
### D-050 — 잔여 HTTP API와 개인 기록의 최소 계약 (2026-10-25)

사용자가 남은 API 전체 구현을 요청하여 D-043의 B/C/D/S와 후보 E/F를 이번 구현 범위로 확정했습니다. 기존 업무 Store·검색·전체 원장 조회를 얇은 HTTP 계층에서 재사용합니다. 공통 `json_operation`이 현재 권한·8MiB 실제 JSON 수신·중복 키/비정상 숫자/알 수 없는 필드 거부·owned thread·응답을 처리합니다. 저장 직전 권한을 재확인하며 OpenAPI의 수동 입력 모델은 업무 모듈 이름으로 구분합니다. 기존 MCP 인자와 그래프 의미·배포 검증 지문은 유지합니다.

- **편집/검토/대응:** 기존 전체 파일 이력·CAS·원문 근거 검토/업무 판단의 별도 권한·prepare 계약을 유지합니다. 일반 C/D 쓰기는 `mutation_receipt:null` 또는 기존 결과 계약을 사용하며 응답 유실 시 최신 본문/원장을 읽고 대조합니다. 임의 request_id를 기존 원장에 끼워 넣거나 같은 hash만으로 성공을 확정하지 않습니다. 본문 이력의 파일 식별자와 내용 revision은 구분하고 미기록 작성자/이유는 null로 둡니다.
- **검토함/통합 이력:** E01/E02는 명시 문서 최대8개·대응 최대8개·작업 최대8개의 선택 범위 집계입니다. 전체 원장을 먼저 검증한 뒤 출력만 페이지화하며 cursor는 주체·관점·선택·관측 판본에 묶입니다. tenant 전체를 읽었다고 표시하지 않습니다. F01은 명시 문서/필수 문서·주장·불변 원본을 읽어 전체 근거 snapshot을 준비합니다. 원본만 선택할 수도 있으며 준비 자체는 AI 실행/영속 저장이 아닙니다.
- **개인 대화/결과:** F02/F03을 사용자별 개인 보관으로 확정합니다. `conversation_write`, `result_write` 권한을 새로 정의하며 기존 write/source_write에서 자동 상속하지 않습니다. read와 해당 소유권이 모두 필요하고 tenant 공유·삭제·자동 만료는 제공하지 않습니다. `_personal/<user hash>/` 아래 자원별 최대200개, 기록당1MiB·추가 이벤트100개 한도를 적용하며 한도를 넘으면 이전 기록 전체를 보존하고 거부합니다. 같은 요청 ID/입력 지문은 재실행하지 않고 기록된 요청으로 확인하고, 변경은 현재 revision과 추가 이벤트로만 수행합니다. `GET /personal-requests/{kind}/{request_id}`에서 응답 유실을 확인합니다. 추가 요청은 record_id도 필요합니다.
- **질문/답변 근거:** 질문 추가 시 F01을 재사용해 서버가 확인한 원문·현재 유효 지식·정책·선택 주장/원본의 전체 snapshot을 보관합니다. 답변은 같은 사용자의 저장된 질문 `reply_to`를 요구하고 당시 근거를 유지합니다. 직접 저장 결과도 서버가 준비한 전체 근거를 포함합니다. 답변/비교는 `client_reported`이며 사람의 승인으로 승격하지 않습니다. 조회의 당시 snapshot은 최신값으로 바꾸지 않고 `snapshot_currentness=not_checked`로 현재성을 구분합니다.
- **비교 기록:** F04의 경로를 `GET/POST /comparisons`, `GET /comparisons/{id}`, `POST /comparisons/{id}/completions`로 확정합니다. `comparison_write`를 별도 부여해야 합니다. 이전 saved-result의 근거와 같은 문서 범위의 새 근거를 고정하고 명시한 old/new claim 대응과 이유를 보관합니다. 자동 동일성/모순 판단·추측 삭제·전체 재검토 완료를 만들지 않습니다. reviewed 완료에는 모든 명시된 새 claim의 실제 최신 원문 근거 검토와 source/graph/state 판본 대조가 필요합니다. 완료/보류도 추가 이벤트이며 다른 범위의 승인이나 현재 사실을 대신하지 않습니다.
- **추출물/파일:** 추출 GET은 `job_id`를 명시해 현재 read와 본인 작업을 먼저 확인합니다. 이미 공개된 추출물에 파일을 연결할 때 extraction ID/revision·현재 job/run/bundle/lease·request_id·실제 bytes/hash를 확인합니다. 개당20MiB·작업당32개/128MiB이며 조정 대기/미연결 보관도 예산에 포함합니다. 원래 추출 manifest는 유지하고 별도 불변 산출물/작업 이벤트로 연결합니다. 취소·만료 후에도 소유자의 저장 자료/요청 영수증은 read로 확인할 수 있습니다. 바이너리는 기존 불변 bundle 공개 모듈을 재사용하는 base64 구성 파일로 보관하며 전송 시 실제 bytes/hash를 재검사합니다.

새 API 구현은 Electron의 모든 화면 연결·운영 권한 부여·서버 배포·실제 AI 의미 정확도 완료를 뜻하지 않습니다. 기존 운영 정책과 사용자 자료를 변경하지 않습니다. 실제 구현·검증 결과와 제약은 [PLAN](PLAN.md)·HISTORY (정리로 삭제된 참고 자료)에 기록합니다.

### D-051 — 시안의 분석·비교·결과·질문·집계를 지원하는 API (2026-10-25)

사용자가 화면 연결 작업을 중단하고 시안에서 부족한 API를 모두 구현하도록 요청했습니다. 우선순위는 ① 분석 범위와 바이너리 자료의 문자 인계 ② 저장 전 추출안·미발견 관계 ③ 결과 초안·Wiki 반영 ④ 개인 질문 실행 ⑤ 공간 전체 검토함·이력입니다. 서버 API와 업무 모듈만 확장하고 이 작업에서는 Electron 화면을 편집하지 않습니다. 기존 공통 JSON/인가·불변 입력 공개·개인 기록·WikiStore/ReviewStore/OntologyStore의 보존/CAS를 재사용하며 운영 자료·권한·토큰은 바꾸지 않습니다.

- **원본과 변환 보고:** 원본 보관에 PDF/XLSX multipart를 추가합니다. 서버는 실제 바이트/hash와 파일 서명을 확인해 보존하고 PDF 파싱·OCR·Office 변환을 실행하지 않습니다. 개인 PC의 변환 보고는 원본 ID/판본/hash, 실제 문자와 페이지/셀 위치, 방법·미독 구간·경고를 묶어 불변 공개합니다. `origin=client_reported`, `coverage=reported_units_only`, `original_coverage=not_verified`로 둡니다. complete 보고가 실제 원본 전체의 포함이나 의미 정확성을 증명하지 않습니다. 명시 변환 참조는 질문 준비의 고정 근거에도 사용할 수 있으며 미완료/불일치 보고는 실행 가능한 근거로 승격하지 않습니다. 답변의 변환 문자 인용은 `reported_conversion`과 변환 판본/방법을 보존해 원시 파일의 직접 판독과 구분합니다.
- **분석 계획과 재분석:** 등록 원본 또는 현재 Wiki의 source/graph/state 판본 중 하나를 기준으로 위치·문서별 제목/목적/구간/출력·필수 맥락을 고정합니다. 실행 전 원본/맥락/관점을 재확인합니다. 다중 문서는 선택 문자를 별도 UTF-8 원본으로 보관한 뒤 문서별 기존 job으로 인계하고 계획·원래 원본/변환 계보를 실제 고정 입력에 포함합니다. 같은 Wiki는 전체 범위의 ontology-only 재분석으로 지원하며 일부 원문만으로 전체 그래프를 교체하지 않습니다. 인계는 AI를 실행하지 않고 개인 PC의 기존 실행/규약/저장 계약을 이어갑니다.
- **전체 추출안:** 별도 원본 등록 없이 현재 Wiki·전체 그래프·검토/정책·필수 맥락·규약을 고정해 새 전체 제출을 canonical 저장 전에 보관합니다. stale일 때는 실제 이전 그래프와 이전 원문을 함께 보존하며 복원할 수 없으면 그 한계를 공개합니다. 명시 apply에서 원문/그래프/검토 상태와 규약을 다시 확인하고 기존 생성 저장기를 사용합니다. 재분석은 같은 내용이어도 새 세대이며 옛 승인을 옮기지 않습니다. 기존 API의 기본 no-op 동작은 유지하고 명시 재분석 경로에만 `force_generation`을 적용합니다. 구조·인용 검증과 AI 의미 정확도 검증을 구분합니다.
- **미발견 관계와 실패 보존:** 제외·기존 유지·재추출은 해당 비교 판본의 명시 판단이며 삭제 사실이나 전문가 정책으로 승격하지 않습니다. 유지는 실제 최신 원문의 근거/전체 주장을 갖춘 복구 초안을 만들고 전체 제안으로 적용합니다. 재추출 후 ID가 달라지면 `decision_id → new_claim_id`를 명시하며 해당 새 세대의 실제 원문 근거 검토를 확인한 뒤 범위만 완료합니다. 후보 공개 후 상태 연결이 실패해도 파일을 보존하고 정확한 같은 요청으로만 연결합니다. 미연결 후보도 100개/32MiB 예산에 포함합니다. apply는 의도와 실제 저장 증거를 분리하며 `saved:null`의 미확인 상태를 자동 재저장하지 않습니다.
- **결과 초안과 반영:** 개인 saved-result에서 편집 초안을 만들고 원래 생성문·전체 frozen basis·답변 인용/실행 계보를 보존합니다. 편집은 CAS와 새 이벤트를 사용합니다. Wiki 반영에는 초안/대상 본문의 현재 판본, 최신 근거 관측값을 요구하며 변경 근거는 읽은 관측값에 명시 동의해야 합니다. 동의 뒤 다시 바뀌면 충돌합니다. WikiStore.save의 전체 이전 파일 이력과 1MiB 제한을 그대로 사용하며 전체 근거 부록을 임의 축약하지 않습니다. 반영 요청 영수증은 쓰기 권한 회수 뒤에도 read와 소유권으로 조회합니다.
- **질문 실행 계약:** 저장된 사용자 질문과 전체 근거에서 개인 실행 대기 자원을 만들고 생성 당시 지시문/출력 계약/버전을 불변 고정합니다. 활성 run·서버 시각 기준 300초 사용권·state/lease 별도 판본·명시 재접수·진행/취소를 제공합니다. 답변 저장 직전에도 사용권·원문/그래프/검토·대화 CAS·현재 권한을 확인합니다. 문서/원본 인용, 기계 주장 source/graph/state/claim/quote, 전문가 정책 state/event/실제 Action log를 구별하며 정책에 가짜 원문 인용을 붙이지 않습니다. 답변의 실행 지문은 client_reported이고 의미 검증·사람 승인은 미실행입니다. 서버는 모델/셸을 실행하지 않습니다. 질문 실행기와 화면 연결은 별도 후속입니다.
- **공간 전체 집계:** 기존 명시 범위를 기본값으로 유지하고 `coverage=tenant`를 추가합니다. 현재 허용 tenant의 문서/대응과 본인 job index만 발견하며 다른 사람의 개인 작업을 먼저 읽지 않습니다. 종류별1,000개·캡처8MiB·출력2,000항목 한도/읽기 실패는 skipped/truncated/complete에 표시합니다. 이력은 최신순이며 cursor는 주체·관점·조건·발견 자료·각 판본에 묶입니다. 자료마다 읽은 시점이 다를 수 있고 전역 단일 거래 시점이나 무제한 전체 조회를 뜻하지 않습니다.

새 권한을 자동 부여하지 않으며 개인 기록은 기존 별도 쓰기 권한과 소유권을 사용합니다. 서버 API의 구현 완료와 실제 변환기·개인 AI 클라이언트·화면·운영 배포·두 PC·실문서 의미 평가 완료를 구분합니다. 실행 순서는 README, 실제 검사/실패 수정과 미실행 범위는 HISTORY (정리로 삭제된 참고 자료)가 관리합니다.

[D-026]: ../access/DECISIONS.md#d-026--사용자-권한과-관점-프로필을-분리한-tenant-모드-2026-10-22-4-a
[D-028]: ../reviews/DECISIONS.md#d-028--원문추출과-분리한-검토-원장과-상태-충돌-검사-2026-10-22-4-c
[D-030]: ../reviews/DECISIONS.md#d-030--전문가의-업무-판단과-action-log계정연결-방향-2026-10-22
[D-031]: ../reviews/DECISIONS.md#d-031--전문가-정책을-기존-검토-원장에-보존하고-최신-판단으로-조회-2026-10-22-선행-1
[D-043]: ../sources/DECISIONS.md#d-043--원격-문서-등록과-개인-cli-분석mcp-저장ui-결과-연결-2026-10-24

### D-059 — 데스크톱 실행 브리지와 명시 서버 배포 준비 (2026-10-25)

Electron의 토큰 전달·새 실행 폴더·프로세스 수명은 `core.runtime.desktop_bridge`에서 기존 개인 ACL/파일/Job 코드를 재사용한다. 토큰은 제한된 stdin으로만 받고 새 private 경로를 검증한 뒤 반환한다. launch는 현재 Python의 허용 CLI만 실행하며 부모 종료/입력 종료/취소에 같은 실행 트리만 회수한다. Windows bootstrap은 Job 할당 후 gate를 열고 live stdin을 원시 읽기로 전달한다. 읽기 전용 capability 탐지·실제 runtime probe·Windows 앱 실기기 검증을 구분하며 미검증 환경에서 앱 운영 제한을 해제하지 않는다.

후속 D-064에서 앱 실행 조건을 현재 PC의 실제 보호 기능 probe로 구체화했습니다. 실기기 배포 검증 상태는 별도로 유지하며, 생성될 수 없는 고정 인증 문자열에 의존하던 실행 차단을 대체합니다.

WSL2/Linux 운영 준비는 `tools.server_deployment`의 명시 설정으로 새 bundle을 만드는 범위다. 기존 시스템 서비스·정책·자료를 추측 교체하지 않는다. backend는 단일 worker/loopback, HTTPS는 명시 IP·호스트·인증서·개인 키를 쓰는 별도 Caddy/systemd 서비스로 준비한다. ACME 발급/공개 터널/DNS/방화벽 변경은 하지 않는다. 전체 보존·hash 대조·새 서비스 적용·원래 enable/active 상태 되돌림을 생성 절차에 둔다. Linux 실제 mount 검사로 Windows/network/휘발성 저장소를 거부하고 정책·키는 tenant 자료 밖에 둔다.

이유: 실행 경계가 여러 앱 기능에서 달라지는 것을 막고, 운영 대상이 아직 알려지지 않은 상태에서도 검토 가능한 설치 결과를 준비하기 위함이다. WSL systemd enable과 Windows 부팅 시 배포판 시작은 별도 검증한다. 사용자가 대상 정보를 현재 알 수 없다고 답했으므로 실제 배포·재부팅·다른 PC·Windows 앱 완료로 표시하지 않는다. 실행법은 [README](../../../README.md#서버-배포-묶음과-사전-점검), 실제 검사와 한계는 HISTORY (정리로 삭제된 참고 자료)를 따른다.

### D-060 — 고정 근거에서 선택하는 질문 인용 계약 (2026-10-26)

새 질문 실행은 `personal-question-v2`로 실제 고정 문서·원본·기계 주장·활성 정책 Action log의 `output.citation_references`를 생성 시 보관한다. 문서는 출판물 원문이라도 `document`, 등록 원본/변환 문자는 `source`이며 ID·판본·hash는 같은 참조의 전체 조합을 복사한다. 기계 주장은 실제 evidence의 정확한 인용을 포함하고 정책은 실제 event/state만 참조한다. 개인 실행기의 동적 출력 스키마는 이 전체 조합마다 enum을 만들어 종류 혼동·식별자 발명·다른 참조 간 조합을 생성 계약에서 제한한다. 문서/원본의 인용문은 서버가 정확한 부분 문자열인지 계속 검사한다.

이유: 공개 RFC9111 개발 재현에서 인용문이 정확해도 존재하지 않는 등록 원본 식별자 때문에 답변 저장이 거부됐다. 서버의 엄격한 인용·현재 권한·근거/대화 CAS·사용권·부분 저장·미확인 영수증 검사는 바꾸지 않는다. 기존 v1 실행은 원래 고정 입력과 출력 스키마를 유지하며, 새로운 기본 계약으로 덮어쓰지 않는다. 잘못된 모델 결과는 로컬 원시 결과로 보존하고 식별자를 추측 교정하거나 모델 호출/저장 요청을 자동 반복하지 않는다. 변환의 실제 판본·방법·미검증 원본 범위도 기존 저장 계보에 남는다.

개발 검증과 실제 모델의 의미 정확도는 별도이며, 이번 개선으로 이전 고정 평가나 운영 허용 규약을 변경하지 않는다. 실제 결과는 HISTORY (정리로 삭제된 참고 자료)에 기록한다.

### D-064 — Windows 실행 전 실제 보호 기능 진단 (2026-10-26)

Windows 앱은 `desktop_bridge probe`가 현재 PC에서 비밀 없는 임시 파일의 보호 권한·새 파일 생성/기존 파일 보존·hardlink 거부와 Job에 속한 자식/손자 종료를 확인한 뒤 실행을 허용합니다. 성공 응답의 `runtime_ready=true`와 `private_file_and_process_tree` 결과를 검사하며 실패·시간 초과·정리 실패 시 실행을 거부합니다. 실제 실행의 prepare 단계에서도 기존 파일 보호·Job 할당 검사를 매번 유지합니다.

`native_validation=not_certified`와 `windows_app_verified=false`는 실제 Windows 앱 배포 검증이 완료되기 전까지 유지합니다. 현재 PC의 실행 준비와 전체 앱 실기기 검증은 별개이며, probe 통과를 설치·사용·취소 전체 동선의 인증으로 표시하지 않습니다. 도우미가 이전 버전이라 probe를 제공하지 않아도 검사를 우회하지 않습니다.

이유: 기존 Python 브리지는 인증 결과를 항상 미검증으로 반환하는데 앱은 생성할 수 없는 `certified` 문자열을 요구하여, 준비된 Windows에서도 개인 실행이 영구 차단됐습니다. 사용자가 서버 설치 동안 나머지 출시 문제 해결을 요청함에 따라 고정 차단을 실제 보호 기능 진단으로 대체했습니다. macOS 시험·모의 Windows 시험은 실제 Windows에서의 배포 검증을 대신하지 않습니다.

### D-069 — Windows 설치 파일에 개인 실행기와 OCR 포함 (2026-10-27)

사용자가 Windows에 설치 EXE 하나만 옮기도록 요청했고, AI CLI는 직접 설치하며 OCR까지 포함하기로 선택했습니다. Windows x64 NSIS에 개인 실행기 소스·공식 CPython embeddable·고정 Windows wheel·Tesseract·한국어/영어 데이터를 포함합니다. `resources/personal-runtime`의 앱 전용 환경이며 대상 PC의 Python·PATH를 변경하거나 pip/다른 설치 프로그램을 실행하지 않습니다. 서버·사용자 자료·토큰·계정 설정은 포함하지 않습니다. Codex/Claude Code 설치·개인 로그인과 서버 연결 정보 입력은 사용자가 수행합니다.

새 앱은 저장된 실행 설정, 명시 환경변수, 포함된 기본 환경 순서로 선택합니다. 기존 외부 경로·손상 설정 보존·다음 시작 적용·설정 CAS와 Windows 실제 보호 진단을 유지합니다. 앱 업데이트로 포함된 실행기를 함께 갱신하며 외부 환경의 자동 교체는 하지 않습니다. macOS/Linux의 기존 외부 환경 배포는 유지합니다.

빌드 입력은 `app/config/windows-runtime.lock.json`의 URL·SHA256으로 고정하고 현재 requirements와 소스 허용 목록을 검사합니다. 라이선스와 전체 파일 hash manifest를 포함하며 빌드 임시 폴더만 정리합니다. 패키지 생성·무결성 검증을 실제 Windows 설치·OCR 인식·DACL/Job 검증 완료로 표시하지 않습니다. 실행 방법은 앱 README, 실제 결과와 한계는 이 도메인 HISTORY가 관리합니다.

이유: 소스 ZIP만 설치 파일에 넣으면 별도 Python/패키지/OCR 설치가 남으므로, 앱에 종속된 실행 환경을 함께 배포해 처음 설정할 경로와 PC별 의존성 차이를 줄입니다.

## D-095 — Pandoc 사용 중단과 문서 변환의 대체 (2026-11-03)

- 사용자 결정: 라이선스 부담(GPL 계열 실행 파일을 설치 파일에 동봉할 때의 의무) 때문에 Pandoc을 쓰지 않습니다. 기존 Pandoc 기능(Markdown→Word/PDF 내보내기, DOCX·XLSX 가져오기)은 모두 다른 방식으로 교체합니다. 새 산출물 형식은 Word·PDF·Markdown·Excel·PowerPoint입니다.
- 내보내기(적용됨): `markdown-it`(MIT)로 Markdown을 해석해 `docx`(MIT)로 Word를 만들고, PDF는 같은 해석으로 만든 HTML을 기존 Electron 숨은 창 인쇄로 만듭니다. 원본 HTML 조각은 해석하지 않고 글자로 두며, 그림은 대체 글자만 남기고, 연결은 http(s)·mailto만 허용합니다. 하위 의존성 라이선스는 MIT·BSD-2·Python-2.0(`argparse`)이며 `package-lock.json`에 고정했습니다.
- 가져오기·패키징(적용됨): DOCX는 이미 있던 대체 경로 `python-docx`(문단·표 셀 좌표)를, XLSX는 원본 구조 기록과 `openpyxl` 셀 기록을 기본으로 삼았습니다. 기존 등록 보고의 `converter=pandoc` 기록은 바꾸지 않고 보존하며 새 보고만 `python-docx`/`openpyxl`을 기록합니다. Pandoc 어댑터(`source_conversion_pandoc.py`)·XLSX 입력 사본 생성·패키징 동봉 스크립트를 제거했습니다.
- 감수한 손실: DOCX의 단일 Markdown(제목·목록·표 구조, 각주·주석·변경 추적 본문)과 XLSX의 읽기용 표 보기(병합 참조 표시)를 더는 만들지 않습니다. DOCX의 각주·주석·머리말·변경 추적·표 안의 표는 미독으로 표시합니다. 표 모양 보기는 필요하면 셀 기록에서 직접 생성하는 후속으로 둡니다.
- Excel·PowerPoint(적용됨): Excel은 `write-excel-file`(MIT, 하위 의존성 `fflate` 하나), PowerPoint는 `pptxgenjs`(MIT)로 Markdown에서 만듭니다. `exceljs`는 하위 패키지가 199개이고 오래된 것·라이선스 필드가 빈 것이 섞여 제외했습니다. `pptxgenjs`의 `jszip`은 "MIT 또는 GPL-3.0" 이중 라이선스로 MIT를 선택하는 형태이며, 배포 전 확인 항목입니다. 표는 시트로(앞 제목이 시트 이름), 표가 아닌 내용은 "본문" 시트로, H1은 표지·H2는 슬라이드로 옮깁니다. 앞자리 0이 없는 숫자만 숫자 셀로 두고 글자 셀은 수식으로 해석하지 않습니다.
- 산출물 템플릿(적용됨): 별도 파일 형식이 아니라 **질문에 붙는 출력 양식 지시**입니다. 채팅 입력창의 "답변 양식"에서 고르면 질문 뒤에 `[출력 양식 #번호]` 표지와 구조 지시가 붙고(번호만 저장해 화면에서 이름을 찾음), AI가 그 구조의 Markdown으로 쓰면 위 변환기가 Word·PDF·Excel·PowerPoint로 옮깁니다. 서버 계약은 바꾸지 않았습니다. 내장 4종은 비교 분석 보고서(Word), 항목 매핑표(Excel), 타임라인·프로세스(Word), 요약 브리핑(PowerPoint)이며 양식을 고르면 어울리는 내려받기 형식이 미리 선택됩니다. 양식은 다음 질문 한 번에만 적용됩니다. 사용자 정의 양식은 아직 없습니다.
- 이 저장소에서 라이선스는 법률 판단이 아니라 패키지 메타데이터 확인입니다. 배포 전 사용자가 최종 확인합니다.

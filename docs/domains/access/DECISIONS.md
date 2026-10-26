# 인증·워크스페이스 결정

현재 구현 상태는 [PLAN](PLAN.md), 작업 시 지킬 상세 규칙은 도메인에 연결된 RULES를 따릅니다. 결정 번호·이유와 상세 계약을 보존합니다. 아래 결정 안의 날짜·시험 수·운영 상태는 기록 당시 값이며, 최신 구현 상태는 PLAN을 우선합니다. 필요한 D 번호·하위 절만 읽습니다.

### D-026 — 사용자 권한과 관점 프로필을 분리한 tenant 모드 (2026-10-22, 4-A)

상태: 현재 개인 인증·워크스페이스 격리·행동 권한·조회 프로필의 계약입니다.

- 용어와 범위: 독립 프로젝트 자료 공간을 **워크스페이스**라고 부르고 기존 API의 `tenant`에 대응시킵니다. 한 사용자는 여러 워크스페이스에 소속될 수 있습니다. 행동 권한은 무엇을 읽고 변경·검토할 수 있는지 결정하고, 현업·개발자·아키텍처 등의 관점은 허용 자료를 어떤 질문 중심으로 조회하는지 나타냅니다. 관점 때문에 같은 tenant의 문서 내 접근을 제한하지 않습니다. 추출의 보조 자료도 선택한 허용 tenant 안에서 찾으며, 사용자 관점으로 원문 추출을 축소하지 않는 기준은 [D-036]을 따릅니다. 서비스/Bounded Context 힌트의 설계 후보는 [D-035]입니다.
- 격리 단위: 관리자 지정 `tenant_root/<tenant-id>`마다 기존 `WikiStore`를 사용합니다. `wiki/`, `_history/`, `_ontology/`, 저장 잠금이 각각 분리되며 검색·연결 탐색도 승인된 저장소 안에서만 실행합니다. tenant ID는 엄격한 식별자이고 임의 경로 매핑은 받지 않습니다. 기존 단일 저장소는 자동 이동하지 않으며 CLI에서 `--data-dir`과 `--access-config`는 배타적입니다. 관리자가 같은 저장소를 별도의 legacy 서버로 노출하지 않아야 합니다.
- 인증: PoC에서는 개인별 32~256자 URL-safe 고엔트로피 토큰과 정책에 저장한 SHA-256을 비교합니다. HTTP는 요청별 단일 Bearer 헤더, stdio는 서버 프로세스의 지정 환경변수를 사용합니다. 기존 공유 토큰 모드는 그대로 유지하지만 다중 모드에서 공유 토큰·무인증 경로로 되돌아가지 않습니다. 사용자·소속·권한·프로필 정책은 tenant 저장 루트 밖의 관리자 파일입니다. 사용자 토큰 원문은 정책/위키/문서에 저장하지 않습니다.
- 표준과 범위: [MCP HTTP 권한 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)는 OAuth 기반 방식을 정의하고 stdio는 환경에서 자격 증명을 받도록 구분합니다. 이번 전용 정적 Bearer 게이트는 완전한 MCP OAuth 구현이 아닙니다. IdP·OAuth·토큰 만료/발급 서비스·조직 디렉터리는 구현하지 않습니다. 설치된 SDK 2.3.0의 실제 요청 context와 스레드 전달 경로를 확인해 연결했습니다.
- 소속과 행동: 기본 행동 권한은 `read`, `write`, `ontology_write`이며 이후 [D-028]의 `ontology_review`, [D-031]의 `ontology_policy`를 별도로 추가했습니다. 쓰기·생성에는 읽기 권한도 있어야 합니다. 서버는 요청의 tenant 선택을 인증된 사용자의 소속과 대조하고 요청마다 권한을 검사합니다. 클라이언트가 `user_id`, `permissions`, 직접 필터 등 추가 인자로 권한을 바꾸지 못하게 거부합니다. 문서별 ACL·그룹 상속은 현재 범위 밖이며 같은 tenant 안의 읽기 범위는 전체입니다.
- 관점: tenant별 프로필에 `domain`과 `viewpoint`를 정의하고 사용자 소속별 허용 프로필·기본값을 지정합니다. 현업/개발팀의 다른 기본 관점은 같은 tenant 안에서 구성합니다. `ontology_query.profile`은 그 요청에만 적용하며 전역/세션의 현재 관점을 변경하지 않습니다. 프로필은 데이터 접근 권한이 아니며 원문·검색·연결 및 참조 개체는 같은 tenant의 읽기 범위를 유지합니다. 직접 `domain`/`viewpoint` 대신 관리자가 정의한 프로필을 사용합니다.
- 기존 의미 보존: 프로필 조회는 v3의 정확한 context 필터를 재사용하며 그래프를 쓰지 않습니다. 태그 없는 주장도 임의로 공통 사실로 승격하지 않습니다. 전체 그래프 생성은 현재 관점으로 축소하지 않고 기존 계약을 유지합니다. 공통 전제·다른 관점 제약·미분류 항목을 보존하는 조회는 [D-027]에서 구현했습니다. 현재 exact 필터·focus 구분은 검색 순위 가중치가 아니며, 사용자 관점별 부분 추출/자동 병합 계약은 제공하지 않습니다.
- 요청과 회수: 한 도구 dispatch는 정책 스냅샷 하나로 사용자·소속·권한·프로필·저장소를 고정합니다. 권한/응답 캐시는 두지 않고 매번 정책을 다시 읽습니다. HTTP 입구에서도 인증하되 실제 도구 dispatch에서 다시 검사합니다. 열린 클라이언트에서도 다음 호출은 변경된 권한을 적용하며 이미 승인되어 실행 중인 저장을 취소하지 않습니다. 원자적 정책 교체를 권장하고 손상·삭제·잘못된 참조·크기 초과 정책은 실패 차단합니다. 관리자에 의한 실행 중 파일시스템 변조까지 OS 격리로 막는 구조는 아닙니다.
- 응답: `access_context`는 자기 소속·허용 프로필만 반환합니다. 승인된 도구 응답은 `access`에 실제 사용자·tenant·프로필과 정책 SHA-256을 포함합니다. 비허용/없는 tenant는 동일 `access_denied`로 처리하고 다른 tenant의 존재·내용·revision·검색 수·연결 상태·저장 경로를 읽어 오류에 담지 않습니다. 정책 문제는 `access_unavailable`이며 HTTP 게이트에서는 503입니다. 이 식별정보는 향후 검토 주체의 기반이고, 기존 파일 히스토리에 사용자 감사 기록을 이미 추가했다는 뜻은 아닙니다.

실행 방법은 [README](../../../README.md#사용자테넌트관점-프로필-모드-4-a), 실제 테스트 결과와 미실행 범위는 [PLAN](../../PLAN.md)에 기록합니다. 이후 맥락 구성·검토/정책 API는 [D-027]·[D-028]·[D-031]로 보완했으며 제품 UI는 미구현입니다.

### D-041 — 개인 인증 tenant 연결 전환과 보존·복구 절차 (2026-10-23)

상태: **개인 인증 read 연결의 운영 계약·최초 전환 기록**입니다. 현재 자료 위치는 아래 [data 경로 전환](#워크스페이스-자료-경로를-data로-전환-2026-10-25)을 따르며 새 인증 SDK와 사용자 앱 재시작 후 현재 채팅의 조회 검증을 각각 완료했습니다. D-038의 대응 8도구와 D-040의 개념 발견/통합 조회를 개인 인증 연결에서 쓰기 위한 계약이며 현재는 조회 13개만 허용합니다. 원문·원장·원격 검증 자료와 제품 UI는 보존합니다. 설계·구현·실제 적용의 각 검증 결과는 [PLAN](../../PLAN.md), 실행 방법은 [README](../../../README.md#개인-인증-런처와-전환-점검-d-041)를 따릅니다.

#### 실제 로컬 적용 결정 (2026-10-24)

아래는 D-041 전환 당시의 빈 운영 자료·read13 적용 기록입니다. 이후 실제 첫 자료 등록과 임시 P1/P2 쓰기·회수는 [D-042](../../history/2026-10-25-before-domain-split/DECISIONS.md#d-042--첫-업무-자료의-선정등록-범위와-최소-쓰기-권한-2026-10-24)를 따릅니다. 현재도 상시 권한/앱 도구는 read13이며 전환 당시 빈 자료 결과를 현재 자료0으로 해석하지 않습니다.

- 사용자 확인에 따라 S는 프로젝트 `data/`, U는 `jong-yu`, T는 `personal`, profile은 `all`(domain=null, viewpoint=null), 행동 권한은 read만으로 확정했습니다. 빈 원본이므로 예제 Alice/acme나 원격 시험 자료를 운영 지식으로 채택하지 않았습니다. 향후 권한·관점은 정책을 검토해 바꿀 수 있지만, ID 변경을 이유로 과거 actor·tenant·hash를 재작성하지 않습니다.
- 전용 `.local/tenancy/tenants/personal/`을 유일한 운영 자료 경로로 삼고 원래 `data/`는 오프라인 보존합니다. 부모·credentials·backups·records는 0700, 개인 파일·정책·기록은 0600입니다. 보존 사본과 비공개 전환 기록의 ID는 `20261023T153700Z`(UTC)이며 백업은 tenant로 등록하지 않습니다. 토큰 원문은 credential 파일에만 있고 설정·보고서에는 넣지 않습니다.
- 동일한 `llm_wiki` 등록을 먼저 비활성화하고, 정확한 실행 명령과 원본 파일의 열린 작업이 없음을 확인한 legacy stdio 프로세스 5개를 종료했습니다. 원본·백업·staging·최종 사본 대조 후 해당 항목만 개인 런처/read13으로 원자 교체했습니다. 다른 MCP·역할·전역 설정을 보존했습니다. 조사한 로컬 등록·프로세스·자동 시작 경로와 전환 후 재실행 여부는 비공개 기록에 남깁니다. 다른 기기의 모든 등록까지 조사했다고 확대하지 않습니다.
- 서버는 Codex가 세션별로 자동 실행하는 stdio입니다. 사용자가 별도 상주 서버를 시작할 필요가 없습니다. 저장된 설정을 사용하는 새 CLI와 SDK의 실제 인증·빈 조회·다른 tenant/profile 거부를 확인했습니다. 실제 문서·원장이 없어 대응 상세/prepare·대상 중심 통합 조회의 실자료 재사용은 `not_applicable_empty`입니다. 실자료를 발명하여 검증하지 않습니다.
- `connection_ready.cli/sdk/app=true`, `write_ready=false`, `remote_verified=false`로 구분합니다. 앱 자동 조작의 접근 거부 이후 사용자가 앱을 다시 열었고, 현재 대화에서 read13 노출과 `access_context`·문서 검색·개념 발견의 실제 3호출을 확인했습니다. 소속은 `jong-yu`/`personal`/`all`·read이며 빈 조회의 누락/잘림은 없었습니다. 보존 대조와 로컬 legacy 재실행 없음도 확인하여 **G6의 로컬 읽기 연결을 완료**합니다. 13개 전체 실행이나 실자료 판단 재사용으로 확대하지 않으며 G5·제품 UI·업무 쓰기는 미실행입니다. 이전 재연결 실패 기록은 PLAN에 보존합니다.
- 복귀 자료에는 비활성 유지보수 구성과 검증된 개인 인증 구성을 분리 보관했습니다. 오류 시 새 연결을 닫고 최신 tenant·원본·백업을 유지하며 legacy 구성의 재활성화나 옛 자료 덮어쓰기를 하지 않습니다. 실제 복구 실행과 쓰기 권한 추가는 이번 범위에 포함하지 않습니다.

#### 현재 확인 범위와 전환 단위

설계 시점 프로젝트 `.codex/config.toml`의 `llm_wiki`는 절대 Python 경로·`-B -m core.mcp_server --data-dir <project>/data --lock-timeout 5`의 legacy stdio였습니다. enabled_tools는 wiki_read/write/search·ontology_generate/query/connections 6개이고 개인 토큰 주입은 없었습니다. required=true, startup20초/tool30초, default_tools_approval_mode=writes는 실제 전환에서도 유지했습니다. 당시 CLI는 0.163.0-alpha.11.1, 실제 전환 검증은 0.163.0-alpha.11.2입니다. 파일 관찰만으로 모든 대화의 메모리 내 도구/원격 프로세스가 같다고 확정하지 않습니다.

설계 당시 메타데이터 조사에서 `data/`는 원문/히스토리 0개, graph/review 부재였습니다. `.local/remote-check/`에는 원문 2개·히스토리 4개와 잠금 파일만 있고 graph/review가 없습니다. 후자는 기존 원격 검증 자료로 보존하며 실사용 지식으로 자동 편입하지 않습니다. 당시 없던 `.local/tenancy`는 위 적용 단계에서 새로 만들었습니다. 다른 저장소의 부재나 존재하지 않는 운영 원장의 재사용까지 검증한 것은 아닙니다.

결정: **첫 전환은 현재 맥북의 로컬 개인 인증 stdio, 전용 tenant 루트, 한 개의 실사용 자료 공간**으로 한정합니다. 원격 HTTPS/Windows·OAuth/SSO·계정 UI는 별도 단계입니다. 같은 `llm_wiki` 연결 항목을 교체하며 두 번째 이름으로 기존 legacy와 함께 활성화하지 않습니다. 다른 MCP 연결·역할 설정을 포함한 config 전체를 템플릿으로 덮지 않습니다.

| 후속 적용 입력 | 확정할 내용과 중단 조건 |
| --- | --- |
| 자료 공간 S | 현재 `data/`를 기본 후보로 명시하되 실제 채택할 원본 절대 경로·소유자·보존 대상 범위를 운영자가 확정. 검증 자료/다른 저장소를 임의 합치지 않음 |
| tenant T·사용자 U | 사람이 실제 사용할 안정된 ID와 자료 귀속을 기록. 원장 tenant가 있으면 그 ID를 유지하며, 여러 tenant가 섞이거나 불명확하면 전환 중단 |
| 관점·권한 | 허용 profile ID·정확한 domain/viewpoint·기본값과 U의 행동 권한을 확정. 예제 Alice/acme를 실사용자/조직으로 채택하지 않음 |
| 경로·시작 방식 | 실제 대상·정책·자격 증명·백업 위치와 Codex 실행 표면(CLI/앱)을 확정. 쓰기 후 복귀 가능한 개인 인증 구성과 비밀 없는 점검 기록 위치도 함께 확정 |

자료/ID가 확정되지 않아도 이 설계는 검토할 수 있지만 실제 복사·토큰 발급·연결 교체는 수행하지 않습니다. 설계 요청 자체를 실행 허가나 업무 판단 승인으로 해석하지 않습니다.

#### 워크스페이스 자료 경로를 data로 전환 (2026-10-25)

사용자가 본문 폴더 이름은 `wiki/`로 유지하고 업무 자료를 `data/<workspaceId>/`에 모으는 방향을 확정했습니다. 현재 workspace ID `personal`을 그대로 사용해 `.local/tenancy/tenants/personal/`의 문서·온톨로지·전체 이력·검토 원장을 `data/personal/`로 이관했습니다. 중간 `tenants/` 폴더는 두지 않으며 인증/권한 정책과 개인 토큰·비서비스 보존/작업 기록은 `.local/tenancy/`에 둡니다. 상태는 **자료/설정 이관·새 인증 SDK 및 현재 앱 조회 검증 완료**이며 실제 결과는 PLAN에 기록합니다.

- 같은 ID·원문 바이트/revision·graph generation/hash·전체 history·검토/정책/대응 원장 체인과 권한을 보존합니다. 기존 자료를 재등록·재추출·재직렬화하지 않습니다. `wiki/`를 `documents/`로 바꾸거나 FastAPI/새 업로드 기능을 구현하지 않습니다.
- 이전 D-041의 최초 복사 절차는 원본 S를 기존 위치에 보존하는 방식이었습니다. 이번에는 사용자의 실제 저장 경로 변경 요청과 기존 warm 서버의 옛 경로 재노출 방지를 위해 **현재 원본의 전체 바이트·디렉터리를 비서비스 백업 위치로 보존 이동**하는 것으로 개정합니다. 자료 자체는 삭제하지 않습니다. 기존 `data/`의 빈 보존 구조도 별도 백업으로 유지하고 합치거나 덮어쓰지 않습니다.
- 정확히 확인한 기존 MCP 세션과 진행 중 자료 접근을 동결하고, 동일 기준의 사본·독립 inode·원문/graph/state 조회 결과를 대조한 뒤 새 경로를 공개합니다. 현재 등록의 `--tenant-root`만 프로젝트 `data/`로 변경하며 다른 설정·현재 읽기 권한·정책·토큰은 유지합니다. 정책/설정 기준이 바뀌면 최신 내용을 다시 검토하고 덮어쓰지 않습니다.
- `data/`를 코드 추적에서 제외하고 새 루트/워크스페이스700·자료600과 소유자를 유지합니다. 서명/전체 byte 대조와 mode/owner/link 검사를 함께 수행합니다. 기존 경로를 symlink로 남기거나 같은 자료를 legacy 서버에 중복 노출하지 않습니다.
- 새 설정의 인증 SDK와 현재 앱의 실제 문서/판단 조회를 구분해 검증합니다. `access_context` 성공만으로 새 자료 경로 연결을 완료했다고 표시하지 않습니다. warm 세션에 재연결이 필요하면 실제 완료 범위를 명시하며 앱 전체 재시작이나 권한 확대를 임의로 수행하지 않습니다.
- 실제 이관은 `workspace-data-20261025T062306Z`의 비공개 기록에 보존했습니다. 현재 원본7파일·639,380바이트·ready3/422주장과 모든 source/graph/history/state revision·graph generation·빈 디렉터리·mode/소유자를 보존했습니다. 기존 원본은 `.local/tenancy/backups/<전환ID>/source-tenants/personal/`, 빈 기존data 구조는 같은 백업의 `preexisting-data/`에 있습니다. 새 자료 사본은 보존본과 독립 inode이고 옛 서비스 경로는 남기지 않았습니다.
- 저장된 `llm_wiki`의 `--tenant-root` 한 값만 프로젝트 `data`로 바꾸고 13개 읽기 도구·정책·토큰·사용자/프로필은 유지했습니다. 새 설정의 실제 개인 런처로 문서3·온톨로지/현재 판단422·맥락·연결·개념 발견/선택 조회와 비허용 tenant/profile 거부를 전후 대조해 동일했습니다. 현재 앱 조회는 처음에 연결 오류와 사용자 작업 때문에 보류했으나, 이후 사용자 앱 재시작 후 이 채팅에서 인증·검색·문서3의 본문/기계 그래프/현재 검토를 실제 조회해 이관 당시 결과와 같음을 확인했습니다. **현재 앱 재연결 대기는 완료**했으며 추가 운영 설정이나 권한은 변경하지 않았습니다. 상세 검증 범위는 PLAN에 기록합니다.

#### 저장 배치와 기존 원장 재사용

아래 배치는 최초 개인 인증 전환 당시의 기록입니다. 현재 업무 자료 위치는 위 data 경로 전환을 따르며, 정책·토큰·비서비스 백업은 계속 자료 루트 밖에 둡니다.

배치는 프로젝트의 비공개 `.local/tenancy/` 아래 `tenants/<T>/`(실사용 데이터), `access.json`(정책), `credentials/<U>.token`(개인 비밀), `backups/<전환ID>/`와 `staging/<전환ID>/`(비서비스 보존/준비 자료)입니다. 정책·토큰·백업은 `tenant_root=.../tenants` 밖에 둡니다. 부모/비밀 디렉터리는 0700, 토큰/정책/비공개 점검 기록은 0600을 적용합니다. 이번 적용에서는 staging을 검증 후 최종 경로로 공개했으며 중복 staging 자료를 남기지 않았습니다. 기존 경로가 있으면 새 작업 소유 여부·용도부터 확인하고 덮어쓰지 않습니다.

현재 [접근 정책](../../../core/modules/access/policy.py)은 기존 실제 디렉터리 `tenant_root/<T>`만 허용하고 tenant 루트/대상 symlink와 alias를 거부합니다. `data/`를 새 ID에 연결하는 symlink/임의 경로 매핑은 사용하지 않습니다. 대안으로 `tenant_root=<project>, T=data`인 제자리 사용은 가능하지만 정책이 프로젝트 밖이어야 하고 자료 공간 ID도 data에 고정됩니다. 기본안은 이를 선택하지 않으며 제자리 사용을 요청받으면 별도로 경로·정책 경계를 확정합니다.

복사는 모든 writer가 멈춘 한 시점의 **데이터셋 전체 보존 복사**입니다. 원본 S를 삭제/이동하거나 기존 파일을 최신 본문만 재등록하지 않습니다. staging에서 검증 후 비어 있는 최종 T 경로로 공개하고 기존 T와 병합하지 않습니다. 기존 T가 있으면 같은 데이터라는 추정으로 덮지 않고 경로 선택부터 다시 확인합니다.

| 자료 | 복사·백업 불변식 |
| --- | --- |
| `wiki/` | 문서 상대 경로·전체 파일 바이트 유지. 줄바꿈/Unicode/인용 위치를 변환하지 않음 |
| `_history/` | 모든 문서의 전체 이전 버전·디렉터리·파일명을 보존. 최신 파일만 복사하거나 이력을 재명명/정리하지 않음 |
| `_ontology/` | 기존 raw JSON·generation_id·source revision을 그대로 복사. 재생성/스키마 숫자 변경/JSON 재직렬화로 이관하지 않음 |
| `_reviews/` | 문서별 v1/v2 검토/정책과 `correspondences/` 하위 전체, ID·이벤트 순서·before/after·hash chain·tenant·actor·시각·원래 판단 출처 보존 |
| 잠금·기타 파일 | 원본 `.storage.lock`을 삭제/교체하지 않음. 대상 잠금은 writer 종료 후 독립 inode로 생성하며 lock bytes를 지식 revision으로 취급하지 않음. 알 수 없는 파일/임시 파일은 자동 삭제하지 않고 별도 목록과 보존 사유를 기록 |

파일 집합·유형·상대 경로·크기·SHA-256과 필요한 빈 디렉터리를 보존 manifest로 비교합니다. 원본/백업/대상은 독립 regular 파일이며 symlink·source와 같은 inode의 hardlink 복사는 금지합니다. OS의 독립 쓰기를 보장하는 복사만 사용합니다. 백업은 tenant로 등록/서비스하지 않습니다. 실제 민감 경로/파일명·내용을 포함한 manifest는 소유자 전용 점검 자료에 두고 공개 보고에는 개수/일치 여부만 적습니다. 정책/설정 사본은 데이터 manifest와 분리하고 토큰 원문·실제 운영 URL을 문서·명령 인수·보고서에 넣지 않습니다.

특히 `_history/` 누락은 ABA 뒤 옛 승인을 현재로 되살릴 수 있으므로 복사 실패와 동일하게 차단합니다. 한 파일이라도 누락/손상/변경/한도 초과이면 원본·기존 이력을 유지한 채 중단하고 자동 초기화·자르기·재추출로 통과시키지 않습니다. 복사 manifest만 맞아도 reader의 전체 원장 검증·현재성/범위 판정은 별도로 필요합니다.

대응 reader는 ledger.tenant=현재 T 및 모든 event.actor.tenant=ledger.tenant를 검사합니다. 문서 reader가 옛 actor.tenant와 현재 T를 대조하지 않는 점을 이용해 혼합 원장을 허용하지 않습니다. 이관 전 문서/대응 이력의 tenant 분포·원래 귀속을 함께 대조하고 다르면 원장 필드나 hash를 다시 써서 맞추지 않습니다. 같은 T를 유지할 수 없으면 별도 이관 계약이 필요합니다. 과거 사용자 ID를 새 토큰 소유자로 바꾸거나 옛 판단을 새 사람의 승인으로 재표시하지 않습니다.

완전한 바이트 복사와 같은 상대 경로/히스토리 이름은 source/graph/review/history 구성요소 revision을 유지합니다. D-038 prepare/state는 접근정책·선택 관점·변경안·실제 의존 기준을 포함하고 D-040 snapshot은 tenant/정책·실제 선택/캡처 기준을 포함하므로 전환 전과 같다고 가정하지 않습니다. 평가 시각 자체는 이 두 기준에 직접 넣지 않고 D-040 view에 포함합니다. direct_confirmed의 시각/범위 평가가 실제 선택 자료를 바꾸면 snapshot도 간접적으로 달라질 수 있습니다. 기존 정책의 domain/viewpoint·기간·한정어를 문자 그대로 유지해 상태를 다시 조회하며, 연결 전환만으로 pending/stale를 해소하거나 옛 판단을 다시 수용하지 않습니다. 새 세션은 최신 read/query/find/prepare부터 시작합니다.

#### 자격 증명과 Codex 설정 계약

개인 토큰은 서버용 고엔트로피 URL-safe 32–256자이며 사용자별로 분리합니다. 정책에는 hash만 기록하고 ChatGPT 로그인이나 legacy 공유 토큰을 대신 사용하지 않습니다. 사용자·소속·권한·프로필은 서버 정책이 정하며 client allowlist와 쓰기 확인은 별도입니다.

Codex의 stdio `env_vars`는 상위 환경의 허용 변수를 전달하며, HTTP의 `bearer_token_env_var`와 용도가 다릅니다. 프로젝트 설정의 `enabled_tools/disabled_tools`, `required`와 `writes` 확인 정책을 사용할 수 있습니다. 설정 문법은 [공식 MCP 안내](https://learn.chatgpt.com/docs/extend/mcp)와 [공식 설정 참조](https://learn.chatgpt.com/docs/config-file/config-reference)를 실제 열람하고 현재 CLI/기존 검증 코드와 대조했습니다. GUI 앱이 터미널의 환경을 자동 상속한다고 가정하지 않습니다.

기본 실행안은 **보호된 토큰 파일을 읽어 exec하는 전용 stdio 런처**입니다. 서버 자체의 인자는 유지하고 [개인 런처](../../../core/personal_launcher.py)에 `--token-file`을 구현했습니다. 위 실제 적용 단계에서 새 CLI와 재시작한 앱 대화의 읽기 연결을 검증했습니다. 런처는 고정된 개인 파일의 regular/non-symlink·소유/권한·형식/크기를 확인하고 토큰을 `LLM_WIKI_PERSONAL_TOKEN` 환경에만 넣은 뒤, 프로젝트 절대 `.venv/bin/python`으로 `-B -m core.mcp_server --access-config <정책> --tenant-root <루트> --token-env LLM_WIKI_PERSONAL_TOKEN --lock-timeout 5`를 exec합니다. 원문 토큰을 argv·TOML env 값·stdout·shell trace·에러에 출력하지 않습니다. 실패하면 시작을 거부하며 legacy 변수/모드로 fallback하지 않습니다. 로컬 관리자/같은 계정 프로세스까지 비밀을 격리한다고 과장하지 않습니다.

CLI의 격리 검증에는 상위 프로세스가 같은 변수에 토큰을 주입하고 `env_vars=["LLM_WIKI_PERSONAL_TOKEN"]`로 직접 Python을 실행하는 경로도 사용할 수 있습니다. 이 대안과 파일 런처를 동시에 불명확하게 설정하지 않습니다. 환경 이름은 `--token-env`와 같아야 하며 TOML 문자열에서 `$(cat ...)`가 실행된다고 기대하지 않습니다. 비밀 전달이 확인되지 않으면 앱/CLI 연결은 미검증으로 남깁니다.

| `llm_wiki` 항목의 후속 변경 | 적용 계약 |
| --- | --- |
| command/args/cwd | 검증된 런처 또는 검증된 환경 주입 Python, 프로젝트 절대 cwd. `--access-config/--tenant-root`를 함께 사용하고 `--data-dir` 제거 |
| 인증 | 개인 토큰만 지정 변수에 전달. HTTP bearer/OAuth 설정을 stdio 토큰 주입으로 오해하지 않음 |
| 노출 도구 | 첫 실제 연결은 아래 조회 13개 allowlist. 변경 권한/도구는 별도 단계에서 필요한 것만 추가하며 wildcard/전체 자동 허용하지 않음 |
| 확인·시간 | required=true·startup20초/tool30초·writes를 시작 기준으로 유지. 짧은 응답 시간 때문에 성공 저장을 재시도하지 않고 필요하면 격리 실측 근거로 tool timeout만 조정 |
| 기존 항목 | 전역/관리 설정·다른 project 항목·disabled_tools·per-tool override까지 효과를 점검. 다른 MCP/역할/권한 정책을 통째 덮지 않음 |

stdio 토큰은 시작 시 프로세스에 고정되므로 교체에는 새 MCP 프로세스와 세션이 필요합니다. 소속·권한·profile·토큰 hash 회수는 정책의 원자적 교체 후 다음 dispatch에 반영되지만 이미 승인된 실행 중 저장을 취소하지 않습니다. 회전 시 구 토큰을 다시 살리는 정책 롤백을 하지 않으며 현재 회수 상태를 보존합니다. `codex mcp login`은 이 정적 개인 토큰 PoC의 발급/로그인 수단으로 사용하지 않습니다.

#### 도구 노출과 행동 권한

현재 tenant 서버의 정적 목록은 24개입니다. 첫 단계는 `access_context`와 read 12개를 client allowlist에 지정하고 서버 정책도 read만 허용합니다. 도구 목록에 보이는 것과 호출 권한이 있는 것은 다릅니다. 다음 변경 11개는 필요한 역할을 운영자가 확정한 뒤 추가합니다. 다섯 행동 권한을 모두 부여해야 하는 경우에도 그 배정을 실제 사용자별로 기록하며 자동 기본 권한으로 삼지 않습니다.

| 서버 권한 | 도구 |
| --- | --- |
| 인증된 자기 소속 조회 | `access_context` |
| read | `wiki_read`, `wiki_search`, `ontology_query`, `ontology_connections`, `ontology_context`, `ontology_impact`, `ontology_review_query`, `ontology_correspondence_query`, `ontology_correspondence_prepare`, `ontology_correspondence_find`, `ontology_concept_find`, `ontology_concept_query` |
| read + write | `wiki_write` |
| read + ontology_write | `ontology_generate`, `ontology_correspondence_propose` |
| read + ontology_review | `ontology_review`, `ontology_review_undo`, `ontology_correspondence_review`, `ontology_correspondence_review_undo` |
| read + ontology_policy | `ontology_policy`, `ontology_policy_undo`, `ontology_correspondence_policy`, `ontology_correspondence_policy_undo` |

허용 profile은 조회/정책의 정확한 맥락이며 read 경계가 아닙니다. 기존 null·업무 문자열·현업/개발자 관점을 임의 통합하지 않습니다. 서버 read 권한은 같은 tenant 전체이므로 문서별 비밀 분리가 필요하면 현재 profile로 해결하지 않습니다. `writes` 확인이나 토큰 사용은 사람이 판단 내용을 직접 승인했다는 증명이 아니며 실제 요청한 업무 결정만 기록합니다.

#### 전환 순서와 legacy 중복 노출 차단

원본 경로가 다른 복제본도 같은 논리적 자료 공간으로 관리합니다. client에서 도구를 숨기거나 같은 저장 잠금을 쓴다는 이유로 legacy 노출이 차단됐다고 판정하지 않습니다. 원본·대상·보존 복제본에 무인증/공유 토큰 legacy로 접근할 수 있는 경로가 없어야 합니다. 무관한 별도 검증 저장소는 전환 원본에 합치거나 임의 종료하지 않습니다.

| 단계 | 수행/통과 조건 | 실패 시 상태 |
| --- | --- | --- |
| G0 운영 입력·현황 고정 | S/T/U/권한/profile/비밀 경로·복귀 대상을 확정. 프로젝트/전역/앱/IDE/CLI/원격의 등록·실행 프로세스·재시작/자동 시작 경로와 각 real root를 비밀 없이 분류 | 확정 전 실제 준비/전환하지 않음 |
| G1 격리 예행 검증 | 새 임시 사용자·tenant·원장으로 PLAN의 A/격리 항목과 설정 예행만 수행. 실제 토큰/자료를 사용하지 않고 자동 승인 override와 사람 확인을 분리. 실제 B/C 확인은 G4/G5에서 수행 | 기존 연결 그대로, candidate는 폐쇄 |
| G2 원본 동결·구 노출 종료 | 모든 사용자가 저장을 마치고 진행 중 요청의 결과를 확인. 등록된 정확한 legacy 세션/서버/해당 터널·재실행 경로를 종료/비활성화하고 완전히 종료됐는지 확인. PID 파일만 믿거나 광범위 프로세스 종료를 하지 않음 | 미확인 프로세스/저장 결과가 있으면 복사·새 실자료 연결 중단 |
| G3 보존·복사·검증 | G2 유지 아래 원본 전체 백업·staging 복사·manifest/reader/tenant/참조 검사 후 T 공개. 원본은 보존하되 서비스하지 않고 T를 유일한 쓰기/조회 기준으로 기록 | source·backup·candidate 모두 보존, 어느 쪽도 자동 노출하지 않음 |
| G4 실제 read 연결 | read13·서버 read-only로 단일 llm_wiki 교체. 새 세션의 access_context와 실제 access/도구 목록, 원문/판단/대응/통합 조회를 확인. 실제 자료에는 쓰지 않음 | 오류면 연결을 닫고 유지보수. legacy/다른 저장소로 응답하지 않음 |
| G5 변경 기능 준비 | 격리 검증의 권한·CAS·승인·되돌림을 통과한 필요한 변경 도구/권한만 추가. 실제 업무 쓰기는 별도의 구체 요청으로 수행하고 첫 변경 시점/영수증을 보존 | 변경 시도/응답 유실은 쓰기 가능 상태로 취급, 옛 데이터 복원 금지 |
| G6 완료·운영 인계 | 새 CLI와 실제 사용할 앱의 토큰 주입·소속·도구 가용성·단일 서비스 경로·보존/복귀 자료를 확인. 이후 세션도 최신 scope/read/prepare부터 시작 | 미검증 표면은 완료로 묶지 않음 |

설정 파일은 최신 내용을 다시 읽고 예상 기준 hash와 대조한 뒤 해당 llm_wiki 부분만 원자적으로 교체합니다. 정책/클라이언트 설정/프로세스/데이터 공개를 하나의 원자 거래라고 주장하지 않습니다. 바뀐 설정을 덮거나 버전값만 새로 넣어 강행하지 않고 그 변경을 검토해 다시 준비합니다. 기존 stdio 프로세스·열린 대화의 도구 캐시와 다른 클라이언트는 설정 교체만으로 종료되지 않으므로 G2/G4를 건너뛰지 않습니다. 실제 적용 중에는 활성 도구를 스스로 끊는 세션에서 계속 쓰지 않고 별도 관리 경로와 재시작 순서를 준비합니다.

초기 범위에 HTTP/터널은 추가하지 않습니다. 이후 원격 사용을 요청받으면 같은 개인 정책·개별 Bearer·loopback/Host/Origin/요청 상한을 유지한 별도 경로로 검증합니다. 기존 공유 토큰 HTTP를 동일 자료에 남기는 방식으로 원격 기능을 유지하지 않습니다. 현재 모든 원격 노출이 종료됐다고 이번 문서 조사로 보고하지 않습니다.

#### 준비 도구의 구현 경계 (2026-10-24)

- [런처](../../../core/personal_launcher.py)는 POSIX의 no-follow directory/file descriptor로 개인 토큰·정책을 검사합니다. current UID·일반 파일·단일 link·0600와 직접 부모0700, 모든 부모의 symlink/쓰기 권한·bounded read를 확인하고 기존 정책 인증을 재사용합니다. stdio/env/프로젝트 Python을 고정하고 기존 LLM_WIKI/PYTHON 변수의 주입을 제거합니다. 인수 축약과 legacy fallback을 거부하며 비밀 없는 고정 오류만 stderr로 냅니다. 토큰 발급·클라이언트 등록·운영 정책 편집은 수행하지 않습니다.
- [전환 점검](../../../tools/transition_check.py)은 명시 source/target의 전체 파일·빈 디렉터리를 제한된 메모리로 캡처하고, frozen store에서 기존 graph/review/correspondence reader를 재사용합니다. 파일 시스템 디렉터리/lock 생성 없이 보존 manifest·independent inode·tenant/actor·전체 원장·history/ABA·검사 중 변경을 확인합니다. source/target 중첩·symlink·비일반 파일·손상·누락·한도는 차단합니다. 이중 관측은 writer 동결을 대신하지 않습니다.
- `--policy/--tenant-root`는 명시 대상 귀속과 기존 parser 검증, `--config`는 구문과 기준 hash의 검사입니다. baseline은 비교용 데이터이며 그 경로를 실행/재탐색하지 않습니다. source-only 기준 뒤 명시 target 추가는 가능하지만 기준에 있던 대상/정책/설정을 생략·교체할 수 없습니다. 새 report만 0600·no-clobber로 공개하며 성공 후 임시 정리 경고를 저장 실패와 구분합니다. 공개 요약에는 개수/상태/코드만, 경로·manifest·분포는 비공개 report에 둡니다.
- `inspection_passed`는 이 파일 점검의 통과이며 `ready_for_cutover=false`와 수동 미검증 gates를 유지합니다. `write_state`는 운영자의 선언으로 표시하고 실제 쓰기 유무를 입증하지 않습니다. 모든 경우 옛 복사본 덮어쓰기·legacy/옛 권한으로 복귀를 금지합니다. 서비스 종료·복사·설정 적용·롤백 실행기는 추가하지 않았습니다.
- [새 CLI 검증](../../../tools/verify_transition.py)은 기존 합성 fixture·저장 API로 준비한 임시 데이터만 사용합니다. personal launcher·read13 allowlist·read 권한으로 새 세션을 만들고 실제 MCP 호출/대상/출처/버전/범위와 전후 바이트를 검사합니다. 원문 검색·명시 대응에서 발견한 보조 근거 조회는 허용하되 주 대상의 최신 전문가 판단 조회를 대체하지 못합니다. 모델의 성공 자기보고로 통과하지 않으며 실제 원문 의미 평가·사람 승인·GUI/원격 전환으로 확대하지 않습니다.

#### 검증 증거와 되돌림

검증은 (A) 합성 임시 자료의 전체 기능/실패/새 CLI, (B) 실제 T의 read-only 연결·보존, (C) 사용자가 실제 요청한 업무 변경을 구분합니다. 기존 [CLI 검증](../../../tools/verify_codex.py)의 expert-policy 경로는 임시 tenant/env 전달/새 세션의 기반일 뿐 D-038·D-040 실제 CLI 전체나 수동 확인을 이미 검증하지 않습니다. legacy fixture의 per-tool approval_mode=approve는 수동 쓰기 승인 시험에 재사용하지 않습니다. `verify_codex --transition`은 보호된 개인 파일 런처를 통한 새 CLI의 read 흐름과 출처/ref·버전을 검사하며, 변경 CAS/원장/히스토리 실패 경계는 격리 회귀로 검증합니다. 실제 GUI·수동 확인·운영 권한 검증은 별도로 남깁니다.

실제 S/T가 비어 있으면 존재하지 않는 대응/전문가 판단을 만들어 실자료 재사용을 증명하지 않습니다. 인증·도구·빈 탐색 결과와 읽기 전용 보존은 확인하되 `data_reuse_verified=not_applicable_empty`로 남깁니다. 실제 판단이 있으면 전체 원장 검증과 대표 현재/보류/다른 범위/undo 출처를 원본과 대조합니다. `connection_ready`, `write_ready`, `data_reuse_verified`, `remote_verified`를 각각 기록하고 임시 자료 통과를 실제 자료·사람 승인·원격 완료로 합치지 않습니다.

비공개 전환 기록에는 상태 G0–G6, source/target·설정 기준 hash, 보존 manifest/검증 결과, 읽기만 했는지, 첫 변경 시도/영수증/event ID와 확인 불가 여부, 종료한 노출/복귀 경로를 남깁니다. 토큰/원문/실제 URL은 제외합니다. 기록 저장 실패도 성공한 업무 쓰기를 재전송할 근거가 아니며 해당 T/ID를 조회해 상태를 확인합니다.

| 되돌림 시점 | 허용 절차 |
| --- | --- |
| G2 전 | candidate 준비를 중단하고 원래 서비스는 당시 허용 상태 그대로 둠. 실패한 인증을 다른 경로로 우회한 성공으로 기록하지 않음 |
| G2 이후, 실사용 변경 없음 확인 | 새 연결을 닫고 source/target/backup·설정 사본을 보존. 기본 복귀는 유지보수 정지 또는 검증된 개인 인증 구성 재적용. legacy 설정 사본은 오프라인 보관하며 자동 재활성화하지 않음 |
| 실사용 쓰기 성공 또는 확인 불가 | 모든 writer를 멈추고 전환 후 전체 데이터도 추가 보존. 유일한 최신 T를 유지한 채 수정된/검증된 개인 인증 연결로 복귀하거나 정지 상태 수동 복구. 옛 S/backup을 덮어 복원하거나 옛 복제본을 조회 정답으로 사용하지 않음 |
| 개별 내용·판단 취소 | 연결 롤백과 분리. 원문은 최신 read/CAS와 WikiStore.save로 새 전체 이력을 추가하고, 문서/대응 판단은 최신 state/prepare와 각각의 undo 역이벤트 사용. 다른 사건을 건너뛰거나 과거 actor/hash를 수정하지 않음 |
| 정책/비밀 오류·권한 회수 | access_denied/access_unavailable·startup 실패로 닫힘 유지. 현재 회수/소속 결정을 보존하며 과거 정책·공유 토큰·무인증/다른 tenant로 우회하지 않음 |

timeout·응답 유실·저장 후 cleanup 경고는 무조건 쓰기 실패가 아닙니다. 새 T의 문서/알려진 correspondence ID/event를 먼저 조회하고 성공 저장을 반복하지 않습니다. 잠금 시간 초과 storage_busy만 같은 기준으로 나중에 재시도하며 conflict는 최신 내용/판단을 대조합니다. 되돌림 중 검증 실패도 원본·전환 후 원장·백업을 지우는 정리로 해결하지 않습니다.

[D-027]: ../knowledge/DECISIONS.md#d-027--선택-문서의-자연어전체-그래프를-보존하는-조회-맥락-2026-10-22-4-b
[D-028]: ../reviews/DECISIONS.md#d-028--원문추출과-분리한-검토-원장과-상태-충돌-검사-2026-10-22-4-c
[D-031]: ../reviews/DECISIONS.md#d-031--전문가-정책을-기존-검토-원장에-보존하고-최신-판단으로-조회-2026-10-22-선행-1
[D-035]: ../analysis/DECISIONS.md#d-035--문서-등록의-맥락-힌트와-bounded-context-간-대응-검토-2026-10-23
[D-036]: ../ontology/DECISIONS.md#d-036--추출-신뢰성반복-일관성과-전문가-조정의-판정-기준-2026-10-23

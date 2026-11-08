# 인증·워크스페이스 계획

## 현재 상태

PoC 앱의 역할별 조회 관점은 [D-083](DECISIONS.md#d-083--poc에서-역할별-조회-관점-제외-2026-10-29)에 따라 제외했습니다. 앱은 허용된 공간의 중립 기본 조회만 사용하며 이전 역할 선택의 자동 복원을 거부합니다. 기존 profile/API/MCP·원장 호환과 사용자·tenant·행동 권한 검사는 유지합니다. 앱 기본 조회·보존 9묶음 및 웹 통합 검증을 완료했으며 운영 정책을 자동 변경하지 않습니다. [실행 기록](HISTORY.md#2026-10-29--poc-앱의-기본-중립-조회-고정)을 따릅니다.

D-071의 인증 담당 구현과 격리 검증을 완료했습니다. 이름 가입·로그인, 사용자별 암호화 영구 토큰, 9개 권한·SDV 플랫폼 신규 가입, 본인 범위의 `access_revision`, 정확한 두 공개 POST를 구현했습니다. 기존 version 1 정책·사용자 ID·workspace ID와 개인 자료를 유지합니다. 실제 운영 적용과 앱·MCP 전체 통합 완료는 별도이며 [실행 기록](HISTORY.md)을 따릅니다.

기존 일반 `.token` 파일만 있을 때 최초 암호화 키 생성을 잘못 거부하던 시작 호환 문제를 수정했습니다. 암호문·미완료 가입·알 수 없는 항목·링크가 있으면 키를 재생성하지 않으며 기존 토큰·정책을 자동 이관하지 않습니다. 격리 검사와 실제 Mac의 기존 Bearer API/MCP 연결을 확인했고, 이름 로그인 이관·공개 주소의 개인 인증·다른 PC 연결은 별도 범위로 유지합니다.

## 이번 병렬 구현 공개 계약

- `core.modules.access.auth.initialize_auth(policy, *, key_path=None) -> AuthService`를 서버 조립 시 호출하고 `app.state.auth`에 둡니다. 기존 정책/tenant root 검증에 실패하면 중단하며 빈 정책이나 자료 루트를 생성하지 않습니다. MCP 담당의 `create_application(..., auth=None, credential_key_path=None)`·HTTP CLI `--credential-key-file` 연결을 확인했습니다.
- 의존성은 `cryptography==50.0.2`(현재 `.venv` 설치 확인), 검증된 Fernet 인증 암호화입니다. MCP 담당이 requirements/lock에 추가했습니다. 키 경로는 명시 `key_path`, `LLM_WIKI_CREDENTIAL_KEY_FILE`, 정책 부모의 `credential.key` 순서입니다. 기본 키와 `credentials/`는 tenant root 밖 정책 부모에 두며 명시 키도 tenant root 밖이어야 합니다. 새 키/파일은 0600, 새 디렉터리는 0700으로 생성합니다. 암호화 자격 증명이 이미 있는데 키가 없거나 잘못 교체됐으면 새 키/토큰으로 대체하지 않고 실패합니다. 기존 키 교체/재암호화는 자동 수행하지 않습니다.
- access router에 `POST /auth/signup`, `POST /auth/login`을 등록하므로 기존 `/api/v1` 조립으로 정확한 공개 URL이 됩니다. 요청 `{name: string}`만 받습니다. 성공 envelope의 `data`는 중첩 없이 `token`, `user_id`, `display_name`, `memberships`, `default_tenant`, `policy_revision`, `access_revision`입니다. membership은 기존 `permissions`, `profiles`, `default_profile`에 `display_name`을 추가합니다. `default_tenant`는 소속이 없는 기존 사용자에 한해 null입니다. access-context도 토큰 외 동일 필드를 제공합니다.
- `AccessScope.access_revision: str`을 추가합니다. `policy_revision`은 기존 전체 파일 SHA를 유지합니다. 새 기준은 본인 ID/소속/정렬된 유효 권한/허용 profile 정의와 기본값/인증 세대(토큰 해시 포함)만 반영하며 다른 사용자·표시 이름·JSON 공백 변경에 영향받지 않습니다. 공통 Access DTO/`access_value` 추가 및 신규 범위 비교에서 이 필드를 소비하는 것은 MCP/업무 담당입니다. 과거 actor 원장을 재작성하지 않습니다.
- 기존 version 1의 필수 필드를 유지하며 tenant의 `display_name`, user의 `display_name`, `default_tenant`, `auth_generation`만 선택 확장합니다. 기존 사용자는 표시 이름이 없으면 기존 ID를 이름으로 사용합니다. 복구 암호문이 없는 기존 사용자 로그인은 토큰을 재발급하지 않고 안전하게 실패하며 기존 Bearer 인증은 유지합니다. 관리자용 `AuthService.enroll_existing_token(user_id, token)`은 현재 정책 해시와 일치하는 알려진 토큰만 암호화 보관합니다. 관리자가 해시/인증 세대를 명시 교체한 뒤 같은 함수로 복구 토큰을 교체할 수 있으며 ID·이름·자료는 바꾸지 않습니다.
- 신규 사용자는 `sdv-platform`에 현 9개 권한으로 가입합니다. 신규 workspace 표시명은 `SDV 플랫폼`, 기본 profile은 `default`(domain/viewpoint null)입니다. 이미 있는 `sdv-platform`은 경로/프로필/표시명을 보존하며 기존 허용 profile 중 `default` 또는 정렬 첫 profile을 선택합니다. 다른 ID를 표시명만 보고 바꾸거나 기존 자료를 연결하지 않습니다. 최대 5명은 기존 사용자 포함입니다.
- 가입은 정책 부모의 `.auth.lock`과 `.signup.pending.json` 복구 기록으로 직렬화합니다. 가입 의도를 먼저 보존한 뒤 필요한 새 workspace·자격 증명 암호문을 확정하고 정책을 마지막에 원자 교체합니다. 서버 재시작/다음 가입·로그인 때 같은 ID/토큰으로 복구합니다. 관리자 정책 쓰기도 같은 잠금을 사용하거나 서버를 중지해야 합니다. 미완료 기록의 기준 정책과 달라졌으면 관리자 변경을 덮지 않고 실패합니다. 정책 확정 뒤 복구 기록 정리 실패는 성공을 되돌리지 않으며 비밀값 없는 경고와 다음 호출의 정리로 처리합니다.
- 공개 예외는 tenant 정책 모드의 정확한 두 POST뿐입니다. Host/Origin과 본문 제한은 유지하며 모든 토큰 응답은 `Cache-Control: no-store`입니다. 중복 가입 409 `name_conflict`, 5명 초과 409 `user_limit`, 없는 이름 401 `login_failed`, 복구/키/정책 실패 503 `access_unavailable`입니다.

## 남은 연동과 검증

`core/tests/poc_access`의 27개 검증이 통과했습니다. 독립 프로세스의 동시 가입·종료 후 재로그인, 부분 실패/응답 유실 복구, 기존 자료·사용자 보존, 권한 회수·기준 안정성, HTTP 인증 경계를 포함합니다. 서버 조립/의존성/공통 DTO는 MCP 담당 구현과 연결되어 있으며 업무별 신규 범위 비교 및 앱 전체 흐름은 각 담당 통합 검증으로 확인합니다. 실제 운영 정책·서버·사용자 CLI에는 쓰기 시험을 하지 않았습니다.

## 다음 요청에서 확인할 범위

실제 운영 사용자 적용·기존 사용자 토큰의 명시 암호화 등록·원격 운영 검증은 남아 있습니다. SSO는 이번 무비밀번호 PoC 범위 밖입니다. 운영 키는 소스 관리에 넣지 않고 별도로 보존해야 합니다.

## 완료 조건

허용 tenant·행동·profile을 서버 정책으로 확인하고 비허용 자료를 읽지 않습니다. 연결/정책 변경 시 거부·회수·격리·보존을 검증합니다.

## 근거와 기록

- [적용 결정](DECISIONS.md) · [상세 규칙](RULES.md)
- 이관 전 검증/계획 원문 (정리로 삭제된 참고 자료)
- 과거 시험 수는 당시 기록입니다. 이번 문서 이관에서 제품 시험을 재실행한 결과가 아닙니다.

## 이후 작업 기록

실제 검증·실패·미실행은 [HISTORY](HISTORY.md)에 기록합니다.

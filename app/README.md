# LLM Wiki 데스크톱 앱

Electron·React·React Router·Jotai·TypeScript로 만든 데스크톱 앱입니다. 서버 연결·문서/원본 관리·지식/검토·개인 AI 분석과 질문·결과 초안의 명시 Wiki 반영을 지원합니다. 밝은/어두운 테마와 제한된 IPC, OS 보호 저장을 사용합니다. 설치 패키지와 개인 실행 환경의 준비 범위는 아래 패키징 절을 따릅니다.

## 실행

Node.js 24 이상과 npm을 사용합니다. `.nvmrc`는 Node 24를 지정하며 의존성은 `package-lock.json`에 고정합니다.

```sh
cd "/Users/jong-yu/Projects/LLM Wiki/app"
npm ci
npm run electron:install
npm run dev
```

Electron 45의 실행 파일은 `electron:install`로 준비합니다. 최초 설치에는 npm과 Electron 공식 배포 서버에 접근해야 합니다. 개발 화면은 `127.0.0.1:5173`만 사용하고 해당 포트가 사용 중이면 실행을 중단합니다.

현재 Mac에는 Node 20도 설치되어 있습니다. 이 작업에서 사용한 Node 24는 다음 위치에 있으며, 기본 `node --version`이 24 미만이면 Node 24를 선택한 뒤 위 명령을 실행합니다. 다른 PC에서는 자체 설치한 Node 24를 사용합니다.

```sh
export PATH="/Users/jong-yu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node --version
```

빌드 결과를 실행하려면 다음을 사용합니다. `build`는 타입·코드 경계·포맷·토큰 검사를 먼저 수행합니다. 설치용 앱 패키지를 만드는 명령은 아닙니다.

```sh
npm run build
npm start
```

## 서버 연결

앱의 **서버 연결**에서 서버 기본 주소와 개인 토큰을 입력합니다. 실제 `/api/v1/access-context`로 허용 작업 공간·행동·관점을 조회하고 선택 직전에 다시 확인합니다. 원격은 HTTPS, 같은 PC의 loopback 서버만 HTTP를 허용합니다. reverse proxy prefix와 `/api/v1`을 처리합니다.

토큰 입력은 제출 직후 비우며 renderer에 다시 반환하지 않습니다. **이 PC에 연결을 보호 저장**을 선택하면 OS 보호 저장을 사용하고, 재시작 때 서버의 현재 인증·권한·관점을 재확인한 뒤 연결을 복원합니다. 보호 저장을 선택하지 않으면 앱 종료 후 다시 입력합니다. 개인 실행 중에는 main이 전용 임시 인증 파일을 만들고 자식 프로세스 종료 후 지웁니다. 연결 해제는 서버 토큰 자체를 회수하지 않으며 로컬 복구 자료의 삭제 범위는 아래 종료 후 복구 절을 따릅니다.

## 문서 목록

작업 공간 선택 후 **문서 목록 보기** 또는 왼쪽 **문서 목록**으로 이동합니다. 왼쪽의 저장된 자료, 중앙 문서 영역, 오른쪽 문서 정보로 나뉘며 각 패널이 따로 스크롤됩니다. 선택한 서버·사용자·작업 공간·관점에서 실제 목록 API를 읽고, 20개씩 이전/다음 페이지를 조회합니다. 현재 페이지에서 제목·경로·위키 폴더·자료 종류를 좁혀 찾을 수 있으며 서버 전체 검색은 아닙니다. 자료 선택 시 실제 목록 메타데이터를 표시하고 긴 판본 정보는 펼쳐 확인합니다.

위키를 선택하면 실제 본문을 중앙에 Markdown으로 표시합니다. 표·체크리스트·코드를 지원하며 링크/이미지는 설명과 주소로 표시합니다. **본문 다시 불러오기**로 최신 본문을 조회할 수 있고 빈 본문·읽기 실패·목록 이후 변경된 판본을 구분합니다.

등록 원본을 선택하면 실제 파일 API에서 선택한 판본의 크기·SHA-256을 확인하고 중앙에 미리 표시합니다. 지원 형식은 MD/TXT/PDF/XLSX/DOCX와 PNG/JPG/JPEG/GIF/WebP/BMP/TIF/TIFF이며 최대20MiB입니다. Markdown은 서식으로, 텍스트와1MiB 초과 Markdown은 원문 텍스트로 표시합니다. 바이너리 원본은 원본 파일과 변환 보고를 분리해 열람합니다. **원본 다시 불러오기**로 같은 불변 판본을 다시 조회하며 빈 원본·읽기 실패를 구분합니다. 원본 조회는 분석을 시작하지 않습니다. 목록 새로고침·조회 한도·권한/연결 변경과 빠른 문서 전환 시 이전 자료를 숨깁니다.

## 원본 등록

문서 목록 오른쪽 위 **원본 등록**에서 파일 업로드 또는 직접 입력을 선택합니다. 현재 작업 공간에 `source_write` 권한이 필요하며 위 지원 형식의 원본 최대20MiB를 보관합니다. 직접 입력은 UTF-8 텍스트입니다. 파일은 OS 선택 창으로 고르고 제목을 확인한 뒤 **등록하고 미리보기**를 누릅니다. 완료되면 목록이 갱신되고 새 원본을 중앙에서 바로 미리봅니다. 새 원본이 첫 페이지 밖에 있으면 방금 등록한 항목을 함께 표시합니다.

등록 완료와 목록 갱신 실패는 따로 표시합니다. 등록 결과가 불확실하거나 서버 확인이 진행 중이면 초안과 요청 번호를 보존하며 **등록 상태 확인**으로 같은 영수증을 조회합니다. 이 동작은 등록을 다시 전송하지 않습니다. 원본을 등록해도 분석은 시작되지 않습니다. 미확정 요청과 파일 참조는 현재 앱 실행 중에만 보존합니다.

## 개인 AI 분석·결과

문서 목록에서 등록 원본을 선택한 뒤 **분석·결과**를 엽니다. 저장할 상대 위키 경로(예: `notes/topic.md`)와 생성 결과를 선택하고 **분석 시작**을 누릅니다. 현재는 UTF-8 `.md`/`.txt` 원본 최대4MiB와 대상 문서1개를 지원합니다. 서버에는 사용할 공통 규약이 게시되어 있어야 하며 사용자의 원본/위키/그래프 쓰기 권한이 필요합니다.

Electron main이 개인 실행 환경에 지정한 Python의 기존 개인 AI 어댑터를 실행합니다. 이 PC에 로그인된 Codex 또는 Claude Code CLI가 필요합니다. 개인 Python 실행 환경은 앱 패키지와 별도로 설치합니다. 저장된 공통 설정이 없으면 앱 시작 전에 `WIKI_ANALYSIS_CODEX_CLI`·`WIKI_QUESTION_CODEX_CLI`·`WIKI_PROPOSAL_CODEX_CLI`로 각 실행기 경로를 지정할 수 있습니다. `WIKI_AI_PROVIDER=claude`와 `WIKI_CLAUDE_CLI`로 Claude Code를 선택할 수 있으며 제공자를 생략하면 Codex를 사용합니다. 로그인·서버 설정을 앱이 자동 변경하지 않습니다. Python 어댑터의 준비 조건과 제한은 [프로젝트 실행 안내](../README.md#개인-ai-실행-어댑터)를 따릅니다.

화면은 로컬 실행과 서버의 실제 저장 영수증을 따로 표시합니다. **현재 결과 새로고침**과 기존 작업 선택은 분석을 다시 실행하지 않습니다. 일부만 저장되었거나 저장 결과가 확인되지 않으면 성공한 내용을 보존하고 자동 재실행하지 않습니다. 영수증 당시 판본과 현재 결과의 변경 여부, 자동 검사와 의미 평가 미실행·사람 미승인을 구분합니다. **분석 취소**로 실행 중인 작업을 중단할 수 있습니다. 대화상자 닫기는 조회 화면만 닫으며 연결 변경과 창 종료는 로컬 실행을 중단합니다.

## 검사

```sh
npm run check
npm run test:tooling
npm run test:e2e
```

`test:e2e`는 다시 빌드한 뒤 실제 Electron 창을 실행하므로 데스크톱 세션이 필요합니다. 프로젝트 `.venv`의 실제 FastAPI를 임시 정책·자료로 실행하는 연결·문서 목록/본문 검사도 포함합니다. 임시 프로필에서 앱 정보 IPC·다른 창의 요청 거부·Node 접근 부재·격리·지원 OS의 sandbox·라우팅/새로고침·테마·외부 탐색/팝업 차단을 확인합니다. `test-results/`에는 실행 화면을 남기고 실패 시 trace도 보존합니다. 기존 위키나 운영 인증 설정을 시험 자료로 사용하지 않습니다.

`lint`는 Oxlint와 공식 `oxlint-tsgolint`로 deprecated 함수·타입·속성까지 검사하며, `format`/`format:check`는 Oxfmt를 사용합니다. `test:tooling`은 임시 프로젝트에서 금지 import·경로 우회·순환·Hooks와 허용 사례를 확인하며 `check`에도 포함됩니다. `npm run format`은 수기 앱 코드/설정을 정리합니다. 토큰 산출물·기존 설계 문서·기존 생성기는 직접 포맷하지 않습니다. 검사 결과와 플랫폼별 미검증 범위는 [UI 계획](../docs/domains/ui/PLAN.md)과 [실제 검증 기록](../docs/domains/ui/HISTORY.md)을 따릅니다.

## 구조와 경계

수기 스타일은 `app.scss`와 컴포넌트의 `.module.scss`를 사용합니다. `sass-embedded`는 개발/빌드 의존성이며 Vite에서 처리합니다. 자동 생성하는 `tokens.css`와 밝은/어두운 테마용 CSS 변수는 그대로 유지합니다.

앱 루트에는 패키지/lockfile·README/작업 규칙·npm/Node 진입 설정과 타입 검사 프로젝트의 참조 목록만 둡니다. `tsconfig.json`은 Oxc가 기존 네 개 타입 설정을 찾는 진입점이며 실제 옵션은 `config/typescript/`에 유지합니다. 빌드·테스트·검사 설정은 `config/`에서 관리하며 npm 명령이 각 설정 경로를 명시합니다.

```text
app/
  package.json, package-lock.json
  tsconfig.json  타입 검사 프로젝트의 참조 목록
  .npmrc, .nvmrc
  README.md, AGENTS.md
  config/
    electron.vite.config.ts
    playwright.config.ts
    oxlint.config.ts, import-boundaries.mjs
    oxfmt.json
    typescript/tsconfig.*.json
  src/       앱 코드
  tests/     e2e·tooling 검사
  design/    디자인 토큰 원본
  scripts/   토큰 생성기
  docs/      앱 설계
```

| 위치                              | 역할                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `src/main/`                       | 앱·창/CLI 수명, 호출자·현재 범위 검사, 제한된 HTTP·파일 처리 |
| `src/preload/index.ts`            | 업무별 검증된 IPC만 노출하는 단일 CJS 번들                   |
| `src/shared/contracts/`           | Node·Electron·React에 의존하지 않는 공개 IPC 타입/응답 검사  |
| `src/renderer/app/`               | provider·HashRouter·프레임·테마·공개 실행 정보 조립          |
| `src/renderer/pages/`             | 화면 경로별 feature 조합과 선택 결과 연결                    |
| `src/renderer/platform/`          | renderer의 유일한 bridge 접근                                |
| `src/renderer/shared/ui/`         | 버튼·입력 필드·패널·상태·탭·대화상자                         |
| `tests/e2e/`                      | 실제 Electron 실행 검사                                      |
| `design/tokens.json`              | 디자인 값·시안 hash·출처의 단일 원본                         |
| `scripts/build-design-tokens.mjs` | 기존 CSS/TypeScript 생성 및 정합성 검사                      |
| `src/renderer/shared/theme/`      | 생성된 디자인 토큰; 직접 수정하지 않음                       |

main/preload/renderer와 도구 설정을 따로 타입 검사하며 renderer에는 Node 전역 타입을 열지 않습니다. Oxlint 내장 규칙은 순환·절대경로 import·Hooks·Node/React 금지 참조와 직접 bridge 접근을, 앱 전용 규칙은 정규화한 alias/상대경로의 계층·다른 feature/domain 참조를 검사합니다. 실제 구현한 폴더만 두며 향후 domain/feature 목록의 빈 파일을 미리 만들지 않습니다.

공통 UI 기반은 묶음으로 구현했습니다. [컴포넌트 계약](docs/component-architecture.md#4-공용-컴포넌트의-계약)은 설계 문서에, [구현 범위와 검증](../docs/history/2026-10-25-before-domain-split/PLAN.md#5단계-공통-ui의-구현)은 계획에 둡니다. 테마·시작 안내·앱 정보의 상태 표시에도 적용했습니다.

서버 연결·문서 편집/이력/연결·지식 탐색/검토·원본 판본·AI 작업/추출/첨부·개인 대화/결과/비교·조건·개념 대응을 제한된 preload → main HTTP client → 백엔드 일반 API로 연결합니다. 개인 AI 분석은 main이 기존 Python 어댑터를 시작하고 같은 백엔드의 MCP로 저장합니다. 질문·대화 화면은 고정 근거와 저장한 질문으로 개인 AI를 명시 실행하고, 확인된 답변을 개인 기록과 편집 가능한 결과 초안으로 보관합니다. 외부/직접 답변 입력도 지원하며 서버 저장 영수증과 생성 중 미리보기를 구분합니다. [화면별 API와 필요한 추가 계약](docs/api-coverage.md), [실제 검증 결과](../docs/domains/ui/HISTORY.md)를 참고하세요.

## 설계와 디자인 자산

- [디자인 토큰](docs/design-tokens.md): 값·테마·출처·생성 규칙.
- [컴포넌트 설계](docs/component-architecture.md): domain/feature 소유권·Electron 경계·명명 규칙.
- [D-045](../docs/domains/ui/DECISIONS.md#electron-실행-골격의-착수-2026-10-25): 실행 골격의 선택 이유와 구현 범위.

저장소 루트에서 토큰만 생성/검사할 수도 있습니다.

```sh
node app/scripts/build-design-tokens.mjs
node app/scripts/build-design-tokens.mjs --check
```

원본 시안을 대조할 때만 `--source <HTML의 절대 경로>`를 추가합니다. 일반 검사는 저장소 밖 원본 파일 없이 동작합니다. `core/`의 서버나 기존 자료·원장을 앱에 복사하지 않습니다.

## 개인 실행 환경 설정

**작업 공간 → 개인 실행 환경**에서 배포받은 Python 프로젝트 폴더와 Python·Codex·Claude Code·Tesseract 실행 파일 및 OCR 언어 데이터 폴더를 선택합니다. Codex 또는 Claude Code 제공자를 선택하고 각각의 경로는 네이티브 선택 창에서 고릅니다. `설치·로그인 진단`은 기존 `tools.runtime_doctor`와 `tools.source_conversion_cli --diagnose --ocr-language kor+eng`를 실행합니다. 모델 호출·로그인·설치를 자동 시작하지 않습니다. 선택한 CLI의 로그인 정보 존재와 실제 모델 호출 가능성을 구별하며 OCR 실행 파일·언어 준비와 인식 정확도도 구별합니다.

설정 화면은 현재 실행 제공자와 다음 시작에 사용할 선택을 함께 표시합니다. 설정 저장은 다음 앱 시작에 적용되며 분석·질문·추출안에 공통으로 사용합니다. 기존 v1 설정은 Codex로 읽고 다음 명시 저장에서 v2로 전환합니다. 진행 중 실행에는 기존 설정을 유지합니다. 설정 충돌·파일 손상 때는 기존 파일을 보존합니다. 설치·고정 버전 업데이트 명령은 화면과 [프로젝트 실행 안내](../README.md)에 있습니다. 앱 업데이트는 제공받은 새 설치 파일로 교체하며 자동 다운로드 채널은 구성하지 않았습니다.

macOS/Linux에서는 Claude 경로가 기본값 `claude`일 때 사용자 홈의 `.local/bin/claude`를 먼저 확인하고, 없으면 PATH를 사용합니다. 직접 고른 경로는 바꾸지 않습니다. Windows에서는 설치된 실행 파일을 선택합니다.

기본 실행 설정은 `WIKI_CLIENT_ROOT`·`WIKI_PYTHON`이며 개발 실행에서는 프로젝트 `.venv`를 찾습니다. 이전 `WIKI_ANALYSIS_PROJECT_ROOT`·`WIKI_CLIENT_PYTHON`·`WIKI_ANALYSIS_PYTHON`도 시작 때 정규화합니다. 저장된 앱 설정이 있으면 그 설정을 사용합니다. 선택한 Tesseract 디렉터리는 실행 PATH에, 언어 데이터 폴더는 `TESSDATA_PREFIX`에 반영합니다. 앱 바이너리에 Python·Codex·Claude Code·OCR를 포함하지 않습니다.

## 설치 산출물과 서명

```sh
npm run package:dir           # 현재 OS용 실행 디렉터리
npm run package:mac:unsigned  # macOS arm64 DMG + ZIP (서명/공증 없음)
npm run package:win:unsigned  # Windows x64 NSIS (서명 없음)
npm run package:runtime       # Python 개인 실행기 소스 ZIP + SHA256
npm run package               # 현재 OS: macOS DMG/ZIP, Windows NSIS, Linux tar.gz
```

`config/electron-builder.json`은 기본 미서명 구성이며 게시하지 않습니다. 개발 실행 파일은 먼저 `npm run electron:install`로 준비합니다. 패키징은 지정한 OS·CPU용 공식 Electron을 받아 사용하며 개발 PC의 Electron 폴더를 다른 OS용으로 재사용하지 않습니다. 최초 대상 빌드에는 Electron과 electron-builder 도구의 공식 배포 서버에 접근해야 합니다. 산출물은 `app/release/`에 둡니다. DMG의 앱을 Applications에 복사한 뒤 실행합니다. 미서명 앱의 Gatekeeper 허용은 사용자가 출처를 확인한 뒤 OS에서 결정합니다. 검증 과정에서 격리 속성이나 Gatekeeper를 자동 해제하지 않습니다. Windows는 NSIS 설치 파일을 실행해 현재 사용자 계정으로 설치하며, 앱 자료 삭제 옵션은 사용하지 않습니다.

`llm-wiki-personal-runtime-0.1.0.zip`은 core/tools Python 소스, 규약 조립에 필요한 의미 지침 한 파일과 고정 requirements를 포함합니다. 압축을 풀고 `python3 -m tools.setup_runtime --role personal`을 실행한 뒤 앱에서 폴더와 `.venv` Python을 선택합니다. Windows는 `py -3.12 -m tools.setup_runtime --role personal`을 사용합니다. 원문·위키·히스토리·토큰·개인 설정·테스트·`.venv`는 포함하지 않습니다. 이 ZIP은 Python/OCR/계정의 설치 완료를 뜻하지 않습니다.

이전 검증 산출물을 보존하며 별도 차수를 만들 때는 electron-builder의 `--config.directories.output=release/<차수>`와 `python3 scripts/package-personal-runtime.py --output-dir release/<차수>`를 사용합니다. 패키지 검사 기록은 `WIKI_PACKAGE_VERIFICATION_DIR`로 같은 차수의 검증 폴더를 지정할 수 있습니다.

현재 설치 파일은 [후보2 차수](release/v0.1.0-candidate2-20261026/)에 보관합니다. 용량 정리로 이전 차수의 DMG·앱 ZIP·NSIS·blockmap과 `mac-arm64`·`win-unpacked` 해제본은 제거했습니다. 이전 검증 기록·SHA256 목록·소형 Python 소스 ZIP은 보존하며, 옛 SHA256 목록이 당시 설치 파일의 현재 존재를 뜻하지는 않습니다. 새 실행 디렉터리가 필요하면 `npm run package:dir`로 현재 소스를 패키징합니다.

서명과 공증은 기존 Developer ID identity 및 기존 키체인 공증 profile을 준비한 환경에서만 실행합니다. `CSC_NAME`, `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`을 해당 환경에 지정하고 `npm run package:mac:signed`를 사용합니다. `config/electron-builder.signed.cjs`는 누락된 자격에서 중단하고 `forceCodeSigning`, hardened runtime, 공증을 활성화합니다. 산출물은 `release/signed/`이며 자동 게시하지 않습니다. 비밀번호·API 키를 코드나 문서에 넣지 않습니다.

현재 Mac에서 사용 가능한 코드 서명 identity는 0개이며 공증 환경도 제공되지 않았습니다. 실제 DMG·ZIP 생성/시작 결과는 [UI 검증 기록](../docs/domains/ui/HISTORY.md)에 기록합니다. Windows NSIS 교차 빌드는 실제 Windows 설치·보호 저장·취소 통과를 뜻하지 않습니다. Windows의 개인 실행은 현재 PC의 보호 파일·프로세스 트리 진단에 성공해야 진행할 수 있으며, 별도의 실제 Windows 릴리스 검증은 아직 완료하지 않았습니다.

### 수동 업데이트

진행 중인 AI/변환 작업의 완료 또는 취소 상태를 확인하고 앱을 종료합니다. macOS는 새 DMG의 앱으로 Applications의 기존 앱을 교체하고, Windows는 같은 사용자 계정에서 새 NSIS 설치 파일을 실행합니다. 앱의 사용자 자료 폴더와 서버 자료 폴더는 지우지 않습니다. 앱의 설치 위치와 원본·위키를 저장하는 서버 위치는 서로 다릅니다.

Python 실행기 ZIP도 같은 배포 차수의 파일을 사용합니다. 새 ZIP을 별도 폴더에 풀고 그 폴더에서 `tools.setup_runtime --role personal`을 실행한 뒤, 앱의 개인 실행 환경에서 새 폴더와 해당 `.venv` Python을 선택·진단·저장하고 앱을 재시작합니다. 이미 같은 소스 폴더를 갱신한 경우에만 `--upgrade`로 고정 의존성을 갱신합니다. `--upgrade` 자체가 새 Python 소스나 앱을 내려받지는 않습니다.

다시 연결한 서버·사용자·작업 공간을 확인하고 기존 문서·작업 기록을 조회합니다. 앱 교체 시험은 설정 보존의 근거이며 운영 자료의 백업·복원 시험을 뜻하지 않습니다. 백업·복원은 사용자 선택에 따라 이번 v0.1.0 검증 범위에서 제외합니다.

### Windows 설치 후 확인

개인 Python 실행기를 설치한 폴더에서 PowerShell로 다음 진단을 실행합니다. 현재 Windows 사용자만 읽는 임시 파일과 그 PC의 시험용 프로세스 트리 종료를 실제로 확인하며 모델을 호출하지 않습니다.

```powershell
.\.venv\Scripts\python.exe -B -m core.runtime.desktop_bridge probe
```

성공 기준은 `ok: true`, `capabilities.runtime_ready: true`, `private_files: true`, `process_tree: true`, `probe: "private_file_and_process_tree"`입니다. `native_validation: "not_certified"`와 `windows_app_verified: false`는 제품의 실제 Windows 릴리스 검증이 아직 끝나지 않았다는 별도 표시입니다. 진단 실패는 `desktop_runtime_boundary_failed`로 실행을 차단하므로 오류를 보존하고 원인을 해결합니다. macOS에서 같은 명령을 성공시켜도 Windows 진단 통과가 되지 않습니다.

앱을 실행해 **개인 실행 환경**에서 같은 Python 프로젝트·실행 파일과 Codex·Tesseract·언어 데이터 경로를 선택하고 진단·저장 후 재시작합니다. 준비된 서버에 연결하여 문서 조회, 공개 시험 자료의 변환, 허용된 AI 실행과 취소, 저장 결과 재조회를 확인합니다. 앱을 완전히 종료하고 다시 열어 연결·설정·확정 저장된 작업의 복구를 확인합니다. 이 마지막 앱·서버 확인은 실제 Windows PC에서 수행해야 합니다.

## 종료 후 복구

미저장 결과 초안·질문·변환·추출안과 요청 식별자는 OS 보호 저장을 사용합니다. 같은 서버·사용자·tenant·관점·정책을 현재 서버에서 다시 확인한 뒤에만 복구 자료를 읽습니다. 복원은 조회이며 AI 자동 실행·POST 자동 재전송·CAS 교체를 하지 않습니다. 보호 저장 실패·손상·경쟁은 현재 입력과 기존 파일을 보존하며 오류를 표시합니다. 완료 안내를 받은 보호 저장만 급작스러운 종료 후 복구를 보장하며, 저장 중의 최신 타이핑은 마지막 확정 내용까지만 남을 수 있습니다. 남은 잠금은 자동으로 제거하지 않고 읽기는 마지막 저장본을, 쓰기는 잠금 오류를 반환합니다.

앱 종료는 복구 자료를 지우지 않습니다. 작업 공간을 선택한 상태의 명시 연결 해제는 현재 서버·사용자의 복구 자료를 먼저 지우고 인증정보를 삭제합니다. 현재 인증 범위를 확인할 수 없으면 삭제 실패를 표시합니다. 선택 없는 연결 해제와 `저장된 연결 삭제`는 암호화된 복구 자료를 보존합니다. 다른 계정의 자료를 지우거나 열지 않습니다.

## 실제 모델 통합 검사

공개 원문을 명시한 경우에만 별도 live 검사를 실행합니다. 로그인된 개인 CLI를 호출하므로 일반 회귀의 합성 모델 검사와 구분합니다. 모든 쓰기는 격리 서버·임시 정책·자료에 수행하며 검토 버튼 동작은 자동화 시험이고 사람의 의미 승인이 아닙니다.

```sh
WIKI_LIVE_SOURCE="/absolute/path/to/public-source.txt" npx playwright test --config config/playwright.live.config.ts
WIKI_PACKAGE_EXECUTABLE="/absolute/path/to/LLM Wiki.app/Contents/MacOS/LLM Wiki" node tests/packaging/smoke.mjs
```

패키지 검사는 기본적으로 이 Mac의 기존 Python·Codex·Tesseract 경로를 사용하는 개발 검증입니다. 다른 PC에서는 `WIKI_PACKAGE_RUNTIME_ROOT`, `WIKI_PACKAGE_PYTHON`, `WIKI_PACKAGE_CODEX`, `WIKI_PACKAGE_TESSERACT`, `WIKI_PACKAGE_TESSDATA`에 설치된 실제 경로를 지정합니다. `WIKI_PACKAGE_PREVIOUS_EXECUTABLE`에 이전 앱 실행 파일을 지정하면 이전 앱에서 설정을 저장하고 완전히 종료한 뒤 같은 임시 프로필을 새 앱으로 열어 교체 후 설정 보존을 확인합니다. 두 실행 파일 모두 시험 PC의 OS·CPU에 맞아야 합니다. 새 PC의 설치나 Gatekeeper/Windows 설치 확인 화면을 대신하는 시험은 아닙니다. live 검사에는 완료한 구간만 milestones로 기록하며 모델·별도 검사·인용 저장 실패를 전체 동선 성공으로 처리하지 않습니다.

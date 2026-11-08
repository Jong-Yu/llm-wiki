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

이 컴퓨터에서 확인한 Node 24는 다음 위치에 있으며, 기본 `node --version`이 24 미만이면 Node 24를 선택한 뒤 위 명령을 실행합니다. 다른 PC에서는 자체 설치한 Node 24를 사용합니다.

```sh
export PATH="/Users/jong-yu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
node --version
```

빌드 결과를 실행하려면 다음을 사용합니다. `build`는 타입·코드 경계·포맷·토큰 검사를 먼저 수행합니다. 설치용 앱 패키지를 만드는 명령은 아닙니다.

```sh
npm run build
npm start
```

## 브라우저에서 화면 테스트

Electron을 열지 않고 같은 React 화면과 서버 처리 코드를 실행할 수 있습니다. Node.js 24 이상에서 다음 명령을 사용합니다.

```sh
npm run test:web -- https://전달받은-서버-주소
```

표시된 `http://127.0.0.1:4173`을 브라우저에서 열고 이름과 같은 서버 주소로 로그인합니다. `WIKI_WEB_TEST_PORT`로 다른 로컬 포트를 선택할 수 있습니다. `WIKI_WEB_SERVER_URL` 환경변수로 서버 주소를 전달해도 됩니다. 원격 서버의 실제 계정·자료를 사용하므로 문서 저장·등록은 실제 반영됩니다.

**파일 선택**으로 20 MiB 이내의 MD·TXT·PDF·XLSX·DOCX·이미지를 등록하거나 텍스트를 붙여넣을 수 있습니다. 선택한 파일은 메모리에서 검사하고 등록 버튼을 눌러야 실제 서버에 보관합니다. 원본 상세의 **원본 내려받기**는 고정 판본·크기·SHA-256을 확인한 파일을 브라우저 다운로드로 전달합니다. AI 결과의 **Markdown 내려받기**는 현재 편집 본문을 UTF-8 파일로 내보내며 서버 저장·승인 상태를 바꾸지 않습니다. 브라우저의 저장 위치·파일명 정책을 따르며 화면은 내려받기 시작과 디스크 저장 완료를 구별합니다.

화면은 같은 업무 서비스·입력/응답 검사·권한·판본 충돌 처리를 사용합니다. 테스트 서버는 127.0.0.1에만 열리고 지정한 원격 서버에만 연결하며, 브라우저에는 인증 토큰을 반환하지 않습니다. 로그인과 임시 복구 자료는 테스트 서버 메모리에만 유지합니다. 브라우저 새로고침은 같은 세션을 유지하지만 테스트 서버 종료 후에는 다시 로그인해야 합니다. 서버에 확정 저장된 원본·위키는 유지됩니다. 여러 탭은 같은 계정과 연결 상태를 공유하므로 로그인·로그아웃 후 다른 탭도 새로고침합니다.

AI 제공자와 실행 경로는 시작 전에 `WIKI_AI_PROVIDER=codex` 또는 `claude`, `WIKI_CLIENT_ROOT`, `WIKI_PYTHON`, `WIKI_ANALYSIS_CODEX_CLI`, `WIKI_CLAUDE_CLI` 등 기존 실행 환경변수로 정합니다. 기본값은 Codex이며 이 프로젝트와 `.venv`를 탐색합니다. 웹 설정 화면의 진단은 실제 실행 환경을 검사합니다. 프로그램 경로 선택·CLI 로그인 터미널 열기, 설정 저장/재시작 적용과 OS 보호 저장은 웹 테스트에서 미지원으로 안내합니다. 실제 AI·분석은 서버 규약과 해당 CLI 로그인이 준비된 경우에만 실행됩니다.

`Ctrl+C`로 종료하면 이번 실행의 임시 빌드와 실행 디렉터리를 정리합니다. 웹 번들은 임시 폴더에 생성되며 Electron의 `out/`과 설치 패키지에 포함하지 않습니다. 코드 변경 후에는 서버를 다시 시작합니다. 격리 API·HTTP 요청 경계·임시 복구 검증은 `npm run test:web:verify`, 전체 정적 검사는 `npm run check`를 사용합니다.

## 서버 연결

앱의 로그인 화면에서 **이름과 서버 주소**를 입력해 가입하거나 로그인합니다. 한 서버 주소에서 `/api/v1`과 `/mcp`를 파생하며, 가입·로그인 응답으로 기본 **SDV 플랫폼** 공간과 관점을 자동 선택합니다. 원격은 HTTPS, 같은 PC의 loopback 서버만 HTTP를 허용합니다. reverse proxy prefix도 유지합니다.

토큰은 main에서만 수신하고 OS 보호 저장으로 재시작 로그인을 유지합니다. 보호 저장 실패는 현재 로그인 성공과 구별해 설정에 표시합니다. 로그아웃은 오프라인에서도 메모리 토큰과 자동 복원을 해제하며 이름·서버 주소만 기억합니다. 서버의 사용자 토큰을 회수하거나 재발급하지 않습니다. 개인 AI CLI 로그인은 앱 계정과 별도이며 설정 화면에서 연결합니다.

## 산출물 Markdown 저장

AI 결과의 **Markdown 내려받기**는 현재 편집 본문을 UTF-8 파일로 저장합니다. Electron에서는 저장 창에서 새 이름·위치를 선택하며 기존 파일을 덮어쓰지 않습니다. 취소나 파일 쓰기 실패에도 편집 본문을 유지하고 서버 저장·승인 상태는 바꾸지 않습니다. 저장 창을 기다리는 동안 연결 범위가 바뀌면 저장을 중단합니다.

## 문서 목록

작업 공간 선택 후 왼쪽 **문서**로 이동합니다. 선택한 서버·사용자·작업 공간·관점에서 실제 목록 API를 읽고, 20개씩 이전/다음 페이지를 조회합니다. 현재 페이지에서 제목·경로·위키 폴더·자료 종류를 좁혀 찾을 수 있으며 서버 전체 검색은 아닙니다. 자료 선택 시 실제 목록 메타데이터를 표시하고 상세 열기로 해당 문서·원본 페이지에 진입합니다. 목록 복귀 시 검색·필터·페이지·선택을 유지하며 현재 목록을 다시 조회합니다.

Wiki 상세는 본문·원본·이력·AI 작업 탭을 주소에 반영합니다. 표·체크리스트·코드를 지원하며 링크/이미지는 설명과 주소로 표시합니다. 다른 화면에서 돌아오면 깨끗한 읽기 상태의 최신 본문을 조회하고, 작성 중인 입력·비교·충돌·저장 미확인 상태는 보존합니다. 빈 본문·읽기 실패·변경된 판본을 구분합니다. **이력**에서 전체 파일을 비교하고 **이 판본으로 복원**을 누르면 현재 본문을 이력에 남긴 뒤 선택한 판본을 저장합니다. 미저장 초안이 있으면 복원을 막고, 충돌·완료 미확인 시 **현재 본문 다시 확인**으로 재조회한 뒤 비교합니다. 복원은 과거 관계나 검토 승인을 되살리지 않습니다.

등록 원본은 별도 상세 페이지에서 판본별 미리보기·내려받기와 파생 Wiki·작업 링크를 제공합니다. 실제 파일 API에서 선택한 판본의 크기·SHA-256을 확인합니다. 지원 형식은 MD/TXT/PDF/XLSX/DOCX와 PNG/JPG/JPEG/GIF/WebP/BMP/TIF/TIFF이며 최대20MiB입니다. Markdown은 서식으로, 텍스트와1MiB 초과 Markdown은 원문 텍스트로 표시합니다. 바이너리 원본은 원본 파일과 변환 보고를 분리해 열람합니다. 없는 과거 판본을 최신 판본으로 대신 열지 않습니다. 원본 조회는 분석을 시작하지 않습니다.

## 검토함

왼쪽 **검토함**에서 현재 작업 공간의 미검토·보류·재검토 항목을 조회합니다. 주장 검토, 이전 판단 기록, 추출 기준 변경을 구별해 기존 상세 화면으로 연결합니다. 확인한 대상 수, 불러온 수, 추가 페이지와 누락을 각각 표시하며 목록 기준이 바뀌면 새로고침합니다. **AI 세션 · 작업 관리**에서 기존 실행·작업을 확인할 수 있습니다. 검토함 조회는 승인·재추출·분석을 시작하지 않습니다.

## 원본 등록

**문서 등록**에서 제목과 Markdown 저장 경로를 정하고 파일 또는 텍스트를 제출합니다. 원본은 불변 판본으로 보관하며, 텍스트는 그대로 유지하고 바이너리는 기존 변환 보고를 연결합니다. 기본 흐름은 별도 분석 계획이나 파생 TXT 원본을 만들지 않고 한 개의 편집 Markdown과 관계 추출 작업을 준비합니다. `source_write`, `write`, `ontology_write` 권한이 필요합니다.

원본 등록 성공과 변환·분석 접수 성공을 구별합니다. 미독·변환 경고와 최초 MD 판본을 표시하며, 접수 결과가 불명확하면 같은 요청의 영수증을 확인합니다. 본문 편집은 title/tags/description과 본문을 분리하고 서버 소유 ID·원본 연결은 읽기 전용으로 유지합니다. 전체 파일 CAS와 이전 전체 파일 이력을 보존합니다.

## 개인 AI 분석·결과

등록 작업이 준비되면 선택한 개인 CLI로 실행합니다. 기본 변환은 전체 읽힌 내용을 보존하고 해당 MD 판본에서 관계를 추출합니다. 공통 규약이 서버에 게시되어 있어야 하며 실제 저장 여부는 단계별 서버 영수증으로 확인합니다. Markdown 저장 후 관계 추출이 실패하면 저장된 Markdown을 유지하고 미완료 단계만 재개합니다.

Electron main이 개인 실행 환경에 지정한 Python의 기존 개인 AI 어댑터를 실행합니다. 이 PC에 로그인된 Codex 또는 Claude Code CLI가 필요합니다. 개인 Python 실행 환경은 앱 패키지와 별도로 설치합니다. 저장된 공통 설정이 없으면 앱 시작 전에 `WIKI_ANALYSIS_CODEX_CLI`·`WIKI_QUESTION_CODEX_CLI`·`WIKI_PROPOSAL_CODEX_CLI`로 각 실행기 경로를 지정할 수 있습니다. `WIKI_AI_PROVIDER=claude`와 `WIKI_CLAUDE_CLI`로 Claude Code를 선택할 수 있으며 제공자를 생략하면 Codex를 사용합니다. 개인 CLI의 계정 설정은 변경하지 않으며 서버 연결은 현재 앱 로그인의 주소·토큰을 사용합니다. Python 어댑터의 준비 조건과 제한은 [프로젝트 실행 안내](../README.md#개인-ai-실행-어댑터)를 따릅니다.

화면은 로컬 실행과 서버의 실제 저장 영수증을 따로 표시합니다. 문서 상세의 **AI 작업**, 헤더의 **AI 세션**, 분석 작업 상세에서 준비·진행·결과를 확인합니다. 여러 질문·분석·재추출·대조를 독립 실행하며 목록에서 선택한 작업만 중단할 수 있습니다. 기존 작업 선택은 실행을 다시 시작하지 않고, 진행 중인 채팅에서 다른 대화나 새 대화로 이동해도 실행과 각 초안을 유지합니다. 저장 결과가 미확인이면 같은 요청을 확인하고 자동 재실행하지 않습니다.

채팅 입력창의 **＋ 옆 지구본**을 누르고 **외부 검색어**를 적용하면 그 공개 검색어만 별도 개인 AI 검색에 보냅니다. 적용 뒤 지구본 옆의 **웹** 표시로 선택 상태를 확인합니다. 기본은 해제이며 질문 접수 뒤 다시 해제됩니다. 웹 자료의 제목·확인 시각·보관 인용과 출처 링크는 해당 답변의 근거에서 확인합니다. 조회 실패·일부 자료만 확인한 상태도 남기며, 위키 문서나 전문가 판단으로 자동 등록하지 않습니다. 이 기능에는 같은 버전의 앱·개인 실행기·서버가 필요합니다. [웹 근거 계약](../docs/domains/knowledge/DECISIONS.md#d-099--질문별-외부-웹-근거-선택과-출처-보존-2026-11-05)을 참고합니다.

헤더의 녹색 상태등은 현재 기기의 실행을, 한도 막대는 로그인한 개인 CLI 계정 전체의 실제 잔여량을 표시합니다. Codex 한도를 읽을 수 있으면 설정의 **AI 실행 → 계정 사용량**에서 기간·사용률·초기화 시각을 확인합니다. Claude 한도 미제공·조회 실패·이전 조회를 구분하며 미확인 값을 0%로 표시하지 않습니다. 창 닫기는 실행을 유지한 채 창을 숨깁니다. 메뉴나 단축키로 앱을 명시 종료하면 진행 중 작업의 중단을 확인하고, 연결 범위 변경 시에도 해당 로컬 실행을 정리합니다.

추출 뒤 **기존 지식 대조**에서 관련 후보·제외 이유·실제 검색 근거·미확인 범위와 최신/이전 실행을 확인합니다. 문서·근거가 달라지면 재확인 필요를 표시합니다. **최신 자료로 검색·대조 다시 실행**은 추출을 반복하지 않고 원래 AI 세션에서 새 대조를 시작하며 이전 결과를 보존합니다. 조회는 실행당 최대 5회이며 후보를 확정 관계나 전문가 승인으로 취급하지 않습니다. 중단되거나 실패한 결과·이미 저장한 본문과 관계는 남습니다.

## 검사

```sh
npm run check
```

타입 검사, import 경계·코드 검사, 포맷 검사, 디자인 토큰 정합성을 확인합니다. `npm run build`도 같은 검사를 먼저 수행합니다. 이전 테스트는 정리 상태를 유지합니다. 이번 로그인·등록 계약 검증은 제품 빌드 후 `node tests/poc-ui/run.mjs`로 실행합니다. 프로젝트 `.venv`와 실제 OS 보호 저장이 필요하며 새 임시 서버·Electron 사용자 폴더만 사용하고 종료 후 정리합니다. 실제 AI 모델은 호출하지 않습니다.

온톨로지 관계 생성·검토는 `node tests/ontology-review/run.mjs`, Clean Up의 미리보기·선택 적용·변경 이력·되돌림은 `node tests/ontology-cleanup/run.mjs`로 확인합니다. 제품 빌드 후 실행하며 새 임시 서버의 합성 자료와 시험 계정만 사용합니다. 경로 검사 후 해당 임시 정책에 한해 읽기 전용 권한도 검증합니다. 운영 자료·설정과 AI 모델을 사용하지 않습니다.

화면 이동·초안·원본 판본·로그아웃은 제품 빌드 후 `node tests/navigation/run.mjs`, 문서 편집·비교·이력은 `node tests/document-comparison/run.mjs`로 실제 HTTP·Electron 경로를 검증합니다. 채팅의 주소·입력·근거·스크롤은 `node tests/chat-navigation/run.mjs`, 세션 목록의 상태·페이지·권한은 `node tests/ai-sessions/run.mjs`와 `node tests/ai-sessions/run-ui.mjs`, 분석 작업의 명시 실행·인라인 취소·권한 경계는 `node tests/job-navigation/run.mjs`로 확인합니다. 뒤의 채팅·세션·작업 검사는 실제 React 화면과 격리 fixture를 쓰며 실제 AI 모델을 호출하지 않습니다.

접근성 검사는 위의 문서·이동·온톨로지 검토/정리·채팅·세션 UI·작업 시험과 `node tests/review-workspace/run.mjs`, `node tests/diagnostic-review/run.mjs`에 선택적으로 추가할 수 있습니다. Node 24와 제품 빌드가 필요합니다. 예를 들어 다음 명령은 문서 흐름에서 axe-core의 WCAG 2.2 A/AA 자동 검사와 지정된 화면의 사용자 글자 간격·200% 페이지 확대를 함께 확인합니다.

```sh
WIKI_A11Y=1 WIKI_A11Y_REPORT_DIR=/private/tmp/wiki-a11y-check/document \
  node tests/document-comparison/run.mjs
```

보고서 경로는 `/private/tmp/wiki-a11y-`로 시작하는 검사 전용 폴더를 사용합니다. 화면별 JSON과 간격·확대 캡처를 남기며, 위반·페이지 가로 넘침·숨은 요소의 초점이 있으면 실패합니다. `incomplete`와 `clippedControls`는 수동 검토 후보이므로 0건의 자동 위반을 전체 적합성으로 간주하지 않습니다. 실제 키보드 순서·초점 가시성·축소된 패널의 행동 접근과 화면 읽기 프로그램 발표를 따로 확인해야 합니다. 초기 진단에서만 `WIKI_A11Y_REPORT_ONLY=1`로 실패를 모아 볼 수 있으며 완료 검증에서는 이 옵션을 제외합니다. [검수 범위와 결과](../docs/domains/ui/HISTORY.md#2026-10-31--접근성-검수와-실제-결함-보완)를 참고합니다.

다중 실행·개별 중단·연결 변경·창 숨김/종료는 `node tests/session-runtime/run.mjs`, 헤더 한도·대조 결과·이동은 `node tests/session-continuity/run.mjs`, 대조 재실행의 실제 HTTP/프로세스·판본 충돌·저장 응답 유실 복구는 `node tests/knowledge-comparisons/run.mjs`로 확인합니다. 임시 자료와 모의 AI 실행기를 사용합니다. 실제 Codex 계정 한도 읽기는 `node tests/session-runtime/run.mjs --live-usage`로 별도 확인하며 모델 호출과 구별합니다.

웹 조사 프로세스의 입력·출처/지문 검사·중단·정리는 `node tests/session-runtime/run.mjs --web-search`, 웹 선택·실패·인용·후속 질문은 제품 빌드 뒤 `npx playwright test -c config/playwright.config.ts web-search.spec.ts`로 검사합니다. 이 검사들도 임시 자료·모의 조회/AI를 사용하며 실제 계정의 웹 검색 성공을 대신하지 않습니다.

## 구조와 경계

현재 화면 시작점은 `src/renderer/main.tsx` → `app/App.tsx` → `app/AppShell.tsx`입니다. `pages/`의 문서·원본·온톨로지·채팅·산출물·분석·세션·설정을 연결하며 실제 주소와 화면 책임은 [IA](../docs/domains/ui/INFORMATION_ARCHITECTURE.md)를 따릅니다. 문서 간 관계는 별도 요청으로 메뉴를 숨기고 기존 주소를 문서로 연결하되 구현·데이터는 보존합니다. 예전 `/renewal/...` 주소는 query·fragment를 유지하며 새 주소로 연결합니다.

`src/main/`은 창·CLI 수명과 서버 통신을, `src/preload/`는 제한된 IPC를, `src/renderer/`는 화면을 담당합니다. `src/shared/contracts/`는 공통 IPC 계약입니다. 서버 업무 구현은 프로젝트의 `core/`에 있습니다.

실행·빌드·코드 검사 설정은 `config/`, 설치·토큰 생성 스크립트는 `scripts/`에 있습니다. `design/tokens.json`은 테마 값의 원본이며 생성된 `tokens.css`·`tokens.ts`는 직접 수정하지 않습니다. 현재 컴포넌트 계약은 [컴포넌트 설계](docs/component-architecture.md)를 따릅니다.

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

**연결 설정 → AI 실행**에서 Codex 또는 Claude Code를 선택하고 **실행 준비 확인**을 누릅니다. 같은 PC·OS 사용자로 CLI에 로그인했다면 기본 설치 위치의 실행 파일은 앱이 자동으로 찾으므로 경로를 직접 알 필요가 없습니다. Claude는 터미널/Windows PowerShell의 어느 폴더에서든 `claude auth login`으로 로그인합니다. **설치된 CLI 다시 찾기**는 설치 위치를 재검색하며, 검색 성공만으로 로그인 완료를 표시하지 않습니다. 자동 탐지가 안 되거나 다른 실행 파일을 쓸 때 **고급 설정 · 실행 환경 경로**에서 직접 선택합니다. 기존 **작업 공간 → 개인 실행 환경**에서도 시작·진단 시 자동 탐지가 적용됩니다. 진단은 기존 `tools.runtime_doctor`와 `tools.source_conversion_cli --diagnose --ocr-language kor+eng`를 실행하며 모델 호출·로그인·설치를 자동 시작하지 않습니다. 선택한 CLI의 로그인 정보 존재와 실제 모델 호출 가능성을 구별하며 OCR 실행 파일·언어 준비와 인식 정확도도 구별합니다.

설정 화면은 현재 실행 제공자와 다음 시작에 사용할 선택을 함께 표시합니다. 설정 저장은 다음 앱 시작에 적용되며 분석·질문·추출안에 공통으로 사용합니다. 기존 v1 설정은 Codex로 읽고 다음 명시 저장에서 v2로 전환합니다. 진행 중 실행에는 기존 설정을 유지합니다. 설정 충돌·파일 손상 때는 기존 파일을 보존합니다. 설치·고정 버전 업데이트 명령은 화면과 [프로젝트 실행 안내](../README.md)에 있습니다. 설치 앱의 업데이트 채널과 배포 명령은 아래 자동 업데이트 절을 따릅니다.

앱 시작과 진단에서 기본 명령 `codex`/`claude`에 한해 설치 위치를 탐지합니다. Claude는 사용자 홈의 `.local/bin`을 먼저 확인하고 절대 PATH 디렉터리, macOS Homebrew 또는 Windows 사용자 npm/WinGet 위치를 확인합니다. Windows의 native `claude.exe`도 PATH 등록 전부터 찾으며 Codex의 기존 Mac 번들 우선순위는 유지합니다. 파일·POSIX 실행 권한을 검사하고 빈/상대 PATH는 제외합니다. 직접 고른 경로는 자동으로 바꾸지 않으며 명시 재검색이 성공했을 때만 초안의 경로를 교체합니다. 재검색 실패 시 기존 경로를 유지하며 저장·다음 앱 시작 적용 규칙도 동일합니다.

기본 실행 설정은 `WIKI_CLIENT_ROOT`·`WIKI_PYTHON`이며 개발 실행에서는 프로젝트 `.venv`를 찾습니다. 이전 `WIKI_ANALYSIS_PROJECT_ROOT`·`WIKI_CLIENT_PYTHON`·`WIKI_ANALYSIS_PYTHON`도 시작 때 정규화합니다. 저장된 앱 설정이 있으면 그 설정을 사용합니다. 선택한 Tesseract 디렉터리는 실행 PATH에, 언어 데이터 폴더는 `TESSDATA_PREFIX`에 반영합니다. Windows x64 설치 파일은 개인 실행기·Python·필수 패키지·한국어/영어 OCR을 포함하고 처음 시작할 때 자동 선택합니다. Codex·Claude Code는 포함하지 않습니다. macOS/Linux 패키지는 기존 외부 실행 환경을 사용합니다.

## 설치 산출물과 서명

```sh
npm run package:dir           # 현재 OS용 실행 디렉터리
npm run package:mac:unsigned  # macOS arm64 DMG + ZIP (서명/공증 없음)
npm run package:win:unsigned  # 실행기/Python/OCR 포함 Windows x64 NSIS (서명 없음)
npm run package:runtime       # Python 개인 실행기 소스 ZIP + SHA256
npm run package               # 현재 OS: macOS DMG/ZIP, Windows NSIS, Linux tar.gz
```

`config/electron-builder.json`은 기본 미서명 구성입니다. 위 패키징 명령은 게시하지 않으며, 공개 배포는 아래 `npm run release`를 사용합니다. 개발 실행 파일은 먼저 `npm run electron:install`로 준비합니다. 패키징은 지정한 OS·CPU용 공식 Electron을 받아 사용하며 개발 PC의 Electron 폴더를 다른 OS용으로 재사용하지 않습니다. 최초 대상 빌드에는 Electron과 electron-builder 도구의 공식 배포 서버에 접근해야 합니다. 산출물은 `app/release/`에 둡니다. DMG의 앱을 Applications에 복사한 뒤 실행합니다. 미서명 앱의 Gatekeeper 허용은 사용자가 출처를 확인한 뒤 OS에서 결정합니다. 검증 과정에서 격리 속성이나 Gatekeeper를 자동 해제하지 않습니다. Windows는 NSIS 설치 파일을 실행해 현재 사용자 계정으로 설치하며, 앱 자료 삭제 옵션은 사용하지 않습니다.

Windows는 **설치 EXE 하나만 옮깁니다.** 설치 후 서버 주소·인증 정보를 설정하고 사용할 AI CLI를 직접 설치·로그인합니다. 개인 실행기 ZIP이나 시스템 Python·Tesseract 설치는 필요하지 않습니다. `resources/personal-runtime`에 앱 전용 Python 3.13.17, 고정 패키지 40개, Tesseract 5.5.3과 한국어·영어 데이터를 둡니다. 기존에 저장한 외부 실행 경로가 있으면 그 설정을 유지합니다. 기존 설정을 계속 사용하는 PC에는 포함된 실행 환경으로 자동 전환하지 않습니다.

`scripts/package-desktop.mjs`는 Windows 빌드마다 새 임시 폴더에서 실행기를 준비하고 asar 밖의 리소스로 포함합니다. `config/windows-runtime.lock.json`의 HTTPS URL·SHA256과 현재 `requirements.lock`을 대조하며 원문·위키·토큰·개인 설정을 포함하지 않습니다. Python·Tesseract·언어 데이터·wheel의 라이선스를 보존합니다. 최초 빌드는 해당 배포 서버에 접근해야 하며 검증된 캐시는 `release/windows-runtime-cache/`에 보관합니다. 빌드용 Python은 프로젝트 `.venv`, 시스템 Python 순서로 찾고 `WIKI_BUILD_PYTHON`으로 실행 파일을 지정할 수 있습니다. NSIS 추출을 지원하는 7-Zip은 electron-builder 도구를 사용하며 필요한 경우 `WIKI_BUILD_7ZIP`으로 지정합니다. 대상 PC에서 pip나 별도 설치 프로그램을 실행하지 않습니다. Python 배포 방식은 [공식 embeddable 안내](https://docs.python.org/3/using/windows.html#the-embeddable-package)를 따릅니다.

`llm-wiki-personal-runtime-0.1.0.zip`은 core/tools Python 소스, 규약 조립에 필요한 의미 지침 한 파일과 고정 requirements를 포함합니다. 압축을 풀고 `python3 -m tools.setup_runtime --role personal`을 실행한 뒤 앱에서 폴더와 `.venv` Python을 선택합니다. Windows는 `py -3.12 -m tools.setup_runtime --role personal`을 사용합니다. 원문·위키·히스토리·토큰·개인 설정·테스트·`.venv`는 포함하지 않습니다. 이 ZIP은 Python/OCR/계정의 설치 완료를 뜻하지 않습니다.

### 문서 내보내기

Word·PDF·Excel·PowerPoint 내보내기는 앱에 포함된 라이브러리(`markdown-it`, `docx`, `write-excel-file`, `pptxgenjs`)와 Electron의 PDF 인쇄로 만들며 외부 프로그램을 동봉하거나 설치할 필요가 없습니다. 의존성의 라이선스는 `package-lock.json`의 패키지 메타데이터 기준으로 MIT·BSD·ISC 등이며, `pptxgenjs`가 쓰는 `jszip`은 MIT 또는 GPL-3.0 이중 라이선스로 MIT를 선택합니다. 배포 전 사용자가 최종 확인합니다.

설치 파일과 다운로드 캐시는 정리했습니다. 필요한 경우 위 패키징 명령으로 현재 소스에서 다시 만듭니다. 새 차수는 Windows의 `npm run package:win:unsigned -- --output-dir release/<차수>`, macOS의 `--config.directories.output=release/<차수>`로 지정할 수 있습니다.

서명과 공증은 기존 Developer ID identity 및 기존 키체인 공증 profile을 준비한 환경에서만 실행합니다. `CSC_NAME`, `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`을 해당 환경에 지정하고 `npm run package:mac:signed`를 사용합니다. `config/electron-builder.signed.cjs`는 누락된 자격에서 중단하고 `forceCodeSigning`, hardened runtime, 공증을 활성화합니다. 산출물은 `release/signed/`이며 자동 게시하지 않습니다. 비밀번호·API 키를 코드나 문서에 넣지 않습니다.

현재 Mac에서 사용 가능한 코드 서명 identity는 0개이며 공증 환경도 제공되지 않았습니다. 실제 DMG·ZIP 생성/시작 결과는 UI 검증 기록 (정리로 삭제된 참고 자료)에 기록합니다. Windows NSIS 교차 빌드는 실제 Windows 설치·보호 저장·취소 통과를 뜻하지 않습니다. Windows의 개인 실행은 현재 PC의 보호 파일·프로세스 트리 진단에 성공해야 진행할 수 있으며, 별도의 실제 Windows 릴리스 검증은 아직 완료하지 않았습니다.

### 자동 업데이트와 릴리스

앱 배포 전용 저장소는 [Jong-Yu/llm-wiki-releases](https://github.com/Jong-Yu/llm-wiki-releases/releases)입니다. `config/electron-builder.json`의 `publish` 설정을 릴리스 사전 확인·게시와 설치 앱의 `app-update.yml`에서 함께 사용합니다. `tagNamePrefix: app-`를 사용하므로 앱0.1.0의 게시 태그는 `app-0.1.0`, 다음0.1.1은 `app-0.1.1`입니다. 소스 저장소의 릴리스를 앱 다운로드 채널로 사용하지 않습니다.

변경을 커밋한 뒤 `app/`에서 실행합니다. 현재 버전으로 게시할 때는 버전 인자를 생략합니다. 플랫폼을 지정하지 않으면 현재 OS만 빌드합니다.

```sh
npm run release -- --mac --win        # 현재 0.1.0: 양 플랫폼 빌드·게시
npm run release -- patch --mac --win  # 다음 패치 버전으로 올려 빌드·게시
```

명령은 앱 검사·빌드 후 릴리스 초안을 한 번 만들고 설치 파일과 `latest.yml`·`latest-mac.yml`·블록맵을 올립니다. Mac을 포함하면 기존 개인 실행기 포장 명령으로 같은 버전의 ZIP·SHA256도 준비해 공개 전에 첨부합니다. 지정한 플랫폼이 모두 성공해야 최신 정식 릴리스로 공개하며, 실패한 초안은 보존합니다. 배포 저장소에는 README 등 초기 커밋이 있어야 합니다. 인증은 `GH_TOKEN`, 저장소 루트의 무시된 `.github_token`, 기존 `gh` 로그인 순으로 사용하며 게시 대상의 쓰기 권한이 필요합니다. 이미 존재하는 같은 버전의 릴리스에는 다시 게시하지 않습니다. `--dry-run`은 빌드하되 업로드하지 않습니다.

설치 앱은 시작할 때와 4시간마다 더 높은 버전을 확인해 자동으로 내려받고 재시작 설치를 안내합니다. `0.1.0`에서 같은 `0.1.0`은 업데이트로 인식하지 않습니다. 이전 주소를 내장한 설치본은 올바른 채널을 내장한 설치 파일로 한 번 수동 교체합니다. macOS 자동 설치에는 서명된 앱이 필요하며 현재 미서명 배포에서는 수동 설치를 사용합니다. 서명·공증 환경은 위 서명 절을 따릅니다. 실제 Windows의 업데이트 설치 성공은 별도 실기기 검증 대상입니다.

### 수동 업데이트

진행 중인 AI/변환 작업의 완료 또는 취소 상태를 확인하고 앱을 종료합니다. macOS는 새 DMG의 앱으로 Applications의 기존 앱을 교체하고, Windows는 같은 사용자 계정에서 새 NSIS 설치 파일을 실행합니다. 앱의 사용자 자료 폴더와 서버 자료 폴더는 지우지 않습니다. 앱의 설치 위치와 원본·위키를 저장하는 서버 위치는 서로 다릅니다.

Windows의 포함된 실행기는 새 설치 EXE로 앱과 함께 갱신합니다. 외부 실행 환경을 사용하는 macOS/Linux 또는 기존 Windows 설정에서는 Python 실행기 ZIP도 같은 배포 차수의 파일을 사용합니다. 새 ZIP을 별도 폴더에 풀고 그 폴더에서 `tools.setup_runtime --role personal`을 실행한 뒤, 앱의 개인 실행 환경에서 새 폴더와 해당 `.venv` Python을 선택·진단·저장하고 앱을 재시작합니다. 이미 같은 소스 폴더를 갱신한 경우에만 `--upgrade`로 고정 의존성을 갱신합니다. `--upgrade` 자체가 새 Python 소스나 앱을 내려받지는 않습니다.

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

앱 종료는 복구 자료를 지우지 않습니다. 명시 로그아웃은 네트워크 없이 활성 인증과 자동 복원을 먼저 해제한 뒤 현재 서버·사용자의 복구 자료를 정리합니다. 정리 실패는 로그아웃 완료와 별도 경고로 표시합니다. 다른 계정의 자료는 열거나 지우지 않습니다. 보호 저장 파일 삭제가 실패해도 자동 복원 차단 기록이 있으면 재로그인 전에는 열지 않습니다. 저장소 오류로 차단 기록과 인증 파일 삭제가 모두 실패하면 다음 시작 차단 여부를 확인할 수 없다고 표시합니다.

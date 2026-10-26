# React 프로젝트 구조·개발 규칙과 컴포넌트 설계

기준: 현재 1920×1080 시안, 사용자 지정 Electron·React·React Router·Jotai·TypeScript. 목적은 **LLM Wiki의 원문 → AI 온톨로지 → 전문가 조정 → 재사용**을 같은 대상/근거로 잇는 것입니다. 이 문서의 업무 컴포넌트·경로·타입은 구현용 설계입니다. 2026-10-25에 실행 골격·시작/앱 정보 화면만 구현했으며 현행 파일과 명령은 [앱 README](../README.md), 실제 검증은 [PLAN](../../docs/history/2026-10-25-before-domain-split/PLAN.md#d-045-electron-실행-골격-2026-10-25)이 관리합니다.

## 1. 분리 기준과 데이터 흐름

컴포넌트 경계는 CSS 상자 수가 아니라 **업무 책임·독립된 상태 수명·재사용 필요**로 정합니다. 화면은 기능 컴포넌트를 합성하고, 기능 컴포넌트는 조회/명령 hook과 표시/입력 UI를 연결합니다. leaf UI는 props를 표시하고 사용자의 의도를 callback으로 올립니다. 원문 조회·검토 저장·PTY 실행을 같은 `Workspace.tsx`에서 처리하지 않습니다.

```text
일반 API 응답 → main HTTP client → bridge → adapter/검사 → Query → 기능 container → UI
UI 조회/등록 의도 → 기능 query/command hook → 제한된 bridge → main HTTP client → 일반 API
AI 분석 의도 → main의 개인 CLI 터미널 → CLI의 MCP 연결 → 같은 백엔드의 저장 서비스
                                      ↓
                         결과 조회/캐시 갱신, 초안은 별도 보존
```

- `AppShell`은 위치·탐색·패널 영역만 맡습니다. `Page`는 기능 조합과 화면 간 이동만 맡습니다. 원문/그래프를 파싱하거나 저장하지 않습니다.
- `useDocumentQuery`, `useClaimReview`, `useIntakeJob`처럼 **특정 기능과 수명**을 가진 hook을 둡니다. 전체 화면을 지배하는 `useWikiApp`이나 단일 거대 atom은 만들지 않습니다.
- 공통 UI에는 임의 `variant`/boolean을 계속 늘리는 만능 카드 대신 작은 `Panel`, `PanelHeader`, `PanelBody`, `PanelActions`를 합성합니다. 근거·정책·실패를 하나의 거대한 `CardRenderer`에 넣지 않습니다.
- 파생 목록·건수·선택 객체·표시 그래프는 원본과 선택 ID에서 계산합니다. props를 Effect로 state에 복사하지 않습니다. 사용자가 편집을 시작할 때만 기준 snapshot과 초안을 만듭니다.
- React의 선언적 이벤트와 안정된 ID `key`를 사용합니다. `innerHTML`, 전역 `data-action` 분기, DOM 조회로 UI 상태 복구, 기존 시안의 전역 `state`는 이관하지 않습니다. 원문 HTML을 그대로 실행하는 통로도 만들지 않습니다.
- Effect는 xterm/ResizeObserver/worker/구독 같은 외부 시스템 연결에 한정하고 cleanup을 짝으로 둡니다. 필터·카운트·상태 판정은 순수 함수입니다. `memo/useMemo`는 측정한 비용이 있을 때 적용하며 단일 책임의 대체물이 아닙니다.

이 기준은 [React의 Thinking in React](https://react.dev/learn/thinking-in-react), [중복·모순 상태를 피하는 구조](https://react.dev/learn/choosing-the-state-structure)를 적용한 것입니다. 새 상태 라이브러리나 UI 프레임워크를 추가하는 결정은 아닙니다.

## 2. 구현 위치와 의존 방향

사용자가 검토한 초안을 기준으로 **domains는 업무 모델·공통 규칙·재사용 표현을, features는 사용자가 입력부터 결과 확인까지 수행하는 한 흐름을 소유**합니다. 특정 아키텍처의 계층 목록을 의무로 적용하지 않으며 실제 책임·상태 수명·참조 방향으로 경계를 지킵니다. 아래는 **전체 목표 배치도**이며 예정 표시는 원래 설계 기준입니다. 현재 실행 골격에 있는 부분은 앱 README에서 확인하고 업무 제품 파일·빈 폴더는 미리 만들지 않습니다.

```text
app/
  package.json                      # 앱 의존성·개발/빌드 명령의 단위
  config/                           # 빌드·테스트·Oxc 설정
    electron.vite.config.ts          # main/preload/renderer 빌드 조립
    playwright.config.ts            # 실제 Electron 검사
    oxlint.config.ts, oxfmt.json     # 린트·포맷
    import-boundaries.mjs            # 앱 참조 방향의 Oxlint 규칙
    typescript/tsconfig.*.json       # main/preload/renderer/도구 분리 검사
  design/tokens.json                 # 값의 단일 원본 (존재)
  scripts/build-design-tokens.mjs    # 생성/검사 (존재)
  docs/                             # 이 문서와 토큰 사용 규칙 (존재)
  src/
    main/                           # 예정: 창·PTY·인증 보관·파일·일반 HTTP API client
    preload/                        # 예정: 한정된 wiki bridge
    shared/contracts/               # 예정: 직렬화 가능한 IPC 요청/응답, 타입/검사
    renderer/
      index.html, main.tsx           # 예정: HTML·React 시작점
      app/                          # 예정: providers, router, shell
      pages/                        # 예정: 화면 단위 합성
      features/                     # 예정: 입력부터 결과까지의 사용자 작업
        search-documents-by-text/
        read-wiki-document/
        edit-wiki-document/
        explore-concept-connections/
        review-source-claim/
        record-expert-policy/
        register-source/
        run-source-analysis/
        compare-extractions/
        view-document-history/
        connect-workspace/
        start-cli-session/
      domains/                      # 예정: 업무 모델과 공통 표현의 소유자
        documents/ knowledge/ review/
        sources/ analysis/ access/
      platform/                     # 예정: preload bridge adapter
      shared/
        ui/                         # 예정: 업무 중립 UI
        theme/tokens.css, tokens.ts  # 생성된 디자인 값 (존재)
        lib/                        # 예정: 책임이 명확한 업무 중립 기술 함수
  tests/
    e2e/                            # 예정: 실제 Electron 흐름 *.spec.ts
    fixtures/                       # 예정: 앱 검증에서 실제 필요한 고정 입력만
```

```text
화면·업무: app → pages → features → domains → renderer/shared
외부 연결:                  features → platform → src/shared/contracts
```

feature끼리 직접 import하지 않고 공개 export도 이 제한을 우회하지 않습니다. domain은 feature/page를 import하지 않으며 다른 domain의 실행 코드·상태·UI도 직접 호출하지 않습니다. 여러 domain의 조합은 feature가, 여러 feature의 순서 연결은 page가 맡습니다. domain 사이의 식별/판본 참조는 공통 contracts를 사용하고 소유권은 2.5절을 따릅니다. `shared/ui/theme/lib`는 domain·feature·tenant 업무를 모르며 업무에 특화된 근거·주장·판본 UI는 해당 domain에 둡니다.

`renderer`는 `node:fs`, `node-pty`, 인증 토큰, MCP 클라이언트를 직접 import하지 않습니다. 실제 bridge 접근은 platform만 맡고 feature의 조회/명령 adapter가 이를 소비합니다. 새 서버 계약은 [D-043](../../docs/domains/sources/DECISIONS.md#d-043--원격-문서-등록과-개인-cli-분석mcp-저장ui-결과-연결-2026-10-24)·[D-044](../../docs/domains/analysis/DECISIONS.md#d-044--mcp-공통-추출-규약맥락과-분석-입력-버전-관리-2026-10-24)가 담당하고 이 문서에서 다시 정의하지 않습니다.

### 2.1 앱 단위와 Electron 책임

`app/`을 하나의 앱 패키지로 관리합니다. React 의존성·lockfile·빌드/검사 설정은 이 위치에 두고 Python 백엔드의 `core/`와 분리합니다. 초기에는 별도 workspace 패키지나 배포 단위로 쪼개지 않습니다. `renderer/` 안에 `src/`를 한 겹 더 만들지 않고 기존 토큰 경로를 유지합니다. [electron-vite의 공식 구조](https://electron-vite.org/guide/dev#project-structure)는 main/preload/renderer 진입을 지원하며, 위 배치에 맞춘 실제 설정은 골격 구현에서 확인합니다.

| 위치 | 책임과 필요한 경우의 하위 분리 |
| --- | --- |
| `main/index.ts` | 앱 시작/종료와 의존성 조립. 실제 처리는 담당 모듈에 위임 |
| `main/windows/` | 창 생성·탐색/닫기·화면 수명 |
| `main/ipc/` | 허용 채널 등록·호출자/입력 확인·결과 직렬화 |
| `main/backend/` | 일반 HTTP 클라이언트·서버 응답 검사·전송 오류/필드 변환 |
| `main/terminal/` | PTY 세션 생성·입출력·크기·종료와 출력 복구 |
| `main/settings/` | 연결 설정·보호된 자격 증명 접근. 구체 저장/CLI 적용은 D-047 계약 확정 후 구현 |
| `preload/index.ts` | `contextBridge`로 명시한 작업과 구독만 노출. 업무 처리나 HTTP·PTY 수명 관리 없음 |
| `shared/contracts/` | main/preload/renderer가 공유하는 IPC 입력·결과·이벤트와 실행 시 검사. React·Electron·Node 런타임에 의존하지 않음 |

renderer는 `main/`이나 `preload/`의 구현을 import하지 않습니다. `platform/`만 실제 `window.wiki`를 읽고 feature의 조회/명령 adapter는 platform의 제한된 gateway를 소비합니다. app의 provider는 이 adapter를 조립/주입할 수 있지만 page/domain/표시 UI가 직접 bridge를 호출하지 않습니다. `contextIsolation: true`, `nodeIntegration: false`, renderer sandbox를 골격 기준으로 두며 범용 `send/invoke`를 노출하지 않습니다. main에서 호출자와 작업별 입력을 확인합니다. 근거는 [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation#security-considerations)과 [IPC sender 검증](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages)입니다. 실행 골격에서 이 설정과 앱 정보 IPC를 구현했으며 실제 검사 결과는 PLAN을 따릅니다. 서버/PTY의 경계는 후속 구현 대상입니다.

### 2.2 feature 내부 구조와 공용화

`features/` 바로 아래에는 `edit-wiki-document`처럼 **동작과 대상을 드러내는 기능 이름**을 둡니다. 같은 API를 쓰더라도 이름 검색/사번 검색처럼 입력의 의미와 사용자 작업이 다르면 별도 feature로 이름 붙입니다. 여러 흐름을 하나의 `searchMode`나 만능 폼에 모아 서로의 상태/행동을 공유하지 않습니다. 입력 UI가 SelectBox인지 여부는 기능 경계를 정하는 기준이 아닙니다.

feature 내부는 처음부터 책임별 `ui/`, `model/`, `api/`로 구분합니다. 실제 구현 파일이 있는 폴더만 만들고 빈 계층은 추가하지 않습니다.

```text
features/edit-wiki-document/
  ui/
    EditWikiDocument.tsx            # 입력·진행·실패·결과 표시의 조합
    EditWikiDocument.module.scss    # 해당 UI의 스타일
    EditWikiDocument.test.tsx       # 해당 흐름에 필요한 행동/실패 검사
  model/
    useEditWikiDocument.ts          # 초안·기준·저장 흐름 조정
    editWikiDocument.schema.ts      # 폼 검증·스키마에서 추론한 값 타입
  api/
    editWikiDocument.mutations.ts   # gateway를 통한 명시 저장/결과 처리
  index.ts                         # 필요한 공개 항목만 named export
```

| 위치 | 담당 | 의존 규칙 |
| --- | --- | --- |
| `features/<feature>/ui/` | 입력·진행·실패·결과와 domain UI 조합 | 자기 흐름 hook과 domain/shared UI 사용. HTTP/bridge 직접 호출 없음 |
| `features/<feature>/model/` | 해당 작업의 초안·기준·조회/명령·순수 조정 | 자기 adapter와 domain 모델 사용. UI import 없음 |
| `features/<feature>/api/` | gateway 호출·조회 key/옵션·mutation·결과 변환 | platform/domain/contracts 사용. 자기 흐름 atom이나 UI import 없음 |
| `domains/<영역>/model/` | 해당 업무 모델·참조 해석·표시/초안용 순수 계산 | contracts/shared 기술 함수 사용. React/Query/Jotai·외부 I/O·다른 domain/feature import 없음 |
| `domains/<영역>/ui/` | 해당 모델의 재사용 표시·입력 부품 | 자기 domain 모델과 shared UI/theme 사용. 조회·저장·작업 상태 소유 없음 |
| `platform/` | 제한된 bridge를 감싼 플랫폼 adapter | contracts 사용. domain/feature 표시 모델 import 없음 |
| `shared/ui/`, `shared/theme/`, `shared/lib/` | 업무 중립 UI·디자인 값·범위가 분명한 기술 함수 | domain/feature/platform import 없음 |

feature 내부는 `UI → 흐름 hook → 조회/명령 adapter → platform`으로 참조합니다. 특정 작업만 쓰는 초안·변환은 feature에, 같은 업무 의미로 재사용할 모델/UI는 소유 domain에 둡니다. 폼 구성·결과 표시·흐름 조정의 일부 중복은 허용합니다. HTTP/IPC 계약·전송 오류 변환은 main/backend·contracts·platform의 단일 구현을 재사용하며 domain의 같은 규칙을 feature별로 복사하지 않습니다. 서버의 권한·정책 적용·CAS·저장 규칙을 프런트에 재구현하지 않습니다. `core/modules`와 폴더를 기계적으로 일대일 대응시키거나 빈 계층을 추가하지 않습니다.

feature/domain의 외부 진입은 필요할 때 해당 `index.ts`의 명시 named export로 제한합니다. 내부 파일은 자기 barrel을 거치지 않고 상대 경로를 사용합니다. domain UI에 다른 domain의 상태·근거 표시가 필요하면 feature가 props/slot/callback으로 조합합니다. 하나의 최신 모델을 여러 domain에서 다시 정의하거나 모든 타입을 전역 `types.ts`에 모으지 않습니다. `shared/lib`에도 기능 이름 없이 만능 utils를 쌓지 않습니다.

### 2.3 계약·타입·import 경계

서버 HTTP 계약, IPC 계약, domain 모델, 여러 domain을 조합한 작업 표시 모델을 구분합니다. main/backend는 실제 HTTP 응답을 검사하고 필요한 필드를 IPC 결과에 명시 매핑합니다. feature의 adapter는 소유 domain의 순수 변환을 사용해 모델을 얻고 자기 작업 표시 모델을 조합합니다. 서버의 `state_revision`을 앱의 `stateRevision`으로 옮길 때 누락/널·한정어·완전성·오류 코드·출처를 보존하며 일괄 키 변환으로 의미를 추정하지 않습니다. 표시 모델을 쓰기 payload로 되돌려 저장하지 않습니다.

IPC 값은 JSON으로 전달 가능한 명시 객체/배열/원시값을 기준으로 합니다. 함수·DOM·프로세스 핸들·클래스 인스턴스·인증 비밀을 결과에 넣지 않고, 오류도 명시 code/detail 결과로 변환합니다. 출력 구독의 해제 함수는 preload가 renderer에 제공하는 bridge 동작이며 IPC payload에 포함하는 함수가 아닙니다. HTTP 계약의 원본은 D-043과 실제 구현에서 생성할 OpenAPI이며, 아직 없는 API의 생성 타입·코드를 미리 만들지 않습니다.

TypeScript는 `strict`를 기본으로 하고 외부 입력은 `unknown`에서 검사합니다. 타입만 사용할 때 `import type`을 쓰며 `any`나 타입 단언으로 검사 실패를 숨기지 않습니다. renderer 타입 검사에는 Node 전역 타입을 열지 않고 main/preload와 설정을 분리합니다. 공통 계약에는 브라우저/Node 전용 타입을 넣지 않습니다.

같은 기능/모듈 안은 상대 import, 경계를 넘을 때는 `@renderer/*`와 `@contracts/*`를 사용합니다. renderer의 일반 기능 코드는 contracts를 직접 호출 통로로 삼지 않으며 platform/api가 경계를 맡습니다. `@main/*`는 main 내부에만 열고 preload는 별도 설정에서 자기 구현과 contracts만 읽습니다. 별칭은 경로 편의이며 접근 허가가 아닙니다. 실제 TypeScript·빌드·테스트의 alias 해석과 금지 import 검사는 골격에서 함께 구성합니다.

### 2.4 테스트 위치와 구현 점검

단위/컴포넌트 검사는 대상 옆의 `*.test.ts(x)`, 실제 Electron 실행 검사는 `app/tests/e2e/*.spec.ts`에 둡니다. 공통 fixture는 실제 검사에서 필요할 때만 `app/tests/fixtures/`에 추가하며 시안의 모의 결과를 제품 초기 데이터로 넣지 않습니다. Python 저장·권한 검사는 기존 `core/tests/`에 유지합니다.

골격은 TypeScript·Oxlint/React Hooks·Oxfmt·Playwright로 검사하고 lockfile로 버전을 고정합니다. 설정은 `config/`, 타입 검사 설정은 `config/typescript/`에 둡니다. 기존 권고의 Vitest/Testing Library는 해당 검사가 필요한 기능에서 추가합니다. 우선 검사는 타입·금지 import/순환·토큰 정합성, 이후 구현 기능의 사용자 행동·실패/충돌·구독 해제를 확인합니다. 스타일만 바꾸는 수정마다 구현을 그대로 복제한 테스트를 만들지 않습니다. 아직 없는 명령을 README의 실행 가능한 명령으로 적지 않으며 새 실행 결과는 PLAN에 기록합니다.

### 2.5 domain별 모델 소유권

이 표는 **renderer 업무 모델의 소유권**입니다. 타입 이름은 구현용 이름이며 서버의 스키마/권한·파일 위치를 바꾸지 않습니다. 각 domain은 자기 모델·표시/초안용 순수 규칙·재사용 UI를 소유하고 조회 캐시/편집 작업 상태는 feature가 6절의 상태 저장 수단을 사용해 관리합니다. 실제 서버 정책/판정·원장/CAS·버전 발급은 백엔드의 책임입니다.

| Domain | 소유 모델·의미와 재사용 UI 예 | 다른 소유자와의 경계 |
| --- | --- | --- |
| `documents` | `WikiDocument`, `WikiBody`, `DocumentRef`, `DocumentRevision`, `DocumentHistoryEvent`; `WikiReader`, Wiki 본문용 `RevisionCompare` | 관리 Wiki의 전체 본문·수정 전 이력·본문 revision. 바이너리 원본 판본은 sources, 추출/검토 상태는 knowledge/review |
| `knowledge` | `Concept`, `Entity`, `Claim`(관계/속성), `RelationCandidate`, `QualifierSet`, `ClaimContext`, `Identifier`, `ClaimProvenance`, `ClaimRef`, `GraphSnapshot`, `ClaimEvidenceRef`; `ClaimSummary`, `EvidenceExcerpt`, `ClaimInspector`, `ClaimEditForm`, `QualifierFields` | 기계 추출·유효 그래프의 주장/출처/한정어 표현과 서버가 반환한 현재성·부분 범위. 검토 결정/정책 이벤트를 새로 만들거나 승인·조건 충족을 계산하지 않음 |
| `review` | `SourceReviewDecision`, `ReviewState`, `ExpertPolicy`, `PolicyScope`, `ReviewEvent`, `PolicyEvent`, `CorrespondenceDecision`; `ReviewStateBadge`, 검토/정책의 이벤트 표시 | 원문 인용 검토·인용 없는 업무 판단·문서 간 대응 판단을 별도 종류로 유지. Claim 자체는 knowledge, 전체 비교/수정 초안은 해당 feature |
| `sources` | `SourceRecord`, `SourceRef`, `OriginalFile`, `OriginalVersion`, `SourceBodySubmission`, `SourceLineage`; `SourceRecordHeader`, `SourceLineagePanel` | 원본 파일 바이트의 메타데이터/판본·변환 본문 제출·원본 1:N Wiki 계보. 파일 바이트의 실제 보관/전송은 서버/main, Wiki 본문 revision은 documents |
| `analysis` | `AnalysisJob`, `AnalysisRun`, `StageReceipt`, `AnalysisResultRef`, `InputBasis`; `ProcessingTimeline`, `InputBasisDetails` | 서버 작업·단계·확인된 결과/규약/bundle 참조. CLI 터미널 문구나 PTY 생존을 작업 완료/저장 영수증으로 해석하지 않음 |
| `access` | `PrincipalSummary`, `Membership`, `AllowedProfile`, `AllowedActions`, `WorkspaceScope`; `MembershipPanel`, `AllowedActions` | 서버가 확인한 연결·주체·tenant·관점/정책 기준의 표시 모델. 인증 비밀·실제 인가 정책·보호 저장/CLI 설정·토큰 발급을 소유하지 않음 |

모델의 소유 domain과 전송 표현의 위치를 구분합니다. `DocumentRef/SourceRef/ClaimRef`와 이벤트·작업 참조의 **직렬화된 식별/판본 형태**는 `src/shared/contracts/`에 한 번 정의하고 domain이 그대로 참조/타입 별칭으로 사용합니다. 의미·판본 해석은 위 소유자에게 있으며 contracts에 도메인 판정 로직을 넣지 않습니다. 다른 domain을 쓰기 위해 그 모델 전체를 import하거나 똑같은 참조 타입을 새로 정의하지 않습니다. compound 결과는 feature가 각 domain의 공개 모델을 명시 조합하고 원본 revision·근거·범위를 보존합니다.

공통 UI의 배치도 같은 소유권을 따릅니다. 예를 들어 ClaimSummary의 주장/근거는 knowledge, 검토 상태 badge는 review이며 feature가 slot으로 연결합니다. `RevisionTrail`처럼 문서/원본/그래프/검토 판본을 함께 표시하는 조합은 사용하는 feature/page가 맡고, 개별 판본 표현은 소유 domain이 제공합니다. 업무 중립 `SaveOutcomePanel`은 결과 상태와 영수증 slot만 받고 실제 영수증/오류 해석은 feature가 합니다. 종전 `domain/` 단일 타입 폴더와 `shared/knowledge/`는 새 목표 배치에서 사용하지 않습니다. 현재 실제 파일의 이동은 없습니다.

`EditDraft`와 고정 질문/비교 context는 해당 feature의 작업 모델입니다. 여러 feature가 쓸 명확한 공통 초안/참조 계약만 추후 분리하며 범용 전역 draft 모델을 먼저 만들지 않습니다. 비밀 없는 연결 설정 초안은 connect-workspace, PTY 세션 참조/상태의 전송 형태는 platform/contracts와 main/terminal이 담당합니다. 이력은 원래 자료/판단/작업의 domain에 귀속하고 전역 history domain으로 복제하지 않습니다. 대화·답변·결과물 영속 모델은 기존 미결 계약을 유지합니다.

### 2.6 feature별 입력과 완료 결과

아래 **12개 feature는 사용자와 검토한 구조의 작업 경계**입니다. 모든 흐름은 입력·진행·실패·결과를 소유하며 입력 UI의 종류나 공통 API 사용 여부만으로 합치지 않습니다. 여러 domain을 사용할 수 있지만 다른 feature를 직접 호출하지 않습니다. 조회/저장/외부 자원 접근은 자기 adapter를 통해 수행합니다.

workspace 자료를 다루는 입력에는 현재 확인된 서버 연결·주체·tenant와 필요한 허용 profile을 고정합니다. 수정에는 실제 읽은 원문/그래프/검토 기준도 보관하며 관점·입력·판본 값만 갈아 끼워 기존 요청을 재전송하지 않습니다. connect-workspace는 tenant가 아직 없는 최초 상태부터 시작합니다.

| Feature | 입력·시작 기준 | 완료 결과와 끝나는 지점 | 사용하는 domain |
| --- | --- | --- | --- |
| `search-documents-by-text` | 검색어·명시 검색 범위/한도와 현재 workspace scope | 해당 요청의 문서 참조·snippet·검색 범위와 `truncated/skipped`를 표시. 한도 내 빈 결과/부분 결과도 상태를 붙여 반환하며 전체 저장소의 부재로 확대하지 않음. 문서 선택 의도는 page로 전달 | documents, access |
| `read-wiki-document` | Wiki 목록에서의 대상 선택 또는 전달받은 `DocumentRef`, 현재/지정 판본 선택·scope | 자기 adapter가 입력 선택용 Wiki 목록을 조회하고, 선택 후 정확한 전체 본문·원문 revision과 조회 상태를 표시. 다른 문서/최신 판본으로 조용히 대체하지 않으며 읽기 실패는 빈 본문이 아님. 읽기가 분석·수정 시작을 유발하지 않음 | documents, access |
| `edit-wiki-document` | 실제 읽은 전체 본문·source revision·대상 참조와 사용자 초안 | 명시 저장의 성공·새 revision과 현재 본문을 확인해 결과를 반환. 성공 cleanup 경고는 성공과 함께 표시. conflict/busy/응답 유실·확인 대기는 초안/기준을 보존하고 완료 성공으로 표시하지 않음 | documents, access |
| `explore-concept-connections` | 발견 검색어 또는 선택한 typed concept/claim target·허용 profile·문서/대응 범위·확장 의도 | 선택 대상의 실제 연결·주장·근거·검토/정책 상태와 source/graph/state·snapshot/view 기준을 표시. 현재/과거·기계층/유효층·후보/부분 범위를 구분하며 표시 결과 확보가 전체 지식의 승인/완료는 아님 | knowledge, documents, review, access |
| `review-source-claim` | 최신 ClaimRef/state·원문·현재 유효값, 사용자의 수용/정정/거절/보류와 이유; 정정에는 실제 인용·모든 한정어/출처 | 요청한 검토 이벤트·새 state와 현재 적용/보류 상태를 확인. 보류/거절 저장을 승인으로 표시하지 않음. 정책 판단·원문 변경·전체 재추출은 별도 작업으로 연결 | knowledge, documents, review, access |
| `record-expert-policy` | 대상/업무 판단·이유·전체 한정어·정확한 적용 profile/범위와 최신 state; 위조 원문 인용 없음 | 전문가 Action log의 event/state와 현재 적용 상태를 확인. 정책 저장을 원문 사실·조건 충족·기존 추출의 자동 승인으로 바꾸지 않음 | knowledge, review, access |
| `register-source` | 선택한 원본 파일·등록 정보·고정 업로드 입력과 scope | 실제 등록된 SourceRef·원본 판본/해당 등록 결과를 확인. 결과는 분석 미요청이며 Wiki/그래프 생성 완료가 아님. 응답 유실은 등록 결과부터 조회하고 중복 등록하지 않음 | sources, access |
| `run-source-analysis` | 등록 SourceRef/원본 판본·본문/맥락 기준, 명시 분석 요청·지원 개인 CLI 세션/준비 상태; 제공되는 경우 D-044 고정 입력 기준 | 서버 job/run의 단계별 영수증·파생 Wiki/그래프 참조와 일반 API의 현재 저장 결과를 확인. 제출/접수·CLI 종료 문구만으로 완료하지 않음. 일부 저장 성공 후 후속 실패는 성공 결과를 보존한 부분 상태로 유지 | sources, analysis, documents, knowledge, access |
| `compare-extractions` | 비교할 두 원문/그래프/검토 snapshot과 전체 비교 범위·명시 대응 기준 | 변경/유지/신규/미발견과 근거·한정어·대응 여부를 대조한 **미저장 비교 결과**를 표시. 선택 대응 초안은 이 feature가 소유하며 결과 열람만으로 저장·승인·재추출하지 않음 | documents, knowledge, review, analysis, access |
| `view-document-history` | 문서 참조·대상 이력 종류/이벤트·선택 판본·제공되는 조회 범위 | 사건 당시 before/after·이유·근거·event/state/판본과 현재 대상 이동 참조를 표시. 읽지 못한/제한된 이력은 표시하며 과거 snapshot을 현재값으로 바꾸지 않음. 되돌림은 별도 명시 작업 | documents, knowledge, review, sources, analysis, access |
| `connect-workspace` | 비밀 없는 연결 주소/API·MCP 설정 초안, main의 보호 인증 참조, 서버에서 받은 허용 공간/관점 선택과 선택적인 CLI 설정 의도 | 실제 일반 API 인증·소속 확인 후 적용된 읽기 연결 scope와 각 진단 결과를 반환. 읽기 가능/AI 미연결로도 종료 가능. AI 로그인·MCP 연결·행동·동일 대상 대조는 각각 실제 확인 수준을 표시하며 새 분석을 실행하지 않음 | access |
| `start-cli-session` | 명시 선택한 지원 CLI·작업 디렉터리·main이 처리할 실행/환경 참조와 요청 scope | main이 생성한 고유 세션 ID·실제 PTY 시작/출력 연결 상태를 확인해 TerminalDock에 전달. 세션 시작은 AI 로그인·MCP 인증·저장 완료가 아님. 이후 생존/입출력은 main과 앱 frame의 세션 host 수명으로 유지 | access; 세션 자체는 platform/main 책임 |

완료 결과는 **해당 작업의 결과가 확인됐다는 뜻**입니다. 조회 완료는 승인이나 전체 범위 완료와 다르고, 변경 요청의 결과 미확인은 완료 성공/확정 실패와 별도입니다. 저장 성공이 확인된 뒤 후속 조회가 실패하면 성공 저장과 결과 확인 대기를 나눠 보이며 같은 쓰기를 재실행하지 않습니다. 취소/실패 시 원래 scope·초안·성공한 단계는 보존하고, 읽지 못한 필드를 기본값으로 채워 완료하지 않습니다.

이 표는 새 API를 제공한다는 뜻이 아닙니다. 일반 HTTP API는 아직 미구현이며 첫 구현 A01–A04와 후속 쓰기/검색/작업/이력·D-044/047의 미결 계약은 기존 결정/PLAN을 따릅니다. 미지원 동작은 adapter에서 드러내고 임의 MCP 호출·모의 결과로 대체하지 않습니다. 파일 원본과 본문 직접 입력은 같은 등록 mode로 기능 상태를 합치지 않습니다. 기존 TextSourceForm의 본문 직접 등록은 별도 흐름의 이름/입력·완료 계약을 후속 설계하며 register-source의 파일 작업에 자동 포함하지 않습니다.

### 2.7 화면 조합과 기존 설계의 연결

| 기존 영역/화면 | 새 책임 배치 |
| --- | --- |
| documents / DocumentsPage·DocumentPage | documents domain의 모델/표현을 사용해 검색·읽기·수정·이력 feature를 page가 조합. Wiki 목록 조회/선택은 read-wiki-document의 입력 단계이며 원본/파생 트리 결합은 후속 카탈로그 계약과 함께 조합. page가 직접 조회하거나 본문 검색으로 목록을 흉내 내지 않음 |
| knowledge / KnowledgePage | knowledge domain의 주장/근거와 review의 상태를 explore-concept-connections에서 조합. 정정 의도는 page가 review-source-claim에 정확한 ref/basis로 연결 |
| review / ReviewPage | review-source-claim과 record-expert-policy를 별도 흐름으로 유지. 공용 ClaimEditForm의 props 표현을 함께 쓸 수 있어도 권한·근거·저장 command를 합치지 않음 |
| intake / SourceRegistrationPage·SourceJobPage | register-source 완료의 SourceRef를 page가 run-source-analysis 입력으로 전달. 둘은 직접 참조하지 않으며 등록 성공만으로 분석을 시작하지 않음 |
| refresh / RefreshPage | compare-extractions는 대조 결과/대응 초안까지만 소유. 적용·전체 재추출·미발견 유지/제외·선택 재검토/완료는 별도 작업 경계를 추가 설계하고 비교 조회에 숨겨 실행하지 않음 |
| history / HistoryPage | view-document-history와 원래 domain의 이력 표현을 조합. 전역 검색/되돌림은 별도 계약/흐름으로 유지 |
| terminal / TerminalDock | start-cli-session의 확인된 session ID를 받아 앱 frame이 같은 세션 UI를 유지. 다른 feature는 page/frame을 통해 해당 ID를 입력받고 시작 feature를 직접 호출하지 않음 |
| workspace / 연결·작업 공간 화면 | connect-workspace의 최초/변경 입력을 page가 연결. access 모델은 scope/허용 상태 표현이며 실제 보호 저장/진단은 main/platform 책임 |

5절의 컴포넌트 이름은 UI 책임을 찾는 색인이며 각각을 feature로 만드는 목록이 아닙니다. ChatPage·질문/답변·결과물 초안/저장, 문서 간 대응 검토·새 연결·되돌림·기준 비교 등 기존 UC-01–19의 동선은 유지합니다. 현재 12개가 전체 제품 흐름을 망라한다고 표시하지 않고, 나머지는 해당 API/영속 계약과 함께 입력·완료 결과 및 feature 이름을 후속으로 정합니다. 기존 UI 시안/서버 구현 상태를 이번 구조 문서 반영으로 완료 처리하지 않습니다.

### 일반 백엔드 API와 CLI의 MCP 경계

2026-10-24 API 설계: [D-043의 유스케이스별 API 목록](../../docs/domains/sources/DECISIONS.md#유스케이스별-fastapi-api-설계-2026-10-24)에 UC-01–19의 경로·입출력·권한·기존 처리 재사용/신규/미결을 연결했습니다. 첫 구현은 A01–A04의 소속·문서 목록·본문·현재 지식 조회입니다. 탐색 B, 편집/이력 C, 대응 D, 원본/작업 S를 후속으로 연결하며 전역 검토/이력 E와 질문·대화·결과/비교 F는 별도 계약이 필요합니다. 후보 경로를 구현된 기능으로 표시하지 않고 API별 준비 상태를 adapter가 드러냅니다. API 계약은 이 가이드에 복사하지 않습니다.

사용자가 추가하기로 한 백엔드는 **일반 화면 조회/등록용 API**를 제공합니다. D-043의 현행 결정에 따라 하나의 위키 백엔드가 일반 API와 MCP를 함께 제공하며 인증·tenant 정책·자료 서비스·기존 저장 모듈을 공유합니다. 일반 API를 MCP의 임의 도구 실행 프록시로 만들거나 UI용 데이터 사본을 따로 관리하지 않습니다. 백엔드는 AI를 직접 호출하는 실행자가 아니고, 파일 읽기·변환·AI 본문 구성·온톨로지 추출은 개인 CLI의 역할입니다.

```text
React 화면 → feature api adapter → WikiGateway (renderer의 제한된 facade)
                                  ↓ preload
                             WikiApiClient (Electron main, 일반 HTTP)
                                  ↓
                       하나의 위키 백엔드
                       ├─ 일반 API: 목록·본문·지식·자료/작업·결과 조회
                       ├─ MCP: 개인 CLI의 지침/입력 조회·추출물 제출·저장
                       └─ 공통 서비스·정책·기존 저장 모듈

Electron main → PTY → 사용자 개인 CLI ──MCP──┘
```

`WikiGateway/WikiApiClient`는 향후 adapter 역할 이름이며 아직 구현된 파일이 아닙니다. 컴포넌트가 URL·인증·transport를 알아야 할 이유가 없으므로 renderer의 기능 hook은 이 facade를 통해 조회합니다. main은 인증정보를 보관하고 허용된 일반 API 요청을 보내며, renderer에는 필요한 구조화 결과/오류만 반환합니다. 서버가 제공하는 실제 계약과 인증·에러 모델은 D-043을 따릅니다.

| UI adapter의 작업 이름 예 | 소비하는 컴포넌트 | 보존할 결과 |
| --- | --- | --- |
| `listDocuments` | `DocumentCatalog` | 원본만 있는 항목·1:N 파생 문서·계보 없는 기존 Wiki, cursor/필터·목록 기준과 완전성 |
| `getDocumentContent` | `WikiReader`, `WikiEditor`, `SourceReader` | 실제 전체 본문과 source revision. 파일 원본 바이트와 구분 |
| `getDocumentKnowledge` | `OntologyMap`, `ClaimInspector`, `ReviewQueue` | 유효 그래프·정책·미검토/pending과 source/graph/state 기준, 필요한 기계층/후보·속성·한정어·출처/범위 |
| `listSources`, `getSource` | `SourceIntake`, `SourceLineagePanel` | 원본 판본/변환 제출·본문 기준·파생 문서 계보 |
| `getAnalysisJob` | `ProcessingTimeline`, `StoredResultsPanel` | 서버 작업 상태·단계별 영수증과 당시/현재 결과. 터미널 문구와 구분 |
| 서버 사용자/허용 범위 조회 | `WorkspaceBoundary`, `AllowedActions` | HTTP access-context의 실제 주체·tenant·profile·행동. CLI는 별도로 MCP access_context 확인 |

이 표는 화면의 소비 책임을 정하는 것으로 HTTP 경로/인자를 새로 정의하지 않습니다. 전용 문서 목록은 원문 검색으로 흉내 내지 않습니다. 첫 페이지를 전체 목록으로 표시하지 않고 `next_cursor/complete/truncated/skipped`와 목록 기준 변경을 유지합니다. 추출 결과의 machine층을 전문가 판단이 반영된 최신 지식으로 표시하지 않으며, 현재 유효 계층과 미검토/대기 상태를 함께 받습니다. 표시용 view model은 조건/근거를 잃은 쓰기 payload로 재사용하지 않습니다.

일반 화면 조회에는 CLI 프로세스나 AI 로그인이 필요하지 않습니다. **CLI 종료/분석 불가 상태에서도 문서 목록·본문·기존 추출 결과 조회는 가능**해야 합니다. 반대로 API가 정상이라고 CLI 로그인/MCP 연결·추출 가능 상태를 추정하지 않습니다. `ConnectionStatus`는 일반 API 연결과 CLI/MCP 준비 상태를 각각 표시합니다. 네트워크 오류와 권한 거부를 구분하고 새 tenant로 전환한 후 옛 요청 결과를 적용하지 않습니다.

원문·검토·정책의 UI 저장은 해당 일반 API의 실제 제공 여부/권한을 별도로 확인합니다. 기존 MCP에 쓰기 도구가 있다는 이유만으로 화면의 HTTP 쓰기가 구현됐다고 하지 않습니다. 등록 이외의 일반 API 쓰기 계약이 아직 없으면 command adapter의 미지원 상태로 두고 MCP 직접 호출로 조용히 우회하지 않습니다. 문서/지식 읽기 API부터 백엔드에 준비한 뒤 해당 feature의 실제 adapter를 연결합니다.

### 시안 코드에서 찾을 위치

원본 HTML의 경로/hash는 [토큰 manifest](../design/tokens.json)의 `source`를 따릅니다. 아래 함수 이름은 **이관할 책임을 찾는 색인**입니다. HTML 문자열을 JSX로 자동 치환하거나 시안의 모의 API를 실제 adapter로 복사하지 않습니다.

| 현재 시안의 위치 | 구현 시 분리할 책임 |
| --- | --- |
| `render`, 전역 `state`, `data-action` 분기 | AppRouter/AppShell, feature별 hook/command, 선언적 callback으로 나눔. DOM 전체 교체 제거 |
| `upScreen`, `upForm`, `upSourcePanel` | SourceRegistrationPage/SourceJobPage와 등록 폼·원본/본문 UI |
| `upResults`, `upResultCurrent` | StoredResultsPanel의 당시 영수증/현재 상태 props와 조회 hook |
| `dmDocumentIndex`, `dmSourceInfo` | DocumentCatalog와 SourceLineagePanel; 등록/문서 화면에서 동일 UI 공유 |
| `knowledgeScreen`, `.gm-*`, `.ix-workspace` | ConceptExplorer, OntologyMap의 node/edge/group, ClaimInspector; 표시 selector와 배치 adapter 분리 |
| `ixForm`, `flReviewForm`, `flSource` | 공용 ClaimEditForm/QualifierFields/EvidenceExcerpt; 기능 container의 명령만 별도 |
| `rfScreen`, `msScreen`, `msForm`, `msDecision` | RefreshPage, ExtractionCompareWorkspace, MissingClaimDecision과 결정 초안 |
| `historyScreen`, `ixHistory`, `msHistory` | 대상별 이벤트 조회 adapter와 EventTimeline/EventDiff; 저장 이력을 UI 모의 배열에서 만들지 않음 |
| `chatScreen`, `compose`, `flSaveResult` | ChatPage, QuestionComposer/QuestionScopeBar, DraftResultPanel과 저장 명령 |
| `settingsScreen`, 미리보기/시연 도구 | 실제 공간/연결 UI와 시안 전용 도구를 구분해 제품에는 필요한 부분만 이관 |

이관 중 기존 시안은 비교 기준으로 보존합니다. 시안의 고정 문구/가상 사용자/모의 영수증/강제 실패 버튼은 제품 로직에 넣지 않습니다.

## 3. 앱 프레임과 화면 경로

```text
AppProviders (테마·연결 bootstrap·Query client; tenant 없이 시작)
└─ AppRouter
   ├─ ConnectionSetupPage (서버 미설정/인증 실패에서도 진입; 소속 조회 전 연결 준비)
   └─ WorkspaceBoundary (일반 API access-context 확인 후 주체/tenant별 store 생성·전환)
      └─ AppShell
         ├─ WorkspaceHeader (브랜드, 공간, 허용 관점)
         ├─ PrimaryNavigation (AI 작업/지식/문서/검토/이력/작업 공간)
         ├─ RouteOutlet (현재 Page)
         ├─ TerminalDock (선택해서 여는 세션 UI)
         └─ OverlayHost / NoticeRegion
```

터미널 dock과 미저장 초안의 수명은 개별 Page보다 깁니다. document→review 이동 때문에 CLI를 종료하거나 입력을 초기화하지 않습니다. panel은 `children/header/actions/aside` slot으로 합성합니다. 분할 레이아웃의 크기만 패널 설정이 알고, 내부 업무 컴포넌트는 옆 패널 폭을 알지 않습니다.

초기 Electron 라우팅은 **HashRouter**를 설계 기준으로 둡니다. hash에 경로를 보관해 로컬 문서 경로 처리와 구분할 수 있습니다([공식 문서](https://reactrouter.com/api/declarative-routers/HashRouter)). 실제 Electron 로드 방식과 뒤로/앞으로·새로고침은 골격 구현에서 검증합니다. 프로토콜·배포·딥링크 구현을 완료한 것은 아닙니다.

| 경로 예 | Page / 주요 기능 | 경로에 유지하는 대상 |
| --- | --- | --- |
| `/setup/connection` | `ConnectionSetupPage` | 최초 연결 단계와 비밀 없는 설정 초안; tenant 확인 없이 진입 |
| `/settings/connections` | `ConnectionSettingsPage` | 서버 연결 관리·진단; 확인 전 workspace 자료를 표시하지 않음 |
| `/work/:tenant/chat/:conversationId?` | `ChatPage` | 대화; 질문 작성 범위는 별도 고정 context |
| `/work/:tenant/knowledge` | `KnowledgePage` | query: profile, document, concept, claim, graph/state 기준 |
| `/work/:tenant/documents` | `DocumentsPage` | 검색/목록; 파일 경로를 임의 URL 문자열로 쓰지 않음 |
| `/work/:tenant/documents/:documentId` | `DocumentPage` | 문서 + tab + 선택 판본/주장 |
| `/work/:tenant/sources/new` | `SourceRegistrationPage` | 등록 전 초안 ID |
| `/work/:tenant/sources/:sourceId/jobs/:jobId?` | `SourceJobPage` | 원본·원래 작업·선택 탭; 최신 작업으로 조용히 바꾸지 않음 |
| `/work/:tenant/documents/:documentId/refresh/:comparisonId?` | `RefreshPage` | 비교 기준 + 선택 주장/필터 |
| `/work/:tenant/review` | `ReviewPage` | 선택 문서/주장 + 이전 화면 복귀 대상 |
| `/work/:tenant/history` | `HistoryPage` | 문서/주장/이벤트 및 당시 기준 |
| `/work/:tenant/settings` | `WorkspacePage` | 연결·소속·허용 관점; 자격 증명은 URL에 넣지 않음 |

`documentId/comparisonId` 등은 UI adapter가 다루는 참조 이름이며 현재 서버가 해당 opaque ID API를 제공한다는 뜻이 아닙니다. 일반 API의 실제 문서 참조와 정확히 대응시키고 백엔드의 MCP/저장 서비스가 사용하는 문서를 임의 이름으로 교체하지 않습니다. URL의 tenant는 접근 권한이 아니고 서버의 허용 목록과 대조합니다. 같은 선택을 URL과 독립 Jotai atom에 두 번 저장하지 않습니다. 선택 주장이 더 이상 같은 그래프/검토 상태에 없으면 최신값으로 재선택하도록 안내합니다.

### 3.1 원격 PC의 최초 연결과 연결 관리

상태: **설계와 HTML 모의 동선 반영이며 실제 React 화면·연결 처리는 미구현**입니다. 원격 사용과 인증·시험·설정 수명주기의 계약은 [D-047](../../docs/domains/platform/DECISIONS.md#d-047--원격-pc의-최초-연결과-설정-수명주기-2026-10-25)이 단일 원본입니다. 아래는 UI의 진입과 표시 책임이며 서버 필드/비밀 저장 방식을 새로 확정하지 않습니다.

| 화면/단계 | 입력·표시와 다음 행동 |
| --- | --- |
| 최초 연결 시작 | ‘기존 위키 서버 연결’을 제공. 서버 미설정·인증 실패에서도 접근 가능하며 작업 공간 화면 안으로 먼저 들어갈 것을 요구하지 않음 |
| 자료 서버 | 연결 이름·서버 기본 주소와 API/MCP 경로, 개인 서버 인증 입력/보호 저장 의도를 제공. 일반 API의 실제 도달·인증·허용 소속 조회를 각각 표시 |
| 작업 공간 선택 | 서버에서 받은 자기 소속·허용 관점/행동만 선택. 여기까지 확인되면 ‘자료 읽기 시작’ 또는 ‘개인 AI 연결 계속’으로 진행 |
| 개인 AI·MCP | 로컬 CLI 설치/로그인, 지원 어댑터, MCP 등록의 변경 전후·대상을 확인. 준비·명시 적용·프로토콜/접근 확인을 구분하며 기존 MCP 설정을 덮어쓰지 않음 |
| 연결 확인 결과 | 자료 읽기 가능·AI 로그인·실제 MCP 연결·행동 권한·API/MCP 대상 일치의 확인 수준을 별도 표시. 미확인/미지원·읽기만 가능 상태도 명시하고 새 분석을 자동 시작하지 않음 |
| 연결 관리·진단 | 작업 공간 설정에서 재진입. 주소·인증 변경, 연결 시험, 로그아웃/해제와 재연결, 초안 보존·중단된 작업 확인으로 이동. 오류 메시지/복사 정보에는 비밀을 넣지 않음 |

`ConnectionSetupPage/ConnectionSettingsPage`는 예정된 화면 이름이며 빈 파일을 생성하지 않습니다. 연결 설정 상태는 workspace 데이터 상태보다 앞에 있고 tenant가 아직 없는 상태를 지원합니다. 비밀 없는 설정 초안·단계·확인 결과와 main이 관리할 자격 증명 참조를 구분하며 실제 비밀은 라우트·전역 atom·Query cache·저장된 화면 snapshot에 두지 않습니다. 설정 입력을 main에 전달하는 좁은 bridge와 보호 저장 방법은 구현 전에 고정합니다.

최초 설정의 bootstrap provider는 tenant 없이 시작하고 인증·소속 확인 후에만 workspace store와 자료 조회 범위를 만듭니다. 미인증 초기 화면을 만들기 위해 임의의 기본 사용자/tenant나 이전 연결의 자료 상태를 주입하지 않습니다.

기존 `WorkspacePage`의 연결 상태 카드는 위 연결 관리로 이동하는 진입점을 가집니다. 정상 상태를 고르는 시안의 개발용 select를 최초 설정이나 연결 성공 증거로 재사용하지 않습니다. API/MCP의 같은 서버·주체 대조용 handshake와 자동 CLI 설정은 후속 계약이므로 확인 결과를 모의/미구현으로 표시해야 합니다. 실제 연결 수용 기준은 [원격 PC 검증 조건](../../docs/history/2026-10-25-before-domain-split/PLAN.md#원격-pc-최초-연결의-후속-검증-조건)을 따릅니다.

2026-10-25 HTML 시안 반영: 전역 ‘서버 연결’·작업 공간의 ‘연결 관리’, 시안의 ‘새 PC 최초 연결 체험’에서 시작합니다. 최초 설정을 여는 동안 workspace의 자료 renderer를 호출하지 않고 서버/인증·허용 공간·개인 AI/등록 변경 전후·결과/진단을 표시합니다. API 실패·소속 없음·지원 불일치, CLI 설치/로그인·MCP 반영 실패/충돌/재시작과 프로토콜/인증 실패를 구분합니다. 시안에서는 실제 비밀 입력을 비활성화하고 보호 인증 경로가 미구현임을 명시합니다.

연결 설정의 draft·API 확인 기준과 적용된 연결을 분리합니다. 취소는 활성 CLI/MCP 모의 snapshot을 복원하며, 서버 전환 뒤 기존 MCP 등록은 새 대상의 준비 완료로 쓰지 않고 변경 전후 정보로 남깁니다. 새 연결에는 별도 자료 예시가 없어 기존 문서/지도/검토/질문을 표시하지 않으며 이전 연결로 복귀하면 원래 범위의 상태를 다시 사용합니다. 실제 제품은 connection/principal/tenant별 Query·초안 경계와 늦은 응답의 generation 검사를 구현해야 합니다. 현재 시안에는 실제 비동기 네트워크가 없고 다른 PC·재시작 지속성·호환 handshake·보호 저장·CLI 설정 파일 처리는 검증하지 않았습니다.

## 4. 공용 컴포넌트의 계약

직접 작성하는 전역 스타일은 `.scss`, 컴포넌트 스타일은 `.module.scss`로 관리합니다. Sass 컴파일러는 `sass-embedded`를 사용하며 생성된 `shared/theme/tokens.css`와 그 CSS 변수는 유지합니다.

다음 계약은 표시 모델과 이벤트의 **방향**입니다. 업무에 특화된 공용 UI는 2.5절의 소유 domain에, 업무 중립 UI는 shared/ui에 둡니다. 여러 domain을 다루는 패널/초안 조정은 feature/page가 조합합니다. 서버 스키마/필드를 축약해 저장 인자로 재사용하지 않습니다.

현재 `shared/ui/`에 Button, IconButton, Field/TextField/TextareaField/SelectField, Panel/Header/Body/Actions, StatusNotice, Tabs, Dialog와 SCSS Module을 구현했습니다. `Button`은 네이티브 버튼 props/ref·children을 전달하고 `variant="primary|secondary"`를 받습니다. 기본 `type="button"`이며 폼 제출은 호출자가 명시합니다. 기본 모양은 primary이고 앱 프레임의 테마 전환은 secondary를 사용합니다. disabled·키보드 동작은 네이티브 버튼 의미를 유지하고, 색/경계/포커스/비활성/모션 축소는 기존 토큰을 사용합니다. 권한·저장·테마 상태는 버튼이 소유하지 않습니다. 링크는 기존 링크 컴포넌트를 사용하며 버튼에 임의 태그 전환이나 업무 상태를 추가하지 않습니다. 구현 순서/각 요소의 완료 여부는 [PLAN](../../docs/history/2026-10-25-before-domain-split/PLAN.md#5단계-공통-ui의-구현)이 관리합니다.

공통 작업 공간은 `WorkspaceLayout` 안에 `WorkspacePane name="index|content|inspector"` 영역을 합성합니다. 기본은 세 영역이며 목록/상세 화면은 `panes={['index', 'content']}`로 두 영역만 사용합니다. `labels`로 화면에 맞는 패널 이름을 지정합니다. `className`은 넓은 화면의 기존 grid 폭을 전달하며 좁은 화면의 배치는 공통 컴포넌트가 결정합니다. 조건부 내용도 해당 Pane 안에서 표시하고 패널 전환을 데이터 조회·저장 명령에 연결하지 않습니다. `WorkspaceToolbar`는 기존 header 표현을 유지하며 긴 동작을 영역 내에서 스크롤합니다. 기준값·검증·화면별 후속은 [공통 레이아웃 검토](responsive-layout-audit.md)를 따릅니다.

입력 필드는 `label/description/error`와 네이티브 props/ref를 받으며 Field가 ID·설명·오류 연결을 보존합니다. SelectField는 option children을 전달합니다. IconButton은 접근 이름을 필수로 받습니다. Panel은 header/body/actions를 children으로 합성하고 StatusNotice는 호출자가 정한 `tone/title/action`을 표시합니다. Tabs는 `label/value/onValueChange/items`의 controlled 계약이며 item ID는 고유해야 합니다. 비활성 탭을 제외해 키보드로 이동하고 숨긴 패널도 유지합니다. Dialog는 `open/onOpenChange/title/description/children/actions`를 받으며 native modal의 focus 제한·복귀를 사용합니다. 두 컴포넌트의 선택/열림 상태는 호출자가 소유합니다.

| 컴포넌트 | 입력 / 로컬 상태 | 내보내는 의도 / 맡지 않는 일 |
| --- | --- | --- |
| `Button`, `IconButton`, `Field`, `Tabs`, `Dialog` | 일반 props, disabled, 오류, 접근 이름 | click/change/focus. 업무 저장·권한 결정 없음 |
| `Panel` 조합 | header/body/footer/aside slot | 레이아웃. 수십 개 상태 boolean으로 모든 패널 표현 안 함 |
| `AsyncBoundary` | loading/error/empty/partial/ready 판별 상태 | 재조회 요청. 빈 결과와 읽기 실패·불완전 범위 구분 |
| `StatusNotice` | 상태, 설명, 가능한 action | 명확한 다음 동작. 실패/미확인/정리 경고를 성공 문구 하나로 합치지 않음 |
| `RevisionTrail` | 원본판본, source/graph/state refs | 해당 판본/현재판 조회. 서로 다른 revision을 같은 번호로 표시 안 함 |
| `EvidenceExcerpt` | 종류가 명시된 source 인용 또는 action-log 근거 | `onOpenSource(ref)`, `onOpenEvent(ref)`. 중첩 콜아웃·가짜 인용 없음 |
| `ClaimSummary` | 주어·관계·목적어 또는 속성·모든 한정어·출처/검토 요약 | `onSelect(ref)`. 방향/조건/단위/양태를 문자열 split로 복원 안 함 |
| `ProvenanceLegend`, `ReviewStateBadge` | 출처와 검토 상태 각각 | 도움말. 출처=승인이나 현재 정책=원문 사실로 합치지 않음 |
| `ClaimInspector` | 최신 또는 과거 claim view model, evidence slot, actions slot | 클릭 편집 요청·근거/이력 이동. 데이터 조회·저장은 container 책임 |
| `ClaimEditForm` | 전체 편집 가능한 값 + 고정 basis + validation | `onSubmit(draft)`, `onCancel`. 기준 revision만 교체하는 conflict 우회 없음 |
| `QualifierFields` | 극성·양태·조건·범위·시점·업무관점·출처 등 | 전체 draft 변경. 보이지 않는 필드 삭제/기본값 덮어쓰기 없음 |
| `SourceReader` | 정확한 본문/ref/선택 줄; readOnly 여부 | 줄 선택/주석 요청. 파일 변환·Wiki 저장 없음 |
| `RevisionCompare` | 이전/새 본문 ref + 두 본문 | 차이·줄 선택. 문자 차이를 삭제/AI 누락의 원인으로 판정 안 함 |
| `SaveOutcomePanel` | 실패/성공/성공+정리경고/미확인 + 영수증 | 허용된 재조회·재시도. 결과 미확인에서 즉시 재저장 안 함 |
| `DraftGuard` | 미저장 draft와 기준 변경 여부 | 유지·재대조·명시 폐기. 단순 경로 이동으로 자동 폐기 안 함 |

원문 인용과 전문가 Action log는 discriminated union으로 구분합니다. AI/전문가/후보의 지도 스타일은 [토큰 규칙](design-tokens.md)을 공유하고, 전문가 행위 세부는 이력에서만 구분합니다.

## 5. 화면별 분해와 책임

표의 구성요소는 별도 책임을 가질 때 추출할 파일 후보입니다. 모든 이름을 처음부터 빈 파일로 생성하지 않습니다. 도메인 타입/실패 상태를 정의한 뒤 의미 있는 컴포넌트부터 구현합니다.

### 5.1 자료 등록·CLI 작업·결과

AI 작업의 기본 진입은 `AiWorkPage = StoredWorkList + StoredWorkDetail`입니다. 저장된 지식/답변/결과물을 조회하는 탭과 `AnalysisRequestList`의 기존 요청 상태를 분리하며, 어느 조회도 새 job·추출·질문을 만들지 않습니다. `NewAiRequestDialog`에서 온톨로지 새 분석 또는 새 질문을 명시 선택합니다. 원본만 등록된 경우에는 source ref를 유지하고 기존 작업과 실제 파생 Wiki 선택지를 표시합니다. 아직 Wiki가 없으면 그 상태를 표시하며 이전에 보던 다른 문서로 대체하지 않습니다. `ChatPage`는 별도 질문 동선으로 재사용하고 과거 답변 조회에는 새 AI 실행을 요구하지 않습니다.

```text
SourceRegistrationPage                SourceJobPage
├─ DocumentCatalog                   ├─ DocumentCatalog
└─ SourceIntake                      └─ SourceJobWorkspace
   ├─ InputModeTabs                     ├─ SourceRecordHeader
   ├─ FileInput / TextSourceForm         ├─ ProcessingTimeline
   ├─ OriginalSelectionSummary          ├─ SourceJobTabs
   └─ RegistrationActions               │  ├─ OriginalBodyPanel
                                        │  ├─ CliRequestPanel
                                        │  │  ├─ CliReadinessNotice
                                        │  │  ├─ RequestPreview
                                        │  │  └─ TerminalSessionView (기능 공개 경계)
                                        │  └─ StoredResultsPanel
                                        └─ SourceLineagePanel
```

`useSourceRegistration`은 register-source의 파일 초안과 **제출 시점의 불변 입력**을 다룹니다. 파일 흐름은 이름·원본 파일을 입력받습니다. 기존 시안의 TextSourceForm/직접 본문 등록은 별도 feature의 경계·이름을 후속 설계하고, InputModeTabs는 page가 서로 다른 흐름을 선택하는 UI로 해석합니다. 같은 hook/atom에 두 입력의 상태/저장 경로를 모으지 않습니다. 등록 완료는 분석 미요청 상태이며 `ProcessingTimeline/CliRequestPanel`은 별도 run-source-analysis 요청이 있을 때 표시합니다. `useSourceJob`은 해당 분석 흐름의 서버 작업 상태/단계별 결과를 읽고 명령을 발행합니다. `useCliRequest`와 요청 패널은 요청 준비·복사·명시 제출을 제공하고 PTY에 임의 명령을 자동 주입하지 않습니다. `StoredResultsPanel`은 `receiptSnapshot/currentState`를 나눠 받습니다. `DocumentCatalog`는 **원본 1개→Wiki 여러 개**를 계층으로 표시하며 원본만 있는 상태·이전 Wiki만 있는 상태도 지원합니다.

| 하위 UI | 반드시 보존할 경계 |
| --- | --- |
| 입력 전환 | page가 파일/본문 등록 흐름을 구분하고 각각 입력/초안의 소유권을 유지. 업로드 결과 미확인 중 흐름/제출 입력을 바꾸지 않고 기존 초안 보존 |
| 원본·본문 | 다운로드 원본 바이트와 편집 가능한 본문 후보 분리. 원본 교체는 새 판본; 본문 편집만으로 바이너리 원본을 바꾸지 않음 |
| CLI 연결 | disconnected/login/다른 tenant/denied/busy는 요청 준비·copy 경로. PTY 연결과 MCP 인증·현재 행동 권한은 별도 |
| 처리 타임라인 | 업로드 성공·제출 대기·제출했으나 미접수·서버 claim·본문 준비·분석·본문 저장·그래프·결과 조회·부분/미확인 각각 구분 |
| 재시도 | 성공한 Wiki/그래프는 다시 쓰지 않고 실패/미실행 단계만. 저장 미확인은 서버 영수증/현재 상태부터 대조 |
| 원래 작업 이동 | 파생 문서→원래 source/job. 이전 작업의 기준과 현재 판본을 함께 표시; 당시 영수증을 최신 state로 덮어쓰지 않음 |
| 입력 출처 상세 | D-044 규약·bundle·맥락/의존버전은 `InputBasisDetails` slot에서 표시하도록 준비. 현재 시안/서버에 해당 기능이 존재한다고 표시 안 함 |

2026-10-25 분석 범위/원본 추적 시안: `AnalysisScopeDialog`는 `TargetRangeSelector + OutputDocumentEditor + RequiredContextSelector + AnalysisBasisConfirmation + SourceExtractionTrace`로 합성할 책임입니다. `saOpen/saValidate/saReview/saStart`가 현재 HTML의 모의 흐름이며 React 파일/실제 API를 추가한 것은 아닙니다. 대상 페이지·셀·Wiki 줄과 만들 문서별 제목/목적/사용 구간, 허용 정의·예외·필수 여부/이유를 명시합니다. 처음 읽은 입력 기준과 사용자 선택을 분리하고 실행 확인 뒤 편집/외부 판본 변경을 감지합니다. 사라진 필수 문서는 확인 불가로 보존하며 명시 새 준비 전 오래된 본문에 최신 판본만 붙이지 않습니다.

`SourceExtractionTrace`는 요청 당시 원본 위치/예시 읽기 방식 → 준비 본문 → 추출 인용과 미독/선택 범위 밖을 함께 보여줍니다. 합성 PDF/Excel 예시와 기존 Wiki의 원본 위치·불변 추출물 미보유를 구분하며 `complete/truncated/skipped`·구조 인용 대조/의미 검사 미실행을 유지합니다. 분석 요청 목록에서 재열람해도 당시 snapshot을 현재값으로 갱신하지 않습니다. 이번 시연의 끝은 Wiki·그래프 저장 전이며 실제 규약/bundle·파일 변환·AI/CLI·불변 제출/영수증·출처 영속화는 [D-043/044](../../docs/domains/analysis/DECISIONS.md#d-044--mcp-공통-추출-규약맥락과-분석-입력-버전-관리-2026-10-24)의 후속 계약입니다. 1920×1080의 지도 배치와 원시 주장은 보존합니다.

### 5.2 문서 목록·읽기·편집

`DocumentsPage/DocumentPage`는 `DocumentCatalog + DocumentWorkspace + DocumentContextPanel`을 합성합니다.

| 컴포넌트 | 책임 / 주요 이벤트 |
| --- | --- |
| `DocumentCatalog` | 원본/파생 Wiki 트리·검색·필터·선택; `onSelectSource/onSelectDocument`. 행 선택이 문서 읽기 진입이며 별도 ‘문서 열기’ 버튼 없음 |
| `DocumentWorkspace` | `DocumentHeader`, `DocumentTabs`, tab별 읽기/연결/판본/AI 처리; 문서 현재성과 원본·원래 작업 링크 |
| `WikiReader`, `OriginalFilePanel` | Markdown/원본 미리보기와 내려받기를 구분. 파일 원본은 보존하고 미지원 형식은 내려받기/변환 필요 안내 |
| `WikiEditor` | 현재 본문에서 시작한 초안·기준 snapshot·저장/취소. `onSave(draft,basis)`; 히스토리 보존은 서버 |
| `DocumentConnectionMap`, `ConnectionList` | 기본은 선택 문서의 연결 지도, 접근/상세용 목록 병행. 명시 링크/공통 이름 후보/검토된 의미 대응을 구분. 목록 필터와 실제 질문/저장 범위 분리 |
| `VersionList`, `RevisionCompare` | 원본 판본과 Wiki 본문 revision 각각 선택/대조. 충돌 시 옛 초안/최신 본문/기준을 보존해 재반영 |

2026-10-24 시안 반영: 첫 화면은 저장된 자료 목록과 본문이며 행/탭 선택·검색·재조회가 AI 분석을 실행하지 않습니다. `StoredKnowledgePanel`은 저장된 관계·속성·후보와 본문/그래프/검토 판본·근거·미검토 상태를 먼저 보여주고, `NewAnalysisRequestDialog`는 별도 명시 동작으로 엽니다. 문서·관점별 마지막 조회 snapshot을 유지하며 조회 중/실패를 실제 결과 없음과 구분합니다. 최신 상태를 확인하지 못하면 검토 쓰기를 잠그고 초안은 보존합니다. CLI 미연결은 조회를 막지 않으며 새 분석 실행만 제한합니다. 분석 요청의 본문·원본·그래프·검토·관점 기준을 고정하고 바뀌면 새 요청이 필요합니다. 재준비 시 이전 요청과 이유를 이력에 보존합니다. 현재 HTML의 모의 동작이며 위 React 컴포넌트·일반 API·실제 CLI 연결은 아직 구현하지 않았습니다.

### 5.3 개념 탐색·접히는 지도

```text
KnowledgePage
├─ ConceptExplorer (검색·영역·발견 대상 선택)
├─ KnowledgeMapWorkspace
│  ├─ ConceptHeader / MapToolbar / ProvenanceLegend
│  └─ OntologyMap
│     ├─ ConceptNode
│     ├─ RelationGroupNode (접힌 집계, 방향/숨은 수)
│     ├─ RelationLabel (선택 전 회색 상자, 클릭 편집)
│     ├─ ProvenanceEdge (끝점별 handle, 방향/출처)
│     └─ MapOverview (현재 조회 범위 표시)
└─ ClaimInspector + ClaimEditForm / NewConnectionComposer
```

`buildDisplayGraph(fullGraph, expansion, viewFilter)`는 React 외부의 순수 selector입니다. 접어도 대표 묶음과 외부 경계 선을 남기고 펼친 다른 그룹의 연결을 지우지 않습니다. 묶음은 논리 개체 병합이나 승인 단위가 아닙니다. 각 끝점 handle은 고유 ID로 ELK port에 연결해 중앙 한 포트로 모든 선을 합치지 않습니다. 개념 카드에는 이름만, 선에 ‘AI가 찾음/전문가’ 반복 문구는 없습니다.

원본 그래프·검토 반영 계층은 서버 조회 상태이고, 접힘/선택·사용자 고정 위치는 UI 상태입니다. 지도 배치/좌표는 worker/React Flow adapter가 맡습니다. 측정 크기·배치 결과를 원문/그래프의 의미 수정으로 저장하지 않습니다. 검색 시 흐리게 남기는 맥락과 질문에 포함하는 자료는 별도입니다. MiniMap의 전체는 현재 표시/조회 범위이며 저장소 전체라고 표시하지 않습니다.

2026-10-24 조회 경계 반영: 지도는 저장된 원문·전체 기계 그래프와 현재 관점의 검토 반영값을 조회하며, 렌더링·선택·접기·검색에서 그래프를 생성하지 않습니다. 초기 모의 자료 준비는 화면 밖의 명시 fixture 초기화이며 실제 서버 조회와 구분합니다. 같은 원시 주장 ID를 문서/claim ref에 연결해 지도에서 선택한 관계가 공용 전문가 검토와 원문·이력으로 이어집니다. 다른 관점의 고정 모의 전문가 이력을 현재 승인처럼 재사용하지 않습니다. 오래됨은 보류와 별도로 표시합니다. 조회 중/오프라인/일부 확인은 같은 관점의 마지막 지도와 당시 판본을 유지하고 새 질문·검토 쓰기를 제한하며, 접근 거부는 캐시를 현재 자료로 표시하지 않습니다. 신규 독립 연결은 별도 제안 초안으로 보관하고 지원되지 않는 생성 API를 실제 저장으로 표현하지 않습니다.

`NewConnectionComposer`는 신규 제안의 종류를 선택합니다. 기존 주장 정정, 근거 있는 후보 검토, 문서 간 대응, 원문 추가 후 전체 재추출로 각각 기존 지원 경로를 찾습니다. **독립 새 관계의 지도 드래그 생성과 즉시 서버 저장은 아직 제공된 API가 아닙니다.** 지원되는 경로가 없으면 제안 초안·필요 근거/후속 구현 상태로 남기고 기존 검토 API에 임의 필드를 넣지 않습니다.

### 5.4 검토함·전문가 판단

`ReviewPage`는 `ReviewQueue + ClaimReviewWorkspace`를 합성합니다. workspace는 **같은 주장 ref**의 `SourceReader + ClaimEditForm + ReviewActions + ReviewHistory`입니다. 지도에서 클릭한 관계도 같은 편집 UI/command hook을 사용합니다. ‘수정’ 버튼을 다시 누르게 하지 않고 읽기 영역의 click/Enter로 시작합니다. 저장/취소는 명확하게 제공합니다.

`ReviewActions`는 원문 근거 검토, `PolicyDecisionForm`은 인용 없는 전문가 업무 판단, `CorrespondenceReview`는 문서 간 대응을 맡습니다. 수용·수정·거절·보류의 실제 계약/권한은 각각 기존 API에 따릅니다. 한 폼의 `expert=true`로 세 저장 경로를 합치지 않습니다. 편집은 최신 유효값에서 시작하고 극성/양태/조건/기간/단위/맥락/출처를 모두 보존합니다.

검토 대기열의 집계/전역 API는 아직 별도 구현 대상입니다. 현재 문서별 조회를 전체 tenant 완전 목록으로 표시하지 않습니다. 읽기만 허용되면 폼/저장 행동을 숨기거나 이유와 함께 비활성화하되 인용과 현재 상태는 읽을 수 있습니다.

검토 화면은 현재 저장된 주장·원문을 먼저 조회합니다. 문서/관점별 직전 snapshot과 편집 초안은 별도로 보존하고 조회 중/실패에는 변경을 잠급니다. 저장 실패는 해당 검토 명령만 재시도하며 저장 결과 미확인은 영수증/이벤트 조회로 확인하기 전까지 추가 저장·되돌림·새 질문/분석을 막습니다. 재추출로 선택 claim이 현재 rows에서 빠지면 현재 관계 목록으로 전환하고 이전 입력을 보관해 볼 수 있게 하며 새 claim에 복사하지 않습니다. 이 UI 상태는 기존 검토 API의 CAS·원장 보존을 대체하지 않습니다.

### 5.5 원문 변경·이전/새 추출·미발견 대조

```text
RefreshPage
├─ RefreshHeader / ProcessingTimeline
├─ AffectedClaimsQueue (변경/유지/신규/미발견·현재 처리상태)
├─ ExtractionCompareWorkspace
│  ├─ PreviousClaimPanel / NewClaimPanel
│  ├─ RevisionCompare
│  └─ MissingClaimDecision (미발견 선택 시)
│     ├─ PreviousEvidence / NewSourceLocator
│     ├─ KeepExcludeReextractChoices
│     └─ DecisionReasonForm
└─ ApplyPreview / SaveOutcomePanel / ReviewCompletionPanel
```

compare-extractions의 조회/대조 실패·재조회와 차이 분류/필터는 자기 hook·selector가 맡습니다. 기존 `useRefreshComparison`은 책임을 찾는 이름이며 비교 조회에 적용/재추출 command를 함께 넣지 않습니다. 적용·전체 재추출·미발견 판단/재검토는 2.7절의 후속 흐름으로 page가 연결하고 각 흐름이 자기 저장/재시도를 소유합니다. 미발견은 ‘AI가 놓침/원문에서 삭제’의 확정 상태가 아닙니다. 이전 실제 인용·새 전체 원문을 나란히 보고 새 근거로 유지, 이번 판본에서 제외, 전체 재추출을 **명시 판단**합니다. 제외를 보편적 부정 사실로 쓰지 않습니다.

미저장 비교와 실제 전체 그래프 재생성을 구분합니다. 선택한 몇 행만 전체 생성 입력으로 보내지 않습니다. 과거 승인 자동 이식 없음, source/graph/state 충돌은 최신 원문·검토 이력과 다시 대조합니다. 검토 완료는 해당 명시 비교 범위의 실제 저장/조회 결과에서만 계산하며 전역 영향 종료로 확대하지 않습니다.

미발견의 ‘유지’는 곧바로 승인/저장 완료가 아닙니다. 새 원문 인용과 모든 한정어를 갖춘 **복구 초안 → 전체 생성 결과 대조 → 전체 저장의 영수증/현재 결과 조회 → 새 claim의 별도 검토**로 이어집니다. 옛 claim의 승인·ID를 새 claim에 이식하지 않습니다. `MissingClaimDecision`은 옛 주장 ref와 저장 후 확인한 새 주장 ref의 명시 대응을 보관하고, 검토 폼은 실제 새 claim/state를 다시 읽습니다. 그 전에는 복구 준비/저장 확인/새 검토 대기를 구분합니다.

비교 제안이나 새 추출 결과가 바뀌면 기존 명시 대응과 임시 결정은 기준 제안·원문·그래프·검토 버전을 대조해 무효화/재확인을 표시합니다. 행 번호·이름 일치·버전 숫자 교체로 대응을 자동 복구하지 않습니다. 제외 결정도 해당 새 판본의 비교 범위에 고정합니다. ‘재추출’은 새 비교 기준을 만들며 이전 미확인 결정의 승인을 복사하지 않습니다.

### 5.6 변경 이력·다음 질문·설정

| 화면 | 컴포넌트 조합 / 책임 |
| --- | --- |
| `HistoryPage` | `HistoryFilters + EventTimeline + EventDiff + EventEvidence + UndoDecision`. 원문/검토/정책/대응 이벤트를 해당 경로에서 읽고, 되돌림은 새 이벤트. 원문 revision 조회/복원·전역 검색은 후속 계약 필요 |
| `ChatPage` | `ConversationList + MessageThread + QuestionComposer + QuestionScopeBar + AnswerProvenancePanel + DraftResultPanel`. 질문 텍스트와 전달 context 분리. 당시 답변 snapshot과 새 질문의 최신 조회를 구분 |
| `WorkspacePage` | `ConnectionStatus + MembershipPanel + AllowedActions + ProfileSelector + CliSessionSettings`. 자기 소속/허용 행동 표시. 프로필을 쓰기 권한으로 해석하지 않음. 계정 발급/SSO/관리 기능을 구현된 것처럼 노출하지 않음 |
| 시안 전용 | ‘화면 구성 지도’, 미리보기 배율, 모의 오류/진행 버튼은 개발 참고 자료. 제품 주 탐색에는 이관하지 않음 |

`EventTimeline/EventEvidence`는 이벤트 당시의 before/after·이유·인용·원문 snapshot·판본을 사용합니다. 현재 유효값을 옛 이벤트에 덮어 표시하지 않습니다. 현재 관계로 이동할 때 같은 claim의 현재성을 확인하고, 새 추출에 명시 대응이 없으면 해당 문서의 현재 관계 목록으로 이동합니다. 되돌림은 화면에서 조회한 현재 이벤트와 state 기준으로 새 이벤트를 쓰며, 조회 실패나 저장 미확인 상태에서 기준 숫자를 자동 갱신하지 않습니다. AI 작업·검토·이력·문서·질문의 공통 범위는 `DocumentRef` 또는 아직 Wiki가 없는 `SourceRef`이며 잘못된 ID를 기본 문서로 바꾸지 않습니다. 질문 초안과 저장된 답변 snapshot은 구분해 유지합니다.

2026-10-24 HTML 시안에는 위 AI 작업/검토/이력 조회 경계를 반영했습니다. 이 절의 React 컴포넌트 파일·일반 API·검토 HTTP 쓰기·실제 CLI/AI 연결은 후속이며 시안의 모의 저장을 실제 서버 기능으로 표시하지 않습니다.

질문하기는 현재 source/graph/state·정책 이벤트·범위를 읽어 새 질문 context를 만들고, 과거 답변의 근거 snapshot은 보존합니다. 관점/대상 변경 시 질문 문구는 유지하고 context 변경을 재확인합니다. 내부 주장 ID/전달 지침을 질문 입력칸에 자동 삽입하지 않습니다. 결과 초안과 저장된 Wiki는 별도이며 결과물 출처 영속 계약은 [D-039](../../docs/domains/ui/DECISIONS.md#d-039--유스케이스에-따른-ai-온톨로지-중심-화면-구성-2026-10-23)의 미결 범위를 따릅니다.

2026-10-24 남은 화면 시안 반영: `QuestionScopeBar`는 사용자가 요청한 문서·관계·관점을 그대로 보존하며 조회 불가·다른 문서/관점·오래된 지정 관계를 조용히 제외하지 않습니다. 접힘/검색은 질문 범위와 별도입니다. 준비·범위 변경·재조회는 AI 실행이 아니며, 명시 질문 요청에서 원문/추출/검토 판본을 고정합니다. 관점·근거 변경 시 초안/옛 답변을 보존하고 명시 재확인을 요구합니다. 답변은 검토 반영 지식, 인용이 있는 미검토 원문 주장, 후보·보류·오래된 참고를 구분하고 미검토를 승인으로 바꾸지 않습니다. 저장 결과의 근거는 질문 당시 snapshot이며 현재값으로 갱신하지 않습니다.

`WorkspacePage`는 `SourceServiceStatus`(일반 API 조회), `PersonalAiReadiness`(개인 CLI/AI 로그인), `McpReadiness`(MCP 인증/저장 준비), `MembershipPanel/AllowedActions`로 분리합니다. 자료 조회는 CLI 없이 가능하고 새 요청에는 해당 실행 준비가 필요합니다. 실행 중 준비 상태가 바뀌면 저장 직전 재검사해 중단하고 성공한 결과를 보존합니다. 저장 영수증 재조회는 자료 서비스만 요구하며 AI 실행과 분리합니다. 재연결은 자동 재실행이 아니고 사용자가 기존 작업 이어가기/재시도를 선택합니다. 시안의 상태 선택기는 개발용이며 실제 인증·권한 설정 UI로 이관하지 않습니다. 실제 API·React/Electron·CLI/AI/PTY 연결과 재시작 지속성은 후속입니다.

2026-10-25 결과물 초안 시안: 답변의 `DraftResultPanel` 진입은 초안 생성/열기이며 Wiki 저장이 아닙니다. `ResultDraftDialog`는 `ResultDraftEditor + GeneratedDraftComparison + FrozenEvidencePanel + DraftApplyBar`로 합성합니다. 편집 제목/본문과 처음 생성한 서술, 질문 당시 문서별 원문/추출/검토 기준·인용·조건·판단 이유를 분리합니다. 새 질문은 문서별 graph/state manifest도 함께 고정하고, 옛 답변에 기준이 없으면 최신값을 소급하지 않고 미보유를 표시합니다.

초안 registry는 연결/주체/tenant·질문·관점 범위에 귀속해야 합니다. 현재 HTML은 기존 자료 fixture에서만 동작하고 원격 새 연결에서는 차단합니다. 닫기는 입력을 보존하고, 현재 근거 변경 시 현재 판본에 묶인 확인을 요구하며 재변경 때 재확인합니다. 최종 제목/본문/고정 부록을 합산해 UTF-8 1 MiB를 검사하고 명시 반영에서만 새 문서를 만듭니다. 문서 반영은 그래프 생성/관계 승인과 별도입니다. 성공 문서 ID를 재사용해 중복 생성을 막지만 실제 API 영수증·결과 미확인 해소·출처 영속화 계약을 구현한 증거는 아닙니다. 오프라인 초안 보존과 접근 거부 시 초안/원문 비표시를 구분합니다. 실제 F02/F03·권한·재시작/공유 계약은 D-043의 미결 범위로 유지합니다.

## 6. 상태의 유일한 원본

| 위치 | 맡는 상태 | 두지 않을 상태 |
| --- | --- | --- |
| Router | 현재 화면/문서/개념/주장/관점·선택 탭, 명시 이력 대상 | 토큰·파일 바이트·긴 입력·서버 전체 객체 |
| Query | 일반 API로 조회한 서버 문서/원본/작업/그래프/검토/정책·영수증·현재 상태 | 독립 최신값으로 복제한 Jotai 그래프/승인 상태, 화면을 열 때마다 CLI/MCP에 요구하는 조회 |
| Jotai (주체/tenant store) | 패널·묶음 접힘·초안 registry·고정 질문 snapshot·활성 terminal session ID | route/profile의 별도 원본, PTY 대량 출력, 서버 권한을 직접 설정하는 값 |
| 컴포넌트 로컬 state | input focus·일회성 tooltip/dialog·공유 필요 없는 폼 필드 | 여러 화면에서 이어야 하는 작업/초안 전체 |
| 순수 selector | 필터 결과·집계·표시 그래프·현재 선택 객체·미검토 건수 | 변경할 수 있는 두 번째 fullGraph |
| main + xterm | main: PTY process/세션 연결; xterm: 표시 버퍼 | renderer가 직접 process handle 보관, ANSI 텍스트로 저장 완료 판정 |

폼 초안은 하나의 객체를 소유하고 기준을 함께 보관합니다. 화면을 넘나들어야 하는 초안은 Jotai registry가 소유하며 폼은 그것을 제어합니다. 로컬에서만 쓰는 폼은 로컬이 소유합니다. 같은 초안을 로컬과 registry에 Effect로 계속 복제하지 않습니다. 포커스 상태나 글자 입력마다 전체 앱을 구독시키지 않도록 atom/구독을 기능별로 나눕니다.

Jotai store는 인증 주체·서버·tenant 범위로 분리하며 전환 시 이전 Query 응답·구독을 취소하고 해당 캐시/초안을 다른 공간에 노출하지 않습니다. 보존할 초안은 그 원래 범위에서만 접근하게 합니다. 전환 시 버릴지/보관할지는 명시 안내하며 임의 로컬 영속 저장을 추가하지 않습니다. [Jotai Provider](https://jotai.org/docs/core/provider)는 subtree별 store를 지원합니다. 관점 전환은 같은 tenant 초안을 자동 삭제하거나 원문을 변경하는 계기가 아닙니다.

검토·정책·대응·질문 초안은 시작한 **허용 profile과 업무 적용 범위**를 context와 registry key에 고정합니다. 관점 전환 후 기존 초안은 보존하되, 시작 관점으로 돌아가거나 새 관점에서 최신 근거/판단을 다시 읽고 명시 재확인한 새 초안을 만들기 전에는 그 초안을 제출하지 않습니다. 기준값만 새 관점으로 교체하지 않습니다. 원문 편집의 basis는 전체 문서이며 관점별 일부 본문으로 원문 저장 범위를 줄이지 않습니다.

Query key는 **서버·인증 주체·tenant·정책 기준 + 조회 종류 + 필요한 profile/문서/버전**을 포함합니다. 현재 조회와 특정 revision 조회를 다른 key로 둡니다. 예: `claimReview(scope, document, current)`와 `claimReview(scope, document, graphRevision, stateRevision)`. 이 표기는 키 설계 예이고 실제 함수/API가 아닙니다. 요청 시점 scope를 캡처하고 이전 공간에서 늦게 온 결과를 현재 화면에 반영하지 않습니다. profile이 없는 조회에 임의 필터를 추가해 원문 추출을 축소하지 않습니다.

조회 갱신은 편집 초안을 덮어쓰지 않습니다. 변화가 있으면 ‘편집 기준 변경’을 보여 주고 이전 basis/초안/최신값을 대조합니다. 저장은 명시 이벤트 한 번, mutation 자동 retry는 끄는 것을 기본으로 하며 `storage_busy`와 conflict를 분리합니다. 성공 후 현재 결과를 다시 확인하고 관련 쿼리만 무효화합니다. 저장 성공 뒤 영수증/정리 경고 때문에 같은 쓰기를 다시 보내지 않습니다.

## 7. 대상·판본을 잇는 표시 계약

화면 사이에는 표시 문자열이 아니라 **범위 있는 참조**를 넘깁니다. 아래는 기존 주장 편집을 설명하는 renderer 설계 예이며 IPC/HTTP·서버 저장 계약을 대체하지 않습니다. 공용 초안은 편집 값과 기준 타입을 각각 받습니다.

```ts
type DocumentRef = Readonly<{
  tenant: string;
  document: string;              // 서버의 실제 문서 참조
  sourceRevision: string;
}>;
type ClaimRef = Readonly<{
  source: DocumentRef;
  graphRevision: string;
  claimId: string;               // 서버가 제공하는 검토 대상 ID
  stateRevision: string;
}>;
type ClaimEvidenceRef =
  | { kind: 'source'; source: DocumentRef; quote: string;
      lines: readonly [number, number] }
  | { kind: 'actionLog'; claim: ClaimRef; eventId: string };
type DraftContext = Readonly<{
  server: string; principal: string; tenant: string; profile: string;
}>;
type EditDraft<T, TBasis> = Readonly<{
  context: DraftContext; basis: TBasis; initial: T; value: T;
}>;
// WikiEditor: EditDraft<WikiBody, DocumentRef>
// ClaimEditForm: EditDraft<EditableClaim, ClaimRef>
// CorrespondenceReview: 양쪽/연결 근거의 전체 의존 ref와 대응 원장 basis 사용
```

실제 revision은 내용 식별값/서버 값입니다. 시안의 1판/2판 숫자를 실제 revision 타입으로 고정하지 않습니다. 배열 위치는 해당 graph revision 안의 조회 위치일 뿐 영구 수정 ID가 아닙니다. 후보/속성/정책/대응 ref는 각각 서버 조회의 종류·ID·근거·버전을 보존하며 임의 `ClaimRef`로 변환하지 않습니다. `ClaimEvidenceRef`는 기존 주장용 예시일 뿐 모든 Action log의 공통 ref가 아닙니다. 공용 `EvidenceExcerpt`는 문서 간 대응/전문가 판단의 정확한 이벤트·상태·의존 출처 모델도 별도 종류로 받습니다.

질문 context에는 문서/인용/graph/state·profile·선택 범위·완전성과 정책 event가 연결됩니다. 등록 결과에는 source/job/run·원본 판본·본문 basis·파생 문서·단계별 영수증이 연결됩니다. D-044 입력 출처가 실제 제공되면 별도 고정 규약/bundle 참조를 붙이며 과거 운영 그래프에 새 규약을 소급 표시하지 않습니다.

## 8. 터미널의 별도 수명

`TerminalDock`은 세션 탭/열기/접기를, `TerminalSessionView`는 xterm 생성·fit·출력 구독·입력 전달을, `useTerminalSession`은 main 세션 상태를 연결합니다. `CliRequestPanel`과 TerminalDock은 같은 main 세션 ID를 참조하고 인스턴스를 중복 생성하지 않습니다.

- xterm을 DOM에 연결하는 Effect에는 구독 해제/observer/인스턴스 dispose를 짝으로 둡니다. 숨김·다시 보임·React 개발 모드의 Effect 재실행으로 새 CLI를 계속 spawn하지 않습니다.
- `TerminalSessionHost`는 앱 frame에 세션별로 유지하고 dock의 숨김/펼침만으로 unmount하지 않습니다. 따라서 화면/패널 전환 중에는 같은 xterm 인스턴스와 출력 구독이 버퍼를 유지합니다. 실제 unmount/dispose 후에도 PTY를 유지할 경우를 위해 main의 세션별 **상한 있는 메모리 출력 캐시/순번·마지막 수신 위치**를 후속 bridge 설계에 포함합니다. 재연결 시 중복 없이 남은 출력을 재생하고 캐시 상한으로 누락되면 그 사실을 표시합니다. 이는 아직 구현하지 않은 앱 내 표시 복구이며 무제한 기록·앱 재시작 복원·서버 저장 이력이 아닙니다.
- 패널 크기를 fit한 행/열은 main PTY에 전달합니다. 화면 숨김은 프로세스 종료가 아니고 **명시 종료/앱 종료**에서 main이 정리합니다.
- ANSI 출력은 xterm 버퍼에서 처리합니다. 글자마다 Jotai 전체 atom이나 Query에 쌓지 않습니다. 로그인/접속/권한 상태는 구조화된 별도 확인이며 문자열 매칭만으로 확정하지 않습니다.
- main/preload가 세션 ID·허용 입력/resize/종료를 검사합니다. renderer에 범용 shell 실행/임의 IPC API·비밀 환경변수 읽기를 열지 않습니다.
- CLI의 “완료”는 결과 증명이 아닙니다. D-043 서버 claim/영수증/최신 조회를 별도로 표시합니다. D-044의 단계별 고정 입력 전달/세션 준비를 지원하지 않는 CLI는 단순 요청 준비 상태이며 공통 실행 검증 완료가 아닙니다.

실제 xterm/PTY·한글 입력·Ctrl+C·macOS/Windows 패키징은 미검증입니다. 사용 기술과 배포 확인 항목은 [D-033](../../docs/domains/ui/DECISIONS.md#d-033--정책을-추적한-ui-시안과-구현-경계-2026-10-23)이 담당합니다.

## 9. UC-01~19 구현 담당 추적

유스케이스 본문/정책의 단일 원본은 [D-039](../../docs/domains/ui/DECISIONS.md#d-039--유스케이스에-따른-ai-온톨로지-중심-화면-구성-2026-10-23)가 연결한 시안의 `cases`입니다. 이 표는 **컴포넌트 담당만 매핑**하며 완료를 선언하지 않습니다.

| UC | 목적 | 구현 책임 / 이어지는 화면 |
| --- | --- | --- |
| 01 | 자료 축적 | SourceIntake → SourceJobWorkspace → StoredResultsPanel → DocumentWorkspace |
| 02 | 경험 문서화 | QuestionComposer → DraftResultPanel → WikiEditor; 경험과 제안 분리 |
| 03 | 자료 이해 | WikiReader + ClaimSummary + ClaimInspector + EvidenceExcerpt; 부분/미검토 표시 |
| 04 | 문서 찾기 | DocumentCatalog → WikiReader; 검색 불완전성 표시 |
| 05 | 근거 있는 질문 | QuestionScopeBar → MessageThread → AnswerProvenancePanel |
| 06 | 개념 종합 이해 | ConceptExplorer → OntologyMap + ClaimInspector; 버전 있는 대상 |
| 07 | 관점별 이해 | WorkspaceHeader/ProfileSelector → QuestionScopeBar; context 재확인 |
| 08 | 기준 비교 | RevisionCompare와 구분한 KnowledgeCriteriaCompare (추후 전용 동선); 방향/범위/근거 대조 |
| 09 | 결과물 작성 | DraftResultPanel → WikiEditor → AnswerProvenancePanel; 당시 출처 계보 |
| 10 | 연결 탐색 | OntologyMap / DocumentConnectionMap → ClaimInspector; 링크/후보/대응 분리 |
| 11 | 연결 검토·선례 | CorrespondenceReview → EvidenceExcerpt → ReviewHistory; 승인 복사 없음 |
| 12 | 원문 정정 | WikiEditor → RevisionCompare/DraftGuard → SaveOutcomePanel |
| 13 | AI 해석 정정 | RelationLabel → ClaimEditForm/QualifierFields → ReviewHistory |
| 14 | 전문가 판단 | PolicyDecisionForm / CorrespondenceReview → EventEvidence |
| 15 | 지식 갱신 | RefreshPage → ExtractionCompareWorkspace → ApplyPreview → 검토 |
| 16 | 변경 후 재검토 | AffectedClaimsQueue → MissingClaimDecision → ReviewCompletionPanel |
| 17 | 추적·되돌림 | EventTimeline → EventDiff/UndoDecision → 원래 ClaimInspector |
| 18 | 다음 작업 재사용 | History/Document/Claim → 새 QuestionScopeBar → 최신 조회 |
| 19 | 작업 범위 확인 | WorkspaceBoundary → MembershipPanel/AllowedActions → 연결/관점 확인 |

UC-08 전용 비교, 결과물 계보·대화 영속화, 전역 검토/이력·완료 판정, 새 관계 직접 저장은 공용 컴포넌트가 있다는 이유만으로 구현된 기능으로 표시하지 않습니다. 기능별 API 준비 여부를 adapter에 드러내고 모의 데이터는 별도 mock adapter로 구분합니다.

## 10. 구현 순서와 수용 기준

처음에는 문서/토큰을 준비했으며 2026-10-25 요청으로 아래 2번 중 서버에 의존하지 않는 Electron 실행 골격을 먼저 구현했습니다. **다음 순서는 후속 요청 시** 한 묶음씩 구현하고, 자료 연결은 1번의 실제 API를 먼저 검증합니다. 단계 완료 상태는 [PLAN](../../docs/PLAN.md)이 관리합니다.

1. 문서 목록·본문·지식/현재 판단 조회용 **백엔드 일반 API와 권한/부분 결과 계약을 먼저 구현·검증**합니다. [D-043](../../docs/domains/sources/DECISIONS.md#fastapi-백엔드-채택과-구현-경계-2026-10-24)의 FastAPI·기존 MCP 단일 앱 채택과 [PLAN의 R1 첫4개](../../docs/history/2026-10-25-before-domain-split/PLAN.md#r1-첫-구현-묶음과-검증-조건-fastapi-채택-2026-10-24)를 따르고 기존 서비스/저장 모듈을 재사용합니다. 실제 배포/인증·버전 고정은 해당 구현 범위에서 검증·결정합니다.
2. Electron main/preload/renderer 경계와 앱 frame·router·테마를 준비하고 1920×1080으로 확인합니다. 실제 의존성/배포 버전은 이때 고정합니다. 공통 근거·판본 UI와 문서 읽기부터 옮겨 실제 일반 API adapter를 검증합니다. 한 feature씩 옮기고 시안 전체를 한 TSX로 감싸지 않습니다.
3. 자료 등록→CLI 요청→저장 확인은 D-043/D-044의 서버 gate가 준비된 범위만 연결합니다. mock/실제 경로를 섞지 않습니다.
4. 지도→같은 ClaimEditForm→검토 이력→다음 질문을 연결하고 명시 쓰기/권한/CAS와 원문 보존을 검증합니다.
5. 원문 변경→이전/새 추출→미발견 대조→선택 재검토를 연결합니다. 실제 재추출 입력은 전체 원문/그래프 계약을 지킵니다.

| 확인 과제 | 수용 기준 |
| --- | --- |
| domain/feature 경계 | domain 모델의 소유자 하나, feature는 2.6절의 입력/결과와 실패 상태를 소유. feature 간/다른 domain 실행 참조·역참조·순환 없음. page가 공개 결과/참조로 다음 흐름 연결 |
| 초안/계약 보존 | domain 공통 규칙·식별/판본 계약의 복제 없음. 기능 UI/조정의 허용된 중복과 구분하고 등록/분석·원문 검토/전문가 판단·비교/적용을 독립 검증 |
| 컴포넌트 분리 | page에 MCP·PTY·본문파서·관계수정 알고리즘이 없음. 표시 UI는 callback mock으로 독립 렌더 가능 |
| 일반 API와 CLI 분리 | CLI가 꺼져 있어도 문서/추출 결과 조회 가능. API 사용자/권한 확인·목록 페이지/불완전성·유효 계층 보존, MCP 직접 호출 우회 없음 |
| 동일 대상 동선 | 원본→파생 Wiki→주장→근거→검토→이력→질문의 refs/판본 일치. 재방문해도 초안/원래 작업 보존 |
| 지도 접힘 | 접힘 전후 원본 그래프/질문 범위 불변, 외부 경계 연결·숨은 수·후보 구분 유지 |
| 편집·충돌 | 현재 유효값으로 시작; source/graph/state 변경 시 draft 보존·재대조; 버전만 바꾼 재전송 없음 |
| 실패·미확인 | 부분 실패는 미완료 단계만; 응답 유실은 조회 먼저; 성공 정리 경고와 실패 구분 |
| 원문 변경 | 미발견을 원인 확정으로 표시하지 않음. 유지/제외/재추출 각각 근거·판단·저장/현재 결과 분리 |
| 범위 전환 | 다른 주체/tenant 늦은 응답·캐시 누출 없음. profile 변경은 추출/권한 변경이 아님 |
| 터미널 수명 | 경로 전환·숨김·개발 모드 재실행 중 세션 중복 생성 없음; 종료·resize·한글/Ctrl+C 확인 |
| 접근·긴 텍스트 | 클릭 편집의 Enter/키보드 진입, 포커스 복귀, full name 접근, 긴 인용/조건/파일명 overflow 없음 |

이 수용 기준의 실제 기능·사용성·접근성·저장 지속성·패키징 검증은 아직 실행하지 않았습니다. 토큰/문서 정합성 검증 결과와 혼동하지 않습니다.

## 11. 명명 규칙

이 절은 `app/`에서 새 컴포넌트와 관련 파일을 만들 때 적용하는 프로젝트 규칙입니다. 화면별 책임/배치는 위 3~5절, 값은 디자인 토큰 문서를 따릅니다. 이름을 정했다는 이유로 빈 컴포넌트나 디렉터리를 미리 생성하지 않습니다.

### 11.1 파일·export·폴더

| 대상 | 규칙 | 예 |
| --- | --- | --- |
| React 컴포넌트 | PascalCase, 파일명과 대표 named export 일치 | `ClaimEditForm.tsx` → `export function ClaimEditForm` |
| props 타입 | 컴포넌트명 + `Props` | `ClaimEditFormProps` |
| React hook | `use` + PascalCase 의미, 파일명과 export 일치 | `useClaimReview.ts` → `useClaimReview` |
| 조회 hook | `use` + 대상 + `Query` | `useDocumentQuery`, `useClaimReviewQuery` |
| 개별 쓰기 hook | `use` + 동사/대상 + `Mutation` | `useSubmitClaimReviewMutation` |
| 기능 조정 hook | `use` + 기능명, 내부 조회/명령 연결 | `useSourceRegistration`, `useClaimReview` |
| 순수 함수 | camelCase 동사, 파일명과 대표 함수 일치 | `buildDisplayGraph.ts`, `selectAffectedClaims.ts` |
| 도메인 타입 파일 | camelCase 대상 + `.types.ts` | `claim.types.ts`, `sourceJob.types.ts` |
| 조회/명령 묶음 | 대상 + `.queries.ts` / `.mutations.ts` | `claimReview.queries.ts`, `claimReview.mutations.ts` |
| SCSS Module | 해당 컴포넌트명 + `.module.scss` | `ClaimEditForm.module.scss` |
| 테스트 | 대상 파일명 + `.test.ts(x)` | `ClaimEditForm.test.tsx`, `buildDisplayGraph.test.ts` |
| feature 폴더 | 소문자 kebab-case의 동작 + 대상; 입력부터 완료 결과까지 한 작업 | `features/review-source-claim`, `features/edit-wiki-document` |
| domain 폴더 | 소문자 업무 영역 이름 | `domains/documents`, `domains/knowledge`, `domains/review` |
| 기타 폴더 | 소문자 kebab-case; 실제 책임이 있을 때만 분리 | `shared/ui`, 필요할 때 `shared/lib/date-formatting` |

한 파일에는 대표 공개 컴포넌트 하나를 둡니다. 그 컴포넌트에만 쓰는 작은 내부 표현까지 기계적으로 파일 분리하지 않습니다. 별도 책임/재사용/수명이 생기면 의미 있는 이름으로 추출합니다. 페이지·컴포넌트의 default export는 사용하지 않고, 도구가 필수로 요구하는 진입점만 예외로 둡니다.

`index.ts`는 실제로 공개 경계가 필요한 feature/공용 모듈에만 두고 필요한 named export를 명시합니다. 모든 파일에 `index.ts` 폴더를 만들거나 `export *`로 내부 상태/구현을 전부 노출하지 않습니다. 명명 규칙이 2절의 의존 방향을 바꾸지는 않습니다.

### 11.2 UI 역할 접미사

**업무 대상 + 구체적 역할**로 이름을 만듭니다. 역할이 이미 `Reader/Editor/Composer` 등으로 드러나면 접미사를 추가로 쌓지 않습니다.

| 역할 | 사용 기준 | 현재 설계의 예 |
| --- | --- | --- |
| `Page` | Router가 여는 화면; 기능 합성/이동 담당 | `KnowledgePage`, `SourceJobPage` |
| `Layout`, `Shell` | 여러 화면이 공유하는 배치/앱 프레임 | `AppShell`, 필요할 때 `SplitPaneLayout` |
| `Workspace` | 한 업무의 여러 패널을 조정하는 작업 영역 | `ClaimReviewWorkspace`, `DocumentWorkspace` |
| `Panel` | 지속적으로 보이는 한 영역 | `SourceLineagePanel`, `StoredResultsPanel` |
| `List`, `Queue`, `Catalog` | 일반 목록 / 처리 대기열 / 계층 탐색 | `VersionList`, `ReviewQueue`, `DocumentCatalog` |
| `Item`, `Row`, `Card` | 목록 항목 / 열 구조 행 / 독립 카드 | 필요할 때 `DocumentTreeItem`, `SourceResultRow`, `SourceResultCard` |
| `Form`, `Fields` | 제출 단위 / 폼 안의 관련 입력 묶음 | `ClaimEditForm`, `QualifierFields` |
| `Reader`, `Editor`, `Composer` | 읽기 / 기존 내용 편집 / 새 내용 구성 | `WikiReader`, `WikiEditor`, `QuestionComposer` |
| `Inspector` | 선택 대상의 상세·근거·행동 | `ClaimInspector` |
| `Dialog`, `Drawer` | 대화상자 / 필요할 때 여는 측면 오버레이 | 필요할 때 `DiscardDraftDialog`; 고정 패널을 Drawer로 부르지 않음 |
| `Node`, `Edge` | 지도에서 위치·연결점/선을 갖는 표현 | `ConceptNode`, `RelationGroupNode`, `ProvenanceEdge` |
| `Badge`, `Notice`, `Legend` | 짧은 상태 / 설명과 다음 행동 / 시각 부호 안내 | `ReviewStateBadge`, `StatusNotice`, `ProvenanceLegend` |

모든 기능을 `FooContainer/FooView` 두 파일로 강제하지 않습니다. `ClaimReviewWorkspace`가 hook과 표시 UI를 합성하고 `ClaimEditForm`이 입력 책임을 가지면 충분합니다. `Manager`, `Handler`, `Wrapper`, `Common`, `Custom`, `Component`처럼 역할을 숨기는 접미사는 구체적 역할로 바꿉니다. 상위 폴더의 맥락 없이 import해도 대상을 이해할 수 있게 `Form.tsx` 대신 `ClaimEditForm.tsx`를 사용합니다.

### 11.3 이 프로젝트의 업무 용어

| 이름에 쓰는 용어 | 의미와 경계 |
| --- | --- |
| `Wiki` / `Document` | 관리되는 Wiki 본문/문서. 파일 원본은 `OriginalFile`, 원본 판본은 `OriginalVersion`으로 명시 |
| `Source` / `Evidence` | Source는 해당 기능에서 다루는 출처, Evidence는 실제 인용/Action log 근거. `sourceRevision`과 `originalVersion`을 혼용하지 않음 |
| `Concept` / `Relation` / `Claim` | 개념 탐색 대상 / 지도에 표현되는 관계 / 관계·속성 등 검토 가능한 주장. 모든 주장을 선으로 강제하지 않음 |
| `Review` / `Policy` / `Correspondence` | 원문 근거 검토 / 전문가 업무 판단 / 문서 간 의미 대응. 서로 다른 권한·출처·저장 경로 유지 |
| `Candidate` | 미확정 제안. 이름에 Reviewed/Confirmed를 붙여 승인처럼 보이게 하지 않음 |
| `Draft` / `Snapshot` / `Receipt` | 미저장 편집안 / 특정 시점의 고정 내용 / 확인된 저장 결과. 임시 UI 상태를 Receipt로 부르지 않음 |
| `Job` / `Session` | 서버 처리 작업 / 터미널·CLI 세션. terminal 출력과 Job 완료를 혼동하지 않음 |

새 이름에도 위 용어를 적용합니다. `Review`와 `Policy`를 `ExpertForm` 하나로 뭉치거나, 원문 파일/변환 본문/Wiki를 모두 `DocumentData`라고 부르지 않습니다. 기존 설계의 `SourceRegistrationPage` 등은 유지하되 타입·필드에 원본 판본/본문 revision의 구분을 명시합니다.

약어는 PascalCase 안에서 단어처럼 씁니다: `CliRequestPanel`, `McpConnectionStatus`, `PtySessionState`, `WikiReader`. 필드는 `claimId`, `sourceUrl`처럼 씁니다. 서버의 `claim_id`, `state_revision` 등 실제 계약 이름은 그대로 유지하고 adapter에서 명시적으로 매핑합니다. 외부 라이브러리 export나 생성된 이름은 억지로 변경하지 않습니다.

### 11.4 props·이벤트·상태·타입

| 대상 | 규칙 | 예 |
| --- | --- | --- |
| 상위에 알리는 callback prop | `on` + 사용자 의도 | `onSelectClaim`, `onSubmit`, `onCancel`, `onOpenSource` |
| 컴포넌트 내부 이벤트 함수 | `handle` + 같은 의도 | `handleSubmit`, `handleClaimSelect` |
| boolean | `is/has/can/should`로 의미 명시 | `isOpen`, `hasEvidence`, `canSubmit` |
| 상태 값/단계 | `status`, `phase`, 의미 있는 판별 union | `phase: 'claim_wait'`; 여러 상충 boolean을 따로 저장하지 않음 |
| 읽기 참조 / 편집 기준 | `Ref` / `Basis` | `ClaimRef`, 필요할 때 `CorrespondenceBasis` |
| 초안 / 표시용 데이터 | `Draft` / `ViewModel` | `EditDraft<T, TBasis>`, 필요할 때 `ClaimViewModel` |
| Jotai atom | 상태 이름 + `Atom` | `expandedRelationGroupsAtom`, `activeTerminalSessionIdAtom` |
| 조회 key factory | 대상 + `Keys` | `documentKeys`, `claimReviewKeys` |
| 순수 계산/변환 | `build/select/derive/to` + 결과 | `buildDisplayGraph`, `toClaimViewModel` |

`canSubmit` 같은 표시 조건은 실제 서버 권한을 대체하지 않습니다. Query에서 파생되는 `isPending` 등을 같은 이름의 독립 atom에 복제하지 않습니다. `handleClick`처럼 DOM 동작만 말하는 이름보다 어떤 업무 의도인지 드러냅니다. `onChange`는 일반 입력에 허용하고, 대상이 여러 개이면 `onQualifierChange`처럼 명확하게 합니다. callback은 `onSelectClaim(ref)`처럼 필요한 값만 올리며 무관한 DOM event나 전체 전역 store를 전달하지 않습니다.

타입에는 `I` 접두사나 모호한 `Data/Info/Object`를 관습적으로 붙이지 않습니다. `DraftContext`처럼 이미 문서에 정의된 명확한 업무 이름은 유지합니다. SCSS Module의 로컬 class는 `root/header/actions` 같은 camelCase 역할 이름을 쓰고, 공용 디자인 변수는 기존 생성 규칙인 `--wiki-*`를 그대로 사용합니다.

### 11.5 생성 시 적용 예와 점검

```text
pages/ReviewPage.tsx
features/review-source-claim/ui/ReviewSourceClaim.tsx
features/review-source-claim/model/useReviewSourceClaim.ts
features/review-source-claim/api/reviewSourceClaim.queries.ts
features/review-source-claim/api/reviewSourceClaim.mutations.ts
features/record-expert-policy/ui/RecordExpertPolicy.tsx
domains/knowledge/model/claim.types.ts
domains/knowledge/ui/ClaimEditForm.tsx
domains/knowledge/ui/ClaimEditForm.module.scss
domains/knowledge/ui/EvidenceExcerpt.tsx
domains/review/model/reviewDecision.types.ts
domains/review/ui/ReviewStateBadge.tsx
```

이는 배치/이름 예시이며 생성된 제품 파일 목록이 아닙니다. feature는 ui/model/api 역할별로 배치하며 실제 구현이 있는 폴더만 만듭니다. ClaimEditForm은 props로 값/검증/의도를 받고, 원문 검토와 전문가 판단의 실제 command는 각각의 feature가 소유합니다. 테스트가 필요한 기능을 구현할 때 해당 `*.test.ts(x)`를 함께 둡니다.

생성 전에는 화면/공용 책임이 어디인지, 같은 역할의 기존 컴포넌트가 있는지, 이름만으로 업무 대상/역할이 드러나는지 확인합니다. `NewClaimCard`, `ClaimCard2`, `FinalPanel`, `AiComponent`, `LLMWikiCommonWrapper` 같은 시간·번호·기술 중심 이름을 피합니다. 이름이 계속 길어지면 무조건 축약하기보다 그 컴포넌트의 책임을 다시 나눕니다. 실제 버전이 다른 서버 스키마를 뜻하는 타입명은 별도이며 UI 수정 순서를 이름에 넣는 경우와 구분합니다.

### 11.6 Electron 계약과 코드 작성

| 대상 | 규칙 | 예 |
| --- | --- | --- |
| 클래스와 해당 파일 | PascalCase 일치. 객체 수명이 필요할 때만 클래스 사용 | `WikiApiClient.ts` → `WikiApiClient` |
| IPC 계약 파일 | 업무 대상 + `.contract.ts` | `documents.contract.ts`, `terminal.contract.ts` |
| 요청/결과/이벤트 타입 | 구체 동작 + `Request/Response/Event` | `ReadDocumentRequest`, `ReadDocumentResponse`, `TerminalOutputEvent` |
| IPC 채널 | 소문자 `업무:동작` / `업무:이벤트` | `documents:read`, `terminal:output` |
| bridge 함수 | 구체 동작의 camelCase, 허용 작업별로 노출 | `wiki.documents.read`, `wiki.terminal.onOutput` |
| 모듈 상수 | 고정 규약/한도는 UPPER_SNAKE_CASE, 일반 값/객체는 camelCase | `IPC_CHANNELS`, `MAX_OUTPUT_BYTES`; `documentKeys`는 기존 규칙 유지 |
| 실제 앱 흐름 검사 | 시나리오 kebab-case + `.spec.ts` | `document-reading.spec.ts` |

채널 문자열과 계약의 단일 원본은 shared/contracts이며 main과 preload에서 복사하지 않습니다. 위 이름은 앱 내부 규칙/예시이며 서버의 HTTP 경로·MCP 도구 이름을 바꾸지 않습니다.

코드 식별자는 영어, 역할/중요한 선택의 설명은 한국어로 씁니다. 제품 문구는 현재 한국어 시안을 따르고 다국어 체계를 미리 도입하지 않습니다. 수기 TS/TSX는 공백 2칸·작은따옴표·세미콜론·LF를 기본으로 하며 Oxfmt 설정을 기준으로 맞춥니다. JSON과 생성 토큰은 해당 형식/생성기 규칙을 유지합니다.

컴포넌트/일반 함수는 named export를 기본으로 하고, 파일 최상위의 import만으로 창·PTY·구독·네트워크를 시작하지 않습니다. props와 판별 union은 `type`을 기본으로 하며 외부 계약의 선언 병합이 필요한 경우에 `interface`를 사용합니다. 상태 값은 의미 있는 문자열 union으로 표현하고 같은 상태를 상충하는 boolean이나 별도 enum 사본으로 중복 정의하지 않습니다.

생산 모듈의 역할과 공개 경계의 입력/결과·상태 수명을 짧게 설명합니다. tenant 전환·초안/CAS·IPC 검사·구독 해제의 이유처럼 코드만으로 알기 어려운 선택에 주석을 두며 매 줄을 번역하지 않습니다. UI의 표시/초안 검증은 서버 인가·정책·저장 검증을 대체하지 않습니다. 파일이 길어지면 독립 책임과 수명부터 검토하되 줄 수를 맞추기 위한 쪼개기나 빈 추상 계층을 만들지 않습니다.

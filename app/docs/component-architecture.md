# React 프로젝트 구조·개발 규칙과 컴포넌트 설계

현재 앱의 책임·의존 방향·상태 수명·명명 규칙을 관리합니다. 실제 명령은 [앱 README](../README.md), 대상·주소·복귀는 [IA](../../docs/domains/ui/INFORMATION_ARCHITECTURE.md), 표현·조작·검수는 [UI RULES](../../docs/domains/ui/RULES.md), 구현 상태와 검증은 [PLAN](../../docs/domains/ui/PLAN.md)·[HISTORY](../../docs/domains/ui/HISTORY.md)를 따릅니다. 초기 설계와 선택 이유는 [D-045](../../docs/domains/ui/DECISIONS.md#d-045--electron-앱의-디자인-토큰과-react-컴포넌트-경계-2026-10-24)에 남아 있습니다.

## 1. 분리 기준과 데이터 흐름

컴포넌트는 업무 책임·독립된 상태 수명·재사용 필요에 따라 나눕니다. 줄 수나 CSS 상자 수를 맞추려고 파일을 분할하지 않습니다.

```text
UI 의도 → feature hook/adapter → platform → preload bridge → main → 일반 HTTP API
AI 실행 → main의 개인 CLI → MCP → 같은 백엔드의 업무 서비스
서버 결과 → 검증된 IPC 응답 → 조회/작업 상태 → 표시 UI
```

- `AppShell`은 탐색·패널·공통 상태, page는 feature 조합·이동, feature는 입력부터 확인된 결과까지의 작업을 맡습니다. 표시 UI는 props와 callback을 사용합니다.
- 파생 목록·건수·선택 객체·그래프는 원본과 선택 ID에서 계산합니다. props를 Effect로 state에 복사하지 않고, 편집 시작 시에만 기준 snapshot과 초안을 만듭니다.
- Effect는 구독·observer·외부 자원 연결에 사용하고 cleanup을 함께 둡니다. 필터·집계·상태 판정은 순수 함수로 처리합니다. `memo/useMemo`는 측정한 비용을 줄일 때 사용합니다.
- 안정된 ID를 `key`로 사용합니다. 전역 DOM 분기·`innerHTML`·원문 HTML 실행으로 상태를 관리하지 않습니다. 만능 hook·카드·전역 store에 업무를 모으지 않습니다.

## 2. 구현 위치와 의존 방향

`app/`은 하나의 앱 패키지입니다. main/preload/renderer·공유 계약을 구분하며 Python 서버는 `core/`에 둡니다. 실제 구현이 필요한 폴더만 만들고 별도 패키지·빈 계층을 미리 추가하지 않습니다.

```text
화면·업무: app → pages → features → domains → renderer/shared
외부 연결:                  features → platform → src/shared/contracts
```

feature끼리 직접 import하지 않습니다. domain은 feature/page 또는 다른 domain의 실행 코드·상태·UI를 직접 호출하지 않습니다. 여러 domain은 feature가, 여러 feature는 page가 조합합니다. 공통 식별·판본의 직렬화 형태는 contracts로 공유합니다. `shared/ui/theme/lib`에는 업무 정책과 tenant 상태를 넣지 않습니다.

### 2.1 앱 단위와 Electron 책임

| 위치 | 책임 |
| --- | --- |
| `main/index.ts`, `main/windows/` | 앱 조립·시작/종료, 창 생성·탐색·수명 |
| `main/ipc/` | 허용 채널·호출자·입력 검증과 결과 직렬화 |
| `main/backend/` | HTTP 응답 검사, 업무 요청·개인 실행의 수명과 오류 처리 |
| `main/settings/` | 연결·개인 실행 설정과 보호된 자격 증명 |
| `preload/` | 명시한 작업·구독만 노출하는 `contextBridge` |
| `shared/contracts/` | 런타임 중립 IPC 요청·결과·이벤트·검사 |
| `renderer/platform/` | 실제 bridge 접근을 감싼 제한된 adapter |

renderer는 Node 파일·프로세스·인증 토큰·MCP client와 main/preload 구현을 직접 참조하지 않습니다. `window.wiki` 접근은 platform이 맡습니다. app provider는 adapter를 조립할 수 있지만 page/domain/표시 UI가 bridge를 직접 호출하지 않습니다. `contextIsolation: true`, `nodeIntegration: false`, renderer sandbox와 main의 sender/입력 검증을 유지하며 범용 `send/invoke`·shell 실행을 공개하지 않습니다.

### 2.2 feature 내부 구조와 공용화

| 위치 | 책임·허용 의존 |
| --- | --- |
| `ui/` | 입력·진행·실패·결과 조합. 자기 hook과 domain/shared UI 사용 |
| `model/` | 초안·기준·작업 조정·순수 계산. 자기 adapter와 domain 모델 사용 |
| `api/` | gateway 호출·조회 key·명시 변경·결과 변환. platform/domain/contracts 사용 |
| `domains/<영역>/model/` | 업무 모델·표시/초안용 순수 규칙. contracts/shared 사용 |
| `domains/<영역>/ui/` | 자기 모델의 재사용 표현. 조회·저장·작업 상태를 소유하지 않음 |
| `platform/` | bridge와 contracts의 연결. domain/feature 표시 모델을 참조하지 않음 |
| `shared/` | 업무 중립 UI·테마·책임이 명확한 기술 함수 |

- feature는 동작·대상으로 이름 짓고 실제 파일이 있는 `ui/model/api`만 만듭니다. 입력 의미와 완료 결과가 다른 흐름을 공통 API나 입력 위젯만 보고 합치지 않습니다.
- 참조는 `UI → hook → adapter → platform` 방향입니다. UI가 HTTP를 호출하거나 model/api가 UI를 import하지 않습니다. 순수 domain 모델에는 React·조회 라이브러리·외부 I/O를 넣지 않습니다.
- 작업 전용 초안은 feature가, 같은 업무 의미의 재사용 모델/UI는 소유 domain이 맡습니다. 폼·표시의 일부 중복은 허용하며 서버 인가·정책·CAS를 프런트에 재구현하지 않습니다.
- 외부 진입은 필요한 named export의 `index.ts`로 제한합니다. 내부에서는 자기 barrel을 거치지 않습니다. 다른 domain의 표현은 feature가 props/slot/callback으로 조합합니다. 전역 `types.ts`·만능 utils·빈 wrapper를 만들지 않습니다.

### 2.3 계약·타입·import 경계

HTTP 계약, IPC 계약, domain 모델, 작업용 표시 모델을 구별합니다. main은 서버 응답을 검사하고 필드를 명시적으로 매핑합니다. 누락/널·한정어·완전성·오류·출처·revision을 보존하며 표시 모델을 쓰기 payload로 역변환하지 않습니다.

IPC는 직렬화 가능한 명시 객체·배열·원시값과 오류 code/detail을 사용합니다. 함수·DOM·프로세스 핸들·클래스 인스턴스·인증 비밀은 payload에 넣지 않습니다. preload의 구독 해제 함수는 bridge 동작입니다.

TypeScript `strict`, `unknown`에서의 외부 입력 검사, `import type`을 유지합니다. renderer에 Node 전역 타입을 열지 않고 공통 계약은 브라우저/Node 전용 타입에 의존하지 않습니다. 같은 모듈 내부는 상대 import, 경계를 넘을 때는 `@renderer/*`·`@contracts/*`를 사용합니다. `@main/*`는 main 내부에만 열며 alias는 접근 허가를 대신하지 않습니다.

### 2.4 테스트 위치와 구현 점검

현재 `app/tests/`의 해당 검사와 `config/`의 타입·Oxc·빌드 설정을 재사용합니다. 단위 검사가 필요한 새 모듈은 대상 옆 `*.test.ts(x)`를 사용할 수 있습니다. Python 저장·권한 검사는 `core/tests/`에 둡니다. 고정 입력은 실제 검사에 필요한 것만 만들고 시안의 모의 결과를 제품 초기 데이터로 넣지 않습니다.

변경 범위의 타입·import 경계·토큰 정합성과 사용자 행동·실패/충돌·구독 해제를 확인합니다. 스타일 수정에 구현을 복제한 검사를 추가하지 않습니다. 명령은 실제 package scripts/README, 검증 결과는 HISTORY에서 관리합니다.

### 2.5 domain별 모델 소유권

아래는 업무 의미의 소유권이며 폴더 생성 목록이 아닙니다. 현재 분리된 domain은 `documents`·`templates`이고 다른 작업 모델은 기존 feature에서 관리합니다. 서버 정책·판정·원장·CAS·버전 발급은 백엔드 책임입니다.

| 업무 | 소유 의미 | 구별할 경계 |
| --- | --- | --- |
| documents | Wiki 전체 본문·본문 revision·전체 수정 이력 | 원본 파일 판본·추출/검토 상태와 구별 |
| knowledge | 개체·주장·관계/속성·한정어·출처·그래프·근거 참조 | 현재성/부분 범위를 보존하며 승인·조건 충족을 계산하지 않음 |
| review | 원문 검토·전문가 정책·대응 판단·각 이벤트 | Claim 자체·원문 수정·정책 판단의 권한과 근거를 합치지 않음 |
| sources | 원본 메타데이터·불변 판본·변환 제출·원본/Wiki 계보 | 실제 파일 보관은 서버/main, Wiki revision은 documents |
| templates | 등록 템플릿·고정 판본·생성 지원 범위 | 관리 초안은 manage-templates, 질문 snapshot·결과 파일은 chat-with-knowledge |
| analysis | job/run·단계 영수증·고정 입력·규약·결과 참조 | CLI 출력/생존과 저장 완료를 구별 |
| access | 확인된 주체·소속·허용 공간/관점·행동·정책 기준 | 인증 비밀·실제 인가·보호 저장은 서버/main |

식별·판본의 직렬화 형태는 `src/shared/contracts/`에 한 번 정의하고 의미 해석은 소유자가 맡습니다. 복합 표시 모델은 feature가 조합하며 원본 revision·근거·범위를 보존합니다. 이력은 원래 자료/판단/작업에 귀속하고 전역 history 모델로 복제하지 않습니다. 편집 초안·고정 질문/비교 context도 해당 feature가 소유합니다.

### 2.6 feature별 입력과 완료 결과

자료 작업은 서버·주체·workspace와 필요한 허용 profile을 고정합니다. 변경 작업은 읽은 본문·그래프·검토 기준을 함께 보관합니다. scope나 revision 값만 바꿔 오래된 요청을 재전송하지 않습니다.

| 작업 | 입력 | 확인할 결과 |
| --- | --- | --- |
| 목록·검색·읽기 | 대상·검색 조건·현재/지정 판본·허용 범위 | 정확한 본문/참조와 부분·누락·페이지 상태. 읽기 실패는 빈 결과가 아님 |
| 본문·판단 변경 | 실제 읽은 기준·사용자 초안·이유·출처/한정어 | 새 revision/event/state와 영수증. 원문 검토와 전문가 정책은 별도 command |
| 등록·분석 | 원본/보고 판본·본문 기준·고정 입력·명시 실행 | source/job/run·파생 Wiki/그래프와 단계별 저장 결과. 부분 성공 보존 |
| 비교·이력 | 두 snapshot·비교 범위 또는 사건/선택 판본 | 당시 값·근거·대응·미발견 상태. 조회가 적용/복원을 실행하지 않음 |
| 질문·산출물 | 고정 질문·근거/템플릿 판본·실행 context | 저장 답변·인용·지원 파일 또는 추가 질문 대기. 생성 미리보기와 구별 |
| 연결·개인 실행 | 연결 초안·main의 보호 인증·허용 공간·CLI 선택 | API 연결과 AI 로그인/MCP 준비·실행을 각각 실제 확인 수준으로 표시 |

저장 성공 뒤 재조회 실패는 성공 저장과 확인 대기로 나눕니다. 결과 미확인·충돌·`storage_busy`·정리 경고를 구별하고 자동 재저장하지 않습니다. 취소/실패에도 원래 scope·초안·저장된 단계를 보존합니다. 문서 등록의 최종 완료는 Wiki 저장과 온톨로지 구성까지이며, 현행 구현과 새 흐름의 차이는 [UI PLAN](../../docs/domains/ui/PLAN.md#문서-등록-목표와-시안)을 따릅니다.

## 3. 앱 프레임과 화면 경로

```text
main.tsx (StrictMode · HashRouter)
└─ App → WorkspaceLogin → AppShell → RetainedWorkspace → Routes
```

인증·소속 확인 전에는 업무 화면을 마운트하지 않습니다. 최초 연결은 tenant 없는 상태를 지원하며 임의 기본 사용자·이전 자료를 주입하지 않습니다. 실제 주소·선택·뒤로가기·호환 경로는 [IA](../../docs/domains/ui/INFORMATION_ARCHITECTURE.md)를 따릅니다. URL은 권한이 아니며 비밀·긴 원문·파일 바이트를 넣지 않습니다.

화면 전환·패널 숨김은 작업 종료나 초안 폐기가 아닙니다. 경로와 같은 선택값을 독립 state에 중복 저장하지 않고, 대상/판본이 사라지면 재선택을 안내합니다. 보호 설정·진단은 main, 비밀 없는 설정 초안은 해당 feature가 맡습니다.

## 4. 공용 컴포넌트의 계약

전역 스타일은 `.scss`, 컴포넌트 스타일은 `.module.scss`, 생성 디자인 값은 기존 CSS 변수로 관리합니다. 실제 `shared/ui/`와 `WorkspacePage`·`WorkspaceSection`·`ReadingProperties`를 재사용하며 모든 화면에 같은 패널 수를 강제하지 않습니다.

- Button/Field/Tabs는 네이티브 props/ref·접근 이름·라벨/도움말/오류 연결·키보드 의미를 보존합니다. 제출/일반 행동/이동을 구별하고 업무 저장·권한·테마를 소유하지 않습니다.
- 패널·알림은 slot과 상태/행동 props로 합성합니다. 읽기 실패·빈 결과·부분 결과·저장 미확인을 구별합니다. 숨긴 패널은 초안을 유지하되 focus·접근성 트리에서 제외합니다.
- Claim·Qualifier·근거 표현은 방향·단위·조건·양태·출처와 보이지 않는 편집 필드를 보존합니다. 원문 인용과 전문가 Action log는 별도 종류로 받습니다.
- 비교는 두 본문/ref를 표시하며 차이만으로 삭제 원인이나 AI 누락을 판정하지 않습니다. 저장 결과·초안 보호는 기준 변경/정리 경고/결과 확인 대기를 구별합니다.
- 치수·배치·키보드·업무 모달 제한은 [UI RULES](../../docs/domains/ui/RULES.md)를 따릅니다. 공용 UI를 도입하면서 새 승인·자동 실행을 추가하지 않습니다.

## 5. 화면별 분해와 책임

현재 기능 폴더를 찾는 색인입니다. 입력부터 확인된 결과까지의 책임은 2.6절, 실제 주소와 복귀는 IA를 따릅니다.

| feature | 책임 |
| --- | --- |
| `browse-document-library`, `manage-document-content` | 문서 목록·선택, 본문/메타정보 편집·이력·비교·복원 |
| `import-document-content`, `browse-document-tasks` | 원본/텍스트 등록·변환·분석, 기기 작업 목록·상세·복구 |
| `review-source-notifications` | 서버 알림·보관 문자 검토/승인과 공유 작업 연결 |
| `explore-ontology-map`, `browse-review-queue` | 개념/관계 탐색·근거·정정/판단, 검토할 대상 발견 |
| `review-analysis-proposals`, `inspect-document-connections` | 추출안·비교·명시 적용, 문서 대응의 기존 기능 |
| `chat-with-knowledge`, `create-document-artifact` | 대화/추가 질문·실행·답변 근거, 결과 초안·파일 |
| `browse-ai-sessions`, `configure-workspace-tools` | 기기 실행/저장 기록, 서버/계정·개인 AI 설정 |
| `manage-templates` | 템플릿 등록·고정 판본·파일/지침 편집 |

폴더 존재와 활성 메뉴 노출은 다릅니다. 숨겨 둔 문서 대응·관점 선택을 이 표를 근거로 다시 노출하지 않습니다.

## 6. 상태의 유일한 원본

| 소유자 | 상태 |
| --- | --- |
| Router | 화면·선택 대상·탭·명시 이력 참조 |
| 조회 cache | 서버 문서/원본/작업/그래프/검토·영수증. 현재 조회와 지정 판본을 구별 |
| feature hook·유지된 작업 화면 | 편집 초안·기준 snapshot·질문/작업 흐름 |
| 컴포넌트 local state | focus·일회성 메뉴·공유하지 않는 입력 |
| 순수 selector | 목록·집계·표시 그래프·선택 객체 |
| main·기존 보호 저장 | 개인 프로세스·연결·범위별 복구 기록 |

Jotai는 사용하지 않습니다. 화면을 넘는 초안은 기존 작업 화면·보호 저장으로 보존하고, 같은 초안을 여러 store에 Effect로 계속 복사하지 않습니다. 입력마다 전체 앱이 구독되지 않도록 수명을 나눕니다.

요청·cache key는 서버·주체·workspace·정책 기준과 필요한 profile/문서/판본을 포함합니다. 범위 전환 시 이전 응답·구독을 무효화하고, 보존 초안은 원래 범위에서만 접근합니다. 기존 초안의 profile만 바꿔 제출하지 않으며 새 범위에서는 최신 근거를 읽고 재확인합니다. 원문 편집은 전체 본문을 기준으로 합니다.

조회 갱신은 초안을 덮어쓰지 않습니다. 기준이 바뀌면 기존 basis/초안/최신값을 비교합니다. 저장은 명시 이벤트로 실행하고 자동 mutation retry는 기본적으로 끕니다. 성공 후 관련 조회만 갱신하며 결과 확인·정리 경고로 같은 쓰기를 다시 보내지 않습니다.

## 7. 대상·판본을 잇는 표시 계약

화면에는 표시명 대신 범위 있는 참조를 넘깁니다. 실제 타입은 contracts를 따르며 문서 본문 revision·원본 판본·graph/state·event·job/run을 합치지 않습니다. 배열 위치는 영구 수정 ID가 아니고 시안의 판 번호를 실제 revision으로 사용하지 않습니다.

후보·속성·정책·대응은 각 서버 참조 종류와 의존 근거를 유지합니다. 원문 인용과 Action log를 구별하고 질문에는 고정 근거·profile·선택 범위·완전성·정책 event를, 등록에는 원본/본문/규약 기준과 단계 영수증을 연결합니다. 새 규약을 과거 결과에 소급 표시하지 않습니다.

## 8. 개인 실행의 별도 수명

개인 CLI 프로세스와 출력 구독은 main의 확인된 세션을 사용합니다. 화면 숨김·재렌더·Effect 재실행으로 프로세스를 중복 생성하지 않습니다. 출력 표시를 연결하는 Effect에는 구독/observer/인스턴스 cleanup을 둡니다.

출력은 기존 개인 실행 서비스의 표시·보관 범위를 따르며 화면 표시와 서버 저장 결과를 구별합니다. 출력 전체를 React state나 조회 cache에 글자마다 쌓지 않습니다. 화면 전환과 실행 중단을 구별하고 명시 종료는 기존 앱 종료·프로세스 정리 절차를 사용합니다. main/preload는 세션·입력·종료를 검증합니다.

CLI 종료 문구·ANSI 출력은 저장 증거가 아닙니다. 로그인/MCP/권한과 서버의 job/run·영수증·현재 결과를 별도로 확인합니다. 실제 제공자·OS 검증 범위는 [platform PLAN](../../docs/domains/platform/PLAN.md)을 따릅니다.

## 11. 명명 규칙

이 절은 `app/`에서 새 컴포넌트와 관련 파일을 만들 때 적용하는 프로젝트 규칙입니다. 화면별 책임은 5절, 디자인 값은 토큰 원본을 따릅니다. 이름을 정했다는 이유로 빈 컴포넌트나 디렉터리를 미리 생성하지 않습니다.

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

새 이름에도 위 용어를 적용합니다. `Review`와 `Policy`를 `ExpertForm` 하나로 뭉치거나, 원문 파일/변환 본문/Wiki를 모두 `DocumentData`라고 부르지 않습니다. 타입·필드에서도 원본 판본과 본문 revision을 구별합니다.

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
| 조회 key factory | 대상 + `Keys` | `documentKeys`, `claimReviewKeys` |
| 순수 계산/변환 | `build/select/derive/to` + 결과 | `buildDisplayGraph`, `toClaimViewModel` |

`canSubmit` 같은 표시 조건은 실제 서버 권한을 대체하지 않습니다. Query에서 파생되는 `isPending` 등을 같은 이름의 독립 state에 복제하지 않습니다. `handleClick`처럼 DOM 동작만 말하는 이름보다 어떤 업무 의도인지 드러냅니다. `onChange`는 일반 입력에 허용하고, 대상이 여러 개이면 `onQualifierChange`처럼 명확하게 합니다. callback은 `onSelectClaim(ref)`처럼 필요한 값만 올리며 무관한 DOM event나 전체 전역 store를 전달하지 않습니다.

타입에는 `I` 접두사나 모호한 `Data/Info/Object`를 관습적으로 붙이지 않습니다. `DraftContext`처럼 이미 문서에 정의된 명확한 업무 이름은 유지합니다. SCSS Module의 로컬 class는 `root/header/actions` 같은 camelCase 역할 이름을 쓰고, 공용 디자인 변수는 기존 생성 규칙인 `--wiki-*`를 그대로 사용합니다.

### 11.5 생성 시 적용 예와 점검

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

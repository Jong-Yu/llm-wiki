# Electron 앱 작업 규칙

루트 [AGENTS.md](../AGENTS.md)를 따릅니다. 화면/공통 UI는 [ui PLAN](../docs/domains/ui/PLAN.md)·[ui DECISIONS](../docs/domains/ui/DECISIONS.md)의 관련 절만 읽습니다. 업무 모델/전송 계약을 실제로 변경할 때만 루트 경로 표의 해당 도메인을 추가합니다. 아래 설계 문서도 변경과 관련된 절만 확인합니다. 이 폴더의 구현 위치와 참조 방향은 [컴포넌트 설계 2절](docs/component-architecture.md#2-구현-위치와-의존-방향), 업무 모델의 소유권은 [2.5절](docs/component-architecture.md#25-domain별-모델-소유권), 입력부터 결과까지의 feature 경계는 [2.6절](docs/component-architecture.md#26-feature별-입력과-완료-결과)을 따릅니다. 컴포넌트·파일·hook·이벤트의 명명 규칙은 [11절](docs/component-architecture.md#11-명명-규칙)을 따릅니다. 공용 디자인 값은 [토큰 원본](design/tokens.json)에서 관리하며 생성 산출물을 직접 수정하지 않습니다.

새 파일을 만들기 전에 같은 책임의 기존 구현을 확인하고 재사용합니다. 설계 문서의 컴포넌트 이름 목록을 빈 파일로 미리 생성하지 않습니다. 요청받은 구현 범위만 진행하며 구현/실제 연결 완료와 문서상의 설계를 구분합니다.

feature 내부는 [설계 2.2절](docs/component-architecture.md#22-feature-내부-구조와-공용화)에 따라 `ui/`·`model/`·`api/` 역할별로 구분합니다. 실제 구현이 있는 폴더만 만들고 외부에는 `index.ts`로 필요한 named export만 공개합니다.

화면 구현은 [디자인 토큰의 기준 시안](design/tokens.json)의 `source.path`와 해당 화면 설계를 대조합니다. 색상뿐 아니라 패널 배치·너비·정보 밀도·선택 상태·스크롤을 확인하며, API 연동 완료와 디자인 일치를 각각 검증합니다. 미구현 데이터·동작은 시안의 샘플로 채우지 않습니다.

## 주석과 타입

- 컴포넌트·hook·함수에는 역할을 설명하는 짧은 한국어 주석을 작성합니다. 비동기 응답 수명, 보안 경계 등 판단이 필요한 부분에는 이유를 남기며 코드와 함께 갱신합니다.
- 컴포넌트 입력은 이름 있는 `Props` 타입으로 선언합니다. 함수·콜백의 매개변수와 반환 타입은 항상 명시합니다. 예: `(props: ButtonProps): JSX.Element => ...`.
- `any`나 검사 우회용 타입 단언을 사용하지 않습니다. 외부 입력은 `unknown`으로 받고 검증·타입 좁히기를 거쳐 사용합니다. TypeScript `strict`와 Oxc의 타입 표기 검사를 유지합니다.
- 설치된 버전에서 `@deprecated`로 표시된 함수·타입·속성을 사용하지 않습니다. 제공된 대체 항목을 확인해 사용하고, Oxc의 `typescript/no-deprecated` 검사를 유지합니다.

## 폼 상태와 검증

- 여러 입력과 검증이 필요한 폼은 React Hook Form과 Zod를 사용합니다. feature 안에서 스키마를 정의하고 폼 값 타입은 스키마에서 추론합니다. 기존 네이티브 입력 컴포넌트에 register/ref·접근성 오류 표시를 전달합니다.
- 기본값 결정과 연동 필드 변경을 명시적인 함수로 분리하며 긴 `??` 체인으로 초안·서버 상태를 혼합하지 않습니다. 새 연결·허용 범위 변경 시 폼을 초기화하고 비밀 입력은 제출 직후 비웁니다. 서버의 권한·계약 검증은 유지합니다.

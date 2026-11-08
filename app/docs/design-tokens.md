# 앱 디자인 토큰

기준일: 2026-11-07. 현재 앱은 화이트·크림·다크 테마를 제공합니다. **실제 값은 [tokens.json](../design/tokens.json) 한 곳에서 관리**합니다. 기존 시안의 `source.path`·SHA는 최초 출처로 보존하며 이번 변경값은 각 토큰의 `origin: normalized`·`source`에 별도 기록합니다. 그래프의 AI/전문가/후보 색·선 의미는 유지합니다.

제품 표현·검수의 최종 기준은 [UI RULES](../../docs/domains/ui/RULES.md)입니다. 아래 색상표·치수 설명은 현재 토큰과 기존 적용 기준을 설명하며 모든 화면의 실제 일치를 보장하지 않습니다. D-086의 색상 방향에 이어 D-087에서 확정한 목표 팔레트·문자·배치·상태는 RULES 한 곳에서 관리합니다. 2026-10-31 구현에서 목표 팔레트와 공통 치수를 토큰 원본에 반영했습니다. 실제 화면 검증 범위는 UI HISTORY를 따릅니다.

## 범위와 값의 층위

토큰은 시안 추출값, 추출값을 참조하는 공용 의미 별칭, 구현용 제안으로 구성합니다. 각 항목의 `origin/source`와 전체 목록은 JSON 원본을 따르며 생성기가 현재 개수와 등록된 모든 테마의 정합성을 검사합니다. 이는 프로젝트 자체 형식이며 외부 토큰 표준 호환을 주장하지 않습니다.

| 층위 | 이름 예 | 사용 원칙 |
| --- | --- | --- |
| 기초 치수·서체 | `space.12`, `radius.5`, `font.size.13` | 시안의 실제 값 보존. 7/9/13px 등을 임의로 4px 단위로 반올림하지 않음 |
| 의미 색·상태 | `color.surface.canvas`, `color.relation.expert` | 색 이름보다 목적을 사용. 장식용 강조와 원문/전문가/후보 출처를 혼용하지 않음 |
| 화면·업무 컴포넌트 | `layout.intake.inspectorWidth`, `component.relationLabel.background` | 전역 카드 크기 하나로 통일하지 않고 역할별 차이 유지 |

전체 CSS 선언이나 과거 시안 클래스는 이관하지 않습니다. 미사용 이전 `rg-checked/rg-edited` 색은 현재 전문가 관여를 세 종류로 다시 나누는 토큰으로 채택하지 않았습니다. 제안 3개는 지도 배경/선의 레이어 0·1과 모션 축소 0ms입니다. 레이어는 지도 내부 isolation 범위에서만 유효하며 Electron OS 창 순서가 아닙니다.

## 색과 출처 표현

| 용도 | 시안 변수 → 공용 토큰 | 화이트 / 다크 |
| --- | --- | --- |
| 기본 바탕 | `--ow-bg` → `color.surface.canvas` | `#ffffff` / `#1f1f1f` |
| 보조 패널 | `--ow-side` → `color.surface.panel` | `#f7f7f8` / `#191a1c` |
| 비선택 관계 상자 | `--ow-soft` → `color.surface.subtle` | `#f5f6f7` / `#2a2d32` |
| 기본 글자 | `--ow-text` → `color.text.primary` | `#2a2a2a` / `#ececec` |
| 보조 글자 | `--ow-muted` → `color.text.secondary` | `#616161` / `#bdbdbd` |
| 경계 | `--ow-line` → `color.border.default` | `#e5e7eb` / `#3a3d42` |
| 행동/선택 | `--ow-accent` → `color.action.primary` | `#b9431c` / `#4daafc` |
| AI 추출 선 | `--rg-ai` → `color.relation.machine` | `#2563b9` / `#94baff` |
| 전문가 관여 선 | `--rg-expert` → `color.relation.expert` | `#7b3db2` / `#d0a5f0` |
| 연결 후보 선 | `--rg-candidate` → `color.relation.candidate` | `#946114` / `#e8bf79` |

성공/주의/실패와 각 배경, 관계별 배경도 JSON에 있습니다. `color.status.success`는 처리 성공이지 의미적 정확성·전문가 승인 색이 아닙니다. 기계층/검토 반영 계층의 차이는 데이터가 결정합니다. 원문 인용과 전문가 업무 판단의 Action log를 같은 근거로 바꾸지 않습니다.

지도에서는 출처 문구를 각 선에 반복하지 않고 **선 색·형태 + 범례 + 접근 가능한 이름**을 사용합니다. 실선의 기본 폭 1.45, 전문가 관여 1.8, 묶음 2.2, 선택 2.8과 후보 점선 `6 4`를 보존합니다. 전문가 확인·수정·직접 작성은 지도에서 동일한 전문가 스타일을 사용하고, 실제 행위는 상세/이력에 남깁니다. 혼합 출처 묶음은 중립 선과 카드 내 집계로 표시합니다. 색만 보고 혼합 묶음을 전문가 승인으로 추정하지 않습니다.

## 기존 토큰과 적용 기준

| 항목 | 현재 기준과 적용 |
| --- | --- |
| 앱 프레임 | 상단52px, 단일 메뉴208px(접힘60px), 하단 상태줄26px. 900px 미만에서는 메뉴가 기본 접힘이며 명시적으로 펼칩니다. 실제 다중 문서 기능이 없는 탭 모양은 사용하지 않습니다. |
| 화면별 패널 | 검토함은 선택할 때만360~400px 상세를 열고, 선택 전에는 목록이 전체폭을 사용합니다. 온톨로지 목록216px·상세360px, 문서 정보280px를 사용하며 중앙은 `minmax(0, 1fr)`로 남깁니다. 실제 작업 영역에 따라 패널을 전환하고, 읽기 속성은900px 미만에서 본문 뒤 펼침 영역으로 제공합니다. |
| 서체 | UI는 시스템 서체, 터미널은 monospace. 기본 UI13/20px, 정보 구획 제목14/20px, 읽기 본문16/26px, 보조12/18px. 화면 제목과 본문 제목은 역할별 위계를 유지합니다. |
| 공통 정보 구획 | 배경 없는 제목·인접한 행동과 필요한 구분선만 사용합니다. 구획 사이 약24px, 헤더와 본문 사이12px를 기준으로 하며 중첩 테두리/패딩을 피합니다. 중요한 폼 fieldset은 유지합니다. |
| 속성 정보 | 라벨80px/값 남은 폭, 간격8~12px, 최소32px 행. 문서·관계·설정의 같은 종류 속성을 두 열로 정렬합니다. 좁은 폼은 입력이 맞도록 한 열로 바꿀 수 있습니다. |
| 검토 목록 | 기본68px 두 줄 목록에서 상세를 선택하며, 근거·전체 속성·작업은 선택 상세에 표시합니다. 좁은 화면은 목록↔상세 전환과 초점 복귀를 제공하고, 필터 결과에서 선택 항목이 없어지면 상세를 해제합니다. |
| 관계 상자 | 선택 전에도 회색 배경과 경계. 현재 기본 높이 46px, 제목 두 줄까지. 선택 시 강조 배경/경계. 개념 상자는 이름만 표시 |
| 긴 제목/개념 | 목록 한 줄 말줄임, 관계 두 줄 말줄임. 키보드 focus/hover 시 전체 이름, 상세에서는 전체 텍스트. `title` 속성만 유일한 접근 경로로 쓰지 않음 |
| 인용·조건·편집 | `overflow-wrap:anywhere`, `min-width:0`. 인용/조건은 의미를 자르지 않고 본문 패널에서 스크롤. 편집 입력은 clamp하지 않음 |
| 근거 | 단일 `EvidenceExcerpt`의 왼쪽 경계 + 출처/줄. 콜아웃 속 콜아웃을 중첩하지 않음 |
| hover/focus | hover 150ms는 추출값. 키보드 focus는 경계/outline으로 보이고, 모션 축소 시 0ms 제안 적용. disabled의 0.45 opacity와 실제 disabled 의미를 함께 사용 |
| 스크롤 | 독립 탐색이 필요한 작업의 패널 스크롤과 일반 읽기/폼의 페이지 스크롤을 구별. 배치·검수는 [RULES 9절](../../docs/domains/ui/RULES.md#9-반응형스크롤모션)을 따르며 모든 화면에 패널별 스크롤을 강제하지 않음 |

`layout.responsive.*`는 1280×720 지원을 위한 제안값이며 시안 추출값과 구분합니다. 실제 작업 영역의1200/900px 기준과 접힌 화면 목록 폭280px를 소유합니다. `color.button.primaryBackground/Foreground`는 주요 버튼의 강조색과 흰 글자를, `color.action.*`는 링크·선택 강조를 나타냅니다. `color.workbench.*`는 작업 공간의 공통 색을, `layout.workbench.*`는 메뉴·헤더 치수를 소유합니다. `component.control.radius`는6px, `height`는36px, `heightSmall`은32px, `lineHeight`는20px입니다. 이 높이는 기본 배율의 한 줄 컨트롤 외곽 높이이며, 터치 입력 환경은 heightTouch44px를 사용합니다. 읽기760px·등록720px·설정960px·읽기+속성1064px는 layout.content.*에서 관리합니다. 입력 식별 경계는 color.border.control, 중립 hover는 color.surface.hover, 주요 버튼 hover는 color.button.primaryHoverBackground를 사용합니다. 내부 padding·Select 아이콘 박스·클릭 영역·확대 예외는 [RULES 3절](../../docs/domains/ui/RULES.md#3-base-ui)을 따릅니다.

2026-10-31 D-087 적용에서 공통 팔레트·읽기/폼 폭·문자와 터치 치수를 반영해 당시 공통 기준을 정리했으며 현재194개 토큰을 세 테마로 생성합니다. 앞선 패널 정리와 이번 규칙 적용의 검증 결과는 구분합니다. 직접 확인한7개 제품 화면의 출처와 선택 이유는 [D-085 후속 결정](../../docs/domains/ui/DECISIONS.md#실제-제품-화면을-참고한-패널-정리), 실행한 화면 검증과 남은 범위는 [UI 작업 기록](../../docs/domains/ui/HISTORY.md#2026-10-31--실제-제품-참고와-선택-상세-패널-정리)을 따릅니다.

이 표는 현재 디자인의 역할을 설명합니다. 대비·화면 확대·키보드·한글 입력·실제 전문가 사용성은 제품 구현 시 검증해야 하며 토큰 생성 통과로 승인하지 않습니다.

## 코드에서 공용으로 쓰는 방법

[생성기](../scripts/build-design-tokens.mjs)가 [CSS](../src/renderer/shared/theme/tokens.css)와 [TypeScript](../src/renderer/shared/theme/tokens.ts)를 같은 원본에서 만듭니다. CSS 변수 이름은 `--wiki-` + 점을 하이픈으로 바꾼 이름입니다. camelCase는 kebab-case로 바꿉니다. 치수는 CSS에서 px, 기간은 ms, JS에서는 숫자입니다. 그림 선의 폭은 unitless 숫자입니다.

```tsx
// ReadingProperties의 반응형 판별처럼 JS 계산에 같은 원본을 사용합니다.
import { designTokens } from './shared/theme/tokens';
import './shared/theme/tokens.css';

const singleWidth = designTokens.light['layout.responsive.singleWidth'];
const narrow = workspace.getBoundingClientRect().width < singleWidth;
```

```css
.relation-label {
  background: var(--wiki-component-relation-label-background);
  border: var(--wiki-border-width-default) solid var(--wiki-color-border-default);
  border-radius: var(--wiki-component-relation-label-radius);
  min-width: 0;
}
```

루트에 `class="wiki-theme" data-wiki-theme="light|cream|dark"`를 적용하고 AppShell이 사용자의 화이트·크림·다크·시스템 선택을 해석합니다. 로그인 화면은 밝은 테마를 사용합니다. CSS 표현에는 생성된 변수를, JS 계산에는 `designTokens`를 사용합니다. 시안의 `light-dark()`를 CSS 변수·JS에 서로 다른 방식으로 다시 계산하지 않습니다.

관계 상자 높이는 현재 시안의 초깃값입니다. 사용자 글자 확대·긴 조건으로 overflow가 생기면 카드 측정→지도 재배치를 하고 본문을 잘라 문제를 숨기지 않습니다. 지도 좌표·개체별 위치·원문 문구·상태 전이는 디자인 토큰이 아닙니다.

## 테마 등록과 상속

`tokens.json`의 `modes`가 테마 목록의 원본입니다. 각 항목은 표시 이름 `label`, 네이티브 컨트롤의 `colorScheme`(`light` 또는 `dark`), 선택적인 상속 대상 `extends`를 정의합니다. 크림은 `light`를 상속하고 달라지는 색상에만 `value.cream`을 둡니다. 별칭은 참조 대상의 현재 테마 값을 사용하므로 AI 화면도 같은 크림색을 따릅니다.

새 테마는 이 원본에 이름과 색상을 정의한 뒤 생성기를 실행하면 선택지·미리보기·저장값 검사에도 포함됩니다. 생성된 `designThemes`와 `Theme` 타입을 사용하며 별도의 이름 목록을 만들지 않습니다. `system`은 운영체제 설정용 예약 이름입니다. 상속 대상/순환·잘못된 색상 키·누락 값은 생성 단계에서 거부합니다. 기존 저장값 `light`·`dark`·`system`은 유지합니다.

## 수정과 확인

1. 시안의 최종 적용 규칙을 확인하고 JSON의 값/별칭/출처를 수정합니다. 값 변경 없이 새 hash만 붙여 재추출한 척하지 않습니다.
2. `node app/scripts/build-design-tokens.mjs`로 두 산출물을 생성합니다.
3. `node app/scripts/build-design-tokens.mjs --check`로 타입·별칭 누락/순환·CSS 이름 충돌·등록된 모든 테마·산출물 일치를 검사합니다.
4. 원본이 있으면 `--source <절대 경로>`로 고정한 시안 hash도 확인합니다. 실제 색/배치 대조는 별도 검토입니다.

제품 구현에서 새 공통 역할이 생기면 의미 토큰을 추가합니다. 일회성 지도 좌표나 모든 CSS 수치를 공용 토큰으로 올리지 않습니다. 실제 시각·접근성 검증 결과는 [UI HISTORY](../../docs/domains/ui/HISTORY.md), 현재 상태·남은 범위는 [UI PLAN](../../docs/domains/ui/PLAN.md)에 기록합니다.

# 현재 시안에서 추출한 디자인 토큰

기준일: 2026-10-24. 이 문서는 값의 의미·사용 규칙을 담당하고, **실제 값은 [tokens.json](../design/tokens.json) 한 곳에서 관리**합니다. 시안 원본의 절대 경로·SHA-256은 해당 파일의 `source`에 있습니다. 시안의 이전 스타일보다 뒤에서 적용되는 수정 규칙을 우선했습니다. 추출은 소스 대조이며 브라우저의 모든 computed style을 수집한 결과는 아닙니다.

## 범위와 값의 층위

토큰은 시안 추출값, 추출값을 참조하는 공용 의미 별칭, 구현용 제안으로 구성합니다. 각 항목의 `origin/source`와 전체 목록은 JSON 원본을 따르며 생성기가 현재 개수와 두 모드의 정합성을 검사합니다. 이는 프로젝트 자체 형식이며 외부 토큰 표준 호환을 주장하지 않습니다.

| 층위 | 이름 예 | 사용 원칙 |
| --- | --- | --- |
| 기초 치수·서체 | `space.12`, `radius.5`, `font.size.13` | 시안의 실제 값 보존. 7/9/13px 등을 임의로 4px 단위로 반올림하지 않음 |
| 의미 색·상태 | `color.surface.canvas`, `color.relation.expert` | 색 이름보다 목적을 사용. 장식용 강조와 원문/전문가/후보 출처를 혼용하지 않음 |
| 화면·업무 컴포넌트 | `layout.intake.inspectorWidth`, `component.relationLabel.background` | 전역 카드 크기 하나로 통일하지 않고 역할별 차이 유지 |

전체 CSS 선언이나 과거 시안 클래스는 이관하지 않습니다. 미사용 이전 `rg-checked/rg-edited` 색은 현재 전문가 관여를 세 종류로 다시 나누는 토큰으로 채택하지 않았습니다. 제안 3개는 지도 배경/선의 레이어 0·1과 모션 축소 0ms입니다. 레이어는 지도 내부 isolation 범위에서만 유효하며 Electron OS 창 순서가 아닙니다.

## 색과 출처 표현

| 용도 | 시안 변수 → 공용 토큰 | 밝음 / 어두움 |
| --- | --- | --- |
| 기본 바탕 | `--ow-bg` → `color.surface.canvas` | `#ffffff` / `#191b21` |
| 보조 패널 | `--ow-side` → `color.surface.panel` | `#f7f7fa` / `#202229` |
| 비선택 관계 상자 | `--ow-soft` → `color.surface.subtle` | `#f0f1f6` / `#2a2d37` |
| 기본 글자 | `--ow-text` → `color.text.primary` | `#292b38` / `#eef0f6` |
| 보조 글자 | `--ow-muted` → `color.text.secondary` | `#636878` / `#b1b7c9` |
| 경계 | `--ow-line` → `color.border.default` | `#e1e3ec` / `#3c404e` |
| 행동/선택 | `--ow-accent` → `color.action.primary` | `#6751b7` / `#c2b0ff` |
| AI 추출 선 | `--rg-ai` → `color.relation.machine` | `#2563b9` / `#94baff` |
| 전문가 관여 선 | `--rg-expert` → `color.relation.expert` | `#7b3db2` / `#d0a5f0` |
| 연결 후보 선 | `--rg-candidate` → `color.relation.candidate` | `#946114` / `#e8bf79` |

성공/주의/실패와 각 배경, 관계별 배경도 JSON에 있습니다. `color.status.success`는 처리 성공이지 의미적 정확성·전문가 승인 색이 아닙니다. 기계층/검토 반영 계층의 차이는 데이터가 결정합니다. 원문 인용과 전문가 업무 판단의 Action log를 같은 근거로 바꾸지 않습니다.

지도에서는 출처 문구를 각 선에 반복하지 않고 **선 색·형태 + 범례 + 접근 가능한 이름**을 사용합니다. 실선의 기본 폭 1.45, 전문가 관여 1.8, 묶음 2.2, 선택 2.8과 후보 점선 `6 4`를 보존합니다. 전문가 확인·수정·직접 작성은 지도에서 동일한 전문가 스타일을 사용하고, 실제 행위는 상세/이력에 남깁니다. 혼합 출처 묶음은 중립 선과 카드 내 집계로 표시합니다. 색만 보고 혼합 묶음을 전문가 승인으로 추정하지 않습니다.

## 화면·텍스트·상태 규칙

| 항목 | 현재 기준과 적용 |
| --- | --- |
| 기준 화면 | 1920×1080. 상단 52px, 앱 탐색 148px. 시안의 작업 영역 1026px는 2px 창 경계를 뺀 값. 제품에서는 실제 사용 가능한 창 높이로 계산 |
| 화면별 패널 | 지식 280/390px, 문서 316/334px, 등록 280/340px, 검토 큐 290px, 재추출 큐 330px. 초기 크기로 쓰며 분할 패널을 조절해도 중앙은 `minmax(0, 1fr)` 유지 |
| 서체 | UI는 시스템 서체, 터미널은 monospace. 본문 14px, 정보 밀도가 높은 관계 13px, 보조 11/12px. 화면 제목 21/22/23px 차이는 이관 단계에서 해당 역할에 맞춰 사용 |
| 관계 상자 | 선택 전에도 회색 배경과 경계. 현재 기본 높이 46px, 제목 두 줄까지. 선택 시 강조 배경/경계. 개념 상자는 이름만 표시 |
| 긴 제목/개념 | 목록 한 줄 말줄임, 관계 두 줄 말줄임. 키보드 focus/hover 시 전체 이름, 상세에서는 전체 텍스트. `title` 속성만 유일한 접근 경로로 쓰지 않음 |
| 인용·조건·편집 | `overflow-wrap:anywhere`, `min-width:0`. 인용/조건은 의미를 자르지 않고 본문 패널에서 스크롤. 편집 입력은 clamp하지 않음 |
| 근거 | 단일 `EvidenceExcerpt`의 왼쪽 경계 + 출처/줄. 콜아웃 속 콜아웃을 중첩하지 않음 |
| hover/focus | hover 150ms는 추출값. 키보드 focus는 경계/outline으로 보이고, 모션 축소 시 0ms 제안 적용. disabled의 0.45 opacity와 실제 disabled 의미를 함께 사용 |
| 스크롤 | 앱 전체 고정 높이 안에서 목록·지도·상세 각각 스크롤. 1280×720 대응은 공통 패널 전환을 사용하며 전체 글자/화면을 축소하지 않음 |

`layout.responsive.*`는 1280×720 지원을 위한 제안값이며 시안 추출값과 구분합니다. 실제 작업 영역의 1200/900px 기준과 접힌 화면 목록 폭 280px를 소유합니다. `color.button.primaryBackground/Foreground`는 시안 `.ow-primary`의 중성색 버튼을, 기존 `color.action.*`는 링크·선택 강조를 나타냅니다. 자세한 적용과 남은 차이는 [레이아웃 검토](responsive-layout-audit.md)를 따릅니다.

이 표는 현재 디자인을 보존하는 규칙입니다. 대비·화면 확대·키보드·한글 입력·실제 전문가 사용성은 제품 구현 시 검증해야 하며 토큰 생성 통과로 승인하지 않습니다.

## 코드에서 공용으로 쓰는 방법

[생성기](../scripts/build-design-tokens.mjs)가 [CSS](../src/renderer/shared/theme/tokens.css)와 [TypeScript](../src/renderer/shared/theme/tokens.ts)를 같은 원본에서 만듭니다. CSS 변수 이름은 `--wiki-` + 점을 하이픈으로 바꾼 이름입니다. camelCase는 kebab-case로 바꿉니다. 치수는 CSS에서 px, 기간은 ms, JS에서는 숫자입니다. 그림 선의 폭은 unitless 숫자입니다.

```tsx
// 구현 시 사용하는 예시. 실제 컴포넌트는 아직 만들지 않았습니다.
import { designTokens, tokenVars } from './shared/theme/tokens';
import './shared/theme/tokens.css';

const palette = designTokens[mode]; // mode: 'light' | 'dark'
const terminalTheme = {
  background: palette['component.terminal.background'],
  foreground: palette['component.terminal.foreground'],
};
// SVG/React Flow: stroke={palette['color.relation.machine']}
// CSS-in-JS: color: tokenVars['color.text.primary']
```

```css
.relation-label {
  background: var(--wiki-component-relation-label-background);
  border: var(--wiki-border-width-default) solid var(--wiki-color-border-default);
  border-radius: var(--wiki-component-relation-label-radius);
  min-width: 0;
}
```

루트에 `class="wiki-theme" data-wiki-theme="light|dark"`를 적용하고 AppProviders의 단일 테마 선택이 CSS와 그래프/터미널의 `mode`를 함께 바꿉니다. 시스템 테마도 해석 후 이 둘 중 하나를 전달합니다. 자동 OS 감지·테마 Provider는 아직 구현하지 않았습니다. 라이브러리 테마에 별도 색상표를 복사하지 말고 Mantine/React Flow/xterm adapter에서 이 값을 읽습니다. 시안의 `light-dark()`를 CSS 변수·JS에 서로 다른 방식으로 다시 계산하지 않습니다.

관계 상자 높이는 현재 시안의 초깃값입니다. 사용자 글자 확대·긴 조건으로 overflow가 생기면 카드 측정→지도 재배치를 하고 본문을 잘라 문제를 숨기지 않습니다. 지도 좌표·개체별 위치·원문 문구·상태 전이는 디자인 토큰이 아닙니다.

## 수정과 확인

1. 시안의 최종 적용 규칙을 확인하고 JSON의 값/별칭/출처를 수정합니다. 값 변경 없이 새 hash만 붙여 재추출한 척하지 않습니다.
2. `node app/scripts/build-design-tokens.mjs`로 두 산출물을 생성합니다.
3. `node app/scripts/build-design-tokens.mjs --check`로 타입·별칭 누락/순환·CSS 이름 충돌·두 모드·산출물 일치를 검사합니다.
4. 원본이 있으면 `--source <절대 경로>`로 고정한 시안 hash도 확인합니다. 실제 색/배치 대조는 별도 검토입니다.

제품 구현에서 새 공통 역할이 생기면 의미 토큰을 추가합니다. 일회성 지도 좌표나 모든 CSS 수치를 공용 토큰으로 올리지 않습니다. 후속 시각 검증과 접근성 검증의 결과는 [PLAN](../../docs/PLAN.md)에 기록합니다.

# 앱 디자인 토큰

실제 값과 테마 목록은 [tokens.json](../design/tokens.json), 표현·배치·상태·검수 기준은 [UI RULES](../../docs/domains/ui/RULES.md)가 관리합니다. 이 문서는 토큰의 사용·생성 방법을 설명합니다. 적용 상태와 실제 화면 검증은 [UI PLAN](../../docs/domains/ui/PLAN.md)·[HISTORY](../../docs/domains/ui/HISTORY.md)를 따릅니다.

## 범위와 값의 층위

| 층위 | 이름 예 | 사용 원칙 |
| --- | --- | --- |
| 기초 치수·서체 | `space.12`, `radius.5`, `font.size.13` | 출처의 값을 임의로 반올림하지 않음 |
| 의미 색·상태 | `color.surface.canvas`, `color.relation.expert` | 색 이름보다 목적을 사용하며 업무 출처와 장식 강조를 구별 |
| 화면·업무 컴포넌트 | `layout.intake.inspectorWidth`, `component.relationLabel.background` | 역할별 차이를 유지하고 모든 화면을 같은 카드로 통일하지 않음 |

`origin/source`는 추출값·의미 별칭·제안을 구별합니다. 기존 `source.path`·SHA는 최초 출처로 유지하며 변경값의 출처를 별도로 기록합니다. 프로젝트 자체 형식이며 외부 토큰 표준 호환을 뜻하지 않습니다. 지도 내부 레이어는 해당 isolation 범위에서만 유효하고 OS 창 순서가 아닙니다.

## 색과 출처 표현

색상값·선 폭·점선 패턴은 JSON 원본에서 읽습니다. `color.relation.machine/expert/candidate`는 AI 추출·전문가 관여·미확정 후보를 구별하며 처리 성공 색은 의미 정확성이나 승인 색이 아닙니다. 전문가 확인·수정·직접 작성은 같은 지도 스타일을 사용하고 실제 행위는 상세/이력에 남깁니다.

지도는 선 색·형태와 범례·접근 이름을 함께 사용합니다. 혼합 출처 묶음은 중립 선과 집계로 표시하고 전문가 승인으로 추정하지 않습니다. 원문 인용과 전문가 Action log도 구별합니다. 관계 상자는 긴 조건·글자 확대에 맞춰 측정·재배치하며 본문을 잘라 overflow를 숨기지 않습니다.

## 코드에서 공용으로 쓰는 방법

[생성기](../scripts/build-design-tokens.mjs)가 [CSS](../src/renderer/shared/theme/tokens.css)와 [TypeScript](../src/renderer/shared/theme/tokens.ts)를 함께 만듭니다. 생성물을 직접 수정하지 않습니다. CSS 변수는 `--wiki-` 뒤 점과 camelCase를 kebab-case로 바꾼 이름을 사용합니다. 치수는 CSS에서 px, 기간은 ms, JS에서는 숫자이며 그림 선 폭은 unitless입니다.

```tsx
import { designTokens } from './shared/theme/tokens';

const singleWidth = designTokens.light['layout.responsive.singleWidth'];
```

```css
.relation-label {
  background: var(--wiki-component-relation-label-background);
  border: var(--wiki-border-width-default) solid var(--wiki-color-border-default);
  border-radius: var(--wiki-component-relation-label-radius);
  min-width: 0;
}
```

루트의 `class="wiki-theme" data-wiki-theme="light|cream|dark"`와 AppShell이 사용자 테마 선택을 적용합니다. CSS는 생성 변수, JS 계산은 `designTokens`를 사용하며 색과 치수를 별도로 재계산하지 않습니다. 주요 버튼은 `color.button.*`, 링크·선택은 `color.action.*`, 공통 프레임은 `color.workbench.*`·`layout.workbench.*`, 읽기/폼 폭은 `layout.content.*`, 컨트롤은 `component.control.*`의 역할을 따릅니다.

## 테마 등록과 상속

`modes`는 표시 이름 `label`, 네이티브 `colorScheme`, 선택적 `extends`를 정의합니다. 크림은 `light`를 상속하고 다른 색만 `value.cream`에 둡니다. 별칭은 현재 테마의 참조값을 사용합니다.

테마를 추가할 때는 원본을 수정하고 생성된 `designThemes`·`Theme`를 사용합니다. 별도 이름 목록을 만들지 않습니다. `system`은 OS 설정용 예약 이름이며 기존 저장값 `light`·`dark`·`system`은 유지합니다. 잘못된 상속·순환·색 키·누락 값은 생성 단계에서 거부합니다.

## 수정과 확인

1. UI RULES의 관련 기준과 현재 화면을 확인하고 JSON의 값·별칭·출처를 수정합니다. 값 변경 없이 hash만 갱신하지 않습니다.
2. `node app/scripts/build-design-tokens.mjs`로 생성합니다.
3. `node app/scripts/build-design-tokens.mjs --check`로 타입·별칭·이름 충돌·테마·산출물 일치를 확인합니다.
4. 출처 원본이 있으면 `--source <절대 경로>`로 고정 hash를 검사합니다. 실제 화면·대비·확대·키보드 검증은 UI RULES를 따릅니다.

새 공통 역할만 의미 토큰으로 추가합니다. 일회성 지도 좌표·개체 위치·원문·상태 전이나 모든 CSS 수치를 토큰으로 올리지 않습니다. 생성 통과를 실제 시각·접근성 검증 완료로 취급하지 않습니다.

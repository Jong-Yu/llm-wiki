import { useState } from 'react';
import type { JSX, KeyboardEvent, PointerEvent, Ref } from 'react';
import type {
  LayoutEdge,
  LayoutNode,
  MapRectangle,
  OntologyLayout,
} from '../model/buildOntologyLayout';
import styles from './OntologyMinimap.module.scss';

type OntologyMinimapProps = {
  ref: Ref<HTMLElement>;
  layout: OntologyLayout;
  visible: MapRectangle;
  coveredRight: number;
  selectedConceptKey: string | null;
  onNavigate: (x: number, y: number) => void;
};
type Projection = { scale: number; x: number; y: number };
type MinimapDrag = {
  pointerId: number;
  projection: Projection;
  offsetX: number;
  offsetY: number;
};
const width = 180;
const height = 108;
const padding = 8;

/** 불러온 지도의 배치와 현재 화면을 함께 표시하고 같은 카메라를 이동합니다. */
export function OntologyMinimap({
  ref,
  layout,
  visible,
  coveredRight,
  selectedConceptKey,
  onNavigate,
}: OntologyMinimapProps): JSX.Element {
  const [drag, setDrag] = useState<MinimapDrag | null>(null);
  // 지도 밖으로 이동해도 현재 위치를 잃지 않도록 화면 범위까지 축소도에 포함합니다.
  const left = Math.min(0, visible.x);
  const top = Math.min(0, visible.y);
  const right = Math.max(layout.width, visible.x + visible.width);
  const bottom = Math.max(layout.height, visible.y + visible.height);
  const scale = Math.min(
    (width - padding * 2) / (right - left),
    (height - padding * 2) / (bottom - top),
  );
  const projection = drag?.projection ?? {
    scale,
    x: (width - (right - left) * scale) / 2 - left * scale,
    y: (height - (bottom - top) * scale) / 2 - top * scale,
  };

  /** SVG의 반응형 크기를 되돌려 축소도 좌표를 실제 지도 좌표로 변환합니다. */
  function worldPoint(
    event: PointerEvent<SVGSVGElement>,
    basis: Projection,
  ): { x: number; y: number } {
    const frame = event.currentTarget.getBoundingClientRect();
    return {
      x:
        (((event.clientX - frame.left) * width) / frame.width - basis.x) /
        basis.scale,
      y:
        (((event.clientY - frame.top) * height) / frame.height - basis.y) /
        basis.scale,
    };
  }

  /** 현재 영역은 잡은 지점을 유지해 끌고, 바깥을 누르면 그 위치로 바로 이동합니다. */
  function startDrag(event: PointerEvent<SVGSVGElement>): void {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const point = worldPoint(event, projection);
    const inside =
      point.x >= visible.x &&
      point.x <= visible.x + visible.width &&
      point.y >= visible.y &&
      point.y <= visible.y + visible.height;
    setDrag({
      pointerId: event.pointerId,
      // 이동 중 축소도 범위가 넓어져도 같은 변환을 사용해 드래그가 튀지 않게 합니다.
      projection,
      offsetX: inside ? point.x - visible.x - visible.width / 2 : 0,
      offsetY: inside ? point.y - visible.y - visible.height / 2 : 0,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!inside) onNavigate(point.x, point.y);
  }

  /** 캡처한 포인터만 반영하며 배율·선택·불러온 자료는 그대로 유지합니다. */
  function moveDrag(event: PointerEvent<SVGSVGElement>): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = worldPoint(event, drag.projection);
    onNavigate(point.x - drag.offsetX, point.y - drag.offsetY);
  }

  /** 포인터 취소·해제 뒤에는 다음 이동을 이전 드래그에 연결하지 않습니다. */
  function stopDrag(event: PointerEvent<SVGSVGElement>): void {
    if (drag?.pointerId !== event.pointerId) return;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /** 방향키는 보이는 범위의 일부만큼 이동하고 Home은 현재 중심 개념으로 돌아갑니다. */
  function moveByKeyboard(event: KeyboardEvent<SVGSVGElement>): void {
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    if (event.key === 'Home') {
      event.preventDefault();
      onNavigate(
        layout.topic.x + layout.topic.width / 2,
        layout.topic.y + layout.topic.height / 2,
      );
    } else if (step) {
      event.preventDefault();
      onNavigate(
        visible.x + visible.width / 2 + (step[0] * visible.width) / 10,
        visible.y + visible.height / 2 + (step[1] * visible.height) / 10,
      );
    }
  }

  return (
    <aside
      ref={ref}
      className={styles.root}
      style={{
        right: coveredRight + 12,
        maxWidth: `calc(100% - ${coveredRight + 24}px)`,
      }}
      data-covered={coveredRight > 0}
      aria-label="지도 미니맵"
    >
      <div className={styles.caption}>
        <span>불러온 지도</span>
        <span className={styles.current}>
          <i aria-hidden="true" />
          현재 위치
        </span>
      </div>
      <svg
        className={styles.map}
        viewBox={`0 0 ${width} ${height}`}
        tabIndex={0}
        role="group"
        aria-label="미니맵 이동 영역. 누르거나 드래그, 방향키로 이동. Home으로 중심 개념으로 이동"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag}
        onKeyDown={moveByKeyboard}
      >
        <g
          transform={`translate(${projection.x} ${projection.y}) scale(${scale})`}
          aria-hidden="true"
        >
          {layout.edges.map((edge: LayoutEdge): JSX.Element => (
            <path
              key={edge.key}
              d={edge.path}
              className={styles.edge}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {layout.nodes.map((node: LayoutNode): JSX.Element => (
            <rect
              key={node.key}
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={8}
              className={`${styles.node} ${node.topic ? styles.topic : ''} ${selectedConceptKey === node.key ? styles.selected : ''}`}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <rect
            x={visible.x}
            y={visible.y}
            width={visible.width}
            height={visible.height}
            className={styles.visible}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </svg>
    </aside>
  );
}

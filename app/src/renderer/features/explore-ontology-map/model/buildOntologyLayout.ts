import type {
  MapEdge,
  MapConcept,
  OntologyCanvasGraph,
} from './ontologyMap.types';

export type MapRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};
export type LayoutNode = MapRectangle & {
  key: string;
  concept: MapConcept;
  /** 선택 개념은 0, 들어오는 쪽은 음수, 나가는 쪽은 양수 열입니다. */
  column: number;
  topic: boolean;
};
export type LayoutEdge = {
  key: string;
  assertion: MapEdge;
  from: string;
  to: string;
  path: string;
  /** 관계 이름 알약은 바깥쪽 개념 카드 바로 앞에 놓습니다. */
  pill: MapRectangle;
  /** 선택 개념에서 한 단계 더 떨어진 관계는 옅게 그립니다. */
  far: boolean;
};
export type RelationCount = { label: string; count: number };
export type OntologyLayout = {
  width: number;
  height: number;
  topic: LayoutNode;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** 관계 이름 걸러보기 선택과 무관하게 현재 범위에서 센 관계 이름별 개수입니다. */
  relationCounts: RelationCount[];
  /** 직접 연결된 관계 중 반대편 개념을 이 지도에서 찾지 못한 개수입니다. */
  unresolvedCount: number;
  /** 선택 개념에 직접 이어진 관계 개수입니다. */
  directCount: number;
};
export type OntologyDepth = 1 | 2;

const nodeWidth = 208;
const nodeHeight = 64;
const rowGap = 84;
const columnGap = 150;
const pillHeight = 22;
const pillMaxWidth = 128;

/** 속성을 제외하고 양쪽 끝이 모두 개념으로 확인되는 관계만 지도에 그립니다. */
function drawableAssertions(graph: OntologyCanvasGraph): MapEdge[] {
  const keys = new Set(
    graph.concepts.map((concept: MapConcept): string => concept.key),
  );
  return graph.assertions.filter(
    (assertion: MapEdge): boolean =>
      assertion.collection !== 'attributes' &&
      assertion.object !== null &&
      keys.has(assertion.subject) &&
      keys.has(assertion.object),
  );
}

/** 같은 문서의 실제 개념 키만 연결하며 속성은 관계선으로 바꾸지 않습니다. */
export function connectedAssertions(
  graph: OntologyCanvasGraph,
  focus: MapConcept,
): MapEdge[] {
  return graph.assertions.filter(
    (assertion: MapEdge): boolean =>
      assertion.collection !== 'attributes' &&
      (assertion.subject === focus.key || assertion.object === focus.key),
  );
}

/** 알약 글자 수에 맞춰 폭을 정하되 인접한 카드 사이 통로를 넘지 않게 제한합니다. */
function pillWidth(label: string): number {
  return Math.min(pillMaxWidth, 26 + label.length * 12);
}

/**
 * 선택 개념에서 들어오는 쪽은 왼쪽 열, 나가는 쪽은 오른쪽 열로 넓혀 갑니다.
 * 접지 않고 전부 펼치며, 관계 이름을 고르면 그 관계로 이어진 개념만 남기고 다시 배치합니다.
 */
export function buildOntologyLayout(
  graph: OntologyCanvasGraph,
  focus: MapConcept,
  depth: OntologyDepth,
  relations: ReadonlySet<string>,
): OntologyLayout {
  const byKey = new Map(
    graph.concepts.map((concept: MapConcept): [string, MapConcept] => [
      concept.key,
      concept,
    ]),
  );
  const all = drawableAssertions(graph);
  const allowed = (assertion: MapEdge): boolean =>
    relations.size === 0 || relations.has(assertion.label);
  const column = new Map<string, number>([[focus.key, 0]]);
  for (const direction of [1, -1]) {
    let frontier: string[] = [focus.key];
    for (let step = 1; step <= depth; step++) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const assertion of all) {
          if (!allowed(assertion)) continue;
          const other =
            direction > 0
              ? assertion.subject === key
                ? assertion.object
                : null
              : assertion.object === key
                ? assertion.subject
                : null;
          if (other !== null && !column.has(other)) {
            column.set(other, direction * step);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
  }
  const drawn = all.filter((assertion: MapEdge): boolean => {
    if (!allowed(assertion) || assertion.object === null) return false;
    const from = column.get(assertion.subject);
    const to = column.get(assertion.object);
    return from !== undefined && to !== undefined && to - from === 1;
  });
  const columns = new Map<number, string[]>();
  for (const [key, index] of column) {
    columns.set(index, [...(columns.get(index) ?? []), key]);
  }
  const order = new Map<string, number>();
  for (const keys of columns.values())
    keys.forEach((key: string, index: number): void => {
      order.set(key, index);
    });
  // 연결된 카드들의 평균 순서로 정렬해 선이 서로 덜 꼬이게 합니다.
  const barycenter = (key: string): number => {
    let sum = 0;
    let count = 0;
    for (const assertion of drawn) {
      const other =
        assertion.subject === key
          ? assertion.object
          : assertion.object === key
            ? assertion.subject
            : null;
      if (other === null) continue;
      sum += order.get(other) ?? 0;
      count++;
    }
    return count ? sum / count : (order.get(key) ?? 0);
  };
  for (let round = 0; round < 5; round++)
    for (const keys of columns.values()) {
      keys.sort(
        (a: string, b: string): number => barycenter(a) - barycenter(b),
      );
      keys.forEach((key: string, index: number): void => {
        order.set(key, index);
      });
    }
  const indexes = [...columns.keys()].sort(
    (a: number, b: number): number => a - b,
  );
  const low = indexes[0] ?? 0;
  const high = indexes[indexes.length - 1] ?? 0;
  const span = nodeWidth + columnGap;
  const rows = Math.max(
    1,
    ...[...columns.values()].map((keys: string[]): number => keys.length),
  );
  const height = Math.max(420, rows * rowGap + 90);
  const width = 40 + (high - low) * span + nodeWidth;
  const centerY = height / 2;
  const nodes: LayoutNode[] = [];
  const placed = new Map<string, LayoutNode>();
  for (const index of indexes) {
    const keys = columns.get(index) ?? [];
    keys.forEach((key: string, row: number): void => {
      const concept = byKey.get(key);
      if (!concept) return;
      const node: LayoutNode = {
        key,
        concept,
        column: index,
        topic: key === focus.key,
        x: 20 + (index - low) * span,
        y: centerY + (row - (keys.length - 1) / 2) * rowGap - nodeHeight / 2,
        width: nodeWidth,
        height: nodeHeight,
      };
      nodes.push(node);
      placed.set(key, node);
    });
  }
  const edges: LayoutEdge[] = [];
  for (const assertion of drawn) {
    const a = placed.get(assertion.subject);
    const b = assertion.object ? placed.get(assertion.object) : undefined;
    if (!a || !b) continue;
    const x1 = a.x + a.width;
    const x2 = b.x;
    const y1 = a.y + a.height / 2;
    const y2 = b.y + b.height / 2;
    const middle = (x1 + x2) / 2;
    // 곡선의 바깥 카드 쪽(0.2 또는 0.8 지점) 높이에 알약을 둡니다.
    const t = b.column <= 0 ? 0.2 : 0.8;
    const u = 1 - t;
    const pillY =
      u ** 3 * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y2;
    const w = pillWidth(assertion.label);
    edges.push({
      key: assertion.key,
      assertion,
      from: a.key,
      to: b.key,
      path: `M${x1} ${y1} C${middle} ${y1} ${middle} ${y2} ${x2} ${y2}`,
      pill: {
        x: middle - w / 2,
        y: pillY - pillHeight / 2,
        width: w,
        height: pillHeight,
      },
      far: a.column * b.column > 0,
    });
  }
  // 관계 이름별 개수는 걸러보기 전 기준이라 선택을 바꿔도 숫자가 변하지 않습니다.
  const unfiltered = new Map<string, number>();
  if (relations.size === 0) {
    for (const assertion of drawn)
      unfiltered.set(
        assertion.label,
        (unfiltered.get(assertion.label) ?? 0) + 1,
      );
  } else {
    const wide = buildOntologyLayout(graph, focus, depth, new Set());
    for (const item of wide.relationCounts)
      unfiltered.set(item.label, item.count);
  }
  const relationCounts: RelationCount[] = [...unfiltered]
    .map(([label, count]: [string, number]): RelationCount => ({
      label,
      count,
    }))
    .sort((a: RelationCount, b: RelationCount): number => b.count - a.count);
  const direct = connectedAssertions(graph, focus);
  const topic: LayoutNode = placed.get(focus.key) ?? {
    key: focus.key,
    concept: focus,
    column: 0,
    topic: true,
    x: 20,
    y: centerY - nodeHeight / 2,
    width: nodeWidth,
    height: nodeHeight,
  };
  if (!placed.has(focus.key)) nodes.push(topic);
  return {
    width,
    height,
    topic,
    nodes,
    edges,
    relationCounts,
    unresolvedCount: direct.filter(
      (assertion: MapEdge): boolean =>
        assertion.object === null ||
        !byKey.has(assertion.object) ||
        !byKey.has(assertion.subject),
    ).length,
    directCount: direct.length,
  };
}

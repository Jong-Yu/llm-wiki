import type {
  MapConcept,
  MapEdge,
  OntologyCanvasGraph,
} from './ontologyMap.types';
import type {
  LayoutEdge,
  LayoutNode,
  OntologyDepth,
  OntologyLayout,
  RelationCount,
} from './buildOntologyLayout';

const cardWidth = 208;
const cardHeight = 64;
const rowSpan = 100;
const columnSpan = 382;

/** 시작점에서 이미 읽은 끝점만 따라가며 새 자료를 자동으로 요청하지 않습니다. */
function visibleColumns(
  seeds: string[],
  edges: MapEdge[],
  depth: OntologyDepth,
  relations: ReadonlySet<string>,
): Map<string, number> {
  const neighbors = new Map<
    string,
    { key: string; direction: number; label: string }[]
  >();
  for (const edge of edges) {
    if (edge.object === null) continue;
    const outgoing = neighbors.get(edge.subject) ?? [];
    outgoing.push({ key: edge.object, direction: 1, label: edge.label });
    neighbors.set(edge.subject, outgoing);
    const incoming = neighbors.get(edge.object) ?? [];
    incoming.push({ key: edge.subject, direction: -1, label: edge.label });
    neighbors.set(edge.object, incoming);
  }
  const columns = new Map<string, number>();
  for (const key of seeds) columns.set(key, 0);
  let frontier = [...columns.keys()];
  for (let step = 0; step < depth; step++) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const neighbor of neighbors.get(key) ?? []) {
        if (relations.size > 0 && !relations.has(neighbor.label)) continue;
        const other = neighbor.key;
        if (columns.has(other)) continue;
        columns.set(other, (columns.get(key) ?? 0) + neighbor.direction);
        next.push(other);
      }
    }
    frontier = next;
  }
  return columns;
}

/** 보이는 부분의 연결 묶음마다 중심을 하나만 정해 관련 시작점도 실제 방향대로 놓습니다. */
function componentColumns(
  visible: ReadonlyMap<string, number>,
  edges: MapEdge[],
  roots: string[],
): Map<string, number>[] {
  const neighbors = new Map<string, { key: string; direction: number }[]>();
  for (const edge of edges) {
    if (edge.object === null) continue;
    const outgoing = neighbors.get(edge.subject) ?? [];
    outgoing.push({ key: edge.object, direction: 1 });
    neighbors.set(edge.subject, outgoing);
    const incoming = neighbors.get(edge.object) ?? [];
    incoming.push({ key: edge.subject, direction: -1 });
    neighbors.set(edge.object, incoming);
  }
  const assigned = new Set<string>();
  const components: Map<string, number>[] = [];
  for (const root of [...roots, ...visible.keys()]) {
    if (assigned.has(root) || !visible.has(root)) continue;
    const columns = new Map<string, number>([[root, 0]]);
    const queue = [root];
    assigned.add(root);
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index];
      for (const neighbor of neighbors.get(key) ?? []) {
        if (assigned.has(neighbor.key) || !visible.has(neighbor.key)) continue;
        columns.set(neighbor.key, (columns.get(key) ?? 0) + neighbor.direction);
        assigned.add(neighbor.key);
        queue.push(neighbor.key);
      }
    }
    components.push(columns);
  }
  return components;
}

/** 연결되지 않은 시작점도 같은 지도에 남기고 문서·개체 키마다 카드를 한 번만 놓습니다. */
export function buildExplorationLayout(
  graph: OntologyCanvasGraph,
  focus: MapConcept,
  seeds: string[],
  depth: OntologyDepth,
  relations: ReadonlySet<string>,
): OntologyLayout {
  const concepts = new Map<string, MapConcept>();
  for (const concept of graph.concepts) concepts.set(concept.key, concept);
  concepts.set(focus.key, focus);
  const roots = [...new Set([...seeds, focus.key])].filter(
    (key: string): boolean => concepts.has(key),
  );
  const uniqueEdges = new Map<string, MapEdge>();
  for (const edge of graph.assertions) uniqueEdges.set(edge.key, edge);
  const edges = [...uniqueEdges.values()].filter(
    (edge: MapEdge): boolean =>
      edge.collection !== 'attributes' &&
      edge.object !== null &&
      concepts.has(edge.subject) &&
      concepts.has(edge.object),
  );
  const visible = visibleColumns(roots, edges, depth, relations);
  const wide = visibleColumns(roots, edges, depth, new Set());
  const counts = new Map<string, number>();
  for (const edge of edges)
    if (edge.object !== null && wide.has(edge.subject) && wide.has(edge.object))
      counts.set(edge.label, (counts.get(edge.label) ?? 0) + 1);
  const relationCounts = [...counts].map(
    ([label, count]: [string, number]): RelationCount => ({ label, count }),
  );
  relationCounts.sort(
    (a: RelationCount, b: RelationCount): number =>
      b.count - a.count || a.label.localeCompare(b.label),
  );
  const drawn = edges.filter(
    (edge: MapEdge): boolean =>
      edge.object !== null &&
      visible.has(edge.subject) &&
      visible.has(edge.object) &&
      (relations.size === 0 || relations.has(edge.label)),
  );
  // 여러 시작점의 표시 범위를 먼저 확정하고, 현재 초점이 속한 묶음부터 방향 열을 배정합니다.
  const components = componentColumns(visible, drawn, [focus.key, ...roots]);
  const indexes = components.flatMap(
    (columns: Map<string, number>): number[] => [...columns.values()],
  );
  const low = Math.min(0, ...indexes);
  const high = Math.max(0, ...indexes);
  const width = Math.max(480, 180 + (high - low) * columnSpan + cardWidth);
  const nodes: LayoutNode[] = [];
  const placed = new Map<string, LayoutNode>();
  let rowOffset = 0;
  for (const columns of components) {
    const groups = new Map<number, string[]>();
    for (const [key, column] of columns) {
      const group = groups.get(column) ?? [];
      group.push(key);
      groups.set(column, group);
    }
    const rows = Math.max(
      1,
      ...[...groups.values()].map((group: string[]): number => group.length),
    );
    for (const [column, keys] of groups) {
      keys.forEach((key: string, row: number): void => {
        const concept = concepts.get(key);
        if (!concept) return;
        const node: LayoutNode = {
          key,
          concept,
          column,
          topic: roots.includes(key),
          x: 50 + (column - low) * columnSpan,
          y: 90 + rowOffset + (row + (rows - keys.length) / 2) * rowSpan,
          width: cardWidth,
          height: cardHeight,
        };
        nodes.push(node);
        placed.set(key, node);
      });
    }
    rowOffset += rows * rowSpan + 80;
  }
  const height = Math.max(420, 100 + rowOffset);
  const lanes = new Map<string, number>();
  const laidEdges: LayoutEdge[] = [];
  let curveBottom = height;
  for (const edge of drawn) {
    const a = placed.get(edge.subject);
    const b = edge.object === null ? undefined : placed.get(edge.object);
    if (!a || !b) continue;
    const pair = JSON.stringify([a.key, b.key].sort());
    const lane = lanes.get(pair) ?? 0;
    lanes.set(pair, lane + 1);
    const offset = lane * 24;
    const w = Math.min(146, 28 + edge.label.length * 12);
    let path: string;
    let pillX: number;
    let pillY: number;
    if (a.column === b.column) {
      // 같은 열의 연결·자기 연결은 카드 바깥 곡선으로 그려 누락하지 않습니다.
      const x = a.x + cardWidth;
      const y1 = a.y + (a.key === b.key ? 18 : cardHeight / 2);
      const y2 = b.y + (a.key === b.key ? 48 : cardHeight / 2);
      const bend = x + 70 + lane * 24;
      path = `M${x} ${y1} C${bend} ${y1 - 45} ${bend} ${y2 + 45} ${x} ${y2}`;
      curveBottom = Math.max(curveBottom, y2 + 65);
      pillX = bend - w / 2;
      pillY = (y1 + y2) / 2 - 11 + offset;
    } else {
      const forward = b.column > a.column;
      const x1 = a.x + (forward ? cardWidth : 0);
      const x2 = b.x + (forward ? 0 : cardWidth);
      const y1 = a.y + cardHeight / 2;
      const y2 = b.y + cardHeight / 2;
      const middle = (x1 + x2) / 2;
      path = `M${x1} ${y1} C${middle} ${y1 + offset * 2} ${middle} ${y2 + offset * 2} ${x2} ${y2}`;
      curveBottom = Math.max(curveBottom, Math.max(y1, y2) + offset * 2 + 20);
      pillX = middle - w / 2;
      pillY = (y1 + y2) / 2 - 11 + offset * 1.5;
    }
    laidEdges.push({
      key: edge.key,
      assertion: edge,
      from: a.key,
      to: b.key,
      path,
      pill: { x: pillX, y: pillY, width: w, height: 22 },
      far: !roots.includes(a.key) && !roots.includes(b.key),
    });
  }
  const topic = placed.get(focus.key) ?? nodes[0];
  // focus는 위에서 visible에 항상 포함하므로 빈 지도 fallback을 자료로 만들지 않습니다.
  if (!topic) throw new Error('ontology_focus_missing');
  const direct = [...uniqueEdges.values()].filter(
    (edge: MapEdge): boolean =>
      edge.collection !== 'attributes' &&
      (edge.subject === focus.key || edge.object === focus.key),
  );
  return {
    width: Math.max(
      width,
      ...laidEdges.map(
        (edge: LayoutEdge): number => edge.pill.x + edge.pill.width + 20,
      ),
    ),
    height: Math.max(
      curveBottom,
      ...laidEdges.map(
        (edge: LayoutEdge): number => edge.pill.y + edge.pill.height + 20,
      ),
    ),
    topic,
    nodes,
    edges: laidEdges,
    relationCounts,
    directCount: direct.length,
    unresolvedCount: direct.filter(
      (edge: MapEdge): boolean =>
        edge.object === null ||
        !concepts.has(edge.subject) ||
        !concepts.has(edge.object),
    ).length,
  };
}

import { useId, useState } from 'react';
import type { JSX } from 'react';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { responseGraph } from '../model/explorerPresentation';
import type {
  ExplorerRow,
  GraphNode,
  GraphEdge,
} from '../model/explorerPresentation';
import styles from './WorkspaceExplorer.module.scss';

type ExplorerGraphProps = {
  data: KnowledgeValue;
  focusKey?: string;
  selectedKey?: string;
  onSelect: (row: ExplorerRow) => void;
};
type Point = { x: number; y: number };

/** 카드 테두리에서 선을 시작·종료해 관계의 방향이 카드에 가려지지 않게 합니다. */
function cardBoundary(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const scale = Math.min(
    dx === 0 ? Infinity : 88 / Math.abs(dx),
    dy === 0 ? Infinity : 24 / Math.abs(dy),
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

/** 실제 개체·관계의 선택을 같은 조회 응답의 근거 패널로 전달합니다. 펼침은 조회 범위를 바꾸지 않습니다. */
export function ExplorerGraph({
  data,
  focusKey,
  selectedKey,
  onSelect,
}: ExplorerGraphProps): JSX.Element | null {
  const arrowId = useId();
  const [expandedData, setExpandedData] = useState<KnowledgeValue | null>(null);
  const [overview, setOverview] = useState(false);
  const [zoom, setZoom] = useState(100);
  const expanded = expandedData === data;
  const all = responseGraph(data, Infinity);
  const focused =
    all.nodes.find((node: GraphNode): boolean => node.key === focusKey) ||
    all.nodes[0];
  const connected = all.edges.filter(
    (edge: GraphEdge): boolean =>
      edge.subject === focused?.key || edge.object === focused?.key,
  );
  const connectedKeys = new Set(
    connected.flatMap((edge: GraphEdge): string[] => [
      edge.subject,
      edge.object,
    ]),
  );
  if (focused) connectedKeys.add(focused.key);
  const graph = overview
    ? responseGraph(data, expanded ? Infinity : 20)
    : {
        nodes: all.nodes.filter((node: GraphNode): boolean =>
          connectedKeys.has(node.key),
        ),
        edges: connected,
        totalNodes: all.totalNodes,
      };
  if (graph.nodes.length === 0) return null;
  const incoming = graph.nodes.filter(
    (node: GraphNode): boolean =>
      node.key !== focused?.key &&
      connected.some(
        (edge: GraphEdge): boolean =>
          edge.subject === node.key && edge.object === focused?.key,
      ),
  );
  const outgoing = graph.nodes.filter(
    (node: GraphNode): boolean =>
      node.key !== focused?.key && !incoming.includes(node),
  );
  const columns = overview ? Math.min(3, graph.nodes.length) : 3;
  const height = Math.max(
    480,
    overview
      ? Math.ceil(graph.nodes.length / columns) * 190 + 100
      : Math.max(incoming.length, outgoing.length) * 130 + 200,
  );
  const positions = new Map(
    graph.nodes.map((node: GraphNode, index: number): [string, Point] => [
      node.key,
      {
        x: overview
          ? 120 + (index % columns) * 340
          : node.key === focused?.key
            ? 510
            : incoming.includes(node)
              ? 120
              : 900,
        y: overview
          ? 160 + Math.floor(index / columns) * 190
          : node.key === focused?.key
            ? height / 2
            : incoming.includes(node)
              ? height / 2 +
                (incoming.indexOf(node) - (incoming.length - 1) / 2) * 130
              : height / 2 +
                (outgoing.indexOf(node) - (outgoing.length - 1) / 2) * 130,
      },
    ]),
  );
  const pairs = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const key = JSON.stringify([edge.subject, edge.object].sort());
    const group = pairs.get(key) || [];
    group.push(edge);
    pairs.set(key, group);
  }
  return (
    <section className={styles.map} aria-label="조회한 개념 연결 지도">
      <header className={styles.mapToolbar}>
        <h3>
          {overview
            ? '조회 범위의 전체 구조'
            : `${focused?.label || '선택 개념'} · 직접 연결`}
        </h3>
        <Button
          variant="secondary"
          aria-pressed={overview}
          onClick={(): void => setOverview(!overview)}
        >
          {overview ? '선택 개념으로 돌아가기' : '전체 구조 보기'}
        </Button>
        {overview && graph.totalNodes > 20 && (
          <Button
            variant="secondary"
            onClick={(): void => setExpandedData(expanded ? null : data)}
          >
            {expanded
              ? '처음 20개만 보기'
              : `조회한 ${graph.totalNodes}개 모두 펼치기`}
          </Button>
        )}
      </header>
      <div className={styles.mapLegend}>
        <span>━ 저장된 관계</span>
        <span>┄ 연결 후보</span>
        <span>관계를 선택하면 근거를 확인합니다</span>
      </div>
      <div className={styles.mapScroll}>
        <svg
          style={{
            width: `${(columns * 340 * zoom) / 100}px`,
            minWidth: `${(columns * 340 * zoom) / 100}px`,
          }}
          viewBox={`0 0 ${columns * 340} ${height}`}
          role="group"
          aria-label={`개체 ${graph.nodes.length}개, 관계·후보 ${graph.edges.length}개`}
        >
          <defs>
            <marker
              id={arrowId}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 Z" fill="currentColor" />
            </marker>
          </defs>
          {graph.edges.map((edge: GraphEdge): JSX.Element | null => {
            const from = positions.get(edge.subject);
            const to = positions.get(edge.object);
            if (!from || !to) return null;
            const peers =
              pairs.get(JSON.stringify([edge.subject, edge.object].sort())) ||
              [];
            const lane = peers.findIndex(
              (peer: GraphEdge): boolean => peer.key === edge.key,
            );
            const bend = (lane - (peers.length - 1) / 2) * 64;
            const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
            const cx = (from.x + to.x) / 2 - ((to.y - from.y) / length) * bend;
            // 같은 행의 먼 끝점을 연결하는 선은 가운데 카드 위로 우회합니다.
            const acrossCard =
              overview && from.y === to.y && Math.abs(from.x - to.x) > 340;
            const cy = acrossCard
              ? from.y - 170 - lane * 68
              : (from.y + to.y) / 2 + ((to.x - from.x) / length) * bend;
            const self = edge.subject === edge.object;
            const start = self
              ? { x: from.x - 35, y: from.y - 24 }
              : cardBoundary(from, { x: cx, y: cy });
            const end = self
              ? { x: from.x + 35, y: from.y - 24 }
              : cardBoundary(to, { x: cx, y: cy });
            const path = self
              ? `M${start.x} ${start.y} C${from.x - 90} ${from.y - 95},${from.x + 90} ${from.y - 95},${end.x} ${end.y}`
              : `M${start.x} ${start.y} Q${cx} ${cy} ${end.x} ${end.y}`;
            const label = self
              ? { x: from.x, y: from.y - 77 }
              : {
                  x: (start.x + 2 * cx + end.x) / 4,
                  y: (start.y + 2 * cy + end.y) / 4,
                };
            return (
              <g
                key={edge.key}
                className={edge.candidate ? styles.candidateEdge : styles.edge}
              >
                <path d={path} markerEnd={`url(#${arrowId})`} />
                <foreignObject
                  x={label.x - 67}
                  y={label.y - 14}
                  width="134"
                  height="28"
                >
                  <button
                    className={styles.graphRelation}
                    type="button"
                    aria-label={`관계 근거 · ${edge.row.document} · ${edge.row.title}`}
                    aria-pressed={selectedKey === edge.row.key}
                    title={`${edge.row.title}${edge.candidate ? ' · 미확정 후보' : ''}`}
                    onClick={(): void => onSelect(edge.row)}
                  >
                    {edge.label}
                  </button>
                </foreignObject>
              </g>
            );
          })}
          {graph.nodes.map((node: GraphNode): JSX.Element | null => {
            const point = positions.get(node.key);
            if (!point) return null;
            return (
              <g key={node.key}>
                <foreignObject
                  x={point.x - 86}
                  y={point.y - 21}
                  width="172"
                  height="42"
                >
                  <button
                    className={[
                      styles.graphNode,
                      !overview && node.key === focused?.key
                        ? styles.focusNode
                        : '',
                    ].join(' ')}
                    type="button"
                    aria-label={`개체 근거 · ${node.document} · ${node.label} · ${node.id}`}
                    aria-pressed={selectedKey === node.row.key}
                    title={`${node.document} · ${node.label} · ${node.id}`}
                    onClick={(): void => onSelect(node.row)}
                  >
                    {node.label}
                  </button>
                </foreignObject>
                <text
                  className={styles.graphDocument}
                  x={point.x}
                  y={point.y + 38}
                >
                  {node.document}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <footer className={styles.mapFooter}>
        <span>
          개체 {graph.nodes.length}개 · 연결 {graph.edges.length}개
          {overview ? ` · 전체 ${graph.totalNodes}개 중` : ''}
        </span>
        <div>
          <Button
            variant="secondary"
            aria-label="지도 축소"
            disabled={zoom <= 50}
            onClick={(): void => setZoom(zoom - 25)}
          >
            −
          </Button>
          <span>{zoom}%</span>
          <Button
            variant="secondary"
            aria-label="지도 확대"
            disabled={zoom >= 200}
            onClick={(): void => setZoom(zoom + 25)}
          >
            +
          </Button>
          <Button variant="secondary" onClick={(): void => setZoom(100)}>
            100%로 복원
          </Button>
        </div>
      </footer>
    </section>
  );
}

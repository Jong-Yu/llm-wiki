import { Icon } from '@renderer/shared/ui/Icon';
import { documentDisplayName } from '@renderer/domains/documents';
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  FocusEvent,
  JSX,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
} from 'react';
import type {
  MapEdge,
  MapConcept,
  OntologyCanvasGraph,
} from '../model/ontologyMap.types';
import { buildExplorationLayout } from '../model/buildExplorationLayout';
import { valueObject } from '../model/buildOntologyGraph';
import { ontologyTermLabel } from '../model/ontologyLabels';
import { buildOntologyLayout } from '../model/buildOntologyLayout';
import type {
  LayoutEdge,
  LayoutNode,
  MapRectangle,
  OntologyDepth,
  OntologyLayout,
  RelationCount,
} from '../model/buildOntologyLayout';
import styles from './OntologyGraphCanvas.module.scss';
import { OntologyMinimap } from './OntologyMinimap';

export type OntologyGraphCanvasProps = {
  /** 지도 머리글 왼쪽에 놓는 선택 개념 표시입니다. */
  heading: ReactNode;
  /** 현재 지도 범위의 조회 안내는 지도 머리글 아래에 둡니다. */
  notices?: ReactNode;
  /** 검색 중심 탐색은 도구를 한 줄에 모으고 여러 시작점을 같은 지도에 유지합니다. */
  exploration?: {
    seeds: string[];
    onSearch: () => void;
    toolbar?: ReactNode;
    onPrevious?: () => void;
    previousName?: string;
  };
  graph: OntologyCanvasGraph;
  focus: MapConcept;
  /** 상세에 열려 있는 관계의 키입니다. */
  selectedKey: string | null;
  /** 상세에 열려 있는 개념의 키입니다. */
  selectedConceptKey: string | null;
  /** 오른쪽 상세가 지도 위에 겹쳐 가리는 폭(px)이며 0이면 가리지 않습니다. */
  coveredRight: number;
  onSelectAssertion: (assertion: MapEdge) => void;
  /** 카드를 한 번 누르면 상세만 열고 지도의 중심은 바꾸지 않습니다. */
  onSelectConcept: (concept: MapConcept) => void;
  /** 카드를 두 번 누르거나 Shift+Enter로 그 개념을 지도의 중심으로 옮깁니다. */
  onMoveConcept: (concept: MapConcept) => void;
  /** 관계 이름 걸러보기를 바꾸면 사라질 수 있는 선택을 닫습니다. */
  onClearSelection: () => void;
  memory: Map<string, OntologyGraphView>;
};
/** 개념 종류 이름에서 항상 같은 색을 만들어, 같은 종류끼리 같은 색 타일을 갖게 합니다. */
function typeColor(type: string): string {
  let hash = 0;
  for (const char of type) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 55% 42%)`;
}
type ViewPosition = {
  x: number;
  y: number;
  zoom: number;
  fit: boolean;
  fitAll?: boolean;
};
export type OntologyGraphView = {
  view: ViewPosition;
  depth: OntologyDepth;
  relations: string[];
};
type DragPosition = { x: number; y: number; view: ViewPosition };
type Origin = MapEdge['origin'];
const origins: Origin[] = ['machine', 'expert', 'candidate'];
const originLabels: Record<Origin, string> = {
  machine: 'AI 추출',
  expert: '검토·판단 반영',
  candidate: '연결 후보',
};
const depthOptions: { value: OntologyDepth; label: string }[] = [
  { value: 1, label: '직접 연결' },
  { value: 2, label: '한 단계 더' },
];
const maxFitZoom = 1.5;
const maxZoom = 2;
/** 단일 클릭은 더블클릭과 구분하려고 짧게 기다린 뒤 상세를 엽니다. */
const clickDelay = 180;
/** 포인터가 잠깐 벗어나도 강조가 깜빡이지 않게 해제를 늦춥니다. */
const leaveDelay = 250;

/** 표시 위치만 CSS로 전달하고 관계·원문 데이터는 변경하지 않습니다. */
function rectangleStyle(rectangle: MapRectangle): CSSProperties {
  return {
    left: rectangle.x,
    top: rectangle.y,
    width: rectangle.width,
    height: rectangle.height,
  };
}

/** 선택 개념 변경은 표시 수명만 새로 시작하며 원본 그래프의 범위를 바꾸지 않습니다. */
export function OntologyGraphCanvas(
  props: OntologyGraphCanvasProps,
): JSX.Element {
  return (
    <OntologyGraphViewport
      key={props.exploration ? 'exploration' : props.focus.key}
      {...props}
    />
  );
}

/** 선택 개념 주변 관계를 모두 펼쳐 보이고 사용자가 지정한 배율은 창 크기가 바뀌어도 유지합니다. */
function OntologyGraphViewport({
  heading,
  notices,
  exploration,
  graph,
  focus,
  selectedKey,
  selectedConceptKey,
  coveredRight,
  onSelectAssertion,
  onSelectConcept,
  onMoveConcept,
  onClearSelection,
  memory,
}: OntologyGraphCanvasProps): JSX.Element {
  const memoryKey = exploration ? 'exploration' : focus.key;
  const remembered = memory.get(memoryKey);
  const [depth, setDepth] = useState<OntologyDepth>(remembered?.depth ?? 1);
  const [relations, setRelations] = useState<string[]>(
    remembered?.relations ?? [],
  );
  const [view, setView] = useState<ViewPosition>(
    remembered?.view ?? {
      x: 0,
      y: 0,
      zoom: 1,
      fit: true,
      fitAll: Boolean(exploration),
    },
  );
  useEffect((): void => {
    memory.set(memoryKey, { view, depth, relations });
  }, [memory, memoryKey, view, depth, relations]);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<DragPosition | null>(null);
  const nodeElements = useRef(new Map<string, HTMLButtonElement>());
  const clickTimer = useRef<number | undefined>(undefined);
  const nodeLeaveTimer = useRef<number | undefined>(undefined);
  const edgeLeaveTimer = useRef<number | undefined>(undefined);
  const marker = useId();
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const minimapRef = useRef<HTMLElement>(null);
  const previousFocus = useRef(focus.key);
  const previousTopicCount = useRef(exploration?.seeds.length ?? 0);
  const previousCoveredRight = useRef(coveredRight);
  const selectedRelations = useMemo(
    (): Set<string> => new Set(relations),
    [relations],
  );
  const layout = useMemo(
    (): OntologyLayout =>
      exploration
        ? buildExplorationLayout(
            graph,
            focus,
            exploration.seeds,
            depth,
            selectedRelations,
          )
        : buildOntologyLayout(graph, focus, depth, selectedRelations),
    [graph, focus, depth, selectedRelations, exploration],
  );
  const zoom = view.fit
    ? Math.min(
        maxFitZoom,
        Math.max(
          exploration && !view.fitAll ? 0.9 : 0.1,
          Math.min(
            (size.width - coveredRight - 24) / Math.max(1, layout.width),
            (size.height - 24) / Math.max(1, layout.height),
          ),
        ),
      )
    : view.zoom;
  // 개념 종류가 한 가지뿐이면 색이 아무것도 구분하지 못하므로 같은 중립 색으로 둡니다.
  const mixedTypes = useMemo(
    (): boolean =>
      new Set(
        graph.concepts.map(
          (concept: MapConcept): string => concept.entity.type,
        ),
      ).size > 1,
    [graph],
  );
  const anchor = exploration
    ? (layout.nodes.find(
        (node: LayoutNode): boolean => node.key === exploration.seeds[0],
      ) ?? layout.topic)
    : layout.topic;
  const position = view.fit
    ? exploration && view.fitAll
      ? {
          x:
            (anchor.x + anchor.width / 2 - layout.width / 2) * zoom -
            coveredRight / 2,
          y: (anchor.y + anchor.height / 2 - layout.height / 2) * zoom,
        }
      : { x: -coveredRight / 2, y: 0 }
    : view;
  const origin = exploration
    ? { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 }
    : { x: layout.width / 2, y: layout.height / 2 };
  const visibleWidth = Math.max(0, size.width - coveredRight);
  const visible = {
    x: origin.x - (size.width / 2 + position.x) / zoom,
    y: origin.y - (size.height / 2 + position.y) / zoom,
    width: visibleWidth / zoom,
    height: size.height / zoom,
  };
  /** 미니맵의 위치를 실제로 보이는 지도 영역 중앙에 맞추고 현재 배율을 보존합니다. */
  function navigateMinimap(x: number, y: number): void {
    setView({
      x: (origin.x - x) * zoom - coveredRight / 2,
      y: (origin.y - y) * zoom,
      zoom,
      fit: false,
    });
  }
  /** 새 시작점으로 이동할 때만 그 카드를 드러내며 관계 페이지 추가는 카메라를 건드리지 않습니다. */
  const revealFocus = useEffectEvent((): void => {
    if (!exploration) return;
    setView({
      x:
        (anchor.x +
          anchor.width / 2 -
          layout.topic.x -
          layout.topic.width / 2) *
        zoom,
      y:
        (anchor.y +
          anchor.height / 2 -
          layout.topic.y -
          layout.topic.height / 2) *
        zoom,
      zoom,
      fit: false,
    });
  });
  useEffect((): void => {
    if (previousFocus.current !== focus.key) revealFocus();
    previousFocus.current = focus.key;
  }, [focus.key]);
  // 새로 함께 보는 개념을 추가했을 때 전체 비교 범위를 먼저 보여 줍니다.
  const topicCount = exploration?.seeds.length ?? 0;
  useEffect((): void => {
    if (topicCount > previousTopicCount.current)
      setView({ x: 0, y: 0, zoom: 1, fit: true, fitAll: true });
    previousTopicCount.current = topicCount;
  }, [topicCount]);
  const attributes =
    focus.attributeCount ??
    graph.assertions.filter(
      (assertion: MapEdge): boolean =>
        assertion.collection === 'attributes' &&
        assertion.subject === focus.key,
    ).length;
  // 강조 기준은 마우스를 올린 개념, 없으면 상세에 열어 둔 개념입니다.
  const emphasis = hoverNode ?? selectedConceptKey;
  const picked = layout.edges.find(
    (edge: LayoutEdge): boolean => edge.key === selectedKey,
  );
  const filtering = !!emphasis || !!picked || hoverEdge !== null;
  const active = new Set<string>();
  const states = new Map<string, { on: boolean; show: boolean }>();
  for (const edge of layout.edges) {
    const touch =
      !!emphasis && (edge.from === emphasis || edge.to === emphasis);
    const on =
      !filtering || touch || hoverEdge === edge.key || picked?.key === edge.key;
    if (on) {
      active.add(edge.from);
      active.add(edge.to);
    }
    // 개념을 가리키는 동안에는 그 개념의 관계 이름만 남깁니다.
    states.set(edge.key, { on, show: !(emphasis && !touch) });
  }

  useEffect((): (() => void) => {
    const element = viewport.current;
    if (!element) return (): void => {};
    const observer = new ResizeObserver(
      (entries: ResizeObserverEntry[]): void => {
        const rect = entries[0]?.contentRect;
        if (rect) setSize({ width: rect.width, height: rect.height });
      },
    );
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);
  useEffect(
    (): (() => void) => (): void => {
      window.clearTimeout(clickTimer.current);
      window.clearTimeout(nodeLeaveTimer.current);
      window.clearTimeout(edgeLeaveTimer.current);
    },
    [],
  );

  /** 바깥 누름과 Escape는 보기 설정만 닫고 지도 선택과 배율을 보존합니다. */
  useEffect((): (() => void) => {
    const closeOutside = (event: globalThis.PointerEvent): void => {
      const settings = settingsRef.current;
      if (
        settings?.open &&
        event.target instanceof Node &&
        !settings.contains(event.target)
      )
        settings.open = false;
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent): void => {
      const settings = settingsRef.current;
      if (event.key === 'Escape' && settings?.open) {
        event.stopPropagation();
        settings.open = false;
        settings.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return (): void => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, []);

  /** 상세가 지도 위에 겹쳐 열리면 가려지는 카드만 그만큼 옆으로 밀어 보이게 합니다. */
  const revealCovered = useEffectEvent((key: string): void => {
    const element = nodeElements.current.get(key);
    const frame = viewport.current?.getBoundingClientRect();
    if (!element || !frame || coveredRight <= 0) return;
    const limit = frame.right - coveredRight - 12;
    const overflow = element.getBoundingClientRect().right - limit;
    if (overflow > 0)
      setView({ x: position.x - overflow, y: position.y, zoom, fit: false });
  });
  const revealKey = selectedConceptKey ?? picked?.to ?? null;
  useEffect((): void => {
    if (revealKey && coveredRight > 0) revealCovered(revealKey);
  }, [revealKey, coveredRight, layout]);
  // 설명을 열어도 관계의 반대편 카드까지 보이도록 남은 작업 면에 맞춥니다.
  useEffect((): void => {
    if (exploration && coveredRight > previousCoveredRight.current)
      setView({ x: 0, y: 0, zoom: 1, fit: true, fitAll: true });
    previousCoveredRight.current = coveredRight;
  }, [coveredRight, exploration]);

  /** 범위·관계 이름이 바뀌면 배치가 달라지므로 화면에 다시 맞춥니다. */
  function resetView(): void {
    setView({ x: 0, y: 0, zoom: 1, fit: true, fitAll: Boolean(exploration) });
    setHoverNode(null);
    setHoverEdge(null);
  }
  function changeDepth(next: OntologyDepth): void {
    setDepth(next);
    resetView();
  }
  function toggleRelation(label: string): void {
    onClearSelection();
    setRelations((current: string[]): string[] =>
      current.includes(label)
        ? current.filter((item: string): boolean => item !== label)
        : [...current, label],
    );
    resetView();
  }
  function clearRelations(): void {
    onClearSelection();
    setRelations([]);
    resetView();
  }

  /** 배율 변경을 명시하면 자동 맞춤을 해제하여 후속 resize에 끌려가지 않게 합니다. */
  function changeZoom(next: number): void {
    const nextZoom = Math.min(maxZoom, Math.max(0.1, next));
    setView((current: ViewPosition): ViewPosition => ({
      ...current,
      x: current.fit ? position.x : current.x,
      y: current.fit ? position.y : current.y,
      zoom: nextZoom,
      fit: false,
    }));
  }

  /** 트랙패드 두 손가락 스크롤은 이동, 핀치(ctrlKey)와 ⌘/Ctrl 스크롤은 마우스 위치 중심의 확대·축소입니다. */
  const handleWheel = useEffectEvent((event: WheelEvent): void => {
    // 비수동 리스너에서 막아 핀치가 앱 화면 확대로 번지지 않게 합니다.
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const frame = viewport.current?.getBoundingClientRect();
      if (!frame) return;
      const cursorX = event.clientX - frame.left - frame.width / 2;
      const cursorY = event.clientY - frame.top - frame.height / 2;
      const nextZoom = Math.min(
        maxZoom,
        Math.max(0.1, zoom * Math.exp(-event.deltaY * 0.01)),
      );
      setView((current: ViewPosition): ViewPosition => {
        const baseZoom = current.fit ? zoom : current.zoom;
        const baseX = current.fit ? position.x : current.x;
        const baseY = current.fit ? position.y : current.y;
        const ratio = nextZoom / baseZoom;
        return {
          x: cursorX - (cursorX - baseX) * ratio,
          y: cursorY - (cursorY - baseY) * ratio,
          zoom: nextZoom,
          fit: false,
        };
      });
      return;
    }
    setView((current: ViewPosition): ViewPosition => ({
      x: (current.fit ? position.x : current.x) - event.deltaX,
      y: (current.fit ? position.y : current.y) - event.deltaY,
      zoom: current.fit ? zoom : current.zoom,
      fit: false,
    }));
  });
  useEffect((): (() => void) => {
    const element = viewport.current;
    if (!element) return (): void => {};
    const listener = (event: WheelEvent): void => handleWheel(event);
    element.addEventListener('wheel', listener, { passive: false });
    return (): void => element.removeEventListener('wheel', listener);
  }, []);

  /** 카드·관계 이름·관계선을 누르는 동작은 이동으로 보지 않습니다. */
  function isControl(target: EventTarget): boolean {
    return target instanceof Element && !!target.closest('button, [data-hit]');
  }

  /** 빈 곳을 끌 때만 글자 선택을 막고 이미 잡힌 선택도 지웁니다. */
  function preventSelection(event: MouseEvent<HTMLDivElement>): void {
    if (event.button !== 0 || isControl(event.target)) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    event.currentTarget.focus({ preventScroll: true });
  }

  /** 버튼을 제외한 빈 그래프에서만 포인터 이동을 시작합니다. */
  function startPan(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || isControl(event.target)) return;
    const current = { ...position, zoom, fit: false };
    drag.current = { x: event.clientX, y: event.clientY, view: current };
    setView(current);
    setIsPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** 포인터 캡처로 캔버스 밖 드래그도 같은 이동 수명에서 마칩니다. */
  function movePan(event: PointerEvent<HTMLDivElement>): void {
    const start = drag.current;
    if (start)
      setView({
        ...start.view,
        x: start.view.x + event.clientX - start.x,
        y: start.view.y + event.clientY - start.y,
      });
  }

  /** 취소와 포인터 해제 모두 이동 상태를 정리합니다. */
  function stopPan(): void {
    drag.current = null;
    setIsPanning(false);
  }

  /** 키보드 사용자는 캔버스를 포커스하고 방향키로 같은 표시 이동을 수행합니다. */
  function moveByKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [40, 0],
      ArrowRight: [-40, 0],
      ArrowUp: [0, 40],
      ArrowDown: [0, -40],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    setView((current: ViewPosition): ViewPosition => ({
      x: (current.fit ? position.x : current.x) + offset[0],
      y: (current.fit ? position.y : current.y) + offset[1],
      zoom,
      fit: false,
    }));
  }

  /** 지도 밖 노드에 키보드 초점이 가면 배율을 유지한 채 해당 노드를 보이는 곳으로 이동합니다. */
  function revealFocusedControl(event: FocusEvent<HTMLDivElement>): void {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const frame = event.currentTarget.getBoundingClientRect();
    const target = event.target.getBoundingClientRect();
    const margin = 8;
    const dx =
      target.left < frame.left + margin
        ? frame.left + margin - target.left
        : target.right > frame.right - margin
          ? frame.right - margin - target.right
          : 0;
    let dy =
      target.top < frame.top + margin
        ? frame.top + margin - target.top
        : target.bottom > frame.bottom - margin
          ? frame.bottom - margin - target.bottom
          : 0;
    const overview = minimapRef.current?.getBoundingClientRect();
    // 고정 미니맵 뒤로 초점이 들어가면 위·아래의 빈 지도 영역으로 카드를 드러냅니다.
    if (
      overview &&
      overview.width > 0 &&
      overview.height > 0 &&
      target.right + dx > overview.left &&
      target.left + dx < overview.right &&
      target.bottom + dy > overview.top &&
      target.top + dy < overview.bottom
    ) {
      dy =
        overview.top - frame.top > frame.height / 2
          ? overview.top - margin - target.bottom
          : overview.bottom + margin - target.top;
    }
    if (dx || dy)
      setView({ x: position.x + dx, y: position.y + dy, zoom, fit: false });
  }

  /** 개념 위로 포인터가 올라가면 그 개념의 관계만 강조하고, 벗어나면 잠시 뒤 해제합니다. */
  function enterNode(key: string): void {
    window.clearTimeout(nodeLeaveTimer.current);
    setHoverNode(key);
  }
  function leaveNode(): void {
    window.clearTimeout(nodeLeaveTimer.current);
    nodeLeaveTimer.current = window.setTimeout(
      (): void => setHoverNode(null),
      leaveDelay,
    );
  }
  /** 관계선과 관계 이름 위의 강조 수명은 개념과 따로 관리해 서로 해제하지 않게 합니다. */
  function enterEdge(key: string): void {
    window.clearTimeout(edgeLeaveTimer.current);
    setHoverEdge(key);
  }
  function leaveEdge(): void {
    window.clearTimeout(edgeLeaveTimer.current);
    edgeLeaveTimer.current = window.setTimeout(
      (): void => setHoverEdge(null),
      leaveDelay,
    );
  }

  /** 한 번 누름은 더블클릭이 아님을 확인한 뒤 상세로, 두 번 누름은 중심 이동으로 보냅니다. */
  function clickConcept(concept: MapConcept): void {
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(
      (): void => onSelectConcept(concept),
      clickDelay,
    );
  }
  function doubleClickConcept(concept: MapConcept): void {
    window.clearTimeout(clickTimer.current);
    if (
      concept.sourceAnchor ||
      valueObject(concept.entity.anchor)?.kind === 'source_anchor'
    )
      onSelectConcept(concept);
    else onMoveConcept(concept);
  }
  /** Shift+Enter는 더블클릭의 키보드 대안이며 Enter·Space는 상세를 엽니다. */
  function keyConcept(
    event: KeyboardEvent<HTMLButtonElement>,
    concept: MapConcept,
  ): void {
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      doubleClickConcept(concept);
    }
  }

  /** 노드는 같은 문서·개체 참조를 상세 선택으로 전달합니다. */
  function renderConcept(node: LayoutNode): JSX.Element {
    const dim = filtering && !active.has(node.key) && !node.topic;
    return (
      <button
        key={node.key}
        ref={(element: HTMLButtonElement | null): void => {
          if (element) nodeElements.current.set(node.key, element);
          else nodeElements.current.delete(node.key);
        }}
        type="button"
        className={`${styles.node} ${node.topic ? styles.topic : ''} ${selectedConceptKey === node.key ? styles.picked : ''} ${dim ? styles.dim : ''}`}
        style={rectangleStyle(node)}
        aria-pressed={selectedConceptKey === node.key}
        onClick={(): void => clickConcept(node.concept)}
        onDoubleClick={(): void => doubleClickConcept(node.concept)}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>): void =>
          keyConcept(event, node.concept)
        }
        onMouseEnter={(): void => enterNode(node.key)}
        onMouseLeave={leaveNode}
        onFocus={(): void => enterNode(node.key)}
        onBlur={leaveNode}
        title={`${node.concept.entity.label} · ${node.concept.document}`}
      >
        <i
          className={styles.avatar}
          style={{
            backgroundColor: mixedTypes
              ? typeColor(node.concept.entity.type)
              : 'var(--wiki-color-text-secondary)',
          }}
          aria-hidden="true"
        >
          {node.concept.entity.label.slice(0, 1)}
        </i>
        <span className={styles.nodeText}>
          {node.topic && (
            <small>
              {exploration
                ? `${documentDisplayName(node.concept.document)} · 탐색 주제`
                : '선택한 개념'}
            </small>
          )}
          <strong>{node.concept.entity.label}</strong>
          <span>
            {node.topic
              ? exploration
                ? `연결 ${graph.assertions.filter((edge: MapEdge): boolean => edge.collection !== 'attributes' && (edge.subject === node.key || edge.object === node.key)).length}${node.concept.relationCount === undefined ? '' : ` / ${node.concept.relationCount}`}개 · 속성 ${node.concept.attributeCount ?? 0}`
                : `직접 관계 ${layout.directCount} · 속성 ${attributes}`
              : exploration
                ? `${ontologyTermLabel(node.concept.entity.type)} · ${documentDisplayName(node.concept.document)}`
                : ontologyTermLabel(node.concept.entity.type)}
          </span>
        </span>
      </button>
    );
  }

  const rangeControls = (
    <div className={styles.segment} role="group" aria-label="보이는 범위">
      {depthOptions.map(
        (option: { value: OntologyDepth; label: string }): JSX.Element => (
          <button
            key={option.value}
            type="button"
            aria-pressed={depth === option.value}
            onClick={(): void => changeDepth(option.value)}
          >
            {option.label}
          </button>
        ),
      )}
    </div>
  );
  const relationControls =
    layout.relationCounts.length > 0 ? (
      <div
        className={styles.chips}
        role="group"
        aria-label="관계 이름으로 걸러 보기"
      >
        <span>
          {exploration
            ? '관계 종류'
            : '관계 이름(고르면 그 관계로 이어진 개념만 남습니다)'}
        </span>
        {layout.relationCounts.map((item: RelationCount): JSX.Element => (
          <button
            key={item.label}
            type="button"
            className={styles.chip}
            aria-pressed={relations.includes(item.label)}
            onClick={(): void => toggleRelation(item.label)}
          >
            {item.label}
            <small>{item.count}</small>
          </button>
        ))}
        {relations.length > 0 && (
          <button
            type="button"
            className={styles.chip}
            onClick={clearRelations}
          >
            선택 풀기
          </button>
        )}
      </div>
    ) : null;
  const appliedCount = relations.length + (depth > 1 ? 1 : 0);
  return (
    <section
      className={`${styles.root} ${exploration ? styles.exploration : ''}`}
      aria-label="온톨로지 연결 지도"
    >
      <div className={styles.focusbar}>
        <div className={styles.heading}>{heading}</div>
        {exploration ? (
          <div className={styles.tools}>
            {exploration.toolbar}
            {exploration.onPrevious && (
              <button
                type="button"
                className={styles.tool}
                disabled={!exploration.previousName}
                aria-label={
                  exploration.previousName
                    ? `이전 개념 ${exploration.previousName}으로 돌아가기`
                    : '이전 개념으로 돌아가기'
                }
                title={
                  exploration.previousName
                    ? `${exploration.previousName}으로 돌아가기`
                    : '이전 개념으로 돌아가기'
                }
                onClick={exploration.onPrevious}
              >
                <Icon name="arrow-left" />
              </button>
            )}
            <button
              type="button"
              className={styles.tool}
              onClick={exploration.onSearch}
              aria-label="개념 추가"
            >
              <Icon name="plus" />
              <span>개념 추가</span>
            </button>
            <details className={styles.settings} ref={settingsRef}>
              <summary
                className={styles.tool}
                aria-label={`지도 보기 설정${appliedCount > 0 ? `, ${appliedCount}개 적용` : ''}`}
              >
                <Icon name="filter" />
                <span>보기 · {depth > 1 ? '한 단계 더' : '직접 연결'}</span>
                {relations.length > 0 && <small>관계 {relations.length}</small>}
              </summary>
              <div className={styles.options} aria-label="지도 보기 설정">
                <div className={styles.optionsHeading}>
                  <strong>보이는 범위</strong>
                  <button
                    type="button"
                    className={styles.close}
                    aria-label="보기 설정 닫기"
                    onClick={(): void => {
                      if (settingsRef.current) {
                        settingsRef.current.open = false;
                        settingsRef.current.querySelector('summary')?.focus();
                      }
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </div>
                {rangeControls}
                <p className={styles.rangeHint}>
                  이미 지도에 가져온 연결 안에서 표시합니다.
                </p>
                {relationControls}
              </div>
            </details>
          </div>
        ) : (
          rangeControls
        )}
      </div>
      {notices && <div className={styles.notices}>{notices}</div>}
      {!exploration && relationControls}
      <div className={styles.stage}>
        <div className={styles.legend} aria-label="선 종류 범례">
          <span className={styles.machine}>
            <i />
            AI 추출
          </span>
          <span className={styles.expert}>
            <i />
            검토·판단 반영
          </span>
          <span className={styles.candidate}>
            <i />
            연결 후보 · 미확정
          </span>
        </div>
        <div
          ref={viewport}
          className={`${styles.viewport} ${isPanning ? styles.panning : ''}`}
          tabIndex={0}
          role="group"
          aria-label="그래프 이동 영역. 방향키, 빈 곳 드래그, 두 손가락 스크롤로 이동하고 핀치로 확대·축소"
          onMouseDown={preventSelection}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={stopPan}
          onPointerCancel={stopPan}
          onLostPointerCapture={stopPan}
          onKeyDown={moveByKeyboard}
          onFocusCapture={revealFocusedControl}
        >
          <div
            className={styles.world}
            style={{
              width: layout.width,
              height: layout.height,
              transform: exploration
                ? `translate(${position.x}px, ${position.y}px) scale(${zoom}) translate(${-anchor.x - anchor.width / 2}px, ${-anchor.y - anchor.height / 2}px)`
                : `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px)) scale(${zoom})`,
            }}
          >
            <svg
              className={styles.wires}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              <defs>
                {origins.map((origin: Origin): JSX.Element => (
                  <marker
                    key={origin}
                    id={`${marker}-${origin}`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path
                      d="M0 0 L8 4 L0 8 Z"
                      className={styles[origin]}
                      fill="currentColor"
                    />
                  </marker>
                ))}
              </defs>
              {layout.edges.map((edge: LayoutEdge): JSX.Element => {
                const state = states.get(edge.key);
                const on = state?.on ?? true;
                const hot = filtering && on;
                return (
                  <g
                    key={edge.key}
                    className={`${styles.wire} ${styles[edge.assertion.origin]} ${edge.far ? styles.far : ''} ${on ? '' : styles.off} ${hot ? styles.hot : ''}`}
                  >
                    <path
                      d={edge.path}
                      markerEnd={`url(#${marker}-${edge.assertion.origin})`}
                    />
                    <path
                      d={edge.path}
                      className={styles.hit}
                      data-hit="true"
                      onMouseEnter={(): void => enterEdge(edge.key)}
                      onMouseLeave={leaveEdge}
                      onClick={(): void => onSelectAssertion(edge.assertion)}
                    />
                  </g>
                );
              })}
            </svg>
            {layout.nodes.map(renderConcept)}
            {layout.edges.map((edge: LayoutEdge): JSX.Element => {
              const state = states.get(edge.key);
              const show = state?.show ?? true;
              const selected = selectedKey === edge.key;
              return (
                <button
                  key={edge.key}
                  type="button"
                  className={`${styles.relation} ${styles[edge.assertion.origin]} ${selected ? styles.selected : ''} ${show ? '' : styles.hidden} ${state?.on === false ? styles.off : ''}`}
                  style={rectangleStyle(edge.pill)}
                  aria-pressed={selected}
                  tabIndex={show ? 0 : -1}
                  title={
                    edge.assertion.description ??
                    `${edge.assertion.label} · ${originLabels[edge.assertion.origin]}`
                  }
                  aria-label={
                    edge.assertion.description ?? edge.assertion.label
                  }
                  onClick={(): void => onSelectAssertion(edge.assertion)}
                  onMouseEnter={(): void => enterEdge(edge.key)}
                  onMouseLeave={leaveEdge}
                >
                  {edge.assertion.label}
                </button>
              );
            })}
          </div>
        </div>
        {visibleWidth > 0 && size.height > 0 && (
          <OntologyMinimap
            ref={minimapRef}
            layout={layout}
            visible={visible}
            coveredRight={coveredRight}
            selectedConceptKey={selectedConceptKey}
            onNavigate={navigateMinimap}
          />
        )}
      </div>
      {layout.edges.length === 0 && (
        <div className={styles.empty} role="status">
          <strong>
            {relations.length > 0
              ? '선택한 관계 종류에 해당하는 연결이 없습니다'
              : '이 개념에 연결된 관계가 없습니다'}
          </strong>
          <p>개념을 선택하면 속성과 출처를 확인할 수 있습니다.</p>
        </div>
      )}
      <footer className={styles.footer}>
        <span className={styles.hint}>
          드래그나 두 손가락 스크롤로 이동 · 핀치로 확대·축소
          {layout.unresolvedCount > 0
            ? ` · 끝점 미확인 ${layout.unresolvedCount}개`
            : ''}
        </span>
        <div className={styles.controls}>
          <button
            type="button"
            aria-label="그래프 축소"
            onClick={(): void => changeZoom(zoom - 0.1)}
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className={styles.zoomValue}
            aria-label={`그래프 배율 ${Math.round(zoom * 100)}%, 누르면 100%`}
            title="누르면 100%"
            onClick={(): void => changeZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            aria-label="그래프 확대"
            onClick={(): void => changeZoom(zoom + 0.1)}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            aria-label="화면에 맞춤"
            title="화면에 맞춤"
            onClick={(): void =>
              setView({ x: 0, y: 0, zoom: 1, fit: true, fitAll: true })
            }
          >
            <Icon name="maximize-2" />
            <span className={styles.fitLabel}>화면에 맞춤</span>
          </button>
        </div>
      </footer>
    </section>
  );
}

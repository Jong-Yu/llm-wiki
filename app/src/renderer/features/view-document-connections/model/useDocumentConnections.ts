import { useEffect, useRef, useState } from 'react';
import {
  loadDocumentConnections,
  loadDocumentImpact,
  readImpactBaseline,
  readLinkExcerpt,
} from '../api/documentConnections.api';
import type {
  ConnectionsInput,
  DocumentConnections,
  DocumentImpact,
  ExplicitDocumentLink,
  SharedConceptCandidate,
  ImpactBaseline,
  ConnectionFailure,
  ConnectionsResult,
  LinkExcerpt,
} from '../api/documentConnections.api';

export type ConnectionEdge =
  | {
      kind: 'explicit';
      key: string;
      peerDocument: string;
      link: ExplicitDocumentLink;
    }
  | {
      kind: 'candidate';
      key: string;
      peerDocument: string;
      candidate: SharedConceptCandidate;
    };
type ConnectionState =
  | { status: 'loading' }
  | { status: 'error'; error: ConnectionFailure }
  | { status: 'ready'; data: DocumentConnections };
type ImpactState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: ConnectionFailure }
  | { status: 'ready'; data: DocumentImpact };
type ExcerptState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: LinkExcerpt }
  | { status: 'error'; error: ConnectionFailure };
type Input = ConnectionsInput & { onScopeInvalidated: () => void };
export type DocumentConnectionsModel = {
  connections: ConnectionState;
  impact: ImpactState;
  edges: ConnectionEdge[];
  selected: ConnectionEdge | null;
  excerpt: ExcerptState;
  baseline: ImpactBaseline | null;
  baselineError: string | null;
  baselineBusy: boolean;
  refresh: () => void;
  select: (edge: ConnectionEdge) => void;
  queryImpact: () => void;
  resetBaseline: () => void;
};
const baselines = new Map<string, ImpactBaseline>();

/** 비교 기준은 현재 연결/사용자/관점/문서의 실제 조회 판본에만 묶습니다. */
function baselineKey(input: ConnectionsInput): string {
  return JSON.stringify([
    input.connectionId,
    input.scope.userId,
    input.scope.tenant,
    input.scope.profileId,
    input.scope.policyRevision,
    input.document,
  ]);
}

/** 명시 링크의 방향과 이름 일치 후보를 구별해 같은 문서를 자동 병합하지 않습니다. */
function edgesOf(data: DocumentConnections): ConnectionEdge[] {
  return [
    ...data.explicit_links.map(
      (link: ExplicitDocumentLink, index: number): ConnectionEdge => ({
        kind: 'explicit',
        key: `link:${index}:${link.source_document}:${link.target_document}`,
        peerDocument:
          link.direction === 'outgoing'
            ? link.target_document
            : link.source_document,
        link,
      }),
    ),
    ...data.candidates.map(
      (candidate: SharedConceptCandidate, index: number): ConnectionEdge => ({
        kind: 'candidate',
        key: `candidate:${index}:${candidate.source_entity.id}:${candidate.target_entity.id}`,
        peerDocument: candidate.target_entity.document,
        candidate,
      }),
    ),
  ];
}

/** 연결·영향·인용의 응답 수명을 분리하고 조회 실패를 빈 결과로 바꾸지 않습니다. */
export function useDocumentConnections(input: Input): DocumentConnectionsModel {
  const [connections, setConnections] = useState<ConnectionState>({
    status: 'loading',
  });
  const [impact, setImpact] = useState<ImpactState>({ status: 'idle' });
  const [selected, setSelected] = useState<ConnectionEdge | null>(null);
  const [excerpt, setExcerpt] = useState<ExcerptState>({ status: 'idle' });
  const [baseline, setBaseline] = useState<ImpactBaseline | null>(
    (): ImpactBaseline | null => baselines.get(baselineKey(input)) || null,
  );
  const [baselineError, setBaselineError] = useState<string | null>(null);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const mounted = useRef(false);
  const connectionsGeneration = useRef(0);
  const impactGeneration = useRef(0);
  const excerptGeneration = useRef(0);
  const baselineGeneration = useRef(0);
  const initial = useRef(input);

  /** 권한/조회 범위 변경 시 부모가 이전 문서를 숨기도록 전달합니다. */
  function applyFailure(error: ConnectionFailure): void {
    if (
      error.status === 401 ||
      error.status === 403 ||
      ['scope_changed', 'subject_changed', 'connection_changed'].includes(
        error.code,
      )
    )
      input.onScopeInvalidated();
  }
  useEffect((): (() => void) => {
    mounted.current = true;
    const target = initial.current;
    const request = ++connectionsGeneration.current;
    void loadDocumentConnections(target).then(
      (result: ConnectionsResult<DocumentConnections>): void => {
        if (!mounted.current || request !== connectionsGeneration.current)
          return;
        if (result.ok) setConnections({ status: 'ready', data: result.data });
        else {
          setConnections({ status: 'error', error: result.error });
          if (
            result.error.status === 401 ||
            result.error.status === 403 ||
            result.error.code === 'scope_changed'
          )
            target.onScopeInvalidated();
        }
      },
    );
    if (!baselines.has(baselineKey(target))) {
      const baselineRequest = ++baselineGeneration.current;
      void readImpactBaseline(target).then(
        (result: ConnectionsResult<ImpactBaseline>): void => {
          if (
            !mounted.current ||
            baselineRequest !== baselineGeneration.current
          )
            return;
          if (result.ok) {
            baselines.set(baselineKey(target), result.data);
            setBaseline(result.data);
          } else {
            setBaselineError(result.error.message);
            if (
              result.error.status === 401 ||
              result.error.status === 403 ||
              result.error.code === 'scope_changed'
            )
              target.onScopeInvalidated();
          }
        },
      );
    }
    return (): void => {
      mounted.current = false;
      connectionsGeneration.current += 1;
      impactGeneration.current += 1;
      excerptGeneration.current += 1;
      baselineGeneration.current += 1;
    };
  }, []);

  /** 연결을 다시 읽으면 이전 선택/인용을 숨기되 처음 관측한 비교 기준은 보존합니다. */
  function refresh(): void {
    const request = ++connectionsGeneration.current;
    impactGeneration.current += 1;
    setImpact({ status: 'idle' });
    excerptGeneration.current += 1;
    setSelected(null);
    setExcerpt({ status: 'idle' });
    setConnections({ status: 'loading' });
    void loadDocumentConnections(input).then(
      (result: ConnectionsResult<DocumentConnections>): void => {
        if (!mounted.current || request !== connectionsGeneration.current)
          return;
        if (result.ok) setConnections({ status: 'ready', data: result.data });
        else {
          setConnections({ status: 'error', error: result.error });
          applyFailure(result.error);
        }
      },
    );
  }
  /** 선택한 명시 링크의 원문 인용만 읽고 후보는 저장된 개체 근거를 그대로 사용합니다. */
  function select(edge: ConnectionEdge): void {
    const request = ++excerptGeneration.current;
    setSelected(edge);
    if (edge.kind === 'candidate') {
      setExcerpt({ status: 'idle' });
      return;
    }
    setExcerpt({ status: 'loading' });
    void readLinkExcerpt(input, edge.link).then(
      (result: ConnectionsResult<LinkExcerpt>): void => {
        if (!mounted.current || request !== excerptGeneration.current) return;
        if (result.ok) setExcerpt({ status: 'ready', data: result.data });
        else {
          setExcerpt({ status: 'error', error: result.error });
          applyFailure(result.error);
        }
      },
    );
  }
  /** 영향 조회는 현재 기준만 대조하며 저장·재추출·정책 재적용을 실행하지 않습니다. */
  function queryImpact(): void {
    const request = ++impactGeneration.current;
    setImpact({ status: 'loading' });
    void loadDocumentImpact(input, baseline).then(
      (result: ConnectionsResult<DocumentImpact>): void => {
        if (!mounted.current || request !== impactGeneration.current) return;
        if (result.ok) setImpact({ status: 'ready', data: result.data });
        else {
          setImpact({ status: 'error', error: result.error });
          applyFailure(result.error);
        }
      },
    );
  }
  /** 사용자가 새 기준을 요청하면 실제 지식 전체를 다시 읽은 판본만 채택합니다. */
  function resetBaseline(): void {
    const request = ++baselineGeneration.current;
    impactGeneration.current += 1;
    setImpact({ status: 'idle' });
    setBaselineBusy(true);
    void readImpactBaseline(input).then(
      (result: ConnectionsResult<ImpactBaseline>): void => {
        if (!mounted.current || request !== baselineGeneration.current) return;
        setBaselineBusy(false);
        if (result.ok) {
          baselines.set(baselineKey(input), result.data);
          setBaseline(result.data);
          setBaselineError(null);
          setImpact({ status: 'idle' });
        } else {
          setBaselineError(result.error.message);
          applyFailure(result.error);
        }
      },
    );
  }
  return {
    connections,
    impact,
    edges: connections.status === 'ready' ? edgesOf(connections.data) : [],
    selected,
    excerpt,
    baseline,
    baselineError,
    baselineBusy,
    refresh,
    select,
    queryImpact,
    resetBaseline,
  };
}

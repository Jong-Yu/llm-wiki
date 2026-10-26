import { useEffect, useRef, useState } from 'react';
import type { SourceRegistrationRecord } from '@contracts/sources.contract';
import type {
  DocumentListItem,
  DocumentListPage,
} from '@contracts/documents.contract';
import { loadDocumentPage, loadLinkedDocument } from '../api/documentList.api';
import type {
  DocumentPageOutcome,
  DocumentListError,
  DocumentListScope,
} from '../api/documentList.api';

export type { DocumentListItem };
type CompletedRegistration = Extract<
  SourceRegistrationRecord,
  { state: 'complete' }
>;
export type DocumentListState =
  | { status: 'loading' }
  | { status: 'unselected' }
  | {
      status: 'error';
      scope: DocumentListScope | null;
      error: DocumentListError;
    }
  | {
      status: 'ready';
      scope: DocumentListScope;
      page: DocumentListPage;
      cursor: string | null;
      previousCursors: readonly (string | null)[];
      registeredSource?: CompletedRegistration['item'];
      linkedDocument?: Extract<DocumentListItem, { kind: 'wiki' }>;
    };

export type DocumentListModel = {
  state: DocumentListState;
  refresh: () => void;
  previous: () => void;
  next: () => void;
  registration: CompletedRegistration | null;
  showRegisteredSource: (record: CompletedRegistration) => void;
  openDocument: (document: string) => Promise<void>;
};

/** 다른 사용자/공간에서 완료된 등록을 현재 목록에 끼워 넣지 않습니다. */
function matchesRegistration(
  record: CompletedRegistration,
  scope: DocumentListScope,
): boolean {
  return (
    record.connectionId === scope.connectionId &&
    record.access.userId === scope.userId &&
    record.access.tenant === scope.tenant &&
    record.access.policyRevision === scope.policyRevision
  );
}

/** 페이지 이력과 응답 수명만 소유하고 대기/실패 시 이전 목록을 숨깁니다. */
export function useDocumentList(initialDocument?: string): DocumentListModel {
  const [state, setState] = useState<DocumentListState>({ status: 'loading' });
  const mounted = useRef(false);
  const generation = useRef(0);
  const [registration, setRegistration] =
    useState<CompletedRegistration | null>(null);

  /** 사용자 동작으로 시작한 조회의 최신 응답만 화면에 반영합니다. */
  async function load(
    cursor: string | null,
    previousCursors: readonly (string | null)[],
    expectedScope: DocumentListScope | undefined,
    registered: CompletedRegistration | null = null,
  ): Promise<void> {
    const request = ++generation.current;
    const result = await loadDocumentPage(cursor, expectedScope);
    if (!mounted.current || request !== generation.current) return;
    if (result.status === 'ready')
      setState({
        ...result,
        cursor,
        previousCursors,
        ...(registered && matchesRegistration(registered, result.scope)
          ? { registeredSource: registered.item }
          : {}),
      });
    else setState(result);
  }

  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    // 최초 화면은 이미 loading이므로 API 완료 때만 상태를 갱신합니다.
    void loadDocumentPage(null, undefined).then(
      async (result: DocumentPageOutcome): Promise<void> => {
        if (!mounted.current || request !== generation.current) return;
        if (result.status === 'ready') {
          if (initialDocument) {
            try {
              const linked = await loadLinkedDocument(
                initialDocument,
                result.scope,
              );
              if (!mounted.current || request !== generation.current) return;
              if (linked.ok)
                setState({
                  ...result,
                  cursor: null,
                  previousCursors: [],
                  linkedDocument: {
                    kind: 'wiki',
                    document: linked.data.document,
                    revision: linked.data.revision,
                    sourceStatus: 'unknown',
                  },
                });
              else
                setState({
                  status: 'error',
                  scope: result.scope,
                  error: linked.error,
                });
            } catch {
              if (mounted.current && request === generation.current)
                setState({
                  status: 'error',
                  scope: result.scope,
                  error: {
                    code: 'bridge_unavailable',
                    message: '선택한 문서를 읽지 못했습니다.',
                  },
                });
            }
          } else setState({ ...result, cursor: null, previousCursors: [] });
        } else setState(result);
      },
    );
    return (): void => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [initialDocument]);

  /** 목록 기준이 바뀌면 현재 cursor를 재사용하지 않고 처음부터 읽습니다. */
  function refresh(): void {
    setState({ status: 'loading' });
    void load(null, [], undefined, registration);
  }

  /** 확인된 등록 영수증을 보존하고 목록 기준을 새로 읽은 뒤 해당 원본을 선택합니다. */
  function showRegisteredSource(record: CompletedRegistration): void {
    if (state.status !== 'ready' || !matchesRegistration(record, state.scope))
      return;
    setRegistration(record);
    setState({ status: 'loading' });
    void load(null, [], state.scope, record);
  }

  /** 현재 범위의 본문을 실제 읽고 페이지 밖 문서도 선택할 수 있게 합니다. */
  async function openDocument(document: string): Promise<void> {
    if (state.status !== 'ready') return;
    const before = state;
    const request = ++generation.current;
    setState({ status: 'loading' });
    try {
      const result = await loadLinkedDocument(document, before.scope);
      if (!mounted.current || generation.current !== request) return;
      if (!result.ok) {
        setState({ status: 'error', scope: before.scope, error: result.error });
        return;
      }
      setState({
        ...before,
        linkedDocument: {
          kind: 'wiki',
          document: result.data.document,
          revision: result.data.revision,
          sourceStatus: 'unknown',
        },
      });
    } catch {
      if (mounted.current && generation.current === request)
        setState({
          status: 'error',
          scope: before.scope,
          error: {
            code: 'bridge_unavailable',
            message: '선택한 문서를 읽지 못했습니다. 다시 조회해 주세요.',
          },
        });
    }
  }

  /** 이미 조회한 같은 범위의 이전 페이지만 다시 읽습니다. */
  function previous(): void {
    if (state.status !== 'ready' || state.previousCursors.length === 0) return;
    const cursor = state.previousCursors[state.previousCursors.length - 1];
    if (cursor === undefined) return;
    setState({ status: 'loading' });
    void load(cursor, state.previousCursors.slice(0, -1), state.scope);
  }

  /** 서버가 준 다음 cursor만 사용하고 임의 페이지 번호는 보내지 않습니다. */
  function next(): void {
    if (
      state.status !== 'ready' ||
      state.page.nextCursor === null ||
      state.page.requiresRefresh
    )
      return;
    setState({ status: 'loading' });
    void load(
      state.page.nextCursor,
      [...state.previousCursors, state.cursor],
      state.scope,
    );
  }

  return {
    state,
    refresh,
    previous,
    next,
    registration,
    showRegisteredSource,
    openDocument,
  };
}

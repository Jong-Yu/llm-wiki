import { useEffect, useRef, useState } from 'react';
import {
  cleanupHistorySchema,
  cleanupPreviewSchema,
  cleanupReceiptSchema,
} from '@contracts/ontologyCleanup.contract';
import type {
  CleanupEvent,
  CleanupHistory,
  CleanupPreview,
  CleanupReceipt,
} from '@contracts/ontologyCleanup.contract';
import { cleanupScope, executeCleanup } from '../api/ontologyCleanup.api';
import { invalidatesScope } from '../api/ontologyMap.api';
import type { OntologyFailure, OntologyScope } from './ontologyMap.types';

type PendingRequest = { requestId: string; action: 'apply' | 'undo' };
type CleanupState = {
  document: string;
  phase: 'idle' | 'preview' | 'history' | 'apply' | 'undo' | 'receipt';
  preview: CleanupPreview | null;
  history: CleanupHistory | null;
  selected: string[];
  pending: PendingRequest | null;
  error: OntologyFailure | null;
  receipt: CleanupReceipt | null;
};
export type OntologyCleanupModel = CleanupState & {
  busy: boolean;
  setDocument: (document: string) => void;
  toggle: (id: string) => void;
  previewPage: (more?: boolean) => Promise<void>;
  historyPage: (more?: boolean) => Promise<void>;
  apply: (reason: string) => Promise<void>;
  undo: (event: CleanupEvent, reason: string) => Promise<void>;
  checkReceipt: () => Promise<void>;
};

/** 문서별 선택과 미확인 요청을 보존하며 닫았다 열어도 저장을 재전송하지 않습니다. */
export function useOntologyCleanup(
  scope: OntologyScope,
  initialDocument: string,
  onChanged: () => void,
  onInvalidate: () => void,
): OntologyCleanupModel {
  const [state, setState] = useState<CleanupState>({
    document: initialDocument,
    phase: 'idle',
    preview: null,
    history: null,
    selected: [],
    pending: null,
    error: null,
    receipt: null,
  });
  const live = useRef(false);
  const locked = useRef(false);
  const callbacks = useRef({ onChanged, onInvalidate });
  useEffect((): void => {
    callbacks.current = { onChanged, onInvalidate };
  }, [onChanged, onInvalidate]);
  useEffect((): (() => void) => {
    live.current = true;
    return (): void => {
      live.current = false;
    };
  }, []);

  /** 동기 잠금으로 이중 클릭을 막고 다른 범위의 늦은 응답을 버립니다. */
  function begin(phase: CleanupState['phase']): boolean {
    if (locked.current || !live.current || !state.document) return false;
    locked.current = true;
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      phase,
      error: null,
    }));
    return true;
  }
  /** 조회 실패는 빈 결과와 구분하고 권한을 잃은 자료는 숨깁니다. */
  function fail(error: OntologyFailure, mutation: boolean = false): void {
    locked.current = false;
    if (!live.current) return;
    if (invalidatesScope(error)) {
      callbacks.current.onInvalidate();
      return;
    }
    const uncertain =
      error.code === 'outcome_unknown' ||
      (mutation && error.retry === 'read_again');
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      phase: 'idle',
      error,
      pending: mutation && !uncertain ? null : previous.pending,
      preview: mutation || error.status === 409 ? null : previous.preview,
      selected: mutation || error.status === 409 ? [] : previous.selected,
      history: error.status === 409 ? null : previous.history,
    }));
  }
  /** 확인된 저장만 완료로 표시하며 다음 변경에는 새 조회 기준을 요구합니다. */
  function saved(receipt: CleanupReceipt): void {
    locked.current = false;
    if (!live.current) return;
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      phase: 'idle',
      pending: null,
      error: null,
      receipt,
      preview: null,
      selected: [],
      history: null,
    }));
    callbacks.current.onChanged();
  }
  /** 미확인 저장 중에는 대상을 바꾸지 않고 원래 요청의 조회 경로를 유지합니다. */
  function setDocument(document: string): void {
    if (locked.current || state.pending) return;
    setState({
      document,
      phase: 'idle',
      preview: null,
      history: null,
      selected: [],
      pending: null,
      error: null,
      receipt: null,
    });
  }
  /** 서버가 제공한 적용 가능 항목만 명시적으로 선택합니다. */
  function toggle(id: string): void {
    if (
      locked.current ||
      state.pending ||
      !state.preview?.items.some(
        (item: CleanupPreview['items'][number]): boolean =>
          item.item_id === id && item.available,
      )
    )
      return;
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      selected: previous.selected.includes(id)
        ? previous.selected.filter((value: string): boolean => value !== id)
        : [...previous.selected, id].slice(0, 50),
    }));
  }
  /** 다음 페이지도 같은 미리보기 판본일 때만 이어 붙입니다. */
  async function previewPage(more: boolean = false): Promise<void> {
    if (
      state.pending ||
      (more && !state.preview?.next_cursor) ||
      !begin('preview')
    )
      return;
    const result = await executeCleanup(
      scope,
      {
        connectionId: scope.connectionId,
        expectedScope: cleanupScope(scope),
        operation: 'cleanupPreview',
        input: {
          document: state.document,
          limit: 50,
          ...(more ? { cursor: state.preview?.next_cursor } : {}),
        },
      },
      cleanupPreviewSchema,
    );
    if (!result.ok) {
      fail(result.error);
      return;
    }
    if (
      more &&
      state.preview?.preview_revision !== result.data.preview_revision
    ) {
      fail({
        code: 'catalog_changed',
        status: 409,
        message: '목록이 변경되었습니다. 새 미리보기를 확인해 주세요.',
      });
      return;
    }
    locked.current = false;
    if (!live.current) return;
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      phase: 'idle',
      receipt: null,
      preview: {
        ...result.data,
        items: more
          ? [...(previous.preview?.items || []), ...result.data.items]
          : result.data.items,
      },
      selected: more ? previous.selected : [],
    }));
  }
  /** 이력 갱신은 조회만 수행하며 미확인 저장을 자동 재전송하지 않습니다. */
  async function historyPage(more: boolean = false): Promise<void> {
    if ((more && !state.history?.next_cursor) || !begin('history')) return;
    const result = await executeCleanup(
      scope,
      {
        connectionId: scope.connectionId,
        expectedScope: cleanupScope(scope),
        operation: 'cleanupHistory',
        input: {
          document: state.document,
          limit: 50,
          ...(more ? { cursor: state.history?.next_cursor } : {}),
        },
      },
      cleanupHistorySchema,
    );
    if (!result.ok) {
      fail(result.error);
      return;
    }
    if (more && state.history?.state_revision !== result.data.state_revision) {
      fail({
        code: 'catalog_changed',
        status: 409,
        message: '이력이 변경되었습니다. 처음부터 다시 조회해 주세요.',
      });
      return;
    }
    locked.current = false;
    if (!live.current) return;
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      phase: 'idle',
      history: {
        ...result.data,
        items: more
          ? [...(previous.history?.items || []), ...result.data.items]
          : result.data.items,
      },
    }));
  }
  /** 선택 항목과 읽은 판본을 고유 요청 ID로 한 번만 보냅니다. */
  async function apply(reason: string): Promise<void> {
    if (
      state.pending ||
      !state.preview ||
      state.preview.requires_refresh ||
      state.selected.length === 0 ||
      !reason.trim() ||
      !begin('apply')
    )
      return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      pending: { requestId, action: 'apply' },
    }));
    const result = await executeCleanup(
      scope,
      {
        connectionId: scope.connectionId,
        expectedScope: cleanupScope(scope),
        operation: 'cleanupApply',
        input: {
          document: state.document,
          request_id: requestId,
          preview_revision: state.preview.preview_revision,
          item_ids: state.selected,
          reason,
        },
      },
      cleanupReceiptSchema,
    );
    if (!result.ok) {
      fail(result.error, true);
      return;
    }
    saved(result.data);
  }
  /** 읽은 적용 이벤트 전체를 되돌리며 조회한 이력 판본을 그대로 보냅니다. */
  async function undo(event: CleanupEvent, reason: string): Promise<void> {
    if (
      state.pending ||
      !state.history ||
      state.history.requires_refresh ||
      event.action !== 'cleanup_apply' ||
      !reason.trim() ||
      !begin('undo')
    )
      return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    setState((previous: CleanupState): CleanupState => ({
      ...previous,
      pending: { requestId, action: 'undo' },
    }));
    const result = await executeCleanup(
      scope,
      {
        connectionId: scope.connectionId,
        expectedScope: cleanupScope(scope),
        operation: 'cleanupUndo',
        input: {
          document: state.document,
          request_id: requestId,
          event_id: event.id,
          expected_state_revision: state.history.state_revision,
          reason,
        },
      },
      cleanupReceiptSchema,
    );
    if (!result.ok) {
      fail(result.error, true);
      return;
    }
    saved(result.data);
  }
  /** 영수증이 아직 없다는 응답은 미저장 확정이 아니므로 조회 경로를 유지합니다. */
  async function checkReceipt(): Promise<void> {
    if (!state.pending || !begin('receipt')) return;
    const result = await executeCleanup(
      scope,
      {
        connectionId: scope.connectionId,
        expectedScope: cleanupScope(scope),
        operation: 'cleanupRequest',
        input: {
          document: state.document,
          request_id: state.pending.requestId,
        },
      },
      cleanupReceiptSchema,
    );
    if (!result.ok) {
      fail(
        result.error.status === 404
          ? {
              ...result.error,
              message:
                '저장 기록이 아직 없습니다. 처리 중일 수 있으니 잠시 후 다시 확인해 주세요.',
            }
          : result.error,
      );
      return;
    }
    saved(result.data);
  }
  return {
    ...state,
    busy: state.phase !== 'idle',
    setDocument,
    toggle,
    previewPage,
    historyPage,
    apply,
    undo,
    checkReceipt,
  };
}

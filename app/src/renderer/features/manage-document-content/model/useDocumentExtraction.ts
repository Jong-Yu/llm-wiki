import { useEffect, useSyncExternalStore } from 'react';
import type { DocumentContent } from '@contracts/documents.contract';
import type { ProposalExecutionDetail } from '@contracts/proposalExecution.contract';
import type {
  DocumentExtractionFailure,
  PreparedDocumentExtraction,
} from '../api/documentExtraction.api';
import {
  prepareDocumentExtraction,
  readPreparedDocumentExtraction,
  startDocumentExtraction,
  readDocumentExtraction,
} from '../api/documentExtraction.api';
import { contentDraftKey } from './documentDraft';

type PreviousRequest = {
  proposalId: string;
  executionId: string | null;
  sourceRevision: string;
};
type ExtractionState = {
  basis: DocumentContent;
  prepared: PreparedDocumentExtraction | null;
  execution: ProposalExecutionDetail | null;
  executionId: string | null;
  recoveryId: string | null;
  error: DocumentExtractionFailure | null;
  pending: boolean;
  previous: PreviousRequest[];
};
const requests = new Map<string, ExtractionState>();
const listeners = new Map<string, Set<() => void>>();
type ExtractionInput = { current: DocumentContent; onInvalidated: () => void };
export type DocumentExtractionModel = {
  state: ExtractionState;
  busy: boolean;
  canPrepare: boolean;
  prepare: () => Promise<void>;
  start: () => Promise<void>;
  run: () => Promise<void>;
  refresh: () => Promise<void>;
  recover: () => Promise<void>;
};

/** 응답 유실·실행 중에는 재준비를 금지하고 확인된 종료에서만 새 요청을 허용합니다. */
function canPrepareExtraction(state: ExtractionState): boolean {
  return (
    !state.pending &&
    !state.recoveryId &&
    (!state.executionId ||
      (!state.error &&
        (state.execution?.local.status === 'failed' ||
          state.execution?.local.status === 'exited')))
  );
}

/** 요청 중 재진입해도 같은 상태를 구독하여 중복 prepare·CLI 실행을 막습니다. */
export function useDocumentExtraction({
  current,
  onInvalidated,
}: ExtractionInput): DocumentExtractionModel {
  const key = contentDraftKey(current);
  /** 인증 범위별 요청 상태를 만들며 외부 I/O는 실행하지 않습니다. */
  function snapshot(): ExtractionState {
    const cached = requests.get(key);
    if (cached) return cached;
    const initial: ExtractionState = {
      basis: current,
      prepared: null,
      execution: null,
      executionId: null,
      recoveryId: null,
      error: null,
      pending: false,
      previous: [],
    };
    requests.set(key, initial);
    return initial;
  }
  /** 같은 범위의 재방문 화면에만 완료 결과를 통지합니다. */
  function subscribe(listener: () => void): () => void {
    const values = listeners.get(key) ?? new Set<() => void>();
    values.add(listener);
    listeners.set(key, values);
    return (): void => {
      values.delete(listener);
      if (values.size === 0) listeners.delete(key);
    };
  }
  const state = useSyncExternalStore(subscribe, snapshot);
  useEffect((): void => {
    if (
      state.error &&
      (state.error.status === 401 ||
        state.error.status === 403 ||
        state.error.code === 'scope_changed')
    )
      onInvalidated();
  }, [state.error, onInvalidated]);
  /** 전송 직전부터 pending을 공유해 빠른 재진입과 연속 클릭을 막습니다. */
  function update(next: ExtractionState): void {
    requests.set(key, next);
    listeners.get(key)?.forEach((listener: () => void): void => listener());
  }
  /** 사용자가 명시한 현재 저장 본문으로 새 입력을 고정하며 이전 참조는 보존합니다. */
  async function prepare(): Promise<void> {
    const before = snapshot();
    if (!canPrepareExtraction(before)) return;
    const previous = before.prepared
      ? [
          ...before.previous,
          {
            proposalId: before.prepared.proposalId,
            executionId: before.executionId,
            sourceRevision: before.prepared.sourceRevision,
          },
        ]
      : before.previous;
    update({ ...before, pending: true });
    const result = await prepareDocumentExtraction(current);
    update({
      basis: current,
      prepared: result.ok ? result.data : null,
      execution: null,
      executionId: null,
      recoveryId: result.ok
        ? null
        : (result.error.recovery?.proposalId ?? null),
      error: result.ok ? null : result.error,
      pending: false,
      previous,
    });
  }
  /** 준비 요청 유실 뒤에는 같은 추출 결과을 읽으며 새 prepare를 보내지 않습니다. */
  async function recover(): Promise<void> {
    const before = snapshot();
    if (before.pending || !before.recoveryId) return;
    update({ ...before, pending: true });
    const result = await readPreparedDocumentExtraction(
      before.basis,
      before.recoveryId,
    );
    update(
      result.ok
        ? {
            ...before,
            prepared: result.data,
            recoveryId: null,
            error: null,
            pending: false,
          }
        : { ...before, error: result.error, pending: false },
    );
  }
  /** CLI 실행 ID를 전송 전에 보존하고 선택된 개인 모델을 한 번만 요청합니다. */
  async function start(): Promise<void> {
    const before = snapshot();
    if (
      before.pending ||
      !before.prepared ||
      before.executionId ||
      current.revision !== before.prepared.sourceRevision
    )
      return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    update({ ...before, executionId: requestId, pending: true });
    const result = await startDocumentExtraction(
      before.basis,
      before.prepared,
      requestId,
    );
    update(
      result.ok
        ? {
            ...before,
            execution: result.data,
            executionId: result.data.executionId,
            error: null,
            pending: false,
          }
        : {
            ...before,
            executionId: result.error.executionId ?? null,
            error: result.error,
            pending: false,
          },
    );
  }
  /** 한 번의 명시 행동으로 준비와 시작을 잇되 각 단계의 중복 방지 규칙은 그대로 따릅니다. */
  async function run(): Promise<void> {
    const before = snapshot();
    if (
      before.prepared &&
      !before.executionId &&
      before.prepared.sourceRevision === current.revision
    ) {
      await start();
      return;
    }
    if (!canPrepareExtraction(before)) return;
    await prepare();
    await start();
  }
  /** 실패·응답 유실 후에는 이미 시작한 실행만 다시 읽습니다. */
  async function refresh(): Promise<void> {
    const before = snapshot();
    if (before.pending || !before.prepared || !before.executionId) return;
    update({ ...before, pending: true });
    const result = await readDocumentExtraction(
      before.basis,
      before.prepared.proposalId,
      before.executionId,
    );
    update(
      result.ok
        ? { ...before, execution: result.data, error: null, pending: false }
        : { ...before, error: result.error, pending: false },
    );
  }
  return {
    state,
    busy: state.pending,
    canPrepare: canPrepareExtraction(state),
    prepare,
    start,
    run,
    refresh,
    recover,
  };
}

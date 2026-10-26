import type {
  ProposalExecutionBridge,
  ProposalExecutionDetail,
  ProposalExecutionResult,
  ProposalExecutionStart,
} from '@contracts/proposalExecution.contract';
import type { ProposalScope } from '../api/analysisProposal.api';
import { proposalExpectedScope } from '../api/analysisProposal.api';
import type { ProposalRecord } from './analysisProposal.schema';
import { z } from 'zod';
import {
  proposalExecutionStartSchema,
  proposalExecutionDetailSchema,
} from '@contracts/proposalExecution.contract';

const executionRecoveryEntrySchema = z.object({
  request: proposalExecutionStartSchema.nullable(),
  detail: proposalExecutionDetailSchema.nullable(),
  executionId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
});
export const proposalExecutionRecoverySchema =
  executionRecoveryEntrySchema.extend({
    previous: z.array(executionRecoveryEntrySchema).default([]),
  });

export type ProposalExecutionState = {
  request: ProposalExecutionStart | null;
  detail: ProposalExecutionDetail | null;
  executionId: string | null;
  previous: z.infer<typeof executionRecoveryEntrySchema>[];
  busy: boolean;
  error: string | null;
};
/** AI 실행 요청과 후보 영수증 확인을 분리하고 화면 이동 뒤에도 미확인 ID를 유지합니다. */
export class ProposalExecutionSession {
  #state: ProposalExecutionState = {
    request: null,
    detail: null,
    executionId: null,
    previous: [],
    busy: false,
    error: null,
  };
  #listeners = new Set<() => void>();
  readonly scope: ProposalScope;
  readonly gateway: ProposalExecutionBridge;
  beforeStart: () => Promise<void> = async (): Promise<void> => {};
  constructor(scope: ProposalScope, gateway: ProposalExecutionBridge) {
    this.scope = scope;
    this.gateway = gateway;
  }
  /** 같은 snapshot 객체를 React 구독에 제공합니다. */
  snapshot = (): ProposalExecutionState => this.#state;
  /** 실행 상태 변경을 화면과 보호 저장에 전달합니다. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  };
  /** 재시작은 서버 확인이 필요한 로컬 중단 상태로 복원하며 모델을 실행하지 않습니다. */
  restore(value: z.infer<typeof proposalExecutionRecoverySchema>): void {
    this.#set({
      ...value,
      busy: false,
      detail: value.detail
        ? {
            ...value.detail,
            local: {
              ...value.detail.local,
              status: 'idle',
              phase: 'restored_receipt_check',
              preview: '',
            },
          }
        : null,
      error: '복원된 실행입니다. 같은 실행·후보 영수증을 조회해 주세요.',
    });
  }
  /** 새 실행은 앞선 서버 상태를 확인한 명시 동작이며 이전 요청·영수증을 보존합니다. */
  prepareNext(): void {
    if (!this.canPrepareNext()) return;
    const { request, detail, executionId, previous } = this.#state;
    this.#set({
      request: null,
      detail: null,
      executionId: null,
      error: null,
      previous: [...previous, { request, detail, executionId }],
    });
  }
  /** 서버가 종료한 실행과 로컬 종료가 모두 확인돼야 다음 실행을 준비합니다. */
  canPrepareNext(): boolean {
    const { detail, busy } = this.#state;
    if (
      !detail ||
      busy ||
      detail.local.status === 'running' ||
      detail.local.status === 'stopping'
    )
      return false;
    const job = z.object({ state: z.string() }).safeParse(detail.server?.job);
    return (
      ['candidate_ready', 'cancelled', 'superseded', 'basis_changed'].includes(
        typeof detail.server?.state === 'string' ? detail.server.state : '',
      ) ||
      (job.success &&
        ['stopped', 'failed', 'cancelled'].includes(job.data.state))
    );
  }
  /** 시작·조회·취소 결과를 한 번에 공개합니다. */
  #set(patch: Partial<ProposalExecutionState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  /** 응답의 추출안과 실행 ID를 대조하고 다른 실행 결과를 숨깁니다. */
  #accept(result: ProposalExecutionResult): void {
    if (!result.ok) {
      this.#set({
        busy: false,
        error: result.error.message,
        ...(result.error.executionId
          ? { executionId: result.error.executionId }
          : {}),
        ...(['scope_changed', 'forbidden', 'unauthorized'].includes(
          result.error.code,
        )
          ? { detail: null }
          : {}),
      });
      return;
    }
    if (
      result.data.proposalId !== this.#state.request?.proposalId ||
      (this.#state.executionId ?? this.#state.request?.requestId) !==
        result.data.executionId
    ) {
      this.#set({
        busy: false,
        detail: null,
        error: '응답의 추출안·실행 ID가 달라 결과를 숨겼습니다.',
      });
      return;
    }
    this.#set({
      busy: false,
      detail: result.data,
      executionId: result.data.executionId,
      error: null,
    });
  }
  /** 현재 후보·원문·규약 기준에 대한 명시 동작에서만 AI를 시작합니다. */
  async start(record: ProposalRecord, semanticCheck: boolean): Promise<void> {
    if (this.#state.busy || this.#state.request) return;
    const request: ProposalExecutionStart = {
      connectionId: this.scope.connectionId,
      expectedScope: proposalExpectedScope(this.scope),
      proposalId: record.proposal_id,
      requestId: crypto.randomUUID().replaceAll('-', ''),
      expectedStateRevision: record.state_revision,
      candidateRevision: record.candidate_ref?.candidate_revision ?? null,
      semanticCheck,
    };
    this.#set({ busy: true, request, error: null });
    try {
      await this.beforeStart();
    } catch {
      this.#set({
        busy: false,
        request: null,
        error:
          '요청 ID의 보호 저장에 실패해 AI를 시작하지 않았습니다. 현재 입력을 보존합니다.',
      });
      return;
    }
    try {
      const result = await this.gateway.start(request);
      if (
        !result.ok &&
        !result.error.executionId &&
        result.error.code !== 'outcome_unknown'
      )
        this.#set({ request: null });
      this.#accept(result);
    } catch {
      this.#set({
        busy: false,
        error:
          '실행 응답을 잃었습니다. 같은 요청 ID로 조회하며 자동 재실행하지 않습니다.',
      });
    }
  }
  /** 보관된 실행만 조회하며 POST나 모델 재시작을 수행하지 않습니다. */
  async read(): Promise<void> {
    await this.#operation('read');
  }
  /** 로컬 중단과 서버 저장 여부는 독립적으로 다시 확인합니다. */
  async cancel(): Promise<void> {
    await this.#operation('cancel');
  }
  /** 연결 기준과 보관된 실행 ID만 공개 bridge로 전달합니다. */
  async #operation(operation: 'read' | 'cancel'): Promise<void> {
    const request = this.#state.request;
    if (!request || this.#state.busy) return;
    this.#set({ busy: true, error: null });
    try {
      this.#accept(
        await this.gateway[operation]({
          connectionId: this.scope.connectionId,
          expectedScope: proposalExpectedScope(this.scope),
          proposalId: request.proposalId,
          executionId: this.#state.executionId ?? request.requestId,
        }),
      );
    } catch {
      this.#set({
        busy: false,
        error:
          '실행 상태를 확인하지 못했습니다. 요청 ID와 이전 근거를 보존합니다.',
      });
    }
  }
}

import type {
  AnalysisProposalRequest,
  AnalysisProposalResult,
  AnalysisProposalsBridge,
  ProposalRecovery,
} from '@contracts/analysisProposals.contract';
import type { ProposalExecutionBridge } from '@contracts/proposalExecution.contract';
import {
  ProposalExecutionSession,
  proposalExecutionRecoverySchema,
} from './ProposalExecutionSession';
import { ProposalFormDrafts, proposalFormsSchema } from './ProposalFormDrafts';
import { createRecoverySlot } from '@renderer/platform/recovery';
import type { RecoverySlot } from '@renderer/platform/recovery';
import { z } from 'zod';
import { analysisProposalRequestSchema } from '@contracts/analysisProposals.contract';
import type {
  DocumentKnowledge,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import type { ProposalScope } from '../api/analysisProposal.api';
import { proposalExpectedScope } from '../api/analysisProposal.api';
import {
  confirmedApplication,
  proposalSchema,
  proposalValidationSchema,
} from './analysisProposal.schema';
const recoverySnapshotSchema = z.object({
  record: proposalSchema.nullable(),
  archived: z.array(proposalSchema),
  pending: analysisProposalRequestSchema.nullable(),
  recovery: z
    .object({
      proposalId: z.string(),
      requestId: z.string(),
      operation: z.string(),
    })
    .nullable(),
  forms: proposalFormsSchema,
  execution: proposalExecutionRecoverySchema.nullable(),
});
type RecoverySnapshot = z.infer<typeof recoverySnapshotSchema>;
import type {
  ProposalRecord,
  ProposalValidation,
} from './analysisProposal.schema';

export type ProposalSessionState = {
  archived: ProposalRecord[];
  record: ProposalRecord | null;
  observed: ProposalRecord | null;
  validation: ProposalValidation | null;
  receipt: KnowledgeValue | null;
  review: DocumentKnowledge | null;
  busy: boolean;
  error: string | null;
  pending: AnalysisProposalRequest | null;
  recovery: ProposalRecovery | null;
  blocked: boolean;
  recoveryNotice: string | null;
};
/** 앱 메모리의 초안·근거·요청을 원래 범위에 보존합니다. localStorage에는 기록하지 않습니다. */
export class ProposalSession {
  readonly scope: ProposalScope;
  readonly gateway: AnalysisProposalsBridge;
  readonly execution: ProposalExecutionSession | null;
  readonly forms = new ProposalFormDrafts();
  #recoverySlot: RecoverySlot<RecoverySnapshot> | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #recoveryFailed = false;
  #listeners = new Set<() => void>();
  #state: ProposalSessionState = {
    archived: [],
    record: null,
    observed: null,
    validation: null,
    receipt: null,
    review: null,
    busy: false,
    error: null,
    pending: null,
    recovery: null,
    blocked: false,
    recoveryNotice: null,
  };
  constructor(
    scope: ProposalScope,
    gateway: AnalysisProposalsBridge,
    executionGateway?: ProposalExecutionBridge,
  ) {
    this.scope = scope;
    this.gateway = gateway;
    this.execution = executionGateway
      ? new ProposalExecutionSession(scope, executionGateway)
      : null;
    this.execution?.subscribe((): void => this.#set({}));
    if (this.execution)
      this.execution.beforeStart = (): Promise<void> => this.persist();
    this.forms.changed = (): void => this.#scheduleSave();
  }
  /** 현재 계정 확인 후 보호 저장을 읽고 서버 조회를 통과한 자료만 화면에 복원합니다. */
  async initializeRecovery(key: string): Promise<void> {
    const slot = createRecoverySlot(
      this.scope,
      'analysis-proposals',
      key,
      (value: unknown): RecoverySnapshot => recoverySnapshotSchema.parse(value),
    );
    try {
      const restored = await slot.load();
      if (restored) {
        const proposalId =
          restored.record?.proposal_id ??
          restored.recovery?.proposalId ??
          restored.execution?.request?.proposalId;
        let observed: ProposalRecord | null = null;
        if (proposalId) {
          const read = await this.gateway.execute({
            ...this.requestFields(),
            operation: 'read',
            input: { proposal_id: proposalId },
          });
          if (!read.ok)
            throw new Error(
              '보관된 추출 결과의 현재 접근·버전을 확인하지 못했습니다. 서버 연결 후 다시 확인해 주세요.',
            );
          observed = proposalSchema.parse(read.data);
          if (observed.proposal_id !== proposalId)
            throw new Error('복원된 추출 결과 ID가 서버 응답과 다릅니다.');
        }
        this.forms.restore(restored.forms);
        const recovery =
          restored.recovery && restored.pending
            ? { ...restored.recovery, operation: restored.pending.operation }
            : null;
        this.#set({
          record: restored.record,
          archived: restored.archived,
          observed,
          pending: restored.pending,
          recovery,
          blocked: !!restored.record,
          validation: null,
          review: null,
          receipt: null,
          recoveryNotice:
            '종료 전 입력과 원래 버전을 복원했습니다. 현재 서버 후보를 대조하고 명시 선택해 주세요. 확인 체크는 초기화했습니다.',
        });
        if (restored.execution) this.execution?.restore(restored.execution);
      }
      this.#recoverySlot = slot;
    } catch (error: unknown) {
      this.#recoveryFailed = true;
      this.#set({
        recoveryNotice:
          error instanceof Error
            ? error.message
            : '보호 복구를 확인하지 못했습니다.',
      });
    }
  }
  /** 쓰기 전의 정확한 요청과 입력을 보호 저장하며 실패 시 서버 쓰기를 시작하지 않습니다. */
  async persist(): Promise<void> {
    if (this.#recoveryFailed) throw new Error('recovery_unavailable');
    if (!this.#recoverySlot) return;
    await this.#recoverySlot.save({
      record: this.#state.record,
      archived: this.#state.archived,
      pending: this.#state.pending,
      recovery: this.#state.recovery,
      forms: this.forms.snapshot(),
      execution: this.execution
        ? {
            request: this.execution.snapshot().request,
            detail: this.execution.snapshot().detail,
            executionId: this.execution.snapshot().executionId,
            previous: this.execution.snapshot().previous,
          }
        : null,
    });
  }
  /** 타이핑은 짧게 묶어 저장하고 실패를 숨기거나 낡은 버전으로 덮어쓰지 않습니다. */
  #scheduleSave(): void {
    if (!this.#recoverySlot || this.#recoveryFailed) return;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout((): void => {
      this.#saveTimer = null;
      void this.persist().catch((): void => {
        this.#recoveryFailed = true;
        this.#set({
          recoveryNotice:
            '보호 복구 저장에 실패했습니다. 입력은 현재 메모리에 남아 있으며 추가 쓰기를 중지합니다.',
        });
      });
    }, 200);
  }
  /** React가 같은 snapshot을 읽어 불필요한 재구독과 초안 초기화를 막습니다. */
  snapshot = (): ProposalSessionState => this.#state;
  /** 화면이 닫혀도 진행 중 요청과 근거는 세션에 남깁니다. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  };
  /** 관측·쓰기 결과를 한 번에 공개합니다. */
  #set(patch: Partial<ProposalSessionState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
    this.#scheduleSave();
  }
  /** 오류를 안전한 설명으로 남기며 이전 폼·기준을 바꾸지 않습니다. */
  fail(message: string): void {
    this.#set({ error: message });
  }
  /** 새 기준으로 이동할 때 이전 전체 원문·후보·판단 snapshot을 보존합니다. */
  #archive(next: ProposalRecord): ProposalRecord[] {
    const current = this.#state.record;
    if (
      !current ||
      (current.proposal_id === next.proposal_id &&
        current.state_revision === next.state_revision)
    )
      return this.#state.archived;
    if (
      this.#state.archived.some(
        (item: ProposalRecord): boolean =>
          item.proposal_id === current.proposal_id &&
          item.state_revision === current.state_revision,
      )
    )
      return this.#state.archived;
    return [...this.#state.archived, current];
  }
  /** 명시적으로 최신 서버 후보를 새 편집 기준으로 열고 이전 폼 사본은 별도 보존합니다. */
  adoptObserved(): void {
    if (this.#state.observed && !this.#state.pending)
      this.#set({
        archived: this.#archive(this.#state.observed),
        record: this.#state.observed,
        observed: null,
        validation: null,
        blocked: false,
        review: null,
      });
  }
  /** 실제 새 버전의 검토 상태만 완료 폼에 제공합니다. */
  setReview(review: DocumentKnowledge): void {
    this.#set({ review });
  }
  /** 현재 연결의 범위를 모든 작업에 부착합니다. */
  requestFields(): {
    connectionId: string;
    expectedScope: ReturnType<typeof proposalExpectedScope>;
  } {
    return {
      connectionId: this.scope.connectionId,
      expectedScope: proposalExpectedScope(this.scope),
    };
  }
  /** 결과 유실 시 GET으로만 조회하고 원 요청의 POST를 자동 반복하지 않습니다. */
  async reconcile(): Promise<void> {
    const pending = this.#state.pending;
    const recovery = this.#state.recovery;
    if (!pending || !recovery) return;
    const byRead =
      pending.operation === 'prepare' ||
      pending.operation === 'decide' ||
      pending.operation === 'complete';
    await this.run(
      byRead
        ? {
            ...this.requestFields(),
            operation: 'read',
            input: { proposal_id: recovery.proposalId },
          }
        : {
            ...this.requestFields(),
            operation: 'receipt',
            input: {
              proposal_id: recovery.proposalId,
              request_id: recovery.requestId,
            },
          },
    );
  }
  /** 수정 명령은 단일 실행하며 CAS 충돌과 미확정 저장을 재시도 가능한 성공으로 바꾸지 않습니다. */
  async run(request: AnalysisProposalRequest): Promise<void> {
    const mutation = !['read', 'validate', 'receipt'].includes(
      request.operation,
    );
    if (
      this.#state.busy ||
      (mutation &&
        (this.#state.pending ||
          (this.#state.blocked && request.operation !== 'prepare')))
    )
      return;
    const pendingBefore = this.#state.pending;
    let recovery: ProposalRecovery | null =
      'request_id' in request.input && 'proposal_id' in request.input
        ? {
            proposalId: request.input.proposal_id,
            requestId: request.input.request_id,
            operation: request.operation,
          }
        : null;
    this.#set({
      busy: true,
      error: null,
      ...(mutation ? { pending: request, recovery, validation: null } : {}),
    });
    // IPC 응답 자체가 유실되어도 생성 요청을 GET으로 식별할 수 있습니다.
    if (request.operation === 'prepare') {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          `${this.scope.tenant}:${this.scope.userId}:${request.input.request_id}`,
        ),
      );
      const proposalId = [...new Uint8Array(digest)]
        .map((value: number): string => value.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 32);
      recovery = {
        proposalId,
        requestId: request.input.request_id,
        operation: request.operation,
      };
      this.#set({ recovery });
    }
    let result: AnalysisProposalResult;
    if (mutation) {
      try {
        await this.persist();
      } catch {
        this.#set({
          busy: false,
          pending: null,
          error:
            '요청의 보호 저장에 실패해 서버에 전송하지 않았습니다. 입력을 보존합니다.',
        });
        return;
      }
    }
    try {
      result = await this.gateway.execute(request);
    } catch {
      result = {
        ok: false,
        error: {
          code: 'outcome_unknown',
          message: '응답을 확인하지 못했습니다. 초안과 요청을 보존합니다.',
        },
      };
    }
    if (!result.ok) {
      const uncertain = mutation && result.error.code === 'outcome_unknown';
      this.#set({
        busy: false,
        error: `${result.error.message}${result.error.cleanupWarningCount ? ` 임시 파일 정리 경고 ${result.error.cleanupWarningCount}건.` : ''}`,
        blocked:
          this.#state.blocked ||
          ['conflict', 'scope_changed', 'forbidden', 'unauthorized'].includes(
            result.error.code,
          ),
        ...(mutation && !uncertain ? { pending: null } : {}),
        ...(result.error.recovery ? { recovery: result.error.recovery } : {}),
      });
      return;
    }
    try {
      if (request.operation === 'validate') {
        this.#set({
          validation: proposalValidationSchema.parse(result.data),
          busy: false,
        });
      } else if (
        request.operation === 'apply' ||
        request.operation === 'receipt'
      ) {
        const data = result.data;
        if (
          data.proposal_id !== request.input.proposal_id ||
          data.request_id !== request.input.request_id
        )
          throw new Error('receipt_mismatch');
        const resolved =
          (data.state === 'complete' &&
            (confirmedApplication(data) ||
              (data.saved === false && data.canonical_changed === false))) ||
          (data.state === 'rejected' && data.saved === false);
        const matchesPending =
          !this.#state.pending ||
          ('request_id' in this.#state.pending.input &&
            this.#state.pending.input.request_id === request.input.request_id);
        this.#set({
          receipt: data,
          busy: false,
          pending: resolved && matchesPending ? null : this.#state.pending,
          blocked:
            this.#state.blocked ||
            !resolved ||
            (matchesPending && !!this.#state.pending),
          error: resolved
            ? null
            : '일부 기록 또는 저장 상태가 미확인입니다. 같은 요청 확인 기록으로 확인해 주세요.',
        });
        // 후보 제출 확인 기록은 canonical 저장 성공을 뜻하지 않으며 최신 후보를 별도로 읽습니다.
      } else {
        const record = proposalSchema.parse(result.data);
        if (
          request.operation === 'prepare' &&
          record.proposal_id !== recovery?.proposalId
        )
          throw new Error('prepare_id_mismatch');
        if (
          'proposal_id' in request.input &&
          record.proposal_id !== request.input.proposal_id
        )
          throw new Error('proposal_mismatch');
        let recovered = false;
        if (
          request.operation === 'read' &&
          pendingBefore &&
          this.#state.recovery
        ) {
          const requestId = this.#state.recovery.requestId;
          recovered = record.events.some(
            (event: KnowledgeValue): boolean =>
              event.request_id === requestId || event.decision_id === requestId,
          );
        }
        const replace = mutation || !this.#state.record;
        this.#set({
          busy: false,
          ...(replace
            ? { archived: this.#archive(record), record, observed: null }
            : { observed: record }),
          ...(mutation || recovered ? { pending: null, recovery: null } : {}),
          validation: null,
          ...(request.operation === 'prepare'
            ? { receipt: null, review: null, blocked: false }
            : {}),
        });
      }
    } catch {
      this.#set({
        busy: false,
        error:
          '응답의 필수 근거를 확인하지 못했습니다. 성공으로 처리하지 않고 입력을 보존합니다.',
        ...(mutation ? {} : { blocked: true }),
      });
    }
  }
}

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AnalysisProposalRequest } from '@contracts/analysisProposals.contract';
import type {
  DocumentKnowledge,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { loadProposalKnowledge } from '../api/analysisProposal.api';
import type { ProposalSession, ProposalSessionState } from './ProposalSession';
import {
  canApplyProposal,
  confirmedApplication,
  currentProposalSource,
  parseContexts,
  parseObject,
  parseBindings,
  splitIds,
} from './analysisProposal.schema';
import type {
  ProposalRecord,
  ProposalClaim,
  PrepareFields,
  SubmitFields,
  DecisionFields,
  CompletionFields,
} from './analysisProposal.schema';
import { automaticCheckPassed, proposalRelations } from './proposalRelations';
import type { ProposalRelations } from './proposalRelations';

type ProposalWorkspaceModel = {
  state: ProposalSessionState;
  record: ProposalRecord | null;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  selected: ProposalClaim | null;
  relations: ProposalRelations;
  automaticPassed: boolean;
  isConfirmed: boolean;
  setConfirmed: (confirmed: boolean) => void;
  receipt: KnowledgeValue | null;
  saved: boolean;
  canWrite: boolean;
  diagnosticRecord: ProposalRecord | null;
  controls: {
    prepareDisabled: boolean;
    lookupDisabled: boolean;
    validateDisabled: boolean;
    applyDisabled: boolean;
    decisionDisabled: boolean;
    completionDisabled: boolean;
    executionDisabled: boolean;
  };
  editLocked: boolean;
  draftKey: string;
  currentSource: KnowledgeValue | null;
  review: DocumentKnowledge | null;
  proposalCurrentForCompletion: boolean;
  reviewCurrent: boolean;
  completions: KnowledgeValue[];
  prepare: (values: PrepareFields) => Promise<void>;
  submit: (values: SubmitFields) => void;
  decide: (values: DecisionFields) => void;
  readReview: () => Promise<void>;
  complete: (values: CompletionFields) => void;
  read: (id: string) => void;
  validateOrApply: (operation: 'validate' | 'apply') => void;
};

/** 요청별 ID는 전송 전에 만들며 재조회 시 동일 ID를 유지합니다. */
function requestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** 현재 후보의 잠금·실제 저장·검토 버전을 한 번 판단하고 원래 기준으로만 요청합니다. */
export function useProposalWorkspace(
  session: ProposalSession,
): ProposalWorkspaceModel {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isConfirmed, setConfirmed] = useState(false);
  const record = state.record;
  const relations = proposalRelations(record);
  const automaticPassed =
    !!record && automaticCheckPassed(record, state.validation);
  const selected =
    record?.missing_claims.find(
      (claim: ProposalClaim): boolean => claim.claim_id === selectedId,
    ) ?? null;
  const savedApplications = record
    ? Object.values(record.applications).filter(
        (entry: KnowledgeValue): boolean => confirmedApplication(entry),
      )
    : [];
  const receipt = confirmedApplication(state.receipt)
    ? state.receipt
    : (savedApplications.at(-1) ?? null);
  const saved = confirmedApplication(receipt);
  const hasUncertainApplication = record
    ? Object.values(record.applications).some(
        (entry: KnowledgeValue): boolean =>
          entry.state !== 'complete' && entry.saved !== false,
      )
    : false;
  const executionState = session.execution?.snapshot();
  const executing =
    executionState?.busy ||
    executionState?.detail?.local.status === 'running' ||
    executionState?.detail?.local.status === 'stopping';
  const executionUnresolved =
    !!executionState?.request && !executionState.detail;
  const locked =
    state.busy ||
    !!state.pending ||
    state.blocked ||
    hasUncertainApplication ||
    !!executing ||
    executionUnresolved;
  const canWrite = session.scope.permissions.includes('ontology_write');
  const canReview = session.scope.permissions.includes('ontology_review');
  const editLocked =
    locked || !canWrite || record?.basis_status !== 'current' || saved;
  const draftKey = `${record?.proposal_id ?? 'prepare'}:${record?.state_revision ?? ''}`;
  const currentSource = record ? currentProposalSource(record) : null;
  const review = state.review;
  const applied =
    receipt &&
    typeof receipt.receipt === 'object' &&
    receipt.receipt !== null &&
    !Array.isArray(receipt.receipt)
      ? receipt.receipt
      : null;
  const proposalCurrentForCompletion =
    !state.receipt || state.receipt.state_revision === record?.state_revision;
  const reviewCurrent =
    !!review &&
    !!applied &&
    review.sourceRevision === applied.source_revision &&
    review.graphRevision === applied.graph_revision;
  const completions =
    record?.events.filter(
      (event: KnowledgeValue): boolean => event.kind === 'comparison_completed',
    ) ?? [];

  /** 후보가 열리면 상태를 바꾸지 않는 서버 검사를 한 번 읽어 "자동 검사 통과" 표시의 근거로 씁니다. */
  const checkedKey = useRef<string>('');
  useEffect((): void => {
    if (
      !record?.candidate_ref ||
      record.basis_status !== 'current' ||
      saved ||
      state.busy ||
      state.pending ||
      state.blocked ||
      automaticPassed
    )
      return;
    const key = `${record.proposal_id}:${record.state_revision}`;
    // 검사 실패 뒤에도 같은 상태에서 반복 요청하지 않습니다.
    if (checkedKey.current === key) return;
    checkedKey.current = key;
    void session.run({
      ...session.requestFields(),
      operation: 'validate',
      input: { proposal_id: record.proposal_id },
    });
  }, [
    record,
    saved,
    state.busy,
    state.pending,
    state.blocked,
    state.validation,
    automaticPassed,
    session,
  ]);

  /** 원문 고정 전에 현재 원문·검토 버전을 읽어 서버 CAS에 전달합니다. */
  async function prepare(values: PrepareFields): Promise<void> {
    try {
      const contexts = parseContexts(values.contexts);
      if (!contexts) return;
      const knowledge = await loadProposalKnowledge(
        session.scope,
        values.document,
      );
      await session.run({
        ...session.requestFields(),
        operation: 'prepare',
        input: {
          request_id: requestId(),
          document: values.document,
          expected_source_revision: knowledge.sourceRevision,
          expected_state_revision: knowledge.stateRevision,
          context_documents: contexts,
        },
      });
    } catch (error: unknown) {
      session.fail(
        error instanceof Error
          ? error.message
          : '입력 기준 조회에 실패했습니다.',
      );
    }
  }
  /** 새 전체 결과와 명시 대응은 현재 폼의 고정 proposal 상태로 제출합니다. */
  function submit(values: SubmitFields): void {
    if (!record) return;
    const submission = parseObject(values.whole);
    const bindings = parseBindings(values.bindings);
    if (!submission || !bindings) return;
    void session.run({
      ...session.requestFields(),
      operation: 'submit',
      input: {
        proposal_id: record.proposal_id,
        request_id: requestId(),
        expected_state_revision: record.state_revision,
        submission,
        resolves_decision_ids: splitIds(values.resolves),
        resolution_bindings: bindings,
      },
    });
  }
  /** 복구·제외·재추출은 현재 선택한 실제 미발견 claim에만 적용합니다. */
  function decide(values: DecisionFields): void {
    if (!record?.candidate_ref || !selected) return;
    void session.run({
      ...session.requestFields(),
      operation: 'decide',
      input: {
        proposal_id: record.proposal_id,
        request_id: requestId(),
        expected_state_revision: record.state_revision,
        candidate_revision: record.candidate_ref.candidate_revision,
        old_claim_id: selected.claim_id,
        action: values.action,
        reason: values.reason,
        evidence: values.evidence,
        checked_whole: values.checkedWhole,
        replacement:
          values.action === 'keep' ? parseObject(values.replacement) : null,
      },
    });
  }
  /** 새 버전의 실제 서버 검토를 별도로 읽고 화면에 버전을 표시합니다. */
  async function readReview(): Promise<void> {
    if (!record) return;
    try {
      session.setReview(
        await loadProposalKnowledge(
          session.scope,
          record.basis.target_document,
        ),
      );
    } catch (error: unknown) {
      session.fail(
        error instanceof Error
          ? error.message
          : '현재 검토를 조회하지 못했습니다.',
      );
    }
  }
  /** 완료 요청은 방금 읽은 실제 검토 버전과 명시 선택만 사용합니다. */
  function complete(values: CompletionFields): void {
    if (!record || !review || !reviewCurrent) return;
    void session.run({
      ...session.requestFields(),
      operation: 'complete',
      input: {
        proposal_id: record.proposal_id,
        request_id: requestId(),
        expected_state_revision: record.state_revision,
        expected_review_state_revision: review.stateRevision,
        reviewed_claim_ids: values.reviewed,
        reason: values.reason,
      },
    });
  }
  /** 읽기는 현재 폼의 기준을 바꾸지 않고 옆의 관측 결과로 보존합니다. */
  function read(id: string): void {
    void session.run({
      ...session.requestFields(),
      operation: 'read',
      input: { proposal_id: id },
    });
  }
  /** 상태 변경 없는 검증과 후보 적용을 구분합니다. */
  function validateOrApply(operation: 'validate' | 'apply'): void {
    if (!record?.candidate_ref) return;
    const request: AnalysisProposalRequest =
      operation === 'validate'
        ? {
            ...session.requestFields(),
            operation,
            input: { proposal_id: record.proposal_id },
          }
        : {
            ...session.requestFields(),
            operation,
            input: {
              proposal_id: record.proposal_id,
              request_id: requestId(),
              expected_state_revision: record.state_revision,
              candidate_revision: record.candidate_ref.candidate_revision,
            },
          };
    setConfirmed(false);
    void session.run(request);
  }

  const lookupDisabled =
    state.busy || !!state.pending || !!executing || executionUnresolved;
  return {
    state,
    record,
    selectedId,
    setSelectedId,
    selected,
    relations,
    automaticPassed,
    isConfirmed,
    setConfirmed,
    receipt,
    saved,
    canWrite,
    diagnosticRecord:
      !executing &&
      (!executionState?.request ||
        record?.active_execution_id === executionState.executionId)
        ? record
        : null,
    controls: {
      prepareDisabled: lookupDisabled || !canWrite,
      lookupDisabled,
      validateDisabled: locked || saved,
      applyDisabled:
        editLocked ||
        !isConfirmed ||
        relations.undecidedIds.length > 0 ||
        !canApplyProposal(record, state.validation),
      decisionDisabled:
        locked || !canReview || saved || record?.basis_status !== 'current',
      completionDisabled:
        locked || !canReview || !reviewCurrent || !proposalCurrentForCompletion,
      executionDisabled:
        editLocked || !session.scope.permissions.includes('source_write'),
    },
    editLocked,
    draftKey,
    currentSource,
    review,
    proposalCurrentForCompletion,
    reviewCurrent,
    completions,
    prepare,
    submit,
    decide,
    readReview,
    complete,
    read,
    validateOrApply,
  };
}

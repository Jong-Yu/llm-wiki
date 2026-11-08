import { sameAccessRevision } from '@contracts/connection.contract';
import { z } from 'zod';
import type { DocumentContent } from '@contracts/documents.contract';
import type { ProposalRecovery } from '@contracts/analysisProposals.contract';
import type { ProposalExecutionDetail } from '@contracts/proposalExecution.contract';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import { analysisProposalsGateway } from '@renderer/platform/analysisProposals';
import { connectionGateway } from '@renderer/platform/connection';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { proposalExecutionGateway } from '@renderer/platform/proposalExecution';

const identifier = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const preparedSchema = z.object({
  proposal_id: identifier,
  state_revision: revision,
  basis_status: z.enum(['current', 'changed_or_unavailable']),
  basis: z.object({
    target_document: z.string(),
    documents: z.array(
      z.object({
        document: z.string(),
        source: z.object({ revision }),
      }),
    ),
  }),
  candidate_ref: z.object({ candidate_revision: revision }).nullable(),
});

export type PreparedDocumentExtraction = {
  document: string;
  proposalId: string;
  stateRevision: string;
  candidateRevision: string | null;
  sourceRevision: string;
};
export type DocumentExtractionFailure = {
  code: string;
  message: string;
  status?: number;
  executionId?: string;
  recovery?: ProposalRecovery;
};
export type DocumentExtractionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DocumentExtractionFailure };

/** 본문을 읽은 주체·공간·관점을 재추출 요청의 고정 비교값으로 사용합니다. */
function expectedScope(current: DocumentContent): WorkspaceScope {
  return {
    userId: current.access.userId,
    tenant: current.access.tenant,
    profileId: current.access.profileId,
    policyRevision: current.access.policyRevision,
    ...(current.access.accessRevision
      ? { accessRevision: current.access.accessRevision }
      : {}),
  };
}

/** 진행 중 범위 변경을 숨기지 않고 이전 문서의 결과 노출을 막습니다. */
async function matchesScope(current: DocumentContent): Promise<boolean> {
  const result = await connectionGateway.getState();
  if (!result.ok || result.data.status !== 'connected') return false;
  const state = result.data;
  return (
    state.connectionId === current.connectionId &&
    state.userId === current.access.userId &&
    sameAccessRevision(state, current.access) &&
    state.selection?.tenant === current.access.tenant &&
    state.selection.profile === current.access.profileId
  );
}

/** 실패에도 요청 식별자를 유지해 사용자 재조회가 새 실행이 되지 않게 합니다. */
function failure<T>(
  code: string,
  message: string,
  references: Pick<DocumentExtractionFailure, 'executionId' | 'recovery'> = {},
): DocumentExtractionResult<T> {
  return { ok: false, error: { code, message, ...references } };
}

/** prepare 응답 유실 뒤 POST 없이 같은 추출 결과을 찾는 서버의 결정적 ID입니다. */
async function proposalRecovery(
  current: DocumentContent,
  requestId: string,
): Promise<ProposalRecovery> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      `${current.access.tenant}:${current.access.userId}:${requestId}`,
    ),
  );
  const proposalId = [...new Uint8Array(digest)]
    .map((value: number): string => value.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return { proposalId, requestId, operation: 'prepare' };
}

/** 실제 캡처 문서·본문 판본이 화면에서 읽은 대상과 일치할 때만 실행 기준을 반환합니다. */
function parsePrepared(
  value: unknown,
  current: DocumentContent,
  proposalId: string,
): PreparedDocumentExtraction | null {
  const parsed = preparedSchema.safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  const source = record.basis.documents.find(
    (entry: (typeof record.basis.documents)[number]): boolean =>
      entry.document === current.document,
  );
  if (
    record.proposal_id !== proposalId ||
    record.basis.target_document !== current.document ||
    source?.source.revision !== current.revision ||
    record.basis_status !== 'current'
  )
    return null;
  return {
    document: current.document,
    proposalId: record.proposal_id,
    stateRevision: record.state_revision,
    candidateRevision: record.candidate_ref?.candidate_revision ?? null,
    sourceRevision: source.source.revision,
  };
}

/** 최신 검토 판본으로 전체 문서의 추출 입력을 고정하며 아직 모델은 실행하지 않습니다. */
export async function prepareDocumentExtraction(
  current: DocumentContent,
): Promise<DocumentExtractionResult<PreparedDocumentExtraction>> {
  let recovery: ProposalRecovery | undefined;
  let submitted = false;
  try {
    if (!(await matchesScope(current)))
      return failure('scope_changed', '연결과 작업 공간을 다시 확인해 주세요.');
    const knowledge = await knowledgeGateway.read({
      connectionId: current.connectionId,
      document: current.document,
    });
    if (!(await matchesScope(current)))
      return failure('scope_changed', '조회 중 작업 공간이 변경되었습니다.');
    if (!knowledge.ok) return knowledge;
    const value = knowledge.data;
    if (
      value.connectionId !== current.connectionId ||
      value.document !== current.document ||
      value.access.userId !== current.access.userId ||
      value.access.tenant !== current.access.tenant ||
      value.access.profileId !== current.access.profileId ||
      !sameAccessRevision(value.access, current.access)
    )
      return failure(
        'scope_changed',
        '재추출 기준의 문서·권한 범위가 달라졌습니다.',
      );
    if (value.sourceRevision !== current.revision)
      return failure(
        'proposal_basis_changed',
        '본문이 변경되었습니다. 최신 본문을 확인한 뒤 다시 요청해 주세요.',
      );
    const requestId = crypto.randomUUID().replaceAll('-', '');
    recovery = await proposalRecovery(current, requestId);
    if (!(await matchesScope(current)))
      return failure(
        'scope_changed',
        '입력 준비 전에 작업 공간이 변경되었습니다.',
      );
    submitted = true;
    const result = await analysisProposalsGateway.execute({
      connectionId: current.connectionId,
      expectedScope: expectedScope(current),
      operation: 'prepare',
      input: {
        request_id: requestId,
        document: current.document,
        expected_source_revision: value.sourceRevision,
        expected_state_revision: value.stateRevision,
        context_documents: [],
      },
    });
    if (!(await matchesScope(current)))
      return failure(
        'outcome_unknown',
        '입력 준비 중 작업 공간이 변경되었습니다. 같은 추출 결과의 저장 상태를 확인해 주세요.',
        { recovery },
      );
    if (!result.ok)
      return {
        ok: false,
        error: {
          ...result.error,
          ...(result.error.code === 'outcome_unknown' && !result.error.recovery
            ? { recovery }
            : {}),
        },
      };
    const prepared = parsePrepared(result.data, current, recovery.proposalId);
    if (!prepared)
      return failure(
        'outcome_unknown',
        '준비된 추출 결과의 문서와 버전을 확인하지 못했습니다. 같은 추출 결과을 다시 조회해 주세요.',
        { recovery },
      );
    return { ok: true, data: prepared };
  } catch {
    return failure(
      submitted ? 'outcome_unknown' : 'extraction_prepare_failed',
      submitted
        ? '입력 준비 응답을 확인하지 못했습니다. 같은 추출 결과 조회로 확인해 주세요.'
        : '재추출 입력 기준을 읽지 못했습니다. 초안은 그대로 보존됩니다.',
      recovery ? { recovery } : {},
    );
  }
}

/** 준비 요청의 응답이 유실되면 생성 대신 기존 추출 결과을 읽어 복구합니다. */
export async function readPreparedDocumentExtraction(
  current: DocumentContent,
  proposalId: string,
): Promise<DocumentExtractionResult<PreparedDocumentExtraction>> {
  try {
    if (!(await matchesScope(current)))
      return failure('scope_changed', '연결과 작업 공간을 다시 확인해 주세요.');
    const result = await analysisProposalsGateway.execute({
      connectionId: current.connectionId,
      expectedScope: expectedScope(current),
      operation: 'read',
      input: { proposal_id: proposalId },
    });
    if (!(await matchesScope(current)))
      return failure('scope_changed', '조회 중 작업 공간이 변경되었습니다.');
    if (!result.ok) return result;
    const prepared = parsePrepared(result.data, current, proposalId);
    if (!prepared)
      return failure(
        'proposal_basis_changed',
        '추출 결과의 입력 기준을 현재 본문과 대조할 수 없습니다. 최신 본문과 기존 추출 결과을 확인해 주세요.',
      );
    return { ok: true, data: prepared };
  } catch {
    return failure(
      'extraction_read_failed',
      '준비된 추출 결과을 읽지 못했습니다. 요청 ID를 보존합니다.',
    );
  }
}

/** 고정 입력으로 선택된 개인 CLI를 한 번 시작하고 후보 생성과 Wiki 적용을 구분합니다. */
export async function startDocumentExtraction(
  current: DocumentContent,
  prepared: PreparedDocumentExtraction,
  requestId: string,
): Promise<DocumentExtractionResult<ProposalExecutionDetail>> {
  let submitted = false;
  try {
    if (!(await matchesScope(current)))
      return failure('scope_changed', '연결과 작업 공간을 다시 확인해 주세요.');
    if (
      prepared.document !== current.document ||
      prepared.sourceRevision !== current.revision
    )
      return failure(
        'proposal_basis_changed',
        '준비한 재추출 입력과 현재 본문이 다릅니다.',
      );
    if (!identifier.safeParse(requestId).success)
      return failure('invalid_request', '재추출 요청 ID를 확인해 주세요.');
    submitted = true;
    const result = await proposalExecutionGateway.start({
      connectionId: current.connectionId,
      expectedScope: expectedScope(current),
      proposalId: prepared.proposalId,
      requestId,
      expectedStateRevision: prepared.stateRevision,
      candidateRevision: prepared.candidateRevision,
      semanticCheck: false,
    });
    if (!(await matchesScope(current)))
      return failure(
        'outcome_unknown',
        '실행 중 작업 공간이 변경되었습니다. 같은 실행 상태를 다시 확인해 주세요.',
        { executionId: requestId },
      );
    if (!result.ok)
      return {
        ok: false,
        error: {
          ...result.error,
          ...(result.error.code === 'outcome_unknown' &&
          !result.error.executionId
            ? { executionId: requestId }
            : {}),
        },
      };
    if (
      result.data.proposalId !== prepared.proposalId ||
      result.data.executionId !== requestId
    )
      return failure(
        'outcome_unknown',
        '재추출 응답의 실행 ID가 다릅니다. 같은 실행을 조회해 주세요.',
        {
          executionId: requestId,
        },
      );
    return result;
  } catch {
    return failure(
      submitted ? 'outcome_unknown' : 'extraction_start_failed',
      submitted
        ? '실행 응답을 확인하지 못했습니다. 자동 재실행 없이 같은 실행 ID로 조회해 주세요.'
        : '재추출 실행 전 연결을 확인하지 못했습니다.',
      submitted ? { executionId: requestId } : {},
    );
  }
}

/** 실행 조회는 모델을 재시작하거나 생성 후보를 현재 그래프에 적용하지 않습니다. */
export async function readDocumentExtraction(
  current: DocumentContent,
  proposalId: string,
  executionId: string,
): Promise<DocumentExtractionResult<ProposalExecutionDetail>> {
  try {
    if (!(await matchesScope(current)))
      return failure(
        'scope_changed',
        '연결과 작업 공간을 다시 확인해 주세요.',
        { executionId },
      );
    const result = await proposalExecutionGateway.read({
      connectionId: current.connectionId,
      expectedScope: expectedScope(current),
      proposalId,
      executionId,
    });
    if (!(await matchesScope(current)))
      return failure(
        'scope_changed',
        '실행 조회 중 작업 공간이 변경되었습니다.',
        { executionId },
      );
    if (!result.ok) return result;
    if (
      result.data.proposalId !== proposalId ||
      result.data.executionId !== executionId
    )
      return failure(
        'invalid_response',
        '다른 실행의 응답은 표시하지 않습니다.',
        { executionId },
      );
    return result;
  } catch {
    return failure(
      'extraction_read_failed',
      '실행 상태를 읽지 못했습니다. 같은 실행 ID를 보존합니다.',
      {
        executionId,
      },
    );
  }
}

import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { ReviewAnalysisProposals } from '../../src/renderer/features/review-analysis-proposals';
import type {
  AnalysisProposalRequest,
  AnalysisProposalResult,
  AnalysisProposalsBridge,
} from '../../src/shared/contracts/analysisProposals.contract';
import type { KnowledgeValue } from '../../src/shared/contracts/knowledge.contract';
import '../../src/renderer/shared/theme/tokens.css';
import type {
  ProposalExecutionBridge,
  ProposalExecutionDetail,
} from '../../src/shared/contracts/proposalExecution.contract';

const hash = 'a'.repeat(64);
const id = 'b'.repeat(32);
const claimId = 'c'.repeat(64);
const original: KnowledgeValue = {
  claim_id: claimId,
  collection: 'relations',
  value: {
    subject: 'model',
    predicate: 'uses',
    object: 'sensor',
    evidence: { quote: '모델은 센서를 사용한다.', start_line: 1, end_line: 1 },
    qualifiers: {
      polarity: 'positive',
      modality: 'asserted',
      condition: null,
      scope: null,
      time: null,
    },
  },
  decision: 'unreviewed',
};
const record: KnowledgeValue = {
  proposal_id: id,
  input_revision: hash,
  state_revision: hash,
  basis_status: 'current',
  basis: {
    target_document: '격리-추출안.md',
    documents: [
      {
        document: '격리-추출안.md',
        source: {
          revision: hash,
          content:
            '모델은 센서를 사용한다.\n현재 원문과 전체 추출안을 대조합니다.\n',
        },
      },
    ],
    previous: {
      status: 'captured',
      graph: { relations: [original.value] },
      claims: [original],
      source: { content: '모델은 센서를 사용한다.\n이전 원문 근거입니다.' },
      source_restoration: 'restored_history',
    },
  },
  candidate_ref: { candidate_id: id, candidate_revision: hash },
  submission: {
    schema_version: 3,
    entities: [],
    relations: [],
    relation_candidates: [],
    attributes: [],
  },
  preview_claims: [],
  missing_claims: [original],
  decisions: [],
  events: [],
  applications: {},
  submission_schema: {},
  rules_components: {},
  human_approval: false,
  semantic_validation: 'not_run',
};
const gateway: AnalysisProposalsBridge = {
  execute: async (
    request: AnalysisProposalRequest,
  ): Promise<AnalysisProposalResult> => {
    if (request.operation === 'submit')
      return {
        ok: false,
        error: {
          code: 'conflict',
          message: '격리 fixture의 CAS 충돌: 이전 초안을 보존합니다.',
        },
      };
    if (request.operation === 'apply')
      return {
        ok: false,
        error: {
          code: 'outcome_unknown',
          message: '격리 fixture의 저장 결과 미확인',
        },
      };
    if (request.operation === 'validate')
      return {
        ok: true,
        data: {
          proposal_id: id,
          state_revision: hash,
          candidate_ref: record.candidate_ref,
          automatic: 'passed',
          semantic: 'not_run',
          human_approval: false,
        },
        traceId: id,
      };
    return { ok: true, data: record, traceId: id };
  },
};
let executionDetail: ProposalExecutionDetail | null = null;
const executionGateway: ProposalExecutionBridge = {
  start: async (request) => {
    executionDetail = {
      proposalId: request.proposalId,
      executionId: request.requestId,
      local: {
        status: 'running',
        phase: 'extracting',
        errorCode: null,
        requestId: null,
        preview: '합성 UI 미리보기',
        previewTruncated: false,
        cleanupWarning: false,
      },
      server: { state: 'ready', canonical_changed: false },
    };
    return { ok: true, data: executionDetail };
  },
  read: async () => {
    if (!executionDetail)
      return { ok: false, error: { code: 'not_found', message: '실행 없음' } };
    executionDetail = {
      ...executionDetail,
      local: {
        ...executionDetail.local,
        status: 'exited',
        phase: 'candidate_ready',
      },
      server: { state: 'candidate_ready', canonical_changed: false },
    };
    record.active_execution_id = executionDetail.executionId;
    return { ok: true, data: executionDetail };
  },
  cancel: async () => {
    if (!executionDetail)
      return { ok: false, error: { code: 'not_found', message: '실행 없음' } };
    executionDetail = {
      ...executionDetail,
      local: { ...executionDetail.local, status: 'exited', phase: 'cancelled' },
      server: { state: 'cancelled', canonical_changed: false },
    };
    return { ok: true, data: executionDetail };
  },
};
Object.defineProperty(window, 'wiki', {
  value: {
    recovery: {
      execute: async (request: {
        operation: string;
        kind: string;
        key?: string;
        payload?: string;
      }): Promise<unknown> => ({
        ok: true,
        data: {
          entries:
            request.operation === 'put'
              ? [
                  {
                    kind: request.kind,
                    key: request.key,
                    payload: request.payload,
                    revision: hash,
                    savedAt: new Date().toISOString(),
                  },
                ]
              : [],
          cleanupWarningCount: 0,
        },
      }),
    },
    connection: {
      getState: async (): Promise<unknown> => ({
        ok: true,
        data: {
          status: 'connected',
          connectionId: 'fixture',
          userId: 'alice',
          policyRevision: hash,
          selection: { tenant: 'fixture', profile: 'all' },
          workspaces: [
            {
              id: 'fixture',
              permissions: [
                'read',
                'source_write',
                'ontology_write',
                'ontology_review',
              ],
              profiles: [{ id: 'all' }],
            },
          ],
        },
      }),
    },
  },
});
const element = document.getElementById('root');
if (!element) throw new Error('fixture root missing');
createRoot(element).render(
  <MemoryRouter>
    <div className="wiki-theme" data-wiki-theme="light">
      <ReviewAnalysisProposals
        gateway={gateway}
        executionGateway={
          new URLSearchParams(location.search).has('execution')
            ? executionGateway
            : undefined
        }
        initialProposalId={id}
      />
    </div>
  </MemoryRouter>,
);

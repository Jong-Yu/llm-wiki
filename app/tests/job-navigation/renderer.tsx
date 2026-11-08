import { StrictMode, useEffect } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { AnalysisJobWorkspace } from '../../src/renderer/features/browse-ai-sessions/ui/AnalysisJobWorkspace';
import {
  analysisDetailSchema,
  analysisReadRequestSchema,
  analysisExecuteRequestSchema,
  analysisCancelRequestSchema,
} from '../../src/shared/contracts/analysis.contract';
import type {
  AnalysisDetail,
  AnalysisReadRequest,
  AnalysisExecuteRequest,
  AnalysisCancelRequest,
} from '../../src/shared/contracts/analysis.contract';
import '../../src/renderer/shared/theme/tokens.css';
import '../../src/renderer/shared/theme/controls.scss';
import { AppShell } from '../../src/renderer/app/AppShell';
import {
  visualConnection,
  visualActivity,
  visualJob,
  visualComparisonList,
  visualComparisonDetail,
} from '../ai-sessions/visualFixtures';
const visual = new URLSearchParams(location.search).has('visual');

const jobId = 'a'.repeat(32);
const inspectedRevision = '8'.repeat(64);
type FixtureMode =
  | 'ok'
  | 'read403'
  | 'inspect403'
  | 'execute403'
  | 'wrongRead'
  | 'wrongInspect'
  | 'wrongExecute';
type Call = {
  operation: string;
  request: AnalysisReadRequest | AnalysisExecuteRequest | AnalysisCancelRequest;
};
type Checks = {
  mode: FixtureMode;
  mounts: number;
  calls: Call[];
  executionMode: 'start' | 'resume';
  cancelled: boolean;
};
const checks: Checks = {
  mode: 'ok',
  mounts: 0,
  calls: [],
  executionMode: 'start',
  cancelled: false,
};
Reflect.set(window, '__jobChecks', checks);

/** 공용 응답 스키마를 통과한 격리 작업이며 실제 AI·서버 자료는 사용하지 않습니다. */
function detail(
  id: string = jobId,
  revision: string = '7'.repeat(64),
): AnalysisDetail {
  if (visual) return visualJob();
  return analysisDetailSchema.parse({
    job: {
      actor: {
        user_id: 'fixture-user',
        tenant: 'fixture',
        profile_id: 'default',
        domain: null,
        viewpoint: null,
        policy_revision: 'e'.repeat(64),
      },
      job_id: id,
      tenant: 'fixture',
      user_id: 'fixture-user',
      request_id: 'd'.repeat(32),
      created_at: '2026-10-29T00:00:00Z',
      source_ref: {
        source_id: 'b'.repeat(32),
        source_version: 'c'.repeat(32),
        source_sha256: 'd'.repeat(64),
        size_bytes: 12,
        registration_revision: 'e'.repeat(64),
      },
      targets: [
        {
          document: id === jobId ? 'requested.md' : 'wrong-target.md',
          source_revision: null,
          state_revision: null,
        },
      ],
      outputs: ['wiki'],
      state: checks.cancelled ? 'cancelled' : 'awaiting_cli',
      run_id: null,
      reported_status: null,
      job_revision: revision,
      events: [],
      lease_status: 'none',
      lease_expires_at: null,
      basis_status: 'current',
      blockers: [],
      input_readiness: 'ready',
      result_summary: {
        status: 'not_started',
        saved_count: 0,
        required_count: 1,
        results: [],
      },
    },
    local: { status: 'idle', message: '격리된 작업 상세' },
    receipts: [],
    receiptErrors: [],
  });
}
/** 명시된 실패 응답만 만들어 접근 오류 후 이전 자료 제거를 검증합니다. */
function forbidden(): unknown {
  return {
    ok: false,
    error: {
      code: 'forbidden',
      status: 403,
      message: '작업 접근 거부 fixture',
    },
  };
}
Object.defineProperty(window, 'wiki', {
  configurable: true,
  value: {
    connection: {
      getState: async (): Promise<unknown> =>
        visual
          ? visualConnection
          : {
              ok: true,
              data: {
                status: 'connected',
                connectionId: 'fixture',
                userId: 'fixture-user',
                policyRevision: 'e'.repeat(64),
                selection: { tenant: 'fixture', profile: 'default' },
                workspaces: [{ id: 'fixture', permissions: ['read'] }],
              },
            },
    },
    ...(visual
      ? {
          aiSessions: {
            read: async (): Promise<unknown> => ({
              ...visualActivity,
              data: {
                ...(visualActivity.ok && visualActivity.data),
                activities: [],
              },
            }),
          },
        }
      : {}),
    knowledgeComparisons: {
      read: async (): Promise<unknown> => visualComparisonDetail,
      list: async (): Promise<unknown> =>
        visual
          ? visualComparisonList
          : {
              ok: true,
              data: { items: [], latestId: null, incomplete: false },
            },
    },
    analysis: {
      read: async (request: AnalysisReadRequest): Promise<unknown> => {
        checks.calls.push({
          operation: 'read',
          request: analysisReadRequestSchema.parse(request),
        });
        if (checks.mode === 'read403') return forbidden();
        return {
          ok: true,
          data: detail(checks.mode === 'wrongRead' ? 'f'.repeat(32) : jobId),
        };
      },
      inspectExecution: async (
        request: AnalysisReadRequest,
      ): Promise<unknown> => {
        checks.calls.push({
          operation: 'inspect',
          request: analysisReadRequestSchema.parse(request),
        });
        if (checks.mode === 'inspect403') return forbidden();
        return {
          ok: true,
          data: {
            detail: detail(
              checks.mode === 'wrongInspect' ? 'f'.repeat(32) : jobId,
              inspectedRevision,
            ),
            mode: checks.executionMode,
            blockers: [],
            checkedAt: '2026-10-29T00:00:01Z',
          },
        };
      },
      execute: async (request: AnalysisExecuteRequest): Promise<unknown> => {
        checks.calls.push({
          operation: 'execute',
          request: analysisExecuteRequestSchema.parse(request),
        });
        if (checks.mode === 'execute403') return forbidden();
        return {
          ok: true,
          data: detail(
            checks.mode === 'wrongExecute' ? 'f'.repeat(32) : jobId,
            '9'.repeat(64),
          ),
        };
      },
      cancel: async (request: AnalysisCancelRequest): Promise<unknown> => {
        checks.calls.push({
          operation: 'cancel',
          request: analysisCancelRequestSchema.parse(request),
        });
        checks.cancelled = true;
        return { ok: true, data: detail(jobId, '0'.repeat(64)) };
      },
    },
  },
});

/** StrictMode의 실제 효과 재실행 여부를 따로 계수해 개발 모드 검증을 보장합니다. */
function Fixture(): JSX.Element {
  useEffect((): void => {
    checks.mounts += 1;
  }, []);
  if (visual)
    return (
      <MemoryRouter initialEntries={['/jobs?jobId=' + jobId]}>
        <AppShell>
          <AnalysisJobWorkspace jobId={jobId} />
        </AppShell>
      </MemoryRouter>
    );
  return (
    <MemoryRouter>
      <div
        data-workspace-container
        style={{ containerName: 'workspace', containerType: 'inline-size' }}
      >
        <AnalysisJobWorkspace jobId={jobId} />
      </div>
    </MemoryRouter>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

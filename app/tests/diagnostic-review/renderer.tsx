import { StrictMode, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { HashRouter } from 'react-router';
import { ProposalDiagnostics } from '../../src/renderer/features/review-analysis-proposals/ui/ProposalDiagnostics';
import { MissingClaimDecisionForm } from '../../src/renderer/features/review-analysis-proposals/ui/ProposalForms';
import { ProposalFormDrafts } from '../../src/renderer/features/review-analysis-proposals/model/ProposalFormDrafts';
import { verifiedProposalReports } from '../../src/renderer/features/review-analysis-proposals/model/proposalReports';
import { readDiagnosticFindings } from '../../src/renderer/features/review-analysis-proposals/model/diagnosticFindings';
import type { DiagnosticFindingsResult } from '../../src/renderer/features/review-analysis-proposals/model/diagnosticFindings';
import type {
  ProposalRecord,
  DecisionFields,
} from '../../src/renderer/features/review-analysis-proposals/model/analysisProposal.schema';
import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import styles from '../../src/renderer/features/review-analysis-proposals/ui/ReviewAnalysisProposals.module.scss';
import { fixture } from './fixtures';
import { ReviewAnalysisProposals } from '../../src/renderer/features/review-analysis-proposals/ui/ReviewAnalysisProposals';
import type {
  AnalysisProposalsBridge,
  AnalysisProposalRequest,
  AnalysisProposalResult,
} from '@contracts/analysisProposals.contract';
import type {
  RecoveryRequest,
  RecoveryResult,
} from '@contracts/recovery.contract';
import type { FixtureMode } from './fixtures';
import '../../src/renderer/shared/theme/tokens.css';
import '../../src/renderer/shared/theme/controls.scss';
import { AppShell } from '../../src/renderer/app/AppShell';
import { visualActivity } from '../ai-sessions/visualFixtures';

type Checks = {
  ready: boolean;
  edits: number;
  calls: string[];
  lastDecision: DecisionFields | null;
  switch: (mode: FixtureMode) => string;
  lock: (value: boolean) => void;
  model: (mode: FixtureMode) => DiagnosticFindingsResult | null;
  lineChecks: () => Record<string, boolean>;
  showForms: () => void;
  showWorkspace: (loaded: boolean) => void;
};
const checks: Checks = {
  ready: false,
  edits: 0,
  calls: [],
  lastDecision: null,
  switch: (): string => '',
  lock: (): void => {},
  model: (): null => null,
  lineChecks: (): Record<string, boolean> => ({}),
  showForms: (): void => {},
  showWorkspace: (): void => {},
};
Reflect.set(window, '__diagnosticChecks', checks);
let select: (mode: FixtureMode) => void = (): void => {};
let lock: (value: boolean) => void = (): void => {};
checks.switch = (mode: FixtureMode): string => {
  flushSync((): void => select(mode));
  return document.body.innerText;
};
checks.lock = (value: boolean): void => flushSync((): void => lock(value));
Reflect.set(
  window,
  'wiki',
  new Proxy(
    {},
    {
      get: (_target: object, property: string | symbol): never => {
        checks.calls.push(String(property));
        throw new Error(
          '진단 화면은 직접 서버 쓰기나 AI 실행을 호출하지 않습니다.',
        );
      },
    },
  ),
);

/** 같은 실제 컴포넌트의 입력만 바꾸며 판본 전환 시 이전 진단의 즉시 숨김을 확인합니다. */
type FixtureProps = { records: Map<FixtureMode, ProposalRecord> };
function Fixture({ records }: FixtureProps): JSX.Element {
  const [mode, setMode] = useState<FixtureMode>('v2');
  const [locked, setLocked] = useState(false);
  const [showForms, setShowForms] = useState(false);
  const [workspace, setWorkspace] = useState<boolean | null>(null);
  const [gateway] = useState((): AnalysisProposalsBridge => ({
    execute: async (
      request: AnalysisProposalRequest,
    ): Promise<AnalysisProposalResult> => {
      checks.calls.push(`proposal:${request.operation}`);
      if (request.operation !== 'read' && request.operation !== 'validate')
        throw new Error('Read-only workspace fixture');
      const value = records.get('v2');
      if (!value) throw new Error('Workspace fixture missing');
      // 읽기 전용 서버 검사: 현재 후보와 같은 참조로 자동 검사만 통과, 의미 검사는 미실행입니다.
      if (request.operation === 'validate' && value.candidate_ref)
        return {
          ok: true,
          data: {
            proposal_id: value.proposal_id,
            state_revision: value.state_revision,
            candidate_ref: value.candidate_ref,
            automatic: 'passed',
            semantic: 'not_run',
            human_approval: false,
          },
          traceId: 'visual-fixture',
        };
      if (request.operation === 'validate')
        throw new Error('Fixture has no candidate');
      return { ok: true, data: value, traceId: 'visual-fixture' };
    },
  }));
  const [drafts] = useState((): ProposalFormDrafts => {
    const value = new ProposalFormDrafts();
    value.prepare.set('a11y', {
      document: 'diagnostic.md',
      contexts: '{invalid',
    });
    value.decision.set('a11y', {
      action: 'exclude',
      reason: '원문 확인이 필요한 제외',
      evidence: '',
      replacement: '',
      checkedWhole: false,
    });
    return value;
  });
  useEffect((): void => {
    checks.showForms = (): void => setShowForms(true);
    checks.showWorkspace = (loaded: boolean): void => {
      Reflect.set(window, 'wiki', {
        aiSessions: {
          read: async (): Promise<unknown> =>
            visualActivity.ok
              ? {
                  ...visualActivity,
                  data: { ...visualActivity.data, activities: [] },
                }
              : visualActivity,
        },
        connection: {
          getState: async (): Promise<unknown> => ({
            ok: true,
            data: {
              status: 'connected',
              connectionId: 'fixture',
              serverUrl: 'http://fixture.invalid',
              userId: 'fixture',
              policyRevision: 'fixture',
              selection: { tenant: 'fixture', profile: 'fixture' },
              checkedAt: '2026-10-31T00:00:00Z',
              workspaces: [
                {
                  id: 'fixture',
                  displayName: '합성 작업 공간',
                  permissions: ['read', 'ontology_write', 'ontology_review'],
                  defaultProfile: 'fixture',
                  profiles: [{ id: 'fixture', domain: null, viewpoint: null }],
                },
              ],
            },
          }),
        },
        recovery: {
          execute: async (
            request: RecoveryRequest,
          ): Promise<RecoveryResult> => ({
            ok: true,
            data: {
              entries:
                request.operation === 'put'
                  ? [
                      {
                        kind: request.kind,
                        key: request.key,
                        payload: request.payload,
                        revision: 'a'.repeat(64),
                        savedAt: '2026-10-31T00:00:00Z',
                      },
                    ]
                  : [],
              cleanupWarningCount: 0,
            },
          }),
        },
      });
      const current = records.get('v2');
      if (current && loaded && current.missing_claims.length === 0) {
        const claim = {
          claim_id: '7'.repeat(64),
          collection: 'relations' as const,
          value: {
            subject: 'sensor',
            predicate: 'produces',
            object: 'warning',
            evidence: '센서는 조건 A에서 경고를 보낸다.',
            condition: '조건 A',
          },
          decision: 'defer',
        };
        records.set('v2', {
          ...current,
          basis: {
            ...current.basis,
            previous: {
              ...current.basis.previous,
              graph: current.submission,
              claims: [claim],
              source: current.basis.documents[0]?.source
                ? knowledgeValueSchema.parse(current.basis.documents[0].source)
                : null,
              source_restoration: 'restored',
            },
          },
          missing_claims: [claim],
        });
      }
      location.hash = '/analysis-proposals?document=diagnostic.md';
      setWorkspace(loaded);
    };
    select = setMode;
    lock = setLocked;
  }, [records]);
  const record = records.get(mode);
  if (!record) throw new Error('Fixture not found');
  if (workspace !== null)
    return (
      <HashRouter>
        <AppShell>
          <ReviewAnalysisProposals
            gateway={gateway}
            initialDocument="diagnostic.md"
            initialProposalId={workspace ? record.proposal_id : ''}
          />
        </AppShell>
      </HashRouter>
    );
  return (
    <HashRouter>
      <main
        className={styles.workspace}
        style={{
          display: 'block',
          padding: 24,
          maxWidth: 1100,
          margin: 'auto',
        }}
      >
        <h1>추출 결과의 진단 검토 · 합성 자료</h1>
        {showForms ? (
          <>
            <MissingClaimDecisionForm
              drafts={drafts}
              draftKey="a11y"
              canRestore={true}
              graph={record.submission}
              claim={{
                claim_id: '7'.repeat(64),
                collection: 'relations',
                value: {
                  subject: 'sensor',
                  predicate: 'produces',
                  object: 'warning',
                  condition: '조건 A',
                  evidence: '센서는 조건 A에서 경고를 보낸다.',
                },
                decision: 'defer',
              }}
              disabled={false}
              onDecide={(values: DecisionFields): void => {
                checks.lastDecision = values;
                checks.calls.push('decision');
              }}
            />
          </>
        ) : (
          <ProposalDiagnostics
            record={record}
            report={{
              proposal_id: record.proposal_id,
              state_revision: record.state_revision,
              automatic: 'pass',
            }}
            onEditCandidate={(): void => {
              checks.edits += 1;
            }}
            editingDisabled={locked}
          />
        )}
      </main>
    </HashRouter>
  );
}

/** 실제 hash 검증을 통과한 자료로 시작하고 테스트를 위한 모의 서버 호출은 만들지 않습니다. */
async function start(): Promise<void> {
  const records = new Map<FixtureMode, ProposalRecord>();
  for (const mode of [
    'v1',
    'v2',
    'stale',
    'tampered',
    'malformed',
    'wrong_quote',
    'wrong_target',
    'changed_candidate',
    'normalized_only',
  ] satisfies FixtureMode[])
    records.set(mode, await fixture(mode));
  checks.model = (mode: FixtureMode): DiagnosticFindingsResult | null => {
    const record = records.get(mode);
    if (!record) return null;
    const reports = z
      .array(
        z.object({
          report: z.object({
            diagnostics: z.object({ report: z.unknown().optional() }),
          }),
        }),
      )
      .parse(record.current_reports);
    return readDiagnosticFindings(reports[0].report.diagnostics.report, record);
  };
  checks.lineChecks = (): Record<string, boolean> => {
    const record = records.get('v1');
    const value = checks.model('v1');
    if (!record || !value?.ok) throw new Error('Line fixture missing');
    const first = value.report.findings[0];
    const content =
      '# 검토 합성 원문\r\n센서는 조건 A에서 경고를 보낸다.\r\n조건 B의 동작은 정해지지 않았다.\r\n추가 범위는 별도 확인한다.\r\n';
    const changed = {
      ...record,
      basis: {
        ...record.basis,
        documents: [
          {
            document: 'diagnostic.md',
            source: { revision: '6'.repeat(64), content },
          },
        ],
      },
    };
    const quote =
      '센서는 조건 A에서 경고를 보낸다.\r\n조건 B의 동작은 정해지지 않았다.';
    const report = {
      ...value.report,
      findings: [{ ...first, source: { start_line: 2, end_line: 3, quote } }],
    };
    const exact = readDiagnosticFindings(report, changed);
    const normalized = readDiagnosticFindings(
      {
        ...report,
        findings: [
          {
            ...first,
            source: {
              start_line: 2,
              end_line: 3,
              quote: quote.replace('\r\n', '\n'),
            },
          },
        ],
      },
      changed,
    );
    const overclaimed = readDiagnosticFindings(
      {
        ...report,
        findings: [
          {
            ...first,
            source: {
              start_line: 2,
              end_line: 3,
              quote: '센서는 조건 A에서 경고를 보낸다.',
            },
          },
        ],
      },
      changed,
    );
    const beyond = readDiagnosticFindings(
      { ...report, reviewed_ranges: [{ start_line: 1, end_line: 5 }] },
      changed,
    );
    return {
      exactCRLF: exact.ok && exact.findings[0].sourceText === quote + '\r\n',
      normalizedQuoteRejected: !normalized.ok,
      inflatedRangeRejected: !overclaimed.ok,
      unavailableReviewedRangeRejected: !beyond.ok,
    };
  };
  const baseline = records.get('v2');
  if (
    !baseline ||
    (await verifiedProposalReports(baseline)).reports.length !== 1
  )
    throw new Error('Valid fixture failed exact report checks');
  const root = document.getElementById('root');
  if (!root) throw new Error('Root missing');
  createRoot(root).render(
    <StrictMode>
      <Fixture records={records} />
    </StrictMode>,
  );
  checks.ready = true;
}
void start();

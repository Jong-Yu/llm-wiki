import { createRoot } from 'react-dom/client';
import { MemoryRouter, Link } from 'react-router';
import { analysisDetailSchema } from '@contracts/analysis.contract';
import type {
  AnalysisDetail,
  AnalysisDetailResult,
  AnalysisExecutionInspectionResult,
} from '@contracts/analysis.contract';
import type { SourceConversionResult } from '@contracts/sourceConversion.contract';
import type { ImportScope } from '@renderer/features/import-document-content/api/importRegistration.api';
import type { CompletedImport } from '@renderer/features/import-document-content/model/ImportRegistrationSession';
import { importProcessingApi } from '@renderer/features/import-document-content/api/importProcessing.api';
import { importProcessingSession } from '@renderer/features/import-document-content/model/importProcessingSessions';
import { ImportDocumentProgress } from '@renderer/features/import-document-content/ui/ImportDocumentProgress';
import { initialImportValues } from '@renderer/features/import-document-content/model/importDocument.schema';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from '@renderer/pages/register/RegisterDocumentPage.module.scss';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';

type Mode = 'ready' | 'running' | 'partial' | 'complete' | 'error';
let mode: Mode = 'ready';
let executions = 0;
const scope: ImportScope = {
  connectionId: 'registration-fixture',
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: 'e'.repeat(64),
  canRegister: true,
  canPrepare: true,
  canExtract: true,
};
const actor = {
  user_id: scope.userId,
  tenant: scope.tenant,
  profile_id: scope.profileId,
  domain: null,
  viewpoint: null,
  policy_revision: scope.policyRevision,
};
const registered: CompletedImport = {
  state: 'complete',
  connectionId: scope.connectionId,
  requestId: 'a'.repeat(32),
  cleanupWarningCount: 0,
  access: {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
    domain: null,
    viewpoint: null,
  },
  item: {
    kind: 'source',
    sourceId: 'b'.repeat(32),
    sourceVersion: 'c'.repeat(32),
    sourceSha256: 'd'.repeat(64),
    registrationRevision: 'e'.repeat(64),
    title: '문서 운영과 검토 안내',
    sizeBytes: 1280,
    format: 'txt',
    linkedDocumentCount: 0,
    analysisStatus: 'not_started',
  },
};
const draft = {
  ...initialImportValues(true),
  kind: 'text' as const,
  title: registered.item.title,
  content: '격리된 등록 진행 UI 검수 자료',
  targetDocument: '운영-안내.md',
};

/** 실제 응답 스키마와 영수증 조건을 따르는 UI 전용 fixture이며 AI를 실행하지 않습니다. */
function detail(): AnalysisDetail {
  const saved = mode === 'partial' || mode === 'complete';
  const stages =
    mode === 'complete'
      ? ['prepare_wiki', 'extract_ontology']
      : saved
        ? ['prepare_wiki']
        : [];
  return analysisDetailSchema.parse({
    job: {
      actor,
      job_id: 'f'.repeat(32),
      tenant: scope.tenant,
      user_id: scope.userId,
      request_id: 'a'.repeat(32),
      created_at: '2026-10-31T00:00:00Z',
      source_ref: {
        source_id: registered.item.sourceId,
        source_version: registered.item.sourceVersion,
        source_sha256: registered.item.sourceSha256,
        registration_revision: registered.item.registrationRevision,
        size_bytes: registered.item.sizeBytes,
      },
      targets: [
        {
          document: draft.targetDocument,
          source_revision: null,
          state_revision: null,
        },
      ],
      outputs: ['wiki', 'ontology'],
      state: 'awaiting_cli',
      run_id: null,
      reported_status: mode === 'partial' ? 'failed' : null,
      job_revision: '7'.repeat(64),
      events: [],
      lease_status: 'none',
      lease_expires_at: null,
      basis_status: 'current',
      blockers: [],
      input_readiness: 'ready',
      result_summary: {
        status:
          mode === 'complete' ? 'complete' : saved ? 'partial' : 'not_started',
        saved_count: stages.length,
        required_count: 2,
        results: [],
      },
    },
    local: {
      status:
        mode === 'running'
          ? 'running'
          : mode === 'partial'
            ? 'failed'
            : mode === 'complete'
              ? 'completed'
              : 'idle',
      message:
        mode === 'running'
          ? '본문을 준비하고 있습니다.'
          : '실행할 준비가 되었습니다.',
    },
    receipts: stages.map((stage: string, index: number): unknown => ({
      request_id: String(index + 1).repeat(32),
      state: 'complete',
      saved: true,
      receipt: {
        actor,
        document: draft.targetDocument,
        stage,
        source_revision: 'a'.repeat(64),
        graph_revision: stage === 'extract_ontology' ? 'b'.repeat(64) : null,
        state_revision: null,
        bundle_id: '2'.repeat(32),
        bundle_revision: 'b'.repeat(64),
        review_status: 'unreviewed',
      },
      validation_report: null,
      current_output: { status: 'current' },
      cleanup_failures: [],
      diagnostics: null,
    })),
    receiptErrors: [],
  });
}
// 테스트 전용 API 대역을 캐시된 실제 처리 세션에 연결합니다. 제품 코드는 수정하지 않습니다.
importProcessingApi.register = async (): Promise<AnalysisDetailResult> => ({
  ok: true,
  data: detail(),
});
importProcessingApi.inspectJob =
  async (): Promise<AnalysisExecutionInspectionResult> =>
    mode === 'error'
      ? {
          ok: false,
          error: {
            code: 'service_unavailable',
            status: 503,
            message:
              '저장 결과를 확인하지 못했습니다. 원본은 보관되어 있습니다.',
          },
        }
      : {
          ok: true,
          data: {
            detail: detail(),
            mode:
              mode === 'ready' ? 'start' : mode === 'partial' ? 'resume' : null,
            blockers: [],
            checkedAt: '2026-10-31T00:00:00Z',
          },
        };
importProcessingApi.executeJob = async (): Promise<AnalysisDetailResult> => {
  executions++;
  return { ok: true, data: detail() };
};
importProcessingApi.conversionRead =
  async (): Promise<SourceConversionResult> => {
    throw new Error('TXT fixture must not convert');
  };
importProcessingApi.conversionStart =
  async (): Promise<SourceConversionResult> => {
    throw new Error('TXT fixture must not convert');
  };
const session = importProcessingSession(scope, registered, draft);
Reflect.set(window, '__registrationFixture', {
  change: async (next: Mode): Promise<void> => {
    mode = next;
    await session.refresh();
  },
  executions: (): number => executions,
});
/** 제품 컴포넌트를 준비된 격리 세션으로 표시합니다. */
async function mount(): Promise<void> {
  await session.begin();
  const root = document.getElementById('root');
  if (!root) throw new Error('Fixture root missing');
  createRoot(root).render(
    <MemoryRouter>
      <main className={styles.page}>
        <header className={styles.header}>
          <h1>문서 등록</h1>
          <Link className={styles.backLink} to="/documents">
            <Icon name="arrow-left" /> 문서 목록
          </Link>
        </header>
        <div className={styles.grid}>
          <section aria-label="문서 등록">
            <ImportDocumentProgress
              scope={scope}
              registered={registered}
              draft={draft}
              onNewRegistration={(): void => {}}
            />
          </section>
        </div>
      </main>
    </MemoryRouter>,
  );
}
void mount();

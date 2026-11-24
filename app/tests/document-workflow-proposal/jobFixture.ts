import { analysisDetailSchema } from '@contracts/analysis.contract';
import type { AnalysisDetail } from '@contracts/analysis.contract';
import { visualJob } from '../ai-sessions/visualFixtures';
import type { PreviewTask } from './model';

/** 현재 상세와 제안 상세에 같은 저장 성공·미완료 사실을 공급합니다. */
export function jobFixture(task: PreviewTask): AnalysisDetail {
  const detail = visualJob(
    task.savedWiki ?? `설계/${task.title}.md`,
    task.title,
    task.sourceId,
  );
  const wiki = detail.receipts[0];
  const receipts = task.savedWiki && wiki ? [wiki] : [];
  const complete = task.state === 'complete';
  const required = 2;
  const rawReceipts =
    complete && wiki?.receipt
      ? [
          ...receipts,
          { ...wiki, receipt: { ...wiki.receipt, stage: 'extract_ontology' } },
        ]
      : receipts;
  return analysisDetailSchema.parse({
    ...detail,
    receipts: rawReceipts,
    job: {
      ...detail.job,
      outputs: ['wiki', 'ontology'],
      state: task.state === 'ready' ? 'awaiting_cli' : 'claimed',
      source_ref: {
        ...detail.job.source_ref,
        source_id: task.sourceId,
        source_version: task.version,
      },
      reported_status:
        task.state === 'partial'
          ? 'failed'
          : task.state === 'running'
            ? 'analyzing'
            : task.state === 'cancelled'
              ? 'stopped'
              : null,
      result_summary: {
        ...detail.job.result_summary,
        status: complete
          ? 'complete'
          : task.state === 'unconfirmed'
            ? 'pending_reconcile'
            : task.savedWiki
              ? 'partial'
              : 'not_started',
        saved_count: rawReceipts.length,
        required_count: required,
        results: task.savedWiki ? detail.job.result_summary.results : [],
      },
    },
    local: {
      status:
        task.state === 'partial'
          ? 'failed'
          : task.state === 'running'
            ? 'running'
            : complete
              ? 'completed'
              : 'idle',
      message:
        task.state === 'partial' ? '관계 추출이 중단됐습니다.' : '합성 상태',
    },
  });
}

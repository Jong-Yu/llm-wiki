import { documentTaskSchema } from '@contracts/documentTasks.contract';
import type { DocumentTask } from '@contracts/documentTasks.contract';
import { analysisDetailSchema } from '@contracts/analysis.contract';
import type { AnalysisDetail } from '@contracts/analysis.contract';
import { visualJob } from '../ai-sessions/visualFixtures';

/** 실제 계약으로 검사한 합성 원본·작업이며 운영 자료와 연결하지 않습니다. */
export function fixtureTask(): DocumentTask {
  const source = {
    sourceId: 'b'.repeat(32),
    sourceVersion: 'c'.repeat(32),
    sourceSha256: 'e'.repeat(64),
    registrationRevision: 'e'.repeat(64),
  };
  return documentTaskSchema.parse({
    taskId: 'a'.repeat(32),
    source,
    item: {
      kind: 'source',
      ...source,
      title: '아키텍처 검토 자료',
      format: 'pdf',
      sizeBytes: 17000,
      linkedDocumentCount: 0,
      analysisStatus: 'not_started',
    },
    targetDocument: '설계/아키텍처.md',
    createdAt: '2026-11-23T01:00:00Z',
    updatedAt: '2026-11-23T01:02:00Z',
    analysisSummary: null,
    registration: {
      requestId: 'd'.repeat(32),
      state: 'not_started',
      jobId: null,
      errorCode: null,
    },
    conversions: [
      {
        requestId: 'f'.repeat(32),
        source,
        state: 'failed',
        format: 'pdf',
        progress: { stage: 'convert', completed: 4, total: 170 },
        receiptState: 'saved',
        reference: null,
        message: 'remaining source: worker_failed',
        diagnosticCodes: ['worker_failed'],
        cleanupWarning: false,
        startedAt: '2026-11-23T01:00:00Z',
        updatedAt: '2026-11-23T01:02:00Z',
        reportSummary: {
          complete: false,
          unreadRanges: ['remaining source: worker_failed'],
          warnings: [],
        },
      },
    ],
  });
}

/** Wiki 저장 후 추출이 중단된 상태를 실제 영수증 형식으로 구성합니다. */
export function fixtureAnalysis(task: DocumentTask): AnalysisDetail {
  const detail = visualJob(task.targetDocument, task.item.title);
  return analysisDetailSchema.parse({
    ...detail,
    job: {
      ...detail.job,
      outputs: ['wiki', 'ontology'],
      result_summary: {
        ...detail.job.result_summary,
        status: 'partial',
        required_count: 2,
      },
      reported_status: 'failed',
    },
    local: { status: 'failed', message: '관계 추출 중 연결이 끊겼습니다.' },
  });
}

/** 같은 대상의 Wiki와 온톨로지 현재 저장 영수증을 모두 제공하는 완료 예입니다. */
export function fixtureCompleteAnalysis(task: DocumentTask): AnalysisDetail {
  const detail = fixtureAnalysis(task);
  const wiki = detail.receipts[0];
  if (!wiki?.receipt) throw new Error('Wiki fixture receipt missing');
  return analysisDetailSchema.parse({
    ...detail,
    job: {
      ...detail.job,
      reported_status: null,
      result_summary: {
        ...detail.job.result_summary,
        status: 'complete',
        saved_count: 2,
      },
    },
    local: { status: 'completed', message: '저장 완료' },
    receipts: [
      wiki,
      {
        ...wiki,
        request_id: '9'.repeat(32),
        receipt: {
          ...wiki.receipt,
          stage: 'extract_ontology',
          graph_revision: 'e'.repeat(64),
          state_revision: 'e'.repeat(64),
        },
      },
    ],
  });
}

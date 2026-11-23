import assert from 'node:assert/strict';
import { ImportProcessingSession } from '@renderer/features/import-document-content/model/ImportProcessingSession';
import type { ImportProcessingApi } from '@renderer/features/import-document-content/model/importProcessing.types';
import type {
  DocumentTask,
  DocumentTaskDetailResult,
} from '@contracts/documentTasks.contract';
import type {
  SourceConversionRun,
  SourceConversionScope,
} from '@contracts/sourceConversion.contract';
import type { AnalysisDetail } from '@contracts/analysis.contract';

type Detail = Extract<DocumentTaskDetailResult, { ok: true }>['data'];

/** 제품 처리 세션을 그대로 사용해 조회 복원과 취소/완료 경합의 쓰기 횟수를 검사합니다. */
export async function verifyImportProcessing(
  task: DocumentTask,
  failure: SourceConversionRun,
  partial: AnalysisDetail,
  scope: SourceConversionScope,
): Promise<void> {
  const calls = { convert: 0, register: 0, execute: 0, read: 0, cancel: 0 };
  const complete: SourceConversionRun = {
    ...failure,
    state: 'complete',
    receiptState: 'saved',
    diagnosticCodes: [],
    reference: {
      ...task.source,
      requestId: failure.requestId,
      conversionId: 'd'.repeat(32),
      conversionRevision: 'b'.repeat(64),
    },
    report: {
      method: 'pdf_text',
      units: [
        {
          unit_id: 'page1',
          content: 'fixture text',
          location: { kind: 'pages', start: 1, end: 1 },
        },
      ],
      complete: true,
      unread_ranges: [],
      warnings: [],
      origin: 'client_reported',
      coverage: 'reported_units_only',
      original_coverage: 'not_verified',
      semantic_validation: 'not_run',
      diagnostics: [],
      unit_methods: {},
    },
  };
  let current: Detail = {
    task,
    conversion: failure,
    analysis: null,
    errors: [],
  };
  const api: ImportProcessingApi = {
    conversionRead: async () => ({ ok: true, data: null }),
    conversionStart: async () => {
      calls.convert += 1;
      return {
        ok: true,
        data: { ...failure, state: 'running', receiptState: 'pending' },
      };
    },
    register: async () => {
      calls.register += 1;
      return { ok: true, data: partial };
    },
    inspectJob: async () => ({
      ok: true,
      data: {
        detail: partial,
        mode: 'resume',
        blockers: [],
        checkedAt: new Date().toISOString(),
      },
    }),
    executeJob: async () => {
      calls.execute += 1;
      return { ok: true, data: partial };
    },
    createTask: async () => ({ ok: true, data: task }),
    readTask: async () => {
      calls.read += 1;
      return { ok: true, data: current };
    },
    conversionCancel: async () => {
      calls.cancel += 1;
      current = { ...current, conversion: complete };
      return { ok: true, data: complete };
    },
  };
  for (const conversion of [
    failure,
    {
      ...failure,
      state: 'report_unconfirmed' as const,
      receiptState: 'unconfirmed' as const,
    },
    complete,
  ]) {
    current = { task, conversion, analysis: null, errors: [] };
    const restored = new ImportProcessingSession(
      scope,
      { item: task.item, cleanupWarningCount: 0 },
      task.targetDocument,
      true,
      api,
      current,
    );
    await restored.refresh();
    assert.equal(calls.convert, 0);
    assert.equal(calls.register, 0);
    assert.equal(calls.execute, 0);
  }
  current = {
    task: {
      ...task,
      registration: { ...task.registration, state: 'unconfirmed' },
    },
    conversion: complete,
    analysis: null,
    errors: [],
  };
  const unknown = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    api,
    current,
  );
  await unknown.refresh();
  assert.equal(unknown.getSnapshot().phase, 'planning_unconfirmed');
  await unknown.retryConversion();
  assert.equal(calls.convert, 0);
  assert.equal(calls.register, 0);
  assert.equal(calls.execute, 0);

  // 최초 실행에서 보고 응답이 유실돼도 수동 GET 확인은 진행 화면만 복원합니다.
  const unresolvedCalls = { convert: 0, register: 0, execute: 0 };
  const pendingTask: DocumentTask = {
    ...task,
    conversions: [],
    registration: { ...task.registration, state: 'not_started', jobId: null },
  };
  const liveUnconfirmed = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    {
      ...api,
      createTask: async () => ({ ok: true, data: pendingTask }),
      conversionStart: async () => {
        unresolvedCalls.convert += 1;
        return {
          ok: true,
          data: {
            ...failure,
            state: 'report_unconfirmed',
            receiptState: 'unconfirmed',
          },
        };
      },
      register: async () => {
        unresolvedCalls.register += 1;
        return { ok: true, data: partial };
      },
      executeJob: async () => {
        unresolvedCalls.execute += 1;
        return { ok: true, data: partial };
      },
    },
  );
  await liveUnconfirmed.begin();
  assert.equal(liveUnconfirmed.getSnapshot().phase, 'conversion_unconfirmed');
  current = {
    task: pendingTask,
    conversion: complete,
    analysis: null,
    errors: [],
  };
  liveUnconfirmed.observeTask(current);
  assert.equal(liveUnconfirmed.getSnapshot().phase, 'ready');
  await liveUnconfirmed.refresh();
  assert.deepEqual(unresolvedCalls, { convert: 1, register: 0, execute: 0 });

  const savedTask = {
    ...task,
    targetDocument: partial.job.targets[0]!.document,
    registration: {
      ...task.registration,
      jobId: partial.job.job_id,
      state: 'linked' as const,
    },
  };
  const partialData: Detail = {
    task: savedTask,
    conversion: complete,
    analysis: {
      ...partial,
      job: {
        ...partial.job,
        targets: partial.job.targets.map((target) => ({
          ...target,
          source_revision: null,
          state_revision: null,
        })),
      },
    },
    errors: [],
  };
  current = partialData;
  const saved = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    savedTask.targetDocument,
    true,
    api,
    partialData,
  );
  await saved.refresh();
  assert.equal(saved.getSnapshot().document, savedTask.targetDocument);
  assert.equal(calls.register, 0);
  assert.equal(calls.execute, 0);

  current = { task, conversion: null, analysis: null, errors: [] };
  const fresh = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    api,
  );
  await fresh.begin();
  assert.equal(calls.convert, 1);
  await fresh.stopConversion();
  await fresh.refresh();
  assert.equal(calls.cancel, 1);
  assert.equal(calls.register, 0);
  assert.equal(calls.execute, 0);
  assert.equal(fresh.getSnapshot().phase, 'ready');
  console.log(
    'PASS production processing session: restored failed/complete/unknown/partial reads never execute; cancel/complete race never starts analysis',
  );
}

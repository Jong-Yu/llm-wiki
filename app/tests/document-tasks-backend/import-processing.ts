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
  assert.ok(complete.report);
  const review: SourceConversionRun = {
    ...complete,
    state: 'partial',
    message: '일부 구간만 변환했습니다.',
    report: {
      ...complete.report,
      complete: false,
      unread_ranges: [
        'page 1: ocr_low_or_missing_confidence_text_retained_manual_review_required',
      ],
    },
  };
  const frameReview: SourceConversionRun = {
    ...review,
    format: 'png',
    report: review.report
      ? {
          ...review.report,
          unread_ranges: [
            'frame 1: ocr_low_or_missing_confidence_text_retained_manual_review_required',
          ],
        }
      : null,
  };
  const frameSession = new ImportProcessingSession(
    scope,
    { item: { ...task.item, format: 'png' }, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    api,
    {
      task: { ...task, item: { ...task.item, format: 'png' } },
      conversion: frameReview,
      analysis: null,
      errors: [],
    },
  );
  assert.equal(frameSession.getSnapshot().phase, 'conversion_failed');
  assert.equal(frameSession.getSnapshot().canPrepare, false);
  assert.equal(frameSession.getSnapshot().canRetryConversion, true);
  assert.equal(frameSession.getSnapshot().canExecute, false);
  const reviewReport = review.report;
  assert.ok(reviewReport && review.reference);
  const originalReview = JSON.stringify(review);
  const reviewCalls = { convert: 0, register: 0, execute: 0, read: 0 };
  const reviewDetail: AnalysisDetail = {
    ...partial,
    job: {
      ...partial.job,
      request_id: task.registration.requestId,
      source_ref: {
        ...partial.job.source_ref,
        source_id: task.source.sourceId,
        source_version: task.source.sourceVersion,
        source_sha256: task.source.sourceSha256,
        registration_revision: task.source.registrationRevision,
      },
      registration: {
        mode: 'preserve',
        title: task.item.title,
        conversion_ref: {
          conversion_id: review.reference.conversionId,
          conversion_revision: review.reference.conversionRevision,
        },
      },
      targets: partial.job.targets.map((target) => ({
        ...target,
        document: task.targetDocument,
        source_revision: null,
        state_revision: null,
      })),
    },
  };
  const reviewApi: ImportProcessingApi = {
    ...api,
    conversionRead: async () => {
      reviewCalls.read += 1;
      return { ok: true, data: review };
    },
    conversionStart: async () => {
      reviewCalls.convert += 1;
      return { ok: true, data: review };
    },
    register: async (_scope, request) => {
      reviewCalls.register += 1;
      assert.equal(
        request.registration?.requestId,
        task.registration.requestId,
      );
      assert.deepEqual(request.registration?.conversionRef, {
        conversionId: review.reference?.conversionId,
        conversionRevision: review.reference?.conversionRevision,
      });
      return { ok: true, data: reviewDetail };
    },
    inspectJob: async () => ({
      ok: true,
      data: {
        detail: reviewDetail,
        mode: 'resume',
        blockers: [],
        checkedAt: new Date().toISOString(),
      },
    }),
    executeJob: async () => {
      reviewCalls.execute += 1;
      return { ok: true, data: reviewDetail };
    },
  };
  current = { task, conversion: review, analysis: null, errors: [] };
  const reviewSession = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    reviewApi,
    current,
  );
  await reviewSession.refresh();
  assert.equal(reviewSession.getSnapshot().phase, 'conversion_review');
  assert.equal(reviewSession.getSnapshot().canPrepare, false);
  assert.equal(reviewSession.getSnapshot().canRetryConversion, false);
  assert.equal(reviewSession.getSnapshot().canExecute, false);
  assert.match(reviewSession.getSnapshot().message, /원본과 대조하고 승인/);
  assert.equal(reviewSession.getSnapshot().conversion?.report?.complete, false);
  assert.deepEqual(reviewCalls, {
    convert: 0,
    register: 0,
    execute: 0,
    read: 0,
  });
  await Promise.all([reviewSession.begin(), reviewSession.begin()]);
  await reviewSession.refresh();
  await reviewSession.refresh();
  assert.deepEqual(reviewCalls, {
    convert: 0,
    register: 0,
    execute: 0,
    read: 1,
  });
  assert.equal(
    JSON.stringify(reviewSession.getSnapshot().conversion),
    originalReview,
  );
  assert.equal(calls.convert, 0);
  assert.equal(calls.register, 0);
  assert.equal(calls.execute, 0);
  for (const state of [
    'unconfirmed',
    'interrupted',
    'worker',
    'empty',
    'missing-warning-text',
  ] as const) {
    const conversion: SourceConversionRun =
      state === 'unconfirmed'
        ? {
            ...review,
            state: 'report_unconfirmed',
            receiptState: 'unconfirmed',
          }
        : state === 'interrupted'
          ? {
              ...review,
              report: {
                ...reviewReport,
                unread_ranges: [
                  ...reviewReport.unread_ranges,
                  'remaining source: conversion_checkpoint_read_failed',
                ],
              },
            }
          : {
              ...review,
              ...(state === 'worker' ? { reference: null } : {}),
              report: {
                ...reviewReport,
                ...(state === 'worker'
                  ? { warnings: ['worker: code=worker_failed'] }
                  : {}),
                ...(state === 'empty' ? { units: [] } : {}),
                ...(state === 'missing-warning-text'
                  ? {
                      unread_ranges: [
                        'page 2: ocr_low_or_missing_confidence_text_retained_manual_review_required',
                      ],
                    }
                  : {}),
              },
            };
    current = { task, conversion, analysis: null, errors: [] };
    const session = new ImportProcessingSession(
      scope,
      { item: task.item, cleanupWarningCount: 0 },
      task.targetDocument,
      true,
      api,
      current,
    );
    assert.equal(
      session.getSnapshot().phase,
      state === 'unconfirmed' ? 'conversion_unconfirmed' : 'conversion_failed',
    );
    assert.equal(session.getSnapshot().canPrepare, false);
    if (state === 'worker') {
      assert.equal(session.getSnapshot().scopeInvalid, false);
      assert.equal(session.getSnapshot().canRetryConversion, true);
    }
    if (state === 'empty' || state === 'missing-warning-text')
      assert.match(session.getSnapshot().message, /보관 문자를 찾지 못해/);
  }
  for (const sourceField of [
    'sourceId',
    'sourceVersion',
    'sourceSha256',
    'registrationRevision',
  ] as const) {
    for (const variant of ['source', 'reference'] as const) {
      const conversion: SourceConversionRun = {
        ...review,
        [variant]: {
          ...review[variant],
          [sourceField]: 'f'.repeat(
            sourceField.includes('Revision') || sourceField.includes('Sha256')
              ? 64
              : 32,
          ),
        },
      };
      const mismatch = new ImportProcessingSession(
        scope,
        { item: task.item, cleanupWarningCount: 0 },
        task.targetDocument,
        true,
        api,
        { task, conversion, analysis: null, errors: [] },
      );
      assert.equal(mismatch.getSnapshot().scopeInvalid, true);
      assert.equal(mismatch.getSnapshot().canPrepare, false);
      await mismatch.begin();
    }
  }
  for (const reference of [
    null,
    { ...review.reference, requestId: 'f'.repeat(32) },
    { ...review.reference, conversionId: 'invalid' },
    { ...review.reference, conversionRevision: 'invalid' },
  ]) {
    const mismatch = new ImportProcessingSession(
      scope,
      { item: task.item, cleanupWarningCount: 0 },
      task.targetDocument,
      true,
      api,
      {
        task,
        conversion: { ...review, reference },
        analysis: null,
        errors: [],
      },
    );
    assert.equal(mismatch.getSnapshot().scopeInvalid, true);
    assert.equal(mismatch.getSnapshot().canPrepare, false);
    await mismatch.begin();
  }
  for (const conversion of [
    {
      ...review,
      requestId: 'f'.repeat(32),
      reference: { ...review.reference, requestId: 'f'.repeat(32) },
    },
    {
      ...review,
      reference: { ...review.reference, conversionId: 'f'.repeat(32) },
    },
    {
      ...review,
      reference: { ...review.reference, conversionRevision: 'f'.repeat(64) },
    },
  ]) {
    const before = { ...reviewCalls };
    const changed = new ImportProcessingSession(
      scope,
      { item: task.item, cleanupWarningCount: 0 },
      task.targetDocument,
      true,
      {
        ...reviewApi,
        conversionRead: async () => ({ ok: true, data: conversion }),
        readTask: async () => ({
          ok: true,
          data: { task, conversion, analysis: null, errors: [] },
        }),
      },
      { task, conversion: review, analysis: null, errors: [] },
    );
    await changed.begin();
    assert.equal(changed.getSnapshot().scopeInvalid, true);
    await changed.revalidateScope();
    await changed.refresh();
    assert.equal(changed.getSnapshot().scopeInvalid, false);
    assert.equal(changed.getSnapshot().phase, 'conversion_review');
    assert.deepEqual(reviewCalls, before);
  }
  for (const throws of [false, true]) {
    const before = { ...reviewCalls };
    const newer: SourceConversionRun = {
      ...review,
      requestId: 'f'.repeat(32),
      reference: {
        ...review.reference,
        requestId: 'f'.repeat(32),
        conversionId: 'f'.repeat(32),
      },
    };
    const failedLookup = new ImportProcessingSession(
      scope,
      { item: task.item, cleanupWarningCount: 0 },
      task.targetDocument,
      true,
      {
        ...reviewApi,
        conversionRead: async () => {
          if (throws) throw new Error('fixture lookup failed');
          return {
            ok: false,
            error: {
              code: 'outcome_unknown',
              message: 'fixture lookup failed',
            },
          };
        },
        readTask: async () => ({
          ok: true,
          data: { task, conversion: newer, analysis: null, errors: [] },
        }),
      },
      { task, conversion: review, analysis: null, errors: [] },
    );
    await failedLookup.begin();
    await failedLookup.refresh();
    await failedLookup.refresh();
    assert.equal(
      failedLookup.getSnapshot().conversion?.requestId,
      newer.requestId,
    );
    assert.equal(failedLookup.getSnapshot().phase, 'conversion_review');
    assert.deepEqual(reviewCalls, before);
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
  for (const conversion of [
    {
      ...review,
      state: 'report_unconfirmed' as const,
      receiptState: 'unconfirmed' as const,
    },
    {
      ...review,
      report: {
        ...reviewReport,
        unread_ranges: [
          ...reviewReport.unread_ranges,
          'remaining source: conversion_checkpoint_read_failed',
        ],
      },
    },
  ]) {
    const before = { ...reviewCalls };
    const interrupted = new ImportProcessingSession(
      scope,
      { item: task.item, cleanupWarningCount: 0 },
      task.targetDocument,
      true,
      {
        ...reviewApi,
        createTask: async () => ({ ok: true, data: pendingTask }),
        conversionRead: async () => ({ ok: true, data: null }),
        conversionStart: async () => ({ ok: true, data: conversion }),
        readTask: async () => ({
          ok: true,
          data: {
            task: pendingTask,
            conversion: review,
            analysis: null,
            errors: [],
          },
        }),
      },
    );
    await interrupted.begin();
    await interrupted.refresh();
    await interrupted.refresh();
    assert.equal(interrupted.getSnapshot().phase, 'conversion_review');
    assert.equal(interrupted.getSnapshot().canPrepare, false);
    assert.deepEqual(reviewCalls, before);
  }
  const beforeLive = { ...reviewCalls };
  let liveConverted = false;
  const liveReview = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    {
      ...reviewApi,
      createTask: async () => ({ ok: true, data: pendingTask }),
      readTask: async () => ({
        ok: true,
        data: {
          task: pendingTask,
          conversion: review,
          analysis: null,
          errors: [],
        },
      }),
      conversionRead: async () => ({
        ok: true,
        data: liveConverted ? review : null,
      }),
      conversionStart: async () => {
        reviewCalls.convert += 1;
        liveConverted = true;
        return {
          ok: true,
          data: { ...review, state: 'running', receiptState: 'pending' },
        };
      },
    },
  );
  await liveReview.begin();
  assert.equal(liveReview.getSnapshot().phase, 'converting');
  await liveReview.refresh();
  await liveReview.refresh();
  assert.deepEqual(reviewCalls, {
    ...beforeLive,
    convert: beforeLive.convert + 1,
    register: beforeLive.register,
    execute: beforeLive.execute,
  });
  assert.equal(
    JSON.stringify(liveReview.getSnapshot().conversion),
    originalReview,
  );

  const blankPage: SourceConversionRun = {
    ...review,
    report: {
      ...reviewReport,
      units: [
        ...reviewReport.units,
        {
          unit_id: 'page2',
          content: '  ',
          location: { kind: 'pages', start: 2, end: 2 },
        },
      ],
    },
  };
  const blankOtherPage = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    reviewApi,
    { task, conversion: blankPage, analysis: null, errors: [] },
  );
  assert.equal(blankOtherPage.getSnapshot().canPrepare, false);
  const blankWarningPage = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    reviewApi,
    {
      task,
      conversion: {
        ...blankPage,
        report: {
          ...reviewReport,
          units: [
            {
              unit_id: 'page1',
              content: ' ',
              location: { kind: 'pages', start: 1, end: 1 },
            },
          ],
        },
      },
      analysis: null,
      errors: [],
    },
  );
  assert.equal(blankWarningPage.getSnapshot().canPrepare, false);

  const sameRequests: string[] = [];
  const beforeUncertain = { ...reviewCalls };
  const uncertainReview = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    {
      ...reviewApi,
      register: async (_scope, request) => {
        sameRequests.push(request.registration!.requestId);
        return sameRequests.length === 1
          ? {
              ok: false,
              error: {
                code: 'outcome_unknown',
                message: 'fixture response lost',
              },
            }
          : { ok: true, data: reviewDetail };
      },
    },
    { task, conversion: complete, analysis: null, errors: [] },
  );
  await uncertainReview.begin();
  assert.equal(uncertainReview.getSnapshot().phase, 'planning_unconfirmed');
  assert.equal(reviewCalls.execute, beforeUncertain.execute);
  await uncertainReview.refresh();
  await uncertainReview.refresh();
  assert.deepEqual(sameRequests, [
    task.registration.requestId,
    task.registration.requestId,
  ]);
  assert.equal(reviewCalls.execute, beforeUncertain.execute + 1);
  assert.equal(reviewCalls.convert, beforeUncertain.convert);
  const beforeRestoredUnknown = { ...reviewCalls };
  current = {
    task: {
      ...task,
      registration: { ...task.registration, state: 'unconfirmed' },
    },
    conversion: review,
    analysis: null,
    errors: [],
  };
  const restoredUnknownReview = new ImportProcessingSession(
    scope,
    { item: task.item, cleanupWarningCount: 0 },
    task.targetDocument,
    true,
    reviewApi,
    current,
  );
  await restoredUnknownReview.refresh();
  await restoredUnknownReview.begin();
  assert.deepEqual(reviewCalls, beforeRestoredUnknown);
  assert.equal(
    restoredUnknownReview.getSnapshot().phase,
    'planning_unconfirmed',
  );

  for (const job of [
    { ...reviewDetail.job, request_id: 'f'.repeat(32) },
    {
      ...reviewDetail.job,
      source_ref: {
        ...reviewDetail.job.source_ref,
        source_sha256: 'f'.repeat(64),
      },
    },
    {
      ...reviewDetail.job,
      registration: {
        mode: 'preserve' as const,
        title: task.item.title,
        conversion_ref: {
          conversion_id: 'f'.repeat(32),
          conversion_revision: 'b'.repeat(64),
        },
      },
    },
  ]) {
    const before = reviewCalls.execute;
    const wrongRegistered = new ImportProcessingSession(
      scope,
      { item: task.item, cleanupWarningCount: 0 },
      task.targetDocument,
      true,
      {
        ...reviewApi,
        register: async () => ({ ok: true, data: { ...reviewDetail, job } }),
      },
      { task, conversion: complete, analysis: null, errors: [] },
    );
    await wrongRegistered.begin();
    assert.equal(wrongRegistered.getSnapshot().scopeInvalid, true);
    assert.equal(reviewCalls.execute, before);
  }
  console.log(
    'PASS retained OCR text waits for server approval without OCR replay; restored reads, changed references, missing text and uncertain registration preserve their gates',
  );
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

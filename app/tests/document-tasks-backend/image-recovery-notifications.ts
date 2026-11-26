import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NotificationService } from '@main/backend/NotificationService';
import { loadNotificationDevice } from '@main/backend/notificationDevice';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import type { ProcessRecovery } from '@main/backend/processRecovery';
import type { ApiFailure } from '@main/backend/readApi';
import type { ImageRecoveryInput } from '@main/backend/SourceImageRecoveryService';
import type {
  NotificationDetailResult,
  NotificationRecoverImagesRequest,
  NotificationRecoverImagesResult,
} from '@contracts/notifications.contract';

/** 권한·고정 판본·저신뢰 위치·늦은 취소를 검증하며 어떤 후보도 서버에 저장하지 않습니다. */
export async function verifyImageRecoveryNotifications(
  context: AnalysisContext,
  recovery: ProcessRecovery,
  root: string,
): Promise<void> {
  const id = (value: string, size: number = 32): string => value.repeat(size);
  const access = {
    user_id: context.active.userId,
    tenant: context.selection.tenant,
    profile_id: context.selection.profile,
    policy_revision: context.active.policyRevision,
    access_revision: context.active.accessRevision,
  };
  const source = {
    source_id: id('a'),
    source_version: id('b'),
    source_sha256: id('c', 64),
    registration_revision: id('d', 64),
  };
  const now = new Date().toISOString();
  const original: Extract<NotificationDetailResult, { ok: true }>['data'] = {
    access,
    source_format: 'pptx',
    sourcePageCount: null,
    corrections: [],
    events: [],
    workflow: {
      workflow_id: id('1'),
      revision: id('2', 64),
      source_ref: source,
      conversion_ref: {
        conversion_id: id('3'),
        conversion_revision: id('4', 64),
      },
      title: '합성 PPTX',
      target_document: 'image.md',
      state: 'review',
      pages: [{ unit_id: 'slide-2', state: 'pending' }],
      approval: null,
      execution: null,
      resume_request_id: id('5'),
      created_at: now,
      updated_at: now,
    },
    conversion: {
      manifest: {
        id: id('3'),
        source_ref: source,
        method: 'pptx_text',
        complete: false,
        unread_ranges: [
          'slide 2: ocr_low_or_missing_confidence_text_retained_manual_review_required',
        ],
        warnings: ['original warning'],
        units: [
          {
            unit_id: 'slide-2',
            location: { kind: 'slides', start: 2, end: 2 },
          },
        ],
      },
      revision: id('4', 64),
      components: { 'slide-2': '원래 문자' },
    },
  };
  let data = structuredClone(original);
  let current = true;
  let writable = true;
  let runs = 0;
  let reads = 0;
  let stage = 'normal';
  const listeners: (() => void)[] = [];
  const noExecution = async (): Promise<never> => {
    throw new Error('Recovery must not execute registration');
  };
  const service = new NotificationService(
    {
      analysisContext: async (
        _id: string,
        write: boolean = false,
      ): Promise<AnalysisContext | ApiFailure> =>
        write && !writable
          ? { ok: false, error: { code: 'forbidden', message: '읽기 전용' } }
          : context,
      isAnalysisCurrent: (): boolean => current,
      analysisAccessFailure: (): void => {},
      onScopeChanged: (listener: () => void): void => {
        listeners.push(listener);
      },
    },
    {
      inspectRuntime: noExecution,
      inspectExecution: noExecution,
      start: noExecution,
      execute: noExecution,
    },
    await loadNotificationDevice(join(root, 'image-recovery-device.json')),
    recovery,
    undefined,
    {
      run: async (
        _context: AnalysisContext,
        input: ImageRecoveryInput,
        requestId: string,
        signal?: AbortSignal,
      ): Promise<NotificationRecoverImagesResult> => {
        runs += 1;
        assert.deepEqual(input.source_ref, original.workflow.source_ref);
        assert.deepEqual(
          input.conversion_ref,
          original.workflow.conversion_ref,
        );
        assert.deepEqual(input.units, [
          {
            unit_id: 'slide-2',
            content: '원래 문자',
            location: { kind: 'slides', start: 2, end: 2 },
          },
        ]);
        assert.equal(requestId.length, 32);
        if (stage === 'cancel-failure') {
          await service.cancelRetry(request);
          return {
            ok: false,
            error: {
              code: 'image_recovery_cancelled',
              message:
                '복구를 취소했습니다. 임시 인증 파일 정리도 완료하지 못했습니다.',
            },
          };
        }
        if (stage === 'wait')
          await new Promise<void>((done: () => void): void => {
            if (signal?.aborted) done();
            else
              signal?.addEventListener('abort', (): void => done(), {
                once: true,
              });
          });
        if (stage === 'revision') data.workflow.revision = id('6', 64);
        if (stage === 'source') {
          data.workflow.source_ref.source_sha256 = id('7', 64);
          if (data.conversion)
            data.conversion.manifest.source_ref = data.workflow.source_ref;
        }
        if (stage === 'conversion') {
          data.workflow.conversion_ref = {
            conversion_id: id('3'),
            conversion_revision: id('8', 64),
          };
          if (data.conversion) data.conversion.revision = id('8', 64);
        }
        if (stage === 'permission') writable = false;
        if (stage === 'scope') {
          current = false;
          for (const listener of listeners) listener();
        }
        if (stage === 'state') data.workflow.state = 'approved';
        if (stage === 'blocked')
          data.workflow.blocked_reason = 'source_changed';
        if (stage === 'format') data.source_format = 'pdf';
        if (stage === 'content' && data.conversion)
          data.conversion.components['slide-2'] = '변경된 보관 문자';
        const units = [
          {
            unit_id: stage === 'foreign' ? 'foreign' : 'slide-2',
            content: stage === 'empty' ? '' : '새 후보',
            warnings: [],
          },
        ];
        if (stage === 'duplicate') units.push({ ...units[0]! });
        if (stage === 'missing') units.pop();
        return {
          ok: true,
          data: {
            units,
            warnings: ['candidate'],
            provider: 'claude',
            model: null,
          },
        };
      },
      stop: async (): Promise<void> => {},
    },
  );
  const request: NotificationRecoverImagesRequest = {
    connectionId: context.active.connectionId,
    expectedScope: {
      userId: access.user_id,
      tenant: access.tenant,
      profileId: access.profile_id,
      policyRevision: access.policy_revision,
      ...(access.access_revision
        ? { accessRevision: access.access_revision }
        : {}),
    },
    workflowId: id('1'),
    requestId: id('9'),
    expectedRevision: id('2', 64),
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    assert.equal(
      init?.method ?? 'GET',
      'GET',
      'Recovery must not mutate server state',
    );
    const url = new URL(input instanceof Request ? input.url : input);
    assert.ok(
      url.pathname.endsWith(`/notification-workflows/${request.workflowId}`),
    );
    reads += 1;
    const response = new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (stage === 'late-permission' && reads === 2) writable = false;
    if (stage === 'late-cancel' && reads === 2)
      await service.cancelRetry(request);
    return response;
  };
  const reset = (): void => {
    data = structuredClone(original);
    current = true;
    writable = true;
    reads = 0;
    stage = 'normal';
  };
  try {
    const success = await service.recoverImages(request);
    assert.equal(success.ok, true);
    assert.deepEqual(
      data,
      original,
      'Candidate creation must preserve original report and workflow',
    );
    assert.equal(reads, 2);
    reset();
    stage = 'cancel-failure';
    const cleanupFailure = await service.recoverImages(request);
    assert.equal(cleanupFailure.ok, false);
    if (!cleanupFailure.ok)
      assert.match(cleanupFailure.error.message, /임시 인증 파일 정리/u);
    for (const value of [
      'revision',
      'source',
      'conversion',
      'permission',
      'scope',
      'state',
      'blocked',
      'format',
      'content',
      'foreign',
      'empty',
      'duplicate',
      'missing',
      'late-permission',
      'late-cancel',
    ]) {
      reset();
      stage = value;
      const result = await service.recoverImages(request);
      assert.equal(result.ok, false, value);
    }
    for (const value of [
      'readonly',
      'revision',
      'whole',
      'input',
      'correction',
      'overlap',
      'range',
      'duplicate-target',
      'unknown-reason',
      'not-pptx',
      'limit',
      'missing-content',
    ]) {
      reset();
      if (value === 'readonly') writable = false;
      if (value === 'revision') data.workflow.revision = id('6', 64);
      if (value === 'whole')
        data.workflow.pages = [{ whole_document: true, state: 'pending' }];
      if (value === 'input') data.workflow.pages[0]!.input_required = true;
      if (value === 'correction')
        data.workflow.pages[0]!.correction_ref = {
          correction_id: id('a'),
          correction_revision: id('b', 64),
        };
      if (value === 'overlap')
        data.conversion!.manifest.units.push({
          unit_id: 'range',
          location: { kind: 'slides', start: 1, end: 3 },
        });
      if (value === 'range')
        data.conversion!.manifest.units[0]!.location = {
          kind: 'slides',
          start: 1,
          end: 3,
        };
      if (value === 'duplicate-target')
        data.workflow.pages.push({ unit_id: 'slide-2', state: 'pending' });
      if (value === 'unknown-reason')
        data.conversion!.manifest.unread_ranges.push('slide 3: unknown');
      if (value === 'not-pptx') data.source_format = 'ppt';
      if (value === 'missing-content')
        delete data.conversion!.components['slide-2'];
      if (value === 'limit')
        data.conversion!.manifest.unread_ranges = Array.from(
          { length: 41 },
          (_unused: unknown, index: number): string =>
            `slide ${index + 1}: ocr_low_or_missing_confidence_text_retained_manual_review_required`,
        );
      const before = runs;
      assert.equal((await service.recoverImages(request)).ok, false, value);
      assert.equal(runs, before, value);
    }
    reset();
    stage = 'wait';
    const before = runs;
    const running = service.recoverImages(request);
    for (let attempt = 0; attempt < 100 && runs === before; attempt += 1)
      await delay(10);
    assert.equal(runs, before + 1);
    const busy = await service.recoverImages(request);
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.error.code, 'conversion_busy');
    const foreign = await service.cancelRetry({
      ...request,
      requestId: id('8'),
    });
    assert.equal(foreign.ok, true);
    if (foreign.ok) assert.equal(foreign.data.cancelled, false);
    await service.cancelRetry(request);
    assert.equal((await running).ok, false);
    reset();
    assert.deepEqual(data, original);
  } finally {
    globalThis.fetch = savedFetch;
    await service.stop();
  }
}

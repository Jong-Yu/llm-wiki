import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import type { ProcessRecovery } from '@main/backend/processRecovery';
import type { ApiFailure } from '@main/backend/readApi';
import { NotificationService } from '@main/backend/NotificationService';
import { loadNotificationDevice } from '@main/backend/notificationDevice';
import type { SourcePageOcrResult } from '@main/backend/SourcePageOcrService';
import type {
  NotificationWorkflow,
  NotificationSession,
  NotificationDetailResult,
} from '@contracts/notifications.contract';

type Correction = Extract<
  NotificationDetailResult,
  { ok: true }
>['data']['corrections'][number];

/** 수정 저장과 후보 생성의 권한·판본·취소 경계를 실제 main 서비스에서 확인합니다. */
export async function verifyPageCorrections(
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
  const session: NotificationSession = {
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
  };
  const now = new Date().toISOString();
  let workflow: NotificationWorkflow = {
    workflow_id: id('a'),
    revision: id('b', 64),
    source_ref: {
      source_id: id('c'),
      source_version: id('d'),
      source_sha256: id('e', 64),
      registration_revision: id('f', 64),
    },
    conversion_ref: {
      conversion_id: id('1'),
      conversion_revision: id('2', 64),
    },
    title: '합성 보류',
    target_document: 'held.md',
    state: 'review',
    pages: [{ page: 6, state: 'held' }],
    approval: null,
    execution: null,
    resume_request_id: id('3'),
    created_at: now,
    updated_at: now,
  };
  const conversion = {
    manifest: {
      id: id('1'),
      source_ref: workflow.source_ref,
      method: 'ocr',
      complete: false,
      unread_ranges: [
        'page 6: ocr_low_or_missing_confidence_text_retained_manual_review_required',
      ],
      warnings: ['original warning'],
      units: [
        { unit_id: 'page-6', location: { kind: 'pages', start: 6, end: 6 } },
      ],
    },
    revision: id('2', 64),
    components: { 'page-6': '원래 OCR 문자' },
  };
  const original = JSON.stringify(conversion);
  let corrections: Correction[] = [];
  let current = true;
  let writable = true;
  let mismatch = false;
  let loseResponse = false;
  let stage: 'normal' | 'wait' | 'changed' | 'scope' = 'normal';
  let retries = 0;
  const writes: Record<string, unknown>[] = [];
  let approvedBody: Record<string, unknown> | null = null;
  const receipts = new Map<string, string>();
  const listeners: (() => void)[] = [];
  const connection = {
    analysisContext: async (
      _connectionId: string,
      write: boolean = false,
    ): Promise<AnalysisContext | ApiFailure> =>
      write && !writable
        ? { ok: false, error: { code: 'forbidden', message: '읽기 전용' } }
        : context,
    isAnalysisCurrent: (): boolean => current,
    analysisAccessFailure: (_failure: ApiFailure): void => {},
    onScopeChanged: (listener: () => void): void => {
      listeners.push(listener);
    },
  };
  const noExecution = async (): Promise<never> => {
    throw new Error('Corrections must not execute analysis');
  };
  const pageOcr = {
    run: async (
      _context: AnalysisContext,
      source: NotificationWorkflow['source_ref'],
      page: number,
      requestId: string,
      signal?: AbortSignal,
    ): Promise<SourcePageOcrResult> => {
      retries += 1;
      assert.deepEqual(source, workflow.source_ref);
      assert.equal(page, 6);
      assert.equal(requestId.length, 32);
      if (stage === 'wait') {
        await new Promise<void>((resolve: () => void): void => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener('abort', (): void => resolve(), {
              once: true,
            });
        });
      }
      if (stage === 'changed')
        workflow = { ...workflow, revision: id('8', 64) };
      if (stage === 'scope') {
        current = false;
        for (const listener of listeners) listener();
      }
      return {
        ok: true,
        data: {
          page,
          content: '다시 인식한 후보',
          warnings: ['candidate warning'],
        },
      };
    },
    stop: async (): Promise<void> => {},
  };
  const service = new NotificationService(
    connection,
    {
      inspectRuntime: noExecution,
      inspectExecution: noExecution,
      start: noExecution,
      execute: noExecution,
    },
    await loadNotificationDevice(join(root, 'correction-device.json')),
    recovery,
    pageOcr,
  );
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const reply = (data: unknown, status: number = 200): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname.includes('/sources/') && url.pathname.endsWith('/pages')) {
      assert.equal(
        url.searchParams.get('source_sha256'),
        workflow.source_ref.source_sha256,
      );
      assert.equal(
        url.searchParams.get('registration_revision'),
        workflow.source_ref.registration_revision,
      );
      return reply({
        data: { ...workflow.source_ref, page_count: 170, access },
      });
    }
    if (url.pathname.endsWith('/pages')) {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      assert.deepEqual(body.decisions, [
        {
          page: 6,
          state: 'usable',
          correction_ref: corrections[0]?.correction_ref,
        },
      ]);
      const page = workflow.pages[0];
      assert.ok(page);
      workflow = { ...workflow, pages: [{ ...page, state: 'usable' }] };
      return reply({ data: { workflow, access, replayed: false } });
    }
    if (url.pathname.endsWith('/approve')) {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      approvedBody = body;
      assert.deepEqual(body.correction_refs, [
        { page: 6, correction_ref: corrections[0]?.correction_ref },
      ]);
      workflow = {
        ...workflow,
        state: 'approved',
        approval: {
          request_id: String(body.request_id),
          approved_at: now,
          actor: access,
          device_id: String(body.device_id),
          device_name: String(body.device_name),
        },
      };
      return reply({ data: { workflow, access, replayed: false } });
    }
    if (url.pathname.endsWith('/corrections')) {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      writes.push(body);
      assert.equal(body.profile, context.selection.profile);
      const requestId = String(body.request_id);
      const previous = receipts.get(requestId);
      if (previous) {
        if (previous !== JSON.stringify(body))
          return reply({ error: { code: 'request_conflict' } }, 409);
        return reply({ data: { workflow, access, replayed: true } });
      }
      assert.equal(body.expected_revision, workflow.revision);
      const correction: Correction = {
        correction_ref: {
          correction_id: id('4'),
          correction_revision: id('5', 64),
        },
        page: 6,
        content: String(body.content),
        method: 'manual',
        warnings: [],
        created_at: now,
        request_id: requestId,
      };
      corrections = [correction];
      workflow = {
        ...workflow,
        revision: id('6', 64),
        pages: [
          {
            page: 6,
            state: 'pending',
            correction_ref: correction.correction_ref,
          },
        ],
      };
      receipts.set(requestId, JSON.stringify(body));
      if (loseResponse) {
        loseResponse = false;
        throw new TypeError('synthetic response loss');
      }
      return reply({ data: { workflow, access, replayed: false } });
    }
    assert.ok(
      url.pathname.endsWith(`/notification-workflows/${workflow.workflow_id}`),
    );
    assert.equal(url.searchParams.get('profile'), context.selection.profile);
    return reply({
      data: {
        workflow,
        corrections: mismatch ? [] : corrections,
        conversion,
        events: [],
        access,
      },
    });
  };
  try {
    const mutation = {
      ...session,
      workflowId: workflow.workflow_id,
      requestId: id('7'),
      expectedRevision: workflow.revision,
      page: 6,
      method: 'manual' as const,
      content: '사람이 고친 문자',
    };
    loseResponse = true;
    assert.equal((await service.correct(mutation)).ok, false);
    const observed = await service.read(mutation);
    assert.ok(
      observed.ok && observed.data.corrections[0]?.content === mutation.content,
    );
    const replay = await service.correct(mutation);
    assert.ok(replay.ok && replay.data.replayed);
    assert.equal(writes[0]?.expected_revision, writes[1]?.expected_revision);
    assert.equal(
      (await service.correct({ ...mutation, content: '바뀐 요청' })).ok,
      false,
    );
    assert.equal(JSON.stringify(conversion), original);
    mismatch = true;
    const invalid = await service.read(mutation);
    assert.ok(!invalid.ok && invalid.error.code === 'correction_mismatch');
    mismatch = false;
    writable = false;
    const count = writes.length;
    assert.equal(
      (await service.correct({ ...mutation, requestId: id('9') })).ok,
      false,
    );
    assert.equal(writes.length, count);
    writable = true;
    const request = {
      ...session,
      workflowId: workflow.workflow_id,
      requestId: id('a'),
      expectedRevision: workflow.revision,
      page: 6,
    };
    const candidate = await service.retryPage(request);
    assert.ok(candidate.ok && candidate.data.content === '다시 인식한 후보');
    assert.equal(writes.length, count);
    assert.equal(workflow.pages[0]?.state, 'pending');
    const beforeStale = retries;
    assert.equal(
      (await service.retryPage({ ...request, expectedRevision: id('b', 64) }))
        .ok,
      false,
    );
    assert.equal(retries, beforeStale);
    stage = 'wait';
    const pending = service.retryPage(request);
    for (let attempt = 0; attempt < 40 && retries === beforeStale; attempt += 1)
      await delay(5);
    assert.equal(
      (await service.retryPage({ ...request, requestId: id('c') })).ok,
      false,
    );
    const cancelled = await service.cancelRetry(request);
    assert.ok(cancelled.ok && cancelled.data.cancelled);
    const cancellation = await pending;
    assert.ok(!cancellation.ok && cancellation.error.code === 'cancelled');
    stage = 'changed';
    const changed = await service.retryPage(request);
    assert.ok(!changed.ok && changed.error.code === 'conflict');
    stage = 'scope';
    const switched = await service.retryPage({
      ...request,
      expectedRevision: workflow.revision,
    });
    assert.ok(!switched.ok && switched.error.code === 'scope_changed');
    assert.equal(JSON.stringify(conversion), original);
    current = true;
    const selected = workflow.pages[0];
    assert.ok(selected?.correction_ref);
    const selection = [{ page: 6, correction_ref: selected.correction_ref }];
    assert.equal(
      (
        await service.decide({
          ...session,
          workflowId: workflow.workflow_id,
          requestId: id('d'),
          expectedRevision: workflow.revision,
          decisions: [
            {
              page: 6,
              state: 'usable',
              correction_ref: selected.correction_ref,
            },
          ],
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await service.approve({
          ...session,
          workflowId: workflow.workflow_id,
          requestId: id('e'),
          expectedRevision: workflow.revision,
          correctionRefs: selection,
        })
      ).ok,
      true,
    );
    assert.ok(approvedBody);
    console.log(
      'PASS correction CAS/replay/read integrity and page OCR candidate/cancel/scope guards; no analysis or original mutation',
    );
  } finally {
    current = true;
    await service.stop();
    globalThis.fetch = savedFetch;
  }
}

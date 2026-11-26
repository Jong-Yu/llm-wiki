import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AnalysisContext,
  ConnectionService,
} from '@main/backend/ConnectionService';
import type { ProcessRecovery } from '@main/backend/processRecovery';
import {
  readProcessJournal,
  writeProcessJournal,
} from '@main/backend/processRecovery';
import { AnalysisService } from '@main/backend/AnalysisService';
import { NotificationService } from '@main/backend/NotificationService';
import { loadNotificationDevice } from '@main/backend/notificationDevice';
import type {
  AnalysisDetail,
  AnalysisStartRequest,
  AnalysisExecuteRequest,
} from '@contracts/analysis.contract';
import type {
  NotificationWorkflow,
  NotificationSession,
} from '@contracts/notifications.contract';
import { notificationApproveSchema } from '@contracts/notifications.contract';
import type { DocumentTask } from '@contracts/documentTasks.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';

/** 실제 보호 저장소와 서비스에 격리 서버/실행기를 주입해 승인·복구의 부수 효과를 검사합니다. */
export async function verifyNotifications(
  context: AnalysisContext,
  connection: ConnectionService,
  recovery: ProcessRecovery,
  detail: AnalysisDetail,
  task: DocumentTask,
  failure: SourceConversionRun,
  root: string,
): Promise<void> {
  const hex = (value: string, length: number = 32): string =>
    value.repeat(length);
  const now = new Date().toISOString();
  const device = await loadNotificationDevice(
    join(root, 'notification-device.json'),
  );
  assert.deepEqual(
    await loadNotificationDevice(join(root, 'notification-device.json')),
    device,
  );
  const source = {
    source_id: task.source.sourceId,
    source_version: task.source.sourceVersion,
    source_sha256: task.source.sourceSha256,
    registration_revision: task.source.registrationRevision,
  };
  const actor = {
    user_id: context.active.userId,
    tenant: context.selection.tenant,
    profile_id: context.selection.profile,
    policy_revision: context.active.policyRevision,
    access_revision: context.active.accessRevision,
  };
  const session: NotificationSession = {
    connectionId: context.active.connectionId,
    expectedScope: {
      userId: actor.user_id,
      tenant: actor.tenant,
      profileId: actor.profile_id,
      policyRevision: actor.policy_revision,
      accessRevision: actor.access_revision,
    },
  };
  let workflow: NotificationWorkflow = {
    workflow_id: hex('e'),
    revision: hex('a', 64),
    source_ref: source,
    conversion_ref: {
      conversion_id: hex('e'),
      conversion_revision: hex('b', 64),
    },
    title: '승인 대기 시험',
    target_document: 'approved.md',
    state: 'review',
    pages: [{ page: 1, state: 'pending' }],
    approval: null,
    execution: null,
    resume_request_id: hex('c'),
    created_at: now,
    updated_at: now,
  };
  const conversion = {
    manifest: {
      id: hex('e'),
      source_ref: source,
      method: 'ocr',
      complete: false,
      unread_ranges: [
        'page 1: ocr_low_or_missing_confidence_text_retained_manual_review_required',
      ],
      warnings: ['OCR review'],
      units: [
        { unit_id: 'page1', location: { kind: 'pages', start: 1, end: 1 } },
      ],
    },
    revision: hex('b', 64),
    components: { page1: '가'.repeat(104705) + 'ab' },
  };
  const sourceBefore = JSON.stringify(conversion);
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  let approvalLoss: 'before' | 'after' | null = 'before';
  let claimLoss: 'before' | 'after' | null = 'before';
  let offlineEvent = true;
  let staleEventRequest: string | null = null;
  let wrongSource = false;
  let pageScopeChanges = false;
  let current = true;
  const savedFetch = globalThis.fetch;
  const savedCurrent = connection.isAnalysisCurrent;
  connection.isAnalysisCurrent = (): boolean => current;
  let registrations = 0,
    executions = 0;
  let running = false;
  let inspectedDetail = detail;
  let claimRequired = true;
  const executionRequests: AnalysisExecuteRequest[] = [];
  let preserveLarge = true;
  const analysis = {
    inspectRuntime: async (): Promise<string[]> => [],
    start: async (
      request: AnalysisStartRequest,
    ): Promise<{ ok: true; data: AnalysisDetail }> => {
      registrations += 1;
      assert.equal(request.registration?.requestId, workflow.resume_request_id);
      assert.equal(
        request.registration?.conversionRef?.conversionId,
        workflow.workflow_id,
      );
      assert.equal(request.sourceSha256, source.source_sha256);
      return { ok: true, data: detail };
    },
    inspectExecution: async (): Promise<{
      ok: true;
      data: {
        detail: AnalysisDetail;
        mode: 'start' | 'resume' | null;
        blockers: string[];
        checkedAt: string;
      };
    }> => ({
      ok: true,
      data: {
        detail: inspectedDetail,
        mode: running
          ? null
          : inspectedDetail.job.state === 'awaiting_cli'
            ? 'start'
            : 'resume',
        blockers: running ? ['이미 실행 중'] : [],
        checkedAt: now,
      },
    }),
    execute: async (
      request: AnalysisExecuteRequest,
    ): Promise<{ ok: true; data: AnalysisDetail }> => {
      executions += 1;
      executionRequests.push(request);
      running = true;
      assert.equal(
        request.executionClaimId,
        claimRequired ? workflow.execution?.claim_id : undefined,
      );
      return { ok: true, data: inspectedDetail };
    },
  };
  const create = (): NotificationService =>
    new NotificationService(connection, analysis, device, recovery);
  let service = create();
  const read = { ...session, workflowId: workflow.workflow_id };
  const envelope = (data: unknown): Response =>
    Response.json({ data, meta: { trace_id: hex('f') } });
  globalThis.fetch = async (
    input: string | URL | Request,
    options?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (options?.method === 'POST') {
      const body: Record<string, unknown> = JSON.parse(String(options.body));
      posted.push({ path, body });
      if (path.endsWith('/pages')) {
        assert.equal(body.expected_revision, workflow.revision);
        workflow = {
          ...workflow,
          revision: hex('c', 64),
          pages: [{ page: 1, state: 'usable' }],
        };
      } else if (path.endsWith('/approve')) {
        if (approvalLoss === 'before') {
          approvalLoss = null;
          throw new Error('lost before commit');
        }
        assert.equal(body.expected_revision, hex('c', 64));
        workflow = {
          ...workflow,
          revision: hex('d', 64),
          state: 'approved',
          approval: {
            request_id: String(body.request_id),
            actor,
            approved_at: now,
            device_id: String(body.device_id),
            device_name: String(body.device_name),
          },
        };
        if (approvalLoss === 'after') {
          approvalLoss = null;
          throw new Error('lost after commit');
        }
      } else if (path.endsWith('/claim')) {
        if (claimLoss === 'before') {
          claimLoss = null;
          throw new Error('claim lost before commit');
        }
        workflow = {
          ...workflow,
          revision: hex('e', 64),
          state: 'claimed',
          execution: {
            claim_id: body.reclaim ? hex('7') : hex('f'),
            device_id: String(body.device_id),
            device_name: String(body.device_name),
            claimed_at: now,
            job_id: body.reclaim ? (workflow.execution?.job_id ?? null) : null,
          },
        };
        if (claimLoss === 'after') {
          claimLoss = null;
          throw new Error('claim lost after commit');
        }
      } else if (path.endsWith('/execution')) {
        assert.ok(workflow.execution);
        workflow = {
          ...workflow,
          revision: hex('f', 64),
          execution: { ...workflow.execution, job_id: String(body.job_id) },
        };
      } else if (
        path.endsWith('/notifications/read') ||
        path.endsWith('/notifications/dismiss')
      ) {
        return envelope({ updated: 1, access: actor });
      } else if (path.endsWith('/notification-events')) {
        if (body.request_id === staleEventRequest)
          return Response.json(
            { error: { code: 'source_changed' } },
            { status: 409 },
          );
        if (offlineEvent) throw new Error('offline');
        return envelope({ access: actor });
      } else if (path.endsWith('/notification-workflows'))
        return envelope({ workflow, replayed: false, access: actor });
      return envelope({ workflow, replayed: false, access: actor });
    }
    if (path.includes('/analysis-jobs/'))
      return envelope({
        ...detail.job,
        source_ref: { ...detail.job.source_ref, size_bytes: 8_225_322 },
        registration: preserveLarge
          ? {
              mode: 'preserve',
              title: workflow.title,
              conversion_ref: workflow.conversion_ref,
            }
          : null,
        result_summary: { ...detail.job.result_summary, results: [] },
        access: actor,
      });
    if (path.endsWith('/notifications'))
      return envelope({
        items: [],
        next_cursor: null,
        unread_count: 0,
        approval_count: 0,
        latest_sequence: 0,
        access: actor,
      });
    if (path.includes('/sources/') && path.endsWith('/pages'))
      return envelope({ ...source, page_count: 170, access: actor });
    if (path.includes('/versions/')) {
      if (pageScopeChanges) current = false;
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: {
          'Content-Type': 'image/png',
          'X-Source-Sha256': source.source_sha256,
          'X-Source-Version': source.source_version,
          'X-Registration-Revision': source.registration_revision,
          'X-Source-Page': '1',
        },
      });
    }
    return envelope({
      workflow,
      conversion: wrongSource
        ? { ...conversion, revision: hex('9', 64) }
        : conversion,
      events: [],
      access: actor,
    });
  };
  try {
    assert.equal(
      notificationApproveSchema.safeParse({
        ...read,
        requestId: hex('1'),
        expectedRevision: workflow.revision,
        deviceId: hex('2'),
      }).success,
      false,
    );
    assert.equal(
      (
        await service.markRead({
          ...session,
          notificationIds: [hex('3')],
          read: true,
        })
      ).ok,
      true,
    );
    assert.equal(workflow.approval, null);
    assert.equal(
      (await service.dismiss({ ...session, notificationIds: [hex('3')] })).ok,
      true,
    );
    const readonlyService = new NotificationService(
      {
        analysisContext: async (
          _connectionId: string,
          write: boolean = false,
        ): ReturnType<ConnectionService['analysisContext']> =>
          write
            ? { ok: false, error: { code: 'forbidden', message: '조회 전용' } }
            : context,
        isAnalysisCurrent: (): boolean => true,
        analysisAccessFailure: (): void => {},
        onScopeChanged: (): void => {},
      },
      analysis,
      device,
      recovery,
    );
    assert.equal(
      (
        await readonlyService.markRead({
          ...session,
          notificationIds: [hex('3')],
          read: false,
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await readonlyService.approve({
          ...read,
          requestId: hex('1'),
          expectedRevision: workflow.revision,
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await readonlyService.dismiss({
          ...session,
          notificationIds: [hex('3')],
        })
      ).ok,
      true,
    );
    assert.equal(workflow.approval, null);
    await service.decide({
      ...read,
      requestId: hex('1'),
      expectedRevision: workflow.revision,
      decisions: [{ page: 1, state: 'usable' }],
    });
    const approval = {
      ...read,
      requestId: hex('2'),
      expectedRevision: workflow.revision,
    };
    assert.equal((await service.approve(approval)).ok, false);
    await service.read(read);
    assert.equal(
      posted.filter((item): boolean => item.path.endsWith('/approve')).length,
      1,
    );
    service = create();
    assert.equal(
      (
        await service.approve({
          ...approval,
          requestId: hex('3'),
          targetDocument: 'changed.md',
        })
      ).ok,
      true,
    );
    const approvalPosts = posted.filter((item): boolean =>
      item.path.endsWith('/approve'),
    );
    assert.equal(approvalPosts.length, 2);
    assert.deepEqual(approvalPosts[1]?.body, approvalPosts[0]?.body);
    const approved = await service.read(read);
    assert.ok(approved.ok);
    assert.equal(
      approved.data.workflow.approval?.request_id,
      approval.requestId,
    );
    assert.equal(
      (await readProcessJournal(recovery, context, 'notification-approvals'))
        .length,
      0,
    );
    assert.equal(executions, 0);
    const resume = {
      ...read,
      requestId: hex('4'),
      expectedRevision: workflow.revision,
    };
    assert.equal((await service.continue(resume)).ok, false);
    assert.equal(registrations, 0);
    service = create();
    const continued = await service.continue({
      ...resume,
      requestId: hex('5'),
    });
    assert.ok(continued.ok && continued.data.started);
    const claims = posted.filter((item): boolean =>
      item.path.endsWith('/claim'),
    );
    assert.deepEqual(claims[0]?.body, claims[1]?.body);
    assert.equal(registrations, 1);
    assert.equal(executions, 1);
    assert.equal(
      (
        await service.continue({
          ...resume,
          expectedRevision: workflow.revision,
        })
      ).ok,
      false,
    );
    assert.equal(executions, 1);
    assert.equal(JSON.stringify(conversion), sourceBefore);
    const foreign = new NotificationService(
      connection,
      analysis,
      { deviceId: hex('9'), deviceName: '다른 PC' },
      recovery,
    );
    const denied = await foreign.validateExecution(
      context,
      {
        ...detail.job,
        registration: {
          mode: 'preserve',
          title: workflow.title,
          conversion_ref: workflow.conversion_ref,
        },
      },
      hex('f'),
    );
    assert.equal(denied?.error.code, 'execution_claim_invalid');
    assert.equal(
      (
        await foreign.continue({
          ...resume,
          expectedRevision: workflow.revision,
        })
      ).ok,
      false,
    );
    assert.equal(executions, 1);
    running = false;
    workflow = { ...workflow, state: 'failed' };
    claimLoss = 'after';
    const retry = {
      ...read,
      requestId: hex('6'),
      expectedRevision: workflow.revision,
    };
    assert.equal((await service.continue(retry)).ok, false);
    assert.equal(executions, 1);
    assert.equal((await create().continue(retry)).ok, true);
    assert.equal(executions, 2);
    assert.equal(registrations, 1);
    assert.equal(workflow.execution?.claim_id, hex('7'));
    const resumedWorkflow = structuredClone(workflow);
    /** 로컬 작업 복원과 다른 화면의 일반 execute가 같은 서버 등록 기록으로 이어지는지 검사합니다. */
    function prepareResume(
      deviceId: string = device.deviceId,
    ): AnalysisExecuteRequest {
      running = false;
      workflow = structuredClone(resumedWorkflow);
      workflow.state = 'stopped';
      assert.ok(workflow.execution && workflow.target_document);
      workflow.execution.device_id = deviceId;
      inspectedDetail = {
        ...detail,
        job: {
          ...detail.job,
          actor: { ...detail.job.actor, ...actor },
          user_id: actor.user_id,
          tenant: actor.tenant,
          request_id: workflow.resume_request_id,
          source_ref: { ...detail.job.source_ref, ...source },
          targets: [
            { ...detail.job.targets[0]!, document: workflow.target_document },
          ],
          registration: {
            mode: 'preserve',
            title: workflow.title,
            conversion_ref: workflow.conversion_ref,
          },
        },
      };
      return {
        connectionId: context.active.connectionId,
        jobId: detail.job.job_id,
        expectedJobRevision: detail.job.job_revision,
        mode: detail.job.state === 'awaiting_cli' ? 'start' : 'resume',
      };
    }
    const approvalsBeforeResume = posted.filter((item): boolean =>
      item.path.endsWith('/approve'),
    ).length;
    let directResume = prepareResume();
    let resumed = await service.execute(directResume);
    assert.ok(
      resumed.ok,
      'same PC direct execute must obtain the reviewed registration claim internally',
    );
    assert.equal(
      executionRequests.at(-1)?.executionClaimId,
      workflow.execution?.claim_id,
    );
    assert.deepEqual(
      resumed.data.receipts,
      detail.receipts,
      'saved Wiki receipts must survive the resume',
    );
    directResume = prepareResume(hex('9'));
    resumed = await create().execute(directResume);
    assert.ok(
      resumed.ok,
      'an expired other-device registration must resume without PC selection',
    );
    assert.equal(workflow.execution?.device_id, device.deviceId);
    // 실제 장애와 같이 등록은 연결됐지만 CLI claim이 소비되기 전에 멈춘 상태입니다.
    directResume = prepareResume();
    inspectedDetail.job = {
      ...inspectedDetail.job,
      state: 'awaiting_cli',
      run_id: null,
      reported_status: null,
      lease_status: 'none',
    };
    directResume.mode = 'start';
    assert.ok(
      (await create().execute(directResume)).ok,
      'stopped linked registration with no consumed CLI claim must start from the existing job',
    );
    for (const stage of ['claim', 'registration'] as const) {
      directResume = prepareResume();
      const oldEntry = (
        await readProcessJournal(recovery, context, 'notification-executions')
      ).find((entry): boolean => entry.key === workflow.workflow_id);
      assert.ok(oldEntry);
      await writeProcessJournal(
        recovery,
        context,
        'notification-executions',
        workflow.workflow_id,
        {
          workflowId: workflow.workflow_id,
          requestId: hex('8'),
          expectedRevision: workflow.revision,
          stage,
          reclaim: false,
          priorClaimId: null,
        },
        oldEntry.revision,
      );
      const claimsBefore = posted.filter((item): boolean =>
        item.path.endsWith('/claim'),
      ).length;
      assert.ok(
        (await create().execute(directResume)).ok,
        `stopped ${stage} journal must obtain a fresh claim`,
      );
      assert.equal(
        posted.filter((item): boolean => item.path.endsWith('/claim')).length,
        claimsBefore + 1,
      );
      assert.equal(
        posted.filter((item): boolean => item.path.endsWith('/claim')).at(-1)
          ?.body.reclaim,
        true,
      );
    }
    directResume = prepareResume();
    const executionsBeforeDuplicate = executions;
    const duplicate = await Promise.all([
      service.execute(directResume),
      service.execute(directResume),
    ]);
    assert.equal(duplicate.filter((result): boolean => result.ok).length, 1);
    assert.equal(executions, executionsBeforeDuplicate + 1);
    directResume = prepareResume(hex('9'));
    running = true;
    const executionsBeforeBlocked = executions;
    let blocked = await service.execute(directResume);
    assert.ok(
      !blocked.ok && blocked.error.code === 'analysis_execution_blocked',
    );
    assert.equal(
      executions,
      executionsBeforeBlocked,
      'active lease must never be taken over',
    );
    for (const changedField of ['user_id', 'tenant'] as const) {
      directResume = prepareResume();
      inspectedDetail.job[changedField] = 'different';
      blocked = await service.execute(directResume);
      assert.ok(
        !blocked.ok && blocked.error.code === 'registration_job_changed',
      );
    }
    directResume = prepareResume();
    inspectedDetail.job.actor = {
      ...inspectedDetail.job.actor,
      profile_id: 'different',
    };
    blocked = await service.execute(directResume);
    assert.ok(!blocked.ok && blocked.error.code === 'registration_job_changed');
    directResume = prepareResume();
    workflow.approval = null;
    blocked = await service.execute(directResume);
    assert.ok(!blocked.ok && blocked.error.code === 'content_review_required');
    assert.equal(
      posted.filter((item): boolean => item.path.endsWith('/approve')).length,
      approvalsBeforeResume,
    );
    assert.equal(registrations, 1, 'resume must retain the original job');
    directResume = prepareResume();
    const requestsBeforePlain = posted.length;
    inspectedDetail.job.registration = null;
    claimRequired = false;
    assert.ok(
      (await service.execute(directResume)).ok,
      'ordinary personal analysis keeps its direct execution path',
    );
    assert.equal(posted.length, requestsBeforePlain);
    claimRequired = true;
    inspectedDetail = detail;
    console.log(
      'PASS public execute resumes reviewed registrations on the same or expired device, recovers unconsumed/stale claims, preserves saved receipts, blocks duplicate/active/foreign work, and keeps ordinary analysis unchanged',
    );
    const runtimeRoot = join(root, 'notification-runtime');
    await mkdir(join(runtimeRoot, 'tools'), { recursive: true });
    const argvPath = join(runtimeRoot, 'executed.json');
    await writeFile(
      join(runtimeRoot, 'tools', 'analysis_cli.py'),
      'import json,sys\nfrom pathlib import Path\nPath("executed.json").write_text(json.dumps(sys.argv))\n',
    );
    const oldRuntimeRoot = process.env.WIKI_CLIENT_ROOT;
    const oldPython = process.env.WIKI_CLIENT_PYTHON;
    process.env.WIKI_CLIENT_ROOT = runtimeRoot;
    process.env.WIKI_CLIENT_PYTHON = process.env.WIKI_TASK_TEST_PYTHON;
    const large = new AnalysisService(
      connection,
      undefined,
      join(root, 'notification-execution'),
    );
    try {
      assert.equal(Buffer.byteLength(conversion.components.page1), 314_117);
      const preserved = await large.inspectExecution({
        connectionId: session.connectionId,
        jobId: detail.job.job_id,
      });
      assert.ok(preserved.ok);
      assert.equal(
        preserved.data.blockers.some((value: string): boolean =>
          value.includes('4 MiB'),
        ),
        false,
      );
      assert.ok(preserved.data.mode);
      large.connectExecutionGuard((scope, job, claimId) =>
        service.validateExecution(scope, job, claimId),
      );
      const spawned = await large.execute({
        connectionId: session.connectionId,
        jobId: detail.job.job_id,
        expectedJobRevision: detail.job.job_revision,
        mode: preserved.data.mode,
        executionClaimId: hex('7'),
      });
      assert.ok(spawned.ok);
      let argv: string[] | null = null;
      for (let attempt = 0; attempt < 100 && !argv; attempt += 1) {
        try {
          argv = JSON.parse(await readFile(argvPath, 'utf8'));
        } catch {
          await delay(10);
        }
      }
      assert.ok(argv);
      assert.equal(argv[argv.indexOf('--execution-claim-id') + 1], hex('7'));
      assert.ok(argv.includes('--reclaim'));
      await large.stop();
      preserveLarge = false;
      const unconverted = await large.inspectExecution({
        connectionId: session.connectionId,
        jobId: detail.job.job_id,
      });
      assert.ok(unconverted.ok);
      assert.equal(
        unconverted.data.blockers.some((value: string): boolean =>
          value.includes('4 MiB'),
        ),
        true,
      );
    } finally {
      await large.stop();
      if (oldRuntimeRoot === undefined) delete process.env.WIKI_CLIENT_ROOT;
      else process.env.WIKI_CLIENT_ROOT = oldRuntimeRoot;
      if (oldPython === undefined) delete process.env.WIKI_CLIENT_PYTHON;
      else process.env.WIKI_CLIENT_PYTHON = oldPython;
    }
    wrongSource = true;
    assert.equal((await service.read(read)).ok, false);
    wrongSource = false;
    const image = await service.page({ ...read, page: 1 });
    assert.ok(
      image.ok && image.data.dataUrl.startsWith('data:image/png;base64,'),
    );
    pageScopeChanges = true;
    const stale = await service.page({ ...read, page: 1 });
    assert.ok(!stale.ok && stale.error.code === 'scope_changed');
    current = true;
    pageScopeChanges = false;
    const beforeFrameEvents = posted.length;
    await service.observeConversion(
      context,
      { ...task, item: { ...task.item, format: 'png' } },
      {
        ...failure,
        format: 'png',
        state: 'partial',
        receiptState: 'saved',
        reference: {
          ...task.source,
          requestId: failure.requestId,
          conversionId: workflow.workflow_id,
          conversionRevision: conversion.revision,
        },
        report: {
          method: 'ocr',
          units: [
            {
              unit_id: 'frame1',
              location: { kind: 'whole' },
              content: 'image text',
            },
          ],
          complete: false,
          unread_ranges: [
            'frame 1: ocr_low_or_missing_confidence_text_retained_manual_review_required',
          ],
          warnings: [],
          origin: 'client_reported',
          coverage: 'reported_units_only',
          original_coverage: 'not_verified',
          semantic_validation: 'not_run',
          diagnostics: [],
          unit_methods: {},
        },
      },
    );
    assert.equal(posted.length, beforeFrameEvents + 1);
    assert.ok(posted.at(-1)?.path.endsWith('/notification-workflows'));
    await service.observeConversion(context, task, failure);
    assert.equal(
      (await readProcessJournal(recovery, context, 'notification-outbox'))
        .length,
      1,
    );
    offlineEvent = false;
    await create().list(session);
    assert.equal(
      (await readProcessJournal(recovery, context, 'notification-outbox'))
        .length,
      0,
    );
    const events = posted.filter((item): boolean =>
      item.path.endsWith('/notification-events'),
    );
    assert.equal(events.length, 2);
    assert.deepEqual(events[0]?.body, events[1]?.body);
    assert.deepEqual(
      events[0]?.body.diagnostic_codes,
      failure.diagnosticCodes.length ? failure.diagnosticCodes : undefined,
    );
    staleEventRequest = hex('a');
    await writeProcessJournal(
      recovery,
      context,
      'notification-outbox',
      'aaa-stale-event',
      {
        path: 'notification-events',
        body: { ...events[0]?.body, request_id: staleEventRequest },
      },
    );
    await writeProcessJournal(
      recovery,
      context,
      'notification-outbox',
      'zzz-next-event',
      {
        path: 'notification-events',
        body: { ...events[0]?.body, request_id: hex('b') },
      },
    );
    await create().flush(context);
    const remainingOutbox = await readProcessJournal(
      recovery,
      context,
      'notification-outbox',
    );
    assert.deepEqual(
      remainingOutbox.map((entry): string => entry.key),
      ['aaa-stale-event'],
    );
    assert.ok(
      posted.some((entry): boolean => entry.body.request_id === hex('b')),
    );
    const disk = await recovery.readContext(context, 'notification-executions');
    assert.ok(disk.ok);
    assert.equal(JSON.stringify(disk).includes(context.token), false);
    // 저장 뒤 응답을 잃은 승인은 같은 영수증 읽기로만 해소합니다.
    workflow = {
      ...workflow,
      workflow_id: hex('8'),
      revision: hex('c', 64),
      conversion_ref: {
        conversion_id: hex('8'),
        conversion_revision: conversion.revision,
      },
      state: 'review',
      approval: null,
      execution: null,
    };
    conversion.manifest.id = hex('8');
    const second = {
      ...session,
      workflowId: workflow.workflow_id,
      requestId: hex('7'),
      expectedRevision: workflow.revision,
    };
    approvalLoss = 'after';
    assert.equal((await service.approve(second)).ok, false);
    const before = posted.filter(
      (entry): boolean => !entry.path.endsWith('/notification-events'),
    ).length;
    assert.equal((await create().approve(second)).ok, true);
    assert.equal(
      posted.filter(
        (entry): boolean => !entry.path.endsWith('/notification-events'),
      ).length,
      before,
    );
    workflow = {
      ...workflow,
      state: 'stopped',
      blocked_reason: 'source_changed',
    };
    const obsoleteInspection = await service.inspect(second);
    assert.ok(obsoleteInspection.ok && !obsoleteInspection.data.ready);
    const stalePosts = posted.filter(
      (entry): boolean => !entry.path.endsWith('/notification-events'),
    ).length;
    const obsoleteContinue = await service.continue(second);
    assert.ok(
      !obsoleteContinue.ok && obsoleteContinue.error.code === 'source_changed',
    );
    const obsoleteExecution = await service.validateExecution(
      context,
      {
        ...detail.job,
        registration: {
          mode: 'preserve',
          title: workflow.title,
          conversion_ref: workflow.conversion_ref,
        },
      },
      hex('7'),
    );
    assert.equal(obsoleteExecution?.error.code, 'source_changed');
    assert.equal(
      posted.filter(
        (entry): boolean => !entry.path.endsWith('/notification-events'),
      ).length,
      stalePosts,
    );
    console.log(
      'PASS notification approval/claim response loss, restart replay, fixed evidence, device isolation, bounded preview and reconnect outbox',
    );
  } finally {
    globalThis.fetch = savedFetch;
    connection.isAnalysisCurrent = savedCurrent;
  }
}

/** POST 도달 전 유실은 기본 조회와 승인 흐름의 명시 재시도를 분리하여 복구합니다. */
export async function verifyMissingRegistration(
  context: AnalysisContext,
  connection: ConnectionService,
  recovery: ProcessRecovery,
  detail: AnalysisDetail,
  task: DocumentTask,
): Promise<void> {
  const request: AnalysisStartRequest = {
    connectionId: context.active.connectionId,
    ...task.source,
    targetDocument: 'registered-from-approval.md',
    registration: {
      requestId: '9'.repeat(32),
      title: task.item.title,
      conversionRef: {
        conversionId: '8'.repeat(32),
        conversionRevision: '7'.repeat(64),
      },
    },
    outputs: ['wiki', 'ontology'],
  };
  const actor = {
    user_id: context.active.userId,
    tenant: context.selection.tenant,
    profile_id: context.selection.profile,
    policy_revision: context.active.policyRevision,
    access_revision: context.active.accessRevision,
  };
  const posts: unknown[] = [];
  let committed = false;
  let gets = 0;
  const savedFetch = globalThis.fetch;
  const envelope = (data: unknown): Response =>
    Response.json({ data, meta: { trace_id: '1'.repeat(32) } });
  const receipt = {
    request_id: request.registration?.requestId,
    state: 'complete',
    job_id: detail.job.job_id,
    access: actor,
  };
  const registeredJob = {
    ...detail.job,
    request_id: request.registration?.requestId,
    targets: [{ ...detail.job.targets[0], document: request.targetDocument }],
    result_summary: { ...detail.job.result_summary, results: [] },
    registration: {
      mode: 'preserve',
      title: task.item.title,
      conversion_ref: {
        conversion_id: '8'.repeat(32),
        conversion_revision: '7'.repeat(64),
      },
    },
    access: actor,
  };
  globalThis.fetch = async (
    input: string | URL | Request,
    options?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (options?.method === 'POST') {
      assert.ok(path.endsWith('/analysis-jobs/registrations'));
      posts.push(JSON.parse(String(options.body)));
      if (posts.length === 1)
        throw new Error('request lost before reaching server');
      committed = true;
      return envelope(receipt);
    }
    if (path.includes('/requests/')) {
      gets += 1;
      return committed
        ? envelope(receipt)
        : Response.json({ error: { code: 'not_found' } }, { status: 404 });
    }
    if (path.includes('/analysis-jobs/')) return envelope(registeredJob);
    throw new Error('unexpected registration fixture route');
  };
  try {
    const first = await new AnalysisService(connection, recovery).start(
      request,
    );
    assert.ok(!first.ok);
    assert.equal(posts.length, 1);
    const restored = new AnalysisService(connection, recovery);
    const readOnlyRecovery = await restored.start(request);
    assert.ok(
      !readOnlyRecovery.ok &&
        readOnlyRecovery.error.code === 'creation_unconfirmed',
    );
    assert.equal(posts.length, 1);
    const changed = await restored.start(
      { ...request, targetDocument: 'changed.md' },
      true,
    );
    assert.ok(!changed.ok && changed.error.code === 'creation_unconfirmed');
    assert.equal(posts.length, 1);
    const changedReference = await restored.start(
      { ...request, sourceVersion: '6'.repeat(32) },
      true,
    );
    assert.ok(
      !changedReference.ok &&
        changedReference.error.code === 'creation_unconfirmed',
    );
    assert.equal(posts.length, 1);
    const beforeReplay = await readProcessJournal(
      recovery,
      context,
      'pending-analysis',
    );
    assert.equal(beforeReplay.length, 1);
    assert.equal(JSON.stringify(beforeReplay).includes(context.token), false);
    const retried = await new AnalysisService(connection, recovery).start(
      request,
      true,
    );
    assert.ok(retried.ok);
    assert.equal(retried.data.job.request_id, request.registration?.requestId);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0], posts[1]);
    assert.equal(gets, 4);
    assert.equal(
      (await readProcessJournal(recovery, context, 'pending-analysis')).length,
      0,
    );
    const previousScopeCheck = connection.isAnalysisCurrent;
    connection.isAnalysisCurrent = (value: AnalysisContext): boolean =>
      value.generation === context.generation;
    try {
      const staleContext = { ...context, generation: context.generation - 1 };
      const switchedStart = await restored.start(request, true, staleContext);
      assert.ok(
        !switchedStart.ok && switchedStart.error.code === 'connection_changed',
      );
      const switchedExecute = await restored.execute(
        {
          connectionId: request.connectionId,
          jobId: detail.job.job_id,
          expectedJobRevision: detail.job.job_revision,
          mode: 'resume',
        },
        staleContext,
      );
      assert.ok(
        !switchedExecute.ok &&
          switchedExecute.error.code === 'connection_changed',
      );
      assert.equal(posts.length, 2);
      assert.equal(gets, 4);
    } finally {
      connection.isAnalysisCurrent = previousScopeCheck;
    }

    console.log(
      'PASS missing registration recovers only on explicit same-body approved retry; ordinary restore and changed basis never POST',
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
}

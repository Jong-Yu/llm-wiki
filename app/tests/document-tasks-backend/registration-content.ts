import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { ConnectionService } from '@main/backend/ConnectionService';
import { ProtectedRecoveryStore } from '@main/backend/ProtectedRecoveryStore';
import { RecoveryService } from '@main/backend/RecoveryService';
import type { ConnectionCipher } from '@main/backend/ProtectedConnectionStore';
import { NotificationService } from '@main/backend/NotificationService';
import { NotificationContentReader } from '@main/backend/NotificationContentReader';
import { loadNotificationDevice } from '@main/backend/notificationDevice';
import { apiFailure, readScopedApiJson } from '@main/backend/readApi';
import {
  contentText,
  originalContentText,
} from '@renderer/features/review-source-notifications/model/notificationView';
import type { NotificationDetail } from '@renderer/features/review-source-notifications/model/notificationView';
import type { ApiFailure, ReadApiResult } from '@main/backend/readApi';
import type { DocumentTask } from '@contracts/documentTasks.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';
import {
  notificationAccessSchema,
  notificationSourceSchema,
  notificationConversionRefSchema,
  notificationLocation,
} from '@contracts/notifications.contract';
import type {
  NotificationSession,
  NotificationItem,
  NotificationWorkflow,
  NotificationDecideRequest,
} from '@contracts/notifications.contract';

const fixtureSchema = z.object({
  token: z.string(),
  access: notificationAccessSchema,
  fixtures: z.record(
    z.string(),
    z.object({
      workflow_id: z.string(),
      source_ref: notificationSourceSchema,
      conversion_ref: notificationConversionRefSchema,
      source_size_bytes: z.number().int().nonnegative(),
    }),
  ),
});
const partTextEnvelope = z.looseObject({
  data: z.looseObject({ components: z.record(z.string(), z.string()) }),
});

/** GET 전용 본문 reader와 변경 서비스가 격리 HTTP의 같은 원본·보정 판본을 사용하는지 확인합니다. */
export async function verifyRegistrationContent(
  root: string,
  python: string,
  cipher: ConnectionCipher,
  networkFetch: typeof globalThis.fetch,
): Promise<void> {
  const fixtureRoot = join(root, 'content-server');
  const projectRoot = resolve(process.cwd(), '..');
  const server = spawn(
    python,
    [
      join(
        process.cwd(),
        'tests/document-tasks-backend/registration-content-server.py',
      ),
      fixtureRoot,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, PYTHONPATH: projectRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const previousFetch = globalThis.fetch;
  let errors = '';
  server.stderr.on('data', (data: Buffer): void => {
    errors = (errors + data.toString()).slice(-4000);
  });
  let service: NotificationService | undefined;
  try {
    const serverUrl = await new Promise<string>(
      (
        accept: (value: string) => void,
        reject: (error: Error) => void,
      ): void => {
        const timeout = setTimeout(
          (): void => reject(new Error('Content API did not start: ' + errors)),
          20000,
        );
        let output = '';
        server.stdout.on('data', (data: Buffer): void => {
          output += data.toString();
          const match = /READY (http:\/\/127\.0\.0\.1:\d+\/api\/v1\/)/.exec(
            output,
          );
          if (match?.[1]) {
            clearTimeout(timeout);
            accept(match[1]);
          }
        });
        server.once('error', (error: Error): void => {
          clearTimeout(timeout);
          reject(error);
        });
        server.once('exit', (): void => {
          clearTimeout(timeout);
          reject(new Error('Content API exited: ' + errors));
        });
      },
    );
    const fixture = fixtureSchema.parse(
      JSON.parse(await readFile(join(fixtureRoot, 'fixture.json'), 'utf8')),
    );
    const access = fixture.access;
    const context: AnalysisContext = {
      active: {
        status: 'connected',
        connectionId: 'registration-content-http',
        serverUrl,
        userId: access.user_id,
        policyRevision: access.policy_revision,
        ...(access.access_revision
          ? { accessRevision: access.access_revision }
          : {}),
        workspaces: [
          {
            id: access.tenant,
            permissions: ['read', 'source_write', 'write', 'ontology_write'],
            defaultProfile: access.profile_id,
            profiles: [
              { id: access.profile_id, domain: null, viewpoint: null },
            ],
          },
        ],
        selection: { tenant: access.tenant, profile: access.profile_id },
        checkedAt: new Date().toISOString(),
      },
      selection: { tenant: access.tenant, profile: access.profile_id },
      token: fixture.token,
      generation: 1,
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
    let writable = true;
    let executions = 0;
    let loseCorrectionResponse = false;
    let partFault: 'none' | 'denied' | 'mismatch' | 'scope' = 'none';
    let partReads = 0;
    let current = true;
    let originalResponseTooLarge = false;
    const accessFailures: string[] = [];
    const paths: string[] = [];
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      paths.push(url.pathname + url.search);
      assert.ok(
        !url.pathname.includes('/analysis-jobs/'),
        'Content editing must not launch or claim analysis.',
      );
      if (
        originalResponseTooLarge &&
        url.pathname.includes('/analysis-conversions/')
      )
        return Response.json(
          {
            error: {
              code: 'input_limit',
              message: 'Synthetic legacy original response boundary.',
            },
          },
          { status: 422 },
        );
      const response = await networkFetch(input, init);
      if (url.pathname.includes('/analysis-conversion-parts/')) {
        partReads += 1;
        if (partReads === 2 && partFault === 'denied')
          return Response.json(
            {
              error: {
                code: 'forbidden',
                message: 'Synthetic access revoked during part retrieval.',
              },
            },
            { status: 403 },
          );
        if (partReads === 2 && partFault === 'scope') current = false;
        if (partReads === 2 && partFault === 'mismatch') {
          const changed = partTextEnvelope.parse(await response.json());
          const key = Object.keys(changed.data.components)[0];
          assert.ok(key);
          changed.data.components[key] += 'mismatched transport bytes';
          return Response.json(changed);
        }
      }
      if (
        loseCorrectionResponse &&
        url.pathname.endsWith('/corrections') &&
        response.ok
      ) {
        loseCorrectionResponse = false;
        throw new Error(
          'Synthetic lost correction response after real commit.',
        );
      }
      return response;
    };
    const noExecution = async (): Promise<never> => {
      executions += 1;
      throw new Error('Reading or editing content must not execute analysis.');
    };
    const connection = new ConnectionService();
    connection.analysisContext = async (
      _id: string,
      write?: boolean,
    ): Promise<AnalysisContext | ApiFailure> =>
      write && !writable
        ? { ok: false, error: { code: 'forbidden', message: '읽기 전용' } }
        : context;
    connection.isAnalysisCurrent = (): boolean => current;
    connection.analysisAccessFailure = (failure: ApiFailure): void => {
      accessFailures.push(failure.error.code);
    };
    connection.onScopeChanged = (): void => {};
    const recovery = new RecoveryService(
      connection,
      new ProtectedRecoveryStore(join(root, 'real-content-recovery'), cipher),
    );
    service = new NotificationService(
      connection,
      {
        inspectRuntime: noExecution,
        inspectExecution: noExecution,
        start: noExecution,
        execute: noExecution,
      },
      await loadNotificationDevice(join(root, 'content-device.json')),
      recovery,
    );
    // 본문 조회는 분석·기기·보호 저장소 없이 인증된 GET 함수 하나로 검사합니다.
    const contentRequests = new Set<AbortController>();
    const readerPaths: string[] = [];
    const readContentApi = (
      selected: AnalysisContext,
      path: string,
    ): Promise<ReadApiResult> => {
      readerPaths.push(path);
      return readScopedApiJson(connection, contentRequests, selected, path, {
        schema: z.object({
          data: z.looseObject({ access: notificationAccessSchema }),
        }),
        changed: (): ApiFailure =>
          apiFailure('scope_changed', '합성 접근 범위 변경'),
        invalidMessage: '등록 본문 응답을 확인할 수 없습니다.',
        profile: 'get-query',
        maxResponseBytes: 8 * 1024 * 1024,
      });
    };
    const reader = new NotificationContentReader(readContentApi);
    const id = (): string => randomUUID().replaceAll('-', '');
    const read = async (name: string): Promise<NotificationWorkflow> => {
      const target = fixture.fixtures[name];
      assert.ok(target);
      const result = await reader.read(context, target.workflow_id);
      assert.ok(
        result.ok,
        result.ok ? '' : result.error.code + ': ' + result.error.message,
      );
      assert.equal(
        result.data.sourcePageCount,
        result.data.source_format === 'pdf' ? 3 : null,
      );
      return result.data.workflow;
    };

    let partial = await read('partial');
    assert.equal(
      partial.pages.find(
        (item: NotificationWorkflow['pages'][number]): boolean =>
          item.page === 2,
      )?.input_required,
      true,
    );
    const premature = await service.decide({
      ...session,
      workflowId: partial.workflow_id,
      requestId: id(),
      expectedRevision: partial.revision,
      decisions: [{ page: 2, state: 'usable' }],
    });
    assert.ok(
      !premature.ok && premature.error.code === 'content_input_required',
    );
    const normalPreview = await service.page({
      ...session,
      workflowId: partial.workflow_id,
      page: 3,
    });
    assert.ok(
      normalPreview.ok,
      normalPreview.ok ? '' : normalPreview.error.message,
    );
    assert.match(normalPreview.data.dataUrl, /^data:image\/png;base64,/);
    const missing = await service.correct({
      ...session,
      workflowId: partial.workflow_id,
      expectedRevision: partial.revision,
      requestId: id(),
      page: 2,
      method: 'manual',
      content: '직접 입력한 누락 내용',
      warnings: [],
    });
    assert.ok(missing.ok);
    assert.equal(
      missing.data.workflow.pages.find(
        (item: NotificationWorkflow['pages'][number]): boolean =>
          item.page === 2,
      )?.input_required,
      false,
    );
    partial = missing.data.workflow;
    const stale = await service.correct({
      ...session,
      workflowId: partial.workflow_id,
      expectedRevision: '0'.repeat(64),
      requestId: id(),
      page: 3,
      method: 'manual',
      content: 'Must not replace newer content.',
      warnings: [],
    });
    assert.ok(!stale.ok && stale.error.code === 'conflict');
    const normal = await service.correct({
      ...session,
      workflowId: partial.workflow_id,
      expectedRevision: partial.revision,
      requestId: id(),
      page: 3,
      method: 'manual',
      content: '정상 페이지도 수정',
      warnings: [],
    });
    assert.ok(normal.ok);
    partial = normal.data.workflow;
    const blank = await service.correct({
      ...session,
      workflowId: partial.workflow_id,
      expectedRevision: partial.revision,
      requestId: id(),
      page: 2,
      method: 'blank',
      content: '',
      warnings: [],
    });
    assert.ok(blank.ok);
    partial = blank.data.workflow;
    const confirmed = await service.decide({
      ...session,
      workflowId: partial.workflow_id,
      expectedRevision: partial.revision,
      requestId: id(),
      decisions: partial.pages.map(
        (
          item: NotificationWorkflow['pages'][number],
        ): NotificationDecideRequest['decisions'][number] => ({
          ...notificationLocation(item),
          state: 'usable',
          ...(item.correction_ref
            ? { correction_ref: item.correction_ref }
            : {}),
        }),
      ),
    });
    assert.ok(confirmed.ok);
    partial = confirmed.data.workflow;
    const wrongHash = await service.approve({
      ...session,
      workflowId: partial.workflow_id,
      expectedRevision: partial.revision,
      requestId: id(),
      correctionsRevision: '0'.repeat(64),
      targetDocument: 'partial.md',
    });
    assert.ok(
      !wrongHash.ok && wrongHash.error.code === 'correction_basis_changed',
    );
    const approved = await service.approve({
      ...session,
      workflowId: partial.workflow_id,
      expectedRevision: partial.revision,
      requestId: id(),
      correctionsRevision: partial.corrections_revision,
      targetDocument: 'partial.md',
    });
    assert.ok(approved.ok);
    assert.equal(approved.data.workflow.state, 'approved');
    const selectedPdf = await service.read({
      ...session,
      workflowId: partial.workflow_id,
    });
    assert.ok(selectedPdf.ok);
    assert.equal(
      contentText(selectedPdf.data, { whole_document: true }),
      'Existing low confidence text.\n\n\n\n정상 페이지도 수정',
      'Whole input includes the selected blank missing page and normal-page correction.',
    );
    assert.equal(
      originalContentText(selectedPdf.data, { whole_document: true }),
      'Existing low confidence text.\n\nNormal third page.',
    );
    const localPdf = structuredClone(selectedPdf.data);
    localPdf.workflow.pages = localPdf.workflow.pages.map(
      (
        page: NotificationDetail['workflow']['pages'][number],
      ): NotificationDetail['workflow']['pages'][number] =>
        page.page === 2 ? { page: 2, state: 'pending' } : page,
    );
    assert.equal(
      contentText(
        localPdf,
        { whole_document: true },
        {
          'page:2': '아직 저장하지 않은 누락 페이지 입력',
          'page:3': '',
        },
      ),
      'Existing low confidence text.\n\n아직 저장하지 않은 누락 페이지 입력\n\n',
      'Local page drafts include a missing page and override saved text with an explicit blank.',
    );
    const duplicatePage = structuredClone(selectedPdf.data);
    assert.ok(duplicatePage.conversion);
    const firstPage = duplicatePage.conversion.manifest.units[0];
    assert.ok(firstPage);
    duplicatePage.conversion.manifest.units.splice(1, 0, {
      ...firstPage,
      unit_id: 'p1_extra',
    });
    duplicatePage.conversion.components.p1_extra =
      'Another fragment on page one.';
    duplicatePage.workflow.pages = [];
    duplicatePage.corrections = [];
    assert.equal(
      contentText(duplicatePage, { whole_document: true }),
      'Existing low confidence text.\n\nAnother fragment on page one.\n\nNormal third page.',
      'Multiple units on one page are combined once rather than repeated per unit.',
    );
    const correctedPage = selectedPdf.data.corrections.find(
      (correction: NotificationDetail['corrections'][number]): boolean =>
        correction.page === 3,
    );
    assert.ok(correctedPage);
    duplicatePage.corrections = [{ ...correctedPage, page: 1 }];
    duplicatePage.workflow.pages = [
      {
        page: 1,
        state: 'pending',
        correction_ref: correctedPage.correction_ref,
      },
    ];
    assert.equal(
      contentText(duplicatePage, { whole_document: true }),
      '정상 페이지도 수정\n\nNormal third page.',
      'One selected page correction replaces all fragments of that page only once.',
    );

    const whole = await read('whole');
    const replacement = await service.correct({
      ...session,
      workflowId: whole.workflow_id,
      expectedRevision: whole.revision,
      requestId: id(),
      whole_document: true,
      method: 'manual',
      content: '전체 문서를 직접 입력했습니다.',
      warnings: [],
    });
    assert.ok(replacement.ok);
    assert.equal(replacement.data.workflow.pages.length, 1);
    assert.equal(replacement.data.workflow.pages[0]?.whole_document, true);
    const text = await read('text');
    const textRequest = {
      ...session,
      workflowId: text.workflow_id,
      expectedRevision: text.revision,
      requestId: id(),
      unit_id: 'lines',
      method: 'manual' as const,
      content: '일반 텍스트 단위 수정',
      warnings: [],
    };
    loseCorrectionResponse = true;
    const lost = await service.correct(textRequest);
    assert.ok(!lost.ok);
    assert.ok((await read('text')).pages[0]?.correction_ref);
    const replay = await service.correct(textRequest);
    assert.ok(replay.ok && replay.data.replayed);

    const presentation = fixture.fixtures.presentation;
    assert.ok(presentation);
    const presentationRead = await service.read({
      ...session,
      workflowId: presentation.workflow_id,
    });
    assert.ok(
      presentationRead.ok,
      presentationRead.ok ? '' : presentationRead.error.message,
    );
    assert.equal(presentationRead.data.source_format, 'pptx');
    assert.equal(presentationRead.data.sourcePageCount, null);
    assert.equal(presentationRead.data.conversion?.manifest.complete, false);
    assert.deepEqual(presentationRead.data.conversion?.manifest.unread_ranges, [
      'slide 1: picture_content_not_read',
    ]);
    assert.equal(presentationRead.data.workflow.pages[0]?.whole_document, true);
    assert.equal(presentationRead.data.workflow.pages[0]?.input_required, true);
    assert.equal(
      originalContentText(presentationRead.data, { whole_document: true }),
      '첫 슬라이드의 보존된 본문.\n\n둘째 슬라이드의 보존된 본문.',
      'A real partial PPTX report reaches the whole-document editor with its retained text.',
    );
    const unconfirmedWhole = await service.decide({
      ...session,
      workflowId: presentation.workflow_id,
      expectedRevision: presentationRead.data.workflow.revision,
      requestId: id(),
      decisions: [{ whole_document: true, state: 'usable' }],
    });
    assert.ok(
      !unconfirmedWhole.ok &&
        unconfirmedWhole.error.code === 'content_input_required',
      'Showing retained text does not approve missing slide content.',
    );
    const correctedSlide = await service.correct({
      ...session,
      workflowId: presentation.workflow_id,
      expectedRevision: presentationRead.data.workflow.revision,
      requestId: id(),
      unit_id: 'slide_1',
      method: 'manual',
      content: '앞서 저장한 첫 슬라이드 수정.',
      warnings: [],
    });
    assert.ok(correctedSlide.ok);
    const correctedPresentation = await service.read({
      ...session,
      workflowId: presentation.workflow_id,
    });
    assert.ok(correctedPresentation.ok);
    const selectedText = contentText(correctedPresentation.data, {
      whole_document: true,
    });
    assert.equal(
      selectedText,
      '앞서 저장한 첫 슬라이드 수정.\n\n둘째 슬라이드의 보존된 본문.',
    );
    assert.equal(
      contentText(
        correctedPresentation.data,
        { whole_document: true },
        {
          'unit:slide_1': '아직 저장하지 않은 첫 슬라이드 수정.',
          'unit:slide_2': '',
        },
      ),
      '아직 저장하지 않은 첫 슬라이드 수정.\n\n',
      'Local unit drafts replace selected server corrections while preserving explicit blanks.',
    );
    assert.equal(
      originalContentText(correctedPresentation.data, { whole_document: true }),
      originalContentText(presentationRead.data, { whole_document: true }),
      'The original view retains the immutable report while whole input includes saved edits.',
    );
    const missingCorrection = structuredClone(correctedPresentation.data);
    missingCorrection.corrections = [];
    assert.equal(
      contentText(missingCorrection, { whole_document: true }),
      null,
    );
    assert.ok(selectedText !== null);
    const savedWhole = await service.correct({
      ...session,
      workflowId: presentation.workflow_id,
      expectedRevision: correctedPresentation.data.workflow.revision,
      requestId: id(),
      whole_document: true,
      method: 'manual',
      content: selectedText + '\n전체 확인한 추가 내용.',
      warnings: [],
    });
    assert.ok(savedWhole.ok);
    const rereadWhole = await service.read({
      ...session,
      workflowId: presentation.workflow_id,
    });
    assert.ok(rereadWhole.ok);
    assert.equal(
      contentText(rereadWhole.data, { whole_document: true }),
      selectedText + '\n전체 확인한 추가 내용.',
      'A saved whole correction takes precedence without dropping the earlier unit edit.',
    );
    assert.equal(
      contentText(
        rereadWhole.data,
        { whole_document: true },
        { 'unit:slide_1': '오래된 구간 초안' },
      ),
      selectedText + '\n전체 확인한 추가 내용.',
      'An existing whole correction remains authoritative over local segment drafts.',
    );
    assert.deepEqual(
      rereadWhole.data.conversion,
      presentationRead.data.conversion,
    );

    const source = {
      sourceId: presentation.source_ref.source_id,
      sourceVersion: presentation.source_ref.source_version,
      sourceSha256: presentation.source_ref.source_sha256,
      registrationRevision: presentation.source_ref.registration_revision,
    };
    const now = new Date().toISOString();
    const failureTask: DocumentTask = {
      taskId: id(),
      source,
      item: {
        ...source,
        kind: 'source',
        title: 'Synthetic failed conversion',
        sizeBytes: presentation.source_size_bytes,
        format: 'pptx',
        linkedDocumentCount: 0,
        analysisStatus: 'not_started',
      },
      targetDocument: 'synthetic-failure.md',
      createdAt: now,
      updatedAt: now,
      conversions: [],
      analysisSummary: null,
      registration: {
        requestId: id(),
        state: 'not_started',
        jobId: null,
        errorCode: null,
      },
    };
    const failureRun: SourceConversionRun = {
      requestId: id(),
      source,
      state: 'failed',
      format: 'pptx',
      progress: null,
      report: null,
      receiptState: 'not_submitted',
      reference: null,
      message: 'Synthetic converter failure',
      diagnosticCodes: ['conversion_checkpoint_locked', 'worker_failed'],
      cleanupWarning: false,
    };
    await service.observeConversion(context, failureTask, failureRun);
    await service.observeConversion(context, failureTask, failureRun);
    const secondDevice = new NotificationService(
      connection,
      {
        inspectRuntime: noExecution,
        inspectExecution: noExecution,
        start: noExecution,
        execute: noExecution,
      },
      await loadNotificationDevice(join(root, 'other-content-device.json')),
      new RecoveryService(
        connection,
        new ProtectedRecoveryStore(
          join(root, 'other-content-recovery'),
          cipher,
        ),
      ),
    );
    const otherDeviceList = await secondDevice.list(session);
    assert.ok(otherDeviceList.ok);
    const failureNotice = otherDeviceList.data.items.find(
      (item: NotificationItem): boolean =>
        item.title === failureTask.item.title,
    );
    assert.ok(failureNotice);
    const otherDeviceDetail = await secondDevice.read({
      ...session,
      workflowId: failureNotice.workflow_id,
    });
    assert.ok(otherDeviceDetail.ok);
    assert.equal(otherDeviceDetail.data.conversion, null);
    assert.equal(otherDeviceDetail.data.events.length, 1);
    assert.deepEqual(
      otherDeviceDetail.data.events[0]?.details?.diagnostic_codes,
      failureRun.diagnosticCodes,
      'A fresh device reads the retained failure cause without a local conversion report.',
    );
    await secondDevice.stop();

    const large = await read('large');
    const largeText = '"'.repeat(2 * 1024 * 1024) + '한😀수정';
    const largeSaved = await service.correct({
      ...session,
      workflowId: large.workflow_id,
      expectedRevision: large.revision,
      requestId: id(),
      page: 1,
      method: 'manual',
      content: largeText,
      warnings: [],
    });
    assert.ok(largeSaved.ok);
    const largeRead = await reader.read(context, large.workflow_id);
    assert.ok(
      largeRead.ok,
      largeRead.ok ? '' : largeRead.error.code + ': ' + largeRead.error.message,
    );
    assert.equal(largeRead.data.corrections[0]?.content, largeText);
    assert.equal(
      largeRead.data.conversion?.components.p1,
      '"'.repeat(2 * 1024 * 1024),
    );
    assert.equal(largeRead.data.sourcePageCount, 3);
    originalResponseTooLarge = true;
    const oldReportFallback = await reader.read(context, large.workflow_id);
    originalResponseTooLarge = false;
    assert.ok(oldReportFallback.ok);
    assert.equal(
      oldReportFallback.data.conversion?.components.p1,
      largeRead.data.conversion?.components.p1,
    );
    assert.equal(oldReportFallback.data.corrections[0]?.content, largeText);
    const multipart = fixture.fixtures.multipart;
    assert.ok(multipart);
    partReads = 0;
    const originalChunksBefore = paths.filter(
      (path: string): boolean =>
        path.includes('/content?') && path.includes('variant=original'),
    ).length;
    const multipartRead = await reader.read(context, multipart.workflow_id);
    assert.ok(
      multipartRead.ok,
      multipartRead.ok ? '' : multipartRead.error.code,
    );
    assert.equal(multipartRead.data.sourcePageCount, 3);
    assert.equal(
      multipartRead.data.conversion?.components.p1,
      '"'.repeat(2 * 1024 * 1024),
    );
    assert.equal(
      multipartRead.data.conversion?.components.p2,
      '"'.repeat(2 * 1024 * 1024),
    );
    assert.equal(
      partReads,
      2,
      'A large source is restored with one request per immutable part.',
    );
    assert.equal(
      paths.filter(
        (path: string): boolean =>
          path.includes('/content?') && path.includes('variant=original'),
      ).length,
      originalChunksBefore,
      'A resolved multipart source never falls back to repeated whole-report unit reads.',
    );
    for (const mode of ['denied', 'mismatch', 'scope'] as const) {
      partReads = 0;
      partFault = mode;
      const failed = await reader.read(context, multipart.workflow_id);
      assert.ok(
        !failed.ok,
        'A partial or mismatched read must never return selected content.',
      );
      assert.equal(
        failed.error.code,
        mode === 'denied'
          ? 'forbidden'
          : mode === 'mismatch'
            ? 'content_mismatch'
            : 'scope_changed',
      );
      if (mode === 'denied') assert.equal(failed.error.status, 403);
      current = true;
    }
    assert.ok(accessFailures.includes('forbidden'));
    partFault = 'none';
    partReads = 0;
    assert.ok((await reader.read(context, multipart.workflow_id)).ok);
    for (const [name, value] of Object.entries(fixture.fixtures)) {
      assert.equal(
        readerPaths.filter(
          (path: string): boolean =>
            path.startsWith(`sources/${value.source_ref.source_id}/`) &&
            path.includes('/pages?'),
        ).length,
        ['text', 'presentation'].includes(name) ? 0 : 1,
        'The exact source basis count is cached across workflow edits.',
      );
    }
    assert.equal(
      paths.filter(
        (path: string): boolean =>
          path.includes(`/sources/${presentation.source_ref.source_id}/`) &&
          path.includes('/pages?'),
      ).length,
      0,
      'A known PPTX source never calls the PDF-only page-count endpoint.',
    );
    const legacyMetadata = z.looseObject({
      source_format: z.unknown().optional(),
    });
    const legacyReader = new NotificationContentReader(
      async (
        selected: AnalysisContext,
        path: string,
      ): Promise<ReadApiResult> => {
        const result = await readContentApi(selected, path);
        if (!result.ok || path !== `notification-workflows/${text.workflow_id}`)
          return result;
        const value = legacyMetadata.parse(result.value);
        delete value.source_format;
        return { ok: true, value };
      },
    );
    const legacyRead = await legacyReader.read(context, text.workflow_id);
    assert.ok(legacyRead.ok);
    assert.equal(legacyRead.data.sourcePageCount, null);
    assert.equal(
      readerPaths.filter(
        (path: string): boolean =>
          path.startsWith(`sources/${text.source_ref.source_id}/`) &&
          path.includes('/pages?'),
      ).length,
      1,
      'A legacy server without source_format keeps the bounded page metadata fallback.',
    );
    assert.ok(
      paths.some((path: string): boolean =>
        path.includes('include_content=false'),
      ),
    );
    assert.ok(
      paths.some((path: string): boolean => path.includes('/content?')),
    );
    writable = false;
    const readOnly = await service.correct({ ...textRequest, requestId: id() });
    assert.ok(!readOnly.ok && readOnly.error.code === 'forbidden');
    assert.ok(await read('text'));
    assert.equal(executions, 0);
    console.log(
      'PASS real content API: missing/blank/whole/non-PDF, page count, CAS/replay, >8MiB multipart/chunk fallback, part 403/hash/scope failure, no execution',
    );
  } finally {
    await service?.stop();
    globalThis.fetch = previousFetch;
    server.kill('SIGTERM');
    await new Promise<void>((done: () => void): void => {
      if (server.exitCode !== null) done();
      else server.once('exit', (): void => done());
    });
  }
}

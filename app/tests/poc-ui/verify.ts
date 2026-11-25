import type {
  SourceConversionScope,
  SourceConversionRun,
} from '@contracts/sourceConversion.contract';
import {
  importProcessingSession,
  readSourceProcessingSession,
  sourceProcessingSession,
} from '@renderer/features/import-document-content/model/importProcessingSessions';
import { ImportProcessingSession } from '@renderer/features/import-document-content/model/ImportProcessingSession';
import type {
  ImportProcessingApi,
  ImportRegistration,
} from '@renderer/features/import-document-content/model/importProcessing.types';
import type {
  AnalysisStartRequest,
  AnalysisDetailResult,
  AnalysisExecutionInspectionResult,
  AnalysisDetail,
} from '@contracts/analysis.contract';
import { analysisDetailSchema } from '@contracts/analysis.contract';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { open, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assignTestWorkspace } from './assignment';
import { app, BrowserWindow } from 'electron';
import { ConnectionService } from '@main/backend/ConnectionService';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { AccountPreferencesStore } from '@main/backend/AccountPreferencesStore';
import { ProtectedConnectionStore } from '@main/backend/ProtectedConnectionStore';
import type { ConnectionCipher } from '@main/backend/ProtectedConnectionStore';
import { ProtectedRecoveryStore } from '@main/backend/ProtectedRecoveryStore';
import type { RecoveryScope } from '@main/backend/ProtectedRecoveryStore';
import {
  RecoveryService,
  logoutWithRecovery,
} from '@main/backend/RecoveryService';
import { createConnectionCipher } from '@main/backend/connectionProtection';
import { WorkspaceApiService } from '@main/backend/WorkspaceApiService';
import { AnalysisService } from '@main/backend/AnalysisService';
import { registerConnectionHandlers } from '@main/ipc/registerConnectionHandlers';
import type {
  ConnectionResult,
  ConnectionSnapshot,
} from '@contracts/connection.contract';
import {
  sameAccessRevision,
  parseConnectionResult,
} from '@contracts/connection.contract';
import type { RecoveryResult } from '@contracts/recovery.contract';
import {
  draftParts,
  replaceBody,
  replaceMetadata,
  authorshipLabel,
} from '@renderer/features/manage-document-content/model/documentMetadata';

/** 격리 실행기가 준 경로·주소가 없으면 실제 사용자 환경을 사용하지 않습니다. */
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated test setting: ${name}`);
  return value;
}
const root = requiredEnvironment('WIKI_UI_TEST_ROOT');
const serverUrl = requiredEnvironment('WIKI_UI_TEST_URL');
const appRoot = requiredEnvironment('WIKI_UI_APP_ROOT');
app.setPath('userData', join(root, 'electron-user'));
app.setName('LLM Wiki isolated verification');
const results: string[] = [];
const fetchOriginal = globalThis.fetch;
/** 현재 등록 요청의 식별자와 변환 참조를 시험 응답에 반영합니다. */
function registrationDetail(
  detail: AnalysisDetail,
  request: AnalysisStartRequest,
): AnalysisDetail {
  const registration = request.registration;
  assert.ok(registration);
  return analysisDetailSchema.parse({
    ...detail,
    job: {
      ...detail.job,
      request_id: registration.requestId,
      registration: {
        mode: 'preserve',
        title: registration.title,
        conversion_ref: registration.conversionRef
          ? {
              conversion_id: registration.conversionRef.conversionId,
              conversion_revision:
                registration.conversionRef.conversionRevision,
            }
          : null,
      },
    },
  });
}
/** 검증 실패에도 비밀을 출력하지 않고 체크 이름만 남깁니다. */
async function check(
  name: string,
  operation: () => Promise<void>,
): Promise<void> {
  await operation();
  results.push(name);
  console.log(`PASS ${name}`);
}
/** 공개 응답만 검사하며 오류 메시지에 main 비밀을 넣지 않습니다. */
function connected(
  result: ConnectionResult,
): Extract<ConnectionSnapshot, { status: 'connected' }> {
  assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
  assert.equal(result.data.status, 'connected');
  if (result.data.status !== 'connected') throw new Error('not_connected');
  return result.data;
}
/** 테스트마다 독립 저장 경로를 사용합니다. */
function service(name: string, cipher: ConnectionCipher): ConnectionService {
  const directory = join(root, name);
  return new ConnectionService(
    new ProtectedConnectionStore(directory, cipher),
    new AccountPreferencesStore(directory),
  );
}
/** 실제 main의 확인된 문맥에서 비밀 없는 요청 scope만 만듭니다. */
function scope(context: AnalysisContext): {
  userId: string;
  tenant: string;
  profileId: string;
  policyRevision: string;
  accessRevision?: string;
} {
  return {
    userId: context.active.userId,
    tenant: context.selection.tenant,
    profileId: context.selection.profile,
    policyRevision: context.active.policyRevision,
    accessRevision: context.active.accessRevision,
  };
}

/** 요청한 경우에만 격리 화면의 시각 확인용 이미지를 남깁니다. */
async function capture(window: BrowserWindow, name: string): Promise<void> {
  const directory = process.env.WIKI_UI_TEST_CAPTURE_DIR;
  if (directory)
    await writeFile(
      join(directory, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
}

/** 실제 렌더러가 비동기 IPC 상태를 반영할 때까지 지정 조건만 기다립니다. */
async function waitForRenderer(
  window: BrowserWindow,
  condition: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await window.webContents.executeJavaScript(condition)) return;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 100);
    });
  }
  throw new Error(`Renderer condition not reached: ${condition}`);
}

async function verify(): Promise<void> {
  await app.whenReady();
  const cipher = createConnectionCipher();
  assert.equal(
    (await cipher.availability()).availability,
    'protected',
    'Actual OS protection must be available for this suite',
  );
  if (process.env.WIKI_UI_TEST_PHASE === 'restart') {
    await check(
      'new Electron process restores OS protected login',
      async (): Promise<void> => {
        const restored = connected(
          await service('restart-survival', cipher).initialize(),
        );
        assert.equal(restored.displayName, 'UI 검증 사용자');
        assert.equal(restored.selection?.tenant, 'sdv-platform');
      },
    );
    await check(
      'new Electron process discovers assignment of an OS protected waiting account',
      async (): Promise<void> => {
        const restored = connected(
          await service('waiting-restart', cipher).initialize(),
        );
        assert.equal(restored.displayName, 'UI 재시작 대기');
        assert.deepEqual(restored.selection, {
          tenant: 'sdv-platform',
          profile: 'default',
        });
        assert.equal(restored.protection?.remembered, true);
      },
    );
    await check(
      'new Electron process cannot restore explicitly logged-out account offline',
      async (): Promise<void> => {
        globalThis.fetch = (): Promise<Response> =>
          Promise.reject(new Error('offline'));
        try {
          const state = await service('protected', cipher).initialize();
          assert.ok(state.ok);
          assert.equal(state.data.status, 'disconnected');
        } finally {
          globalThis.fetch = fetchOriginal;
        }
      },
    );
    return;
  }
  let connection = service('protected', cipher);
  let before: AnalysisContext;
  let registeredFixture: ImportRegistration | undefined;
  let jobFixture: AnalysisDetail | undefined;
  await check(
    'real HTTP unassigned signup, protected restart, explicit assignment refresh and private token',
    async (): Promise<void> => {
      const waiting = connected(
        await connection.authenticate({
          name: 'UI 검증 사용자',
          serverUrl,
          mode: 'signup',
        }),
      );
      assert.equal(waiting.selection, null);
      assert.deepEqual(waiting.workspaces, []);
      assert.equal(waiting.protection?.remembered, true);
      assert.equal(connection.localContext(), null);
      connection = service('protected', cipher);
      const restoredWaiting = connected(await connection.initialize());
      assert.equal(restoredWaiting.userId, waiting.userId);
      assert.equal(restoredWaiting.selection, null);
      assert.deepEqual(restoredWaiting.workspaces, []);
      const blocked = await connection.listDocuments({
        connectionId: restoredWaiting.connectionId,
        cursor: null,
        limit: 20,
      });
      assert.equal(blocked.ok, false);
      await assignTestWorkspace(
        join(appRoot, '..'),
        join(root, 'server'),
        waiting.userId,
      );
      const publicState = connected(await connection.refreshAccess());
      assert.equal(publicState.connectionId, restoredWaiting.connectionId);
      assert.equal(publicState.selection?.tenant, 'sdv-platform');
      assert.equal(publicState.workspaces[0]?.displayName, '테스트 작업 공간');
      assert.equal(publicState.protection?.remembered, true);
      const local = connection.localContext();
      assert.ok(local);
      before = local;
      assert.equal(JSON.stringify(publicState).includes(local.token), false);
      assert.equal(
        JSON.stringify(
          parseConnectionResult({
            ok: true,
            data: { ...publicState, token: local.token },
          }),
        ).includes(local.token),
        false,
      );
      assert.equal(
        (await readFile(join(root, 'protected/account.json'), 'utf8')).includes(
          local.token,
        ),
        false,
      );
      assert.equal(
        (await readFile(join(root, 'protected/selected.bin'))).includes(
          Buffer.from(local.token),
        ),
        false,
      );
    },
  );
  await check(
    'same user login returns same server credential; OS encrypted restart restore',
    async (): Promise<void> => {
      const savedToken = before.token;
      connection.disconnect();
      connection = service('protected', cipher);
      connected(await connection.initialize());
      assert.ok(connection.localContext()?.token === savedToken);
      connected(
        await connection.authenticate({
          name: 'UI 검증 사용자',
          serverUrl,
          mode: 'login',
        }),
      );
      assert.ok(connection.localContext()?.token === savedToken);
    },
  );
  await check(
    'other signup changes audit policy without invalidating current access',
    async (): Promise<void> => {
      const active = connected(connection.getState());
      const other = service('other', cipher);
      const waiting = connected(
        await other.authenticate({
          name: 'UI 두 번째',
          serverUrl,
          mode: 'signup',
        }),
      );
      assert.equal(waiting.selection, null);
      assert.deepEqual(waiting.workspaces, []);
      await assignTestWorkspace(
        join(appRoot, '..'),
        join(root, 'server'),
        waiting.userId,
      );
      connected(await other.refreshAccess());
      const current = await connection.analysisContext(active.connectionId);
      assert.ok(!('ok' in current));
      const fresh = await fetchOriginal(`${serverUrl}/api/v1/access-context`, {
        headers: { Authorization: `Bearer ${before.token}` },
      }).then((response: Response): Promise<unknown> => response.json());
      assert.ok(typeof fresh === 'object' && fresh !== null);
      const list = await connection.listDocuments({
        connectionId: active.connectionId,
        cursor: null,
        limit: 20,
      });
      assert.ok(list.ok, list.ok ? '' : JSON.stringify(list.error));
      assert.notEqual(list.data.access.policyRevision, active.policyRevision);
      assert.equal(list.data.access.accessRevision, active.accessRevision);
    },
  );
  await check(
    'real document save, metadata/body DTO, author, full-file CAS/history',
    async (): Promise<void> => {
      const local = connection.localContext();
      assert.ok(local);
      const api = new WorkspaceApiService(connection);
      const first = await api.execute({
        operation: 'saveDocument',
        connectionId: local.active.connectionId,
        expectedScope: scope(local),
        input: {
          document: 'ui-proof.md',
          content: '# 문서\n원문 유지\n',
          expected_revision: null,
        },
      });
      assert.ok(first.ok, first.ok ? '' : JSON.stringify(first.error));
      const read = await connection.readDocumentContent({
        connectionId: local.active.connectionId,
        document: 'ui-proof.md',
      });
      assert.ok(read.ok, read.ok ? '' : JSON.stringify(read.error));
      assert.equal(read.data.body, '# 문서\n원문 유지\n');
      assert.ok(read.data.documentId);
      assert.ok(authorshipLabel(read.data.authorship).includes('사람'));
      let draft = replaceBody(
        read.data,
        read.data.content,
        '# 문서\n사람 수정\n',
      );
      draft = replaceMetadata(read.data, draft, {
        title: '수정 제목',
        tags: '검증, 원문',
        description: '설명',
      });
      assert.equal(draftParts(read.data, draft).body, '# 문서\n사람 수정\n');
      assert.ok(draft.includes(read.data.documentId));
      const changed = await api.execute({
        operation: 'saveDocument',
        connectionId: local.active.connectionId,
        expectedScope: scope(local),
        input: {
          document: read.data.document,
          content: draft,
          expected_revision: read.data.revision,
        },
      });
      assert.ok(changed.ok, changed.ok ? '' : JSON.stringify(changed.error));
      const conflict = await api.execute({
        operation: 'saveDocument',
        connectionId: local.active.connectionId,
        expectedScope: scope(local),
        input: {
          document: read.data.document,
          content: draft,
          expected_revision: read.data.revision,
        },
      });
      assert.equal(conflict.ok, false);
      const versions = await api.execute({
        operation: 'documentVersions',
        connectionId: local.active.connectionId,
        expectedScope: scope(local),
        input: { document: read.data.document, limit: 20, cursor: null },
      });
      assert.ok(versions.ok);
      assert.ok(
        JSON.stringify(versions.data.data).includes(read.data.revision),
      );
    },
  );
  await check(
    'real source registration to single-MD analysis job without plan or TXT re-registration',
    async (): Promise<void> => {
      const local = connection.localContext();
      assert.ok(local);
      const source = await connection.registerSource({
        kind: 'text',
        connectionId: local.active.connectionId,
        expectedScope: scope(local),
        requestId: randomUUID().replaceAll('-', ''),
        title: '원본 제목',
        content: '# 원문\n원문은 그대로 보존합니다.\n',
        format: 'md',
      });
      assert.ok(source.ok, source.ok ? '' : JSON.stringify(source.error));
      assert.equal(source.data.state, 'complete');
      if (source.data.state !== 'complete')
        throw new Error('registration_unconfirmed');
      registeredFixture = source.data;
      const analysis = new AnalysisService(connection);
      const item = source.data.item;
      const result = await analysis.start({
        connectionId: local.active.connectionId,
        sourceId: item.sourceId,
        sourceVersion: item.sourceVersion,
        sourceSha256: item.sourceSha256,
        registrationRevision: item.registrationRevision,
        targetDocument: 'registered.md',
        outputs: ['wiki', 'ontology'],
        registration: {
          requestId: randomUUID().replaceAll('-', ''),
          title: item.title,
        },
      });
      assert.ok(result.ok, result.ok ? '' : JSON.stringify(result.error));
      jobFixture = result.data;
      assert.equal(result.data.job.source_ref.source_id, item.sourceId);
      assert.equal(result.data.job.targets[0]?.document, 'registered.md');
      assert.equal(result.data.job.result_summary.saved_count, 0);
      await analysis.stop();
    },
  );
  await check(
    'registration session skips text conversion and preserves saved Markdown on graph failure',
    async (): Promise<void> => {
      assert.ok(registeredFixture);
      assert.ok(jobFixture);
      const local = connection.localContext();
      assert.ok(local);
      let initial = jobFixture;
      let partial: AnalysisDetail = analysisDetailSchema.parse({
        ...initial,
        job: {
          ...initial.job,
          result_summary: {
            ...initial.job.result_summary,
            status: 'partial',
            saved_count: 1,
          },
          reported_status: 'failed',
        },
        local: { status: 'failed', message: '관계 추출 실패' },
        receipts: [
          {
            request_id: '1'.repeat(32),
            state: 'complete',
            saved: true,
            receipt: {
              actor: initial.job.actor,
              document: 'registered.md',
              stage: 'prepare_wiki',
              source_revision: 'a'.repeat(64),
              graph_revision: null,
              state_revision: null,
              bundle_id: '2'.repeat(32),
              bundle_revision: 'b'.repeat(64),
              review_status: 'unreviewed',
            },
            validation_report: null,
            current_output: { status: 'current' },
            cleanup_failures: [],
            diagnostics: null,
          },
        ],
      });
      let registrations = 0;
      let executions = 0;
      const api: ImportProcessingApi = {
        conversionRead: async (): Promise<never> => {
          throw new Error('TXT/MD must not duplicate conversion');
        },
        conversionStart: async (): Promise<never> => {
          throw new Error('TXT/MD must not duplicate conversion');
        },
        register: async (
          _scope: SourceConversionScope,
          request: AnalysisStartRequest,
        ): Promise<AnalysisDetailResult> => {
          registrations += 1;
          assert.equal(request.sourceId, initial.job.source_ref.source_id);
          initial = registrationDetail(initial, request);
          partial = registrationDetail(partial, request);
          return { ok: true, data: initial };
        },
        inspectJob: async (): Promise<AnalysisExecutionInspectionResult> => ({
          ok: true,
          data: {
            detail: partial,
            mode: 'resume',
            blockers: [],
            checkedAt: new Date().toISOString(),
          },
        }),
        executeJob: async (): Promise<AnalysisDetailResult> => {
          executions += 1;
          return {
            ok: true,
            data:
              executions === 2
                ? {
                    ...partial,
                    local: { status: 'running', message: '다시 실행 중' },
                  }
                : partial,
          };
        },
      };
      const session = new ImportProcessingSession(
        { connectionId: local.active.connectionId, ...scope(local) },
        registeredFixture,
        'registered.md',
        true,
        api,
      );
      await session.begin();
      assert.equal(session.getSnapshot().phase, 'stopped');
      assert.equal(session.getSnapshot().error, '관계 추출 실패');
      assert.equal(session.getSnapshot().document, 'registered.md');
      // 등록 요청이 곧 명시 실행이므로 begin이 관계 추출을 한 번 자동으로 이어갑니다.
      assert.equal(executions, 1);
      await session.refresh();
      assert.equal(executions, 1);
      await session.restart();
      assert.equal(registrations, 1);
      assert.equal(executions, 2);
      assert.equal(session.getSnapshot().phase, 'running');
      assert.equal(session.getSnapshot().error, null);
      assert.equal(session.getSnapshot().document, 'registered.md');
      await session.refresh();
      assert.equal(session.getSnapshot().phase, 'stopped');
    },
  );
  await check(
    'already registered source starts conversion-free analysis once and repeated starts do not register twice',
    async (): Promise<void> => {
      assert.ok(registeredFixture);
      assert.ok(jobFixture);
      const local = connection.localContext();
      assert.ok(local);
      let initial = jobFixture;
      let registrations = 0;
      let executions = 0;
      const api: ImportProcessingApi = {
        conversionRead: async (): Promise<never> => {
          throw new Error('MD must not convert');
        },
        conversionStart: async (): Promise<never> => {
          throw new Error('MD must not convert');
        },
        register: async (
          _scope: SourceConversionScope,
          request: AnalysisStartRequest,
        ): Promise<AnalysisDetailResult> => {
          registrations += 1;
          initial = registrationDetail(initial, request);
          return { ok: true, data: initial };
        },
        inspectJob: async (): Promise<AnalysisExecutionInspectionResult> => ({
          ok: true,
          data: {
            detail: initial,
            mode: 'start',
            blockers: [],
            checkedAt: new Date().toISOString(),
          },
        }),
        executeJob: async (): Promise<AnalysisDetailResult> => {
          executions += 1;
          return { ok: true, data: initial };
        },
      };
      // 목록의 등록 원본은 등록 영수증 없이 원본 항목만으로 같은 후처리를 시작한다.
      const session = new ImportProcessingSession(
        { connectionId: local.active.connectionId, ...scope(local) },
        { item: registeredFixture.item, cleanupWarningCount: 0 },
        'registered.md',
        true,
        api,
      );
      await session.begin();
      await session.begin();
      assert.equal(registrations, 1);
      assert.equal(executions, 1);
    },
  );
  await check(
    'processing session lookup isolates workspace, profile and access revision',
    async (): Promise<void> => {
      assert.ok(registeredFixture);
      const local = connection.localContext();
      assert.ok(local);
      const current = {
        connectionId: local.active.connectionId,
        ...scope(local),
        canRegister: true,
        canPrepare: true,
        canExtract: true,
      };
      const session = importProcessingSession(current, registeredFixture, {
        targetDocument: 'registered.md',
        extract: true,
      });
      assert.equal(
        sourceProcessingSession(registeredFixture.item, current),
        session,
      );
      assert.equal(
        readSourceProcessingSession(
          current,
          registeredFixture.item.sourceId,
          registeredFixture.item.sourceVersion,
        )?.session,
        session,
      );
      assert.equal(
        sourceProcessingSession(registeredFixture.item, {
          ...current,
          profileId: 'different',
        }),
        null,
      );
      assert.equal(
        sourceProcessingSession(registeredFixture.item, {
          ...current,
          tenant: 'different',
        }),
        null,
      );
      assert.equal(
        sourceProcessingSession(registeredFixture.item, {
          ...current,
          accessRevision: '0'.repeat(64),
        }),
        null,
      );
    },
  );
  await check(
    'failed conversion retries without reupload and advances after leaving the progress screen',
    async (): Promise<void> => {
      assert.ok(registeredFixture);
      assert.ok(jobFixture);
      const local = connection.localContext();
      assert.ok(local);
      let initial = jobFixture;
      let failed = analysisDetailSchema.parse({
        ...initial,
        local: { status: 'failed', message: 'AI 사용 한도로 중단됐습니다.' },
        job: { ...initial.job, reported_status: 'failed' },
      });
      const item = { ...registeredFixture.item, format: 'pdf' as const };
      const source = {
        sourceId: item.sourceId,
        sourceVersion: item.sourceVersion,
        sourceSha256: item.sourceSha256,
        registrationRevision: item.registrationRevision,
      };
      const conversion: SourceConversionRun = {
        requestId: '3'.repeat(32),
        source,
        state: 'failed',
        format: 'pdf',
        progress: null,
        report: null,
        receiptState: 'not_submitted',
        reference: null,
        message: '본문 변환 실행에 실패했습니다.',
        diagnosticCodes: ['worker_failed'],
        cleanupWarning: false,
      };
      let starts = 0;
      let registrations = 0;
      let executions = 0;
      const api: ImportProcessingApi = {
        conversionRead: async () => ({
          ok: true,
          data:
            starts === 0
              ? conversion
              : {
                  ...conversion,
                  state: 'complete',
                  receiptState: 'saved',
                  reference: {
                    ...source,
                    requestId: conversion.requestId,
                    conversionId: '4'.repeat(32),
                    conversionRevision: '5'.repeat(64),
                  },
                  report: {
                    method: 'pdf_text',
                    units: [
                      {
                        unit_id: 'page1',
                        location: { kind: 'pages', start: 1, end: 1 },
                        content: '원문',
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
                },
        }),
        conversionStart: async () => {
          starts += 1;
          return {
            ok: true,
            data: { ...conversion, state: 'running', receiptState: 'pending' },
          };
        },
        register: async (
          _scope: SourceConversionScope,
          request: AnalysisStartRequest,
        ): Promise<AnalysisDetailResult> => {
          registrations += 1;
          initial = registrationDetail(initial, request);
          failed = registrationDetail(failed, request);
          return { ok: true, data: initial };
        },
        inspectJob: async () => ({
          ok: true,
          data: {
            detail: executions ? failed : initial,
            mode: 'start',
            blockers: [],
            checkedAt: new Date().toISOString(),
          },
        }),
        executeJob: async () => {
          executions += 1;
          return { ok: true, data: failed };
        },
      };
      const session = new ImportProcessingSession(
        { connectionId: local.active.connectionId, ...scope(local) },
        { item, cleanupWarningCount: 0 },
        'registered.md',
        true,
        api,
      );
      await session.begin();
      assert.equal(session.getSnapshot().phase, 'conversion_failed');
      assert.equal(starts, 0);
      await session.restart();
      assert.equal(starts, 1);
      assert.equal(session.getSnapshot().phase, 'converting');
      // 화면 구독이나 수동 refresh 없이도 변환 완료 뒤 접수·추출을 이어갑니다.
      const deadline = Date.now() + 5000;
      while (executions === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(executions, 1);
      assert.equal(registrations, 1);
      assert.equal(session.getSnapshot().phase, 'stopped');
      assert.equal(session.getSnapshot().error, 'AI 사용 한도로 중단됐습니다.');
      await session.restart();
      assert.equal(executions, 2);
      assert.equal(registrations, 1);
      assert.equal(starts, 1);
    },
  );
  await check(
    'offline logout succeeds when protected deletion and recovery cleanup fail, restart stays logged out',
    async (): Promise<void> => {
      const lock = await open(
        join(root, 'protected/selected.lock'),
        'wx',
        0o600,
      );
      class FailedRecovery extends ProtectedRecoveryStore {
        override forgetIdentity(
          _scope: RecoveryScope,
          _current: () => boolean,
        ): Promise<RecoveryResult> {
          return Promise.reject(new Error('simulated cleanup failure'));
        }
      }
      const recovery = new RecoveryService(
        connection,
        new FailedRecovery(join(root, 'recovery'), cipher),
      );
      globalThis.fetch = (): Promise<Response> =>
        Promise.reject(new Error('offline'));
      try {
        const loggedOut = await logoutWithRecovery(connection, recovery);
        assert.ok(loggedOut.ok);
        assert.equal(loggedOut.data.status, 'disconnected');
        assert.ok(loggedOut.data.warning?.includes('로그아웃'));
        const restarted = service('protected', cipher);
        const restored = await restarted.initialize();
        assert.ok(restored.ok);
        assert.equal(restored.data.status, 'disconnected');
        assert.equal(restored.data.rememberedAccount?.name, 'UI 검증 사용자');
        assert.equal((await restarted.restoreSaved()).ok, true);
      } finally {
        globalThis.fetch = fetchOriginal;
        await lock.close();
      }
    },
  );
  await check(
    'late account response cannot revive logout',
    async (): Promise<void> => {
      const late = service('late', cipher);
      await late.initialize();
      let resume: (() => void) | undefined;
      let received: (() => void) | undefined;
      const arrived = new Promise<void>((done: () => void): void => {
        received = done;
      });
      globalThis.fetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await fetchOriginal(input, init);
        received?.();
        await new Promise<void>((done: () => void): void => {
          resume = done;
        });
        return response;
      };
      try {
        const pending = late.authenticate({
          name: 'UI 검증 사용자',
          serverUrl,
          mode: 'login',
        });
        await arrived;
        await late.logout();
        resume?.();
        const result = await pending;
        assert.equal(result.ok, false);
        assert.equal(late.localContext(), null);
        const state = late.getState();
        assert.ok(state.ok);
        assert.equal(state.data.status, 'disconnected');
      } finally {
        globalThis.fetch = fetchOriginal;
      }
    },
  );
  await check(
    'protected write failure keeps active session and reports persistence failure',
    async (): Promise<void> => {
      const failing: ConnectionCipher = {
        ...cipher,
        encrypt: (): Promise<Buffer> =>
          Promise.reject(new Error('simulated full disk')),
      };
      const current = service('save-failure', failing);
      const state = connected(
        await current.authenticate({
          name: 'UI 검증 사용자',
          serverUrl,
          mode: 'login',
        }),
      );
      assert.equal(state.protection?.remembered, false);
      assert.equal(state.protection?.issue, 'storage_write_failed');
    },
  );
  await check(
    'recovery access scope survives unrelated policy changes and rejects actual access changes',
    async (): Promise<void> => {
      const store = new ProtectedRecoveryStore(
        join(root, 'scope-recovery'),
        cipher,
      );
      const base: RecoveryScope = {
        serverUrl,
        userId: 'user',
        tenant: 'sdv-platform',
        profileId: 'default',
        policyRevision: 'a'.repeat(64),
        accessRevision: 'b'.repeat(64),
        domain: null,
        viewpoint: null,
      };
      const saved = await store.put(
        base,
        'pending-analysis',
        'job',
        '{}',
        null,
        (): boolean => true,
      );
      assert.ok(saved.ok);
      const same = await store.list(
        { ...base, policyRevision: 'c'.repeat(64) },
        'pending-analysis',
        (): boolean => true,
      );
      assert.ok(same.ok);
      assert.equal(same.data.entries.length, 1);
      const different = await store.list(
        { ...base, accessRevision: 'd'.repeat(64) },
        'pending-analysis',
        (): boolean => true,
      );
      assert.ok(different.ok);
      assert.equal(different.data.entries.length, 0);
      assert.equal(
        sameAccessRevision(base, { ...base, accessRevision: 'd'.repeat(64) }),
        false,
      );
      const legacy = { ...base, accessRevision: undefined };
      assert.ok(
        (
          await store.put(
            legacy,
            'pending-analysis',
            'old',
            '{}',
            null,
            (): boolean => true,
          )
        ).ok,
      );
      const old = await store.list(
        legacy,
        'pending-analysis',
        (): boolean => true,
      );
      assert.ok(old.ok);
      assert.equal(old.data.entries.length, 1);
    },
  );
  await check(
    'legacy recovery upgrades without rewriting old ciphertext and detects later legacy edits',
    async (): Promise<void> => {
      const directory = join(root, 'legacy-recovery');
      const store = new ProtectedRecoveryStore(directory, cipher);
      const legacy: RecoveryScope = {
        serverUrl,
        userId: 'legacy-user',
        tenant: 'sdv-platform',
        profileId: 'default',
        policyRevision: 'a'.repeat(64),
        domain: null,
        viewpoint: null,
      };
      const saved = await store.put(
        legacy,
        'pending-analysis',
        'old',
        '{"old":true}',
        null,
        (): boolean => true,
      );
      assert.ok(saved.ok);
      const entry = saved.data.entries[0];
      assert.ok(entry);
      const identity = (await readdir(directory))[0];
      assert.ok(identity);
      const filename = (await readdir(join(directory, identity))).find(
        (name: string): boolean => name.endsWith('.bin'),
      );
      assert.ok(filename);
      const oldPath = join(directory, identity, filename);
      const original = await readFile(oldPath);
      const current = { ...legacy, accessRevision: 'b'.repeat(64) };
      const upgraded = await store.list(
        current,
        'pending-analysis',
        (): boolean => true,
      );
      assert.ok(upgraded.ok);
      assert.deepEqual(upgraded.data.entries, saved.data.entries);
      assert.ok(
        (
          await store.put(
            current,
            'pending-analysis',
            'old',
            '{"new":true}',
            entry.revision,
            (): boolean => true,
          )
        ).ok,
      );
      assert.deepEqual(await readFile(oldPath), original);
      const reopened = new ProtectedRecoveryStore(directory, cipher);
      const read = await reopened.list(
        { ...current, policyRevision: 'c'.repeat(64) },
        'pending-analysis',
        (): boolean => true,
      );
      assert.ok(read.ok);
      assert.equal(read.data.entries[0]?.payload, '{"new":true}');
      assert.ok(
        (
          await store.put(
            legacy,
            'pending-analysis',
            'old',
            '{"legacyEdit":true}',
            entry.revision,
            (): boolean => true,
          )
        ).ok,
      );
      const conflict = await reopened.list(
        current,
        'pending-analysis',
        (): boolean => true,
      );
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, 'recovery_conflict');
    },
  );
  await check(
    'account switch rejects the previous delayed authentication response',
    async (): Promise<void> => {
      const switching = service('switching', cipher);
      await switching.initialize();
      let release: (() => void) | undefined;
      let arrive: (() => void) | undefined;
      const arrival = new Promise<void>((done: () => void): void => {
        arrive = done;
      });
      let first = true;
      globalThis.fetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const response = await fetchOriginal(input, init);
        if (first) {
          first = false;
          arrive?.();
          await new Promise<void>((done: () => void): void => {
            release = done;
          });
        }
        return response;
      };
      try {
        const previous = switching.authenticate({
          name: 'UI 검증 사용자',
          serverUrl,
          mode: 'login',
        });
        await arrival;
        const next = connected(
          await switching.authenticate({
            name: 'UI 두 번째',
            serverUrl,
            mode: 'login',
          }),
        );
        release?.();
        assert.equal((await previous).ok, false);
        assert.equal(connected(switching.getState()).userId, next.userId);
      } finally {
        globalThis.fetch = fetchOriginal;
      }
    },
  );
  await check(
    'real permission revocation invalidates active selection',
    async (): Promise<void> => {
      const account = service('revoked', cipher);
      const active = connected(
        await account.authenticate({
          name: 'UI 두 번째',
          serverUrl,
          mode: 'login',
        }),
      );
      const policyPath = join(root, 'server/.local/tenancy/access.json');
      const raw = JSON.parse(await readFile(policyPath, 'utf8'));
      raw.users[active.userId].memberships['sdv-platform'].permissions = [
        'read',
      ];
      await writeFile(`${policyPath}.test`, JSON.stringify(raw), {
        mode: 0o600,
      });
      await rename(`${policyPath}.test`, policyPath);
      const context = await account.analysisContext(active.connectionId);
      assert.ok('ok' in context && !context.ok);
      assert.equal(connected(account.getState()).selection, null);
    },
  );
  await check(
    'login response loss is distinguished from rejected signup',
    async (): Promise<void> => {
      const account = service('response-loss', cipher);
      await account.initialize();
      globalThis.fetch = (): Promise<Response> =>
        Promise.reject(new Error('simulated lost response'));
      try {
        const result = await account.authenticate({
          name: '가입 응답 유실',
          serverUrl,
          mode: 'signup',
        });
        assert.ok(!result.ok);
        assert.equal(result.error.code, 'auth_outcome_unknown');
      } finally {
        globalThis.fetch = fetchOriginal;
      }
      const duplicate = await account.authenticate({
        name: 'UI 검증 사용자',
        serverUrl,
        mode: 'signup',
      });
      assert.ok(!duplicate.ok);
      assert.equal(duplicate.error.status, 409);
    },
  );
  connected(
    await service('restart-survival', cipher).authenticate({
      name: 'UI 검증 사용자',
      serverUrl,
      mode: 'login',
    }),
  );
  const restartWaiting = connected(
    await service('waiting-restart', cipher).authenticate({
      name: 'UI 재시작 대기',
      serverUrl,
      mode: 'signup',
    }),
  );
  assert.equal(restartWaiting.selection, null);
  assert.equal(restartWaiting.protection?.remembered, true);
  await assignTestWorkspace(
    join(appRoot, '..'),
    join(root, 'server'),
    restartWaiting.userId,
  );
  await check(
    'actual Electron renderer/preload/main login, unassigned signup, assignment refresh and logout',
    async (): Promise<void> => {
      const location = pathToFileURL(
        join(appRoot, 'out/renderer/index.html'),
      ).href;
      let window: BrowserWindow | null = null;
      const stop = await registerConnectionHandlers(
        (): BrowserWindow | null => window,
        location,
      );
      window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          preload: join(appRoot, 'out/preload/index.cjs'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      await window.loadURL(location);
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 500);
      });
      assert.ok(
        (await window.webContents.executeJavaScript(
          "document.querySelector('#account-title')?.textContent",
        )) === 'LLM Wiki',
      );
      await capture(window, 'login');
      window.setContentSize(480, 720);
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 100);
      });
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('main').scrollWidth <= window.innerWidth",
        ),
        true,
        'Narrow login must fit without horizontal scrolling',
      );
      await capture(window, 'login-narrow');
      window.setContentSize(1280, 800);
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('header, aside, nav') === null",
        ),
        true,
        'Login must not mount the application header or sidebar',
      );
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('button[type=submit]').disabled",
        ),
        true,
        'Sign-in action stays disabled until both fields are filled',
      );
      await window.webContents.executeJavaScript(`(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [name, value] of Object.entries(${JSON.stringify({ name: 'UI 검증 사용자', serverUrl })})) {
        const input = document.querySelector('input[name="' + name + '"]');
        setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('button[type=submit]').disabled",
        ),
        false,
        'Filled name and server enable the sign-in action',
      );
      await window.webContents.executeJavaScript(
        "document.querySelector('input[value=signup]').click(); document.querySelector('input[value=signup]').focus()",
      );
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 50);
      });
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('input[value=login]').checked",
        ),
        true,
        'Left arrow must select login',
      );
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 50);
      });
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('input[value=signup]').checked && document.querySelector('button[type=submit]').textContent === '가입하고 시작'",
        ),
        true,
        'Right arrow must select signup and its matching action',
      );
      await capture(window, 'signup');
      await window.webContents.executeJavaScript(
        "document.querySelector('form').requestSubmit()",
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          await window.webContents.executeJavaScript(
            "document.querySelector('[role=alert]') !== null && !document.querySelector('input[value=login]').disabled && !document.querySelector('input[value=login]').closest('fieldset').disabled",
          )
        )
          break;
        if (attempt === 99)
          throw new Error('Duplicate signup did not show the server rejection');
        await new Promise<void>((done: () => void): void => {
          setTimeout(done, 100);
        });
      }
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('input[value=signup]').checked",
        ),
        true,
        'Rejected signup must preserve the selected mode',
      );
      await window.webContents.executeJavaScript(
        "document.querySelector('input[value=login]').click()",
      );
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 50);
      });
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('[role=alert]') === null",
        ),
        true,
        'Changing mode must clear the previous request error',
      );
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('input[name=name]')?.value ?? document.querySelector('form strong')?.textContent",
        ),
        'UI 검증 사용자',
      );
      await window.webContents.executeJavaScript(
        "document.querySelector('form').requestSubmit()",
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result: unknown = await window.webContents.executeJavaScript(
          'window.wiki.connection.getState()',
        );
        const state = parseConnectionResult(result);
        if (state.ok && state.data.status === 'connected') break;
        if (attempt === 99)
          throw new Error('Renderer login form did not authenticate');
        await new Promise<void>((done: () => void): void => {
          setTimeout(done, 100);
        });
      }
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 300);
      });
      assert.equal(
        (await window.webContents.executeJavaScript(
          "document.querySelector('#account-title')?.textContent",
        )) === 'LLM Wiki',
        false,
      );
      await window.webContents.executeJavaScript(
        "location.hash = '#/document?path=ui-proof.md'",
      );
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const text: string = await window.webContents.executeJavaScript(
          'document.body.innerText',
        );
        if (text.includes('수정 제목') && text.includes('사람 수정')) break;
        if (attempt === 49)
          throw new Error('Document metadata and author were not rendered');
        await new Promise<void>((done: () => void): void => {
          setTimeout(done, 100);
        });
      }
      await capture(window, 'document');
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('header') !== null && document.querySelector('aside') !== null",
        ),
        true,
      );
      // 주 행동 버튼은 앱 Header에 놓이므로 Header 자리가 준비될 때까지 기다립니다.
      await window.webContents.executeJavaScript(
        "new Promise(resolve => { const started = Date.now(); const poll = () => { const b = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '본문 편집'); if (b) { b.click(); resolve(true); } else if (Date.now() - started > 5000) resolve(false); else setTimeout(poll, 50); }; poll(); })",
      );
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 100);
      });
      const body: string = await window.webContents.executeJavaScript(
        "document.querySelector('[data-active=true] textarea[name=document-markdown]').value",
      );
      await capture(window, 'editor');
      assert.equal(body, '# 문서\n사람 수정\n');
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('input[name=document_id]') === null && document.querySelector('input[name=source]') === null",
        ),
        true,
      );
      const out: unknown = await window.webContents.executeJavaScript(
        'window.wiki.connection.disconnect()',
      );
      const parsed = parseConnectionResult(out);
      assert.ok(parsed.ok);
      assert.equal(parsed.data.status, 'disconnected');
      await window.webContents.executeJavaScript(
        "window.dispatchEvent(new Event('wiki-connection-changed'))",
      );
      await new Promise<void>((done: () => void): void => {
        setTimeout(done, 300);
      });
      assert.ok(
        (await window.webContents.executeJavaScript(
          "document.querySelector('#account-title')?.textContent",
        )) === 'LLM Wiki',
      );
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('header, aside, nav') === null",
        ),
        true,
        'Logout must unmount application navigation',
      );
      const requestLog = join(root, 'server/test-request-paths.txt');
      const previousRequests = (await readFile(requestLog, 'utf8'))
        .trim()
        .split('\n').length;
      await window.webContents.executeJavaScript(
        "document.querySelector('input[value=signup]').click()",
      );
      await waitForRenderer(
        window,
        "document.querySelector('input[name=name]') !== null",
      );
      await window.webContents.executeJavaScript(`(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        for (const [name, value] of Object.entries(${JSON.stringify({ name: 'UI 배정 대기', serverUrl })})) {
          const input = document.querySelector('input[name="' + name + '"]');
          setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`);
      await window.webContents.executeJavaScript(
        "document.querySelector('form').requestSubmit()",
      );
      await waitForRenderer(
        window,
        "document.body.innerText.includes('워크스페이스 배정 대기')",
      );
      const waiting = connected(
        parseConnectionResult(
          await window.webContents.executeJavaScript(
            'window.wiki.connection.getState()',
          ),
        ),
      );
      assert.equal(waiting.selection, null);
      assert.deepEqual(waiting.workspaces, []);
      assert.equal(waiting.protection?.remembered, true);
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelector('header, aside, nav') === null",
        ),
        true,
      );
      await capture(window, 'assignment-waiting');
      const waitingRequests = (await readFile(requestLog, 'utf8'))
        .trim()
        .split('\n')
        .slice(previousRequests);
      assert(waitingRequests.includes('/api/v1/auth/signup'));
      assert(
        waitingRequests.every((path: string): boolean =>
          ['/api/v1/auth/signup', '/api/v1/access-context'].includes(path),
        ),
        'Waiting renderer must not request business endpoints',
      );
      await assignTestWorkspace(
        join(appRoot, '..'),
        join(root, 'server'),
        waiting.userId,
      );
      await window.webContents.executeJavaScript(
        'document.querySelector(\'button[aria-label="워크스페이스 배정 다시 확인"]\').click()',
      );
      await waitForRenderer(
        window,
        "document.querySelector('header') !== null && document.querySelector('aside') !== null",
      );
      const assigned = connected(
        parseConnectionResult(
          await window.webContents.executeJavaScript(
            'window.wiki.connection.getState()',
          ),
        ),
      );
      assert.equal(assigned.connectionId, waiting.connectionId);
      assert.deepEqual(assigned.selection, {
        tenant: 'sdv-platform',
        profile: 'default',
      });
      await window.webContents.executeJavaScript(
        "location.hash = '#/document?path=ui-proof.md'",
      );
      await waitForRenderer(
        window,
        "document.body.innerText.includes('사람 수정')",
      );
      await capture(window, 'assignment-entered');
      window.destroy();
      window = null;
      await stop();
    },
  );
  console.log(
    JSON.stringify({
      passed: results.length,
      actualOsProtection: true,
      actualHTTP: true,
      actualElectron: true,
      actualAI: false,
    }),
  );
}
void verify().then(
  (): void => app.exit(0),
  (error: unknown): void => {
    globalThis.fetch = fetchOriginal;
    console.error(error);
    app.exit(1);
  },
);

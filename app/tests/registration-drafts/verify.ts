import assert from 'node:assert/strict';
import { verifySubmissionRecovery } from './submission';
import { RegistrationDraftController } from '@renderer/features/review-source-notifications/model/RegistrationDraftController';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RegistrationDraftService } from '../../src/main/backend/RegistrationDraftService';
import { ProtectedRecoveryStore } from '../../src/main/backend/ProtectedRecoveryStore';
import { RecoveryService } from '../../src/main/backend/RecoveryService';
import { createWikiBridge } from '../../src/shared/createWikiBridge';
import {
  REGISTRATION_DRAFT_CHANNELS,
  registrationDraftGetSchema,
  registrationDraftSaveSchema,
  registrationDraftClearSchema,
} from '@contracts/registrationDrafts.contract';
import type {
  RecoveryRequest,
  RecoveryResult,
} from '@contracts/recovery.contract';
import type {
  ConnectionService,
  AnalysisContext,
} from '../../src/main/backend/ConnectionService';
import type { ConnectionCipher } from '../../src/main/backend/ProtectedConnectionStore';
import type {
  RegistrationDraft,
  RegistrationDraftGetRequest,
  RegistrationDraftResult,
  RegistrationDraftSaveRequest,
  RegistrationDraftClearRequest,
} from '@contracts/registrationDrafts.contract';

const root = await mkdtemp('/private/tmp/wiki-registration-draft-data-');
const revision = 'a'.repeat(64);
const key = randomBytes(32);
let rejectProtection = false;
let failEncryption = 0;
let beforeEncrypt: (() => void) | null = null;
// 제품 OS 키 대신 격리 AES 키로 실제 디스크 보존·암호화·CAS를 검증합니다.
const cipher: ConnectionCipher = {
  availability: async (): ReturnType<ConnectionCipher['availability']> =>
    rejectProtection
      ? { availability: 'session_only', backend: 'unsafe_fallback' }
      : { availability: 'protected', backend: 'macos_keychain' },
  encrypt: async (plain: string): Promise<Buffer> => {
    assert.equal(plain.includes('AUTH-TOKEN-MUST-NOT-BE-SAVED'), false);
    beforeEncrypt?.();
    if (failEncryption > 0 && --failEncryption === 0)
      throw new Error('simulated write failure');
    const iv = randomBytes(12);
    const encoder = createCipheriv('aes-256-gcm', key, iv);
    const bytes = Buffer.concat([encoder.update(plain), encoder.final()]);
    return Buffer.concat([iv, encoder.getAuthTag(), bytes]);
  },
  decrypt: async (bytes: Buffer): Promise<string> => {
    const decoder = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decoder.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decoder.update(bytes.subarray(28)),
      decoder.final(),
    ]).toString();
  },
};
const original: AnalysisContext = {
  active: {
    status: 'connected',
    connectionId: 'first-connection',
    serverUrl: 'http://127.0.0.1:18766/api/v1/',
    userId: 'draft-author',
    policyRevision: revision,
    accessRevision: 'access-first',
    workspaces: [
      {
        id: 'draft-space',
        permissions: ['read', 'source_write'],
        defaultProfile: 'default',
        profiles: [{ id: 'default', domain: null, viewpoint: null }],
      },
    ],
    selection: { tenant: 'draft-space', profile: 'default' },
    checkedAt: new Date().toISOString(),
  },
  token: 'AUTH-TOKEN-MUST-NOT-BE-SAVED',
  generation: 1,
  selection: { tenant: 'draft-space', profile: 'default' },
};
let context = original;
let allowed = true;
const connection: Pick<
  ConnectionService,
  'analysisContext' | 'isAnalysisCurrent' | 'getState'
> = {
  analysisContext: async (
    connectionId: string,
  ): ReturnType<ConnectionService['analysisContext']> =>
    allowed && connectionId === context.active.connectionId
      ? context
      : {
          ok: false,
          error: { code: 'connection_changed', message: '연결 변경' },
        },
  isAnalysisCurrent: (candidate: AnalysisContext): boolean =>
    allowed && candidate === context,
  getState: (): ReturnType<ConnectionService['getState']> => ({
    ok: true,
    data: context.active,
  }),
};

/** 재시작마다 서비스와 저장소를 새로 만들되 암호화 디렉터리를 공유합니다. */
function service(directory: string = root): RegistrationDraftService {
  return new RegistrationDraftService(
    new RecoveryService(
      connection,
      new ProtectedRecoveryStore(directory, cipher, 4096),
    ),
  );
}
/** 실제 현재 인증 범위로 요청하며 source/conversion 식별자는 변경하지 않습니다. */
function request(): RegistrationDraftGetRequest {
  return {
    connectionId: context.active.connectionId,
    expectedScope: {
      userId: context.active.userId,
      tenant: context.selection.tenant,
      profileId: context.selection.profile,
      policyRevision: context.active.policyRevision,
      accessRevision: context.active.accessRevision,
    },
    workflowId: '1'.repeat(32),
    sourceRef: {
      source_id: '2'.repeat(32),
      source_version: '3'.repeat(32),
      source_sha256: revision,
      registration_revision: revision,
    },
    conversionRef: {
      conversion_id: '4'.repeat(32),
      conversion_revision: revision,
    },
  };
}
/** 검증 실패에서 데이터를 단언하지 않고 성공 타입으로 좁힙니다. */
function data(
  result: RegistrationDraftResult,
): Extract<RegistrationDraftResult, { ok: true }>['data'] {
  if (!result.ok) throw new Error(result.error.code);
  return result.data;
}
/** 요청 실패 코드를 확인하되 저장된 초안 본문을 로그로 출력하지 않습니다. */
function failed(result: RegistrationDraftResult, code?: string): void {
  assert.equal(result.ok, false);
  if (!result.ok && code) assert.equal(result.error.code, code);
}
let nextId = 10;
/** 테스트 요청별 식별자는 실제 계약의 32자리 hex 형식을 사용합니다. */
function id(): string {
  return (nextId++).toString(16).padStart(32, '0');
}
const draft: RegistrationDraft = {
  basisRevision: revision,
  basisContents: { 'page:1': '원래 내용', 'page:2': '' },
  contents: {
    'page:1': '편집한 내용 😀',
    'page:2': '',
    'unit:section2': '  \n',
    whole_document: '',
  },
  blankUnits: ['page:2'],
  targetDocument: '',
  submission: {
    firstRequest: {
      requestId: 'f'.repeat(32),
      expectedRevision: revision,
      content: '',
    },
    index: 0,
    pending: null,
  },
};

try {
  await verifySubmissionRecovery();
  let writer = service();
  assert.equal(data(await writer.get(request())).draft, null);
  const first: RegistrationDraftSaveRequest = {
    ...request(),
    draft,
    expectedRevision: null,
    requestId: id(),
  };
  const saved = data(await writer.save(first));
  assert.deepEqual(saved.draft, draft);
  assert.ok(saved.revision);
  assert.deepEqual(data(await writer.save(first)), saved);
  failed(
    await writer.save({
      ...first,
      draft: { ...draft, targetDocument: 'changed.md' },
    }),
    'registration_draft_request_conflict',
  );

  context = {
    ...original,
    active: { ...original.active, connectionId: 'restarted-connection' },
  };
  writer = service();
  assert.deepEqual(data(await writer.get(request())).draft, draft);
  const restartedFirst = { ...first, ...request() };
  assert.deepEqual(data(await writer.save(restartedFirst)).draft, draft);
  failed(
    await writer.save({
      ...request(),
      draft: { ...draft, basisRevision: 'b'.repeat(64) },
      expectedRevision: saved.revision,
      requestId: id(),
    }),
    'registration_draft_basis_conflict',
  );
  failed(
    await writer.save({
      ...request(),
      draft: { ...draft, basisContents: {} },
      expectedRevision: saved.revision,
      requestId: id(),
    }),
    'registration_draft_basis_conflict',
  );
  for (const changed of [
    { ...request(), workflowId: '9'.repeat(32) },
    {
      ...request(),
      sourceRef: { ...request().sourceRef, source_version: '9'.repeat(32) },
    },
    {
      ...request(),
      conversionRef: {
        conversion_id: '9'.repeat(32),
        conversion_revision: revision,
      },
    },
  ])
    assert.equal(data(await writer.get(changed)).draft, null);

  const ownContext = context;
  const ownRequest = request();
  context = {
    ...ownContext,
    active: { ...ownContext.active, userId: 'another-account' },
  };
  failed(await writer.get(ownRequest), 'scope_changed');
  assert.equal(data(await writer.get(request())).draft, null);
  context = {
    ...ownContext,
    active: {
      ...ownContext.active,
      workspaces: [
        {
          ...ownContext.active.workspaces[0]!,
          profiles: [
            {
              id: 'default',
              domain: 'another-domain',
              viewpoint: 'another-view',
            },
          ],
        },
      ],
    },
  };
  assert.equal(data(await writer.get(request())).draft, null);
  context = {
    ...ownContext,
    active: { ...ownContext.active, accessRevision: 'revoked-access' },
  };
  failed(await writer.get(ownRequest), 'scope_changed');
  assert.equal(data(await writer.get(request())).draft, null);
  context = ownContext;
  assert.deepEqual(data(await writer.get(request())).draft, draft);

  const otherWindow = service();
  const competing = await Promise.all([
    writer.save({
      ...request(),
      draft: { ...draft, targetDocument: 'one.md' },
      expectedRevision: saved.revision,
      requestId: id(),
    }),
    otherWindow.save({
      ...request(),
      draft: { ...draft, targetDocument: 'two.md' },
      expectedRevision: saved.revision,
      requestId: id(),
    }),
  ]);
  assert.equal(
    competing.filter((result: RegistrationDraftResult): boolean => result.ok)
      .length,
    1,
  );
  const latest = data(await service().get(request()));
  assert.ok(
    latest.draft?.targetDocument === 'one.md' ||
      latest.draft?.targetDocument === 'two.md',
  );
  failed(
    await writer.clear({
      ...request(),
      expectedRevision: saved.revision,
      requestId: id(),
      reason: 'registered',
    }),
    'recovery_conflict',
  );
  const close = {
    ...request(),
    expectedRevision: latest.revision,
    requestId: id(),
    reason: 'registered' as const,
  };
  const closed = data(await writer.clear(close));
  assert.equal(closed.draft, null);
  assert.equal(closed.cleared, 'registered');
  assert.deepEqual(data(await service().clear(close)), closed);
  failed(
    await writer.save({
      ...request(),
      draft,
      expectedRevision: latest.revision,
      requestId: id(),
    }),
    'recovery_conflict',
  );
  failed(
    await writer.save({
      ...request(),
      draft,
      expectedRevision: null,
      requestId: id(),
    }),
    'recovery_conflict',
  );
  failed(
    await service().save({
      ...request(),
      draft,
      expectedRevision: closed.revision,
      requestId: id(),
    }),
    'registration_draft_closed',
  );

  const separate = { ...request(), workflowId: '8'.repeat(32) };
  const discarded = data(
    await writer.clear({
      ...separate,
      expectedRevision: null,
      requestId: id(),
      reason: 'discarded',
    }),
  );
  failed(
    await writer.save({
      ...separate,
      draft,
      expectedRevision: null,
      requestId: id(),
    }),
    'recovery_conflict',
  );
  const reopened = data(
    await writer.save({
      ...separate,
      draft,
      expectedRevision: discarded.revision,
      requestId: id(),
    }),
  );
  assert.deepEqual(reopened.draft, draft);

  failEncryption = 2; // 조각 저장 뒤 manifest 쓰기에서 실패해야 이전 초안이 유지됩니다.
  failed(
    await writer.save({
      ...separate,
      draft: { ...draft, targetDocument: 'failed.md' },
      expectedRevision: reopened.revision,
      requestId: id(),
    }),
    'recovery_write_failed',
  );
  assert.deepEqual(data(await service().get(separate)), reopened);
  beforeEncrypt = (): void => {
    allowed = false;
    beforeEncrypt = null;
  };
  failed(
    await writer.save({
      ...separate,
      draft: { ...draft, targetDocument: 'late.md' },
      expectedRevision: reopened.revision,
      requestId: id(),
    }),
    'scope_changed',
  );
  allowed = true;
  assert.deepEqual(data(await service().get(separate)), reopened);

  const raceRequest = { ...request(), workflowId: '6'.repeat(32) };
  const raceSaved = data(
    await writer.save({
      ...raceRequest,
      draft,
      expectedRevision: null,
      requestId: id(),
    }),
  );
  const recovery = new RecoveryService(
    connection,
    new ProtectedRecoveryStore(root, cipher, 4096),
  );
  let releaseManifest: () => void = (): void => {};
  let reachedManifest: () => void = (): void => {};
  const release = new Promise<void>((resolve: () => void): void => {
    releaseManifest = resolve;
  });
  const reached = new Promise<void>((resolve: () => void): void => {
    reachedManifest = resolve;
  });
  const delayed = new RegistrationDraftService({
    execute: async (input: RecoveryRequest): Promise<RecoveryResult> => {
      if (input.operation === 'put' && input.key.length === 64) {
        reachedManifest();
        await release;
      }
      return recovery.execute(input);
    },
  });
  const lateSave = delayed.save({
    ...raceRequest,
    draft: { ...draft, targetDocument: 'late-autosave.md' },
    expectedRevision: raceSaved.revision,
    requestId: id(),
  });
  await reached;
  const raceClosed = data(
    await writer.clear({
      ...raceRequest,
      expectedRevision: raceSaved.revision,
      requestId: id(),
      reason: 'registered',
    }),
  );
  releaseManifest();
  failed(await lateSave, 'recovery_conflict');
  assert.deepEqual(data(await service().get(raceRequest)), raceClosed);
  assert.deepEqual(data(await service().get(separate)), reopened);

  rejectProtection = true;
  const unsafeDirectory = join(root, 'unsafe');
  failed(
    await service(unsafeDirectory).save({
      ...request(),
      draft,
      expectedRevision: null,
      requestId: id(),
    }),
    'recovery_unavailable',
  );
  assert.equal((await readdir(root)).includes('unsafe'), false);
  rejectProtection = false;

  const large: RegistrationDraft = {
    ...draft,
    basisContents: {},
    contents: { whole_document: '한'.repeat(4 * 1024 * 1024) + '😀끝' },
  };
  const largeRequest = { ...request(), workflowId: '7'.repeat(32) };
  const largeSaved = data(
    await writer.save({
      ...largeRequest,
      draft: large,
      expectedRevision: null,
      requestId: id(),
    }),
  );
  assert.deepEqual(data(await service().get(largeRequest)).draft, large);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 12 * 1024 * 1024);
  assert.equal(largeSaved.cleanupWarningCount, 0);

  const channels: string[] = [];
  const bridge = createWikiBridge(
    async (
      channel: string,
      ...args: unknown[]
    ): Promise<RegistrationDraftResult> => {
      channels.push(channel);
      if (channel === REGISTRATION_DRAFT_CHANNELS.get)
        return writer.get(registrationDraftGetSchema.parse(args[0]));
      if (channel === REGISTRATION_DRAFT_CHANNELS.save)
        return writer.save(registrationDraftSaveSchema.parse(args[0]));
      if (channel === REGISTRATION_DRAFT_CHANNELS.clear)
        return writer.clear(registrationDraftClearSchema.parse(args[0]));
      throw new Error('unexpected channel');
    },
  ).registrationDrafts;
  assert.ok(bridge);
  const bridgeRequest = { ...request(), workflowId: '5'.repeat(32) };
  assert.equal(data(await bridge.get(bridgeRequest)).draft, null);
  const bridgeSaved = data(
    await bridge.save({
      ...bridgeRequest,
      draft,
      expectedRevision: null,
      requestId: id(),
    }),
  );
  assert.equal(
    data(
      await bridge.clear({
        ...bridgeRequest,
        expectedRevision: bridgeSaved.revision,
        requestId: id(),
        reason: 'discarded',
      }),
    ).cleared,
    'discarded',
  );
  assert.deepEqual(channels, Object.values(REGISTRATION_DRAFT_CHANNELS));
  await assert.rejects(
    bridge.save({
      ...bridgeRequest,
      draft,
      expectedRevision: null,
      requestId: 'malformed',
    }),
  );
  assert.equal(channels.length, 3);
  const controllerRequest = { ...request(), workflowId: 'b'.repeat(32) };
  const controllerWrites: RegistrationDraftSaveRequest[] = [];
  const controllerClears: RegistrationDraftClearRequest[] = [];
  let loseSave = true;
  let loseClear = true;
  const controller = new RegistrationDraftController(controllerRequest, {
    get: (
      input: RegistrationDraftGetRequest,
    ): Promise<RegistrationDraftResult> => writer.get(input),
    save: async (
      input: RegistrationDraftSaveRequest,
    ): Promise<RegistrationDraftResult> => {
      controllerWrites.push(structuredClone(input));
      const result = await writer.save(input);
      if (loseSave) {
        loseSave = false;
        throw new Error('lost local write response');
      }
      return result.ok
        ? { ...result, data: { ...result.data, cleanupWarningCount: 2 } }
        : result;
    },
    clear: async (
      input: RegistrationDraftClearRequest,
    ): Promise<RegistrationDraftResult> => {
      controllerClears.push(structuredClone(input));
      const result = await writer.clear(input);
      if (loseClear) {
        loseClear = false;
        throw new Error('lost local clear response');
      }
      return result.ok
        ? { ...result, data: { ...result.data, cleanupWarningCount: 3 } }
        : result;
    },
  });
  assert.equal(await controller.read(), null);
  await assert.rejects(controller.save(draft), /lost local write response/);
  assert.equal(
    await controller.save({ ...draft, targetDocument: 'next-edit.md' }),
    4,
  );
  assert.deepEqual(controllerWrites[0], controllerWrites[1]);
  assert.notEqual(
    controllerWrites[1]?.requestId,
    controllerWrites[2]?.requestId,
  );
  await assert.rejects(
    controller.clear('registered'),
    /lost local clear response/,
  );
  assert.equal(await controller.clear('registered'), 3);
  assert.deepEqual(controllerClears[0], controllerClears[1]);
  await assert.rejects(controller.save(draft), /완료된 초안/);
  for (const name of await readdir(root, { recursive: true })) {
    if (name.endsWith('.bin'))
      assert.equal(
        (await readFile(join(root, name))).includes(Buffer.from('편집한 내용')),
        false,
      );
  }
  console.log(
    'Registration drafts: restart, original basis, empty text, request replay, scoped access, CAS race, tombstone, save failure, protection, and >12 MiB recovery passed.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

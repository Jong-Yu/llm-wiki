import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SourceVisualPreviewService } from '../../src/main/backend/SourceVisualPreviewService';
import type {
  AnalysisContext,
  ConnectionService,
} from '../../src/main/backend/ConnectionService';
import type { NotificationService } from '../../src/main/backend/NotificationService';
import { notificationDetailResultSchema } from '@contracts/notifications.contract';
import { parseSourceVersionsResult } from '@contracts/sources.contract';
import type { SourceDownloadRequest } from '@contracts/sources.contract';
import { sourceVisualPreviewRequestSchema } from '@contracts/sourceVisualPreviews.contract';
import type { SourceVisualPreviewRequest } from '@contracts/sourceVisualPreviews.contract';

const projectRoot = resolve(process.cwd(), '..');
const python = join(projectRoot, '.venv/bin/python');
const root = await mkdtemp('/private/tmp/wiki-source-preview-test-');
const generated = spawnSync(python, [
  '-c',
  'from PIL import Image; import sys; Image.new("RGB", (40, 30), "red").save(sys.stdout.buffer,format="PNG")',
]);
assert.equal(generated.status, 0);
const bytes = generated.stdout;
const sha256 = createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(64);
const sourceId = 'b'.repeat(32);
const version = 'c'.repeat(32);
const workflowId = 'd'.repeat(32);
const trace = 'e'.repeat(32);
const context: AnalysisContext = {
  active: {
    status: 'connected',
    connectionId: 'fixture',
    serverUrl: 'http://127.0.0.1:1/api/v1/',
    userId: 'tester',
    policyRevision: revision,
    workspaces: [
      {
        id: 'fixture',
        permissions: ['read', 'source_write'],
        defaultProfile: 'default',
        profiles: [{ id: 'default', domain: null, viewpoint: null }],
      },
    ],
    selection: { tenant: 'fixture', profile: 'default' },
    checkedAt: new Date().toISOString(),
  },
  token: 'AUTH-MUST-NOT-ENTER-PREVIEW-FILES',
  generation: 1,
  selection: { tenant: 'fixture', profile: 'default' },
};
const access = {
  userId: 'tester',
  tenant: 'fixture',
  profileId: 'default',
  policyRevision: revision,
  domain: null,
  viewpoint: null,
};
let allowed = true;
let registrationRevision = revision;
let scopeChanged: () => void = (): void => {};
let downloads = 0;
let catalogReads = 0;
let denyAt = 0;
let waitDownload: (() => Promise<void>) | null = null;
const connection: Pick<
  ConnectionService,
  | 'analysisContext'
  | 'isAnalysisCurrent'
  | 'onScopeChanged'
  | 'readSourceVersions'
  | 'readSourceDownload'
> = {
  analysisContext: async (): ReturnType<
    ConnectionService['analysisContext']
  > =>
    allowed
      ? context
      : { ok: false, error: { code: 'forbidden', message: '권한 회수' } },
  isAnalysisCurrent: (candidate: AnalysisContext): boolean =>
    allowed && candidate === context,
  onScopeChanged: (listener: () => void): void => {
    scopeChanged = listener;
  },
  readSourceVersions: async (): ReturnType<
    ConnectionService['readSourceVersions']
  > => {
    catalogReads += 1;
    if (denyAt === catalogReads)
      return { ok: false, error: { code: 'forbidden', message: '권한 회수' } };
    return parseSourceVersionsResult({
      ok: true,
      data: {
        connectionId: 'fixture',
        sourceId,
        title: '격리 이미지',
        currentVersion: version,
        registrationRevision,
        versions: [
          {
            sourceVersion: version,
            sourceSha256: sha256,
            sizeBytes: bytes.length,
            kind: 'file',
            format: 'png',
            filename: 'fixture.png',
            title: '격리 이미지',
            createdAt: '2026-11-25',
            actor: access,
          },
        ],
        documents: [],
        access,
        traceId: trace,
      },
    });
  },
  readSourceDownload: async (
    request: SourceDownloadRequest,
  ): ReturnType<ConnectionService['readSourceDownload']> => {
    downloads += 1;
    await waitDownload?.();
    return {
      ok: true,
      data: { ...request, bytes, text: null, access, traceId: trace },
    };
  },
};
const notifications: Pick<NotificationService, 'read'> = {
  read: async (): ReturnType<NotificationService['read']> =>
    notificationDetailResultSchema.parse({
      ok: true,
      data: {
        workflow: {
          workflow_id: workflowId,
          revision,
          source_ref: {
            source_id: sourceId,
            source_version: version,
            source_sha256: sha256,
            registration_revision: revision,
          },
          conversion_ref: null,
          title: '격리 이미지',
          target_document: null,
          state: 'review',
          pages: [],
          approval: null,
          execution: null,
          resume_request_id: trace,
          created_at: '2026-11-25',
          updated_at: '2026-11-25',
        },
        corrections: [],
        events: [],
        conversion: null,
        access: {
          user_id: 'tester',
          tenant: 'fixture',
          profile_id: 'default',
          policy_revision: revision,
        },
      },
    }),
};
const service = new SourceVisualPreviewService(connection, notifications, {
  workRoot: root,
  runtime: { projectRoot, python },
});
const request: SourceVisualPreviewRequest =
  sourceVisualPreviewRequestSchema.parse({
    connectionId: 'fixture',
    expectedScope: {
      userId: 'tester',
      tenant: 'fixture',
      profileId: 'default',
      policyRevision: revision,
    },
    workflowId,
    previewId: 'f'.repeat(32),
    page: 1,
  });
let checks = 0;
try {
  const first = await service.read(request);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.data.kind, 'image');
    assert.equal(first.data.pageCount, 1);
    assert.ok(first.data.dataUrl.startsWith('data:image/png;base64,'));
  }
  assert.equal(downloads, 1);
  const [directory] = await readdir(root);
  assert.equal((await stat(join(root, directory))).mode & 0o077, 0);
  assert.equal(
    await readFile(join(root, directory, 'work/source.png')).then(
      (value: Buffer): boolean => value.equals(bytes),
    ),
    true,
  );
  assert.equal((await readdir(join(root, directory))).includes('auth'), false);
  assert.equal(
    (
      await readFile(join(root, directory, 'preview-owner.json'), 'utf8')
    ).includes(context.token),
    false,
  );
  checks += 1;
  assert.equal((await service.read(request)).ok, true);
  assert.equal(downloads, 1);
  assert.equal((await service.read({ ...request, page: 2 })).ok, false);
  assert.equal((await readdir(root)).length, 1);
  checks += 1;
  registrationRevision = '0'.repeat(64);
  const changed = await service.read(request);
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, 'source_changed');
  assert.deepEqual(await readdir(root), []);
  registrationRevision = revision;
  checks += 1;
  catalogReads = 0;
  denyAt = 3;
  const denied = await service.read(request);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'forbidden');
  assert.deepEqual(await readdir(root), []);
  denyAt = 0;
  checks += 1;
  let unblock: () => void = (): void => {};
  let downloading: () => void = (): void => {};
  const started = new Promise<void>((done: () => void): void => {
    downloading = done;
  });
  const blocked = new Promise<void>((done: () => void): void => {
    unblock = done;
  });
  waitDownload = async (): Promise<void> => {
    downloading();
    await blocked;
  };
  const pending = service.read(request);
  await started;
  allowed = false;
  scopeChanged();
  unblock();
  assert.equal((await pending).ok, false);
  await service.stop();
  assert.deepEqual(await readdir(root), []);
  allowed = true;
  waitDownload = null;
  checks += 1;
  assert.equal((await service.read(request)).ok, true);
  await service.release('0'.repeat(32));
  assert.equal((await readdir(root)).length, 1);
  await service.release(request.previewId);
  assert.deepEqual(await readdir(root), []);
  const cancelled = service.read(request);
  await service.release(request.previewId);
  assert.equal((await cancelled).ok, false);
  assert.deepEqual(await readdir(root), []);
  checks += 1;
  console.log(
    `PASS ${checks} local preview authorization, PNG, reuse, cancellation and cleanup checks`,
  );
} finally {
  await service.stop();
  await rm(root, { recursive: true, force: true });
}

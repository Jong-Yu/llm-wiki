import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { z } from 'zod';
import { SourceRegistrationService } from '@main/backend/SourceRegistrationService';
import type { RegistrationSession } from '@main/backend/SourceRegistrationService';
import { DocumentReadService } from '@main/backend/DocumentReadService';
import { parseAccessContext } from '@contracts/connection.contract';
import type { ConnectionSnapshot } from '@contracts/connection.contract';
import { sourcesGateway } from '@renderer/platform/sources';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import {
  ImportRegistrationSession,
  registrationSession,
  retainedReplacementSession,
} from '@renderer/features/import-document-content/model/ImportRegistrationSession';
import {
  readImportReplacement,
  readImportScope,
  checkTargetExistence,
  findFreeTarget,
} from '@renderer/features/import-document-content/api/importRegistration.api';
import { initialImportValues } from '@renderer/features/import-document-content/model/importDocument.schema';
import { importProcessingSession } from '@renderer/features/import-document-content/model/importProcessingSessions';
import { targetWithNumber } from '@renderer/features/import-document-content/model/importTargetName';
import { verifyResumableConversion } from './conversion-parts';

const root = process.env.WIKI_REPLACEMENT_ROOT ?? '';
assert.equal(dirname(root), '/private/tmp');
assert.ok(basename(root).startsWith('wiki-source-replacement-'));
const fixture: unknown = JSON.parse(
  await readFile(join(root, 'fixture.json'), 'utf8'),
);
const token = z.object({ token: z.string() }).parse(fixture).token;
const access = parseAccessContext({
  data: fixture,
  meta: { trace_id: 'a'.repeat(32) },
});
const connected: Extract<ConnectionSnapshot, { status: 'connected' }> = {
  ...access,
  status: 'connected',
  connectionId: 'replacement-test',
  serverUrl: `${process.env.WIKI_REPLACEMENT_URL}/api/v1/`,
  displayName: '교체 격리 검증',
  checkedAt: new Date().toISOString(),
  selection: { tenant: 'sdv-platform', profile: 'default' },
};
const session: RegistrationSession = {
  ...connected,
  token,
  generation: 1,
  selection: { tenant: 'sdv-platform', profile: 'default' },
};
let selected: string | null = null;
const service = new SourceRegistrationService(
  () => session,
  () => {},
  async () => ({
    canceled: selected === null,
    filePaths: selected ? [selected] : [],
  }),
);
connectionGateway.getState = async () => ({ ok: true, data: connected });
sourcesGateway.chooseFile = (request) => service.chooseFile(request);
sourcesGateway.versions = (request) => service.versions(request);
sourcesGateway.receipt = (request) => service.receipt(request);
let writes = 0;
let loseResponse = false;
sourcesGateway.register = async (request) => {
  writes++;
  const result = await service.register(request);
  if (loseResponse && result.ok)
    throw new Error('fixture response loss after server commit');
  return result;
};
const documentReader = new DocumentReadService({
  context: () => ({
    active: connected,
    token,
    generation: 1,
    selection: session.selection,
    profile: { id: 'default', domain: null, viewpoint: null },
  }),
  isCurrent: () => true,
  disconnect: () => {},
  clearSelection: () => {},
  contentFailure: () => {},
});
documentsGateway.content = (request) =>
  documentReader.readDocumentContent(request);
const ready = await readImportScope();
assert.equal(ready.status, 'ready');
assert.ok(ready.status === 'ready');
const scope = ready.scope;
const original = await service.register({
  connectionId: scope.connectionId,
  expectedScope: {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
    accessRevision: scope.accessRevision,
  },
  kind: 'text',
  requestId: '1'.repeat(32),
  title: '교체 문서',
  format: 'txt',
  content: '이전 원본 문자 보존',
});
assert.ok(
  original.ok && original.data.state === 'complete',
  original.ok ? original.data.state : JSON.stringify(original.error),
);
const first = original.data.item;
await verifyResumableConversion(root, connected, token, scope, first);
const conversionResponse = await fetch(
  `${connected.serverUrl}tenants/sdv-platform/analysis-conversions`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      profile: 'default',
      request_id: '2'.repeat(32),
      source_ref: {
        source_id: first.sourceId,
        source_version: first.sourceVersion,
        source_sha256: first.sourceSha256,
        registration_revision: first.registrationRevision,
      },
      method: 'verbatim',
      units: [
        {
          unit_id: 'whole',
          location: { kind: 'whole' },
          content: '이전 변환 보존',
        },
      ],
      complete: false,
      unread_ranges: ['whole source: manual_review_required'],
      warnings: ['기존 경고 보존'],
    }),
  },
);
assert.equal(conversionResponse.status, 201);
const conversion = z
  .object({
    data: z
      .object({
        manifest: z.object({ id: z.string() }).passthrough(),
        revision: z.string(),
      })
      .passthrough(),
  })
  .parse(await conversionResponse.json()).data;
const preview = {
  connectionId: scope.connectionId,
  sourceId: first.sourceId,
  sourceVersion: first.sourceVersion,
  sourceSha256: first.sourceSha256,
  sizeBytes: first.sizeBytes,
  format: first.format,
};
const originalBytes = await documentReader.readSourceOriginal(preview);
assert.ok(originalBytes.ok);
const replacement = await readImportReplacement(
  scope,
  first.sourceId,
  first.sourceVersion,
);
assert.ok(replacement.ok);
const pending = registrationSession(scope, replacement.data);
assert.notEqual(pending, registrationSession(scope));
assert.equal(pending.getSnapshot().draft.content, '');
selected = join(root, 'new.md');
await writeFile(selected, '새 파일 내용');
const file = await pending.chooseFile();
assert.ok(file);
const draft = {
  ...initialImportValues(true),
  fileId: file.fileId,
  title: first.title,
  targetDocument: '교체-문서-2.md',
};
pending.updateDraft(draft);
selected = null;
assert.equal(await pending.chooseFile(), null);
assert.deepEqual(pending.getSnapshot().file, file);
selected = join(root, 'missing.md');
assert.equal(await pending.chooseFile(), null);
assert.deepEqual(pending.getSnapshot().draft, draft);
assert.deepEqual(pending.getSnapshot().file, file);
assert.equal(writes, 0);
console.log(
  'PASS canceled/failed file selection preserves old source and replacement draft without writes',
);

assert.equal(await checkTargetExistence(scope, '교체-문서.md'), 'exists');
assert.equal(
  await findFreeTarget(scope, '교체-문서', targetWithNumber),
  '교체-문서-2.md',
);
loseResponse = true;
await pending.submit(draft);
assert.ok(pending.getSnapshot().requestId);
assert.equal(pending.getSnapshot().completed, null);
await pending.submit(draft);
assert.equal(writes, 1);
assert.equal(
  retainedReplacementSession(scope, first.sourceId, first.sourceVersion),
  pending,
);
await pending.check();
const completed = pending.getSnapshot().completed;
assert.ok(completed);
assert.equal(completed.item.sourceId, first.sourceId);
assert.notEqual(completed.item.sourceVersion, first.sourceVersion);
assert.equal(writes, 1);
const versions = await service.versions({
  connectionId: scope.connectionId,
  sourceId: first.sourceId,
});
assert.ok(versions.ok);
assert.equal(versions.data.versions.length, 2);
const stillOriginal = await documentReader.readSourceOriginal(preview);
assert.ok(stillOriginal.ok);
assert.deepEqual(stillOriginal.data.bytes, originalBytes.data.bytes);
const oldConversion = await fetch(
  `${connected.serverUrl}tenants/sdv-platform/analysis-conversions/${conversion.manifest.id}?profile=default`,
  { headers: { Authorization: `Bearer ${token}` } },
);
assert.equal(oldConversion.status, 200);
const preservedConversion = z
  .object({
    data: z
      .object({
        manifest: z.object({ id: z.string() }).passthrough(),
        revision: z.string(),
      })
      .passthrough(),
  })
  .parse(await oldConversion.json()).data;
assert.deepEqual(preservedConversion.manifest, conversion.manifest);
assert.equal(preservedConversion.revision, conversion.revision);
const preservedWiki = await documentsGateway.content({
  connectionId: scope.connectionId,
  document: '교체-문서.md',
});
assert.ok(preservedWiki.ok);
assert.equal(preservedWiki.data.content, '기존 위키 보존');
console.log(
  'PASS same-source immutable replacement, original/Wiki preservation, name conflict and response-loss receipt recovery with one POST',
);

loseResponse = false;
const stale = new ImportRegistrationSession(scope, replacement.data);
selected = join(root, 'new.md');
const staleFile = await stale.chooseFile();
assert.ok(staleFile);
await stale.submit({ ...draft, fileId: staleFile.fileId });
assert.equal(stale.getSnapshot().completed, null);
assert.ok(stale.getSnapshot().error);
const after = await service.versions({
  connectionId: scope.connectionId,
  sourceId: first.sourceId,
});
assert.ok(after.ok);
assert.equal(after.data.versions.length, 2);
assert.equal(
  (await readImportReplacement(scope, first.sourceId, first.sourceVersion)).ok,
  false,
);
const oldProcessing = importProcessingSession(scope, original.data, draft);
const newProcessing = importProcessingSession(scope, completed, draft);
assert.notEqual(oldProcessing, newProcessing);
assert.equal(newProcessing.getSnapshot().conversion, null);
assert.equal(newProcessing.getSnapshot().taskId, null);
const forbidden = new ImportRegistrationSession({
  ...scope,
  canPrepare: false,
});
const before = writes;
await forbidden.submit({
  ...initialImportValues(true),
  kind: 'text',
  title: '권한',
  content: '원본만 저장 금지',
});
assert.equal(writes, before);
console.log(
  'PASS stale CAS refusal, independent new-version processing and no source-only registration',
);

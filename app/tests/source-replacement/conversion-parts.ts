import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { join, resolve } from 'node:path';
import type {
  ConnectionResult,
  ConnectionSnapshot,
} from '@contracts/connection.contract';
import type { ImportScope } from '@renderer/features/import-document-content/api/importRegistration.api';
import type { SourceRegistrationRecord } from '@contracts/sources.contract';
import { SourceConversionService } from '@main/backend/SourceConversionService';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { ProtectedRecoveryStore } from '@main/backend/ProtectedRecoveryStore';
import type { ConnectionCipher } from '@main/backend/ProtectedConnectionStore';
import { RecoveryService } from '@main/backend/RecoveryService';
import {
  readProcessJournal,
  writeProcessJournal,
} from '@main/backend/processRecovery';
import {
  conversionId,
  conversionStoredSchema,
} from '@main/backend/sourceConversionProtocol';
import { readConversionParts } from '@main/backend/sourceConversionParts';

/** 실제 main 복원·개인 CLI·격리 HTTP를 연결하되 OS 키체인은 시험용 AES로 대체한다. */
export async function verifyResumableConversion(
  root: string,
  active: Extract<ConnectionSnapshot, { status: 'connected' }>,
  token: string,
  scope: ImportScope,
  item: Extract<SourceRegistrationRecord, { state: 'complete' }>['item'],
): Promise<void> {
  const secret = randomBytes(32);
  const cipher: ConnectionCipher = {
    availability: async () => ({
      availability: 'protected',
      backend: 'macos_keychain',
    }),
    encrypt: async (plain: string): Promise<Buffer> => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', secret, iv);
      const out = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), out]);
    },
    decrypt: async (raw: Buffer): Promise<string> => {
      const c = createDecipheriv('aes-256-gcm', secret, raw.subarray(0, 12));
      c.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([c.update(raw.subarray(28)), c.final()]).toString();
    },
  };
  const context: AnalysisContext = {
    active,
    token,
    generation: 1,
    selection: { tenant: scope.tenant, profile: scope.profileId },
  };
  const connection = {
    analysisContext: async (): Promise<AnalysisContext> => context,
    isAnalysisCurrent: (): boolean => true,
    onScopeChanged: (): void => {},
    analysisAccessFailure: (): void => {},
    getState: (): ConnectionResult => ({ ok: true, data: active }),
  };
  const recovery = new RecoveryService(
    connection,
    new ProtectedRecoveryStore(join(root, 'conversion-recovery'), cipher),
  );
  const requestId = randomUUID().replaceAll('-', '');
  const source = {
    sourceId: item.sourceId,
    sourceVersion: item.sourceVersion,
    sourceSha256: item.sourceSha256,
    registrationRevision: item.registrationRevision,
  };
  const sourceRef = {
    source_id: item.sourceId,
    source_version: item.sourceVersion,
    source_sha256: item.sourceSha256,
    registration_revision: item.registrationRevision,
  };
  const units = Array.from({ length: 1001 }, (_, index: number) => ({
    unit_id: `line${index + 1}`,
    location: {
      kind: 'lines',
      start: index + 1,
      end: index + 1,
      sheet: null,
      cells: null,
    },
    content: `남길 문자 ${index + 1}`,
  }));
  const body = {
    request_id: requestId,
    source_ref: sourceRef,
    method: 'verbatim',
    complete: true,
    unread_ranges: [],
    warnings: [],
    units,
    profile: scope.profileId,
  };
  const conversion = {
    ...body,
    format: item.format,
    state: 'complete',
    origin: 'client_reported',
    coverage: 'reported_units_only',
    original_coverage: 'not_verified',
    semantic_validation: 'not_run',
    diagnostics: [],
    unit_methods: {},
  };
  const workRoot = join(root, 'conversion-work');
  const relative = 'exec-fixture/work';
  const directory = join(workRoot, relative, `conversion-${requestId}-fixture`);
  await mkdir(workRoot, { mode: 0o700 });
  await mkdir(join(workRoot, 'exec-fixture'), { mode: 0o700 });
  await mkdir(join(workRoot, relative), { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const report = JSON.stringify(body);
  const reportHash = createHash('sha256').update(report).digest('hex');
  await writeFile(join(directory, 'report.json'), report, { mode: 0o600 });
  await writeFile(
    join(directory, 'conversion.json'),
    JSON.stringify(conversion),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, 'report-owner.json'),
    JSON.stringify({
      user_id: scope.userId,
      tenant: scope.tenant,
      profile_id: scope.profileId,
      request_id: requestId,
      source_ref: sourceRef,
      report_sha256: reportHash,
    }),
    { mode: 0o600 },
  );
  // 중단 전에 첫 부분만 서버에 보관된 상황을 실제 API로 준비합니다.
  const partial = await fetch(
    `${active.serverUrl}tenants/${scope.tenant}/analysis-conversion-parts`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        request_id: createHash('sha256')
          .update(`conversion-part:${requestId}:0`)
          .digest('hex')
          .slice(0, 32),
        conversion_request_id: requestId,
        part_index: 0,
        units: units.slice(0, 1000),
      }),
    },
  );
  assert.equal(partial.status, 201);
  await writeProcessJournal(
    recovery,
    context,
    'pending-source-conversion',
    `source:${item.sourceId}:${item.sourceVersion}`,
    {
      requestId,
      source,
      resumeWorkDirectory: relative,
      reportSha256: reportHash,
    },
  );
  const options = {
    workRoot,
    projectRoot: resolve('..'),
    python: resolve('../.venv/bin/python'),
  };
  const request = {
    ...source,
    connectionId: scope.connectionId,
    expectedScope: {
      userId: scope.userId,
      tenant: scope.tenant,
      profileId: scope.profileId,
      policyRevision: scope.policyRevision,
      accessRevision: scope.accessRevision,
    },
  };
  const conversions = new SourceConversionService(
    connection,
    options,
    recovery,
  );
  const read = await conversions.read(request);
  assert.ok(read.ok && read.data);
  assert.equal(read.data.canResumeUpload, true);
  const before = await readFile(
    join(root, 'server/test-request-paths.txt'),
    'utf8',
  );
  const started = await conversions.start({
    ...request,
    ocr: 'never',
    ocrLanguage: 'eng',
  });
  assert.ok(started.ok && started.data);
  assert.equal(started.data.requestId, requestId);
  let completed = started;
  for (let count = 0; count < 150; count++) {
    await new Promise<void>((done) => setTimeout(done, 30));
    const next = await conversions.read(request);
    assert.ok(next.ok && next.data);
    completed = next;
    if (next.data.receiptState === 'saved') break;
  }
  assert.ok(completed.ok && completed.data);
  const confirmed = await fetch(
    `${active.serverUrl}tenants/${scope.tenant}/analysis-conversions/${conversionId(scope.tenant, scope.userId, requestId)}?profile=${scope.profileId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(
    confirmed.status,
    200,
    JSON.stringify(completed.data.diagnosticCodes),
  );
  await readConversionParts(
    conversionStoredSchema.parse(await confirmed.json()).data,
    async (partId: string): Promise<unknown> => {
      const part = await fetch(
        `${active.serverUrl}tenants/${scope.tenant}/analysis-conversion-parts/${partId}?profile=${scope.profileId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return await part.json();
    },
  );
  assert.equal(completed.data.receiptState, 'saved', completed.data.message);
  assert.equal(completed.data.report?.units.length, 1001);
  assert.deepEqual(completed.data.report?.units, units);
  const after = (
    await readFile(join(root, 'server/test-request-paths.txt'), 'utf8')
  ).slice(before.length);
  assert.equal(
    after.split('\n').some((path: string): boolean => path.endsWith('/file')),
    false,
  );
  assert.equal(await readFile(join(directory, 'report.json'), 'utf8'), report);
  const restarted = new SourceConversionService(
    connection,
    options,
    new RecoveryService(
      connection,
      new ProtectedRecoveryStore(join(root, 'conversion-recovery'), cipher),
    ),
  );
  const restored = await restarted.read(request);
  assert.ok(restored.ok && restored.data);
  assert.equal(restored.data.receiptState, 'saved');
  assert.deepEqual(restored.data.report?.units, units);
  console.log(
    'PASS protected main restart → same-request report-only CLI resume → verified multipart GET; no original download or OCR',
  );
  const failedRequestId = randomUUID().replaceAll('-', '');
  const failed = await fetch(
    `${active.serverUrl}tenants/${scope.tenant}/analysis-conversions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        request_id: failedRequestId,
        units: [],
        complete: false,
        unread_ranges: ['whole source: conversion_worker_exception'],
        warnings: ['conversion_attempt_no_text'],
      }),
    },
  );
  assert.equal(failed.status, 201, await failed.text());
  const previousEntries = await readProcessJournal(
    recovery,
    context,
    'pending-source-conversion',
  );
  const previousEntry = previousEntries.find(
    (entry) => entry.key === `source:${item.sourceId}:${item.sourceVersion}`,
  );
  assert.ok(previousEntry);
  await writeProcessJournal(
    recovery,
    context,
    'pending-source-conversion',
    `source:${item.sourceId}:${item.sourceVersion}`,
    { requestId: failedRequestId, source },
    previousEntry.revision,
  );
  const failedReader = new SourceConversionService(
    connection,
    options,
    recovery,
  );
  const observed = await failedReader.read(request);
  assert.ok(observed.ok && observed.data);
  assert.equal(observed.data.state, 'failed');
  assert.equal(observed.data.receiptState, 'saved');
  assert.ok(observed.data.reference);
  assert.deepEqual(observed.data.report?.units, []);
  assert.equal(observed.data.report?.complete, false);
  console.log(
    'PASS main preserves confirmed zero-text failure and reference without marking conversion complete or partial',
  );
}

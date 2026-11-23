import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConnectionService } from '@main/backend/ConnectionService';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { ProtectedRecoveryStore } from '@main/backend/ProtectedRecoveryStore';
import { RecoveryService } from '@main/backend/RecoveryService';
import type { ConnectionCipher } from '@main/backend/ProtectedConnectionStore';
import { DocumentTaskService } from '@main/backend/DocumentTaskService';
import { SourceConversionService } from '@main/backend/SourceConversionService';
import { AnalysisService } from '@main/backend/AnalysisService';
import { writeProcessJournal } from '@main/backend/processRecovery';
import { verifyImportProcessing } from './import-processing';
import { conversionId } from '@main/backend/sourceConversionProtocol';
import type { RecoveryResult } from '@contracts/recovery.contract';
import type {
  DocumentTask,
  DocumentTaskCreateRequest,
  DocumentTaskSession,
} from '@contracts/documentTasks.contract';
import type {
  AnalysisJob,
  AnalysisStartRequest,
} from '@contracts/analysis.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';

const root = process.env.WIKI_TASK_TEST_ROOT!;
const python = process.env.WIKI_TASK_TEST_PYTHON!;
const one = '1'.repeat(32),
  two = '2'.repeat(32),
  three = '3'.repeat(32),
  revision = 'a'.repeat(64);
const privateKey = randomBytes(32);
// 운영 OS 암호화 대신 같은 프로세스의 격리 AES 키로 디스크 보존·CAS만 검증합니다.
const cipher: ConnectionCipher = {
  availability: async () => ({
    availability: 'protected',
    backend: 'macos_keychain',
  }),
  encrypt: async (plain: string): Promise<Buffer> => {
    const iv = randomBytes(12);
    const encoder = createCipheriv('aes-256-gcm', privateKey, iv);
    const encrypted = Buffer.concat([encoder.update(plain), encoder.final()]);
    return Buffer.concat([iv, encoder.getAuthTag(), encrypted]);
  },
  decrypt: async (bytes: Buffer): Promise<string> => {
    const decoder = createDecipheriv(
      'aes-256-gcm',
      privateKey,
      bytes.subarray(0, 12),
    );
    decoder.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([
      decoder.update(bytes.subarray(28)),
      decoder.final(),
    ]).toString();
  },
};
const context: AnalysisContext = {
  active: {
    status: 'connected',
    connectionId: 'connection-one',
    serverUrl: 'http://127.0.0.1:18766/api/v1/',
    userId: 'tester',
    policyRevision: revision,
    accessRevision: 'access-one',
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
  token: 'private-token-never-persist',
  generation: 1,
  selection: { tenant: 'fixture', profile: 'default' },
};
const connection = new ConnectionService();
let current = true;
connection.analysisContext = async () => context;
connection.isAnalysisCurrent = () => current;
connection.onScopeChanged = (): void => {};
connection.analysisAccessFailure = (): void => {};
const actor = {
  user_id: 'tester',
  tenant: 'fixture',
  profile_id: 'default',
  domain: null,
  viewpoint: null,
  policy_revision: revision,
  access_revision: 'access-one',
};
const item: DocumentTaskCreateRequest['item'] = {
  kind: 'source',
  sourceId: one,
  sourceVersion: two,
  sourceSha256: revision,
  registrationRevision: revision,
  title: '실제 흐름 검증 자료',
  sizeBytes: 20,
  format: 'pdf',
  linkedDocumentCount: 0,
  analysisStatus: 'not_started',
};
const project = join(root, 'runtime');
await mkdir(join(project, 'tools'), { recursive: true, mode: 0o700 });
await writeFile(
  join(project, 'tools/source_conversion_cli.py'),
  `import json, sys, time\nfrom pathlib import Path\nargs=sys.argv\ndef arg(name): return args[args.index(name)+1]\nwith open('executions.txt','a') as f: f.write('run\\n')\nprint(json.dumps({'schema_version':1,'type':'progress','stage':'convert','completed':4,'total':170,'location':'page:4'}),flush=True)\ntime.sleep(.05)\nprint(json.dumps({'schema_version':1,'type':'error','error':{'code':'worker_failed'}}),flush=True)\nprint(json.dumps({'schema_version':1,'type':'result','request_id':arg('--request-id'),'source_ref':{'source_id':arg('--source-id'),'source_version':arg('--source-version'),'source_sha256':arg('--source-sha256'),'registration_revision':arg('--registration-revision')},'state':'failed','format':'pdf','conversion':None,'error':{'code':'worker_failed'},'receipt':{'state':'not_submitted'}}),flush=True)\n`,
);
let postCount = 0;
let receiptGets = 0;
let conversionGets = 0;
let legacyReportVisible = false;
let remoteRequest: string | null = null;
let remoteDocument = 'saved.md';
let receiptVisible = true;
const fetchOriginal = globalThis.fetch;
/** 서버 쓰기 유실은 의도적으로 발생시키고 이후 GET만 같은 작업을 반환합니다. */
globalThis.fetch = async (
  input: string | URL | Request,
  options?: RequestInit,
): Promise<Response> => {
  const url = String(input);
  const envelope = (data: unknown): Response =>
    Response.json({ data, meta: { trace_id: one } });
  if (options?.method === 'POST') {
    postCount += 1;
    assert.equal(typeof options.body, 'string');
    const body = JSON.parse(String(options.body));
    remoteRequest = body.request_id;
    remoteDocument = body.document;
    throw new Error('simulated lost response after server commit');
  }
  if (url.includes('/sources/'))
    return envelope({
      source_id: one,
      title: item.title,
      current_version: two,
      registration_revision: revision,
      versions: [
        {
          source_id: one,
          source_version: two,
          source_sha256: revision,
          size_bytes: 20,
          kind: 'file',
          format: 'pdf',
          filename: 'fixture.pdf',
          title: item.title,
          created_at: new Date().toISOString(),
          actor,
        },
      ],
      documents: [],
      access: actor,
    });
  if (url.includes('/analysis-conversions/')) {
    conversionGets += 1;
    if (legacyReportVisible) {
      const requestId = 'e'.repeat(32);
      const id = conversionId('fixture', 'tester', requestId);
      assert.ok(url.includes(`/analysis-conversions/${id}`));
      return envelope({
        manifest: {
          id,
          kind: 'conversions',
          user_id: 'tester',
          tenant: 'fixture',
          request_id: requestId,
          source_ref: {
            source_id: one,
            source_version: two,
            source_sha256: revision,
            registration_revision: revision,
          },
          method: 'pdf_text',
          complete: true,
          unread_ranges: [],
          warnings: [],
          origin: 'client_reported',
          coverage: 'reported_units_only',
          original_coverage: 'not_verified',
          semantic_validation: 'not_run',
          units: [
            { unit_id: 'page1', location: { kind: 'pages', start: 1, end: 1 } },
          ],
        },
        revision,
        components: { page1: 'fixture converted text' },
        access: actor,
      });
    }
    return Response.json(
      { error: { code: 'not_found', message: 'not found' } },
      { status: 404 },
    );
  }
  if (url.includes('/requests/')) {
    receiptGets += 1;
    if (!receiptVisible)
      return Response.json(
        { error: { code: 'not_found', message: 'not found' } },
        { status: 404 },
      );
    assert.ok(remoteRequest && url.endsWith(remoteRequest));
    return envelope({
      request_id: remoteRequest,
      state: 'complete',
      job_id: three,
      access: actor,
    });
  }
  if (url.includes('/results/'))
    return envelope({
      request_id: two,
      state: 'complete',
      saved: true,
      receipt: {
        actor,
        document: remoteDocument,
        stage: 'prepare_wiki',
        source_revision: revision,
        graph_revision: null,
        state_revision: null,
        bundle_id: two,
        bundle_revision: revision,
        review_status: 'unreviewed',
      },
      validation_report: null,
      current_output: { status: 'current' },
      cleanup_failures: [],
      access: actor,
    });
  if (url.includes('/analysis-jobs/'))
    return envelope({ ...job(), access: actor });
  throw new Error(`Unexpected fixture request: ${url}`);
};
/** Wiki 저장 성공과 추출 실패를 구분하는 서버 응답입니다. */
function job(): AnalysisJob {
  return {
    actor,
    job_id: three,
    tenant: 'fixture',
    user_id: 'tester',
    request_id: remoteRequest!,
    created_at: new Date().toISOString(),
    source_ref: {
      source_id: one,
      source_version: two,
      source_sha256: revision,
      registration_revision: revision,
      size_bytes: 20,
    },
    targets: [
      {
        document: remoteDocument,
        source_revision: revision,
        state_revision: null,
      },
    ],
    outputs: ['wiki', 'ontology'],
    state: 'claimed',
    run_id: one,
    reported_status: 'failed',
    job_revision: revision,
    events: [],
    active_input_ref: null,
    analysis_basis_ref: null,
    legacy_rebase_required: false,
    lease_status: 'expired',
    lease_expires_at: null,
    basis_status: 'current',
    blockers: [],
    input_readiness: 'ready',
    result_summary: {
      status: 'partial',
      saved_count: 1,
      required_count: 2,
      results: [
        {
          request_id: two,
          stage: 'prepare_wiki',
          document: remoteDocument,
          run_id: one,
          state: 'complete',
          saved: true,
        },
      ],
    },
  };
}
/** 재접속에서 connectionId가 바뀌어도 현재 주체·권한은 그대로 전달합니다. */
function session(): DocumentTaskSession {
  return {
    connectionId: context.active.connectionId,
    expectedScope: {
      userId: context.active.userId,
      tenant: context.selection.tenant,
      profileId: context.selection.profile,
      policyRevision: context.active.policyRevision,
      accessRevision: context.active.accessRevision,
    },
  };
}
/** 새 서비스 인스턴스로 디스크 복원과 기존 실행 어댑터를 같이 검사합니다. */
function services(
  name: string = 'history',
  maxEntries: number = 4096,
): {
  tasks: DocumentTaskService;
  conversions: SourceConversionService;
  analysis: AnalysisService;
  recovery: RecoveryService;
} {
  const recovery = new RecoveryService(
    connection,
    new ProtectedRecoveryStore(join(root, name), cipher, maxEntries),
  );
  const legacy = new RecoveryService(
    connection,
    new ProtectedRecoveryStore(join(root, 'legacy'), cipher),
  );
  const tasks = new DocumentTaskService(connection, recovery);
  const conversions = new SourceConversionService(
    connection,
    { workRoot: join(root, 'conversions'), projectRoot: project, python },
    legacy,
    tasks,
  );
  const analysis = new AnalysisService(
    connection,
    legacy,
    join(root, 'analysis'),
    tasks,
  );
  tasks.connect({
    conversion: (request) => conversions.read(request),
    analysis: (request) => analysis.read(request),
  });
  return { tasks, conversions, analysis, recovery };
}
/** 실제 자식 프로세스의 종료를 기다리되 조회 중 재실행을 허용하지 않습니다. */
async function finished(
  conversions: SourceConversionService,
  task: DocumentTask,
): Promise<SourceConversionRun> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await conversions.read({
      ...session(),
      ...task.source,
      taskId: task.taskId,
    });
    assert.ok(result.ok && result.data);
    if (result.data.state !== 'running') return result.data;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('conversion did not finish');
}

try {
  let runtime = services();
  const requests = await Promise.all([
    runtime.tasks.create({ ...session(), item, targetDocument: 'first.md' }),
    runtime.tasks.create({ ...session(), item, targetDocument: 'first.md' }),
  ]);
  assert.ok(requests[0].ok && requests[1].ok);
  const first = requests[0].data;
  assert.equal(first.taskId, requests[1].data.taskId);
  assert.equal(postCount, 0);
  console.log(
    'PASS concurrent creation keeps one stable task and registration ID before side effects',
  );

  const started = await runtime.conversions.start({
    ...session(),
    ...first.source,
    taskId: first.taskId,
    ocr: 'auto',
    ocrLanguage: 'kor+eng',
  });
  assert.ok(started.ok && started.data);
  const failure = await finished(runtime.conversions, first);
  assert.equal(failure.state, 'failed');
  assert.deepEqual(failure.diagnosticCodes, ['worker_failed']);
  assert.equal(failure.progress?.completed, 4);
  await runtime.conversions.stop();
  context.active.connectionId = 'connection-after-restart';
  runtime = services();
  const restored = await runtime.tasks.read({
    ...session(),
    taskId: first.taskId,
  });
  assert.ok(restored.ok);
  assert.equal(restored.data.task.taskId, first.taskId);
  assert.equal(restored.data.conversion?.state, 'failed');
  assert.equal(restored.data.conversion?.progress?.total, 170);
  assert.deepEqual(restored.data.conversion?.diagnosticCodes, [
    'worker_failed',
  ]);
  assert.equal(
    (await readFile(join(project, 'executions.txt'), 'utf8')).trim().split('\n')
      .length,
    1,
  );
  assert.equal(conversionGets, 0);
  console.log(
    'PASS failed converter progress and diagnostic survive new main/connection without GET or auto execution',
  );

  assert.ok(
    (
      await runtime.conversions.start({
        ...session(),
        ...first.source,
        taskId: first.taskId,
        ocr: 'auto',
        ocrLanguage: 'kor+eng',
      })
    ).ok,
  );
  await finished(runtime.conversions, first);
  await runtime.conversions.stop();
  const attempts = await runtime.tasks.list(session());
  assert.ok(attempts.ok);
  assert.equal(attempts.data.items[0]?.conversions.length, 2);
  assert.equal(
    attempts.data.items[0]?.conversions[0]?.requestId,
    started.data.requestId,
  );
  const other = await runtime.tasks.create({
    ...session(),
    item,
    targetDocument: 'other.md',
  });
  assert.ok(other.ok);
  const isolated = await runtime.conversions.read({
    ...session(),
    ...other.data.source,
    taskId: other.data.taskId,
  });
  assert.ok(isolated.ok);
  assert.equal(isolated.data, null);
  console.log(
    'PASS explicit retry keeps both attempts; same source in another task never adopts the latest conversion',
  );

  const unknown = {
    ...failure,
    requestId: 'f'.repeat(32),
    state: 'running' as const,
    receiptState: 'pending' as const,
  };
  await runtime.tasks.observeConversion(context, other.data.taskId, unknown);
  runtime = services();
  const uncertain = await runtime.tasks.read({
    ...session(),
    taskId: other.data.taskId,
  });
  assert.ok(uncertain.ok);
  assert.equal(uncertain.data.conversion?.state, 'report_unconfirmed');
  const prevented = await runtime.conversions.start({
    ...session(),
    ...other.data.source,
    taskId: other.data.taskId,
    ocr: 'auto',
    ocrLanguage: 'kor+eng',
  });
  assert.equal(prevented.ok, false);
  assert.ok(!prevented.ok && prevented.error.code === 'report_unconfirmed');
  assert.equal(
    (await readFile(join(project, 'executions.txt'), 'utf8')).trim().split('\n')
      .length,
    2,
  );
  console.log(
    'PASS interrupted unknown submission stays unconfirmed and blocks another converter process',
  );

  const registered = await runtime.tasks.create({
    ...session(),
    item,
    targetDocument: 'saved.md',
  });
  assert.ok(registered.ok);
  const registration: AnalysisStartRequest = {
    connectionId: context.active.connectionId,
    ...registered.data.source,
    taskId: registered.data.taskId,
    targetDocument: 'saved.md',
    registration: {
      requestId: registered.data.registration.requestId,
      title: item.title,
    },
    outputs: ['wiki', 'ontology'],
  };
  assert.equal((await runtime.analysis.start(registration)).ok, false);
  assert.equal(postCount, 1);
  runtime = services();
  const reconciled = await runtime.tasks.read({
    ...session(),
    taskId: registered.data.taskId,
  });
  assert.ok(reconciled.ok);
  assert.equal(reconciled.data.task.registration.jobId, three);
  assert.equal(reconciled.data.analysis?.job.result_summary.status, 'partial');
  assert.equal(reconciled.data.analysis?.receipts[0]?.saved, true);
  assert.equal(postCount, 1);
  assert.ok(receiptGets > 0);
  const reread = await runtime.tasks.read({
    ...session(),
    taskId: registered.data.taskId,
  });
  assert.ok(reread.ok);
  assert.equal(postCount, 1);
  assert.equal(reconciled.data.task.analysisSummary?.reportedStatus, 'failed');
  console.log(
    'PASS lost analysis POST response recovers by request GET only; saved Wiki and extraction failure remain distinct',
  );

  const mismatched = await runtime.conversions.start({
    ...session(),
    ...first.source,
    sourceSha256: 'b'.repeat(64),
    taskId: first.taskId,
    ocr: 'auto',
    ocrLanguage: 'kor+eng',
  });
  assert.equal(mismatched.ok, false);
  const oldScope = session();
  context.active.userId = 'another-user';
  assert.equal((await runtime.tasks.list(oldScope)).ok, false);
  const another = await runtime.tasks.list(session());
  assert.ok(another.ok);
  assert.equal(another.data.items.length, 0);
  context.active.userId = 'tester';
  context.active.accessRevision = 'changed-access';
  const inaccessible = await runtime.tasks.list(session());
  assert.ok(inaccessible.ok);
  assert.equal(inaccessible.data.items.length, 0);
  context.active.accessRevision = 'access-one';
  context.selection.profile = 'another-profile';
  context.active.workspaces[0]!.profiles.push({
    id: 'another-profile',
    domain: null,
    viewpoint: null,
  });
  const differentProfile = await runtime.tasks.list(session());
  assert.ok(differentProfile.ok);
  assert.equal(differentProfile.data.items.length, 0);
  context.selection.profile = 'default';
  console.log(
    'PASS exact source hash, user, access revision, and profile isolation',
  );

  const small = services('capacity', 1);
  const kept = await small.tasks.create({
    ...session(),
    item,
    targetDocument: 'capacity-one.md',
  });
  assert.ok(kept.ok);
  const directory = join(
    root,
    'capacity',
    (await readdir(join(root, 'capacity')))[0]!,
  );
  const file = join(
    directory,
    (await readdir(directory)).find((name) => name.endsWith('.bin'))!,
  );
  const before = await readFile(file);
  const denied = await small.tasks.create({
    ...session(),
    item,
    targetDocument: 'capacity-two.md',
  });
  assert.ok(!denied.ok && denied.error.code === 'task_storage_full');
  assert.deepEqual(await readFile(file), before);
  const plain = await cipher.decrypt(before);
  assert.ok(!plain.includes(context.token));
  assert.ok(!plain.includes('content'));
  console.log(
    'PASS capacity failure preserves prior ciphertext and blocks acceptance; task index contains no credentials or source body',
  );

  const bad = {
    ...session(),
    expectedScope: { ...session().expectedScope, tenant: 'wrong' },
  };
  assert.equal(
    (await runtime.tasks.read({ ...bad, taskId: first.taskId })).ok,
    false,
  );
  current = false;
  assert.equal((await runtime.tasks.list(session())).ok, false);
  current = true;
  console.log('PASS stale scope and late response suppression');

  const legacy = new RecoveryService(
    connection,
    new ProtectedRecoveryStore(join(root, 'legacy'), cipher),
  );
  await writeProcessJournal(
    legacy,
    context,
    'pending-source-conversion',
    `source:${one}:${two}`,
    { requestId: 'e'.repeat(32), source: first.source },
  );
  const upgraded = await runtime.tasks.create({
    ...session(),
    item,
    targetDocument: 'upgraded.md',
  });
  assert.ok(upgraded.ok);
  const legacyBlocked = await runtime.conversions.start({
    ...session(),
    ...upgraded.data.source,
    taskId: upgraded.data.taskId,
    ocr: 'auto',
    ocrLanguage: 'kor+eng',
  });
  assert.ok(
    !legacyBlocked.ok && legacyBlocked.error.code === 'report_unconfirmed',
  );
  assert.equal(
    (await readFile(join(project, 'executions.txt'), 'utf8')).trim().split('\n')
      .length,
    2,
  );
  console.log(
    'PASS new task address cannot bypass a pre-upgrade unconfirmed source conversion guard',
  );

  const beforeLegacy = await legacy.readContext(
    context,
    'pending-source-conversion',
  );
  assert.ok(beforeLegacy.ok);
  const notYet = await runtime.tasks.read({
    ...session(),
    taskId: upgraded.data.taskId,
  });
  assert.ok(notYet.ok);
  assert.equal(notYet.data.task.conversions.length, 1);
  assert.equal(notYet.data.conversion?.requestId, 'e'.repeat(32));
  assert.equal(notYet.data.conversion?.state, 'report_unconfirmed');
  const postsBeforeRead = postCount;
  legacyReportVisible = true;
  const nowKnown = await runtime.tasks.read({
    ...session(),
    taskId: upgraded.data.taskId,
  });
  assert.ok(nowKnown.ok);
  assert.equal(nowKnown.data.conversion?.state, 'complete');
  assert.equal(nowKnown.data.conversion?.receiptState, 'saved');
  assert.equal(nowKnown.data.task.conversions.length, 1);
  assert.equal(nowKnown.data.task.conversions[0]?.requestId, 'e'.repeat(32));
  assert.equal(postCount, postsBeforeRead);
  const afterLegacy = await legacy.readContext(
    context,
    'pending-source-conversion',
  );
  assert.deepEqual(afterLegacy, beforeLegacy);
  assert.equal(
    (await readFile(join(project, 'executions.txt'), 'utf8')).trim().split('\n')
      .length,
    2,
  );
  legacyReportVisible = false;
  console.log(
    'PASS task read adopts only the exact legacy request and resolves its report by GET without modifying the old guard or executing',
  );

  // 구 guard는 격리 검사에서만 성공한 정리로 제거하고 진행 저장 실패를 주입합니다.
  const legacyEntries = await legacy.readContext(
    context,
    'pending-source-conversion',
  );
  assert.ok(legacyEntries.ok);
  const legacyEntry = legacyEntries.data.entries[0]!;
  assert.ok(
    (
      await legacy.removeContext(
        context,
        legacyEntry.kind,
        legacyEntry.key,
        legacyEntry.revision,
      )
    ).ok,
  );
  const volatile = services('progress-failure');
  const pending = await volatile.tasks.create({
    ...session(),
    item,
    targetDocument: 'progress-failure.md',
  });
  assert.ok(pending.ok);
  const capture = volatile.recovery.capture.bind(volatile.recovery);
  let failProgress = false;
  volatile.recovery.capture = async (
    ...args: Parameters<RecoveryService['capture']>
  ): Promise<RecoveryResult> =>
    failProgress
      ? {
          ok: false,
          error: { code: 'recovery_too_large', message: 'simulated full' },
        }
      : capture(...args);
  assert.ok(
    (
      await volatile.conversions.start({
        ...session(),
        ...pending.data.source,
        taskId: pending.data.taskId,
        ocr: 'auto',
        ocrLanguage: 'kor+eng',
      })
    ).ok,
  );
  failProgress = true;
  const warned = await finished(volatile.conversions, pending.data);
  await volatile.conversions.stop();
  const warnedAgain = await volatile.conversions.read({
    ...session(),
    ...pending.data.source,
    taskId: pending.data.taskId,
  });
  assert.ok(
    warnedAgain.ok && warnedAgain.data?.historyWarning?.includes('저장 공간'),
  );
  assert.equal(warned.state, 'failed');
  const unconfirmedRestart =
    await services('progress-failure').tasks.list(session());
  assert.ok(unconfirmedRestart.ok);
  assert.equal(
    unconfirmedRestart.data.items[0]?.conversions[0]?.state,
    'report_unconfirmed',
  );
  console.log(
    'PASS late history capacity error is visible and restart does not display a dead process as running',
  );
  assert.ok(reconciled.data.analysis);
  await verifyImportProcessing(first, failure, reconciled.data.analysis, {
    connectionId: context.active.connectionId,
    ...session().expectedScope,
  });
  console.log('12 backend and processing workflow checks passed');
} finally {
  globalThis.fetch = fetchOriginal;
}

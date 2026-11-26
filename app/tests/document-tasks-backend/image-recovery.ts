import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { SourceImageRecoveryService } from '@main/backend/SourceImageRecoveryService';
import type { ImageRecoveryInput } from '@main/backend/SourceImageRecoveryService';
import {
  createPrivateExecution,
  runPersonalCommand,
} from '@main/backend/personalProcess';
import type {
  PersonalRuntime,
  PrivateExecution,
} from '@main/backend/personalProcess';
import type { PersonalAi } from '@main/backend/personalAi';

/** 합성 CLI와 실제 보호 실행기를 함께 사용해 외부 호출 없이 결과·취소·토큰 경계를 검사합니다. */
export async function verifyImageRecovery(
  context: AnalysisContext,
  root: string,
  python: string,
): Promise<void> {
  const project = join(root, 'image-recovery-runtime');
  const privateRoot = join(root, 'image-recovery-private');
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(
    join(project, 'tools/source_image_recovery_cli.py'),
    `
import json, pathlib, stat, sys, time
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
assert args['--ai-provider'] == 'claude'
assert args['--ai-cli'] == '/synthetic/claude'
assert args['--ai-model'] == 'fixture-model'
assert args['--timeout'] == '240'
assert '--submit' not in sys.argv
request = pathlib.Path(args['--request-file'])
assert stat.S_IMODE(request.stat().st_mode) == 0o600
value = json.loads(request.read_text())
assert all(u['content'].startswith('보관한 슬라이드') for u in value['units'])
assert pathlib.Path(args['--token-file']).read_text()
pathlib.Path(args['--work-dir'], 'original').write_text('preserved')
pathlib.Path('started').write_text('ready')
mode = pathlib.Path('mode').read_text()
if mode == 'output-limit':
    print('a' * (33 * 1024 * 1024), flush=True)
    raise SystemExit(0)
if mode == 'supervised-cancel':
    import asyncio, os, tempfile
    sys.path.insert(0, ${JSON.stringify(resolve('..'))})
    from core.client.ai.codex import _execute
    from core.client.source_image_recovery import _supervise
    child_code = r"""
import os, pathlib, signal, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
while True:
    with pathlib.Path(sys.argv[2]).open('a') as heartbeat: heartbeat.write('beat\\n')
    time.sleep(.05)
"""
    async def operation():
        with tempfile.TemporaryDirectory(prefix='candidate-original-', dir=args['--work-dir']) as temporary:
            original = pathlib.Path(temporary, 'source.pptx')
            original.write_bytes(b'synthetic private original')
            pathlib.Path('temporary-original').write_text(str(original))
            await _execute([sys.executable, '-B', '-c', child_code, str(pathlib.Path('child-pid').absolute()), str(pathlib.Path('heartbeat').absolute())],
                directory=pathlib.Path.cwd(), environment=dict(os.environ), timeout=30)
    try:
        asyncio.run(_supervise(operation(), pathlib.Path(args['--cancel-file']), 30))
    except Exception:
        print(json.dumps(dict(schema_version=1, type='error', ok=False, error=dict(code='image_recovery_cancelled'))), flush=True)
        raise SystemExit(1)
    raise AssertionError('Cancellation must stop the supervised child')
if mode == 'wait':
    while not pathlib.Path(args['--cancel-file']).exists(): time.sleep(.01)
    raise SystemExit(130)
units = [dict(unit_id=u['unit_id'], content='복구한 문자', warnings=['candidate']) for u in value['units']]
if mode == 'wrong-id': units[0]['unit_id'] = 'foreign'
if mode == 'missing': units.pop()
if mode == 'duplicate-unit': units.append(units[0])
if mode == 'empty': units[0]['content'] = ' '
if mode == 'unit-limit': units[0]['content'] = '한' * 1500000
if mode == 'total-limit':
    for u in units: u['content'] = 'a' * (4 * 1024 * 1024)
if mode == 'wrong-source': value['source_ref']['source_sha256'] = '0' * 64
if mode == 'wrong-conversion': value['conversion_ref']['conversion_revision'] = '0' * 64
if mode == 'error':
    print(json.dumps(dict(schema_version=1, type='error', ok=False, error=dict(code='ai_unavailable'))))
    print('private raw stderr secret', file=sys.stderr)
    raise SystemExit(1)
result = dict(schema_version=1, type='result', ok=True, source_ref=value['source_ref'], conversion_ref=value['conversion_ref'], units=units, warnings=[], provider='codex' if mode == 'wrong-provider' else 'claude', model='fixture-model')
if mode == 'full-warnings': result['warnings'] = ['warning-' + str(i) for i in range(100)]
print(json.dumps(result, ensure_ascii=False), flush=True)
if mode == 'duplicate-terminal': print(json.dumps(result), flush=True)
if mode == 'invalid': print('private raw failure must never be shown', flush=True)
if mode == 'exit-error': raise SystemExit(1)
`,
  );
  const source = {
    source_id: 'a'.repeat(32),
    source_version: 'b'.repeat(32),
    source_sha256: 'c'.repeat(64),
    registration_revision: 'd'.repeat(64),
  };
  const input: ImageRecoveryInput = {
    source_ref: source,
    conversion_ref: {
      conversion_id: 'e'.repeat(32),
      conversion_revision: 'f'.repeat(64),
    },
    units: [1, 2, 3, 4, 5, 6].map(
      (slide: number): ImageRecoveryInput['units'][number] => ({
        unit_id: `slide-${slide}`,
        content: `보관한 슬라이드 ${slide} 내용`,
        location: { kind: 'slides', start: slide, end: slide },
      }),
    ),
  };
  const requestId = '1'.repeat(32);
  let current = true;
  let cleanupMode:
    | 'normal'
    | 'failure'
    | 'cancel'
    | 'scope'
    | 'stop'
    | 'failure-cancel' = 'normal';
  let lateStop: Promise<void> | null = null;
  let lateAbort: AbortController | null = null;
  let scopeChanged: () => void = (): void => {};
  const service = new SourceImageRecoveryService(
    {
      isAnalysisCurrent: (): boolean => current,
      onScopeChanged: (callback: () => void): void => {
        scopeChanged = callback;
      },
    },
    { workRoot: privateRoot, projectRoot: project, python },
    {
      selectAi: async (): Promise<PersonalAi> => ({
        provider: 'claude',
        cli: '/synthetic/claude',
        model: 'fixture-model',
      }),
      createExecution: async (
        runtime: PersonalRuntime,
        workRoot: string,
        token: string,
      ): Promise<PrivateExecution> => {
        const execution = await createPrivateExecution(
          runtime,
          workRoot,
          token,
        );
        return {
          ...execution,
          cleanupAuth: async (): Promise<void> => {
            await execution.cleanupAuth();
            if (cleanupMode === 'failure-cancel') {
              lateAbort?.abort();
              throw new Error('synthetic cleanup failure after cancellation');
            }
            if (cleanupMode === 'failure')
              throw new Error('synthetic cleanup failure');
            if (cleanupMode === 'cancel') lateAbort?.abort();
            if (cleanupMode === 'scope') current = false;
            if (cleanupMode === 'stop') lateStop = service.stop();
          },
        };
      },
    },
  );
  const mode = async (value: string): Promise<void> => {
    await writeFile(join(project, 'mode'), value);
    await writeFile(join(project, 'started'), 'pending');
  };
  const started = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await readFile(join(project, 'started'), 'utf8')) === 'ready')
        return;
      await delay(10);
    }
    throw new Error('Synthetic image recovery did not start');
  };
  await mode('success');
  const success = await service.run(context, input, requestId);
  assert.equal(success.ok, true);
  if (success.ok) {
    assert.equal(success.data.units.length, 6);
    assert.equal(success.data.units[0]?.content, '복구한 문자');
    assert.equal(success.data.provider, 'claude');
  }
  for (const value of [
    'wrong-id',
    'missing',
    'duplicate-unit',
    'empty',
    'unit-limit',
    'total-limit',
    'wrong-source',
    'wrong-conversion',
    'wrong-provider',
    'duplicate-terminal',
    'invalid',
    'exit-error',
    'error',
    'output-limit',
  ]) {
    await mode(value);
    const result = await service.run(context, input, requestId);
    assert.equal(result.ok, false, value);
    assert.ok(!JSON.stringify(result).includes('private raw'));
    if (value === 'error' && !result.ok)
      assert.equal(result.error.code, 'ai_unavailable');
  }
  await mode('wait');
  const abort = new AbortController();
  const running = service.run(context, input, requestId, abort.signal);
  await started();
  assert.equal((await service.run(context, input, requestId)).ok, false);
  abort.abort();
  const cancelled = await running;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok)
    assert.equal(cancelled.error.code, 'image_recovery_cancelled');
  await mode('wait');
  const stale = service.run(context, input, requestId);
  await started();
  current = false;
  scopeChanged();
  const changed = await stale;
  if (!changed.ok) assert.equal(changed.error.code, 'scope_changed');
  else assert.fail('Scope change must discard candidate');
  await service.stop();
  current = true;
  await mode('success');
  cleanupMode = 'failure';
  const cleanup = await service.run(context, input, requestId);
  assert.equal(cleanup.ok, true);
  if (cleanup.ok)
    assert.ok(cleanup.data.warnings.includes('private_auth_cleanup_failed'));
  await mode('full-warnings');
  const fullWarnings = await service.run(context, input, requestId);
  assert.equal(fullWarnings.ok, false);
  if (!fullWarnings.ok)
    assert.equal(fullWarnings.error.code, 'private_auth_cleanup_failed');
  await mode('success');
  cleanupMode = 'cancel';
  lateAbort = new AbortController();
  const late = await service.run(context, input, requestId, lateAbort.signal);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.error.code, 'image_recovery_cancelled');
  cleanupMode = 'scope';
  assert.equal((await service.run(context, input, requestId)).ok, false);
  current = true;
  cleanupMode = 'stop';
  const lateStopped = await service.run(context, input, requestId);
  assert.equal(lateStopped.ok, false);
  await lateStop;
  cleanupMode = 'failure-cancel';
  lateAbort = new AbortController();
  const cancelledCleanup = await service.run(
    context,
    input,
    requestId,
    lateAbort.signal,
  );
  assert.equal(cancelledCleanup.ok, false);
  if (!cancelledCleanup.ok) {
    assert.equal(cancelledCleanup.error.code, 'image_recovery_cancelled');
    assert.match(cancelledCleanup.error.message, /임시 인증 파일 정리/u);
  }
  cleanupMode = 'normal';
  current = true;
  await mode('wait');
  const stopping = service.run(context, input, requestId);
  await started();
  await service.stop();
  assert.equal((await stopping).ok, false);
  if (process.platform !== 'win32') {
    // 실제 Python 감독기와 별도 세션의 SIGTERM 무시 자식을 연결해 유예 전 강제 종료 회귀를 잡습니다.
    await mode('supervised-cancel');
    const abort = new AbortController();
    const supervised = service.run(context, input, requestId, abort.signal);
    let childPid: number | null = null;
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          const value = Number(
            await readFile(join(project, 'child-pid'), 'utf8'),
          );
          if (Number.isInteger(value) && value > 0) {
            childPid = value;
            break;
          }
        } catch {
          /* 자식이 준비되기 전에는 PID 파일이 없습니다. */
        }
        await delay(10);
      }
      assert.ok(childPid, 'SIGTERM-ignoring child must start');
      const ownedChildPid = childPid;
      const original = await readFile(
        join(project, 'temporary-original'),
        'utf8',
      );
      assert.equal(
        await readFile(original, 'utf8'),
        'synthetic private original',
      );
      abort.abort();
      const result = await supervised;
      assert.equal(result.ok, false);
      if (!result.ok)
        assert.equal(result.error.code, 'image_recovery_cancelled');
      assert.throws(
        (): void => {
          process.kill(ownedChildPid, 0);
        },
        { code: 'ESRCH' },
      );
      const heartbeat = await readFile(join(project, 'heartbeat'), 'utf8');
      assert.ok(heartbeat.length > 0);
      await delay(300);
      assert.equal(
        await readFile(join(project, 'heartbeat'), 'utf8'),
        heartbeat,
        'No child work may continue after cancellation resolves',
      );
      await assert.rejects(stat(original), { code: 'ENOENT' });
      await assert.rejects(stat(join(original, '..')), { code: 'ENOENT' });
    } finally {
      abort.abort();
      await service.stop();
      // 실패한 회귀도 이 시험이 만든 자식 그룹만 회수하여 프로세스를 남기지 않습니다.
      if (childPid !== null) {
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch (error: unknown) {
          if (
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            throw error;
        }
      }
      await supervised;
    }
  }
  for (const terminateGraceMs of [0, 999, 10_001, Infinity, 1.5]) {
    await assert.rejects(
      runPersonalCommand(
        { projectRoot: project, python },
        ['-c', 'raise AssertionError("must not launch")'],
        { maxBytes: 100, timeoutMs: 1000, terminateGraceMs },
      ),
      /invalid_termination_grace/u,
    );
  }
  for (const name of await readdir(privateRoot)) {
    await assert.rejects(stat(join(privateRoot, name, 'request.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(stat(join(privateRoot, name, 'auth')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(privateRoot, name, 'work/original'), 'utf8'),
      'preserved',
    );
  }
  await mode('success');
  assert.equal(
    (await service.run(context, { ...input, units: [] }, requestId)).ok,
    false,
  );
  for (const content of [
    '',
    '한'.repeat(1_500_000),
    'a'.repeat(4 * 1024 * 1024),
  ]) {
    const invalid = {
      ...input,
      units: input.units.map(
        (
          unit: ImageRecoveryInput['units'][number],
        ): ImageRecoveryInput['units'][number] => ({ ...unit, content }),
      ),
    };
    assert.equal((await service.run(context, invalid, requestId)).ok, false);
  }
  assert.equal(await readFile(join(project, 'started'), 'utf8'), 'pending');
}

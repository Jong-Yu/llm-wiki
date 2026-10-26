import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  symlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import ts from 'typescript';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/app/src/')) {
      const file = resolve(
        dirname(fileURLToPath(context.parentURL)),
        specifier + '.ts',
      );
      if (existsSync(file))
        return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (
      url.startsWith('file:') &&
      url.endsWith('.ts') &&
      url.includes('/app/src/')
    )
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: {
            target: ts.ScriptTarget.ES2023,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText,
      };
    return next(url, context);
  },
});
after(() => hooks.deregister());
const {
  createPrivateExecution,
  spawnPersonalProcess,
  stopPersonalProcess,
  assertPersonalRuntime,
  personalEnvironment,
} = await import('../../src/main/backend/personalProcess.ts');
const projectRoot = resolve(import.meta.dirname, '../../..');
const runtime = { projectRoot, python: join(projectRoot, '.venv/bin/python') };

void test('actual POSIX private execution cleans only its auth and preserves work and neighboring runs', async (t) => {
  const root = await mkdtemp('/private/tmp/ui_10-private-');
  t.after(() => rm(root, { recursive: true }));
  const first = await createPrivateExecution(
    runtime,
    join(root, 'private'),
    'a'.repeat(64),
  );
  const second = await createPrivateExecution(
    runtime,
    join(root, 'private'),
    'b'.repeat(64),
  );
  assert.equal((await lstat(first.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await lstat(first.directory)).mode & 0o777, 0o700);
  await writeFile(join(first.workDirectory, 'receipt.json'), '{"saved":null}');
  await first.cleanupAuth();
  assert.equal(existsSync(first.tokenFile), false);
  assert.equal(await readFile(second.tokenFile, 'utf8'), 'b'.repeat(64));
  assert.equal(
    await readFile(join(first.workDirectory, 'receipt.json'), 'utf8'),
    '{"saved":null}',
  );
  await second.cleanupAuth();
});

void test('public directory and symbolic-link root fail without chmod or writing token', async (t) => {
  const root = await mkdtemp('/private/tmp/ui_10-private-reject-');
  t.after(() => rm(root, { recursive: true }));
  await mkdir(join(root, 'public'), { mode: 0o755 });
  await assert.rejects(
    createPrivateExecution(runtime, join(root, 'public'), 'a'.repeat(64)),
    /private_directory_required/,
  );
  assert.equal((await lstat(join(root, 'public'))).mode & 0o777, 0o755);
  await symlink(join(root, 'public'), join(root, 'alias'));
  await assert.rejects(
    createPrivateExecution(runtime, join(root, 'alias'), 'a'.repeat(64)),
    /unsafe_private_path/,
  );
});

void test('actual POSIX cooperative cancel is idempotent and does not copy secrets into environment', async () => {
  process.env.WIKI_PROCESS_TEST_SECRET = 'hidden';
  try {
    assert.equal(personalEnvironment().WIKI_PROCESS_TEST_SECRET, undefined);
  } finally {
    delete process.env.WIKI_PROCESS_TEST_SECRET;
  }
  const child = spawnPersonalProcess(runtime, [
    '-B',
    '-c',
    'import json,sys\nfor line in sys.stdin:\n if json.loads(line)=={"type":"cancel"}:sys.exit(23)',
  ]);
  const closed = once(child, 'close').then(() => undefined);
  const stopping = stopPersonalProcess(child, closed, 2000);
  assert.equal(stopPersonalProcess(child, closed, 2000), stopping);
  await stopping;
  assert.equal(child.exitCode, 23);
});

void test(
  'actual POSIX timeout closes stdout inherited by a stubborn descendant and only owned group',
  { timeout: 5000 },
  async () => {
    const child = spawnPersonalProcess(runtime, [
      '-B',
      '-c',
      'import subprocess,sys,time\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\nprint(p.pid,flush=True)\ntime.sleep(30)',
    ]);
    const closed = once(child, 'close').then(() => undefined);
    await once(child.stdout, 'data');
    await stopPersonalProcess(child, closed, 50);
    assert.equal(child.signalCode, 'SIGKILL');
    await assert.rejects(
      stopPersonalProcess({ pid: process.pid }, Promise.resolve()),
      /unowned_process/,
    );
  },
);

void test('simulated Windows caller stays unavailable when the actual runtime did not pass Windows probe', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    await assert.rejects(
      assertPersonalRuntime(runtime),
      /windows_runtime_unverified/,
    );
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

void test('Windows gate requires the live probe contract, not a release-certification label (fixture)', async (t) => {
  const root = await mkdtemp('/private/tmp/ui_10-probe-contract-');
  t.after(() => rm(root, { recursive: true }));
  const moduleRoot = join(root, 'core/runtime');
  await mkdir(moduleRoot, { recursive: true });
  const capabilities = {
    private_files: true,
    process_tree: true,
    platform: 'win32',
    mechanism: 'windows_job_and_dacl',
    native_validation: 'not_certified',
    windows_app_verified: false,
    runtime_ready: true,
    probe: 'private_file_and_process_tree',
  };
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    for (const [changes, accepted] of [
      [{}, true],
      [{ native_validation: 'certified', runtime_ready: false }, false],
      [{ private_files: false }, false],
      [{ process_tree: false }, false],
      [{ platform: 'darwin' }, false],
      [{ probe: 'not_run' }, false],
    ]) {
      const result = {
        ok: true,
        capabilities: { ...capabilities, ...changes },
      };
      await writeFile(
        join(moduleRoot, 'desktop_bridge.py'),
        `import sys\nassert sys.argv[1:] == ['probe']\nprint(${JSON.stringify(JSON.stringify(result))})\n`,
      );
      const checking = assertPersonalRuntime({ ...runtime, projectRoot: root });
      if (accepted) await checking;
      else await assert.rejects(checking, /windows_runtime_unverified/);
    }
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

void test(
  'POSIX cancellation also reaps inherited pipes after group leader has exited',
  { timeout: 5000 },
  async () => {
    const child = spawnPersonalProcess(runtime, [
      '-B',
      '-c',
      'import subprocess,sys\nsubprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])',
    ]);
    const closed = once(child, 'close').then(() => undefined);
    await once(child, 'exit');
    assert.equal(child.exitCode, 0);
    await stopPersonalProcess(child, closed, 50);
  },
);

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as path from 'node:path';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import test from 'node:test';
import {
  Arch,
  CancellationToken,
  Platform,
  checkBuildRequestOptions,
} from 'app-builder-lib';
import { githubTagPrefix } from 'builder-util-runtime';
import { createReleaseWorkspace } from '../../scripts/release-workspace.mjs';
import { fixture, releaseFiles } from './fixtures.mjs';

const source = await readFile(
  new URL('../../scripts/release.mjs', import.meta.url),
  'utf8',
);

/** 실제 파일 정리 경로를 사용하고 외부 명령·AI·GitHub 요청만 격리합니다. */
async function execute(paths, scenario = {}) {
  const version = '2.4.0';
  await mkdir(join(paths.app, 'config'));
  await writeFile(join(paths.app, 'package.json'), JSON.stringify({ version }));
  await writeFile(
    join(paths.app, 'config/electron-builder.json'),
    JSON.stringify({
      directories: { output: 'ignored-build-output' },
      publish: {
        provider: 'github',
        owner: 'example',
        repo: 'release-artifacts',
        tagNamePrefix: 'ship-',
      },
    }),
  );
  await releaseFiles(join(paths.release, '2.3.0'), '2.3.0');
  const commands = [];
  const children = new Map();
  const proc = Object.assign(new EventEmitter(), {
    argv: ['node', 'release.mjs', ...(scenario.args ?? ['--mac', '--win'])],
    platform: scenario.platform ?? 'darwin',
    env: { GH_TOKEN: 'fixture-only-token' },
  });
  let work;
  let nodeChild;
  const finish = (child, code, output = '') => {
    if (child.finished) return;
    child.finished = true;
    child.stdout?.end(output);
    child.stderr?.end();
    child.emit('close', code);
  };
  proc.kill = (pid, signal) => {
    commands.push({ command: 'signal', args: [pid, signal] });
    const child = children.get(-pid);
    assert.ok(child, 'signal targets only a child owned by this run');
    queueMicrotask(() => finish(child, null));
  };
  const spawn = (command, args, options) => {
    commands.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 40000 + commands.length;
    children.set(child.pid, child);
    child.stdout = options.stdio[1] === 'pipe' ? new PassThrough() : null;
    child.stderr = options.stdio[2] === 'pipe' ? new PassThrough() : null;
    setImmediate(async () => {
      try {
        if (command === 'taskkill') {
          const target = children.get(Number(args[1]));
          assert.equal(target, nodeChild);
          finish(target, null);
          finish(child, 0);
        } else if (command === 'git') finish(child, 0, '');
        else if (command === 'gh' && args[1] === 'view') finish(child, 1);
        else if (command === 'npm' && args[1] === 'build')
          finish(child, scenario.failBuild ? 1 : 0);
        else if (command === 'npm' && args[1] === 'package:runtime') {
          assert.equal(args[4], work.output);
          await releaseFiles(work.output, version, {
            mac: false,
            win: false,
            runtime: true,
          });
          finish(child, 0);
        } else if (command === 'node') {
          nodeChild = child;
          assert.equal(args[args.indexOf('--output-dir') + 1], work.output);
          assert.equal(args[args.indexOf('--cache-dir') + 1], work.cache);
          assert.equal(args[args.indexOf('--work-dir') + 1], work.temporary);
          await writeFile(join(work.cache, 'windows-download'), 'cached');
          await releaseFiles(work.output, version, {
            mac: false,
            win: true,
            runtime: false,
          });
          if (scenario.cancelChild) {
            proc.emit('SIGTERM');
            if (scenario.repeatSignal) proc.emit('SIGINT');
          } else finish(child, scenario.failWindows ? 1 : 0);
        } else if (command === 'gh' && args[1] === 'edit') {
          assert.ok(
            (await readdir(paths.release)).some((name) =>
              name.startsWith('.publish-'),
            ),
          );
          assert.ok(
            await readFile(join(paths.release, '2.3.0/Example-2.3.0.exe')),
          );
          finish(child, scenario.failPublish ? 1 : 0);
        } else finish(child, 0);
      } catch (error) {
        child.emit('error', error);
        finish(child, 1);
      }
    });
    return child;
  };
  const context = createContext({
    process: proc,
    console: { log() {}, warn() {}, error() {} },
    AbortController,
    fetch: async (url, options) => {
      assert.equal(
        url,
        'https://api.github.com/repos/example/release-artifacts',
      );
      assert.equal(options.headers.Authorization, 'Bearer fixture-only-token');
      return { ok: true, json: async () => ({ permissions: { push: true } }) };
    },
  });
  const build = async (options, packager) => {
    checkBuildRequestOptions(options);
    assert.equal(options.config.directories.output, work.output);
    assert.equal(packager.cancellationToken.cancelled, false);
    await releaseFiles(work.output, version, {
      mac: true,
      win: false,
      runtime: false,
    });
    await writeFile(
      join(work.output, 'builder-debug.yml'),
      'diagnostic: retained',
    );
    await mkdir(join(work.output, 'mac-arm64'));
    if (scenario.cancelMac) proc.emit('SIGINT');
    return [];
  };
  const imports = {
    'node:child_process': { spawn },
    'node:fs/promises': { readFile },
    'node:path': path,
    'app-builder-lib': {
      build,
      Packager: class {
        constructor(options, token) {
          this.options = options;
          this.cancellationToken = token;
        }
      },
      CancellationToken,
      Platform,
      Arch,
    },
    'builder-util-runtime': { githubTagPrefix },
    './release-workspace.mjs': {
      createReleaseWorkspace: async (app) => {
        work = await createReleaseWorkspace(app);
        return work;
      },
    },
  };
  const module = new SourceTextModule(source, {
    context,
    initializeImportMeta(meta) {
      meta.dirname = join(paths.app, 'scripts');
    },
  });
  await module.link(async (specifier) => {
    const values = imports[specifier];
    assert.ok(values, specifier);
    return new SyntheticModule(
      Object.keys(values),
      function setImports() {
        for (const [name, value] of Object.entries(values))
          this.setExport(name, value);
      },
      { context },
    );
  });
  let error;
  try {
    await module.evaluate();
  } catch (failure) {
    error = failure;
  }
  if (work) {
    await assert.rejects(readdir(work.temporary), { code: 'ENOENT' });
    await assert.rejects(
      readFile(join(paths.root, '.local/releases/release.lock')),
      { code: 'ENOENT' },
    );
  }
  assert.equal(proc.listenerCount('SIGINT'), 0);
  assert.equal(proc.listenerCount('SIGTERM'), 0);
  return { work, commands, error, version };
}

await test('actual release orchestration stages outside release, publishes once, then keeps only the successful version', async () => {
  await fixture(async (paths) => {
    const result = await execute(paths);
    assert.equal(result.error, undefined);
    assert.deepEqual(await readdir(paths.release), ['2.4.0']);
    assert.equal((await readdir(join(paths.release, '2.4.0'))).length, 10);
    const actions = result.commands.filter((call) => call.command === 'gh');
    assert.deepEqual(
      actions.map((call) => call.args[1]),
      ['view', 'create', 'upload', 'edit'],
    );
    for (const call of actions)
      assert.equal(
        call.args[call.args.indexOf('--repo') + 1],
        'example/release-artifacts',
      );
    assert.equal(actions.at(-1).args[2], 'ship-2.4.0');
  });
});

for (const { label, scenario } of [
  { label: 'build failure', scenario: { failBuild: true } },
  { label: 'Windows upload failure', scenario: { failWindows: true } },
  { label: 'final publication failure', scenario: { failPublish: true } },
]) {
  await test(`${label} leaves previous output and no temporary/cache directories`, async () => {
    await fixture(async (paths) => {
      const result = await execute(paths, scenario);
      assert.ok(result.error);
      assert.deepEqual(await readdir(paths.release), ['2.3.0']);
      if (!scenario.failPublish)
        assert.ok(
          !result.commands.some(
            (call) => call.command === 'gh' && call.args[1] === 'edit',
          ),
        );
    });
  });
}

await test('dry-run leaves current output unchanged and preserves generated files for review outside release', async () => {
  await fixture(async (paths) => {
    const result = await execute(paths, {
      args: ['--mac', '--win', '--dry-run'],
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(await readdir(paths.release), ['2.3.0']);
    assert.equal((await readdir(result.work.state.preview)).length, 10);
    assert.deepEqual(
      result.commands
        .filter((call) => call.command === 'gh')
        .map((call) => call.args[1]),
      ['view'],
    );
  });
});

await test('SIGINT during a partially resolving Mac build prevents publication and cleans its workspace', async () => {
  await fixture(async (paths) => {
    const result = await execute(paths, { cancelMac: true });
    assert.match(result.error.message, /취소/);
    assert.deepEqual(await readdir(paths.release), ['2.3.0']);
    assert.ok(
      !result.commands.some(
        (call) =>
          call.command === 'node' ||
          (call.command === 'gh' && call.args[1] === 'edit'),
      ),
    );
  });
});

await test('SIGTERM during Windows child work waits for only its owned process tree and preserves previous release', async () => {
  await fixture(async (paths) => {
    const result = await execute(paths, {
      args: ['--win'],
      platform: 'win32',
      cancelChild: true,
    });
    assert.match(result.error.message, /취소/);
    assert.deepEqual(await readdir(paths.release), ['2.3.0']);
    assert.equal(
      result.commands.filter((call) => call.command === 'taskkill').length,
      1,
    );
    assert.ok(
      !result.commands.some(
        (call) => call.command === 'gh' && call.args[1] === 'edit',
      ),
    );
  });
});

await test('repeated interruption never signals a reused or unrelated process tree', async () => {
  await fixture(async (paths) => {
    const result = await execute(paths, {
      args: ['--win'],
      platform: 'win32',
      cancelChild: true,
      repeatSignal: true,
    });
    assert.match(result.error.message, /SIGTERM/);
    assert.equal(
      result.commands.filter((call) => call.command === 'taskkill').length,
      1,
    );
  });
});

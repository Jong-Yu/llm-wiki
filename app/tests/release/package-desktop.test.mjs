// 실행: node --experimental-vm-modules --test tests/release/package-desktop.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import {
  Arch as NativeArch,
  Platform as NativePlatform,
  archFromString,
  checkBuildRequestOptions,
} from 'app-builder-lib';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(
  join(appRoot, 'scripts/package-desktop.mjs'),
  'utf8',
);
const productConfig = JSON.parse(
  await readFile(join(appRoot, 'config/electron-builder.json'), 'utf8'),
);

/** 실제 파일을 사용하는 격리 공간에서 외부 빌더·프로세스만 대체합니다. */
async function execute(t, args, options = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'wiki-package-desktop-test-')),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixtureApp = join(root, 'project/app');
  const temporary = join(root, 'temporary');
  const alias = join(root, 'temporary-alias');
  await mkdir(join(fixtureApp, 'config'), { recursive: true });
  await mkdir(temporary);
  await symlink(
    temporary,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(
    join(fixtureApp, 'config/electron-builder.json'),
    JSON.stringify(productConfig),
  );
  await writeFile(
    join(fixtureApp, 'package.json'),
    JSON.stringify({ version: '0.1.0' }),
  );
  await mkdir(join(root, 'project/.venv/bin'), { recursive: true });
  await writeFile(join(root, 'project/.venv/bin/python'), 'fixture python');
  await mkdir(join(fixtureApp, 'release/0.1.0'), { recursive: true });
  const priorRelease = join(fixtureApp, 'release/0.1.0/preserved.dmg');
  await writeFile(priorRelease, 'prior release');
  const externalFile = join(root, 'external-user-file.md');
  await writeFile(externalFile, 'user content');
  const trace = {
    staging: [],
    removed: [],
    formats: [],
    prepare: [],
    builds: [],
    childSignals: [],
    terminationCommands: [],
    cancellationTokens: [],
    consoleErrors: [],
  };
  let activeChild;
  let childClosed = true;
  const fixtureProcess = new EventEmitter();
  const preservedHandlers = {
    SIGINT: () => {},
    SIGTERM: () => {},
  };
  for (const [name, handler] of Object.entries(preservedHandlers))
    fixtureProcess.on(name, handler);
  Object.assign(fixtureProcess, {
    argv: [
      'node',
      'package-desktop.mjs',
      ...args.map((arg) =>
        arg === '__FIXTURE_ABSOLUTE_CACHE__'
          ? join(root, 'absolute-cache')
          : arg === '__FIXTURE_WORK_DIR__'
            ? alias
            : arg,
      ),
    ],
    platform: options.platform ?? 'darwin',
    arch: process.arch,
    env: {},
    kill(pid, signal) {
      assert.equal(
        pid,
        -activeChild.pid,
        'only the owned Python process group may be signalled',
      );
      trace.childSignals.push({ pid, signal });
      activeChild.finish(null, signal);
      return true;
    },
    exit() {
      throw new Error('process.exit would skip cleanup');
    },
  });

  /** 7-Zip 기능 확인만 동기로 실행하고 긴 Python 준비에는 사용하지 못하게 합니다. */
  function spawnSync(command, commandArgs) {
    assert.deepEqual(Array.from(commandArgs), ['i']);
    trace.formats.push(command);
    return {
      status: options.noNsis ? 1 : 0,
      stdout: options.noNsis ? '' : '7-Zip formats: Nsis',
    };
  }

  /** 실제 파일을 만들고 자식 close 전에는 정리가 시작되지 않는지 검증합니다. */
  function spawn(command, commandArgs, spawnOptions) {
    const child = new EventEmitter();
    if (command.endsWith('taskkill.exe')) {
      trace.terminationCommands.push({
        command,
        args: Array.from(commandArgs),
      });
      queueMicrotask(() => {
        activeChild.finish(null, 'SIGTERM');
        child.emit('close', 0);
      });
      return child;
    }
    child.pid = 700001;
    child.exitCode = null;
    child.signalCode = null;
    childClosed = false;
    let closing = false;
    child.finish = (code, signal = null) => {
      if (closing) return;
      closing = true;
      queueMicrotask(() => {
        child.exitCode = code;
        child.signalCode = signal;
        childClosed = true;
        child.emit('close', code, signal);
      });
    };
    activeChild = child;
    const runtime = commandArgs[commandArgs.indexOf('--output-dir') + 1];
    const cache = commandArgs[commandArgs.indexOf('--cache-dir') + 1];
    trace.prepare.push({
      command,
      args: Array.from(commandArgs),
      runtime,
      cache,
      options: spawnOptions,
    });
    queueMicrotask(() => {
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, 'runtime-marker'), 'prepared runtime');
      mkdirSync(cache, { recursive: true });
      writeFileSync(join(cache, 'cache-marker'), 'prepared cache');
      if (options.signalDuringPreparation) {
        fixtureProcess.emit(options.signalDuringPreparation);
        if (options.secondSignal) fixtureProcess.emit(options.secondSignal);
      } else if (options.prepareError) {
        child.emit('error', new Error('simulated preparation spawn error'));
        child.finish(-1);
      } else child.finish(options.prepareFails ? 1 : 0);
    });
    return child;
  }

  class CancellationToken {
    cancelled = false;
    constructor() {
      trace.cancellationTokens.push(this);
    }
    cancel() {
      this.cancelled = true;
    }
  }
  class Packager {
    constructor(buildOptions, token) {
      this.options = buildOptions;
      this.cancellationToken = token;
    }
  }

  /** 빌더가 중단 뒤 부분 성공을 반환해도 정상 완료로 처리하면 안 됩니다. */
  async function build(config, packager) {
    // 실제 라이브러리의 입력 계약을 통과해야 모의 빌드까지 진행합니다.
    checkBuildRequestOptions(config);
    assert.equal(packager.cancellationToken, trace.cancellationTokens[0]);
    assert.equal(packager.options, config);
    const runtime = config.config.win.extraResources?.[0]?.from;
    if (runtime)
      assert.equal(
        readFileSync(join(runtime, 'runtime-marker'), 'utf8'),
        'prepared runtime',
      );
    trace.builds.push(config);
    const output = resolve(fixtureApp, config.config.directories.output);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'artifact.exe'), 'packaged output');
    if (options.signalDuringBuild) {
      fixtureProcess.emit(options.signalDuringBuild);
      if (options.nativeCancellationRejects)
        throw new Error('native builder cancelled');
    }
    if (options.buildFails) throw new Error('simulated desktop build failure');
    return [join(output, 'artifact.exe')];
  }

  const context = vm.createContext({
    process: fixtureProcess,
    setTimeout,
    clearTimeout,
    console: { error: (...values) => trace.consoleErrors.push(values) },
  });
  const modules = {
    'node:child_process': { spawn, spawnSync },
    'node:fs/promises': {
      access,
      async mkdtemp(prefix) {
        const path = await mkdtemp(prefix);
        trace.staging.push(path);
        if (options.signalAfterStaging)
          fixtureProcess.emit(options.signalAfterStaging);
        return path;
      },
      readFile,
      async realpath(path) {
        if (options.realpathFails)
          throw new Error('simulated canonical path failure');
        return realpath(path);
      },
      async rm(path, flags) {
        assert.equal(
          childClosed,
          true,
          'runtime cleanup must await preparation child close',
        );
        trace.removed.push(path);
        if (options.signalDuringCleanup)
          fixtureProcess.emit(options.signalDuringCleanup);
        if (options.cleanupFails)
          throw new Error('simulated runtime cleanup failure');
        return rm(path, flags);
      },
    },
    'node:os': { tmpdir: () => alias },
    'node:path': { dirname, join, resolve },
    'app-builder-lib': {
      build,
      Packager,
      CancellationToken,
      Platform: {
        WINDOWS: NativePlatform.WINDOWS,
        MAC: NativePlatform.MAC,
        current: () => NativePlatform.fromString(options.platform ?? 'darwin'),
      },
      Arch: NativeArch,
    },
    'app-builder-lib/out/toolsets/7zip.js': {
      getPath7za: async () => join(root, 'tools/7za'),
    },
  };
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: join(fixtureApp, 'scripts/package-desktop.mjs'),
    initializeImportMeta(meta) {
      meta.dirname = join(fixtureApp, 'scripts');
    },
  });
  await module.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected import: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports))
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
  assert.equal(await readFile(priorRelease, 'utf8'), 'prior release');
  assert.equal(await readFile(externalFile, 'utf8'), 'user content');
  for (const [name, handler] of Object.entries(preservedHandlers))
    assert.deepEqual(
      fixtureProcess.listeners(name),
      [handler],
      'only owned signal handlers are removed',
    );
  return {
    root,
    fixtureApp,
    temporary,
    alias,
    trace,
    error,
    exitCode: fixtureProcess.exitCode,
  };
}

/** 준비한 임시 공간만 지워지고 그 부모와 별도 출력은 살아 있는지 확인합니다. */
function assertStagingRemoved(result) {
  assert.equal(result.trace.staging.length, 1);
  for (const path of result.trace.staging)
    assert.equal(existsSync(path), false);
  assert.equal(existsSync(result.temporary), true);
  assert.equal(existsSync(result.alias), true);
}

await test('Windows runtime uses canonical OS temp and defaults cache outside release', async (t) => {
  const result = await execute(t, ['--win', '--output-dir', 'build-output']);
  assert.equal(result.error, undefined);
  assertStagingRemoved(result);
  const prepared = result.trace.prepare[0];
  assert.equal(
    dirname(dirname(prepared.runtime)),
    realpathSync(result.temporary),
  );
  assert.ok(!prepared.runtime.startsWith(join(result.fixtureApp, 'release')));
  assert.equal(
    prepared.cache,
    join(result.root, 'project/.local/build-cache/windows-runtime'),
  );
  assert.equal(
    result.trace.builds[0].config.win.signExecutable,
    productConfig.win.signExecutable,
  );
  assert.equal(
    await readFile(
      join(result.fixtureApp, 'build-output/artifact.exe'),
      'utf8',
    ),
    'packaged output',
  );
  assert.equal(existsSync(join(prepared.cache, 'cache-marker')), true);
});

await test('explicit cache and output are forwarded without deleting their contents', async (t) => {
  const result = await execute(t, [
    '--win',
    '--cache-dir',
    '../shared-cache',
    '--output-dir',
    '../distribution',
  ]);
  assert.equal(result.error, undefined);
  assertStagingRemoved(result);
  assert.equal(
    result.trace.prepare[0].cache,
    resolve(result.fixtureApp, '../shared-cache'),
  );
  assert.equal(
    await readFile(
      join(result.root, 'project/distribution/artifact.exe'),
      'utf8',
    ),
    'packaged output',
  );
  assert.equal(
    existsSync(join(result.root, 'project/shared-cache/cache-marker')),
    true,
  );
});

await test('absolute release-owned cache path is used exactly', async (t) => {
  const result = await execute(t, [
    '--win',
    '--cache-dir',
    '__FIXTURE_ABSOLUTE_CACHE__',
  ]);
  assert.equal(result.error, undefined);
  assertStagingRemoved(result);
  assert.equal(
    result.trace.prepare[0].cache,
    join(result.root, 'absolute-cache'),
  );
});

await test('build failure removes runtime staging and preserves partial build output', async (t) => {
  const result = await execute(t, ['--win', '--output-dir', 'build-output'], {
    buildFails: true,
  });
  assert.match(result.error.message, /simulated desktop build failure/);
  assertStagingRemoved(result);
  assert.equal(
    await readFile(
      join(result.fixtureApp, 'build-output/artifact.exe'),
      'utf8',
    ),
    'packaged output',
  );
});

await test('cleanup failure is reported without removing unrelated build output', async (t) => {
  const result = await execute(t, ['--win', '--output-dir', 'build-output'], {
    cleanupFails: true,
  });
  assert.match(result.error.message, /simulated runtime cleanup failure/);
  assert.equal(
    await readFile(
      join(result.fixtureApp, 'build-output/artifact.exe'),
      'utf8',
    ),
    'packaged output',
  );
  assert.equal(result.trace.removed.length, 1);
});

await test('build and cleanup failures retain both causes', async (t) => {
  const result = await execute(t, ['--win'], {
    buildFails: true,
    cleanupFails: true,
  });
  assert.match(
    result.error.message,
    /packaging failed with additional cleanup or cancellation errors/,
  );
  assert.deepEqual(
    Array.from(result.error.errors, (error) => error.message),
    ['simulated desktop build failure', 'simulated runtime cleanup failure'],
  );
});

for (const options of [{ prepareFails: true }, { prepareError: true }]) {
  await test(`preparation failure ${JSON.stringify(options)} removes partial staging and never builds`, async (t) => {
    const result = await execute(t, ['--win'], options);
    assert.match(result.error.message, /preparation|preparation spawn/);
    assertStagingRemoved(result);
    assert.equal(result.trace.builds.length, 0);
  });
}

await test('unsupported 7-Zip cleans newly owned staging', async (t) => {
  const result = await execute(t, ['--win'], { noNsis: true });
  assert.match(result.error.message, /NSIS-capable 7-Zip required/);
  assertStagingRemoved(result);
  assert.equal(result.trace.prepare.length, 0);
  assert.equal(result.trace.builds.length, 0);
});

await test('work path canonicalization failure creates no staging', async (t) => {
  const result = await execute(t, ['--win'], { realpathFails: true });
  assert.match(result.error.message, /canonical path failure/);
  assert.equal(result.trace.staging.length, 0);
  assert.equal(result.trace.prepare.length, 0);
});

for (const args of [
  ['--win', '--cache-dir'],
  ['--win', '--cache-dir', '--publish'],
  ['--output-dir'],
  ['--work-dir'],
  ['--work-dir', '--win'],
]) {
  await test(`missing path value ${JSON.stringify(args)} causes no staging or build`, async (t) => {
    const result = await execute(t, args);
    assert.match(result.error.message, /Missing packaging option value/);
    assert.equal(result.trace.staging.length, 0);
    assert.equal(result.trace.prepare.length, 0);
    assert.equal(result.trace.builds.length, 0);
  });
}

await test('Mac packaging never prepares Windows staging or cache', async (t) => {
  const result = await execute(t, ['--dir', '--output-dir', 'mac-output']);
  assert.equal(result.error, undefined);
  assert.equal(result.trace.staging.length, 0);
  assert.equal(result.trace.prepare.length, 0);
  assert.deepEqual(
    result.trace.builds[0].targets
      .get(NativePlatform.MAC)
      .get(archFromString(process.arch)),
    ['dir'],
  );
});

for (const [args, host, platform, architecture, folder] of [
  [
    ['--win', '--portable'],
    'darwin',
    NativePlatform.WINDOWS,
    NativeArch.x64,
    'windows-x64',
  ],
  [
    ['--portable'],
    'win32',
    NativePlatform.WINDOWS,
    NativeArch.x64,
    'windows-x64',
  ],
  [
    ['--mac', '--portable'],
    'win32',
    NativePlatform.MAC,
    NativeArch.arm64,
    'mac-arm64',
  ],
  [['--portable'], 'darwin', NativePlatform.MAC, NativeArch.arm64, 'mac-arm64'],
]) {
  await test(`portable ${JSON.stringify(args)} on ${host} preserves no-install ZIP distribution`, async (t) => {
    const result = await execute(t, args, { platform: host });
    assert.equal(result.error, undefined);
    const options = result.trace.builds[0];
    assert.deepEqual(options.targets.get(platform).get(architecture), ['zip']);
    assert.equal(options.publish, 'never');
    assert.equal(options.config.publish, null);
    assert.equal(options.config.extraMetadata.llmWikiDistribution, 'portable');
    assert.equal(options.config.productName, productConfig.productName);
    assert.equal(options.config.appId, productConfig.appId);
    assert.equal(
      options.config.directories.output,
      join('release', 'portable', '0.1.0', folder),
    );
    const config =
      platform === NativePlatform.WINDOWS
        ? options.config.win
        : options.config.mac;
    assert.equal(
      config.artifactName,
      `LLM-Wiki-\${version}-${folder.split('-')[0]}-\${arch}-portable.\${ext}`,
    );
    assert.equal(
      result.trace.prepare.length,
      platform === NativePlatform.WINDOWS ? 1 : 0,
    );
    if (platform === NativePlatform.WINDOWS) {
      assertStagingRemoved(result);
      assert.equal(options.config.win.extraResources[0].to, 'personal-runtime');
    } else {
      assert.equal(options.config.mac.identity, '-');
      assert.equal(options.config.mac.notarize, false);
    }
  });
}

await test('portable output override keeps its new directory separate from installed release files', async (t) => {
  const result = await execute(t, [
    '--win',
    '--portable',
    '--output-dir',
    '../portable-output',
  ]);
  assert.equal(result.error, undefined);
  assert.equal(
    result.trace.builds[0].config.directories.output,
    '../portable-output',
  );
  assertStagingRemoved(result);
});

for (const args of [
  ['--portable', '--dir'],
  ['--portable', '--publish'],
  ['--win', '--mac', '--portable'],
  ['--mac', '--win'],
  ['--portable', '--output-dir', 'release/0.1.0'],
]) {
  await test(`unsafe portable option combination ${JSON.stringify(args)} never starts preparation or a build`, async (t) => {
    const result = await execute(t, args);
    assert.match(
      result.error.message,
      /Portable ZIP packaging|one desktop packaging platform|Portable output already exists/,
    );
    assert.equal(result.trace.staging.length, 0);
    assert.equal(result.trace.prepare.length, 0);
    assert.equal(result.trace.builds.length, 0);
  });
}

await test('normal Windows installer packaging retains updater and configured default targets', async (t) => {
  const result = await execute(t, ['--win', '--publish']);
  assert.equal(result.error, undefined);
  const options = result.trace.builds[0];
  assert.equal(options.publish, 'always');
  assert.deepEqual(
    options.targets.get(NativePlatform.WINDOWS).get(NativeArch.x64),
    [],
  );
  assert.deepEqual(
    Array.from(options.config.win.target),
    productConfig.win.target,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(options.config.publish)),
    productConfig.publish,
  );
  assert.equal(options.config.extraMetadata?.llmWikiDistribution, undefined);
  assert.equal(options.config.directories.output, 'release');
  assertStagingRemoved(result);
});

for (const platform of ['darwin', 'linux']) {
  for (const directoryOnly of [false, true]) {
    await test(`actual build-request validation preserves ${platform} ${directoryOnly ? 'dir' : 'default'} target normalization`, async (t) => {
      const result = await execute(t, directoryOnly ? ['--dir'] : [], {
        platform,
      });
      assert.equal(result.error, undefined);
      const options = result.trace.builds[0];
      assert.doesNotThrow(() => checkBuildRequestOptions(options));
      assert.equal('dir' in options, false);
      assert.equal(options.targets.size, 1);
      const archTargets = options.targets.get(
        NativePlatform.fromString(platform),
      );
      if (directoryOnly) {
        assert.equal(archTargets.size, 1);
        assert.deepEqual(archTargets.get(archFromString(process.arch)), [
          'dir',
        ]);
      } else assert.equal(archTargets.size, 0);
    });
  }
}

await test('provided work directory owns the temporary runtime stage', async (t) => {
  const result = await execute(t, [
    '--win',
    '--work-dir',
    '__FIXTURE_WORK_DIR__',
  ]);
  assert.equal(result.error, undefined);
  assertStagingRemoved(result);
  assert.equal(
    dirname(dirname(result.trace.prepare[0].runtime)),
    result.temporary,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  await test(`${signal} during preparation stops only its process group and waits for close`, async (t) => {
    const result = await execute(t, ['--win'], {
      signalDuringPreparation: signal,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.exitCode, signal === 'SIGINT' ? 130 : 143);
    assertStagingRemoved(result);
    assert.equal(result.trace.prepare[0].options.detached, true);
    assert.deepEqual(result.trace.childSignals, [{ pid: -700001, signal }]);
    assert.equal(result.trace.cancellationTokens[0].cancelled, true);
    assert.equal(result.trace.builds.length, 0);
  });
  await test(`${signal} during a partially resolved build is never success`, async (t) => {
    const result = await execute(t, ['--win'], { signalDuringBuild: signal });
    assert.equal(result.error, undefined);
    assert.equal(result.exitCode, signal === 'SIGINT' ? 130 : 143);
    assertStagingRemoved(result);
    assert.equal(result.trace.cancellationTokens[0].cancelled, true);
    assert.equal(result.trace.childSignals.length, 0);
  });
}

await test('native builder cancellation rejection still cleans runtime and reports interruption', async (t) => {
  const result = await execute(t, ['--win'], {
    signalDuringBuild: 'SIGTERM',
    nativeCancellationRejects: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 143);
  assertStagingRemoved(result);
});

await test('Windows interruption targets only the owned preparation tree', async (t) => {
  const result = await execute(t, ['--win'], {
    platform: 'win32',
    signalDuringPreparation: 'SIGTERM',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 143);
  assertStagingRemoved(result);
  assert.equal(result.trace.prepare[0].options.detached, false);
  assert.deepEqual(result.trace.terminationCommands[0].args, [
    '/PID',
    '700001',
    '/T',
    '/F',
  ]);
  assert.equal(result.trace.childSignals.length, 0);
});

await test('interruption after staging creation still removes the newly owned path', async (t) => {
  const result = await execute(t, ['--win'], { signalAfterStaging: 'SIGTERM' });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 143);
  assertStagingRemoved(result);
  assert.equal(result.trace.prepare.length, 0);
  assert.equal(result.trace.builds.length, 0);
});

await test('repeated signals retain the first cancellation and send one owned-child signal', async (t) => {
  const result = await execute(t, ['--win'], {
    signalDuringPreparation: 'SIGINT',
    secondSignal: 'SIGTERM',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 130);
  assertStagingRemoved(result);
  assert.equal(result.trace.childSignals.length, 1);
});

await test('interruption plus cleanup failure retain both causes', async (t) => {
  const result = await execute(t, ['--win'], {
    signalDuringPreparation: 'SIGTERM',
    cleanupFails: true,
  });
  assert.match(
    result.error.message,
    /packaging failed with additional cleanup or cancellation errors/,
  );
  assert.equal(result.error.errors[0].code, 'DESKTOP_PACKAGING_CANCELLED');
  assert.match(result.error.errors[1].message, /runtime cleanup failure/);
});

await test('interruption during final cleanup is not reported as success', async (t) => {
  const result = await execute(t, ['--win'], {
    signalDuringCleanup: 'SIGTERM',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 143);
  assertStagingRemoved(result);
  assert.equal(result.trace.cancellationTokens[0].cancelled, true);
});

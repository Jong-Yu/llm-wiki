import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  RuntimeSettingsService,
  withCurrentBundledRuntime,
} from '@main/settings/RuntimeSettingsService';
import type { BundledRuntimePaths } from '@main/settings/bundledRuntime';
import type { RuntimeSettings } from '@contracts/runtime.contract';
import { storedRuntimeSettingsSchema } from '@contracts/runtime.contract';
import { z } from 'zod';

/** 실행기 폴더 구조만 갖춘 가짜 번들입니다. python은 받은 셸 스크립트를 실행합니다. */
async function fakeBundle(
  parent: string,
  python = '#!/bin/sh\nexit 0\n',
): Promise<BundledRuntimePaths> {
  const root = join(parent, 'resources/personal-runtime');
  await mkdir(join(root, 'tools'), { recursive: true });
  await mkdir(join(root, 'python'), { recursive: true });
  await mkdir(join(root, 'ocr/tessdata'), { recursive: true });
  await writeFile(join(root, 'tools/runtime_doctor.py'), '');
  await writeFile(join(root, 'python/python.exe'), python);
  await chmod(join(root, 'python/python.exe'), 0o755);
  await writeFile(join(root, 'ocr/tesseract.exe'), '');
  return {
    root,
    python: join(root, 'python/python.exe'),
    tesseract: join(root, 'ocr/tesseract.exe'),
    tessdata: join(root, 'ocr/tessdata'),
  };
}

/** 로그인 상태를 JSON으로 출력하는 가짜 Claude CLI입니다. 종료 코드는 로그인 여부와 일치시킵니다. */
async function fakeClaude(
  directory: string,
  name: string,
  loggedIn: boolean,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(
    path,
    `#!/bin/sh\necho '{"loggedIn": ${loggedIn}}'\nexit ${loggedIn ? 0 : 1}\n`,
  );
  await chmod(path, 0o755);
  return path;
}

/** 새 프로세스처럼 서비스를 다시 만들고 실제 호출 없이 확인 기록을 복원하는지 검사합니다. */
async function verifyAiRestart(base: string): Promise<void> {
  const directory = join(base, 'verification');
  await mkdir(directory);
  const cli = await fakeClaude(directory, 'claude', true);
  const bundle = await fakeBundle(
    join(directory, 'app'),
    `#!/bin/sh
printf 'call\\n' >> "$0.calls"
if [ -e "$0.fail" ]; then
  echo '{"ok":false,"error":{"code":"ai_test_failed"}}'
else
  echo '{"ok":true}'
fi
`,
  );
  const settings: RuntimeSettings = {
    root: bundle.root,
    python: bundle.python,
    provider: 'claude',
    codex: cli,
    claude: cli,
    tesseract: bundle.tesseract,
    tessdata: bundle.tessdata,
    models: { codex: 'default', claude: 'default' },
  };
  const settingsDirectory = join(directory, 'settings');
  const settingsFile = join(settingsDirectory, 'runtime.json');
  const verificationFile = join(settingsDirectory, 'ai-verification.json');
  await mkdir(settingsDirectory);
  await writeFile(settingsFile, JSON.stringify({ version: 2, settings }));
  const restart = async (
    chosenPath: string | null = null,
  ): Promise<RuntimeSettingsService> => {
    const service = new RuntimeSettingsService(
      settingsDirectory,
      '',
      async (): Promise<string | null> => chosenPath,
      null,
      async (): Promise<string | null> => cli,
    );
    await service.initialize();
    return service;
  };
  const calls = async (): Promise<number> =>
    (await readFile(`${bundle.python}.calls`, 'utf8')).trim().split('\n')
      .length;
  const original = await restart();
  const tested = await original.testAi();
  const verifiedAt = tested.cliConnection?.verifiedAt;
  assert.equal(tested.cliConnection?.status, 'connected');
  assert.ok(verifiedAt);
  assert.equal(await calls(), 1);

  const restored = await restart();
  // 저장된 성공만으로 연결됐다고 하지 않고 현재 로그인 결과를 받은 뒤 복원합니다.
  assert.equal(restored.snapshot().cliConnection, undefined);
  const resumed = await restored.refreshConnection();
  assert.equal(resumed.cliConnection?.status, 'connected');
  assert.equal(resumed.cliConnection?.verifiedAt, verifiedAt);
  assert.equal(await calls(), 1);
  const goodBytes = await readFile(settingsFile, 'utf8');
  const persisted = z
    .object({
      version: z.literal(2),
      settings: storedRuntimeSettingsSchema,
    })
    .strict()
    .parse(JSON.parse(goodBytes));
  const goodVerification = await readFile(verificationFile, 'utf8');
  const verification = z
    .object({
      version: z.literal(1),
      key: z.string().regex(/^[a-f0-9]{64}$/u),
      verifiedAt: z.iso.datetime(),
    })
    .strict()
    .parse(JSON.parse(goodVerification));
  assert.equal(verification.verifiedAt, verifiedAt);
  process.stdout.write(
    'PASS AI verification survives restart without another model call\n',
  );

  // 경로·모델·제공자를 바꿔 놓은 설정에는 이전 AI의 성공 기록을 붙이지 않습니다.
  const otherCli = await fakeClaude(directory, 'claude-other', true);
  const changedSettings: RuntimeSettings[] = [
    { ...settings, provider: 'codex' },
    { ...settings, claude: otherCli },
    { ...settings, python: `${bundle.python}-other` },
    { ...settings, root: `${bundle.root}-other` },
    { ...settings, models: { ...settings.models, claude: 'another-model' } },
  ];
  for (const changed of changedSettings) {
    await writeFile(
      settingsFile,
      JSON.stringify({ ...persisted, settings: changed }),
    );
    await writeFile(verificationFile, goodVerification);
    const service = await restart();
    assert.equal(service.snapshot().issue, null);
    const result = await service.refreshConnection();
    assert.equal(result.cliConnection?.status, 'connected');
    assert.equal(result.cliConnection?.verifiedAt ?? null, null);
  }
  assert.equal(await calls(), 1);
  process.stdout.write(
    'PASS changed AI or execution settings reject previous verification\n',
  );

  for (const status of ['logged_out', 'error'] as const) {
    await writeFile(settingsFile, goodBytes);
    await writeFile(verificationFile, goodVerification);
    if (status === 'logged_out') await fakeClaude(directory, 'claude', false);
    else await writeFile(cli, '#!/bin/sh\nexit 2\n');
    const result = await (await restart()).refreshConnection();
    assert.notEqual(result.cliConnection?.status, 'connected');
    assert.equal(result.cliConnection?.verifiedAt ?? null, null);
  }
  await fakeClaude(directory, 'claude', true);
  assert.equal(await calls(), 1);
  process.stdout.write(
    'PASS saved verification never bypasses current CLI login\n',
  );

  await writeFile(settingsFile, goodBytes);
  await writeFile(verificationFile, goodVerification);
  await writeFile(`${bundle.python}.fail`, '');
  const failing = await restart();
  assert.equal(
    (await failing.refreshConnection()).cliConnection?.verifiedAt,
    verifiedAt,
  );
  assert.equal((await failing.testAi()).cliConnection?.status, 'error');
  const afterFailure = await (await restart()).refreshConnection();
  assert.equal(afterFailure.cliConnection?.status, 'connected');
  assert.equal(afterFailure.cliConnection?.verifiedAt ?? null, null);
  await unlink(`${bundle.python}.fail`);
  process.stdout.write(
    'PASS failed model verification is not revived after restart\n',
  );

  // 같은 앱 실행에서도 설정을 바꾼 순간 이전 호출 성공 표시를 제거합니다.
  for (const change of ['model', 'python', 'claude'] as const) {
    await writeFile(settingsFile, goodBytes);
    await writeFile(verificationFile, goodVerification);
    const service = await restart(
      change === 'claude' ? otherCli : `${bundle.python}-other`,
    );
    assert.ok((await service.testAi()).cliConnection?.verifiedAt);
    const changed =
      change === 'model'
        ? await service.selectModel('claude', 'another-model')
        : await service.choose(change);
    assert.equal(changed.cliConnection?.verifiedAt ?? null, null);
    assert.equal(service.snapshot().cliConnection?.verifiedAt ?? null, null);
  }
  process.stdout.write(
    'PASS changing model or executable clears current verification display\n',
  );

  // 잠금 경합으로 무효화에 실패한 경우 알리고, 같은 인스턴스의 다음 실패 때 다시 정리합니다.
  await writeFile(settingsFile, goodBytes);
  await writeFile(verificationFile, goodVerification);
  await writeFile(`${bundle.python}.fail`, '');
  const locked = await restart();
  await writeFile(join(settingsDirectory, 'runtime.lock'), 'test lock');
  const uncleared = await locked.testAi();
  assert.equal(uncleared.cliConnection?.status, 'error');
  assert.match(uncleared.cliConnection?.message ?? '', /이전 성공 기록/u);
  assert.equal(await readFile(verificationFile, 'utf8'), goodVerification);
  await unlink(join(settingsDirectory, 'runtime.lock'));
  const cleared = await locked.testAi();
  assert.equal(cleared.cliConnection?.status, 'error');
  assert.doesNotMatch(cleared.cliConnection?.message ?? '', /이전 성공 기록/u);
  await assert.rejects(readFile(verificationFile), { code: 'ENOENT' });
  assert.equal(await readFile(settingsFile, 'utf8'), goodBytes);
  await unlink(`${bundle.python}.fail`);
  process.stdout.write(
    'PASS failed verification cleanup reports a lock and retries in the same service\n',
  );

  // 저장 전에 다른 앱이 바꾼 설정은 성공 이력을 쓰면서 덮어쓰지 않습니다.
  await writeFile(settingsFile, goodBytes);
  await writeFile(verificationFile, goodVerification);
  const conflicted = await restart();
  const concurrent = JSON.stringify({
    ...persisted,
    settings: {
      ...settings,
      models: { ...settings.models, claude: 'concurrent-model' },
    },
  });
  await writeFile(settingsFile, concurrent);
  assert.equal(
    (await conflicted.testAi()).cliConnection?.code,
    'ai_verification_not_saved',
  );
  assert.equal(await readFile(settingsFile, 'utf8'), concurrent);
  assert.equal(await readFile(verificationFile, 'utf8'), goodVerification);
  process.stdout.write(
    'PASS verification persistence preserves concurrent settings\n',
  );

  // 설정이 같아도 다른 앱이 새로 쓴 확인 기록을 오래된 기준으로 덮어쓰지 않습니다.
  await writeFile(settingsFile, goodBytes);
  await writeFile(verificationFile, goodVerification);
  const staleVerification = await restart();
  const concurrentVerification = JSON.stringify({
    ...verification,
    verifiedAt: '2024-01-01T00:00:00.000Z',
  });
  await writeFile(verificationFile, concurrentVerification);
  assert.equal(
    (await staleVerification.testAi()).cliConnection?.code,
    'ai_verification_not_saved',
  );
  assert.equal(await readFile(settingsFile, 'utf8'), goodBytes);
  assert.equal(
    await readFile(verificationFile, 'utf8'),
    concurrentVerification,
  );
  process.stdout.write(
    'PASS verification persistence preserves concurrent verification\n',
  );

  await writeFile(
    settingsFile,
    JSON.stringify({
      version: 2,
      settings: { ...settings, provider: 'codex' },
    }),
  );
  const selected = await restart();
  selected.selectProvider('claude');
  const activated = await selected.testAi();
  assert.equal(activated.activeProvider, 'claude');
  assert.equal(activated.restartRequired, false);
  const selectedAgain = await restart();
  assert.equal(selectedAgain.snapshot().activeProvider, 'claude');
  assert.equal(
    (await selectedAgain.refreshConnection()).cliConnection?.verifiedAt,
    activated.cliConnection?.verifiedAt,
  );
  process.stdout.write(
    'PASS successful AI test activates and remembers selected provider\n',
  );
}

/** 시작 때 이미 로그인된 CLI는 연결 버튼 없이 연결됨으로 확인하고 로그아웃은 연결 전으로 둡니다. */
async function main(): Promise<void> {
  const root = process.env.WIKI_RUNTIME_TEST_ROOT;
  assert.ok(root);
  assert.equal(dirname(root), await realpath(tmpdir()));
  assert.match(basename(root), /^wiki-runtime-check-/u);
  const base = await mkdtemp(join(root, 'cli-'));
  await mkdir(join(base, 'bin'));
  const loggedIn = await fakeClaude(join(base, 'bin'), 'claude-in', true);
  const loggedOut = await fakeClaude(join(base, 'bin'), 'claude-out', false);
  const create = (cli: string): RuntimeSettingsService => {
    const service = new RuntimeSettingsService(
      join(base, `settings-${cli.split('/').at(-1)}`),
      base,
      async (): Promise<null> => null,
      null,
      async (): Promise<string | null> => cli,
    );
    service.selectProvider('claude');
    return service;
  };

  const connected = create(loggedIn);
  assert.equal(connected.snapshot().cliConnection, undefined);
  const first = await connected.refreshConnection();
  assert.equal(first.cliConnection?.status, 'connected');
  assert.equal(first.cliConnection?.provider, 'claude');

  const out = create(loggedOut);
  const second = await out.refreshConnection();
  assert.equal(second.cliConnection, undefined);
  // 같은 제공자는 간격 안에서 다시 실행하지 않아 로그인 직후에도 즉시 뒤집히지 않습니다.
  assert.equal((await out.refreshConnection()).cliConnection, undefined);

  // 연결 기록이 있으면 다시 확인하지 않고 그대로 둡니다.
  const kept = await connected.refreshConnection();
  assert.equal(kept.cliConnection?.status, 'connected');
  process.stdout.write('PASS cli auto connection check\n');

  // 연결에 성공한 제공자는 저장과 재시작 없이 다음 AI 실행부터 사용 제공자가 됩니다.
  const project = join(base, 'project');
  await mkdir(join(project, 'tools'), { recursive: true });
  await mkdir(join(project, '.venv/bin'), { recursive: true });
  await writeFile(join(project, 'tools/runtime_doctor.py'), '');
  await writeFile(join(project, '.venv/bin/python'), '');
  const before = process.env.WIKI_AI_PROVIDER;
  try {
    const service = new RuntimeSettingsService(
      join(base, 'settings-activate'),
      project,
      async (): Promise<null> => null,
      null,
      async (): Promise<string | null> => loggedIn,
    );
    await service.initialize();
    assert.equal(service.snapshot().activeProvider, 'codex');
    service.selectProvider('claude');
    // 선택만으로는 적용하지 않고 연결에 성공해야 바뀝니다.
    assert.equal(service.snapshot().activeProvider, 'codex');
    const applied = await service.connectCli();
    assert.equal(applied.cliConnection?.status, 'connected');
    assert.equal(applied.activeProvider, 'claude');
    assert.equal(process.env.WIKI_AI_PROVIDER, 'claude');
    assert.equal(applied.restartRequired, false);
    // 다시 시작한 서비스도 저장된 제공자를 읽습니다.
    const restarted = new RuntimeSettingsService(
      join(base, 'settings-activate'),
      project,
      async (): Promise<null> => null,
      null,
      async (): Promise<string | null> => loggedIn,
    );
    await restarted.initialize();
    assert.equal(restarted.snapshot().activeProvider, 'claude');
  } finally {
    if (before === undefined) delete process.env.WIKI_AI_PROVIDER;
    else process.env.WIKI_AI_PROVIDER = before;
  }
  process.stdout.write('PASS provider applies after connection\n');

  // D-144: 이전 앱 사본의 실행기 경로는 이 앱의 실행기로 바꿔 저장하고, 직접 고른 외부 실행기는 그대로 둡니다.
  const oldBundle = await fakeBundle(join(base, 'LLM-Wiki-fix1'));
  const newBundle = await fakeBundle(join(base, 'LLM-Wiki-fix4'));
  const savedOld = {
    root: oldBundle.root,
    provider: 'claude' as const,
    python: oldBundle.python,
    codex: 'codex',
    claude: loggedIn,
    tesseract: oldBundle.tesseract,
    tessdata: oldBundle.tessdata,
    models: { codex: 'default', claude: 'default' },
  };
  const mapped = withCurrentBundledRuntime(savedOld, newBundle, 'win32');
  assert.equal(mapped?.root, newBundle.root);
  assert.equal(mapped?.python, newBundle.python);
  assert.equal(mapped?.tessdata, newBundle.tessdata);
  assert.equal(mapped?.claude, loggedIn);
  assert.equal(
    withCurrentBundledRuntime(
      {
        ...savedOld,
        root: newBundle.root.toUpperCase(),
        python: newBundle.python.toUpperCase(),
      },
      newBundle,
      'win32',
    ),
    null,
  );
  assert.equal(
    withCurrentBundledRuntime(
      { ...savedOld, root: project, python: join(project, '.venv/bin/python') },
      newBundle,
      'win32',
    ),
    null,
  );
  assert.equal(withCurrentBundledRuntime(savedOld, null, 'win32'), null);
  const mappedDirectory = join(base, 'settings-mapped');
  await mkdir(mappedDirectory, { recursive: true });
  await writeFile(
    join(mappedDirectory, 'runtime.json'),
    JSON.stringify({ version: 2, settings: savedOld }),
  );
  const startedWithNew = new RuntimeSettingsService(
    mappedDirectory,
    '',
    async (): Promise<null> => null,
    newBundle,
    async (): Promise<string | null> => loggedIn,
  );
  await startedWithNew.initialize();
  const snapshot = startedWithNew.snapshot();
  assert.equal(snapshot.settings.root, newBundle.root);
  assert.equal(snapshot.saved, true);
  assert.equal(snapshot.restartRequired, false);
  const stored = JSON.parse(
    await readFile(join(mappedDirectory, 'runtime.json'), 'utf8'),
  ) as { settings: { root: string; python: string; claude: string } };
  assert.equal(stored.settings.root, newBundle.root);
  assert.equal(stored.settings.python, newBundle.python);
  assert.equal(stored.settings.claude, loggedIn);
  process.stdout.write(
    'PASS previous bundled runtime is replaced by current\n',
  );

  // D-143: 호출 확인이 돌려준 메시지 종류 이름표는 형식이 맞을 때만 보여 줍니다.
  for (const [event, expected] of [
    ['system:hook_started', 'system:hook_started'],
    ['system:hook\\nC:/Users/secret', undefined],
  ] as const) {
    const pythonDirectory = await mkdtemp(join(base, 'py-'));
    const fakePython = join(pythonDirectory, 'python');
    await writeFile(
      fakePython,
      `#!/bin/sh\ncat <<'JSON'\n{"ok": false, "error": {"code": "ai_cli_event_rejected", "event": "${event}"}}\nJSON\nexit 1\n`,
    );
    await chmod(fakePython, 0o755);
    // 앞선 시험이 적용한 실행 경로 대신 가짜 Python을 쓰도록 시작 환경으로 지정합니다.
    const tested = await (async (): Promise<
      ReturnType<RuntimeSettingsService['snapshot']>
    > => {
      process.env.WIKI_PYTHON = fakePython;
      try {
        const service = new RuntimeSettingsService(
          join(pythonDirectory, 'settings'),
          pythonDirectory,
          async (): Promise<null> => null,
          null,
          async (): Promise<string | null> => loggedIn,
        );
        await service.initialize();
        service.selectProvider('claude');
        return await service.testAi();
      } finally {
        delete process.env.WIKI_PYTHON;
      }
    })();
    assert.equal(tested.cliConnection?.code, 'ai_cli_event_rejected');
    assert.equal(tested.cliConnection?.event, expected);
    assert.match(tested.cliConnection?.message ?? '', /허용하지 않는 동작/u);
  }
  process.stdout.write(
    'PASS rejected event label is shown only when well-formed\n',
  );

  // D-143: 진단 보고서는 앱 데이터 폴더에 새 파일로 저장하고, 기존 보고서는 덮어쓰지 않으며 열기를 요청합니다.
  const reportPython = `#!/bin/sh
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--output" ]; then shift; out="$1"; fi
  shift
done
target="$out"
n=1
while [ -e "$target" ]; do target="\${out%.txt}-$n.txt"; n=$((n+1)); done
echo '{"status": "failed"}' > "$target"
exit 1
`;
  const diagnosticBundle = await fakeBundle(
    join(base, 'LLM-Wiki-diag'),
    reportPython,
  );
  const opened: string[] = [];
  const diagnosing = new RuntimeSettingsService(
    join(base, 'app-data', 'runtime-settings'),
    '',
    async (): Promise<null> => null,
    diagnosticBundle,
    async (): Promise<string | null> => loggedIn,
    async (path: string): Promise<string> => {
      opened.push(path);
      return '';
    },
  );
  await diagnosing.initialize();
  const firstReport = (await diagnosing.diagnoseClaude()).diagnosticReport;
  const secondReport = (await diagnosing.diagnoseClaude()).diagnosticReport;
  assert.equal(firstReport?.status, 'saved');
  assert.equal(secondReport?.status, 'saved');
  assert.notEqual(firstReport?.path, secondReport?.path);
  assert.deepEqual(opened, [firstReport?.path, secondReport?.path]);
  assert.equal(
    dirname(firstReport?.path ?? ''),
    join(base, 'app-data', 'diagnostics'),
  );
  assert.deepEqual(
    (await readdir(join(base, 'app-data', 'diagnostics'))).sort(),
    ['claude-connection-report-1.txt', 'claude-connection-report.txt'],
  );
  const broken = new RuntimeSettingsService(
    join(base, 'app-data-broken', 'runtime-settings'),
    '',
    async (): Promise<null> => null,
    await fakeBundle(join(base, 'LLM-Wiki-broken'), '#!/bin/sh\nexit 2\n'),
    async (): Promise<string | null> => loggedIn,
  );
  await broken.initialize();
  const failed = (await broken.diagnoseClaude()).diagnosticReport;
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.path, null);
  process.stdout.write('PASS claude diagnostic report is saved and opened\n');
  await verifyAiRestart(base);
}
void main().catch((error: unknown): void => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});

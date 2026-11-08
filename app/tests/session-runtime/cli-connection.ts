import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeSettingsService } from '@main/settings/RuntimeSettingsService';

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

/** 시작 때 이미 로그인된 CLI는 연결 버튼 없이 연결됨으로 확인하고 로그아웃은 연결 전으로 둡니다. */
async function main(): Promise<void> {
  const root = process.env.WIKI_RUNTIME_TEST_ROOT;
  assert.ok(root?.startsWith('/private/tmp/wiki-runtime-check-'));
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
}
void main().catch((error: unknown): void => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
});

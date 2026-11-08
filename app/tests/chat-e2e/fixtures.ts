import { _electron as electron, test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const projectRoot = resolve(appRoot, '..');
const python = join(projectRoot, '.venv/bin/python');

export type FakeAiCall = {
  scenario: string;
  resumed: boolean;
  searching: boolean;
  arguments: string[];
  question: string;
};
type Fixture = {
  serverUrl: string;
  workRoot: string;
  /** 고유한 사용자로 새 앱을 띄웁니다. 매 테스트가 빈 userData에서 시작합니다. */
  launch: (options?: { cli?: string }) => Promise<Page>;
  /** 가짜 CLI가 받은 호출 기록입니다. 검색어 확장 호출은 제외합니다. */
  aiCalls: () => Promise<FakeAiCall[]>;
  shot: (page: Page, name: string) => Promise<void>;
  app: () => ElectronApplication;
  /** 실제 앱의 계정 인증으로 격리 서버에 연결하고 AI 채팅 화면까지 이동합니다. */
  openChat: (page: Page, name?: string) => Promise<void>;
  /** 서버 위키에 테스트 문서를 넣습니다. 가입 후(작업 공간 폴더 생성 후)에 호출합니다. */
  seedWiki: () => Promise<void>;
};

/** 격리 서버를 한 번 띄워 같은 파일의 테스트가 공유합니다. 서버 자료는 임시 폴더에만 둡니다. */
async function startServer(root: string): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(python, ['-u', join(appRoot, 'tests/poc-ui/server.py'), join(root, 'server')], {
    cwd: projectRoot,
    env: { ...process.env, PYTHONPATH: projectRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let error = '';
  child.stderr?.on('data', (bytes: Buffer): void => {
    error += bytes.toString();
  });
  const url = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버 시작 시간 초과: ${error}`)), 20_000);
    child.stdout?.on('data', (bytes: Buffer): void => {
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(bytes.toString());
      if (match?.[1]) {
        clearTimeout(timer);
        accept(match[1]);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`서버 종료: ${error}`));
    });
  });
  return { url, child };
}

/** 서버·위키 자료가 테스트끼리 섞이지 않도록 테스트마다 새 서버를 띄웁니다. */
export const test = base.extend<Fixture & { server: { url: string; root: string; stop: () => Promise<void> } }>({
  server: [
    async ({}, use): Promise<void> => {
      const root = await mkdtemp('/private/tmp/wiki-chat-e2e-');
      const started = await startServer(root);
      const stopped = new Promise<void>((done: () => void): void => {
        started.child.once('exit', done);
      });
      async function stop(): Promise<void> {
        if (started.child.exitCode === null && started.child.signalCode === null)
          started.child.kill('SIGTERM');
        await stopped;
      }
      try {
        await use({ url: started.url, root, stop });
      } finally {
        await stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    { auto: false },
  ],
  serverUrl: async ({ server }, use): Promise<void> => use(server.url),
  workRoot: async ({ server }, use): Promise<void> => use(server.root),
  launch: async ({ server }, use, testInfo): Promise<void> => {
    const apps: ElectronApplication[] = [];
    const directory = await mkdtemp(join(server.root, 'run-'));
    const fake = join(directory, 'fake-ai');
    await mkdir(fake, { recursive: true });
    await copyFile(join(appRoot, 'tests/chat-e2e/fake-ai/codex'), join(fake, 'codex'));
    await chmod(join(fake, 'codex'), 0o755);
    await writeFile(
      join(fake, 'config.json'),
      JSON.stringify({ log_dir: directory, slow_seconds: 30, delay_seconds: 3 }),
    );
    testInfo.annotations.push({ type: 'run-directory', description: directory });
    (testInfo as unknown as { runDirectory: string }).runDirectory = directory;
    await use(async (options = {}): Promise<Page> => {
      const application = await electron.launch({
        args: [join(appRoot, 'out/main/index.js'), `--user-data-dir=${join(directory, 'user')}`],
        cwd: appRoot,
        env: {
          ...process.env,
          WIKI_AI_PROVIDER: 'codex',
          WIKI_QUESTION_CODEX_CLI: options.cli ?? join(fake, 'codex'),
          WIKI_ANALYSIS_CODEX_CLI: options.cli ?? join(fake, 'codex'),
          WIKI_CLIENT_ROOT: projectRoot,
          WIKI_PYTHON: python,
        },
      });
      apps.push(application);
      (testInfo as unknown as { application: ElectronApplication }).application = application;
      const page = await application.firstWindow();
      return page;
    });
    for (const application of apps) await application.close().catch(() => undefined);
  },
  aiCalls: async ({ launch: _launch }, use, testInfo): Promise<void> => {
    await use(async (): Promise<FakeAiCall[]> => {
      const directory = (testInfo as unknown as { runDirectory: string }).runDirectory;
      const text = await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line): FakeAiCall => JSON.parse(line) as FakeAiCall)
        .filter((call: FakeAiCall): boolean => !call.searching);
    });
  },
  openChat: async ({ serverUrl }, use): Promise<void> => {
    await use(async (page: Page, name?: string): Promise<void> => {
      await expect(page.getByRole('textbox', { name: '계정 이름' })).toBeVisible();
      // 채팅 검사의 준비 단계입니다. 제품 인증 IPC의 실제 가입 결과를 한 번 확인한 뒤
      // 화면이 main의 연결 상태를 다시 읽게 하므로 폼 전환이나 재가입 추측에 의존하지 않습니다.
      const status = await page.evaluate(async (account: { name: string; serverUrl: string }): Promise<string> => {
        const result = await window.wiki?.connection.authenticate({ ...account, mode: 'signup' });
        if (!result?.ok) throw new Error(result?.error.code ?? 'connection_bridge_missing');
        return result.data.status;
      }, { name: name ?? `검증${randomBytes(8).toString('hex')}`, serverUrl });
      expect(status).toBe('connected');
      await page.reload();
      await page.getByRole('link', { name: 'AI 채팅' }).click();
      await expect(page.getByPlaceholder('문서에 대해 질문하세요')).toBeEnabled();
    });
  },
  seedWiki: async ({ server }, use): Promise<void> => {
    await use(async (): Promise<void> => {
      await new Promise<void>((accept, reject) => {
        const child = spawn(python, [join(appRoot, 'tests/chat-e2e/seed_wiki.py'), join(server.root, 'server/data/sdv-platform')], {
          cwd: projectRoot,
          env: { ...process.env, PYTHONPATH: projectRoot },
          stdio: 'inherit',
        });
        child.once('exit', (code) => (code === 0 ? accept() : reject(new Error(`시드 실패 ${code}`))));
      });
    });
  },
  shot: async ({}, use, testInfo): Promise<void> => {
    let count = 0;
    await use(async (page: Page, name: string): Promise<void> => {
      count += 1;
      const file = testInfo.outputPath(`${String(count).padStart(2, '0')}-${name}.png`);
      await page.screenshot({ path: file });
      await testInfo.attach(name, { path: file, contentType: 'image/png' });
    });
  },
  app: async ({ launch: _launch }, use, testInfo): Promise<void> =>
    use((): ElectronApplication => (testInfo as unknown as { application: ElectronApplication }).application),
});

export { expect };

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// 출력 청크 경계와 무관하게 fixture 서버의 준비 완료 행을 기다립니다.
export function waitForReady(
  server,
  {
    timeoutMs = 15000,
    timeoutMessage = () => 'Isolated server startup timeout',
    stoppedMessage = () => 'Isolated server stopped',
  } = {},
) {
  return new Promise((accept, reject) => {
    let pending = '';
    let discarding = false;
    const cleanup = () => {
      clearTimeout(timeout);
      server.stdout.off('data', onData);
      server.off('error', onError);
      server.off('close', onClose);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error(stoppedMessage()));
    const onData = (bytes) => {
      const parts = bytes.toString().split('\n');
      for (let index = 0; index < parts.length; index += 1) {
        if (!discarding) pending += parts[index];
        if (pending.length > 65536) {
          pending = '';
          discarding = true;
        }
        if (index === parts.length - 1) break;
        const match = discarding
          ? null
          : /^READY (http:\/\/127\.0\.0\.1:\d+)\r?$/.exec(pending);
        pending = '';
        discarding = false;
        if (match) {
          cleanup();
          accept(match[1]);
          return;
        }
      }
    };
    const timeout = setTimeout(
      () => onError(new Error(timeoutMessage())),
      timeoutMs,
    );
    server.stdout.on('data', onData);
    server.once('error', onError);
    server.once('close', onClose);
  });
}

// 시작 실패·시그널 종료도 처리하고 격리 서버를 정리한 뒤 반환합니다.
export async function stopProcess(child) {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  await new Promise((accept) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      accept();
    });
    child.kill('SIGTERM');
  });
}

// 빌드한 검증 파일의 시작 실패와 비정상 종료를 모두 실패로 반환합니다.
async function runCheck(command, args, options, failureMessage) {
  const child = spawn(command, args, options);
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  if (code !== 0) throw new Error(`${failureMessage} (${code})`);
}

// 같은 SSR 설정을 쓰는 Node 검증 두 종류의 임시 빌드·실행·정리를 맡습니다.
export async function runNodeCheck({
  appRoot,
  suite,
  temporaryPrefix,
  failureMessage,
}) {
  const { build } = await import('vite');
  const temporary = await mkdtemp(`/private/tmp/${temporaryPrefix}`);
  try {
    await build({
      configFile: false,
      root: appRoot,
      logLevel: 'error',
      resolve: {
        alias: {
          '@contracts': join(appRoot, 'src/shared/contracts'),
          '@renderer': join(appRoot, 'src/renderer'),
        },
      },
      ssr: { noExternal: true },
      build: {
        ssr: join(appRoot, 'tests', suite, 'verify.ts'),
        outDir: temporary,
        emptyOutDir: false,
        rolldownOptions: { output: { entryFileNames: 'verify.mjs' } },
      },
    });
    await runCheck(
      process.execPath,
      [join(temporary, 'verify.mjs')],
      { stdio: 'inherit' },
      failureMessage,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// Clean Up·관계 검토의 동일한 격리 서버와 제품 renderer 검증 절차를 공유합니다.
export async function runOntologyCheck({ appRoot, kind, failureMessage }) {
  const { build, loadConfigFromFile } = await import('vite');
  const { default: electron } = await import('electron');
  const project = resolve(appRoot, '..');
  const temporary = await mkdtemp(`/private/tmp/wiki-${kind}-ui-`);
  let server;
  try {
    await writeFile(
      join(temporary, `${kind}-test-root`),
      `isolated-${kind}-ui-only`,
      { flag: 'wx' },
    );
    server = spawn(
      join(project, '.venv/bin/python'),
      [
        '-u',
        join(appRoot, `tests/ontology-${kind}/server.py`),
        join(temporary, 'server'),
      ],
      {
        cwd: project,
        env: { ...process.env, PYTHONPATH: project },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let serverError = '';
    server.stderr.on('data', (bytes) => {
      serverError += bytes.toString();
    });
    const url = await waitForReady(server, {
      timeoutMessage: () => serverError || 'Isolated server startup timeout',
      stoppedMessage: () => serverError || 'Isolated server stopped',
    });
    // 제품 설정을 사용하되 다른 작업의 out 산출물과 경합하지 않습니다.
    const productConfig = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      join(appRoot, 'config/electron.vite.config.ts'),
    );
    if (!productConfig?.config.renderer)
      throw new Error('Product renderer configuration unavailable');
    await build({
      ...productConfig.config.renderer,
      configFile: false,
      root: join(appRoot, 'src/renderer'),
      base: './',
      logLevel: 'error',
      build: { outDir: join(temporary, 'renderer') },
    });
    await build({
      configFile: false,
      root: appRoot,
      logLevel: 'error',
      resolve: {
        alias: {
          '@main': join(appRoot, 'src/main'),
          '@contracts': join(appRoot, 'src/shared/contracts'),
        },
      },
      ssr: { noExternal: true, external: ['electron'] },
      build: {
        ssr: join(appRoot, `tests/ontology-${kind}/verify.ts`),
        outDir: temporary,
        emptyOutDir: false,
        rolldownOptions: {
          external: ['electron'],
          output: { entryFileNames: 'verify.mjs' },
        },
      },
    });
    const prefix = `WIKI_${kind.toUpperCase()}`;
    await runCheck(
      electron,
      [join(temporary, 'verify.mjs')],
      {
        cwd: appRoot,
        env: {
          ...process.env,
          [`${prefix}_URL`]: url,
          [`${prefix}_ROOT`]: temporary,
          [`${prefix}_APP`]: appRoot,
          ELECTRON_RUN_AS_NODE: '',
        },
        stdio: 'inherit',
      },
      failureMessage,
    );
  } finally {
    if (server) await stopProcess(server);
    await rm(temporary, { recursive: true, force: true });
  }
}

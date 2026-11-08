import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const mode = process.argv[2];
const recentDocuments = mode === '--recent-documents';
const displayIssues = mode === '--display-issues';
if (process.argv.length > 3 || (mode && !recentDocuments && !displayIssues))
  throw new Error(
    'Use --recent-documents or --display-issues to select an isolated fixture',
  );
const temporary = await mkdtemp('/private/tmp/wiki-exploration-ui-');
await writeFile(
  join(temporary, 'exploration-test-root'),
  'isolated-exploration-ui-only',
  { flag: 'wx' },
);
const api = spawn(
  join(project, '.venv/bin/python'),
  [
    '-B',
    '-u',
    join(appRoot, 'tests/ontology-exploration/server.py'),
    join(temporary, 'server'),
    ...(mode ? [mode] : []),
  ],
  {
    cwd: project,
    env: { ...process.env, PYTHONPATH: project },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let web;
let stopping = false;
let apiError = '';
api.stderr.on('data', (bytes) => {
  apiError = (apiError + bytes.toString()).slice(-6000);
  process.stderr.write(bytes);
});
const stop = (signal) => {
  stopping = true;
  web?.kill(signal);
  api.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
try {
  const upstream = await new Promise((accept, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error(apiError || 'Isolated exploration startup timeout')),
      15000,
    );
    api.stdout.on('data', (bytes) => {
      const output = bytes.toString();
      process.stdout.write(output);
      const ready = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (ready) {
        clearTimeout(timeout);
        accept(ready[1]);
      }
    });
    api.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(apiError || 'Isolated API stopped'));
    });
  });
  if (stopping) throw new Error('Exploration startup canceled');
  // 기존 서버에 연결하거나 종료하지 않고 새로 확보한 loopback 포트만 사용한다.
  const available = createServer();
  await new Promise((accept, reject) => {
    available.once('error', reject);
    available.listen(0, '127.0.0.1', accept);
  });
  const address = available.address();
  if (!address || typeof address === 'string')
    throw new Error('Isolated web port unavailable');
  const port = address.port;
  await new Promise((accept, reject) =>
    available.close((error) => (error ? reject(error) : accept())),
  );
  process.stdout.write(
    `격리 API: ${upstream}\n로그인 이름: 지도 탐색 검증\n자료: ${displayIssues ? 'energy-provider.md / original-record.md · scope별 2관계 / 긴 원문 근거 / 원본 연결 / 문서별 경고' : recentDocuments ? '10문서 · 문서당50개념 · 총500개념' : '예약-플랫폼.md / 파트너-예약.md / 운영-정책.md'}\n현재 제품 renderer와 공통 main 서비스를 빌드합니다.\n`,
  );
  web = spawn(
    process.execPath,
    [join(appRoot, 'scripts/start-web-test.mjs'), upstream],
    {
      cwd: appRoot,
      env: { ...process.env, WIKI_WEB_TEST_PORT: String(port) },
      stdio: 'inherit',
    },
  );
  const code = await new Promise((accept, reject) => {
    web.once('error', reject);
    web.once('exit', accept);
  });
  if (!stopping && code !== 0)
    throw new Error(`Exploration web test stopped (${code})`);
} finally {
  web?.kill('SIGTERM');
  api.kill('SIGTERM');
  await Promise.all(
    [web, api]
      .filter(Boolean)
      .map(
        (child) =>
          new Promise((accept) =>
            child.exitCode !== null || child.signalCode !== null
              ? accept()
              : child.once('exit', accept),
          ),
      ),
  );
  await rm(temporary, { recursive: true, force: true });
}

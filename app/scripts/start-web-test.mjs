import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { userGuideAssets } from '../config/userGuideAssets.ts';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.WIKI_WEB_SERVER_URL || process.argv[2];
if (!upstream || process.argv.length > 3) {
  process.stderr.write('사용법: npm run test:web -- https://서버주소\n');
  process.exit(1);
}
const url = new URL(upstream);
if (
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  (url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    ))
) {
  throw new Error('HTTPS 또는 로컬 서버 주소를 지정해 주세요.');
}
const temporary = await mkdtemp(
  join(await realpath(tmpdir()), 'llm-wiki-web-test-'),
);
const aliases = {
  '@contracts': join(appRoot, 'src/shared/contracts'),
  '@main': join(appRoot, 'src/main'),
  '@renderer': join(appRoot, 'src/renderer'),
};
let child;
let stopping = false;
const stop = (signal) => {
  stopping = true;
  child?.kill(signal);
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
try {
  await build({
    configFile: false,
    root: join(appRoot, 'src/web-test'),
    resolve: { alias: aliases },
    plugins: [react(), userGuideAssets()],
    build: {
      outDir: join(temporary, 'browser'),
      emptyOutDir: false,
      sourcemap: false,
    },
  });
  if (stopping) throw new Error('웹 테스트 시작을 취소했습니다.');
  await build({
    configFile: false,
    root: appRoot,
    resolve: { alias: aliases },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'src/web-test/server.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'server.mjs' },
      },
    },
  });
  if (stopping) throw new Error('웹 테스트 시작을 취소했습니다.');
  child = spawn(process.execPath, [join(temporary, 'server.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      WIKI_WEB_SERVER_URL: upstream,
      WIKI_WEB_TEST_ROOT: temporary,
      WIKI_WEB_TEST_PROJECT: resolve(appRoot, '..'),
    },
    stdio: 'inherit',
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => accept(exitCode));
  });
  process.exitCode = code ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

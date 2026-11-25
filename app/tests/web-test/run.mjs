import { waitForReady, stopProcess } from '../testRuntime.mjs';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp(
  join(await realpath(tmpdir()), 'wiki-web-verify-'),
);
const server = spawn(
  join(project, '.venv/bin/python'),
  ['-u', join(appRoot, 'tests/poc-ui/server.py'), join(temporary, 'fixture')],
  {
    cwd: project,
    env: { ...process.env, PYTHONPATH: project },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverError = '';
server.stderr.on('data', (bytes) => {
  serverError = (serverError + bytes.toString()).slice(-4000);
});
try {
  const url = await waitForReady(server, {
    timeoutMessage: () => 'fixture startup timeout',
    stoppedMessage: () => serverError || 'fixture stopped',
  });
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@contracts': join(appRoot, 'src/shared/contracts'),
        '@main': join(appRoot, 'src/main'),
        '@renderer': join(appRoot, 'src/renderer'),
      },
    },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'tests/web-test/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  const child = spawn(process.execPath, [join(temporary, 'verify.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      WIKI_WEB_VERIFY_ROOT: temporary,
      WIKI_WEB_VERIFY_PROJECT: project,
      WIKI_WEB_VERIFY_URL: url,
    },
    stdio: 'inherit',
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  if (code !== 0) throw new Error('Web verification failed');
} finally {
  await stopProcess(server);
  await rm(temporary, { recursive: true, force: true });
}

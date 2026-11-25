import { waitForReady, stopProcess } from '../testRuntime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp('/private/tmp/wiki-ui-poc-');
const server = spawn(
  join(project, '.venv/bin/python'),
  ['-u', join(appRoot, 'tests/poc-ui/server.py'), join(temporary, 'server')],
  {
    cwd: project,
    env: { ...process.env, PYTHONPATH: project },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverError = '';
server.stderr.on('data', (data) => {
  serverError += data.toString();
});
try {
  const url = await waitForReady(server, {
    timeoutMessage: () => 'Isolated server startup timeout',
    stoppedMessage: () => serverError || 'Isolated server stopped',
  });
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@main': join(appRoot, 'src/main'),
        '@contracts': join(appRoot, 'src/shared/contracts'),
        '@renderer': join(appRoot, 'src/renderer'),
      },
    },
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: join(appRoot, 'tests/poc-ui/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  for (const phase of ['verify', 'restart']) {
    const child = spawn(electron, [join(temporary, 'verify.mjs')], {
      cwd: appRoot,
      env: {
        ...process.env,
        WIKI_UI_TEST_PHASE: phase,
        WIKI_UI_TEST_URL: url,
        WIKI_UI_TEST_ROOT: temporary,
        WIKI_UI_APP_ROOT: appRoot,
        ELECTRON_RUN_AS_NODE: '',
      },
      stdio: 'inherit',
    });
    const code = await new Promise((done) => child.once('exit', done));
    if (code !== 0)
      throw new Error(`Electron contract checks failed (${phase}: ${code})`);
  }
} finally {
  await stopProcess(server);
  await rm(temporary, { recursive: true, force: true });
}

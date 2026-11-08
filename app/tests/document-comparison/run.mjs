import { chmod, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import electron from 'electron';
import react from '@vitejs/plugin-react';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp('/private/tmp/wiki-comparison-ui-');
const product = join(temporary, 'product');
await cp(join(appRoot, 'out'), join(product, 'out'), { recursive: true });
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
  const fakeCli = join(temporary, 'codex');
  await cp(join(appRoot, 'tests/chat-e2e/fake-ai/codex'), fakeCli);
  await chmod(fakeCli, 0o700);
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: {
      alias: {
        '@renderer': join(appRoot, 'src/renderer'),
        '@contracts': join(appRoot, 'src/shared/contracts'),
      },
    },
    plugins: [react()],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      target: 'esnext',
      outDir: join(temporary, 'registration'),
      lib: {
        entry: join(
          appRoot,
          'tests/document-comparison/registration-fixture.tsx',
        ),
        formats: ['es'],
        fileName: 'fixture',
        cssFileName: 'fixture',
      },
    },
  });
  await writeFile(
    join(temporary, 'registration/index.html'),
    '<!doctype html><html lang="ko" data-wiki-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>등록 진행 상태 검수</title><link rel="stylesheet" href="./fixture.css"><style>html,body{margin:0;min-height:100%;background:var(--wiki-color-surface-canvas)}#root{container:workspace/inline-size}</style></head><body><div id="root" class="wiki-theme" data-wiki-theme="light"></div><script type="module" src="./fixture.js"></script></body></html>',
  );
  const url = await new Promise((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Isolated server startup timeout')),
      15000,
    );
    server.stdout.on('data', (bytes) => {
      const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(bytes.toString());
      if (match) {
        clearTimeout(timeout);
        accept(match[1]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(serverError || 'Isolated server stopped'));
    });
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
      ssr: join(appRoot, 'tests/document-comparison/verify.ts'),
      outDir: temporary,
      emptyOutDir: false,
      rolldownOptions: {
        external: ['electron'],
        output: { entryFileNames: 'verify.mjs' },
      },
    },
  });
  for (const phase of ['verify']) {
    const child = spawn(electron, [join(temporary, 'verify.mjs')], {
      cwd: appRoot,
      env: {
        ...process.env,
        WIKI_UI_TEST_PHASE: phase,
        WIKI_UI_TEST_URL: url,
        WIKI_UI_TEST_ROOT: temporary,
        WIKI_UI_APP_ROOT: product,
        WIKI_CLIENT_ROOT: project,
        WIKI_PYTHON: join(project, '.venv/bin/python'),
        WIKI_AI_PROVIDER: 'codex',
        WIKI_QUESTION_CODEX_CLI: fakeCli,
        WIKI_ANALYSIS_CODEX_CLI: fakeCli,
        WIKI_PROPOSAL_CODEX_CLI: fakeCli,
        WIKI_CLAUDE_CLI: fakeCli,
        ELECTRON_RUN_AS_NODE: '',
      },
      stdio: 'inherit',
    });
    const code = await new Promise((done) => child.once('exit', done));
    if (code !== 0)
      throw new Error(`Electron contract checks failed (${phase}: ${code})`);
  }
} finally {
  server.kill('SIGTERM');
  await new Promise((done) =>
    server.exitCode !== null ? done() : server.once('exit', done),
  );
  await rm(temporary, { recursive: true, force: true });
}

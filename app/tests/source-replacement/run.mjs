import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { stopProcess, waitForReady } from '../testRuntime.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const project = resolve(appRoot, '..');
const temporary = await mkdtemp('/private/tmp/wiki-source-replacement-');
const python = join(project, '.venv/bin/python');
const server = spawn(
  python,
  ['-u', join(appRoot, 'tests/poc-ui/server.py'), join(temporary, 'server')],
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
try {
  const url = await waitForReady(server, {
    stoppedMessage: () => serverError || 'Isolated server stopped',
  });
  // 새 임시 서버에만 시험 계정·위키를 만들고 fixture 자격증명도 같은 임시 폴더에 둡니다.
  execFileSync(
    python,
    [
      '-c',
      `import json, sys
from pathlib import Path
from core.modules.access.auth import initialize_auth
from core.modules.access.policy import AccessPolicy
from core.tests.poc_access.fixtures import grant_test_membership
from core.modules.documents.store import WikiStore
r=Path(sys.argv[1]).resolve()
assert r.parent == Path('/private/tmp') and r.name.startswith('wiki-source-replacement-')
s=r/'server'
p=AccessPolicy(s/'.local/tenancy/access.json', s/'data')
u=grant_test_membership(p, initialize_auth(p).signup('교체 격리 검증'))
f=r/'fixture.json'
f.write_text(json.dumps(u),encoding='utf-8'); f.chmod(0o600)
WikiStore(s/'data/sdv-platform').save('교체-문서.md', '기존 위키 보존', expected_revision=None)
`,
      temporary,
    ],
    { cwd: project, env: { ...process.env, PYTHONPATH: project } },
  );
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
      ssr: join(appRoot, 'tests/source-replacement/verify.ts'),
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
    stdio: 'inherit',
    env: {
      ...process.env,
      WIKI_REPLACEMENT_ROOT: temporary,
      WIKI_REPLACEMENT_URL: url,
    },
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', accept);
  });
  if (code !== 0) throw new Error(`Source replacement checks failed (${code})`);
} finally {
  await stopProcess(server);
  await rm(temporary, { recursive: true, force: true });
}

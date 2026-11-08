import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';
import { build } from 'vite';

// 제품 preload와 실제 IPC·읽기 서비스를 격리된 Electron 창에서 함께 검사합니다.
const root = resolve(import.meta.dirname, '../..');
const temporary = await mkdtemp(
  join(await realpath(tmpdir()), 'wiki-attachment-'),
);
try {
  await writeFile(
    join(temporary, 'index.html'),
    '<!doctype html><title>Attachment test</title><script type="module">import * as platform from "./attachments.mjs"; window.attachments = platform;</script>',
  );
  for (const [entry, fileName, format] of [
    ['src/preload/index.ts', 'preload.cjs', 'cjs'],
    ['src/renderer/platform/attachments.ts', 'attachments.mjs', 'es'],
    ['tests/attachments/verify.ts', 'verify.mjs', 'es'],
  ]) {
    await build({
      root,
      configFile: false,
      logLevel: 'error',
      resolve: {
        alias: {
          '@main': join(root, 'src/main'),
          '@contracts': join(root, 'src/shared/contracts'),
        },
      },
      ssr: { noExternal: true, external: ['electron'] },
      build: {
        ssr: join(root, entry),
        outDir: temporary,
        emptyOutDir: false,
        rolldownOptions: {
          external: ['electron'],
          output: { entryFileNames: fileName, format },
        },
      },
    });
  }
  const child = spawnSync(electron, [join(temporary, 'verify.mjs')], {
    cwd: root,
    stdio: 'inherit',
    timeout: 45_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(`첨부 검증 실패 (${child.signal ?? child.status})`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

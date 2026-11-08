import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { userGuideAssets } from '../../config/userGuideAssets.ts';
import { isWindowFrameLocation } from '../../src/main/windows/rendererLocation.ts';

const appRoot = resolve(import.meta.dirname, '../..');
let addresses = 0;
for (const renderer of [
  'file:///Applications/LLM%20Wiki.app/Contents/Resources/app.asar/out/renderer/index.html',
  'file:///C:/Program%20Files/LLM%20Wiki/resources/app.asar/out/renderer/index.html',
  'http://127.0.0.1:5173/',
]) {
  const guide = new URL('user-guide/index.html', renderer).href;
  const reference = new URL('user-guide/reference.html', renderer).href;
  const cases = [
    [renderer, true, true],
    [`${renderer}#/guide`, true, true],
    [guide, true, false],
    [reference, true, false],
    [renderer, false, false],
    [guide, false, true],
    [`${reference}#${encodeURIComponent('개인-ai-연결하기')}`, false, true],
    [`${guide}?other=true`, false, false],
    [new URL('other.html', renderer).href, false, false],
    [new URL('user-guide/../index.html', renderer).href, false, false],
    ['https://example.com/user-guide/index.html', false, false],
    ['file:///etc/passwd', false, false],
    ['javascript:alert(1)', false, false],
    ['data:text/html,<h1>other</h1>', false, false],
  ];
  for (const [address, mainFrame, allowed] of cases) {
    assert.equal(isWindowFrameLocation(address, renderer, mainFrame), allowed);
    addresses++;
  }
}

const assets = new Map();
const plugin = userGuideAssets();
await plugin.generateBundle.call({
  emitFile(asset) {
    assets.set(asset.fileName, asset.source.toString());
  },
});
assert.deepEqual([...assets.keys()].sort(), [
  'user-guide/index.html',
  'user-guide/reference.html',
]);
const index = assets.get('user-guide/index.html');
assert.equal((index.match(/data:image\/png;base64,/g) ?? []).length, 10);
assert(!/<script\s+src=/.test(index));
for (const html of assets.values()) {
  assert(html.includes("connect-src 'none'"));
  assert(!html.includes("script-src 'self'"));
  assert(!html.includes("script-src 'unsafe-inline'"));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const hash = createHash('sha256').update(script[1]).digest('base64');
    assert(html.includes(`'sha256-${hash}'`));
  }
}
const packageConfig = JSON.parse(
  await readFile(join(appRoot, 'config/electron-builder.json'), 'utf8'),
);
assert(packageConfig.files.includes('out/**/*'));

const temporary = await mkdtemp('/private/tmp/wiki-guide-boundaries-');
let server;
try {
  const browser = join(temporary, 'browser');
  await mkdir(join(browser, 'user-guide'), { recursive: true });
  await writeFile(join(browser, 'index.html'), '<!doctype html><h1>App</h1>');
  for (const [filename, content] of assets)
    await writeFile(join(browser, filename), content);
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    resolve: { alias: { '@contracts': join(appRoot, 'src/shared/contracts') } },
    ssr: { noExternal: true },
    build: {
      ssr: join(appRoot, 'src/web-test/httpServer.ts'),
      outDir: join(temporary, 'server'),
      rolldownOptions: { output: { entryFileNames: 'server.mjs' } },
    },
  });
  const { startWebTestServer } = await import(
    pathToFileURL(join(temporary, 'server/server.mjs')).href
  );
  server = await startWebTestServer({
    assetsRoot: browser,
    services: { close: async () => {} },
    port: 0,
  });
  for (const filename of ['index.html', 'reference.html']) {
    const response = await fetch(`${server.url}/user-guide/${filename}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert((await response.text()).includes('Content-Security-Policy'));
  }
  for (const filename of ['steps.js', 'assets/login.png', 'other.html']) {
    const response = await fetch(`${server.url}/user-guide/${filename}`);
    assert.equal(response.status, 404);
  }
  const denied = await fetch(`${server.url}/user-guide/index.html`, {
    headers: { Origin: 'https://example.com' },
  });
  assert.equal(denied.status, 403);
  console.log(
    `PASS guide: ${addresses} frame boundaries, two self-contained packaged pages, script hashes, ten inline screenshots and six web asset/Origin cases`,
  );
} finally {
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}

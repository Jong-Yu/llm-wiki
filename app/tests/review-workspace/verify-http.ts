import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { registerConnectionHandlers } from '../../src/main/ipc/registerConnectionHandlers';

/** 실제 서버 시험도 새 임시 폴더와 localhost 주소로만 실행합니다. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated setting: ${name}`);
  return value;
}
const root = required('WIKI_REVIEW_HTTP_ROOT');
const appRoot = required('WIKI_REVIEW_HTTP_APP');
const serverUrl = required('WIKI_REVIEW_HTTP_URL');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(serverUrl))
  throw new Error('Local isolated server required');
app.setPath('userData', join(root, 'electron-review-workspace'));
app.setName('LLM Wiki review workspace isolated verification');
let window: BrowserWindow | null = null;
let stop: (() => Promise<void>) | undefined;
const requests: string[] = [];
const originalFetch = globalThis.fetch;

/** 검토함은 읽기 POST만 허용하고 원문·검토·AI 쓰기 요청은 전송 전에 차단합니다. */
globalThis.fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(serverUrl + '/'))
    throw new Error('Non-fixture network request blocked');
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  const path = new URL(url).pathname;
  requests.push(`${method} ${path}`);
  if (
    !['GET', 'HEAD'].includes(method) &&
    !path.endsWith('/auth/login') &&
    !path.endsWith('/review-queue/query')
  )
    throw new Error('Unexpected mutation blocked: ' + path);
  return originalFetch(input, init);
};

/** 제품 renderer DOM을 사용하고 인증정보는 출력하지 않습니다. */
async function js(source: string): Promise<unknown> {
  if (!window) throw new Error('Missing window');
  try {
    return await window.webContents.executeJavaScript(source);
  } catch (error: unknown) {
    throw new Error(`Renderer evaluation failed: ${source}`, { cause: error });
  }
}
/** main/preload/서버와 연결한 실제 화면 응답만 기다립니다. */
async function until(source: string): Promise<void> {
  for (let i = 0; i < 160; i += 1) {
    if (await js(source)) return;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 25);
    });
  }
  throw new Error(
    `Timed out: ${source}\n${String(await js('document.body.innerText'))}`,
  );
}

/** 문서 이름으로 목록 행을 고르고 선택 상세의 실제 이동 주소를 확인합니다. */
async function selectDocument(kind: string, name: string): Promise<void> {
  const active =
    "document.querySelector('[data-workspace-route][data-active=true]')";
  await js(
    `(() => { const back=[...${active}.querySelectorAll('button')].find(b=>b.textContent.trim()==='목록으로' && b.getBoundingClientRect().width>0); back?.click(); })()`,
  );
  const row = `[...${active}.querySelectorAll('[data-review-kind=${JSON.stringify(kind)}]')].find(row=>row.closest('section')?.querySelector('h2')?.textContent.trim()===${JSON.stringify(name)})`;
  await until(`${row}?.getBoundingClientRect().width>0`);
  await js(
    `(() => { const button=${row}.querySelector('[data-review-select]'); button.focus(); button.click(); })()`,
  );
  await until(
    `${row}?.querySelector('[data-review-select]')?.getAttribute('aria-pressed')==='true' && !!${active}.querySelector('[data-review-detail]')`,
  );
}

/** 운영 연결 없이 신규 실제 주소·네비게이션과 기존 세션 이동을 확인합니다. */
async function run(): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.equal(dirname(root), '/private/tmp');
  assert.ok(basename(root).startsWith('wiki-review-ui-'));
  assert.equal(
    await readFile(join(root, 'review-test-root'), 'utf8'),
    'isolated-review-ui-only',
  );
  await app.whenReady();
  const location = pathToFileURL(join(appRoot, 'out/renderer/index.html')).href;
  stop = await registerConnectionHandlers(
    (): BrowserWindow | null => window,
    location,
  );
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: join(appRoot, 'out/preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadURL(location);
    await until("!!document.querySelector('input[name=name]')");
    await js(
      `(() => { const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; for(const [name,value] of Object.entries(${JSON.stringify({ name: '관계 검증', serverUrl })})){const input=document.querySelector('input[name="'+name+'"]');setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));} [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='로그인').click();})()`,
    );
    await until('!!document.querySelector(\'a[href="#/review"]\')');
    await js('document.querySelector(\'a[href="#/review"]\').click()');
    await until(
      "[...document.querySelectorAll('[data-workspace-route][data-active=true] h2')].some(e=>e.textContent.trim()==='review') && [...document.querySelectorAll('[data-workspace-route][data-active=true] h2')].some(e=>e.textContent.trim()==='past')",
    );
    assert.equal(
      await js(
        'document.querySelector(\'nav[aria-label="기본 메뉴"] a[href="#/review"]\')?.getAttribute(\'aria-current\')',
      ),
      'page',
    );
    assert.equal(
      await js(
        '!!document.querySelector(\'nav[aria-label="기본 메뉴"] a[href*="connections"]\')',
      ),
      false,
    );
    await selectDocument('document_claim', 'review');
    // 원문 주장은 줄 번호가 있는 원문과 판단 위젯이 상세를 대신합니다.
    await until(
      '!!document.querySelector(\'[data-workspace-route][data-active=true] [data-review-detail] [aria-label="원문"]\') && !!document.querySelector(\'[data-workspace-route][data-active=true] [data-review-detail] [aria-label="판단 선택"]\')',
    );
    assert.equal(
      await js(
        'document.querySelector(\'[data-workspace-route][data-active=true] [data-review-detail] a[href="#/document?path=review.md"]\')?.textContent.trim()',
      ),
      '문서 열기 ↗',
    );
    assert.equal(
      await js(
        'document.querySelectorAll(\'[data-workspace-route][data-active=true] [data-review-detail] [aria-label="판단 선택"] button\').length',
      ),
      4,
    );
    await selectDocument('pending_document_event', 'past');
    assert.equal(
      await js(
        'document.querySelector(\'[data-workspace-route][data-active=true] [data-review-detail] a[href="#/document?path=past.md"]\')?.textContent.trim()',
      ),
      'past',
    );
    assert.equal(
      await js(
        "document.querySelector('[data-workspace-route][data-active=true] [data-review-action]')?.getAttribute('href')",
      ),
      '#/ontology?path=past.md&view=reviews',
    );
    assert(
      requests.some((request: string): boolean =>
        request.endsWith('/review-queue/query'),
      ),
    );
    await js(
      'document.querySelector(\'nav[aria-label="기본 메뉴"] a[href="#/sessions"]\').click()',
    );
    await until(
      "document.querySelector('header h1')?.textContent === 'AI 세션'",
    );
    await js(
      'document.querySelector(\'nav[aria-label="기본 메뉴"] a[href="#/review"]\').click()',
    );
    await until(
      "[...document.querySelectorAll('[data-workspace-route][data-active=true] h2')].some(e=>e.textContent.trim()==='review')",
    );
    // 다시 열면 목록을 새로 읽으므로 이전 선택 상세는 갱신이 끝나기 전 잠시 남을 수 있고 끝나면 사라져야 합니다.
    await until(
      "!document.querySelector('[data-workspace-route][data-active=true] [data-review-detail]')",
    );
    assert.equal(
      await js(
        "document.querySelectorAll('[data-workspace-route][data-active=true]').length",
      ),
      1,
    );
    console.log(
      'PASS actual App route/menu, HTTP review queue, existing exact review links, sessions navigation and retained reactivation; no mutation',
    );
  } finally {
    window.destroy();
    await stop?.();
  }
}
void run()
  .then((): void => app.exit(0))
  .catch((error: unknown): void => {
    console.error(error);
    app.exit(1);
  });

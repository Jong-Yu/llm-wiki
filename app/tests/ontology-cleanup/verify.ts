import assert from 'node:assert/strict';
import { readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { registerConnectionHandlers } from '@main/ipc/registerConnectionHandlers';
import { auditAccessibility } from '../accessibility/audit';

/** 모든 검증 경로는 실행기가 만든 임시 공간으로 제한합니다. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated setting: ${name}`);
  return value;
}
const root = required('WIKI_CLEANUP_ROOT');
const appRoot = required('WIKI_CLEANUP_APP');
const serverUrl = required('WIKI_CLEANUP_URL');
app.setPath('userData', join(root, 'electron-user'));
app.setName('LLM Wiki Clean Up isolated verification');
let window: BrowserWindow;
const windows = new Set<BrowserWindow>();
let stop: (() => Promise<void>) | undefined;
const originalFetch = globalThis.fetch;
let writes = 0;
let loseNext = false;
let loseBeforeSend = false;
let failPreview = false;
let releasePreview: (() => void) | null = null;
let delayNextPreview = false;

/** 실제 HTTP를 사용하며 실패 조건에 한해 전송 완료 뒤 응답을 유실시킵니다. */
globalThis.fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  const mutation =
    init?.method === 'POST' &&
    /\/documents\/(cleanup|cleanup-undos)$/.test(url);
  if (mutation) writes += 1;
  if (mutation && loseBeforeSend) {
    loseBeforeSend = false;
    throw new Error('simulated unconfirmed dispatch');
  }
  if (failPreview && url.includes('/cleanup-preview'))
    throw new Error('simulated offline');
  const response = await originalFetch(input, init);
  if (delayNextPreview && url.includes('/cleanup-preview')) {
    delayNextPreview = false;
    await new Promise<void>((resolve: () => void): void => {
      releasePreview = resolve;
    });
  }
  if (mutation && loseNext) {
    loseNext = false;
    await response.body?.cancel();
    throw new Error('simulated lost receipt');
  }
  return response;
};

/** 렌더러의 실제 DOM과 공개 bridge만 사용합니다. */
async function js(source: string): Promise<unknown> {
  try {
    return await window.webContents.executeJavaScript(source);
  } catch (error: unknown) {
    const body = await window.webContents.executeJavaScript(
      'document.body.innerText',
    );
    throw new Error(`Renderer evaluation failed: ${source}\n${body}`, {
      cause: error,
    });
  }
}
/** 비동기 UI가 기대 상태에 도착했는지 제한 시간 안에 확인합니다. */
async function until(source: string): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (await js(source)) return;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 50);
    });
  }
  const body = await js('document.body.innerText');
  throw new Error(
    `UI condition timed out: ${source}\n${typeof body === 'string' ? body : 'Unavailable DOM'}`,
  );
}
/** 접근 가능한 버튼의 문구를 기준으로 실제 클릭을 보냅니다. */
async function click(label: string): Promise<void> {
  await until(
    `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0 && !b.disabled)`,
  );
  await js(
    `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0); if (!button || button.disabled) throw new Error('Button not available: ' + ${JSON.stringify(label)}); button.click(); })()`,
  );
  await js(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
}
/** React 네이티브 입력 이벤트를 보내 이유를 입력합니다. */
async function reason(value: string): Promise<void> {
  await js(
    `(() => { const field = document.querySelector('[data-workspace-page]:not([hidden]) textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', {bubbles:true})); })()`,
  );
}
/** 선택 문서를 바꾸고 새 미리보기를 명시적으로 읽습니다. */
async function preview(document: string): Promise<void> {
  await until(
    `(() => { const field = document.querySelector('[data-workspace-page]:not([hidden]) select[aria-label="정리할 문서"]'); return !!field && !field.disabled && [...field.options].some(option => option.value === ${JSON.stringify(document)}); })()`,
  );
  await js(
    `(() => { const field = document.querySelector('[data-workspace-page]:not([hidden]) select[aria-label="정리할 문서"]'); field.value = ${JSON.stringify(document)}; field.dispatchEvent(new Event('change', {bubbles:true})); })()`,
  );
  await until(
    `document.querySelector('[data-workspace-page]:not([hidden]) select[aria-label="정리할 문서"]')?.value === ${JSON.stringify(document)}`,
  );
  await click('미리보기');
  await click('새 미리보기 확인');
  await until(
    "!!document.querySelector('[data-workspace-page]:not([hidden]) [aria-label=\"정리 가능한 유형\"]') && [...document.querySelectorAll('[data-workspace-page]:not([hidden]) button')].some(b=>b.textContent.trim()==='새 미리보기 확인' && !b.disabled && b.getAttribute('aria-disabled') !== 'true')",
  );
}
/** 원하는 경우 밝음/어두움·작은 창의 실제 렌더링을 저장합니다. */
async function capture(name: string): Promise<void> {
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 100);
  });
  if (process.env.WIKI_CLEANUP_CAPTURE_DIR)
    await writeFile(
      join(process.env.WIKI_CLEANUP_CAPTURE_DIR, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
}
/** 통과한 동작만 이름으로 기록하며 인증정보를 출력하지 않습니다. */
function pass(name: string): void {
  console.log(`PASS ${name}`);
}

/** 관계 정리는 헤더에서 사라졌으므로 직접 주소로 엽니다. */
async function openCleanup(): Promise<void> {
  // 선택한 문서(document)는 주소에 남아 있으므로 다른 값은 보존하고 view만 바꿉니다.
  await js(
    "(() => { const query = new URLSearchParams(location.hash.split('?')[1] || ''); query.set('view', 'cleanup'); location.hash = '/ontology?' + query; })()",
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '관계 정리'",
  );
}

async function verify(): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.equal(dirname(root), '/private/tmp');
  assert.ok(basename(root).startsWith('wiki-cleanup-ui-'));
  assert.equal(
    await readFile(join(root, 'cleanup-test-root'), 'utf8'),
    'isolated-cleanup-ui-only',
  );
  await app.whenReady();
  const location = pathToFileURL(join(root, 'renderer/index.html')).href;
  let current: BrowserWindow | null = null;
  stop = await registerConnectionHandlers(
    (): BrowserWindow | null => current,
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
    },
  });
  windows.add(window);
  current = window;
  await window.loadURL(location);
  await until("!!document.querySelector('input[name=name]')");
  await js(
    `(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [name, value] of Object.entries(${JSON.stringify({ name: 'Clean Up 검증', serverUrl })})) { const input = document.querySelector('input[name="' + name + '"]'); setter.call(input, value); input.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
  );
  await click('로그인');
  await until('!!document.querySelector(\'a[href="#/ontology"]\')');
  await js('document.querySelector(\'a[href="#/ontology"]\').click()');
  await openCleanup();
  await preview('cleanup.md');
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]').length",
    ),
    1,
  );
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]:checked').length",
    ),
    0,
  );
  assert.ok(
    await js(
      "(() => { const summary = [...document.querySelectorAll('summary')].find(s => s.textContent === '정리 범위와 제외 유형의 이유'); summary.click(); return summary.parentElement.innerText.includes('근거 부족을 틀림으로 바꾸지 않습니다'); })()",
    ),
  );
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) input[type=checkbox]').click(); [...document.querySelectorAll('summary')].find(s => s.textContent === '정리 범위와 제외 유형의 이유').click(); [...document.querySelectorAll('summary')].find(s => s.textContent === '유지되는 근거와 판단').click()",
  );
  assert.equal(
    await js(
      "(() => { const checkbox = document.querySelector('[data-workspace-page]:not([hidden]) input[type=checkbox]'); return ['aria-labelledby', 'aria-describedby'].every(attribute => checkbox.getAttribute(attribute)?.split(/\\s+/).every(id => document.getElementById(id)?.textContent.trim())); })()",
    ),
    true,
  );
  const invalidWrites = writes;
  await click('선택 1개 정리 적용');
  await until(
    "document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.getAttribute('aria-invalid') === 'true'",
  );
  assert.equal(
    await js(
      "document.getElementById(document.activeElement.getAttribute('aria-describedby'))?.getAttribute('role') === 'alert'",
    ),
    true,
  );
  assert.equal(writes, invalidWrites);
  if (process.env.WIKI_A11Y === '1') {
    window.setContentSize(320, 900);
    await auditAccessibility(window, 'cleanup-selected-error-narrow', {
      textSpacing: true,
    });
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) select[aria-label=\"정리할 문서\"]').closest('label').scrollIntoView({block:'center'})",
    );
    await js(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    const labelCheck = await js(`(() => {
      const label = document.querySelector('[data-workspace-page]:not([hidden]) select[aria-label="정리할 문서"]').closest('label');
      const range = document.createRange();
      range.selectNodeContents(label.firstChild);
      const box = range.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const color = getComputedStyle(label).color;
      let background = null;
      for (let node = label; node; node = node.parentElement) {
        const candidate = getComputedStyle(node).backgroundColor;
        if (candidate.startsWith('rgb(')) { background = candidate; break; }
      }
      const luminance = value => value.match(/[\\d.]+/g).slice(0,3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126,.7152,.0722][i], 0);
      const foregroundLuminance = luminance(color);
      const backgroundLuminance = background ? luminance(background) : null;
      const ratio = backgroundLuminance === null ? null : (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
      const visible = box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth && (hit === label || label.contains(hit));
      window.__cleanupLabelCheck = { text: range.toString(), visible, rect: box.toJSON(), viewport: {width: innerWidth, height: innerHeight}, color, background, ratio };
      return window.__cleanupLabelCheck;
    })()`);
    await writeFile(
      join(required('WIKI_A11Y_REPORT_DIR'), 'cleanup-label-after-scroll.json'),
      JSON.stringify(labelCheck, null, 2),
    );
    await writeFile(
      join(required('WIKI_A11Y_REPORT_DIR'), 'cleanup-label-after-scroll.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    assert.equal(await js('window.__cleanupLabelCheck.visible'), true);
    assert.equal(await js('window.__cleanupLabelCheck.ratio >= 4.5'), true);
    window.setContentSize(1280, 900);
  }
  await reason('모의 검토에서 기각한 항목 정리');
  await capture('preview');
  window.setContentSize(480, 740);
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden])').scrollWidth <= document.querySelector('[data-workspace-page]:not([hidden])').clientWidth",
  );
  await capture('preview-narrow');
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) textarea').scrollIntoView({block:'center'})",
  );
  await capture('preview-narrow-action');
  window.setContentSize(1280, 900);
  await click('이전 화면으로');
  await js(
    "(() => { localStorage.setItem('llm-wiki.theme-preference','dark'); window.dispatchEvent(new StorageEvent('storage',{key:'llm-wiki.theme-preference'})); })()",
  );
  await openCleanup();
  await until(
    "document.querySelector('.wiki-theme').dataset.wikiTheme === 'dark'",
  );
  assert.notEqual(
    await js(
      "getComputedStyle(document.querySelector('[data-workspace-page]:not([hidden])')).backgroundColor",
    ),
    'rgb(255, 255, 255)',
  );
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2').scrollIntoView()",
  );
  await capture('preview-dark');
  await auditAccessibility(window, 'cleanup-selected-dark');
  await click('이전 화면으로');
  await js(
    "(() => { localStorage.setItem('llm-wiki.theme-preference','light'); window.dispatchEvent(new StorageEvent('storage',{key:'llm-wiki.theme-preference'})); })()",
  );
  await openCleanup();
  const before = writes;
  await js(
    "(() => { const b = [...document.querySelectorAll('[data-workspace-page]:not([hidden]) button')].find(b => b.textContent.includes('정리 적용')); b.click(); b.click(); })()",
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('1개 항목을 정리했습니다.')",
  );
  assert.equal(writes, before + 1);
  await auditAccessibility(window, 'cleanup-applied-light');
  await preview('cleanup.md');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('이 문서에 정리할 항목이 없습니다.')",
  );
  const raw = await js(
    `(async () => { const c = await window.wiki.connection.getState(); const r = await window.wiki.knowledge.read({connectionId:c.data.connectionId, document:'cleanup.md'}); return r.ok && {raw:r.data.claims.length, current:r.data.currentClaims.length}; })()`,
  );
  assert.deepEqual(raw, { raw: 2, current: 1 });
  pass(
    'real preview, explicit selection, duplicate-click guard, current list refresh and raw claims retained',
  );
  await click('변경 이력');
  await until(
    "!!document.querySelector('[data-workspace-page]:not([hidden]) input[type=radio]:not(:disabled)')",
  );
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) input[type=radio]').click()",
  );
  await reason('정리 되돌림 모의 확인');
  await click('선택한 정리 1개 되돌리기');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('정리를 되돌렸습니다.')",
  );
  await preview('cleanup.md');
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]').length",
    ),
    1,
  );
  pass('real history and undo restore current list');

  await preview('past.md');
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('과거 버전의 검토')",
    ),
  );
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) input[type=checkbox]').click()",
  );
  await reason('과거 판본 검토 정리');
  await click('선택 1개 정리 적용');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('1개 항목을 정리했습니다.')",
  );
  pass('previous-generation review is archived without current approval');
  await preview('empty.md');
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('이 문서에 정리할 항목이 없습니다.')",
    ),
  );
  pass('empty preview is distinct from unsupported types');

  await preview('candidate.md');
  await js(
    "[...document.querySelectorAll('[data-workspace-page]:not([hidden]) summary')].find(s => s.textContent === '유지되는 근거와 판단').click()",
  );
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('제안된 주장')",
    ),
  );
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('저장된 원문 인용이 없습니다')",
    ),
  );
  pass(
    'rejected AI candidate remains a proposal without invented source evidence',
  );

  await preview('many.md');
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]').length",
    ),
    50,
  );
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('일부 결과')",
    ),
  );
  await click('다음 정리 대상 읽기');
  await until(
    "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]').length === 53",
  );
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]:checked').length",
    ),
    0,
  );
  pass(
    'actual cursor pagination shows incomplete range and never selects unseen items',
  );

  failPreview = true;
  await click('새 미리보기 확인');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('처리하지 못했습니다')",
  );
  failPreview = false;
  pass('transport failure is not shown as empty success');
  await preview('cleanup.md');
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) input[type=checkbox]').click()",
  );
  await reason('응답 유실 복구 검증');
  loseNext = true;
  const lostBefore = writes;
  await click('선택 1개 정리 적용');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('저장 결과 확인 필요')",
  );
  await click('이전 화면으로');
  await openCleanup();
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('저장 결과 확인 필요')",
    ),
  );
  await click('저장 결과 확인');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('1개 항목을 정리했습니다.')",
  );
  assert.equal(writes, lostBefore + 1);
  pass(
    'lost mutation response survives close and is resolved by receipt GET without a second write',
  );
  await click('변경 이력');
  await until(
    "!!document.querySelector('[data-workspace-page]:not([hidden]) input[type=radio]:not(:disabled)')",
  );
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) input[type=radio]:not(:disabled)').click()",
  );
  await reason('다음 충돌 검증을 위한 복원');
  await click('선택한 정리 1개 되돌리기');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('정리를 되돌렸습니다.')",
  );
  await preview('cleanup.md');
  await js(
    `(async () => { const c = (await window.wiki.connection.getState()).data; const d = (await window.wiki.documents.content({connectionId:c.connectionId,document:'cleanup.md'})).data; const saved = await window.wiki.workspace.execute({connectionId:c.connectionId,expectedScope:{userId:c.userId,tenant:c.selection.tenant,profileId:c.selection.profile,policyRevision:c.policyRevision,accessRevision:c.accessRevision},operation:'saveDocument',input:{document:'cleanup.md',content:d.content+'Changed after preview.\\n',expected_revision:d.revision}}); if(!saved.ok) throw new Error('Isolated document change failed'); })()`,
  );
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) input[type=checkbox]').click()",
  );
  await reason('오래된 미리보기로 저장 금지');
  await click('선택 1개 정리 적용');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('자료가 변경되었습니다')",
  );
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]').length",
    ),
    0,
  );
  pass(
    'real source revision conflict discards stale preview and requires explicit re-selection',
  );

  await preview('cleanup.md');
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) input[type=checkbox]').click()",
  );
  await reason('미확인 요청은 다시 전송하지 않음');
  loseBeforeSend = true;
  const unconfirmedWrites = writes;
  await click('선택 1개 정리 적용');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('저장 결과 확인 필요')",
  );
  await click('저장 결과 확인');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('저장 기록이 아직 없습니다')",
  );
  assert.equal(writes, unconfirmedWrites + 1);
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) select').disabled",
    ),
  );
  pass(
    'receipt 404 retains unresolved request and never treats missing receipt as cancellation',
  );
  await click('이전 화면으로');
  await js('document.querySelector(\'a[href="#/documents"]\').click()');
  await until(
    '!document.querySelector(\'[aria-label="온톨로지 탐색"]\')?.getBoundingClientRect().width',
  );
  await js('document.querySelector(\'a[href="#/ontology"]\').click()');
  await openCleanup();
  await js(
    "(() => { const select=document.querySelector('[data-workspace-page]:not([hidden]) select'); select.value='cleanup.md'; select.dispatchEvent(new Event('change',{bubbles:true})); })()",
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('저장 기록이 아직 없습니다')",
  );
  pass(
    'unresolved cleanup receipt survives navigation to another menu and back',
  );
  await js('window.wiki.connection.disconnect()');
  await js(
    `window.wiki.connection.authenticate(${JSON.stringify({ name: 'Clean Up 검증', serverUrl, mode: 'login' })})`,
  );
  window.reload();
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '관계 정리'",
  );
  await preview('cleanup.md');
  delayNextPreview = true;
  await click('새 미리보기 확인');
  for (let i = 0; i < 100 && !releasePreview; i += 1)
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 50);
    });
  assert.ok(releasePreview);
  await js('window.wiki.connection.disconnect()');
  releasePreview();
  await until("!document.querySelector('[data-workspace-page]:not([hidden])')");
  pass('late preview after logout cannot restore previous account data');

  const policyPath = join(root, 'server/.local/tenancy/access.json');
  assert.equal(await realpath(policyPath), policyPath);
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  for (const user of Object.values(policy.users)) {
    if (typeof user === 'object' && user !== null && 'memberships' in user) {
      const memberships = user.memberships;
      if (
        typeof memberships === 'object' &&
        memberships !== null &&
        'sdv-platform' in memberships
      ) {
        const membership = memberships['sdv-platform'];
        if (
          typeof membership === 'object' &&
          membership !== null &&
          'permissions' in membership
        )
          membership.permissions = ['read'];
      }
    }
  }
  await writeFile(`${policyPath}.test`, JSON.stringify(policy));
  await rename(`${policyPath}.test`, policyPath);
  // 새 페이지 수명은 실제 read-only 로그인 상태에서 시작합니다.
  await js(
    `window.wiki.connection.authenticate(${JSON.stringify({ name: 'Clean Up 검증', serverUrl, mode: 'login' })})`,
  );
  window.reload();
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '관계 정리'",
  );
  await preview('cleanup.md');
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])').innerText.includes('미리보기와 이력만 조회')",
    ),
  );
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) input[type=checkbox]:not(:disabled)').length",
    ),
    0,
  );
  pass(
    'actual read-only permission allows preview and history but no selection or mutation',
  );
  window.show();
  window.focus();
  await until('document.hasFocus()');
  await js(
    "[...document.querySelectorAll('[data-workspace-page]:not([hidden]) button')].find(b => b.textContent.trim() === '새 미리보기 확인').focus()",
  );
  // 이전 검증의 해제 함수가 남아 있으면 새 지연 요청을 풀지 못하므로 먼저 비웁니다.
  releasePreview = null;
  delayNextPreview = true;
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  // Enter로 버튼을 활성화하려면 keyDown과 char 입력이 함께 필요합니다.
  window.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await until(
    "document.activeElement?.textContent.trim() === '확인 중…' && document.activeElement.getAttribute('aria-disabled') === 'true' && !document.activeElement.disabled",
  );
  for (let count = 0; count < 100 && !releasePreview; count += 1)
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 50);
    });
  assert.ok(releasePreview, 'Delayed preview must be awaiting its response');
  const finishPreview = releasePreview as (() => void) | null;
  finishPreview?.();
  releasePreview = null;
  await until(
    "document.activeElement?.textContent.trim() === '새 미리보기 확인' && document.activeElement.getAttribute('aria-disabled') !== 'true'",
  );
  await capture('preview-keyboard-focus');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await until(
    "document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.textContent === '미리보기'",
  );
  pass(
    'native keyboard preview keeps focus while loading and after completion, then continues into tabs',
  );
}

/** Electron ready는 모듈 평가가 끝난 뒤 발생하므로 최상위 await로 막지 않습니다. */
async function run(): Promise<void> {
  try {
    await verify();
  } catch (error: unknown) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
    for (const opened of windows) opened.destroy();
    await stop?.();
    app.exit(process.exitCode ? 1 : 0);
  }
}
void run();

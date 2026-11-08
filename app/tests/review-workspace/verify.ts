import assert from 'node:assert/strict';
import { auditAccessibility } from '../accessibility/audit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import type { Event, WebContentsConsoleMessageEventParams } from 'electron';

const root = process.env.WIKI_REVIEW_ROOT;
if (!root?.startsWith('/private/tmp/wiki-review-workspace-'))
  throw new Error('Isolated fixture required');
app.setPath('userData', join(root, 'user'));
let window: BrowserWindow | null = null;

/** 렌더러의 실제 DOM과 격리 응답 제어 상태만 읽습니다. */
async function js(source: string): Promise<unknown> {
  if (!window) throw new Error('Window missing');
  try {
    return await window.webContents.executeJavaScript(source);
  } catch (error: unknown) {
    throw new Error(`Renderer operation failed: ${source}`, { cause: error });
  }
}

/** React의 실제 렌더 완료를 한정된 시간 안에서 기다립니다. */
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

/** 모의 자료임이 드러나는 실제 컴포넌트 화면을 전후 비교용으로 남깁니다. */
async function capture(name: string): Promise<void> {
  const directory = process.env.WIKI_REVIEW_CAPTURE_DIR;
  if (!directory || !window) throw new Error('Capture directory missing');
  window.webContents.invalidate();
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  await new Promise<void>((done: () => void): void => {
    setTimeout(done, 200);
  });
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.png`),
    (await window.webContents.capturePage()).toPNG(),
  );
}

/** 보이는 현재 화면의 버튼만 눌러 보관 화면의 행동과 혼동하지 않습니다. */
async function click(label: string): Promise<void> {
  // 좁은 폭에서는 Header 버튼이 "화면 메뉴" 안에 접혀 있으므로 필요하면 먼저 엽니다.
  await js(
    `(() => { const t=document.querySelector('button[aria-label="화면 메뉴"]'); const found=[...document.querySelectorAll('button')].some(b=>(b.textContent.trim()||b.getAttribute('aria-label'))===${JSON.stringify(label)} && b.getBoundingClientRect().width>0); if(t && t.getBoundingClientRect().width>0 && t.getAttribute('aria-expanded')==='false' && !found) t.click(); })()`,
  );
  await until(
    `[...document.querySelectorAll('button')].some(b=>(b.textContent.trim()||b.getAttribute('aria-label'))===${JSON.stringify(label)} && b.getBoundingClientRect().width>0 && !b.disabled)`,
  );
  await js(
    `(() => { const b=[...document.querySelectorAll('button')].find(b=>(b.textContent.trim()||b.getAttribute('aria-label'))===${JSON.stringify(label)} && b.getBoundingClientRect().width>0); b.click(); })()`,
  );
}

/** 좁은 화면에서는 목록으로 복귀한 뒤 행을 선택하고 실제 상세 표시를 기다립니다. */
async function selectReview(kind: string, index: number = 0): Promise<void> {
  const active =
    "document.querySelector('[data-workspace-route][data-active=true]')";
  await js(
    `(() => { const back=[...${active}.querySelectorAll('button')].find(b=>b.textContent.trim()==='목록으로' && b.getBoundingClientRect().width>0); back?.click(); })()`,
  );
  const row = `${active}.querySelectorAll('[data-review-kind=${JSON.stringify(kind)}] [data-review-select]')[${index}]`;
  await until(`${row}?.getBoundingClientRect().width>0`);
  await js(`(() => { const row=${row}; row.focus(); row.click(); })()`);
  await until(
    `${row}?.getAttribute('aria-pressed')==='true' && !!${active}.querySelector('[data-review-detail]')`,
  );
}

/** 검토 상태 필터는 select이므로 보이는 이름의 option을 골라 change를 보냅니다. */
async function chooseFilter(label: string): Promise<void> {
  await js(
    `(() => { const select=document.querySelector('select[aria-label="검토 상태 필터"]'); const option=[...select.options].find(o=>o.textContent.trim()===${JSON.stringify(label)}); select.value=option.value; select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
}

/** 각 응답 상태는 기존 조회 버튼을 통해 요청하며 원래 응답을 임의 덮어쓰지 않습니다. */
async function reload(mode: string): Promise<void> {
  await js(`window.__reviewChecks.mode=${JSON.stringify(mode)}`);
  // 목록을 아직 읽지 못한 오류 화면에서는 오류 카드의 "다시 불러오기"가 조회 버튼입니다.
  const retry = await js(
    `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='다시 불러오기' && b.getBoundingClientRect().width>0)`,
  );
  await click(retry ? '다시 불러오기' : '새로고침');
  await until(
    "!document.querySelector('[data-workspace-route][data-active=true]')?.innerText.includes('검토 항목을 불러오고 있습니다')",
  );
}

/** 신규 화면의 네 종류·범위·페이지·권한·수명을 실제 공개 UI로 검증합니다. */
async function review(): Promise<void> {
  if (!window) throw new Error('Window missing');
  const active =
    "document.querySelector('[data-workspace-route][data-active=true]')";
  const count = `${active}?.querySelectorAll('[data-review-kind]').length`;
  const body = `${active}?.innerText`;
  const workspace = `${active}.querySelector('[data-layout][data-detail-open]')`;
  await until(
    `${count}===3 && !${body}.includes('검토 항목을 불러오고 있습니다')`,
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
  assert.equal(
    await js(`${body}.includes('일부 자료를 확인하지 못했습니다')`),
    false,
  );
  assert.equal(
    await js(
      `document.querySelector('[data-review-coverage] summary')?.textContent.includes('3 / 5건')`,
    ),
    true,
  );
  assert.equal(
    await js(
      `document.querySelector('[data-review-coverage]')?.textContent.includes('조회한 대상 5건 중 3건 불러옴')`,
    ),
    true,
  );
  assert.equal(await js(`${body}.includes('제어기 · 사용 · 센서')`), true);
  assert.equal(await js(`${body}.includes('${'a'.repeat(64)}')`), false);
  assert.equal(await js(`${body}.includes('${'c'.repeat(32)}')`), false);
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-kind="document_claim"]')?.closest('section')?.querySelector('h2')?.textContent.trim()`,
    ),
    '조건 정의',
  );
  assert.equal(
    await js(
      `${active}.querySelectorAll('[data-review-kind] a, [data-review-kind] details').length`,
    ),
    0,
  );
  assert.equal(
    await js(`!!${active}.querySelector('[data-review-detail]')`),
    false,
  );
  assert.equal(await js(`${workspace}?.dataset.detailOpen`), 'false');
  // 넓은 화면은 빈 상세 안내를 보이고 좁은 화면은 상세 패널을 숨깁니다.
  assert.equal(
    await js(
      `${active}.querySelector('section[aria-label="선택한 검토 항목"]')?.hidden`,
    ),
    (await js(`${workspace}?.dataset.layout`)) !== 'wide',
  );
  assert.equal(
    await js(`${active}.querySelectorAll('[data-review-select]').length`),
    3,
  );
  assert.equal(
    await js(`document.querySelector('[data-review-coverage]')?.open`),
    false,
  );
  await js(`document.querySelector('[data-review-coverage] summary').click()`);
  assert.equal(
    await js(
      `document.querySelector('[data-review-coverage]')?.innerText.includes('정해진 한도 안에서 조회한 목록이며')`,
    ),
    true,
  );
  await js(`document.querySelector('[data-review-coverage] summary').click()`);
  await auditAccessibility(window, 'flow-review-list-light', {
    textSpacing: true,
    zoom: true,
  });
  // 원문 주장은 온톨로지의 원문·판단 화면이 상세를 대신하므로 연결 여부만 확인합니다.
  await selectReview('document_claim');
  assert.equal(await js(`${workspace}?.dataset.detailOpen`), 'true');
  assert.equal(
    await js(`${active}.querySelectorAll('[data-review-detail] pre').length`),
    0,
  );
  assert.equal(
    await js(
      `${active}.querySelector('section[aria-label="선택한 검토 항목"]')?.hidden`,
    ),
    false,
  );
  if ((await js(`${workspace}?.dataset.layout`)) === 'wide')
    assert.equal(await js(`getComputedStyle(${workspace}).display`), 'grid');
  await auditAccessibility(window, 'flow-review-detail-light', {
    textSpacing: true,
    zoom: true,
  });
  await capture('review-wide-first-page');
  await click('더 불러오기');
  await until(
    `${count}===5 && document.querySelector('[data-review-coverage] summary')?.textContent.includes('5 / 5건')`,
  );
  await selectReview('pending_document_event');
  assert.equal(
    await js(`${active}.querySelector('[data-review-detail] h2')?.textContent`),
    '이전 기준의 검토 기록',
  );
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-detail] a[href^="#/document?"]')?.textContent.trim()`,
    ),
    '과거 판단',
  );
  assert.equal(await js(`${body}.includes('${'c'.repeat(32)}')`), false);
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-detail]').textContent.includes('${'c'.repeat(32)}')`,
    ),
    false,
  );
  assert.equal(
    await js(
      `${active}.querySelectorAll('[data-review-detail] pre, [data-review-detail] details').length`,
    ),
    0,
  );
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-action]')?.getAttribute('href')`,
    ),
    `#/ontology?path=${encodeURIComponent('과거 판단.md')}&view=reviews`,
  );
  if ((await js(`${workspace}?.dataset.layout`)) === 'wide') {
    await js(`${active}.querySelector('[data-review-detail] button').focus()`);
    await js(
      `${active}.querySelector('button[aria-label="상세 닫기"]').click()`,
    );
    await until(
      `${workspace}?.dataset.detailOpen==='false' && document.activeElement===${active}.querySelector('[data-review-kind="pending_document_event"] [data-review-select]')`,
    );
    assert.equal(
      await js(
        `${active}.querySelector('section[aria-label="선택한 검토 항목"]')?.hidden`,
      ),
      false,
    );
  }
  await selectReview('document_graph');
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-action]')?.getAttribute('href')`,
    ),
    `#/document?path=${encodeURIComponent('변경 문서.md')}`,
  );
  await selectReview('correspondence_judgment');
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-detail]')?.querySelectorAll('a').length`,
    ),
    0,
  );
  assert.equal(
    await js(`${body}.includes('이 항목은 검토 대상 건수에 포함됩니다')`),
    true,
  );
  console.log(
    'PASS actual route/menu and non-claim kinds keep exact targets; hidden correspondences retain counts without navigation',
  );
  await reload('opaque_ids');
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-kind="document_claim"] [data-review-title]')?.textContent`,
    ),
    '원문 주장 · 사용',
  );
  assert.equal(
    await js(
      `${body}.includes('entity_1') || ${body}.includes('${'f'.repeat(32)}')`,
    ),
    false,
  );
  assert.equal(
    await js(
      `getComputedStyle(${active}.querySelector('[data-review-kind="document_claim"] [data-review-title]')).textOverflow`,
    ),
    'ellipsis',
  );
  await reload('ok');
  assert.equal(
    await js(`!!${active}.querySelector('[data-review-detail]')`),
    false,
  );
  await selectReview('document_claim');
  await chooseFilter('보류');
  await until(
    `${count}===1 && document.querySelector('select[aria-label="검토 상태 필터"]').selectedOptions[0].textContent==='보류'`,
  );
  assert.equal(
    await js(`!!${active}.querySelector('[data-review-detail]')`),
    false,
  );
  assert.deepEqual(await js('window.__reviewChecks.queueCalls.at(-1).states'), [
    'defer',
  ]);
  assert.equal(
    await js('window.__reviewChecks.queueCalls.at(-1).cursor'),
    null,
  );
  await chooseFilter('전체');
  await until(`${count}===3`);
  await js('window.__reviewChecks.holdNext=true');
  await click('더 불러오기');
  await until('window.__reviewChecks.waiting');
  await chooseFilter('검토 대기');
  await until(
    `${count}===1 && document.querySelector('select[aria-label="검토 상태 필터"]').selectedOptions[0].textContent==='검토 대기'`,
  );
  await js('window.__reviewChecks.release()');
  await until('!window.__reviewChecks.waiting');
  assert.equal(await js(count), 1);
  assert.equal(await js(`${body}.includes('보류 자료')`), false);
  console.log(
    'PASS filter resets cursor and old next-page response cannot contaminate a new filter',
  );

  await chooseFilter('전체');
  await until(`${count}===3`);
  await js("window.__reviewChecks.mode='network'");
  await click('더 불러오기');
  await until(`${body}.includes('network 모의 응답')`);
  assert.equal(await js(count), 3);
  await reload('ok');
  await selectReview('document_claim');
  await js("window.__reviewChecks.mode='catalog_changed'");
  await click('더 불러오기');
  await until(`${body}.includes('목록을 새로 확인해 주세요')`);
  assert.equal(
    await js(`${active}.querySelectorAll('[data-review-kind]').length`),
    3,
  );
  assert.equal(
    await js(`!!${active}.querySelector('[data-review-detail]')`),
    false,
  );
  await until(
    `document.activeElement===${active}.querySelector('section[aria-label="검토 목록"]')`,
  );
  assert.equal(
    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='더 불러오기' && b.getBoundingClientRect().width>0)?.disabled",
    ),
    true,
  );
  await reload('ok');
  assert.equal(
    await js('window.__reviewChecks.queueCalls.at(-1).cursor'),
    null,
  );
  console.log(
    'PASS ordinary page failure preserves rows; changed catalog blocks pagination and explicit refresh starts over',
  );

  await reload('partial');
  await until(
    `${count}===5 && ${body}.includes('일부 자료를 확인하지 못했습니다')`,
  );
  assert.equal(
    await js(`${body}.includes('더 불러올 페이지는 없습니다')`),
    true,
  );
  await js(`${active}.querySelector('[data-review-skipped] summary').click()`);
  assert.equal(await js(`${body}.includes('누락 문서')`), true);
  assert.equal(await js(`${body}.includes('누락 문서.md')`), false);
  assert.equal(
    await js(
      `${active}.querySelectorAll('[data-review-skipped] details, [data-review-skipped] code').length`,
    ),
    0,
  );
  await capture('review-partial-wide');
  if (!window) throw new Error('Window missing');
  window.setContentSize(480, 900);
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  assert.equal(
    await js('document.documentElement.scrollWidth <= window.innerWidth'),
    true,
  );
  assert.equal(
    await js(`${active}.scrollWidth <= ${active}.clientWidth + 1`),
    true,
  );
  await capture('review-partial-narrow');
  await js(
    "(() => { localStorage.setItem('llm-wiki.theme-preference','dark'); window.dispatchEvent(new StorageEvent('storage',{key:'llm-wiki.theme-preference'})); })()",
  );
  await until(
    "document.querySelector('[data-wiki-theme]')?.dataset.wikiTheme==='dark'",
  );
  await capture('review-partial-narrow-dark');
  await js(
    `${active}.querySelector('[data-review-kind]')?.scrollIntoView({block:'start'})`,
  );
  await capture('review-items-narrow-dark');
  assert.equal(
    await js(
      `[...${active}.querySelectorAll('[data-review-select]')].every(row=>{const height=row.getBoundingClientRect().height;return height>=32&&height<=40;})`,
    ),
    true,
  );
  await selectReview('pending_document_event');
  await until(
    `document.activeElement===${active}.querySelector('[data-review-detail] h2')`,
  );
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-select]')?.getBoundingClientRect().width`,
    ),
    0,
  );
  assert.equal(await js(count), 5);
  assert.equal(
    await js('document.documentElement.scrollWidth <= window.innerWidth'),
    true,
  );
  await auditAccessibility(window, 'flow-review-detail-narrow-dark', {
    textSpacing: true,
  });
  await capture('review-detail-narrow-dark');
  if (process.env.WIKI_A11Y === '1') {
    window.setContentSize(320, 900);
    await auditAccessibility(window, 'flow-review-detail-320-dark', {
      textSpacing: true,
    });
    window.setContentSize(1280, 720);
    await auditAccessibility(window, 'flow-review-partial-zoom-dark', {
      zoom: true,
    });
    window.webContents.setZoomFactor(2);
    await until('innerWidth===640');
    await js(`${active}.querySelector('[data-review-action]').focus()`);
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal(
      await js(
        `(() => { const area=${active}.getBoundingClientRect(); const action=${active}.querySelector('[data-review-action]').getBoundingClientRect(); return action.height>0 && action.top>=area.top && action.bottom<=area.bottom; })()`,
      ),
      true,
      '확대 후 검토 행동이 키보드 focus로 보이는 작업 영역 안에 도달해야 함',
    );
    await capture('review-partial-zoom-action-focused');
    window.webContents.setZoomFactor(1);
    window.setContentSize(480, 900);
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
  }
  await click('목록으로');
  await until(
    `document.activeElement===${active}.querySelector('[data-review-kind="pending_document_event"] [data-review-select]')`,
  );
  assert.equal(
    await js(`!!${active}.querySelector('[data-review-detail]')`),
    false,
  );
  assert.equal(await js(count), 5);
  await reload('partial_empty');
  assert.equal(await js(count), 0);
  assert.equal(
    await js(`${body}.includes('일부 자료는 확인하지 못했습니다')`),
    true,
  );
  await reload('empty');
  assert.equal(
    await js(`${body}.includes('일부 자료를 확인하지 못했습니다')`),
    false,
  );
  assert.equal(await js(`${body}.includes('표시할 항목이 없습니다')`), true);
  console.log(
    'PASS incomplete/limited/no-next-page and empty states remain distinct; 480 width and dark have no overflow',
  );

  await reload('ok');
  await selectReview('document_claim');
  await js('window.__reviewChecks.holdNext=true');
  await click('새로고침');
  await until('window.__reviewChecks.waiting');
  await js(
    "window.__reviewChecks.scope='second'; window.dispatchEvent(new Event('wiki-connection-changed'))",
  );
  await until(`${body}.includes('새 범위 제어기')`);
  await js('window.__reviewChecks.release()');
  await until('!window.__reviewChecks.waiting');
  assert.equal(
    await js(
      `${active}.querySelector('[data-review-kind="document_claim"] [data-review-title]')?.textContent.startsWith('새 범위 제어기')`,
    ),
    true,
  );
  assert.equal(
    await js(`!!${active}.querySelector('[data-review-detail]')`),
    false,
  );
  await reload('forbidden');
  assert.equal(await js(count), 0);
  await reload('ok');
  await reload('wrong_scope');
  assert.equal(await js(count), 0);
  await auditAccessibility(window, 'flow-review-permission-dark');
  await reload('invalid');
  assert.equal(await js(count), 0);
  assert.equal(
    await js(`${body}.includes('응답의 항목과 버전을 확인할 수 없습니다')`),
    true,
  );
  console.log(
    'PASS connection change ignores late prior response; access denial and server scope mismatch clear rows; malformed response is visible',
  );

  await reload('ok');
  await js(
    'document.querySelector(\'nav[aria-label="기본 메뉴"] a[href="#/sessions"]\').click()',
  );
  await until(`document.querySelector('header h1')?.textContent==='AI 세션'`);
  await js(
    'document.querySelector(\'nav[aria-label="기본 메뉴"] a[href="#/review"]\').click()',
  );
  await until(`${count}===3`);
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-route][data-active=true]').length",
    ),
    1,
  );
  const calls = await js('window.__reviewChecks.calls');
  assert(Array.isArray(calls));
  assert(
    calls.every(
      (call: unknown): boolean =>
        typeof call === 'string' &&
        [
          'workspace.reviewQueue',
          'analysis.list',
          'questionRuns.list',
          'aiSessions.read',
          'knowledgeComparisons.list',
        ].includes(call),
    ),
  );
  console.log(
    'PASS read-only workspace lists and sessions navigation perform no approve/write/AI calls',
  );
}

/** 고립된 Electron 창에서 운영 연결 없이 기준 화면과 읽기 호출을 검증합니다. */
async function run(directory: string): Promise<void> {
  await app.whenReady();
  const requests: string[] = [];
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback): void => {
      requests.push(details.url);
      callback({ cancel: true });
    },
  );
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const errors: string[] = [];
  window.webContents.on(
    'console-message',
    (event: Event<WebContentsConsoleMessageEventParams>): void => {
      if (event.level === 'error') errors.push(event.message);
    },
  );
  try {
    const baseline = process.env.WIKI_REVIEW_BASELINE === '1';
    await window.loadURL(
      pathToFileURL(join(directory, 'renderer/index.html')).href +
        (baseline ? '?baseline=1' : ''),
    );
    if (!baseline) {
      await review();
      assert.deepEqual(requests, []);
      assert.deepEqual(errors, []);
      return;
    }
    await until(
      "document.body.innerText.includes('조건 정의 자료 · 모의 분석') && !document.body.innerText.includes('세션을 불러오고 있습니다')",
    );
    assert.equal(
      await js('document.querySelectorAll(\'a[href*="/jobs"]\').length'),
      2,
    );
    await capture('baseline-sessions-wide');
    window.setContentSize(480, 900);
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    await capture('baseline-sessions-narrow');
    assert.equal(
      await js('document.documentElement.scrollWidth <= window.innerWidth'),
      true,
    );
    await js(
      "(() => { localStorage.setItem('llm-wiki.theme-preference','dark'); window.dispatchEvent(new StorageEvent('storage',{key:'llm-wiki.theme-preference'})); })()",
    );
    await until(
      "document.querySelector('[data-wiki-theme]')?.dataset.wikiTheme==='dark'",
    );
    await capture('baseline-sessions-narrow-dark');
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    console.log(
      'PASS baseline actual AppShell/AiSessions, 1280/480 and dark, isolated read-only bridges without network',
    );
  } finally {
    window.destroy();
  }
}
void run(root)
  .then((): void => app.exit(0))
  .catch((error: unknown): void => {
    console.error(error);
    app.exit(1);
  });

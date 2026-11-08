import assert from 'node:assert/strict';
import { auditAccessibility } from '../accessibility/audit';
import { z } from 'zod';
import { readFile, writeFile, realpath, rename } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { registerConnectionHandlers } from '@main/ipc/registerConnectionHandlers';

/** 모든 검증 경로는 실행기가 만든 임시 공간으로 제한합니다. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing isolated setting: ${name}`);
  return value;
}
const root = required('WIKI_REVIEW_ROOT');
const appRoot = required('WIKI_REVIEW_APP');
const serverUrl = required('WIKI_REVIEW_URL');
app.setPath('userData', join(root, 'electron-user'));
app.setName('LLM Wiki relation review isolated verification');
let window: BrowserWindow;
const windows = new Set<BrowserWindow>();
let stop: (() => Promise<void>) | undefined;
const originalFetch = globalThis.fetch;
let writes = 0;
let loseNext = false;
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
    /\/documents\/(reviews|policies|review-undos|policy-undos|relations|relation-undos)$/.test(
      url,
    );
  if (mutation) writes += 1;
  const response = await originalFetch(input, init);
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
    `[...document.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0 && !b.disabled)`,
  );
  await js(
    `(() => { const button = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0); if (!button || button.disabled) throw new Error('Button not available: ' + ${JSON.stringify(label)}); button.click(); })()`,
  );
  await js(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
}
/** 원하는 경우 밝음/어두움·작은 창의 실제 렌더링을 저장합니다. */
async function capture(name: string): Promise<void> {
  window.webContents.invalidate();
  await js(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 250);
  });
  if (process.env.WIKI_REVIEW_CAPTURE_DIR)
    await writeFile(
      join(process.env.WIKI_REVIEW_CAPTURE_DIR, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
}
/** 화살표·그래프 SVG 때문에 자동 확정되지 않은 문자의 실제 불투명 바탕색 대비를 기록합니다. */
async function inspectContrast(label: string): Promise<void> {
  if (process.env.WIKI_A11Y !== '1') return;
  const directory = process.env.WIKI_A11Y_REPORT_DIR;
  if (!directory?.startsWith('/private/tmp/wiki-a11y-'))
    throw new Error('Isolated accessibility report required');
  const rows = z
    .array(
      z.object({
        text: z.string(),
        foreground: z.string(),
        background: z.string(),
        ratio: z.number().nullable(),
      }),
    )
    .parse(
      await js(`(() => {
    const colors = value => (value.match(/[\\d.]+/g) || []).map(Number);
    const luminance = rgb => rgb.slice(0,3).map(x=>{ const s=x/255; return s<=.04045?s/12.92:((s+.055)/1.055)**2.4; }).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
    return [...document.querySelectorAll('select, [aria-label="개념 탐색"] button small, [data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] [role=group][aria-label="관계 이름으로 걸러 보기"] small, [data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] footer span, button[class*="primaryAction"]')].filter(el=>el.checkVisibility()&&!el.closest('[hidden]')&&!el.disabled).map(el=>{
      const foreground=getComputedStyle(el).color; let background='';
      for(let ancestor=el;ancestor;ancestor=ancestor.parentElement){const color=getComputedStyle(ancestor).backgroundColor;const channels=colors(color);if(channels.length===3||channels[3]===1){background=color;break;}}
      const f=colors(foreground), b=colors(background);const a=luminance(f), c=luminance(b);
      return {text:(el.getAttribute('aria-label')||el.textContent||'').trim().slice(0,100),foreground,background,ratio:f.length>=3&&b.length>=3?(Math.max(a,c)+.05)/(Math.min(a,c)+.05):null};
    });
  })()`),
    );
  await writeFile(
    join(directory, label + '-manual-contrast.json'),
    JSON.stringify(rows, null, 2),
  );
  if (process.env.WIKI_A11Y_REPORT_ONLY !== '1')
    for (const row of rows)
      assert.ok(
        row.ratio !== null && row.ratio >= 4.5,
        `${label}: ${row.text} contrast ${row.ratio}`,
      );
}

/** 같은 화면 안에서 근거와 입력의 실제 위치를 비교하고 좁은 폭의 읽기 순서를 보장합니다. */
async function assertComparisonLayout(stacked: boolean): Promise<void> {
  await until(
    `(() => {const comparison=[...document.querySelectorAll('[data-ontology-comparison]')].find(element=>!element.closest('[hidden]'));if(!comparison)return false;const reference=comparison.querySelector('[data-ontology-reference]').getBoundingClientRect();const editor=comparison.querySelector('[data-ontology-editor]').getBoundingClientRect();return ${stacked} ? reference.bottom<=editor.top && Math.abs(reference.left-editor.left)<2 : reference.right<=editor.left && Math.abs(reference.top-editor.top)<2;})()`,
  );
  assert.equal(
    await js('document.documentElement.scrollWidth<=innerWidth'),
    true,
  );
}

/** 개념 카드 안의 이름·종류 줄이 세로로 잘리지 않고 카드끼리 겹치지 않는지 검사합니다. */
async function checkConceptCardText(label: string): Promise<void> {
  const measurements = z
    .array(
      z.object({
        title: z.string(),
        clientHeight: z.number(),
        scrollHeight: z.number(),
        children: z.array(
          z.object({
            text: z.string(),
            clientHeight: z.number(),
            scrollHeight: z.number(),
            lineHeight: z.string(),
            withinCard: z.boolean(),
          }),
        ),
      }),
    )
    .parse(
      await js(`(() => [...document.querySelectorAll('[data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] button[title]:has(strong)')].map(card => {
    const bounds=card.getBoundingClientRect();
    return {title:card.querySelector('strong').textContent,clientHeight:card.clientHeight,scrollHeight:card.scrollHeight,children:[...card.children].map(child => {
      const rect=child.getBoundingClientRect();
      return {text:child.textContent,clientHeight:child.clientHeight,scrollHeight:child.scrollHeight,lineHeight:getComputedStyle(child).lineHeight,withinCard:rect.top>=bounds.top && rect.bottom<=bounds.bottom};
    })};
  }))()`),
    );
  assert.ok(measurements.length > 0, 'Concept cards must be present');
  assert.equal(
    await js(
      `(() => {const rectangles=[...document.querySelectorAll('[data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] button[title]:has(strong)')].map(group=>group.getBoundingClientRect());return rectangles.every((a,index)=>rectangles.slice(index+1).every(b=>a.right<=b.left || b.right<=a.left || a.bottom<=b.top || b.bottom<=a.top));})()`,
    ),
    true,
    'Concept card rectangles must not overlap',
  );
  for (const card of measurements) {
    assert.ok(
      card.scrollHeight <= card.clientHeight,
      `${card.title}: card content overflow`,
    );
    for (const child of card.children) {
      assert.ok(
        child.scrollHeight <= child.clientHeight,
        `${card.title}: clipped ${child.text}`,
      );
      assert.ok(child.withinCard, `${card.title}: ${child.text} outside card`);
    }
  }
  const directory = process.env.WIKI_A11Y_REPORT_DIR;
  if (directory?.startsWith('/private/tmp/wiki-a11y-'))
    await writeFile(
      join(directory, `${label}-geometry.json`),
      JSON.stringify(measurements, null, 2),
    );
}

/** 통과한 동작만 이름으로 기록하며 인증정보를 출력하지 않습니다. */
function pass(name: string): void {
  console.log(`PASS ${name}`);
}

async function verify(): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.equal(dirname(root), '/private/tmp');
  assert.ok(basename(root).startsWith('wiki-review-ui-'));
  assert.equal(
    await readFile(join(root, 'review-test-root'), 'utf8'),
    'isolated-review-ui-only',
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
      backgroundThrottling: false,
    },
  });
  windows.add(window);
  current = window;
  await window.loadURL(location);
  await until("!!document.querySelector('input[name=name]')");
  await js(
    `(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const [name, value] of Object.entries(${JSON.stringify({ name: '관계 검증', serverUrl })})) { const input = document.querySelector('input[name="' + name + '"]'); setter.call(input, value); input.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
  );
  await click('로그인');
  await until('!!document.querySelector(\'a[href="#/ontology"]\')');
  // 전역 시작 화면과 별개인 기존 문서 작업 주소에서 검토·정정 흐름을 검증합니다.
  await js("location.hash='/ontology?document=review.md'");
  await until(
    "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '새 관계' && !b.disabled)",
  );
  assert.equal(await js("document.querySelectorAll('dialog[open]').length"), 0);
  await js("location.hash='/ontology?path=review.md'");
  await until(
    "location.hash === '#/ontology?path=review.md' && !!document.querySelector('[data-workspace-route][data-active=true] [aria-label=\"온톨로지 탐색\"]') && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '새 관계' && !b.disabled)",
  );
  await until(
    "document.querySelector('[data-workspace-route][data-active=true] [aria-label=\"온톨로지 탐색\"]').textContent.includes('1개 문서')",
  );
  await js("location.hash='/ontology?document=review.md'");
  await ready();
  pass(
    'document ontology deep link reads only the requested document without a modal',
  );
  await click('화면에 맞춤');
  await auditAccessibility(window, 'flow-ontology-map-light', {
    textSpacing: true,
    zoom: true,
  });
  await inspectContrast('flow-ontology-map-light');
  await capture('ontology-map-light');
  await js(
    'document.querySelector(\'button[title="누르면 개념 정보를 열고 닫습니다"]\').click()',
  );
  await until(
    'document.querySelectorAll(\'[aria-label="연결된 관계"] button\').length > 0',
  );
  await until(
    "document.querySelector('[aria-label=\"연결된 관계\"]').parentElement.textContent.includes('예약 서비스는 일정 조회 서비스를 사용한다.')",
  );
  assert.equal(
    await js(
      "document.querySelector('[aria-label=\"연결된 관계\"]').parentElement.textContent.includes('개념의 기술 정보')",
    ),
    false,
  );
  await auditAccessibility(window, 'redesign-ontology-concept-light');
  await capture('ontology-concept-connections-light');
  await js(
    'document.querySelector(\'[aria-label="연결된 관계"] button\').click()',
  );
  await click('원문 근거 정정');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent==='원문 근거 정정'",
  );
  await assertComparisonLayout(false);
  await auditAccessibility(window, 'redesign-ontology-correction-light', {
    textSpacing: true,
    zoom: true,
  });
  await capture('ontology-correction-light');
  await field('textarea[name=reason]', '원문을 확인하며 작성 중인 정정 초안');
  window.setContentSize(480, 740);
  await assertComparisonLayout(true);
  await auditAccessibility(window, 'redesign-ontology-correction-narrow', {
    textSpacing: true,
  });
  await capture('ontology-correction-narrow');
  window.setContentSize(320, 740);
  await assertComparisonLayout(true);
  await capture('ontology-correction-320');
  await click('초안 보관하고 돌아가기');
  await click('원문 근거 정정');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) textarea[name=reason]')?.value==='원문을 확인하며 작성 중인 정정 초안'",
  );
  await click('수정안 버리기');
  window.setContentSize(1280, 900);
  await ready();
  pass(
    'concept connections open exact evidence; correction aligns source/form, reflows and retains draft',
  );
  if (process.env.WIKI_REVIEW_INFORMATION_ONLY === '1') return;
  await click('새 관계');
  await openRelationDocument('review.md');
  await until(
    "!![...document.querySelectorAll('[data-pane=details] input[role=combobox]')].find(e=>!e.closest('[hidden]'))",
  );
  // 새 관계는 페이지가 아니라 오른쪽 패널이므로 지도가 계속 보이고, 개념 목록은 넓은 화면에서 함께 보입니다.
  assert.equal(
    await js(
      "(() => { const visible = pane => { const element = document.querySelector('[data-pane=' + pane + ']'); return !!element && !element.closest('[hidden]') && element.getBoundingClientRect().width > 0; }; const wide = document.querySelector('[aria-label=\"온톨로지 탐색\"]').getBoundingClientRect().width >= 1200; return visible('main') && visible('details') && (!wide || visible('index')) && !document.querySelector('[data-workspace-page]:not([hidden])'); })()",
    ),
    true,
  );
  await auditAccessibility(window, 'flow-ontology-relation-form-light', {
    textSpacing: true,
    zoom: true,
  });
  await inspectContrast('flow-ontology-relation-form-light');
  // 저장 버튼은 모든 칸이 차기 전에는 비활성이므로 폼 제출로 검사 오류를 확인합니다.
  assert.equal(
    await js(
      "[...document.querySelectorAll('[data-pane=details] button[type=submit]')].find(e=>!e.closest('[hidden]')).disabled",
    ),
    true,
  );
  await js(
    "[...document.querySelectorAll('[data-pane=details] form')].find(e=>!e.closest('[hidden]')).requestSubmit()",
  );
  await until(
    "[...document.querySelectorAll('[data-pane=details] [aria-invalid=true]')].filter(e=>!e.closest('[hidden]')).length>=3",
  );
  assert.equal(
    await js(
      "[...[...document.querySelectorAll('[data-pane=details] [aria-invalid=true]')].filter(e=>!e.closest('[hidden]'))].every(input=>{const error=document.getElementById(input.getAttribute('aria-describedby'));return error && error.textContent.trim().length>0})",
    ),
    true,
  );
  await auditAccessibility(window, 'flow-ontology-relation-errors-light', {
    textSpacing: true,
  });
  await inspectContrast('flow-ontology-relation-errors-light');
  await field('textarea[name=reason]', '문서별 보관 초안 A');
  await click('대상 문서 변경');
  await pickDocument('candidate.md');
  await until(
    "!![...document.querySelectorAll('[data-pane=details] input[role=combobox]')].find(e=>!e.closest('[hidden]'))",
  );
  assert.equal(
    await js(
      "[...document.querySelectorAll('[data-pane=details] textarea[name=reason]')].find(e=>!e.closest('[hidden]')).value",
    ),
    '',
  );
  await field('textarea[name=reason]', '문서별 보관 초안 B');
  await js('history.back()');
  await until(
    "!![...[...document.querySelectorAll('[data-pane=details] select')].filter(e=>!e.closest('[hidden]'))].find(select => [...select.options].some(option => option.text === '문서 선택'))",
  );
  await pickDocument('review.md');
  await until(
    "[...document.querySelectorAll('[data-pane=details] textarea[name=reason]')].find(e=>!e.closest('[hidden]'))?.value === '문서별 보관 초안 A'",
  );
  assert.equal(await js("document.querySelectorAll('dialog[open]').length"), 0);
  await click('취소');
  pass(
    'new relation drafts stay with their document and browser back restores the chooser',
  );
  await openReviews();
  await js(
    `(() => { const section = [...document.querySelectorAll('[data-workspace-page]:not([hidden]) section')].find(s => s.querySelector('h3')?.textContent === 'review'); section.querySelector('button').click(); })()`,
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '관계 검토'",
  );
  await assertComparisonLayout(false);
  await field('textarea[name=reason]', '원문 검토 탭 초안');
  await capture('ontology-source-review-light');
  await click('전문가 업무 판단');
  await field('textarea[name=reason]', '전문가 판단 탭 초안');
  await assertComparisonLayout(false);
  await auditAccessibility(window, 'redesign-ontology-review-policy-light', {
    textSpacing: true,
  });
  await capture('ontology-expert-judgment-light');
  await click('원문 근거 검토');
  assert.equal(
    await js(
      "[...document.querySelectorAll('[data-workspace-page]:not([hidden]) textarea[name=reason]')].find(element=>!element.closest('[hidden]')).value",
    ),
    '원문 검토 탭 초안',
  );
  window.setContentSize(480, 740);
  await assertComparisonLayout(true);
  await capture('ontology-source-review-narrow');
  window.setContentSize(1280, 900);
  await assertComparisonLayout(false);
  await field('select[name=action]', 'edit');
  await until(
    "!!document.querySelector('[data-workspace-page]:not([hidden]) form select[name^=leaves]')",
  );
  await js(
    `(() => { const form=document.querySelector('[data-workspace-page]:not([hidden]) form'); for(const [label,value] of [['주체','gamma'],['대상','alpha']]) { const f=[...form.querySelectorAll('label')].find(x=>x.textContent.trim().startsWith(label)).querySelector('select'); f.value=value; f.dispatchEvent(new Event('change',{bubbles:true})); } })()`,
  );
  await field('textarea[name=reason]', '격리 원문 정정');
  await click('검토 결과 기록');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  assert.equal(
    await js(
      `(async () => { const c=await window.wiki.connection.getState(); const k=await window.wiki.knowledge.read({connectionId:c.data.connectionId,document:'review.md'}); return k.data.effectiveGraph.relations[0].subject; })()`,
    ),
    'gamma',
  );
  pass('real source review edits endpoints and reloads persisted relation');
  await ready();
  await openReviews();
  await js(
    `(() => { const section = [...document.querySelectorAll('[data-workspace-page]:not([hidden]) section')].find(s => s.querySelector('h3')?.textContent === 'review'); section.querySelector('button').click(); })()`,
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '관계 검토'",
  );
  await click('전문가 업무 판단');
  await js(
    `(() => { const section=document.querySelector('[data-workspace-page]:not([hidden]) section[aria-label="전문가 업무 판단"]'); const f=section.querySelector('textarea[name=reason]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,'격리 업무 판단'); f.dispatchEvent(new Event('input',{bubbles:true})); })()`,
  );
  await click('업무 판단 기록');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  pass('real expert policy records separately from source review');
  await ready();
  await openReviews();
  await js(
    `(() => { const section = [...document.querySelectorAll('[data-workspace-page]:not([hidden]) section')].find(s => s.querySelector('h3')?.textContent === 'review'); section.querySelector('button').click(); })()`,
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '관계 검토'",
  );
  await click('검토 기록');
  await js(
    `[...document.querySelectorAll('[data-workspace-page]:not([hidden]) section[aria-labelledby]')].find(section => document.getElementById(section.getAttribute('aria-labelledby'))?.textContent === '검토 기록').querySelector('button').click()`,
  );
  await until(
    "!!document.querySelector('[data-workspace-page]:not([hidden]) [role=tabpanel]:not([hidden]) textarea')",
  );
  await field(
    '[role=tabpanel]:not([hidden]) textarea[name=reason]',
    '격리 정책 되돌림',
  );
  await click('선택 판단 되돌림 기록');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  pass(
    'real history and policy inverse event preserve prior source correction',
  );
  await ready();
  await click('새 관계');
  await openRelationDocument('review.md');
  await until(
    "[...document.querySelectorAll('[data-pane=details] h2')].find(e=>!e.closest('[hidden]'))?.textContent === '새 관계'",
  );
  // 패널이 열린 동안 개념 목록의 개념을 누르면 비어 있는 주체, 대상 순서로 채워집니다.
  await pickFromIndex('일정 조회 서비스');
  await until(
    "[...document.querySelectorAll('[data-pane=details] input[role=combobox]')].filter(e=>!e.closest('[hidden]')).map(e=>e.value).join('|')==='일정 조회 서비스|'",
  );
  await pickFromIndex('재고 서비스');
  await until(
    "[...document.querySelectorAll('[data-pane=details] input[role=combobox]')].filter(e=>!e.closest('[hidden]')).map(e=>e.value).join('|')==='일정 조회 서비스|재고 서비스'",
  );
  await field('select[name=predicate]', 'depends_on');
  await field('textarea[name=reason]', '빠진 관계를 전문가 의견으로 추가');
  loseNext = true;
  await click('저장');
  await until(
    "[...document.querySelectorAll('[data-pane=details] [role=alert]')].find(e=>!e.closest('[hidden]'))?.innerText.includes('저장')",
  );
  await click('추가 요청 저장 여부 확인');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  const counts = await js(
    `(async()=>{const c=await window.wiki.connection.getState();const k=await window.wiki.knowledge.read({connectionId:c.data.connectionId,document:'review.md'});return {machine:k.data.machineGraph.relations.length,current:k.data.effectiveGraph.relations.length,added:k.data.relationHistory.length,raw:k.data.claims.length};})()`,
  );
  assert.deepEqual(counts, { machine: 1, current: 2, added: 1, raw: 1 });
  pass(
    'new expert relation persists via HTTP/main/preload/UI and lost response is reconciled without duplicate',
  );
  await capture('relation-source');
  window.setContentSize(480, 740);
  await until(
    'document.documentElement.scrollWidth <= document.documentElement.clientWidth',
  );
  await auditAccessibility(window, 'flow-ontology-relation-narrow');
  await inspectContrast('flow-ontology-relation-narrow');
  await capture('relation-narrow');
  window.setContentSize(320, 740);
  await auditAccessibility(window, 'flow-ontology-relation-320-light', {
    textSpacing: true,
  });
  await inspectContrast('flow-ontology-relation-320-light');
  window.setContentSize(1280, 900);
  await ready();
  await openReviews();
  await js(
    `(() => { const section = [...document.querySelectorAll('[data-workspace-page]:not([hidden]) section')].find(s => s.querySelector('h3')?.textContent === 'review'); [...section.querySelectorAll('button')].find(b=>b.textContent.includes('의존성')).click(); })()`,
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '관계 검토'",
  );
  await js(
    `[...document.querySelectorAll('[data-workspace-page]:not([hidden]) section[aria-labelledby]')].find(section => document.getElementById(section.getAttribute('aria-labelledby'))?.textContent === '검토 기록').querySelector('button').click()`,
  );
  await field(
    '[role=tabpanel]:not([hidden]) textarea[name=reason]',
    '독립 추가 되돌림',
  );
  await click('선택 판단 되돌림 기록');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  pass('authored relation can be undone through its own audit record');
  await ready();
  await js(
    "(() => { localStorage.setItem('llm-wiki.theme-preference','dark'); window.dispatchEvent(new StorageEvent('storage',{key:'llm-wiki.theme-preference'})); })()",
  );
  await click('새 관계');
  await openRelationDocument('review.md');
  await until(
    "[...document.querySelectorAll('[data-pane=details] h2')].find(e=>!e.closest('[hidden]'))?.textContent === '새 관계'",
  );
  await fillRelation(
    '예약 서비스',
    'approves',
    '재고 서비스',
    '격리 전문가 새 판단',
  );
  await auditAccessibility(window, 'flow-ontology-policy-dark', {
    textSpacing: true,
  });
  await inspectContrast('flow-ontology-policy-dark');
  await capture('relation-policy-dark');
  await click('저장');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  pass(
    'independent expert relation saves without requiring an existing claim or fabricated evidence',
  );
  await ready();
  await review('candidate.md', '의존성');
  await field('textarea[name=reason]', '근거 없는 후보는 확정할 수 없음');
  await click('근거 확인 후 후보 수용 기록');
  await until(
    "!!document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')",
  );
  assert.equal(await knowledgeCount('candidate.md', 'history'), 0);
  pass('candidate acceptance without evidence fails without adding history');
  await field('select[name=action]', 'defer');
  await click('검토 결과 기록');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  await ready();
  await review('candidate.md', '의존성');
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])')?.innerText.includes('보류')",
    ),
  );
  await field('select[name=action]', 'edit');
  await js(
    `(() => { const label=[...document.querySelectorAll('[data-workspace-page]:not([hidden]) form label')].find(x=>x.textContent.trim()==='원문 인용'); const box=label.parentElement.querySelector('input[type=checkbox]'); if(box?.checked) box.click(); })()`,
  );
  await js(
    `(() => { const f=[...document.querySelectorAll('[data-workspace-page]:not([hidden]) form label')].find(x=>x.textContent.trim()==='원문 인용').querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(f,'일정 조회 서비스는 재고 서비스에 의존한다.'); f.dispatchEvent(new Event('input',{bubbles:true})); })()`,
  );
  await field('textarea[name=reason]', '명시 인용을 확인해 후보 수용');
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=tab]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
  );
  assert.equal(
    await js(
      "document.activeElement?.textContent==='검토 기록' && document.activeElement.getAttribute('aria-selected')==='false'",
    ),
    true,
  );
  await js('document.activeElement.click()');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=tab][aria-selected=true]')?.textContent==='검토 기록'",
  );
  await js(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=tab][aria-selected=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))",
  );
  assert.equal(
    await js(
      "document.activeElement?.textContent==='원문 근거 검토' && document.activeElement.getAttribute('aria-selected')==='false'",
    ),
    true,
  );
  await js('document.activeElement.click()');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=tab][aria-selected=true]')?.textContent==='원문 근거 검토'",
  );
  assert.equal(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) textarea[name=reason]').value",
    ),
    '명시 인용을 확인해 후보 수용',
  );
  await click('근거 확인 후 후보 수용 기록');
  await until(
    "document.body.innerText.includes('관계 변경이 저장되었습니다.')",
  );
  pass(
    'deferred candidate remains selectable; explicit evidence accepts it and arrow keys move focus without selection and explicit tab activation preserves draft',
  );
  await ready();
  await review('review.md', '사용');
  await field('textarea[name=reason]', '충돌 후 보존할 초안');
  await js(
    `(async()=>{const c=(await window.wiki.connection.getState()).data; const k=(await window.wiki.knowledge.read({connectionId:c.connectionId,document:'review.md'})).data; const r=await window.wiki.workspace.execute({connectionId:c.connectionId, expectedScope:{userId:c.userId,tenant:c.selection.tenant,profileId:c.selection.profile,policyRevision:c.policyRevision,accessRevision:c.accessRevision},operation:'review',input:{document:'review.md',action:'defer',claim_id:k.claims[0].claim_id,expected_state_revision:k.stateRevision,reason:'concurrent isolated review',replacement:null}});if(!r.ok)throw new Error('Second reviewer failed');})()`,
  );
  const beforeConflict = writes;
  await click('검토 결과 기록');
  await until(
    "!!document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')",
  );
  assert.equal(writes, beforeConflict + 1);
  assert.equal(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) textarea[name=reason]').value",
    ),
    '충돌 후 보존할 초안',
  );
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) form fieldset').disabled",
    ),
  );
  pass(
    'concurrent reviewer causes conflict, preserves draft, and disables repeated submission',
  );
  await click('검토 초안 버리기');
  await refresh();
  await review('review.md', '사용');
  await field('textarea[name=reason]', '응답 유실 검토');
  const beforeLost = writes;
  loseNext = true;
  await click('검토 결과 기록');
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) [role=alert]')?.innerText.includes('저장 여부')",
  );
  assert.equal(writes, beforeLost + 1);
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) form fieldset').disabled",
    ),
  );
  await click('검토 초안 버리기');
  await refresh();
  await review('review.md', '사용');
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden])')?.innerText.includes('원문 대조 확인')",
    ),
  );
  pass(
    'lost legacy review response blocks resubmission; explicit reread shows saved result',
  );
  await click('검토 초안 버리기');
  await review('past.md', '사용');
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) form fieldset').disabled",
    ),
  );
  await click('검토 기록');
  await js(
    `[...document.querySelectorAll('[data-workspace-page]:not([hidden]) section[aria-labelledby]')].find(section => document.getElementById(section.getAttribute('aria-labelledby'))?.textContent === '검토 기록').querySelector('button').click()`,
  );
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) [role=tabpanel]:not([hidden]) button[type=submit]').disabled",
    ),
  );
  pass(
    'past source review remains visible and cannot be applied or undone as current',
  );
  await auditAccessibility(window, 'flow-ontology-history-dark');
  await inspectContrast('flow-ontology-history-dark');
  await capture('review-history-dark');
  await click('검토 초안 버리기');

  await js('window.wiki.connection.disconnect()');
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
        const member = memberships['sdv-platform'];
        if (
          typeof member === 'object' &&
          member !== null &&
          'permissions' in member
        )
          member.permissions = ['read'];
      }
    }
  }
  await writeFile(`${policyPath}.test`, JSON.stringify(policy));
  await rename(`${policyPath}.test`, policyPath);
  await js(
    `window.wiki.connection.authenticate(${JSON.stringify({ name: '관계 검증', serverUrl, mode: 'login' })})`,
  );
  window.reload();
  await ready();
  await review('review.md', '사용');
  assert.equal(
    await js(
      "document.querySelectorAll('[data-workspace-page]:not([hidden]) form fieldset:not(:disabled)').length",
    ),
    0,
  );
  await click('검토 기록');
  await js(
    `[...document.querySelectorAll('[data-workspace-page]:not([hidden]) section[aria-labelledby]')].find(section => document.getElementById(section.getAttribute('aria-labelledby'))?.textContent === '검토 기록').querySelector('button').click()`,
  );
  assert.ok(
    await js(
      "document.querySelector('[data-workspace-page]:not([hidden]) [role=tabpanel]:not([hidden]) button[type=submit]').disabled",
    ),
  );
  pass(
    'real read-only login can inspect source/policy history and cannot mutate or undo',
  );
  await click('검토 초안 버리기');
  await ready();
  // 숨겨진 Electron 창은 focus 이벤트를 발생시키지 않으므로 실제 키보드 검증 중에만 활성화합니다.
  window.show();
  window.focus();
  // macOS 창 활성화와 본문 초점은 별도이므로 실제 키 입력을 받을 webContents도 명시합니다.
  window.webContents.focus();
  await until('document.hasFocus()');
  await review('review.md', '사용');
  await until(
    "document.activeElement === document.querySelector('[data-workspace-page]:not([hidden]) h2')",
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await until(
    "document.activeElement !== document.body && !!document.activeElement.closest('[data-workspace-page]:not([hidden])') && document.activeElement.getBoundingClientRect().width > 0",
  );
  pass(
    'task entry focuses its heading and native Tab continues within the active review',
  );
  await click('검토 초안 버리기');
  await ready();
  await js(
    'document.querySelector(\'[data-workspace-route][data-active=true] [aria-label="그래프 이동 영역. 방향키, 빈 곳 드래그, 두 손가락 스크롤로 이동하고 핀치로 확대·축소"]\').focus()',
  );
  await until(
    `document.activeElement === document.querySelector('[data-workspace-route][data-active=true] [aria-label="그래프 이동 영역. 방향키, 빈 곳 드래그, 두 손가락 스크롤로 이동하고 핀치로 확대·축소"]')`,
  );
  // 지도 제목 버튼과 구별해 실제 이동하는 개념 카드만 검사합니다.
  for (let count = 0; count < 30; count += 1) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  }
  await until(
    '(() => {const node=document.querySelector(\'[data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] button[title]:has(strong)\').getBoundingClientRect();const region=document.querySelector(\'[data-workspace-route][data-active=true] [aria-label="그래프 이동 영역. 방향키, 빈 곳 드래그, 두 손가락 스크롤로 이동하고 핀치로 확대·축소"]\').getBoundingClientRect();return node.right<region.left;})()',
  );
  for (let count = 0; count < 16; count += 1) {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await js('new Promise(resolve => requestAnimationFrame(resolve))');
    if (
      await js(
        'document.activeElement === document.querySelector(\'[data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] button[title]:has(strong)\')',
      )
    )
      break;
  }
  assert.equal(
    await js(
      'document.activeElement === document.querySelector(\'[data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] button[title]:has(strong)\')',
    ),
    true,
  );
  await until(
    '(() => {const node=document.activeElement.getBoundingClientRect();const region=document.querySelector(\'[data-workspace-route][data-active=true] [aria-label="그래프 이동 영역. 방향키, 빈 곳 드래그, 두 손가락 스크롤로 이동하고 핀치로 확대·축소"]\').getBoundingClientRect();return node.left>=region.left && node.right<=region.right && node.top>=region.top && node.bottom<=region.bottom;})()',
  );
  await checkConceptCardText('ontology-cards-default');
  await capture('ontology-keyboard-focused-node');
  await js(
    `(() => {const style=document.createElement('style');style.id='ontology-cards-spacing';style.textContent='[data-workspace-route][data-active=true] [aria-label="온톨로지 연결 지도"] button[title]:has(strong) * { line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important; }';document.head.append(style);})()`,
  );
  try {
    await checkConceptCardText('ontology-cards-spacing');
    await capture('ontology-cards-spacing');
  } finally {
    await js('document.getElementById("ontology-cards-spacing")?.remove()');
  }
  pass(
    'concept card names and types remain unclipped with default and expanded text spacing',
  );
  pass(
    'native arrow-key graph panning and Tab reveal the focused offscreen node',
  );
}

/** 새로고침 버튼이 없으므로 지도 주소로 돌아간 뒤 창을 다시 읽어 서버 기준을 새로 받습니다. */
async function refresh(): Promise<void> {
  await js("location.hash='/ontology?document=review.md'");
  window.reload();
  await ready();
}
/** 문서별 관계 검토는 헤더에서 사라졌으므로 직접 주소로 엽니다. */
async function openReviews(): Promise<void> {
  await js("location.hash='/ontology?view=reviews'");
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent === '문서별 관계 검토'",
  );
  await until(
    "[...document.querySelectorAll('[data-workspace-page]:not([hidden]) section')].some(section => section.querySelector('h3')?.textContent === 'review' && !!section.querySelector('button'))",
  );
}
/** 이름 검색 combobox에서 개념 이름을 입력하고 목록의 정확한 항목을 고릅니다. */
async function pickConcept(label: string, name: string): Promise<void> {
  const input = `[...${inForm('label')}].find(x=>x.textContent.trim()===${JSON.stringify(label)}).parentElement.querySelector('input[role=combobox]')`;
  await js(`(() => { const i=${input}; i.focus(); })()`);
  await js(
    `(() => { const i=${input}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(name)}); i.dispatchEvent(new Event('input',{bubbles:true})); })()`,
  );
  await until(
    `[...${inForm('[role=listbox] [role=option]')}].some(o=>o.querySelector('span')?.textContent===${JSON.stringify(name)})`,
  );
  await js(
    `[...${inForm('[role=listbox] [role=option]')}].find(o=>o.querySelector('span')?.textContent===${JSON.stringify(name)}).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}))`,
  );
  await until(`${input}.value===${JSON.stringify(name)}`);
}
/** 개념 목록이 접혀 있으면 열고, 이름이 같은 개념 버튼을 누릅니다. */
async function pickFromIndex(name: string): Promise<void> {
  const selector = `[data-workspace-route][data-active=true] [data-pane=index] button[title=${JSON.stringify(`${name} · review.md`)}]`;
  const visible = `(() => { const b = document.querySelector('${selector}'); return !!b && b.getBoundingClientRect().width > 0; })()`;
  if (!(await js(visible))) await click('개념 목록 열기');
  await until(visible);
  await js(`document.querySelector('${selector}').click()`);
}
/** 새 관계 폼은 주체·관계·대상·이유만 받으므로 같은 순서로 채웁니다. */
async function fillRelation(
  subject: string,
  predicate: string,
  object: string,
  reason: string,
): Promise<void> {
  await pickConcept('주체', subject);
  await field('select[name=predicate]', predicate);
  await pickConcept('대상', object);
  await field('textarea[name=reason]', reason);
}

/** 다음 사용자가 열기 전에 저장 후 문서 재조회가 끝났는지 확인합니다. */
async function ready(): Promise<void> {
  await until(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='새 관계' && !b.disabled)",
  );
}
/** 거절·보류·과거 주장도 문서별 목록에서 선택합니다. */
async function review(document: string, predicate: string): Promise<void> {
  await ready();
  await openReviews();
  await js(
    `(() => { const section=[...document.querySelectorAll('[data-workspace-page]:not([hidden]) section')].find(s=>s.querySelector('h3')?.textContent===${JSON.stringify(document.replace(/\.md$/, ''))}); for(const d of section.querySelectorAll('details'))d.open=true; [...section.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(predicate)})).click(); })()`,
  );
  await until(
    "document.querySelector('[data-workspace-page]:not([hidden]) h2')?.textContent==='관계 검토'",
  );
}
/** 실제 서버에서 다시 읽은 감사 이벤트 수를 사용합니다. */
async function knowledgeCount(document: string, key: string): Promise<unknown> {
  return js(
    `(async()=>{const c=await window.wiki.connection.getState();const k=await window.wiki.knowledge.read({connectionId:c.data.connectionId,document:${JSON.stringify(document)}});return k.data[${JSON.stringify(key)}].length;})()`,
  );
}

/** 폼 종류에 맞는 실제 네이티브 입력 이벤트를 보냅니다. */
/** 새 관계 패널의 문서 선택 칸에서 문서를 고릅니다(문서가 여러 개이고 정해지지 않았을 때만 나옵니다). */
async function pickDocument(name: string): Promise<void> {
  const stem = name.replace(/\.md$/i, '');
  await until(
    "!![...[...document.querySelectorAll('[data-pane=details] select')].filter(e=>!e.closest('[hidden]'))].find(select => [...select.options].some(option => option.text === '문서 선택'))",
  );
  await js(
    `(() => { const select=[...[...document.querySelectorAll('[data-pane=details] select')].filter(e=>!e.closest('[hidden]'))].find(element=>[...element.options].some(option=>option.text==='문서 선택')); const option=[...select.options].find(item=>item.text.includes(${JSON.stringify(stem)})); if (!option) throw new Error('Missing document option: ' + ${JSON.stringify(name)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select, option.value); select.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
}
/** 문서가 정해져 폼이 바로 열려도 원하는 문서가 아니면 "대상 문서 변경"으로 고릅니다. */
async function openRelationDocument(name: string): Promise<void> {
  const stem = name.replace(/\.md$/i, '');
  await until(
    "!![...document.querySelectorAll('[data-pane=details] input[role=combobox]')].find(e=>!e.closest('[hidden]')) || !![...[...document.querySelectorAll('[data-pane=details] select')].filter(e=>!e.closest('[hidden]'))].find(select => [...select.options].some(option => option.text === '문서 선택'))",
  );
  const formOpen = await js(
    "!![...document.querySelectorAll('[data-pane=details] input[role=combobox]')].find(e=>!e.closest('[hidden]'))",
  );
  if (formOpen) {
    const current = await js(
      `[...document.querySelectorAll('[data-pane=details]')].find(e=>!e.closest('[hidden]')).innerText.includes(${JSON.stringify(stem)})`,
    );
    if (current) return;
    await click('대상 문서 변경');
  }
  await pickDocument(name);
}
/** 열린 작업 페이지 또는 새 관계 패널(오른쪽 상세 패널) 안의 요소를 찾는 브라우저 쪽 식을 만듭니다. */
function inForm(selector: string): string {
  return `[...document.querySelectorAll('[data-workspace-page]:not([hidden]) ${selector}, [data-pane=details] ${selector}')].filter(e=>!e.closest('[hidden]'))`;
}
async function field(selector: string, value: string): Promise<void> {
  await js(
    `(() => { const f=[...${inForm(selector)}].find(element=>!element.closest('[hidden]')); if (!f) throw new Error('Missing field'); const proto=f.tagName==='SELECT'?HTMLSelectElement.prototype:f.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(f,${JSON.stringify(value)}); f.dispatchEvent(new Event(f.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`,
  );
}
void verify()
  .then((): void => {
    console.log(
      process.env.WIKI_REVIEW_INFORMATION_ONLY === '1'
        ? 'Relation information and correction checks passed'
        : 'Relation review checks passed',
    );
  })
  .catch((error: unknown): void => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async (): Promise<void> => {
    globalThis.fetch = originalFetch;
    for (const item of windows) if (!item.isDestroyed()) item.destroy();
    await stop?.();
    app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });

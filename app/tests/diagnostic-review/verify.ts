import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { auditAccessibility } from '../accessibility/audit';
import type { WebContentsConsoleMessageEventParams, Event } from 'electron';

const root = process.env.WIKI_DIAGNOSTIC_ROOT;
if (!root?.startsWith('/private/tmp/wiki-diagnostic-review-'))
  throw new Error('Isolated fixture required');
app.setPath('userData', join(root, 'user'));
let window: BrowserWindow | null = null;
const errors: string[] = [];
/** 실제 React 화면의 관찰과 합성 fixture 전환만 실행합니다. */
async function js(source: string): Promise<unknown> {
  if (!window) throw new Error('Window missing');
  return window.webContents.executeJavaScript(source);
}
/** 렌더와 비동기 hash 검사를 한정된 시간만 기다립니다. */
async function until(source: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if (await js(source)) return;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 25);
    });
  }
  throw new Error(
    `Timed out: ${source}\n${String(await js('document.body.innerText'))}\n${errors.join('\n')}`,
  );
}
/** 필요한 전후 화면만 지정된 위치에 보관합니다. */
async function capture(name: string): Promise<void> {
  const directory = process.env.WIKI_DIAGNOSTIC_CAPTURE_DIR;
  if (!directory || !window) return;
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.png`),
    (await window.webContents.capturePage()).toPNG(),
  );
}
/** 알려진 fixture로 바꾼 즉시 이전 판본의 진단과 편집 행동이 사라져야 합니다. */
async function change(mode: string): Promise<void> {
  const instant = await js(
    `window.__diagnosticChecks.switch(${JSON.stringify(mode)})`,
  );
  assert.equal(typeof instant, 'string');
  assert(!String(instant).includes('후보에서 조건 A가 빠졌습니다.'));
  assert(!String(instant).includes('진단을 보며 전체 추출 결과 편집'));
}
/** 버튼 상태와 호출 횟수는 실제 DOM에서 확인합니다. */
async function editEnabled(): Promise<unknown> {
  return js(
    "[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='진단을 보며 전체 추출 결과 편집' && !button.disabled)",
  );
}
/** 실제 Electron 모듈 평가를 완료한 후 ready와 React 비동기 표시를 확인합니다. */
async function run(directory: string): Promise<void> {
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 960,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.on(
    'console-message',
    (event: Event<WebContentsConsoleMessageEventParams>): void => {
      if (event.level === 'error') errors.push(event.message);
    },
  );
  await window.loadURL(
    pathToFileURL(join(directory, 'renderer/index.html')).href,
  );
  await until(
    "window.__diagnosticChecks?.ready && document.body.innerText.includes('AI 자기보고')",
  );
  assert.deepEqual(await js('window.__diagnosticChecks.calls'), []);
  if (process.env.WIKI_DIAGNOSTIC_BASELINE === '1') {
    await capture('diagnostic-before-wide');
    window.setContentSize(480, 900);
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    await capture('diagnostic-before-narrow');
    assert.deepEqual(errors, []);
    console.log(
      'PASS current diagnostic baseline, exact report hashes and no bridge calls',
    );
    return;
  }
  let checks = 0;
  assert.deepEqual(await js('window.__diagnosticChecks.lineChecks()'), {
    exactCRLF: true,
    normalizedQuoteRejected: true,
    inflatedRangeRejected: true,
    unavailableReviewedRangeRejected: true,
  });
  checks++;
  await until(
    "document.body.innerText.includes('후보에서 조건 A가 빠졌습니다.')",
  );
  await auditAccessibility(window, 'wf-diagnostics-light', {
    textSpacing: true,
    zoom: true,
  });
  if (process.env.WIKI_A11Y === '1') {
    window.setContentSize(320, 900);
    await auditAccessibility(window, 'wf-diagnostics-narrow', {
      textSpacing: true,
    });
    window.setContentSize(1280, 960);
    await js("document.body.dataset.wikiTheme='dark'");
    await auditAccessibility(window, 'wf-diagnostics-dark');
    await js("document.body.dataset.wikiTheme='light'");
  }
  assert.deepEqual(
    await js(
      "(() => {const value=window.__diagnosticChecks.model('v2');return {ok:value.ok,version:value.report.schema_version,source:value.findings[0].sourceText,target:value.findings[0].target};})()",
    ),
    {
      ok: true,
      version: 2,
      source: '센서는 조건 A에서 경고를 보낸다.\n',
      target: {
        subject: 'sensor',
        predicate: 'produces',
        object: 'warning',
        evidence: '센서는 조건 A에서 경고를 보낸다.',
        condition: null,
      },
    },
  );
  for (const text of [
    '조건 표현을 원문과 다시 대조해야 합니다.',
    '추가 범위는 별도 확인한다는 문장이 구조화되지 않았습니다.',
    '첨부 2쪽의 글자를 확인하지 못했습니다.',
    '조건 A가 충족될 때만 경고를 보내나요?',
    '현재 후보의 관계',
    '원문 인용이 보고되지 않았습니다.',
  ])
    assert.equal(
      await js(`document.body.innerText.includes(${JSON.stringify(text)})`),
      true,
    );
  const candidate = await js(
    `document.querySelector('[aria-label="진단 1의 후보 대상"]').textContent`,
  );
  assert.equal(typeof candidate, 'string');
  for (const text of [
    '센서',
    '경고',
    '원문 근거',
    '센서는 조건 A에서 경고를 보낸다.',
    '조건',
  ])
    assert.equal(String(candidate).includes(text), true);
  assert.equal(String(candidate).includes('relations[0]'), false);
  assert.equal(String(candidate).includes('"subject"'), false);
  assert.equal(
    await js(
      `document.querySelector('[aria-label="진단 1의 후보 대상"] pre') === null`,
    ),
    true,
  );
  assert.equal(await editEnabled(), true);
  checks++;
  console.log(
    'PASS v2 diagnostics expose exact fixed source, candidate target, warnings, omissions, unread ranges and uncertainty',
  );

  await js(
    "document.querySelector('[aria-label=\"진단 항목과 검토 연결\"]').scrollIntoView({block:'start'})",
  );
  await capture('diagnostic-after-wide');
  window.setContentSize(480, 900);
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  assert.equal(
    await js(
      'document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1',
    ),
    true,
  );
  await capture('diagnostic-after-narrow');
  await js("document.body.dataset.wikiTheme='dark'");
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  await capture('diagnostic-after-dark-narrow');
  await js(
    "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='진단을 보며 전체 추출 결과 편집').scrollIntoView({block:'center'})",
  );
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  await capture('diagnostic-after-actions-narrow');
  window.setContentSize(1280, 960);
  await js("document.body.dataset.wikiTheme='light'");
  checks++;

  await js(
    "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='진단을 보며 전체 추출 결과 편집').click()",
  );
  assert.equal(await js('window.__diagnosticChecks.edits'), 1);
  assert.deepEqual(await js('window.__diagnosticChecks.calls'), []);
  await js('window.__diagnosticChecks.lock(true)');
  assert.equal(await editEnabled(), false);
  await js(
    "[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='진단을 보며 전체 추출 결과 편집').click()",
  );
  assert.equal(await js('window.__diagnosticChecks.edits'), 1);
  await js('window.__diagnosticChecks.lock(false)');
  checks++;
  console.log(
    'PASS explicit edit navigation invokes one callback, respects lock and makes no bridge or AI calls',
  );

  await change('v1');
  await until(
    "document.body.innerText.includes('후보에서 조건 A가 빠졌습니다.')",
  );
  assert.equal(
    await js("window.__diagnosticChecks.model('v1').report.schema_version"),
    1,
  );
  assert.equal(await editEnabled(), true);
  assert.equal(
    await js(
      "document.body.innerText.includes('이 응답에는 규칙별 판정이 없습니다.')",
    ),
    true,
  );
  checks++;

  for (const [mode, message] of [
    ['stale', '현재성을 확인하지 못했습니다.'],
    ['tampered', '의미 검사 보고가 기록된 내용과 다릅니다.'],
    ['changed_candidate', '후보·입력·실행 참조가 다르거나'],
  ]) {
    await change(mode);
    await until(`document.body.innerText.includes(${JSON.stringify(message)})`);
    assert.equal(await editEnabled(), false);
    assert.equal(
      await js(
        '!!document.querySelector(\'[aria-label="진단 항목과 검토 연결"]\')',
      ),
      false,
    );
    checks++;
  }
  console.log(
    'PASS stale, tampered and changed-candidate reports never expose current diagnostic actions',
  );

  for (const mode of ['malformed', 'wrong_quote', 'wrong_target']) {
    await change(mode);
    await until(
      "document.body.innerText.includes('진단의 형식·원문 범위·후보 대상을 확인하지 못했습니다.')",
    );
    assert.equal(
      await js(`window.__diagnosticChecks.model(${JSON.stringify(mode)}).ok`),
      false,
    );
    assert.equal(await editEnabled(), false);
    assert.equal(
      await js(
        '!!document.querySelector(\'[aria-label="진단 항목과 검토 연결"]\')',
      ),
      false,
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('summary')].some(node=>node.textContent==='진단 원본·검증된 의미 보고')",
      ),
      false,
    );
    checks++;
  }
  console.log(
    'PASS malformed findings, absent source quotation and out-of-range candidate targets show an explanation without raw reports or structured actions',
  );
  await change('normalized_only');
  await until("document.body.innerText.includes('AI 자기보고')");
  assert.equal(await editEnabled(), false);
  assert.equal(
    await js(
      '!!document.querySelector(\'[aria-label="진단 항목과 검토 연결"]\')',
    ),
    false,
  );
  checks++;

  await js('window.__diagnosticChecks.showForms()');
  await until(`!!document.querySelector('textarea[name="reason"]')`);
  assert.equal(
    await js(
      `!!document.querySelector('textarea[name="contexts"], input[name="id"], textarea[name="replacement"]')`,
    ),
    false,
  );
  await js(
    "[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='미발견 판단 기록').click()",
  );
  await until(
    'document.activeElement?.name === "checkedWhole" && document.activeElement.getAttribute("aria-invalid") === "true"',
  );
  assert.equal(
    await js(
      'document.getElementById(document.activeElement.getAttribute("aria-describedby"))?.textContent.includes("현재 전체 원문")',
    ),
    true,
  );
  if (process.env.WIKI_A11Y === '1') {
    window.setContentSize(320, 900);
    await auditAccessibility(window, 'wf-proposal-checkbox-error-narrow', {
      textSpacing: true,
    });
  }
  checks++;
  console.log(
    'PASS structured proposal restoration keeps internal inputs out of the screen and associates required confirmation errors',
  );

  await js(`(() => {
    const action=document.querySelector('select[name="action"]');
    action.value='keep'; action.dispatchEvent(new Event('change',{bubbles:true}));
    const evidence=document.querySelector('textarea[name="evidence"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(evidence,'센서는 조건 A에서 경고를 보낸다.');
    evidence.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await until("document.body.innerText.includes('복구할 관계')");
  assert.equal(
    await js(`document.querySelector('textarea[name="replacement"]') === null`),
    true,
  );
  await js(
    "[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='미발견 판단 기록').click()",
  );
  await until('window.__diagnosticChecks.lastDecision !== null');
  assert.deepEqual(
    await js('JSON.parse(window.__diagnosticChecks.lastDecision.replacement)'),
    {
      subject: 'sensor',
      predicate: 'produces',
      object: 'warning',
      condition: '조건 A',
      evidence: '센서는 조건 A에서 경고를 보낸다.',
    },
  );
  assert.equal(
    await js('window.__diagnosticChecks.lastDecision.action'),
    'keep',
  );
  await js('window.__diagnosticChecks.calls.length=0');
  checks++;
  console.log(
    'PASS restoration submits the exact new quotation while preserving the original condition and entity references without a JSON editor',
  );

  assert.deepEqual(await js('window.__diagnosticChecks.calls'), []);
  window.setContentSize(1440, 960);
  await js(
    "document.body.dataset.wikiTheme='light'; window.__diagnosticChecks.showWorkspace(false)",
  );
  await until(
    "document.body.innerText.includes('비교할 추출 결과가 없습니다')",
  );
  await capture('proposal-prepare-wide');
  await auditAccessibility(window, 'wf-proposal-prepare-light');
  await js('window.__diagnosticChecks.showWorkspace(true)');
  await until("document.body.innerText.includes('사라진 관계 1')");
  assert.equal(
    await js(
      "document.body.innerText.includes('추가 1') && document.body.innerText.includes('사라짐 1') && document.body.innerText.includes('그대로 0')",
    ),
    true,
  );
  await until("document.body.innerText.includes('자동 검사 통과')");
  await capture('proposal-workspace-wide');
  await js(
    "document.querySelector('[aria-label=\"반영하기\"]')?.scrollIntoView({block:'start'})",
  );
  await capture('proposal-workspace-lower');
  await js(
    "document.querySelector('[aria-label=\"이 화면에서 할 일\"]')?.scrollIntoView({block:'start'})",
  );
  await auditAccessibility(window, 'wf-proposal-workspace-light', {
    textSpacing: true,
  });
  await js(
    "[...document.querySelectorAll('button')].find(x=>x.textContent.includes('판단 입력')).click()",
  );
  await until(
    "[...document.querySelectorAll('button')].some(x=>x.textContent.includes('미발견 판단 기록'))",
  );
  await capture('proposal-selected-wide');
  window.setContentSize(320, 900);
  await auditAccessibility(window, 'wf-proposal-selected-narrow', {
    textSpacing: true,
  });
  await js("document.body.dataset.wikiTheme='dark'");
  await auditAccessibility(window, 'wf-proposal-selected-dark');
  await capture('proposal-selected-dark-narrow');
  assert.deepEqual(
    await js(
      "window.__diagnosticChecks.calls.filter(x=>x.startsWith('proposal:'))",
    ),
    ['proposal:read', 'proposal:validate'],
  );
  checks++;
  assert.deepEqual(errors, []);
  console.log(
    `PASS: ${checks} diagnostic review component, exact-reference and model checks`,
  );
}
void run(root)
  .catch((error: unknown): void => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally((): void => {
    window?.destroy();
    app.exit(process.exitCode ? 1 : 0);
  });

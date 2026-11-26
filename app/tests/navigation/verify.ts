import assert from 'node:assert/strict';
import { auditAccessibility } from '../accessibility/audit';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { registerRuntimeHandlers } from '@main/ipc/registerRuntimeHandlers';
import { registerConnectionHandlers } from '@main/ipc/registerConnectionHandlers';
import { parseSourceRegistrationResult } from '@contracts/sources.contract';
import type { SourceRegistrationRecord } from '@contracts/sources.contract';
import { parseConnectionResult } from '@contracts/connection.contract';

/** 실행기가 생성한 격리 경로만 사용합니다. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing setting: ${name}`);
  return value;
}
const root = required('WIKI_UI_TEST_ROOT');
const appRoot = required('WIKI_UI_APP_ROOT');
const project = required('WIKI_CLIENT_ROOT');
const serverUrl = required('WIKI_UI_TEST_URL');
const active = '[data-workspace-route][data-active="true"]';
app.setPath('userData', join(root, 'electron-user'));
let window: BrowserWindow;
let stop: (() => Promise<void>) | undefined;
let checks = 0;

/** 실제 렌더러와 제품 bridge만 호출합니다. */
async function js(code: string): Promise<unknown> {
  try {
    return await window.webContents.executeJavaScript(code);
  } catch (error: unknown) {
    throw new Error(`UI operation failed: ${code}`, { cause: error });
  }
}
/** 현재 화면의 비동기 전환을 제한 시간 안에서 기다립니다. */
async function until(code: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await js(code)) return;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(
    `Timed out: ${code}\n${String(await js('document.body.innerText'))}`,
  );
}
/** 숨겨 보관 중인 화면의 행동을 누르지 않습니다. */
async function click(label: string): Promise<void> {
  const expression = `Array.from(document.querySelectorAll('button,a')).find(e => e.textContent.trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0 && !e.disabled)`;
  await until(`!!(${expression})`);
  await js(`(${expression}).click()`);
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
}
/** 입력은 실제 네이티브 이벤트를 거쳐 React 초안을 갱신합니다. */
async function input(selector: string, value: string): Promise<void> {
  await until(`!!document.querySelector(${JSON.stringify(selector)})`);
  await js(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('Missing input'); const p = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`,
  );
}
/** 주소 직접 진입 뒤 현재 슬롯이 표시될 때까지 기다립니다. */
async function go(path: string): Promise<void> {
  await js(`location.hash=${JSON.stringify('#' + path)}`);
  await until(
    `location.hash === ${JSON.stringify('#' + path)} && !!document.querySelector(${JSON.stringify(active)})`,
  );
}
/** 현재 표시된 업무 내용만 읽습니다. */
function visibleIncludes(text: string): string {
  // 화면 제목은 앱 Header가 보이므로 활성 화면과 Header를 함께 봅니다.
  return `(document.querySelector(${JSON.stringify(active)})?.innerText.includes(${JSON.stringify(text)}) || document.querySelector('header')?.innerText.includes(${JSON.stringify(text)}))`;
}
/** 실제 제품 캡처는 요청한 증거 경로가 있을 때만 보관합니다. */
async function capture(name: string): Promise<void> {
  await js(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  await auditAccessibility(window, `nav-${name}`, {
    textSpacing: name === 'source-reading-wide',
    zoom: name === 'source-reading-wide',
  });
  if (process.env.WIKI_UI_TEST_CAPTURE_DIR)
    await writeFile(
      join(process.env.WIKI_UI_TEST_CAPTURE_DIR, name + '.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
}
/** 통과한 행동만 기록합니다. */
function pass(name: string): void {
  checks++;
  console.log(`PASS ${name}`);
}

/** 등록도 실제 인증된 HTTP 경로를 사용하며 새 임시 서버에만 씁니다. */
async function registerSource(
  previous?: Extract<SourceRegistrationRecord, { state: 'complete' }>,
): Promise<Extract<SourceRegistrationRecord, { state: 'complete' }>> {
  const fields = {
    kind: 'text',
    requestId: randomUUID().replaceAll('-', ''),
    title: '이동 검증 원본',
    format: 'txt',
    content: [
      previous ? '새 판본 원본 내용' : '이전 판본 원본 내용',
      '',
      '문서 등록과 검토를 위한 운영 안내',
      '',
      '등록된 원본은 전달받은 자료 그대로 보관합니다. 문서를 읽을 때에는 이 자료가 어느 판본인지 먼저 확인하고, 파생된 위키 본문과 함께 검토합니다.',
      '',
      '1. 제목과 등록 시각을 확인합니다.',
      '2. 이전 판본을 선택하여 변경 전 내용을 읽습니다.',
      '3. 원본 파일이 필요한 경우 내려받기를 사용합니다.',
      '',
      '보관된 원본과 편집 가능한 위키는 독립적으로 유지됩니다. 본문을 고치더라도 이 자료의 내용은 그대로 남으며, 이력 비교에서는 선택한 판본을 기준으로 변경 사항을 확인합니다.',
      '',
      '검토가 필요한 내용',
      '자료에 기재된 대상과 범위, 작업 순서와 예외 사항을 확인합니다. 결과가 불확실한 경우에는 저장 상태와 근거를 먼저 읽고 다음 행동을 선택합니다.',
    ].join('\n'),
    ...(previous
      ? {
          target: {
            sourceId: previous.item.sourceId,
            expectedRegistrationRevision: previous.item.registrationRevision,
          },
        }
      : {}),
  };
  const result = parseSourceRegistrationResult(
    await js(
      `(async () => { const c=await window.wiki.connection.getState(); const s=c.data; return window.wiki.sources.register({...${JSON.stringify(fields)},connectionId:s.connectionId,expectedScope:{userId:s.userId,tenant:s.selection.tenant,profileId:s.selection.profile,policyRevision:s.policyRevision,accessRevision:s.accessRevision}}); })()`,
    ),
  );
  assert(result.ok && result.data.state === 'complete');
  return result.data;
}

/** 현재 빌드의 문서·원본·작업 이동과 계정별 보존 수명을 검증합니다. */
async function verify(): Promise<void> {
  assert.equal(await realpath(root), root);
  assert.equal(dirname(root), '/private/tmp');
  assert(basename(root).startsWith('wiki-navigation-ui-'));
  await app.whenReady();
  const location = pathToFileURL(join(appRoot, 'out/renderer/index.html')).href;
  stop = await registerConnectionHandlers(
    (): BrowserWindow | null => window ?? null,
    location,
  );
  window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 960,
    webPreferences: {
      preload: join(appRoot, 'out/preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await registerRuntimeHandlers((): BrowserWindow => window, location);
  await window.loadURL(location);
  await until("!!document.querySelector('input[name=name]')");
  await input('input[name=name]', '이동 격리 검증');
  await input('input[name=serverUrl]', serverUrl);
  await js("document.querySelector('input[value=signup]').click()");
  await click('가입하고 시작');
  await until("document.body.innerText.includes('워크스페이스 배정 대기')");
  const waiting = parseConnectionResult(
    await js('window.wiki.connection.getState()'),
  );
  assert(waiting.ok && waiting.data.status === 'connected');
  assert.equal(waiting.data.selection, null);
  assert.deepEqual(waiting.data.workspaces, []);
  // 가입과 권한 부여를 분리한 제품 동작을 유지하고 새 임시 서버의 시험 계정만 배정합니다.
  execFileSync(
    join(project, '.venv/bin/python'),
    [
      '-c',
      `from pathlib import Path
import sys
from core.modules.access.policy import AccessPolicy
from core.tests.poc_access.fixtures import grant_test_membership_for_user
root = Path(sys.argv[1]).resolve()
assert root.parent == Path('/private/tmp') and root.name.startswith('wiki-navigation-ui-')
server = root / 'server'
policy = AccessPolicy(server / '.local/tenancy/access.json', server / 'data')
grant_test_membership_for_user(policy, sys.argv[2])`,
      root,
      waiting.data.userId,
    ],
    { cwd: project, env: { ...process.env, PYTHONPATH: project } },
  );
  await js(
    'document.querySelector(\'button[aria-label="워크스페이스 배정 다시 확인"]\').click()',
  );
  await until(`!!document.querySelector(${JSON.stringify(active)})`);
  const assigned = parseConnectionResult(
    await js('window.wiki.connection.getState()'),
  );
  assert(assigned.ok && assigned.data.status === 'connected');
  assert.equal(assigned.data.connectionId, waiting.data.connectionId);
  assert.deepEqual(assigned.data.selection, {
    tenant: 'sdv-platform',
    profile: 'default',
  });
  pass(
    'unassigned signup enters the isolated workspace only after explicit assignment refresh',
  );
  const first = await registerSource();
  const second = await registerSource(first);
  execFileSync(
    join(project, '.venv/bin/python'),
    [
      '-c',
      `from pathlib import Path\nimport sys\nfrom core.modules.documents.store import WikiStore\nfrom core.modules.documents.metadata import render_document\nfrom core.modules.ontology.store import OntologyStore\nr=Path(sys.argv[1]); assert r.parent==Path('/private/tmp') and r.name.startswith('wiki-navigation-ui-')\nw=WikiStore(r/'server/data/sdv-platform')\nw.save('navigation-a.md',render_document('Alpha uses Beta.\\n',title='문서 A',source={'id':sys.argv[2],'version':sys.argv[3]}),expected_revision=None)\nw.save('navigation-b.md',render_document('Second document.\\n',title='문서 B'),expected_revision=None)\no=OntologyStore(w)\no.generate('navigation-a.md',w.read('navigation-a.md').revision,[{'id':'alpha','label':'Alpha','type':'system','evidence':'Alpha uses Beta.'},{'id':'beta','label':'Beta','type':'system','evidence':'Alpha uses Beta.'}],[{'subject':'alpha','predicate':'uses','object':'beta','evidence':'Alpha uses Beta.'}])`,
      root,
      first.item.sourceId,
      first.item.sourceVersion,
    ],
    { cwd: project },
  );
  const task = await js(
    `(async () => {const c=await window.wiki.connection.getState(); const s=c.data; return window.wiki.documentTasks.create({connectionId:s.connectionId,expectedScope:{userId:s.userId,tenant:s.selection.tenant,profileId:s.selection.profile,policyRevision:s.policyRevision,accessRevision:s.accessRevision},item:${JSON.stringify(second.item)},targetDocument:'navigation-current.md'});})()`,
  );
  assert(
    task &&
      typeof task === 'object' &&
      'ok' in task &&
      task.ok &&
      'data' in task,
  );
  // fixture는 화면 밖에서 생성했으므로 실제 화면 재진입으로 빈 목록 조회를 갱신합니다.
  await go('/settings');
  await until(visibleIncludes('서버'));
  await go('/documents');
  await until(
    `!!document.querySelector(${JSON.stringify(active + ' input[aria-label="문서 검색"]')})`,
  );
  await input(active + ' input[aria-label="문서 검색"]', '이동 검증 원본');
  await js(
    `document.querySelector(${JSON.stringify(active + ' form[role="search"]')}).requestSubmit()`,
  );
  await until(
    `!!document.querySelector(${JSON.stringify(active + ' a[aria-label*="진행 상세"][href*="taskId="]')})`,
  );
  const listWidth = await js(
    `document.querySelector(${JSON.stringify(active)}).getBoundingClientRect().width`,
  );
  await js(
    `document.querySelector(${JSON.stringify(active + ' a[aria-label*="진행 상세"][href*="taskId="]')}).click()`,
  );
  await until("location.hash.startsWith('#/documents?taskId=')");
  await until(visibleIncludes('문자 변환'));
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(active)}).getBoundingClientRect().width`,
    ),
    listWidth,
  );
  assert.equal(await js("!!document.querySelector('dialog[open]')"), false);
  assert.equal(
    await js(
      `Array.from(document.querySelectorAll(${JSON.stringify(active + ' a,' + active + ' button')})).some(e => ['문서 목록', '등록 진행으로 돌아가기'].includes(e.textContent.trim()))`,
    ),
    false,
  );
  await js('document.querySelector(\'button[aria-label="뒤로가기"]\').click()');
  await until("location.hash === '#/documents'");
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(active + ' input[aria-label="문서 검색"]')}).value`,
    ),
    '이동 검증 원본',
  );
  await until(
    `document.activeElement?.getAttribute('aria-label')?.includes('진행 상세')`,
  );
  const observed = await js(
    `(async()=>{const c=await window.wiki.connection.getState();const s=c.data;return window.wiki.documentTasks.list({connectionId:s.connectionId,expectedScope:{userId:s.userId,tenant:s.selection.tenant,profileId:s.selection.profile,policyRevision:s.policyRevision,accessRevision:s.accessRevision}});})()`,
  );
  assert(
    observed &&
      typeof observed === 'object' &&
      'ok' in observed &&
      observed.ok &&
      'data' in observed,
  );
  assert.equal(
    await js(
      `(async()=>{const c=await window.wiki.connection.getState();const s=c.data;const r=await window.wiki.documentTasks.list({connectionId:s.connectionId,expectedScope:{userId:s.userId,tenant:s.selection.tenant,profileId:s.selection.profile,policyRevision:s.policyRevision,accessRevision:s.accessRevision}});return r.data.items.every(t=>t.conversions.length===0 && t.registration.state==='not_started');})()`,
    ),
    true,
  );
  pass(
    'document status opens a full progress page; return preserves search and focus without executing',
  );
  assert.equal(
    await js(
      `!!document.querySelector(${JSON.stringify(active + ' a[href="#/documents/trash"]')})`,
    ),
    false,
  );
  await js('document.querySelector(\'aside a[aria-label="휴지통"]\').click()');
  await until("location.hash === '#/documents/trash'");
  await until(visibleIncludes('휴지통이 비어 있습니다.'));
  assert.equal(
    await js(
      'document.querySelector(\'aside a[aria-label="휴지통"]\')?.getAttribute("aria-current")',
    ),
    'page',
  );
  assert.equal(
    await js(
      'document.querySelector(\'aside a[aria-label="문서"]\')?.getAttribute("aria-current")',
    ),
    null,
  );
  assert.equal(
    await js(
      `!!document.querySelector(${JSON.stringify(active + ' input[aria-label="문서 검색"]')})`,
    ),
    false,
  );
  assert.equal(
    await js(
      'document.querySelector(\'nav[aria-label="현재 위치"] [aria-current="page"]\')?.textContent',
    ),
    '휴지통',
  );
  await capture('document-trash');
  assert.equal(
    await js(
      'document.querySelector(\'nav[aria-label="현재 위치"]\')?.textContent',
    ),
    '휴지통',
  );
  assert.equal(
    await js('!!document.querySelector(\'button[aria-label="뒤로가기"]\')'),
    false,
  );
  await js('document.querySelector(\'aside a[aria-label="문서"]\').click()');
  await until("location.hash === '#/documents'");
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(active + ' input[aria-label="문서 검색"]')}).value`,
    ),
    '이동 검증 원본',
  );
  await until(
    "document.activeElement?.getAttribute('aria-label')?.includes('진행 상세')",
  );
  pass(
    'sidebar trash opens independently and back restores the document search and prior selection',
  );
  await go('/tasks');
  await until("location.hash === '#/documents'");
  await go('/settings');
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 100);
  });
  assert.equal(await js('location.hash'), '#/settings');
  pass(
    'legacy task list redirects once to documents and stays inactive after leaving',
  );
  const docA = '/document?path=navigation-a.md';
  const docB = '/document?path=navigation-b.md';
  const draft = 'Alpha uses Beta.\n보관할 편집 초안 7319';
  await go(docA);
  await until(visibleIncludes('문서 A'));
  await click('본문 편집');
  await until(
    `!!document.querySelector(${JSON.stringify(active + ' textarea[name=document-markdown]')})`,
  );
  await input(active + ' textarea[name=document-markdown]', draft);
  await input(active + ' input[name=description]', '메뉴 이동 뒤 유지할 설명');
  await click('취소');
  await click('관계 · 최신');
  await until("location.hash.includes('/ontology?path=navigation-a.md')");
  await until(visibleIncludes('Alpha'));
  await go('/settings');
  await until(visibleIncludes('서버'));
  await go(docA);
  await until(visibleIncludes('문서 A'));
  await click('본문 편집');
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(active + ' textarea[name=document-markdown]')}).value`,
    ),
    draft,
  );
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(active + ' input[name=description]')}).value`,
    ),
    '메뉴 이동 뒤 유지할 설명',
  );
  pass(
    'document editor draft and metadata survive ontology/settings navigation',
  );
  await go(docB);
  await until(visibleIncludes('문서 B'));
  await click('본문 편집');
  const ids = await js(
    "[...document.querySelectorAll('textarea[name=document-markdown]')].map(e=>e.id)",
  );
  assert(Array.isArray(ids));
  assert.equal(new Set(ids).size, ids.length);
  await js('history.back()');
  await until(visibleIncludes('문서 B'));
  await js('history.back()');
  await until(visibleIncludes('문서 A'));
  assert.equal(
    await js(
      `document.querySelector(${JSON.stringify(active + ' textarea[name=document-markdown]')}).value`,
    ),
    draft,
  );
  pass(
    'document A/B browser back restores the exact draft; editor label ids stay unique',
  );
  await click('취소');
  await click('원본 보기');
  await until(visibleIncludes('이전 판본 원본 내용'));
  assert.ok(
    await js(`(() => {
    const source = document.querySelector(${JSON.stringify(active)});
    const select = source.querySelector('select').getBoundingClientRect();
    const download = [...source.querySelectorAll('button')].find(button => button.textContent.includes('내려받기')).getBoundingClientRect();
    return select.height === 28 && download.height === 28 && Math.abs(select.top + select.height / 2 - download.top - download.height / 2) < 1;
  })()`),
  );
  await capture('source-reading-wide');
  const originalLocation = await js('location.hash');
  assert(
    typeof originalLocation === 'string' &&
      originalLocation.includes(first.item.sourceVersion),
  );
  await until(visibleIncludes('문서 A'));
  await js(
    `(() => {const e=document.querySelector(${JSON.stringify(active + ' select')});e.value=${JSON.stringify(second.item.sourceVersion)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await until(visibleIncludes('새 판본 원본 내용'));
  await js('history.back()');
  await until(visibleIncludes('이전 판본 원본 내용'));
  await click('생성된 문서: 문서 A');
  await until(
    `!!document.querySelector(${JSON.stringify(active + ' [aria-label="문서 본문"]')})`,
  );
  pass(
    'original exact revision opens, switches versions, goes back, and returns to derived Wiki',
  );
  await go(`/source?sourceId=${first.item.sourceId}&version=${'0'.repeat(32)}`);
  await until(visibleIncludes('최신 버전으로 대체하지 않았습니다'));
  assert.equal(await js(visibleIncludes('새 판본 원본 내용')), false);
  pass(
    'missing original revision is explicit and never replaced with current bytes',
  );
  await go('/route-that-does-not-exist');
  await until(visibleIncludes('이 화면을 찾을 수 없습니다'));
  assert.equal(await js('location.hash'), '#/route-that-does-not-exist');
  pass(
    'unknown route stays explicit instead of silently opening document list',
  );
  await go('/sessions');
  await until(visibleIncludes('AI 세션'));
  await go('/jobs');
  await until(visibleIncludes('분석 작업'));
  await go('/analysis-proposals?document=navigation-a.md');
  await until(visibleIncludes('관계 추출 결과 비교'));
  assert.equal(await js("!!document.querySelector('dialog[open]')"), false);
  pass(
    'session, job, and proposal comparison addresses render actual pages without dialogs',
  );
  await go('/connections?path=navigation-a.md');
  await until("location.hash.startsWith('#/document?path=navigation-a.md')");
  assert.equal(
    await js('!!document.querySelector(\'nav a[href="#/connections"]\')'),
    false,
  );
  await go('/settings');
  await until(visibleIncludes('서버'));
  await new Promise<void>((resolve: () => void): void => {
    setTimeout(resolve, 150);
  });
  assert.equal(await js('location.hash'), '#/settings');
  pass(
    'legacy connections redirect preserves its document and does not navigate again while hidden',
  );
  window.setContentSize(480, 800);
  for (const path of [
    docA,
    `/source?sourceId=${first.item.sourceId}&version=${first.item.sourceVersion}`,
    '/sessions',
    '/analysis-proposals?document=navigation-a.md',
  ]) {
    await go(path);
    await until(`!!document.querySelector(${JSON.stringify(active)})`);
    if (path.startsWith('/source')) {
      await until(visibleIncludes('이전 판본 원본 내용'));
      await capture('source-reading-narrow');
    }
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    const overflow = await js(
      `document.querySelector(${JSON.stringify(active)}).scrollWidth > document.querySelector(${JSON.stringify(active)}).clientWidth + 1`,
    );
    assert.equal(overflow, false, `horizontal overflow at ${path}`);
    assert.equal(
      await js("document.querySelectorAll('dialog[open]').length"),
      0,
    );
  }
  await capture('navigation-narrow-proposal');
  pass(
    '480px document/original/session/proposal pages fit with no blocking dialog',
  );
  window.setContentSize(1280, 960);
  await go(docA);
  await click('본문 편집');
  await capture('navigation-draft-preserved');
  await go('/settings');
  await until(visibleIncludes('서버'));
  await click('로그아웃');
  await until("!!document.querySelector('h1#account-title')");
  assert.equal(
    await js("document.querySelectorAll('[data-workspace-route]').length"),
    0,
  );
  assert.equal(
    await js("document.body.textContent.includes('보관할 편집 초안 7319')"),
    false,
  );
  pass('logout removes hidden retained pages and their private draft DOM');
  console.log(`Navigation integration ${checks} scenarios passed`);
}

void verify()
  .then(async (): Promise<void> => {
    if (stop) await stop();
    window?.destroy();
    app.exit(0);
  })
  .catch(async (error: unknown): Promise<void> => {
    console.error(error);
    if (stop) await stop();
    window?.destroy();
    app.exit(1);
  });

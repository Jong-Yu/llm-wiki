import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import type { Event, WebContentsConsoleMessageEventParams } from 'electron';
import { auditAccessibility } from '../accessibility/audit';

const root = process.env.WIKI_DOCUMENT_TASK_UI_ROOT;
if (!root?.startsWith('/private/tmp/wiki-document-task-ui-'))
  throw new Error('Isolated fixture root required');
app.setPath('userData', join(root, 'user'));
app.setName('LLM Wiki isolated document workflow checks');
let window: BrowserWindow;
const rendererErrors: string[] = [];

/** 테스트 전용 bridge와 표시 중인 DOM만 읽습니다. */
async function js(source: string): Promise<unknown> {
  try {
    return await window.webContents.executeJavaScript(source);
  } catch (cause: unknown) {
    throw new Error(
      `Renderer operation failed: ${source}\n${rendererErrors.join('\n')}`,
      { cause },
    );
  }
}

/** 실제 React controller의 상태 반영을 지정 조건까지 기다립니다. */
async function until(condition: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await js(condition)) return;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(
    `Timed out: ${condition}\n${String(await js('document.body.innerText'))}\nFixture state: ${JSON.stringify(await js("({location:window.__documentTaskLocation, history:window.__documentTaskNavigationHistory, processing:window.__documentTaskChecks.processing(), routes:[...document.querySelectorAll('[data-workspace-route]')].map(e=>({id:e.dataset.workspaceRoute,active:e.dataset.active,hidden:e.hidden}))})"))}`,
  );
}

/** 숨긴 보관 화면의 같은 이름 버튼을 누르지 않습니다. */
async function click(
  label: string,
  selector: string = 'button,a',
): Promise<void> {
  await js(
    `(() => { const item=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0); if (!item || item.disabled) throw new Error('Missing enabled visible control: '+${JSON.stringify(label)}); item.click(); })()`,
  );
}

/** 재시작은 렌더러 메모리와 제품 세션을 새로 만들고 fixture 응답만 유지합니다. */
async function open(route: string): Promise<void> {
  if (!root) throw new Error('Missing test root');
  const target = pathToFileURL(join(root, 'renderer/index.html'));
  target.searchParams.set('route', route);
  await window.loadURL(target.href);
  await until(
    "!!document.querySelector('.wiki-theme') && !!window.__documentTaskChecks",
  );
}

/** 부수 효과 계수는 목록·상태 읽기와 구분해 비교합니다. */
async function effects(): Promise<unknown> {
  return js(
    `(() => { const c=window.__documentTaskChecks.snapshot().counters; return {registrations:c.registrations,creates:c.creates,conversions:c.conversions,analysisStarts:c.analysisStarts,analysisExecutes:c.analysisExecutes}; })()`,
  );
}

/** 실제 테마 저장/구독 경로로 변경하고 하위 AppShell 적용까지 확인합니다. */
async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await js(
    `localStorage.setItem('llm-wiki.theme-preference', ${JSON.stringify(theme)}); window.dispatchEvent(new StorageEvent('storage',{key:'llm-wiki.theme-preference'}))`,
  );
  await until(
    `document.querySelector('.wiki-theme')?.dataset.wikiTheme===${JSON.stringify(theme)}`,
  );
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  await js(
    'Promise.allSettled(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished))',
  );
}

/** 화면·폭·테마별로 긴 제목을 포함한 제품 배치의 넘침을 검사합니다. */
async function layout(name: string): Promise<void> {
  for (const width of [1280, 720, 320]) {
    window.setContentSize(width, 900);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(theme);
      await js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      const geometry = await js(
        `(() => { const root=document.documentElement; const active=document.querySelector('[data-active="true"]'); return {width:innerWidth,documentOverflow:root.scrollWidth-root.clientWidth,activeOverflow:active ? active.scrollWidth-active.clientWidth : 0}; })()`,
      );
      const canvas = await js(
        "getComputedStyle(document.querySelector('.wiki-theme')).getPropertyValue('--wiki-color-surface-canvas').trim().toLowerCase()",
      );
      assert.ok(
        typeof canvas === 'string' &&
          (theme === 'light' ? ['#fff', '#ffffff'] : ['#1f1f1f']).includes(
            canvas,
          ),
        `${name}: actual ${theme} canvas ${String(canvas)}`,
      );
      assert.ok(
        geometry &&
          typeof geometry === 'object' &&
          'documentOverflow' in geometry &&
          typeof geometry.documentOverflow === 'number' &&
          geometry.documentOverflow <= 1,
        `${name} ${width} ${theme}: ${JSON.stringify(geometry)}`,
      );
      assert.ok(
        'activeOverflow' in geometry &&
          typeof geometry.activeOverflow === 'number' &&
          geometry.activeOverflow <= 1,
        `${name} active content overflow: ${JSON.stringify(geometry)}`,
      );
      const directory = process.env.WIKI_DOCUMENT_TASK_CAPTURE_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `${name}-${width}-${theme}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
        await writeFile(
          join(directory, `${name}-${width}-${theme}.json`),
          JSON.stringify({ width, theme, canvas, geometry }, null, 2),
        );
      }
    }
  }
  window.setContentSize(1280, 900);
  await setTheme('light');
}

/** 실제 앱 프레임·등록·작업 controller의 정상/실패 이동을 합성 bridge로 검증합니다. */
async function verify(): Promise<void> {
  await app.whenReady();
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
  window.webContents.on(
    'console-message',
    (event: Event<WebContentsConsoleMessageEventParams>): void => {
      if (
        event.level === 'error' &&
        !event.message.includes('Electron Security Warning')
      )
        rendererErrors.push(event.message);
    },
  );
  try {
    await open('/register');
    await until(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='파일 선택')",
    );
    await click('파일 선택');
    await until(
      "[...document.querySelectorAll('button[type=submit]')].some(b=>!b.disabled)",
    );
    await js(
      "[...document.querySelectorAll('button[type=submit]')].find(b=>!b.disabled && b.getBoundingClientRect().width>0).click()",
    );
    await until(
      "!!document.querySelector('[data-active=true] [data-task-detail]') && document.body.innerText.includes('변환 프로그램이 중단')",
    );
    const taskId = await js(
      "document.querySelector('[data-active=true] [data-task-detail]').dataset.taskDetail",
    );
    assert.equal(typeof taskId, 'string');
    assert.deepEqual(await effects(), {
      registrations: 1,
      creates: 1,
      conversions: 1,
      analysisStarts: 0,
      analysisExecutes: 0,
    });
    assert.equal(
      await js(
        "document.querySelector('[data-active=true] [aria-label=\"문서 처리 단계\"]').textContent.includes('원본 보관')",
      ),
      true,
    );
    assert.equal(
      await js(
        "document.querySelector('[data-active=true] [aria-label=\"문서 처리 단계\"]').textContent.includes('Wiki 저장')",
      ),
      true,
    );
    await layout('conversion-failure');
    await auditAccessibility(window, 'document-task-failure', {
      textSpacing: true,
    });
    console.log(
      'PASS registered source creates task before conversion and exposes actionable worker_failed with four stages',
    );

    await click('문서 목록', 'a');
    await until(
      "document.querySelector('[data-active=true] [data-fixture-destination]')?.textContent==='/documents'",
    );
    await click('작업 목록', 'a');
    await until(
      "document.querySelectorAll('[data-active=true] [data-task-id]').length===1",
    );
    await js(
      "[...document.querySelectorAll('[data-active=true] [aria-label=\"작업 상태\"] button')].find(b=>b.textContent.trim().startsWith('조치 필요')).click()",
    );
    await until(
      "document.querySelectorAll('[data-active=true] [data-task-id]').length===1",
    );
    await js(
      "document.querySelector('[data-active=true] [data-task-id] a').click()",
    );
    await until(
      "!!document.querySelector('[data-active=true] [data-task-detail]')",
    );
    assert.equal(
      await js(
        "document.querySelector('[data-active=true] [data-task-detail]').dataset.taskDetail",
      ),
      taskId,
    );
    assert.deepEqual(await effects(), {
      registrations: 1,
      creates: 1,
      conversions: 1,
      analysisStarts: 0,
      analysisExecutes: 0,
    });
    console.log(
      'PASS leaving and opening failed task retains identity and does not dismiss attention or repeat processing',
    );

    await js(
      "(() => { const source=window.__documentTaskChecks.snapshot().tasks[0].source; window.__documentTaskNavigate('/register?'+new URLSearchParams({sourceId:source.sourceId,version:source.sourceVersion})); })()",
    );
    await until(
      "window.__documentTaskNavigationHistory.some(path=>path.startsWith('/register?sourceId='))",
    );
    await until(
      'window.__documentTaskLocation===' +
        JSON.stringify(`/tasks?taskId=${String(taskId)}`),
    );
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal(
      await js('window.__documentTaskLocation'),
      `/tasks?taskId=${String(taskId)}`,
    );
    assert.deepEqual(await effects(), {
      registrations: 1,
      creates: 1,
      conversions: 1,
      analysisStarts: 0,
      analysisExecutes: 0,
    });
    console.log(
      'PASS legacy source progress address redirects to stable task without registration reset overriding navigation',
    );

    await click('다른 문서 등록', 'a');
    await until(
      "[...document.querySelectorAll('[data-active=true] button')].some(b=>b.textContent.trim()==='파일 선택')",
    );
    assert.equal(
      await js(
        "document.querySelector('[data-active=true]').innerText.includes('가져올 파일')",
      ),
      true,
    );
    await js("window.__documentTaskChecks.nextTitle('두 번째 독립 등록 문서')");
    await click('파일 선택');
    await until(
      "[...document.querySelectorAll('[data-active=true] button[type=submit]')].some(b=>!b.disabled)",
    );
    await js(
      "[...document.querySelectorAll('[data-active=true] button[type=submit]')].find(b=>!b.disabled).click()",
    );
    await until(
      "document.querySelector('[data-active=true] [data-task-detail]')?.dataset.taskDetail!==" +
        JSON.stringify(taskId) +
        " && document.body.innerText.includes('변환 프로그램이 중단')",
    );
    assert.deepEqual(await effects(), {
      registrations: 2,
      creates: 2,
      conversions: 2,
      analysisStarts: 0,
      analysisExecutes: 0,
    });
    await click('작업 목록', 'a');
    await until(
      "document.querySelectorAll('[data-active=true] [data-task-id]').length===2",
    );
    await layout('task-list');
    console.log(
      'PASS new registration opens clean input, creates separate task, and retains original failure',
    );

    const beforeRestart = await effects();
    const legacyPath = await js(
      "(() => { const source=window.__documentTaskChecks.snapshot().tasks[0].source; return '/register?'+new URLSearchParams({sourceId:source.sourceId,version:source.sourceVersion}); })()",
    );
    assert.equal(typeof legacyPath, 'string');
    await open(String(legacyPath));
    await until(
      "!!document.querySelector('[data-active=true] [data-task-detail]') && document.body.innerText.includes('변환 프로그램이 중단')",
    );
    assert.equal(
      await js('window.__documentTaskLocation'),
      `/tasks?taskId=${String(taskId)}`,
    );
    assert.deepEqual(await effects(), beforeRestart);
    await click('새로고침');
    await until(
      "!document.querySelector('[data-active=true] [data-task-detail][aria-busy=true]')",
    );
    assert.deepEqual(await effects(), beforeRestart);
    await click('다시 변환');
    await until(
      "window.__documentTaskChecks.snapshot().counters.conversions===3 && !document.querySelector('[data-active=true] [data-task-detail][aria-busy=true]')",
    );
    assert.equal(
      await js(
        'window.__documentTaskChecks.snapshot().tasks[0].conversions.length',
      ),
      2,
    );
    assert.equal(
      await js(
        'window.__documentTaskChecks.snapshot().tasks[1].conversions.length',
      ),
      1,
    );
    console.log(
      'PASS cold legacy restart and refresh are read-only; explicit retry adds one attempt to original task only',
    );

    await js("window.__documentTaskChecks.scenario('unknown')");
    await open('/tasks?taskId=000000000000000000000000000000c9');
    await until(
      "document.body.innerText.includes('처리 결과를 확인해야 합니다')",
    );
    const unknownEffects = await effects();
    assert.equal(
      await js(
        "[...document.querySelectorAll('button')].some(b=>['다시 변환','본문 준비 시작'].includes(b.textContent.trim()) && b.getBoundingClientRect().width>0)",
      ),
      false,
    );
    await click('결과 확인');
    await until(
      "!document.querySelector('[data-active=true] [data-task-detail][aria-busy=true]')",
    );
    assert.deepEqual(await effects(), unknownEffects);
    await layout('unconfirmed');
    console.log(
      'PASS unconfirmed registration offers result lookup only and creates no new conversion, registration, or AI run',
    );

    await js("window.__documentTaskChecks.scenario('running')");
    await open('/tasks?taskId=000000000000000000000000000000c9');
    await until(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='이 기기 변환 중단' && !b.disabled)",
    );
    const originalSource = await js(
      'window.__documentTaskChecks.snapshot().tasks[0].source',
    );
    const originalAttempt = await js(
      'window.__documentTaskChecks.snapshot().tasks[0].conversions[0].requestId',
    );
    await click('이 기기 변환 중단');
    await until(
      "document.querySelector('[data-active=true] [data-task-detail]').textContent.includes('실행 중단')",
    );
    assert.equal(
      await js(
        'window.__documentTaskChecks.snapshot().counters.conversionCancels',
      ),
      1,
    );
    assert.deepEqual(
      await js('window.__documentTaskChecks.snapshot().tasks[0].source'),
      originalSource,
    );
    assert.equal(
      await js(
        'window.__documentTaskChecks.snapshot().tasks[0].conversions[0].requestId',
      ),
      originalAttempt,
    );
    assert.equal(
      await js(
        'window.__documentTaskChecks.snapshot().tasks[0].conversions.length',
      ),
      1,
    );
    console.log(
      'PASS stopping active conversion cancels the exact existing request and preserves original source and attempt',
    );

    await js("window.__documentTaskChecks.scenario('linked')");
    await open('/tasks?taskId=000000000000000000000000000000c9');
    await until(
      "document.querySelector('[data-active=true] [data-task-detail]')?.textContent.includes('처리 완료')",
    );
    assert.deepEqual(await effects(), {
      registrations: 0,
      creates: 0,
      conversions: 0,
      analysisStarts: 0,
      analysisExecutes: 0,
    });
    assert.equal(
      await js(
        "[...document.querySelectorAll('[data-active=true] [data-task-detail] a')].some(a=>a.getAttribute('href')==='/document?path=fixture-1.md')",
      ),
      true,
    );
    console.log(
      'PASS linked successful analysis restores its saved Wiki receipt without creating or executing another job',
    );

    await js("window.__documentTaskChecks.scenario('previous-success')");
    await open('/tasks?taskId=000000000000000000000000000000c9');
    await until(
      "document.body.innerText.includes('이전 성공 결과는 유지됩니다')",
    );
    const linkedEffects = await effects();
    assert.equal(
      await js(
        "document.querySelector('[data-active=true] [data-task-detail]').textContent.includes('일부 완료')",
      ),
      true,
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('[data-active=true] [data-task-detail] a')].some(a=>a.getAttribute('href')==='/document?path=fixture-1.md')",
      ),
      true,
    );
    await layout('previous-success');
    await auditAccessibility(window, 'document-task-previous-success', {
      textSpacing: true,
    });
    window.show();
    window.focus();
    window.webContents.focus();
    await until('document.hasFocus()');
    await js(
      '[...document.querySelectorAll(\'[data-active=true] [data-task-detail] a[href="/document?path=fixture-1.md"]\')].find(a=>a.getBoundingClientRect().height>0 && !a.closest("details:not([open])")).focus()',
    );
    await until(
      "document.activeElement?.getAttribute('href')==='/document?path=fixture-1.md'",
    );
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(
      "document.querySelector('[data-active=true] [data-fixture-destination]')?.textContent==='/document?path=fixture-1.md'",
    );
    await js("document.querySelector('button[aria-label=뒤로가기]').click()");
    await until(
      "!!document.querySelector('[data-active=true] [data-task-detail]')",
    );
    assert.deepEqual(await effects(), linkedEffects);
    console.log(
      'PASS latest failure remains visible alongside preserved Wiki receipt; keyboard opens exact result and returns without execution',
    );

    await js('window.__documentTaskChecks.deny()');
    await until(
      "!document.querySelector('[data-active=true] [data-task-detail]')",
    );
    assert.equal(
      await js(
        "document.querySelector('[data-active=true]')?.innerText.includes('아주 긴 문서 제목')",
      ),
      false,
    );
    assert.deepEqual(await effects(), linkedEffects);
    console.log(
      'PASS access change removes old task details without mutating preserved work',
    );
    assert.deepEqual(rendererErrors, [], 'Renderer errors');
    console.log(
      'Document workflow UI: 10 scenarios passed; fixture bridge, no real AI or user storage',
    );
  } finally {
    window.destroy();
  }
}

void verify().then(
  (): void => app.exit(0),
  (cause: unknown): void => {
    console.error(cause);
    app.exit(1);
  },
);

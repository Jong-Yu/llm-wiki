import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import type { Event, WebContentsConsoleMessageEventParams } from 'electron';
import { auditAccessibility } from '../accessibility/audit';

const root = process.env.WIKI_VOC_UI_ROOT;
if (!root?.startsWith('/private/tmp/wiki-error-report-'))
  throw new Error('Isolated fixture root required');
app.setPath('userData', join(root, 'user'));
app.setName('LLM Wiki isolated error report checks');
let window: BrowserWindow;
const rendererErrors: string[] = [];
let assertions = 0;

/** 합성 bridge와 실제 제품 DOM만 조회하고 조작합니다. */
async function js(source: string): Promise<unknown> {
  return window.webContents.executeJavaScript(source);
}

/** React 상태와 실제 라우트 전환이 반영될 때까지만 기다립니다. */
async function until(source: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await js(source)) return;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 25);
    });
  }
  throw new Error(
    `Timed out: ${source}\n${String(await js('document.body.innerText'))}\n${JSON.stringify(await js("({calls:window.__vocChecks.calls,mode:window.__vocChecks.mode,content:document.querySelector('textarea')?.value,focus:document.activeElement?.outerHTML})"))}\n${rendererErrors.join('\n')}`,
  );
}

/** 네이티브 값 변경과 input 이벤트로 실제 React 입력 경로를 통과합니다. */
async function fill(content: string): Promise<void> {
  await js(`(() => {
    const input=document.querySelector('[data-active="true"] textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(content)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await until(
    `document.querySelector('[data-active="true"] textarea')?.value===${JSON.stringify(content)}`,
  );
}

/** 보이는 폼만 제출해 보관된 숨김 화면과 혼동하지 않습니다. */
async function submit(): Promise<void> {
  await js(
    'document.querySelector(\'[data-active="true"] button[type=submit]\').click()',
  );
}

/** 사용자 메뉴 이름으로 제품 탐색 링크를 누릅니다. */
async function navigate(label: string, route: string): Promise<void> {
  await js(
    `document.querySelector('aside a[aria-label=${JSON.stringify(label)}]').click()`,
  );
  await until(`window.__vocLocation===${JSON.stringify(route)}`);
}

/** 각 테마/폭의 가로 넘침과 보고 행동의 표시를 검사하고 증거를 저장합니다. */
async function layout(): Promise<void> {
  for (const width of [1280, 320]) {
    window.setContentSize(width, 900);
    for (const theme of ['light', 'dark']) {
      await js(
        `localStorage.setItem('llm-wiki.theme-preference',${JSON.stringify(theme)}); window.dispatchEvent(new StorageEvent('storage',{key:'llm-wiki.theme-preference'}))`,
      );
      await until(
        `document.querySelector('.wiki-theme')?.dataset.wikiTheme===${JSON.stringify(theme)}`,
      );
      await js(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      );
      const result = await js(`(() => {
        const active=document.querySelector('[data-active="true"]');
        const textarea=active.querySelector('textarea').getBoundingClientRect();
        const button=active.querySelector('button[type=submit]').getBoundingClientRect();
        return {overflow:Math.max(document.documentElement.scrollWidth-innerWidth,active.scrollWidth-active.clientWidth),
          textareaInside:textarea.left>=0&&textarea.right<=innerWidth+1,
          buttonInside:button.left>=0&&button.right<=innerWidth+1&&button.width>0};
      })()`);
      assert.ok(
        result &&
          typeof result === 'object' &&
          'overflow' in result &&
          typeof result.overflow === 'number' &&
          result.overflow <= 1,
        `${width} ${theme}: ${JSON.stringify(result)}`,
      );
      assert.ok(
        'textareaInside' in result &&
          result.textareaInside &&
          'buttonInside' in result &&
          result.buttonInside,
        `${width} ${theme}: controls visible`,
      );
      assertions += 2;
      const directory = process.env.WIKI_VOC_CAPTURE_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `error-report-${width}-${theme}.png`),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
      await auditAccessibility(window, `error-report-${width}-${theme}`, {
        textSpacing: true,
      });
    }
  }
  window.setContentSize(1280, 900);
}

/** 보고 폼의 글자만 200% 키워 입력과 주요 행동이 화면 밖으로 나가지 않는지 확인합니다. */
async function textZoom(): Promise<void> {
  await js(
    `(() => { for (const e of document.querySelectorAll('[data-active="true"] form label,[data-active="true"] form textarea,[data-active="true"] form button')) {e.dataset.originalFontSize=e.style.fontSize;e.style.fontSize=(parseFloat(getComputedStyle(e).fontSize)*2)+'px';} })()`,
  );
  try {
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal(
      await js(
        `(() => { const active=document.querySelector('[data-active="true"]');return active.scrollWidth<=active.clientWidth+1&&[...active.querySelectorAll('textarea,button')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth+1;});})()`,
      ),
      true,
    );
    assert.equal(
      await js(
        "(() => {const s=getComputedStyle(document.querySelector('textarea'));return parseFloat(s.lineHeight)>=parseFloat(s.fontSize);})()",
      ),
      true,
      '글자 확대 시 textarea 줄 겹침 방지',
    );
    assertions += 2;
    const directory = process.env.WIKI_VOC_CAPTURE_DIR;
    if (directory)
      await writeFile(
        join(directory, 'error-report-text-200.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
  } finally {
    await js(
      `(() => {for (const e of document.querySelectorAll('[data-original-font-size]')) {e.style.fontSize=e.dataset.originalFontSize;delete e.dataset.originalFontSize;}})()`,
    );
  }
}

/** 명시 보고만 일어나고 성공/실패/중복/복귀가 입력을 올바르게 보존하는지 확인합니다. */
async function verify(): Promise<void> {
  if (!root) throw new Error('Missing root');
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
  await window.loadURL(pathToFileURL(join(root, 'renderer/index.html')).href);
  await until('!!document.querySelector(\'[data-active="true"] textarea\')');
  assert.equal(
    await js("document.querySelector('h1')?.textContent.trim()"),
    '오류 보고',
  );
  assert.equal(
    await js(
      "document.querySelector('aside a[aria-label=\"오류 보고\"]')?.getAttribute('aria-current')",
    ),
    'page',
  );
  assert.equal(await js('window.__vocChecks.calls.length'), 0);
  assertions += 3;

  await submit();
  await until(
    "document.querySelector('textarea')?.getAttribute('aria-invalid')==='true'",
  );
  assert.equal(await js('window.__vocChecks.calls.length'), 0);
  assert.equal(await js('document.activeElement?.tagName'), 'TEXTAREA');
  await fill('  \n\t');
  await submit();
  assert.equal(await js('window.__vocChecks.calls.length'), 0);
  assertions += 3;

  const draft =
    '문서 등록 후 오류가 발생했습니다.\n재현 내용과 한글 입력을 그대로 보존합니다.  ';
  await fill(draft);
  await navigate('문서', '/documents');
  await navigate('오류 보고', '/report');
  assert.equal(
    await js('document.querySelector(\'[data-active="true"] textarea\').value'),
    draft,
  );
  assert.equal(await js('window.__vocChecks.calls.length'), 0);
  assertions += 2;
  await layout();
  await textZoom();

  await js("window.__vocChecks.mode='failure'");
  await submit();
  await until(
    "document.body.innerText.includes('오류 보고를 저장하지 못했습니다.')",
  );
  assert.equal(await js("document.querySelector('textarea').value"), draft);
  assert.deepEqual(await js('window.__vocChecks.calls[0]'), {
    connectionId: 'fixture',
    content: draft,
  });
  assertions += 2;

  await js("window.__vocChecks.mode='throw'");
  await submit();
  await until(
    "document.body.innerText.includes('보고 전송을 확인하지 못했습니다.')",
  );
  assert.equal(await js("document.querySelector('textarea').value"), draft);
  assertions += 1;

  await js("window.__vocChecks.mode='pending'");
  const beforePending = await js(
    "(() => {const r=document.querySelector('button[type=submit]').getBoundingClientRect();return {width:r.width,height:r.height};})()",
  );
  await js(
    `(() => { const form=document.querySelector('[data-active="true"] form'); form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); })()`,
  );
  await until("document.querySelector('button[type=submit]')?.disabled===true");
  const duringPending = await js(
    "(() => {const r=document.querySelector('button[type=submit]').getBoundingClientRect();return {width:r.width,height:r.height};})()",
  );
  assert.deepEqual(duringPending, beforePending, '보고 중 버튼 크기 유지');
  assertions += 1;
  assert.equal(await js('window.__vocChecks.calls.length'), 3);
  assert.equal(await js("document.querySelector('textarea').readOnly"), true);
  assert.equal(
    await js(
      "document.querySelector('button[type=submit]').getAttribute('aria-busy')",
    ),
    'true',
  );
  await navigate('문서', '/documents');
  await js(
    "window.__vocChecks.finish({ok:true,data:{report_id:'a'.repeat(32),created_at:'2026-11-26T00:00:00Z'}})",
  );
  await navigate('오류 보고', '/report');
  await until("document.body.innerText.includes('오류를 보고했습니다.')");
  assert.equal(await js("document.querySelector('textarea').value"), '');
  assert.equal(await js('window.__vocChecks.calls.length'), 3);
  assertions += 5;

  await fill('키보드로 작성한 오류 보고');
  await js("document.querySelector('textarea').focus()");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  assert.equal(await js('window.__vocChecks.calls.length'), 3);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await until("document.activeElement?.getAttribute('type')==='submit'");
  await js("window.__vocChecks.mode='success'");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await until(
    "window.__vocChecks.calls.length===4 && document.querySelector('textarea').value===''",
  );
  assert.deepEqual(rendererErrors, []);
  assertions += 2;
  console.log(
    `Error report UI: ${assertions} checks passed (synthetic bridge, real AppShell/form, 1280/320 light/dark).`,
  );
  window.destroy();
  app.quit();
}

void verify().catch((error: unknown): void => {
  console.error(error);
  app.exit(1);
});

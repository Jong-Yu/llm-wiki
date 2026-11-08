import assert from 'node:assert/strict';
import { auditAccessibility } from '../accessibility/audit';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
/** 테스트 자료는 실행기가 만든 새 임시 경로로만 한정합니다. */
function testRoot(): string {
  const value = process.env.WIKI_CHAT_IA_ROOT;
  if (!value?.startsWith('/private/tmp/wiki-chat-ia-'))
    throw new Error('Isolated test root required');
  return value;
}
const root = testRoot();
app.setPath('userData', join(root, 'user'));
let window: BrowserWindow;
/** 별도 시각 사례를 실제 앱 스타일과 함께 보관합니다. */
async function captureVisual(name: string): Promise<void> {
  const directory = process.env.WIKI_CHAT_IA_CAPTURE;
  if (!directory) return;
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  await writeFile(
    join(directory, name + '.png'),
    (await window.webContents.capturePage()).toPNG(),
  );
}
/** 실제 렌더러 DOM을 읽거나 사용자 입력을 전달합니다. */
async function js(source: string): Promise<unknown> {
  return window.webContents.executeJavaScript(source);
}
/** 대상 UI가 바뀔 때까지 제한된 시간 동안 기다립니다. */
async function until(source: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if (await js(source)) return;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 25);
    });
  }
  throw new Error(
    `Timed out: ${source}\n${String(await js('document.body.innerText'))}`,
  );
}
/** 표시된 버튼만 실행해 숨겨진 영역과 같은 이름의 행동을 혼동하지 않습니다. */
async function click(label: string): Promise<void> {
  await until(
    `[...document.querySelectorAll('button')].some(x=>(x.textContent.trim()===${JSON.stringify(label)}||x.getAttribute('aria-label')===${JSON.stringify(label)})&&!x.disabled&&x.getBoundingClientRect().width>0)`,
  );
  await js(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.textContent.trim()===${JSON.stringify(label)}||x.getAttribute('aria-label')===${JSON.stringify(label)})&&x.getBoundingClientRect().width>0); if(!b||b.disabled)throw new Error('Button unavailable'); b.focus(); b.click(); })()`,
  );
}
/** 내려받기 메뉴에서 형식을 명시 선택해 현행 파일 저장 동작을 실행합니다. */
async function downloadMarkdown(): Promise<void> {
  await click('내려받기');
  const menuItem = `[...document.querySelectorAll('button[role="menuitem"]')].find(x=>x.textContent.startsWith('Markdown (.md)'))`;
  await until(`Boolean(${menuItem})`);
  await js(`(${menuItem}).click()`);
}
async function verify(): Promise<void> {
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadURL(
      pathToFileURL(join(root, 'renderer/index.html')).href +
        '#/chat?conversationId=' +
        'a'.repeat(32),
    );
    await until("document.querySelector('textarea')?.value === 'A의 초안'");
    assert.equal(await js("document.querySelectorAll('dialog').length"), 0);
    await auditAccessibility(window, 'flow-chat-conversation-light', {
      textSpacing: true,
      zoom: true,
    });
    await js(
      "(() => { const p=document.querySelector('[role=log]'); p.scrollTop=250; p.dispatchEvent(new Event('scroll')); })()",
    );
    await js(
      "[...document.querySelectorAll('aside[aria-label=\"대화 목록\"] button')].find(x=>x.innerText.includes('대화 B')).click()",
    );
    await until(
      "location.hash.includes('conversationId='+'b'.repeat(32)) && document.querySelector('textarea')?.value==='B의 초안'",
    );
    await js('history.back()');
    await until("document.querySelector('textarea')?.value==='A의 초안'");
    await until("document.querySelector('[role=log]')?.scrollTop>200");
    console.log('PASS A/B 대화 주소·뒤로가기·개별 초안·스크롤 복원');
    assert.equal(await js('window.__chatChecks.cancels'), 0);
    await click('새 대화');
    await until(
      "document.querySelector('textarea')?.value==='' && location.hash.includes('threadId=')",
    );
    await js("location.hash='/chat?conversationId='+'a'.repeat(32)");
    await until("document.querySelector('textarea')?.value==='A의 초안'");
    assert.equal(await js('window.__chatChecks.cancels'), 0);
    await js('window.__chatChecks.activeRun=false');
    await until(
      "document.body.innerText.includes('보존된 답변의 본문입니다.')",
    );
    console.log(
      'PASS 진행 중 대화에서 다른 대화·새 대화 이동과 초안 보존, 자동 중단 없음',
    );
    await click('example · 1줄');
    await until(
      "location.hash.includes('evidence=0') && document.querySelector('aside[aria-label=\"답변 근거\"]')?.innerText.includes('원문 인용')",
    );
    assert.equal(await js("document.querySelectorAll('dialog').length"), 0);
    // 승인된 채팅의 일반 단추36px·새 대화 아이콘32px·인용 칩24px 크기를 구분합니다.
    const metrics = (await js(
      "['새 대화','example · 1줄','현재 문서 열기'].map(label=>{const element=[...document.querySelectorAll('button,a')].find(x=>(x.textContent.trim()===label || x.getAttribute('aria-label')===label) && x.getBoundingClientRect().width>0);const style=getComputedStyle(element);return [element.getBoundingClientRect().height,style.fontSize,style.lineHeight]})",
    )) as [number, string, string][];
    assert.deepEqual(metrics[0], [32, '13px', '20px']);
    assert.deepEqual(metrics[2], [36, '13px', '20px']);
    assert.equal(metrics[1]?.[0], 24);
    assert.equal(metrics[1]?.[2], '20px');
    if (process.env.WIKI_CHAT_IA_CAPTURE)
      await writeFile(
        join(process.env.WIKI_CHAT_IA_CAPTURE, 'chat-wide.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    await auditAccessibility(window, 'flow-chat-evidence-light', {
      textSpacing: true,
      zoom: true,
    });
    window.setSize(480, 800);
    await until(
      "document.querySelector('aside[aria-label=\"답변 근거\"]').getBoundingClientRect().width>0 && document.querySelector('textarea').getBoundingClientRect().width===0",
    );
    assert.equal(
      await js('document.body.scrollWidth <= innerWidth'),
      true,
      String(
        await js(
          "JSON.stringify({width:innerWidth,scroll:document.body.scrollWidth,overflow:[...document.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>innerWidth).map(x=>[x.tagName,x.className,x.getBoundingClientRect().width])})",
        ),
      ),
    );
    if (process.env.WIKI_CHAT_IA_CAPTURE)
      await writeFile(
        join(process.env.WIKI_CHAT_IA_CAPTURE, 'chat-narrow.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    await js("document.documentElement.dataset.wikiTheme='dark'");
    await auditAccessibility(window, 'flow-chat-evidence-narrow-dark');
    if (process.env.WIKI_CHAT_IA_CAPTURE)
      await writeFile(
        join(process.env.WIKI_CHAT_IA_CAPTURE, 'chat-narrow-dark.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    await js("document.documentElement.dataset.wikiTheme='light'");
    await click('대화로');
    await until(
      "document.querySelector('textarea').getBoundingClientRect().width>0",
    );
    assert.equal(
      await js("document.activeElement?.textContent.trim()==='example · 1줄'"),
      true,
      String(await js('document.activeElement.outerHTML')),
    );
    window.setSize(1400, 900);
    await until(
      "document.querySelector('section[aria-label=\"AI 채팅\"]').dataset.layout==='wide'",
    );
    await click('example · 1줄');
    await js(
      "document.querySelector('textarea').focus(); document.querySelector('textarea').setSelectionRange(2,4)",
    );
    window.setSize(320, 800);
    await until(
      "document.querySelector('section[aria-label=\"AI 채팅\"]').dataset.layout==='narrow'",
    );
    assert.equal(
      await js(
        "document.activeElement===document.querySelector('textarea') && document.querySelector('textarea').selectionStart===2 && document.querySelector('textarea').value==='A의 초안'",
      ),
      true,
    );
    assert.equal(
      await js('document.body.scrollWidth <= innerWidth'),
      true,
      String(
        await js(
          "JSON.stringify({width:innerWidth,scroll:document.body.scrollWidth,overflow:[...document.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>innerWidth).map(x=>[x.tagName,x.className,x.getBoundingClientRect().width])})",
        ),
      ),
    );
    await js(
      'document.querySelector(\'button[aria-label="선택한 답변 근거 열기"]\').click()',
    );
    await until(
      'document.querySelector(\'aside[aria-label="답변 근거"]\').hidden===false',
    );
    await click('대화로');
    window.setSize(480, 800);
    await js(
      'document.querySelector(\'button[aria-label="대화 목록 열기"]\').click()',
    );
    await until(
      "location.hash.includes('panel=history') && document.querySelector('aside[aria-label=\"대화 목록\"]').getBoundingClientRect().width>0",
    );
    await click('대화로');
    console.log('PASS 근거 주소·비차단 영역·좁은 화면 목록/근거 복귀');
    await js("location.hash='/chat?document=example.md'");
    await until(
      "document.body.innerText.includes('질문 범위: example') && location.hash.includes('threadId=')",
    );
    assert.equal(
      await js(
        "window.__chatChecks.calls.filter(x=>x.operation==='questionContext').length",
      ),
      0,
    );
    await js(
      "(() => { const t=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'범위 확인 질문'); t.dispatchEvent(new Event('input',{bubbles:true})); })()",
    );
    await click('질문 보내기');
    await until(
      "window.__chatChecks.calls.some(x=>x.operation==='questionContext')",
    );
    assert.deepEqual(
      await js(
        "window.__chatChecks.calls.find(x=>x.operation==='questionContext').input",
      ),
      {
        mode: 'on_demand',
        documents: ['example.md'],
        required_documents: ['example.md'],
      },
    );
    assert.equal(
      await js("window.__chatChecks.calls.some(x=>x.operation==='search')"),
      false,
    );
    console.log('PASS 문서에서 시작한 질문의 명시 범위·자동 실행 없음');
    await js(
      "location.hash='/chat?conversationId='+'b'.repeat(32)+'&questionRunId='+'6'.repeat(32)",
    );
    await until(
      "document.querySelector('textarea')?.value==='B의 초안' && document.body.innerText.includes('보존된 답변의 본문입니다.')",
    );
    assert.equal(
      await js("location.hash.includes('questionRunId='+'6'.repeat(32))"),
      true,
    );
    await click('second · 2–3줄');
    await until(
      "location.hash.includes('evidence=1') && document.querySelector('aside[aria-label=\"답변 근거\"]')?.innerText.includes('두 번째 원문의 인용')",
    );
    await auditAccessibility(window, 'flow-chat-selected-source-light');
    await click('답변의 모든 근거 2개');
    await until("location.hash.includes('evidence=all')");
    await click('대화로');
    // D-094: 답변은 대화에 보관하고 결과물 복사본은 내려받기를 명시했을 때만 만듭니다.
    assert.equal(
      await js(
        "window.__chatChecks.calls.filter(x=>x.operation==='createSavedResult').length",
      ),
      0,
    );
    await downloadMarkdown();
    await until('window.__chatChecks.exports.length===1');
    assert.equal(
      await js(
        "window.__chatChecks.calls.filter(x=>x.operation==='createSavedResult').length",
      ),
      1,
    );
    assert.equal(
      await js('window.__chatChecks.exports[0].content'),
      '저장 당시 답변 본문',
    );
    assert.equal(
      await js(
        "location.hash.includes('/artifact') || window.__chatChecks.calls.filter(x=>x.operation==='createSavedResult').length!==1 || document.body.innerText.includes('저장됨')",
      ),
      false,
    );
    console.log(
      'PASS 명시 내려받기 때 결과물1회 저장·고정 본문 내보내기·저장됨 칩 없음',
    );
    await js("location.hash='/chat?conversationId='+'a'.repeat(32)");
    await until("document.querySelector('textarea')?.value==='A의 초안'");
    // 결과물 저장이 실패해도 답변 파일은 저장하고 확인 필요를 안내합니다.
    await js(
      'window.__chatChecks.forgetSaved(); window.__chatChecks.failSave=true',
    );
    await js('window.__chatChecks.delayExport=true');
    await downloadMarkdown();
    await js(
      "document.documentElement.dataset.active='false'; window.dispatchEvent(new Event('fixture-activity'))",
    );
    await js('window.__chatChecks.releaseExport()');
    await until('window.__chatChecks.exports.length===2');
    await until(
      "document.body.innerText.includes('내 폴더의 결과물 저장 확인이 필요합니다')",
    );
    await js('window.__chatChecks.failSave=false');
    console.log('PASS 결과물 저장 실패에도 내려받기 진행·저장 확인 필요 안내');
    assert.equal(
      await js(
        "location.hash.includes('/chat?conversationId='+'a'.repeat(32))",
      ),
      true,
    );
    await js(
      "document.documentElement.dataset.active='true'; window.dispatchEvent(new Event('fixture-activity'))",
    );
    console.log('PASS 비활성 채팅의 내려받기 완료가 현재 주소를 바꾸지 않음');
    // 좁은 화면에서는 목록이 숨겨지므로 넓은 배치로 돌아가 새 대화를 시작합니다.
    window.setSize(1400, 900);
    await until(
      "document.querySelector('section[aria-label=\"AI 채팅\"]').dataset.layout==='wide'",
    );
    await js(
      'document.querySelector(\'button[aria-label="대화 목록 열기"]\')?.click()',
    );
    await click('새 대화');
    await until("document.querySelector('textarea')?.value===''");
    await js(
      "(() => { const t=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'읽기 전용 초안'); t.dispatchEvent(new Event('input',{bubbles:true})); })()",
    );
    await until(
      "document.querySelector('button[type=submit]')?.disabled===false",
    );
    const beforeIme = await js('window.__chatChecks.calls.length');
    await js(
      "document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))",
    );
    assert.equal(await js('window.__chatChecks.calls.length'), beforeIme);
    await js(
      "window.__chatChecks.setReadOnly(); window.dispatchEvent(new Event('wiki-connection-changed'))",
    );
    await until(
      "document.querySelector('button[type=submit]')?.disabled===true",
    );
    const beforeReadOnly = await js('window.__chatChecks.calls.length');
    await js(
      "document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))",
    );
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal(await js('window.__chatChecks.calls.length'), beforeReadOnly);
    assert.equal(
      await js("document.querySelector('textarea').value"),
      '읽기 전용 초안',
    );
    await auditAccessibility(window, 'flow-chat-readonly-light');
    if (process.env.WIKI_A11Y === '1') {
      window.setSize(320, 800);
      await auditAccessibility(window, 'flow-chat-readonly-320-light', {
        textSpacing: true,
      });
    }
    console.log(
      'PASS IME Enter 오발송 없음·읽기전용 버튼/Enter 동일 차단·초안 유지',
    );
    await js("location.hash='/chat?conversationId='+'9'.repeat(32)");
    await until(
      "document.body.innerText.includes('선택한 대화를 열 수 없습니다')",
    );
    assert.equal(
      await js(
        "[...document.querySelectorAll('[role=log]')].some(x=>x.getBoundingClientRect().width>0)",
      ),
      false,
    );
    console.log('PASS 없는 대화 주소를 기존 대화로 대체하지 않음');

    window.setContentSize(1600, 1000);
    await window.loadURL(
      pathToFileURL(join(root, 'renderer/index.html')).href +
        '?visual=1#/chat?conversationId=' +
        'a'.repeat(32),
    );
    await until(
      "document.querySelector('.wiki-theme') && document.body.innerText.includes('추가로 확인할 점')",
    );
    await js("document.querySelector('[role=log]').scrollTop=0");
    await captureVisual('representative-chat-conversation');
    await click('운전-모드-전환 · 2–3줄');
    await until(
      "document.querySelector('aside[aria-label=\"답변 근거\"]')?.innerText.includes('운전-모드-전환')",
    );
    await captureVisual('representative-chat-sources');
    await js(
      "[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='온도-센서-인터페이스 · 1줄').click()",
    );
    await until(
      "document.querySelector('aside[aria-label=\"답변 근거\"]')?.innerText.includes('온도가 설정 범위를')",
    );
    await captureVisual('representative-chat-selected-source');
    await auditAccessibility(window, 'visual-chat-light', {
      textSpacing: true,
    });
    await js("document.documentElement.dataset.wikiTheme='dark'");
    await auditAccessibility(window, 'visual-chat-dark');
    await captureVisual('representative-chat-dark');
    window.setContentSize(720, 900);
    await auditAccessibility(window, 'visual-chat-narrow');
    await captureVisual('representative-chat-narrow');
    assert.equal(
      await js(
        "window.__chatChecks.calls.some(x=>x.operation==='questionContext'||x.operation==='createSavedResult')",
      ),
      false,
    );
    console.log(
      'PASS representative conversation, two sources and selected citation render inside actual AppShell without AI or save requests',
    );
  } finally {
    window.destroy();
  }
}
void verify()
  .then((): void => app.exit(0))
  .catch((error: unknown): void => {
    console.error(error);
    app.exit(1);
  });

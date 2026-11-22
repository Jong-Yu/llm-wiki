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
  await click('다른 형식으로');
  const menuItem = `[...document.querySelectorAll('button[role="menuitem"]')].find(x=>x.textContent.startsWith('Markdown (.md)'))`;
  await until(`Boolean(${menuItem})`);
  await js(`(${menuItem}).click()`);
}
/** 실제 폴링으로 도착한 실행 단계 하나가 사용자 문구 하나로 바뀌는지 확인합니다. */
async function expectProgress(phase: string, message: string): Promise<void> {
  await js(`window.__chatChecks.run.phase=${JSON.stringify(phase)}`);
  await until(
    `document.querySelector('[data-chat-progress] li:last-child')?.innerText===${JSON.stringify(message)}`,
  );
  assert.equal(
    await js("document.querySelectorAll('[data-chat-progress]').length"),
    1,
  );
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
  window.webContents.on(
    'console-message',
    (
      details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
    ): void => {
      if (details.level === 'error') console.error(details.message);
    },
  );
  try {
    await window.loadURL(
      pathToFileURL(join(root, 'renderer/index.html')).href +
        '#/chat?conversationId=' +
        'a'.repeat(32),
    );
    await until("document.querySelector('textarea')?.value === 'A의 초안'");
    assert.equal(await js("document.querySelectorAll('dialog').length"), 0);
    await expectProgress('starting', '답변을 준비하고 있어요');
    assert.equal(
      await js("document.body.innerText.includes('위키 근거 없이 답해요')"),
      false,
    );
    console.log('PASS 답변 준비 중 근거 없이 답한다는 문구 없음');
    await expectProgress('internal_unknown_phase', '답변을 준비하고 있어요');
    assert.equal(
      await js("document.body.innerText.includes('internal_unknown_phase')"),
      false,
    );
    await js(
      "window.__chatChecks.run.commentaries=[{id:'read',content:'센서 경고 조건을 원문에서 확인하겠습니다.'}]",
    );
    await until(
      "document.querySelector('[data-chat-commentary]')?.textContent==='센서 경고 조건을 원문에서 확인하겠습니다.'",
    );
    await js(
      "window.__chatChecks.run.commentaries=[{id:'read',content:'센서 경고 조건을 확인했습니다. 다음으로 운전 모드별 차이를 살펴보겠습니다.'},{id:'compare',content:'운전 모드별 예외를 비교하고, 확인되지 않은 내용은 따로 표시하겠습니다.'}]",
    );
    await until(
      "document.querySelectorAll('[data-chat-commentary]').length===2 && document.body.innerText.includes('센서 경고 조건을 확인했습니다.')",
    );
    assert.equal(
      await js("document.querySelector('[data-chat-progress]')===null"),
      true,
    );
    assert.equal(
      await js(
        "document.body.innerText.includes('센서 경고 조건을 원문에서 확인하겠습니다.')",
      ),
      false,
    );
    await js(
      "window.__chatChecks.run.preview='A에서 생성 중인 임시 답변입니다.'",
    );
    await js("window.__chatChecks.run.phase='submitting'");
    await until(
      "document.body.innerText.includes('A에서 생성 중인 임시 답변입니다.')",
    );
    await captureVisual('commentary-in-progress');
    await js("location.hash='/chat?conversationId='+'b'.repeat(32)");
    await until("document.querySelector('textarea')?.value==='B의 초안'");
    assert.equal(
      await js("document.querySelector('[data-chat-progress]')===null"),
      true,
    );
    assert.equal(
      await js("document.querySelector('[data-chat-commentaries]')===null"),
      true,
    );
    assert.equal(
      await js(
        "document.body.innerText.includes('A에서 생성 중인 임시 답변입니다.')",
      ),
      false,
    );
    await js("location.hash='/chat?conversationId='+'a'.repeat(32)");
    await until("document.querySelector('textarea')?.value==='A의 초안'");
    await until(
      "document.querySelectorAll('[data-chat-commentary]').length===2",
    );
    await js('window.__chatChecks.run.savedAnswer=true');
    await until("document.body.innerText.includes('완성된 최종 답변입니다.')");
    assert.equal(await js('window.__chatChecks.run.localStatus'), 'running');
    assert.equal(
      await js("document.querySelector('[data-chat-progress]')===null"),
      true,
    );
    assert.equal(
      await js("document.querySelector('[data-chat-commentaries]')===null"),
      true,
    );
    assert.equal(
      await js(
        "document.body.innerText.includes('A에서 생성 중인 임시 답변입니다.')",
      ),
      false,
    );
    await captureVisual('commentary-final-answer');
    console.log(
      'PASS AI 작업 설명 두 개와 같은 ID 갱신·단계 라벨 숨김·대화 분리·확정 답변 전환',
    );
    await js(
      "window.__chatChecks.run.savedAnswer=false; window.__chatChecks.run.localStatus='stopping'",
    );
    await until(
      "document.body.innerText.includes('답변 생성을 멈추고 있어요')",
    );
    await js(
      "window.__chatChecks.run.status='cancelled'; window.__chatChecks.run.localStatus='exited'",
    );
    await until("document.body.innerText.includes('중단 전 생성된 내용')");
    assert.equal(
      await js("document.querySelector('[data-chat-progress]')===null"),
      true,
    );
    assert.equal(
      await js("document.querySelector('[data-chat-commentaries]')===null"),
      true,
    );
    await js("location.hash='/chat?conversationId='+'b'.repeat(32)");
    await until("document.querySelector('textarea')?.value==='B의 초안'");
    await js(
      "window.__chatChecks.run.status='failed'; window.__chatChecks.run.localStatus='failed'; window.__chatChecks.run.errorCode='ai_timeout'; location.hash='/chat?conversationId='+'a'.repeat(32)",
    );
    await until(
      "document.body.innerText.includes('응답 대기 시간이 지났어요')",
    );
    assert.equal(
      await js("document.querySelector('[data-chat-progress]')===null"),
      true,
    );
    assert.equal(
      await js("document.querySelector('[data-chat-commentaries]')===null"),
      true,
    );
    assert.equal(await js('window.__chatChecks.cancels'), 0);
    console.log(
      'PASS 중지·취소·실패 종료 후 진행 메시지 숨김과 부분 답변 보존',
    );
    await js("location.hash='/chat?conversationId='+'b'.repeat(32)");
    await until("document.querySelector('textarea')?.value==='B의 초안'");
    await js(
      "window.__chatChecks.run.savedAnswer=true; window.__chatChecks.run.status='complete'; window.__chatChecks.run.localStatus='exited'; window.__chatChecks.run.errorCode=null; window.__chatChecks.run.preview=''; location.hash='/chat?conversationId='+'a'.repeat(32)",
    );
    await until("document.body.innerText.includes('완성된 최종 답변입니다.')");
    await js('window.__chatChecks.delayContext=true');
    await click('질문 보내기');
    await until(
      "document.querySelector('[data-chat-progress]')?.innerText.includes('관련 문서와 연결된 근거를 찾고 있어요')",
    );
    assert.equal(
      await js("document.body.innerText.includes('완성된 최종 답변입니다.')"),
      true,
    );
    assert.equal(
      await js("document.querySelector('[data-chat-commentaries]')===null"),
      true,
    );
    await js('window.__chatChecks.releaseContext()');
    await until(
      "document.querySelector('[data-chat-progress]')===null && document.body.innerText.includes('범위 확인 후 AI 실행 전 중단')",
    );
    console.log('PASS 이전 답변이 있어도 새 질문의 근거 준비 메시지 표시');
    await js("location.hash='/chat?conversationId='+'b'.repeat(32)");
    await until("document.querySelector('textarea')?.value==='B의 초안'");
    await js(
      "window.__chatChecks.run.savedAnswer=false; window.__chatChecks.run.status='running'; window.__chatChecks.run.localStatus='running'; window.__chatChecks.run.preview='취소 전 생성된 답변입니다.'; location.hash='/chat?conversationId='+'a'.repeat(32)",
    );
    await until(
      "document.querySelectorAll('[data-chat-commentary]').length===2",
    );
    await js('window.__chatChecks.delayConversation=true');
    await until('window.__chatChecks.conversationDelayed');
    await js('window.__chatChecks.cancelEnabled=true');
    await click('응답 중단');
    await until("document.body.innerText.includes('중단 전 생성된 내용')");
    // 취소가 화면에 반영된 뒤 이전 폴링의 대화 조회를 풀어 늦은 응답을 도착시킵니다.
    await js(
      'window.__chatChecks.releaseConversation(); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal(await js('window.__chatChecks.cancels'), 1);
    assert.equal(
      await js("document.querySelector('[data-chat-commentaries]')===null"),
      true,
      '취소 전 폴링 응답이 작업 설명을 다시 표시하면 안 됩니다.',
    );
    assert.equal(
      await js(
        "document.querySelector('[data-chat-progress]')===null && document.body.innerText.includes('중단 전 생성된 내용')",
      ),
      true,
    );
    console.log(
      'PASS 취소 전 실행 조회가 늦게 도착해도 취소 상태와 설명 숨김 유지',
    );
    // 아래 기존 이동·내려받기 사례는 처음의 정상 fixture로 다시 시작합니다.
    await window.loadURL(
      pathToFileURL(join(root, 'renderer/index.html')).href +
        '?flow=main#/chat?conversationId=' +
        'a'.repeat(32),
    );
    await until("document.querySelector('textarea')?.value==='A의 초안'");
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
        allow_empty: true,
        lookup_question: '범위 확인 질문',
        retrieval_scope: 'workspace',
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
    // 일반 답변과 본문 없는/실패한 파일 답변에는 내려받기 행동이 없습니다.
    const noDownload =
      "![...document.querySelectorAll('button')].some(x=>['내려받기','다른 형식으로'].includes(x.textContent.trim()))";
    assert.equal(await js(noDownload), true);
    await js(
      "window.__chatChecks.answerMode='empty'; location.hash='/chat?conversationId='+'a'.repeat(32)",
    );
    await until("document.querySelector('textarea')?.value==='A의 초안'");
    await until(
      "!document.querySelector('[role=log]')?.innerText.includes('보존된 답변의 본문입니다.')",
    );
    assert.equal(await js(noDownload), true);
    await js(
      "window.__chatChecks.answerMode='failed'; location.hash='/chat?conversationId='+'b'.repeat(32)",
    );
    await until(
      "document.body.innerText.includes('이 답변은 실패 상태로 저장되었어요.')",
    );
    assert.equal(await js(noDownload), true);
    await js(
      "window.__chatChecks.answerMode='file'; location.hash='/chat?conversationId='+'a'.repeat(32)",
    );
    await until(
      "document.querySelector('textarea')?.value==='A의 초안' && [...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='다른 형식으로')",
    );
    await js("location.hash='/chat?conversationId='+'b'.repeat(32)");
    await until(
      "document.querySelector('textarea')?.value==='B의 초안' && [...document.querySelectorAll('button')].some(x=>x.textContent.trim()==='내려받기')",
    );
    console.log('PASS 일반·빈·실패 답변의 내려받기 숨김과 실제 파일 행동 표시');
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
      'PASS 실제 파일의 다른 형식 메뉴·명시 내려받기 때 결과물1회 저장·고정 본문 내보내기·저장됨 칩 없음',
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

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
const root = process.env.WIKI_CONTINUITY_ROOT;
if (!root?.startsWith('/private/tmp/wiki-continuity-'))
  throw new Error('Isolated fixture required');
app.setPath('userData', join(root, 'user'));
let window: BrowserWindow;
/** 실제 렌더러의 입력과 결과만 제어합니다. */
async function js(source: string): Promise<unknown> {
  return window.webContents.executeJavaScript(source);
}
/** 비동기 화면 갱신을 제한된 시간만 기다립니다. */
async function until(source: string): Promise<void> {
  for (let i = 0; i < 160; i += 1) {
    if (await js(source)) return;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 25);
    });
  }
  throw new Error(`${source}\n${String(await js('document.body.innerText'))}`);
}
/** "기존 지식 대조" 구역을 찾는 식입니다. */
const comparisonSection =
  "[...document.querySelectorAll('section')].find(x=>x.querySelector('h2')?.textContent==='기존 지식 대조')";
/** 표시된 사용자 행동을 클릭합니다. */
async function click(text: string): Promise<void> {
  await js(
    `(() => { const b=[...document.querySelectorAll('button,a')].find(x=>x.textContent.trim()===${JSON.stringify(text)} && x.getBoundingClientRect().width>0); if(!b||b.disabled) throw new Error('Unavailable action'); b.click(); })()`,
  );
}
/** 다중 상태·한도·이동·중단·연결 변경 경계를 검증합니다. */
async function verify(directory: string): Promise<void> {
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadURL(
      pathToFileURL(join(directory, 'renderer/index.html')).href + '#/sessions',
    );
    await until(
      "document.querySelectorAll('#app-content li').length===2 && document.body.innerText.includes('AI 세션 2') && document.body.innerText.includes('잔여 70%')",
    );
    assert.equal(await js('window.__continuity.starts'), 0);
    assert.equal(
      await js(
        "Number(document.querySelector('footer [role=meter]').getAttribute('aria-valuenow'))",
      ),
      70,
    );
    console.log(
      'PASS two independent activities and shared account allowance displayed without starting AI',
    );
    await until(
      "document.body.innerText.includes('저장된 대조 결과가 없습니다.')",
    );
    await js(
      'window.__continuity.comparisons.records=structuredClone(window.__continuity.comparisons.seedRecords)',
    );
    await click('대조 결과 새로고침');
    await until(
      "document.body.innerText.includes('공통 실험 조건의 관련 후보') && document.body.innerText.includes('재확인 필요')",
    );
    assert.equal(await js('window.__continuity.comparisons.starts'), 0);
    assert.equal(
      await js(
        "document.body.innerText.includes('측정 온도는 20도였다.') && document.body.innerText.includes('조회 5회 한도') && document.body.innerText.includes('comparison_timeout')",
      ),
      true,
    );
    await js(
      `${comparisonSection}.querySelectorAll('details').forEach(x=>{x.open=true})`,
    );
    assert.equal(
      await js(
        "document.body.innerText.includes('실험 조건이 달라 제외') && document.body.innerText.includes('측정 온도는 80도였다.')",
      ),
      true,
    );
    await js(
      `(() => {const s=${comparisonSection}.querySelector('select'); s.value='d'.repeat(32); s.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await until("document.body.innerText.includes('이전 실행의 관련 후보')");
    assert.equal(await js('window.__continuity.comparisons.starts'), 0);
    await click('최신 자료로 검색·대조 다시 실행');
    await until("document.body.innerText.includes('새 대조 결과 보기')");
    await click('새 대조 결과 보기');
    await until("document.body.innerText.includes('이 대조 중단')");
    await click('이 대조 중단');
    await until("document.body.innerText.includes('comparison_cancelled')");
    assert.equal(await js('window.__continuity.comparisons.starts'), 1);
    assert.equal(await js('window.__continuity.comparisons.stops'), 1);
    assert.equal(await js('window.__continuity.comparisons.records.length'), 3);
    console.log(
      'PASS latest/previous comparison evidence, exclusion, partial failure, coverage and explicit rerun/stop preserve history',
    );
    await click('중단');
    await until("document.body.innerText.includes('AI 세션 1 ›')");
    assert.deepEqual(await js('window.__continuity.stopped'), ['a'.repeat(32)]);
    assert.equal(
      await js('window.__continuity.activities[0].kind'),
      'question',
    );
    console.log(
      'PASS selected cancellation preserves the other running session',
    );
    await click('열기');
    await until(
      "location.hash.includes('conversationId='+'c'.repeat(32)) && location.hash.includes('questionRunId='+'b'.repeat(32))",
    );
    assert.equal(await js('window.__continuity.starts'), 0);
    console.log(
      'PASS activity navigation opens its exact conversation/run and never restarts it',
    );
    await js("location.hash='/settings?section=ai'");
    await until(
      "document.body.innerText.includes('Fixture account') && document.querySelectorAll('[role=meter]').length===3",
    );
    await js(
      "window.__continuity.usage={...window.__continuity.usage,status:'unavailable',windows:[],accountLabel:null,message:'한도 미제공'}",
    );
    await click('사용량 새로고침');
    await until(
      "document.querySelectorAll('[role=meter]').length===0 && document.body.innerText.includes('한도 미제공')",
    );
    assert.equal(
      await js("document.body.innerText.includes('잔여 0%')"),
      false,
    );
    console.log('PASS unavailable allowance is not a fabricated zero');
    await js(
      "window.__continuity.usage={...window.__continuity.usage,status:'available',accountLabel:'Old account',windows:[{name:'5시간',usedPercent:30,remainingPercent:70,windowMinutes:300,resetsAt:null}]}; window.__continuity.hold=true",
    );
    await click('사용량 새로고침');
    await until('window.__continuity.waiting');
    await js(
      "window.__continuity.connected=false; window.dispatchEvent(new Event('wiki-connection-changed')); window.__continuity.hold=false; window.__continuity.release()",
    );
    await until(
      "!document.body.innerText.includes('Old account') && document.querySelectorAll('[role=meter]').length===0",
    );
    console.log(
      'PASS connection change clears account data and ignores a delayed old response',
    );
    await js(
      "window.__continuity.connected=true; window.dispatchEvent(new Event('wiki-connection-changed')); location.hash='/sessions'",
    );
    await until(
      "document.querySelectorAll('#app-content li').length>=1 && document.body.innerText.includes('AI 세션 1 ›')",
    );
    if (process.env.WIKI_CONTINUITY_CAPTURE)
      await writeFile(
        join(process.env.WIKI_CONTINUITY_CAPTURE, 'session-continuity.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    window.setSize(736, 800);
    await until('innerWidth===736');
    assert.equal(await js('document.body.scrollWidth <= innerWidth'), true);
    assert.equal(
      await js(
        "[...document.querySelectorAll('footer a')].every(x=>x.getBoundingClientRect().right<=innerWidth)",
      ),
      true,
    );
    console.log(
      'PASS existing header stays within the narrow desktop viewport',
    );
  } finally {
    window.destroy();
  }
}
void verify(root)
  .then((): void => app.exit(0))
  .catch((error: unknown): void => {
    console.error(error);
    app.exit(1);
  });

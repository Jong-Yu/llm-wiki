import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { auditAccessibility } from '../accessibility/audit';
const root = process.env.WIKI_JOB_IA_ROOT;
if (!root?.startsWith('/private/tmp/wiki-job-ia-'))
  throw new Error('Isolated fixture root required');
app.setPath('userData', join(root, 'user'));
let window: BrowserWindow;
/** 같은 상태의 실제 화면을 전후 디자인 비교에 보관합니다. */
async function capture(name: string): Promise<void> {
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  const directory = process.env.WIKI_WORKFLOW_CAPTURE_DIR;
  if (directory) {
    await writeFile(
      join(directory, `${name}.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
    if (name.startsWith('representative-')) {
      // 자동 대비 판정이 보류된 상단 라벨의 실제 색과 가림 여부를 보관합니다.
      const labelEvidence = await js(`(() => {
        const label = document.querySelector('nav[aria-label="현재 위치"] [aria-current="page"]');
        if (!label) throw new Error('Missing real AppShell breadcrumb label');
        const box = label.getBoundingClientRect();
        const color = getComputedStyle(label).color;
        const ancestors = [];
        for (let node = label; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          ancestors.push({tag: node.tagName, background: style.backgroundColor, opacity: style.opacity});
        }
        const points = [[box.left+1,box.top+1],[box.right-1,box.top+1],[box.left+1,box.bottom-1],[box.right-1,box.bottom-1],[box.x+box.width/2,box.y+box.height/2]];
        const labelVisible = points.every(([x,y]) => label.contains(document.elementFromPoint(x,y)));
        return {color, ancestors, labelVisible, bounds: box.toJSON(), viewport: {width: innerWidth,height:innerHeight}};
      })()`);
      await writeFile(
        join(directory, `${name}.controls.json`),
        JSON.stringify(labelEvidence, null, 2),
      );
    }
  }
}
/** 실제 React 화면과 격리된 bridge 요청 기록만 읽습니다. */
async function js(source: string): Promise<unknown> {
  return window.webContents.executeJavaScript(source);
}
/** 늦은 응답과 React 렌더 반영을 기다리되 무한 대기하지 않습니다. */
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
/** 화면에 보이는 활성 버튼을 사용자가 누르는 것처럼 실행합니다. */
async function click(label: string): Promise<void> {
  await until(
    `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`,
  );
  await js(
    `(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled).click(); })()`,
  );
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
}
/** 요청이 실행되지 않은 단순 조회 상태로 복구합니다. */
async function reset(): Promise<void> {
  await js("window.__jobChecks.mode='ok'; window.__jobChecks.cancelled=false");
  await click('새로고침');
  await until(
    "!!document.querySelector('a[href=\"/document?path=requested.md\"]') && !document.querySelector('[role=alert]')",
  );
}
/** 실제 Electron에서 조회·명시 실행·취소·오류 경계를 확인합니다. */
async function verify(directory: string): Promise<void> {
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
  try {
    await window.loadURL(
      pathToFileURL(join(directory, 'renderer/index.html')).href,
    );
    await until(
      "!!document.querySelector('a[href=\"/document?path=requested.md\"]') && !document.querySelector('[role=status]')",
    );
    assert.equal(await js('window.__jobChecks.mounts'), 2);
    assert.equal(
      await js(
        "window.__jobChecks.calls.filter(x=>x.operation==='execute').length",
      ),
      0,
    );
    assert.equal(await js("document.querySelectorAll('dialog').length"), 0);
    console.log(
      'PASS development StrictMode replays effects and initial read remains usable without execution',
    );

    await click('실행 가능 여부 확인');
    await until('!!document.querySelector(\'[aria-label="실행 준비 결과"]\')');
    assert.equal(
      await js(
        "window.__jobChecks.calls.filter(x=>x.operation==='execute').length",
      ),
      0,
    );
    await click('이 작업 실행');
    await until(
      "window.__jobChecks.calls.some(x=>x.operation==='execute') && !document.querySelector('[role=status]')",
    );
    assert.deepEqual(
      await js(
        "window.__jobChecks.calls.find(x=>x.operation==='execute').request",
      ),
      {
        connectionId: 'fixture',
        jobId: 'a'.repeat(32),
        expectedJobRevision: '8'.repeat(64),
        mode: 'start',
      },
    );
    assert.equal(
      await js('!!document.querySelector(\'[aria-label="실행 준비 결과"]\')'),
      false,
    );
    console.log(
      'PASS inspection does not execute; explicit execution sends inspected job revision and start mode',
    );

    await js("window.__jobChecks.executionMode='resume'");
    await click('실행 가능 여부 확인');
    await click('이 작업 이어서 실행');
    assert.deepEqual(
      await js(
        "window.__jobChecks.calls.filter(x=>x.operation==='execute').at(-1).request",
      ),
      {
        connectionId: 'fixture',
        jobId: 'a'.repeat(32),
        expectedJobRevision: '8'.repeat(64),
        mode: 'resume',
      },
    );
    console.log('PASS resume uses the inspected mode and the same exact job');

    await capture('wide');
    await auditAccessibility(window, 'wf-job-light', {
      textSpacing: true,
      zoom: true,
    });
    if (
      process.env.WIKI_A11Y === '1' ||
      process.env.WIKI_WORKFLOW_CAPTURE_DIR
    ) {
      window.setContentSize(320, 900);
      await auditAccessibility(window, 'wf-job-narrow', { textSpacing: true });
      await capture('narrow');
      window.setContentSize(1280, 900);
      await js("document.documentElement.dataset.wikiTheme='dark'");
      await auditAccessibility(window, 'wf-job-dark');
      await capture('dark');
      await js("document.documentElement.dataset.wikiTheme='light'");
    }
    await js(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='작업 취소 검토').focus()",
    );
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until('!!document.querySelector(\'[aria-label="작업 취소 확인"]\')');
    await until("document.activeElement?.textContent === '작업 취소 확인'");
    await auditAccessibility(window, 'wf-job-cancel-confirmation');
    assert.equal(
      await js(
        "window.__jobChecks.calls.filter(x=>x.operation==='cancel').length",
      ),
      0,
    );
    assert.equal(await js("document.querySelectorAll('dialog').length"), 0);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await until("document.activeElement?.textContent.trim()==='이 작업 취소'");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await until("document.activeElement?.textContent.trim()==='돌아가기'");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(
      "document.activeElement?.textContent.trim() === '작업 취소 검토'",
    );
    assert.equal(
      await js(
        "window.__jobChecks.calls.filter(x=>x.operation==='cancel').length",
      ),
      0,
    );
    await click('작업 취소 검토');
    await click('이 작업 취소');
    await until("document.body.innerText.includes('취소됨')");
    await until(
      "document.activeElement?.tagName === 'H3' && document.activeElement.textContent.includes('취소됨')",
    );
    assert.deepEqual(
      await js(
        "window.__jobChecks.calls.find(x=>x.operation==='cancel').request",
      ),
      {
        connectionId: 'fixture',
        jobId: 'a'.repeat(32),
        expectedJobRevision: '9'.repeat(64),
      },
    );
    console.log(
      'PASS cancel requires inline confirmation and sends the current job revision',
    );

    for (const mode of ['read403', 'inspect403', 'execute403']) {
      await reset();
      await click('실행 가능 여부 확인');
      await js(`window.__jobChecks.mode=${JSON.stringify(mode)}`);
      await click(
        mode === 'read403'
          ? '새로고침'
          : mode === 'inspect403'
            ? '실행 가능 여부 확인'
            : '이 작업 이어서 실행',
      );
      await until(
        "document.querySelector('[role=alert]')?.innerText.includes('작업 접근 거부 fixture')",
      );
      assert.equal(
        await js(
          '!!document.querySelector(\'a[href="/document?path=requested.md"]\')',
        ),
        false,
      );
      assert.equal(
        await js('!!document.querySelector(\'[aria-label="실행 준비 결과"]\')'),
        false,
      );
      assert.equal(
        await js(
          "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='실행 가능 여부 확인')",
        ),
        false,
      );
    }
    console.log(
      'PASS read, inspection, and execution 403 each remove prior detail and preparation',
    );

    for (const mode of ['wrongRead', 'wrongInspect', 'wrongExecute']) {
      await reset();
      if (mode === 'wrongExecute') await click('실행 가능 여부 확인');
      await js(`window.__jobChecks.mode=${JSON.stringify(mode)}`);
      await click(
        mode === 'wrongRead'
          ? '새로고침'
          : mode === 'wrongInspect'
            ? '실행 가능 여부 확인'
            : '이 작업 이어서 실행',
      );
      await until(
        "document.querySelector('[role=alert]')?.innerText.includes('요청한 작업')",
      );
      assert.equal(
        await js(
          '!!document.querySelector(\'a[href="/document?path=wrong-target.md"]\')',
        ),
        false,
      );
      assert.equal(
        await js('!!document.querySelector(\'[aria-label="실행 준비 결과"]\')'),
        false,
      );
    }
    console.log(
      'PASS mismatched read, inspection, and execution results never replace the requested job',
    );

    window.setContentSize(1440, 1000);
    await window.loadURL(
      pathToFileURL(join(directory, 'renderer/index.html')).href + '?visual=1',
    );
    await until(
      "document.querySelector('.wiki-theme') && document.body.innerText.includes('관련 후보 2개')",
    );
    await js(
      "(() => {const summary=[...document.querySelectorAll('summary')].find(x=>x.textContent.includes('대조 완료')); if(summary && !summary.parentElement.open) summary.click();})()",
    );
    await until(
      "document.body.innerText.includes('경고를 보내는 조건과 센서의 동작 범위')",
    );
    await capture('representative-job-light');
    await auditAccessibility(window, 'visual-job-light', { textSpacing: true });
    await js(
      "[...document.querySelectorAll('summary')].find(x=>x.textContent.includes('온도-센서-인터페이스')).click()",
    );
    await js(
      "[...document.querySelectorAll('blockquote')].find(x=>x.textContent.includes('온도가 설정 범위')).scrollIntoView({block:'center'})",
    );
    await capture('representative-job-comparison');
    await js("document.documentElement.dataset.wikiTheme='dark'");
    await auditAccessibility(window, 'visual-job-dark');
    await capture('representative-job-dark');
    window.setContentSize(720, 900);
    await auditAccessibility(window, 'visual-job-narrow', {
      textSpacing: true,
    });
    await capture('representative-job-narrow');
    console.log(
      'PASS representative job renders actual AppShell, controls, saved records and schema-validated comparison without execution',
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

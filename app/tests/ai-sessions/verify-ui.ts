import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { auditAccessibility } from '../accessibility/audit';
const root = process.env.WIKI_SESSION_UI_ROOT;
if (!root?.startsWith('/private/tmp/wiki-session-ui-'))
  throw new Error('Isolated fixture path required');
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
/** 현재 목록 DOM과 테스트 전용 응답 제어기를 읽습니다. */
async function js(source: string): Promise<unknown> {
  return window.webContents.executeJavaScript(source);
}
/** 사용자 행동 후 실제 React 갱신을 기다립니다. */
async function until(source: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await js(source)) return;
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(
    `Timed out: ${source}\n${String(await js('document.body.innerText'))}`,
  );
}
/** 표시된 활성 버튼에 사용자 입력을 전달합니다. */
async function click(label: string): Promise<void> {
  await js(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)} && x.getBoundingClientRect().width>0); if(!b || b.disabled) throw new Error('Unavailable button'); b.click(); })()`,
  );
}
/** 격리된 응답으로 실제 목록의 접근 무효화와 페이지 합치기를 검증합니다. */
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
      "document.querySelectorAll('li').length===1 && !document.querySelector('[aria-busy=true]')",
    );
    await capture('wide');
    await auditAccessibility(window, 'wf-sessions-light', {
      textSpacing: true,
      zoom: true,
    });
    if (
      process.env.WIKI_A11Y === '1' ||
      process.env.WIKI_WORKFLOW_CAPTURE_DIR
    ) {
      window.setContentSize(320, 900);
      await auditAccessibility(window, 'wf-sessions-narrow', {
        textSpacing: true,
      });
      await capture('narrow');
      window.setContentSize(1280, 900);
      await js("document.documentElement.dataset.wikiTheme='dark'");
      await auditAccessibility(window, 'wf-sessions-dark');
      await capture('dark');
      await js("document.documentElement.dataset.wikiTheme='light'");
    }
    await click('더 불러오기');
    await until(
      "!document.body.innerText.includes('더 불러오기') && !document.querySelector('[aria-busy=true]')",
    );
    console.log(
      'PASS StrictMode initial read and final cursor clear the pagination notice',
    );

    await click('새로고침');
    await until(
      "document.body.innerText.includes('더 불러오기') && !document.querySelector('[aria-busy=true]')",
    );
    await js("window.__sessionChecks.mode='network'");
    await click('더 불러오기');
    await until("document.body.innerText.includes('네트워크 실패 검증')");
    await capture('error');
    await auditAccessibility(window, 'wf-sessions-error');
    assert.equal(await js("document.querySelectorAll('li').length"), 1);
    assert.equal(
      await js(
        "[...document.querySelectorAll('[role=status]')].some(x=>x.textContent.includes('네트워크 실패 검증'))",
      ),
      true,
    );
    console.log(
      'PASS ordinary partial failure preserves authorized previous rows and explains gaps',
    );

    await js("window.__sessionChecks.mode='ok'");
    await click('새로고침');
    await until(
      "document.body.innerText.includes('더 불러오기') && !document.querySelector('[aria-busy=true]')",
    );
    await js('window.__sessionChecks.hold=true');
    await click('더 불러오기');
    await until('window.__sessionChecks.waiting');
    await click('화면 전환');
    await until("document.querySelector('[data-catalog]').hidden");
    await js(
      "window.__sessionChecks.mode='forbidden'; window.__sessionChecks.hold=false; window.__sessionChecks.release()",
    );
    await until(
      "document.querySelectorAll('li').length===0 && document.querySelector('[role=alert]')?.textContent.includes('접근 거부 검증')",
    );
    console.log(
      'PASS late 403 removes previous rows even when the retained page is hidden',
    );

    await click('화면 전환');
    await until(
      "!document.querySelector('[aria-busy=true]') && !!document.querySelector('[role=alert]')",
    );
    assert.equal(await js("document.querySelectorAll('li').length"), 0);
    await js("window.__sessionChecks.mode='ok'");
    await click('새로고침');
    await until(
      "document.querySelectorAll('li').length===1 && !document.querySelector('[aria-busy=true]')",
    );
    await click('화면 전환');
    await js("window.dispatchEvent(new Event('wiki-connection-changed'))");
    await until("document.querySelectorAll('li').length===0");
    console.log(
      'PASS scope change clears hidden cached rows before any reactivation',
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
    await capture('representative-sessions-light');
    await auditAccessibility(window, 'visual-sessions-light', {
      textSpacing: true,
    });
    await js(
      "[...document.querySelectorAll('summary')].find(x=>x.textContent.includes('온도-센서-인터페이스')).click()",
    );
    await js(
      "[...document.querySelectorAll('blockquote')].find(x=>x.textContent.includes('온도가 설정 범위')).scrollIntoView({block:'center'})",
    );
    await capture('representative-sessions-comparison');
    await js("document.documentElement.dataset.wikiTheme='dark'");
    await auditAccessibility(window, 'visual-sessions-dark');
    await capture('representative-sessions-dark');
    window.setContentSize(720, 900);
    await auditAccessibility(window, 'visual-sessions-narrow', {
      textSpacing: true,
    });
    await capture('representative-sessions-narrow');
    console.log(
      'PASS representative sessions renders actual AppShell, controls, saved records and schema-validated comparison without execution',
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

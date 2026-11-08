import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { registerRuntimeHandlers } from '@main/ipc/registerRuntimeHandlers';
import { z } from 'zod';
import { auditAccessibility } from '../accessibility/audit';
import { parseWorkspaceResult } from '@contracts/workspace.contract';
import { parseDocumentContentResult } from '@contracts/documents.contract';
import type { DocumentContent } from '@contracts/documents.contract';
import { documentMetadataPreview } from '@renderer/features/manage-document-content/model/documentMetadata';
import { registerConnectionHandlers } from '@main/ipc/registerConnectionHandlers';
const root = process.env.WIKI_UI_TEST_ROOT!;
const appRoot = process.env.WIKI_UI_APP_ROOT!;
const url = process.env.WIKI_UI_TEST_URL!;
// 서버가 허용한 flow/들여쓰기/여러 줄 YAML도 같은 업무 정보로 읽고 내부 참조는 제외합니다.
const metadataId = '0123456789abcdef0123456789abcdef';
const metadataExamples = [
  `---\n{schema_version: 1, document_id: "${metadataId}", title: "업무 제목", tags: ["한글", "검증"], description: "여러 줄\\n설명"}\n---\n`,
  `---\r\n  schema_version: 1\r\n  document_id: ${metadataId}\r\n  title: 업무 제목\r\n  tags:\r\n    - 한글\r\n    - 검증\r\n  description: |-\r\n    여러 줄\r\n    설명\r\n---\r\n`,
];
for (const header of metadataExamples) {
  assert.equal(
    documentMetadataPreview(header),
    '제목:\n  업무 제목\n태그:\n  • 한글\n  • 검증\n설명:\n  여러 줄\n  설명',
  );
  assert.equal(documentMetadataPreview(header).includes(metadataId), false);
}
assert.notEqual(
  documentMetadataPreview('---\ntitle: 제목\ntags: ["한글, 검증"]\n---\n'),
  documentMetadataPreview('---\ntitle: 제목\ntags: ["한글", "검증"]\n---\n'),
);
assert.ok(
  root.startsWith('/private/tmp/wiki-comparison-ui-') &&
    url.startsWith('http://127.0.0.1:'),
);
app.setPath('userData', join(root, 'electron-user'));
let window: BrowserWindow;
let stop: (() => Promise<void>) | undefined;
const actualFetch = globalThis.fetch;
let restorationRequests = 0;
/** 격리 서버의 실제 복원 요청 수만 세어 읽기와 명시 재시도를 구분합니다. */
globalThis.fetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const address = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  );
  if (
    address.origin === url &&
    address.pathname.endsWith('/documents/restorations') &&
    init?.method === 'POST'
  )
    restorationRequests++;
  return actualFetch(input, init);
};
/** 실제 렌더러 DOM 또는 공개 bridge 호출만 실행합니다. */
async function js(code: string): Promise<unknown> {
  try {
    // 보관된 비활성 화면의 중복 입력·결과를 현재 화면으로 오인하지 않습니다.
    const scoped = code
      .replaceAll('document.querySelectorAll(', 'visibleAll(')
      .replaceAll('document.querySelector(', 'visibleOne(');
    return await window.webContents.executeJavaScript(`(() => {
      const visibleAll = selector => [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length > 0);
      const visibleOne = selector => {
        const active = document.querySelector('[data-workspace-route][data-active="true"]');
        return [...(active ?? document).querySelectorAll(selector)].find(e => e.getClientRects().length > 0) ?? visibleAll(selector)[0] ?? null;
      };
      return (${scoped});
    })()`);
  } catch (error) {
    throw new Error('DOM operation failed: ' + code, { cause: error });
  }
}
/** 화면이 기대 상태에 도착할 때까지 제한 시간 안에 기다립니다. */
async function until(code: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await js(code)) return;
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 50);
    });
  }
  const body = await js('document.body.innerText');
  throw new Error(
    `Timeout ${code}\n${typeof body === 'string' ? body : 'DOM unavailable'}`,
  );
}
/** 표시되고 활성인 실제 행동만 클릭합니다. */
async function click(label: string): Promise<void> {
  // 좁은 폭에서는 Header 버튼이 "화면 메뉴" 안에 접혀 있으므로 대상이 안 보이면 메뉴를 엽니다.
  await js(`(() => {
    const found = [...document.querySelectorAll('button,a')].some(b => (b.textContent.trim() || b.getAttribute('aria-label')) === ${JSON.stringify(label)});
    const toggle = document.querySelector('button[aria-label="화면 메뉴"]');
    if (!found && toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
  })()`);
  await until(
    `(() => { const b = [...document.querySelectorAll('button,a')].find(b => (b.textContent.trim() || b.getAttribute('aria-label')) === ${JSON.stringify(label)} && b.getBoundingClientRect().width && !b.disabled); if(!b) return false; b.click(); return true; })()`,
  );
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
}
/** 접혀 있는 편집 화면의 문서 정보(제목·태그·설명) 입력란을 펼칩니다. */
async function openMetadata(): Promise<void> {
  await until(
    `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '문서 정보 (제목 · 태그 · 설명)'); if(!b) return false; if(b.getAttribute('aria-expanded') !== 'true') b.click(); return true; })()`,
  );
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
}
/** 헤더 위치 경로의 '문서' 링크로 문서 목록에 돌아갑니다(편집 이력 항목을 거치지 않음). */
async function goToList(): Promise<void> {
  await until(
    `(() => { const a = document.querySelector('nav[aria-label="현재 위치"] a'); if(!a || !a.getBoundingClientRect().width) return false; a.click(); return true; })()`,
  );
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
}
/** React 입력의 네이티브 이벤트로 실제 초안을 갱신합니다. */
async function input(selector: string, value: string): Promise<void> {
  // 본문을 다시 읽는 동안에는 입력란이 잠기므로 활성화된 뒤에 입력합니다.
  await until(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.disabled; })()`,
  );
  await js(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); const p = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`,
  );
}
/** 두 프레임 뒤 실제 제품 픽셀을 선택적으로 보관합니다. */
async function capture(name: string): Promise<void> {
  await js(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  await new Promise<void>((done: () => void): void => {
    setTimeout(done, 100);
  });
  const resizeChecks = [
    'document-reading-rich',
    'document-library-rich',
    'document-reading-wide',
    'comparison-wide',
    'register-wide',
    'settings-wide',
    'settings-ai',
    'artifact-content-wide',
  ].includes(name);
  await auditAccessibility(window, `doc-${name}`, {
    textSpacing: resizeChecks,
    zoom: resizeChecks,
  });
  if (process.env.WIKI_UI_TEST_CAPTURE_DIR)
    await writeFile(
      join(process.env.WIKI_UI_TEST_CAPTURE_DIR, name + '.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
}
// Use only the shipped IPC bridge and actual isolated HTTP backend for document/history operations.
const request = `(async (operation, input) => { const {data:c} = await window.wiki.connection.getState(); return window.wiki.workspace.execute({operation, input, connectionId:c.connectionId, expectedScope:{userId:c.userId, tenant:c.selection.tenant, profileId:c.selection.profile, policyRevision:c.policyRevision, accessRevision:c.accessRevision}}); })`;
const personal = z.object({
  revision: z.string(),
  record: z.object({ id: z.string() }),
});
const versions = z.object({
  items: z.array(z.object({ revision: z.string(), history_id: z.string() })),
});
function operation(
  name: 'createConversation' | 'appendTurn' | 'createSavedResult',
  data: unknown,
): Promise<z.infer<typeof personal>>;
function operation(
  name: 'documentVersions',
  data: unknown,
): Promise<z.infer<typeof versions>>;
function operation(
  name: 'saveDocument' | 'documentVersion',
  data: unknown,
): Promise<unknown>;
/** 제품 응답 파서를 거쳐 검증에 필요한 필드만 읽습니다. */
async function operation(name: string, data: unknown): Promise<unknown> {
  const result = parseWorkspaceResult(
    await js(`${request}(${JSON.stringify(name)}, ${JSON.stringify(data)})`),
  );
  if (!result.ok) throw Error(JSON.stringify(result.error));
  return name === 'documentVersions'
    ? versions.parse(result.data.data)
    : name === 'saveDocument' || name === 'documentVersion'
      ? result.data.data
      : personal.parse(result.data.data);
}
/** 현재 전체 파일과 서버 판본을 실제 bridge로 읽습니다. */
async function read(document = 'comparison.md'): Promise<DocumentContent> {
  const result = parseDocumentContentResult(
    await js(
      `(async()=>{const {data:c}=await window.wiki.connection.getState();return window.wiki.documents.content({connectionId:c.connectionId,document:${JSON.stringify(document)}});})()`,
    ),
  );
  if (!result.ok) throw Error(result.error.message);
  return result.data;
}

/** 긴 실제 Markdown을 격리 저장해 목록 밀도와 본문 중심 배치를 함께 검증합니다. */
async function verifyRichReading(): Promise<void> {
  await js("location.hash='#/register'");
  const document = '문서-변경과-검토-안내.md';
  const content =
    [
      '## 문서를 함께 관리하는 방법',
      '',
      '문서를 읽는 사람은 현재 내용과 변경 이유를 함께 이해할 수 있어야 합니다. 이 안내는 원본 등록부터 본문 편집, 검토와 이력 확인까지 이어지는 작업을 설명합니다.',
      '',
      '원본과 위키 본문은 서로 다른 역할을 갖습니다. 원본은 전달받은 자료를 보관하고, 위키는 사람이 내용을 읽고 수정하는 문서입니다. 관계 추출 결과는 본문과 연결해 확인하되 검토 전 결과임을 구분합니다.',
      '',
      '## 변경 전 확인할 사항',
      '',
      '- 문서 제목과 설명이 현재 범위를 정확히 나타내는지 확인합니다.',
      '- 원본의 판본과 문서가 연결되어 있는지 확인합니다.',
      '- 저장 전 변경 내용을 비교하고 누락된 문단이 없는지 확인합니다.',
      '',
      '| 작업 | 확인할 내용 | 다음 행동 |',
      '| --- | --- | --- |',
      '| 본문 편집 | 문장과 문서 정보의 변경 | 변경 내용 확인 |',
      '| 관계 검토 | 근거 문장과 연결 대상 | 관계 화면 열기 |',
      '| 이전 내용 확인 | 선택한 판본과 현재 본문 | 이력 비교 |',
      '',
      '## 저장과 이력',
      '',
      '저장하면 수정 전 전체 파일이 이력으로 남습니다. 다른 사람이 먼저 문서를 변경한 경우에는 최신 내용을 확인하고 자신의 수정 사항을 다시 반영합니다. 이전 판본으로 복원하는 작업도 새로운 저장이며 기존 이력을 삭제하지 않습니다.',
      '',
      '> 문서의 내용과 검토 상태는 서로 구분해 확인합니다. 본문을 저장했다고 관계 검토까지 완료되는 것은 아닙니다.',
      '',
      '## 공유 전 읽어 보기',
      '',
      '긴 제목, 여러 문단, 목록과 표를 포함한 내용을 읽어 보며 정보의 흐름을 확인합니다. 화면이 좁아져도 본문을 먼저 읽을 수 있고 문서 정보는 필요할 때 열 수 있어야 합니다.',
    ].join('\n') + '\n';
  for (const [path, body] of [
    [document, content],
    ['회의-기록.md', '다음 회의에서 문서 검토 결과를 확인합니다.\n'],
    ['등록-원본-안내.md', '원본은 전달받은 자료 그대로 보관합니다.\n'],
  ])
    await operation('saveDocument', {
      document: path,
      content: body,
      expected_revision: null,
    });
  await js("location.hash='#/documents'");
  await until(
    "document.querySelector('table')?.innerText.includes('문서-변경과-검토-안내')",
  );
  await capture('document-library-rich');
  assert.ok(
    await js(
      "[...document.querySelectorAll('tbody tr')].every(row => row.getBoundingClientRect().height >= 64 && row.getBoundingClientRect().height <= 65)",
    ),
  );
  await js(
    "(() => { const select=document.querySelector('select[aria-label=\"문서 상태 필터\"]');select.value='ready';select.dispatchEvent(new Event('change',{bubbles:true})); })()",
  );
  await until("document.body.innerText.includes('검색 결과가 없습니다')");
  assert.equal(await js("document.querySelectorAll('tbody tr').length"), 0);
  await js(
    "(() => { const select=document.querySelector('select[aria-label=\"문서 상태 필터\"]');select.value='missing';select.dispatchEvent(new Event('change',{bubbles:true})); })()",
  );
  await until("document.querySelectorAll('tbody tr').length===3");
  for (const width of [480, 320]) {
    window.setContentSize(width, 820);
    await capture('document-library-rich-' + width);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
    assert.equal(
      await js(
        "getComputedStyle(document.querySelector('tbody td:nth-child(2)')).display",
      ),
      'grid',
    );
  }
  window.setContentSize(1440, 960);
  await click('문서-변경과-검토-안내');
  await until(
    "document.querySelector('[aria-label=\"문서 본문\"]')?.innerText.includes('공유 전 읽어 보기')",
  );
  await capture('document-reading-rich');
  await click('본문 편집');
  await capture('document-editing-rich');
  // 문서 정보 입력란은 기본으로 접혀 있으므로 펼친 뒤 줄 번호 틀을 포함한 편집기 폭과 맞춰 봅니다.
  await click('문서 정보 (제목 · 태그 · 설명)');
  assert.ok(
    await js(`(() => {
    const fields = document.querySelector('fieldset').getBoundingClientRect();
    const editor = document.querySelector('textarea[name=document-markdown]').parentElement.getBoundingClientRect();
    return Math.abs(fields.left-editor.left)<1 && Math.abs(fields.right-editor.right)<1;
  })()`),
  );
  for (const width of [480, 320]) {
    window.setContentSize(width, 820);
    await capture('document-editing-rich-' + width);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
  }
  window.setContentSize(1440, 960);
  await click('취소');
  for (const width of [480, 320]) {
    window.setContentSize(width, 820);
    await capture('document-reading-rich-' + width);
    assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
  }
  window.setContentSize(1440, 960);
  await goToList();
  await until("!!document.querySelector('tr[data-selected=true]')");
  assert.equal(
    await js(
      'document.querySelector(\'select[aria-label="문서 상태 필터"]\').value',
    ),
    'missing',
  );
  await js(
    "(() => { const select=document.querySelector('select[aria-label=\"문서 상태 필터\"]');select.value='all';select.dispatchEvent(new Event('change',{bubbles:true})); })()",
  );
  assert.equal((await read(document)).body, content);
  console.log(
    'PASS real rich Markdown reading/editing, compact library filters, empty filtered result, 480/320px reflow and filter return context',
  );
}
type RestoreFixture = {
  document: string;
  original: DocumentContent;
  current: DocumentContent;
  historyId: string;
};
/** 공개 저장 경로로 두 전체 파일 판본을 만들어 실제 이력 ID를 구합니다. */
async function restoreFixture(document: string): Promise<RestoreFixture> {
  await operation('saveDocument', {
    document,
    content: '과거 버전의 합성 본문입니다.\n한글과 😀 공백  보존\n',
    expected_revision: null,
  });
  const original = await read(document);
  await operation('saveDocument', {
    document,
    content:
      original.content
        .replace(/^title:.*$/m, 'title: "복원 전 최신 제목"')
        .replace(/^tags:.*$/m, 'tags: ["현재 태그"]') + '복원 직전 전체 본문\n',
    expected_revision: original.revision,
  });
  const current = await read(document);
  const history = await operation('documentVersions', {
    document,
    cursor: null,
    limit: 50,
  });
  const version = history.items.find(
    (item: (typeof history.items)[number]): boolean =>
      item.revision === original.revision,
  );
  assert.ok(version);
  return { document, original, current, historyId: version.history_id };
}
/** 실제 200% 확대에서 읽기·편집 행동과 미저장 초안을 확인하고 원래 배율을 복원합니다. */
async function verifyReadingZoom(draft: string): Promise<void> {
  const originalZoom = window.webContents.getZoomFactor();
  try {
    window.webContents.setZoomFactor(2);
    await until(
      'innerWidth <= 720 && !!document.querySelector(\'[aria-label="문서 본문"]\')',
    );
    assert.equal(window.webContents.getZoomFactor(), 2);
    // 확대해도 문서 정보 칩 줄이 본문 위에 남아 있는지 확인한 뒤 측정합니다.
    await until(
      `!!document.querySelector('[data-layout="reading"] [class*="chipRow"]')`,
    );
    assert.ok(
      await js(`(() => {
      const page = document.querySelector('[data-workspace-route][data-active="true"]');
      const body = document.querySelector('[aria-label="문서 본문"]');
      return page.scrollWidth <= page.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1 && body.getBoundingClientRect().width > 0 && body.innerText.includes('과거 버전의 합성 본문');
    })()`),
    );
    // 주 행동 버튼은 앱 Header에 놓이고 좁은 폭에서는 "화면 메뉴" 안에 접히므로 메뉴를 먼저 엽니다.
    await js(`(() => {
      const toggle = document.querySelector('button[aria-label="화면 메뉴"]');
      if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
    })()`);
    await until(
      `[...document.querySelectorAll('header button')].some(button => button.textContent.includes('본문 편집'))`,
    );
    await js(`(() => {
      const edit = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '본문 편집');
      edit.scrollIntoView({block:'center'});
      edit.focus();
    })()`);
    assert.ok(
      await js(`(() => {
      const edit = document.activeElement.getBoundingClientRect();
      const content = document.querySelector('#app-content').getBoundingClientRect();
      return document.activeElement.textContent.trim() === '본문 편집' && edit.left >= content.left && edit.right <= content.right + 1 && edit.top >= content.top && edit.bottom <= content.bottom + 1;
    })()`),
    );
    await capture('document-reading-200-percent');
    await click('본문 편집');
    assert.equal(
      await js(
        "document.querySelector('textarea[name=document-markdown]').value",
      ),
      draft,
    );
    assert.ok(
      await js(`(() => {
      const page = document.querySelector('[data-workspace-route][data-active="true"]');
      return page.scrollWidth <= page.clientWidth + 1;
    })()`),
    );
    await capture('document-editing-200-percent');
    await click('취소');
  } finally {
    window.webContents.setZoomFactor(originalZoom);
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
  }
  assert.equal(window.webContents.getZoomFactor(), originalZoom);
  console.log(
    'PASS actual 200% page zoom keeps the chip row above the body, reading/edit action reachable, page width contained and unsaved draft intact; original zoom restored',
  );
}
/** 직접 주소로 선택한 실제 판본의 비교가 표시될 때까지 기다립니다. */
async function selectRestore(fixture: RestoreFixture): Promise<void> {
  const query = new URLSearchParams({
    path: fixture.document,
    version: fixture.historyId,
    against: 'current',
  });
  await js(`location.hash=${JSON.stringify('#/document?' + query)}`);
  await until(
    `document.querySelector('[aria-label="버전 변경 보기"]')?.innerText.includes('과거 버전의 합성 본문')`,
  );
}
/** 복원은 새 전체 파일 저장이며 현재 파일과 선택한 원본 이력을 보존합니다. */
async function assertRestored(fixture: RestoreFixture): Promise<void> {
  await until("document.body.innerText.includes('버전 복원 완료')");
  await until(
    "document.querySelector('[aria-label=\"문서 본문\"]')?.innerText.includes('과거 버전의 합성 본문')",
  );
  const restored = await read(fixture.document);
  assert.equal(restored.content, fixture.original.content);
  assert.equal(restored.documentId, fixture.current.documentId);
  assert.deepEqual(restored.metadata, fixture.original.metadata);
  const history = await operation('documentVersions', {
    document: fixture.document,
    cursor: null,
    limit: 50,
  });
  const previous = history.items.find(
    (item: (typeof history.items)[number]): boolean =>
      item.revision === fixture.current.revision,
  );
  assert.ok(previous);
  for (const [historyId, content] of [
    [previous.history_id, fixture.current.content],
    [fixture.historyId, fixture.original.content],
  ]) {
    const historical = z.object({ content: z.string() }).parse(
      await operation('documentVersion', {
        document: fixture.document,
        history_id: historyId,
      }),
    );
    assert.equal(historical.content, content);
  }
}
/** 정상·미저장·실제 경쟁 쓰기를 독립 합성 문서로 검증합니다. */
async function verifyRestoration(): Promise<RestoreFixture> {
  const success = await restoreFixture('restore-success.md');
  await selectRestore(success);
  await js(
    "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='이 버전으로 복원').scrollIntoView({block:'end'})",
  );
  await capture('restore-comparison-wide');
  window.setContentSize(480, 820);
  await js(
    "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='이 버전으로 복원').scrollIntoView({block:'end'})",
  );
  await capture('restore-comparison-narrow');
  assert.ok(
    await js(
      'document.querySelector(\'[aria-label="버전 변경 보기"]\').scrollWidth <= document.querySelector(\'[aria-label="버전 변경 보기"]\').clientWidth + 1',
    ),
  );
  window.setContentSize(1440, 960);
  let requests = restorationRequests;
  await click('이 버전으로 복원');
  await assertRestored(success);
  assert.equal(restorationRequests, requests + 1);
  await capture('restore-success');
  console.log(
    'PASS restore success, stable document ID, historical metadata and exact before/selected whole-file histories retained; wide/480px comparison',
  );

  const dirty = await restoreFixture('restore-dirty.md');
  await js(`location.hash='#/document?path=${dirty.document}'`);
  await until(
    `document.querySelector('header h1')?.textContent.includes(${JSON.stringify(dirty.current.metadata?.title)}) && !!document.querySelector('[aria-label="문서 본문"]') && !!document.querySelector('[data-layout="reading"] [class*="chipRow"]')`,
  );
  // 문서 정보는 본문 옆 패널이 아니라 제목 아래 칩 줄에 두고, 본문은 읽기 폭을 넘지 않습니다.
  assert.ok(
    await js(`(() => {
    const body = document.querySelector('[aria-label="문서 본문"]').getBoundingClientRect();
    const chips = document.querySelector('[data-layout="reading"] [class*="chipRow"]').getBoundingClientRect();
    return body.width <= 760 && chips.bottom <= body.top && !document.querySelector('[data-layout="reading"] aside');
  })()`),
  );
  await capture('document-reading-wide');
  for (const width of [480, 320]) {
    window.setContentSize(width, 820);
    await js(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.ok(
      await js(`(() => {
      const body = document.querySelector('[aria-label="문서 본문"]').getBoundingClientRect();
      const chips = document.querySelector('[data-layout="reading"] [class*="chipRow"]').getBoundingClientRect();
      return chips.bottom <= body.top && chips.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    })()`),
    );
    await capture('document-reading-' + width);
  }
  window.setContentSize(1440, 960);
  await until('!!document.querySelector(\'[aria-label="문서 본문"]\')');
  await click('본문 편집');
  const draft =
    (dirty.current.body ?? dirty.current.content) + '미저장 초안 보존\n';
  await input('textarea[name=document-markdown]', draft);
  await click('취소');
  await verifyReadingZoom(draft);
  await selectRestore(dirty);
  requests = restorationRequests;
  assert.ok(
    await js(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='이 버전으로 복원' && b.disabled)",
    ),
  );
  assert.equal((await read(dirty.document)).content, dirty.current.content);
  // 버전 변경 보기에서는 편집을 잠그므로 현재 본문으로 돌아온 뒤 보관된 초안을 확인합니다.
  await click('현재 본문으로 돌아가기');
  await click('본문 편집');
  assert.equal(
    await js(
      "document.querySelector('textarea[name=document-markdown]').value",
    ),
    draft,
  );
  assert.equal(restorationRequests, requests);
  console.log(
    'PASS unsaved draft blocks restoration without discarding draft or writing history',
  );

  const conflict = await restoreFixture('restore-conflict.md');
  await selectRestore(conflict);
  await operation('saveDocument', {
    document: conflict.document,
    content: conflict.current.content + '다른 클라이언트가 먼저 저장한 본문\n',
    expected_revision: conflict.current.revision,
  });
  const remote = await read(conflict.document);
  requests = restorationRequests;
  await click('이 버전으로 복원');
  await until(
    "document.body.innerText.includes('복원 전에 본문이 변경되었습니다')",
  );
  assert.equal((await read(conflict.document)).content, remote.content);
  assert.equal(restorationRequests, requests + 1);
  await click('현재 본문 다시 확인');
  await until(
    "!document.body.innerText.includes('복원 전에 본문이 변경되었습니다')",
  );
  await selectRestore(conflict);
  await until(
    "document.querySelector('[aria-label=\"버전 변경 보기\"]')?.innerText.includes('다른 클라이언트가 먼저 저장한 본문')",
  );
  assert.equal(restorationRequests, requests + 1);
  assert.equal((await read(conflict.document)).content, remote.content);
  await capture('restore-conflict-recompare');
  await click('이 버전으로 복원');
  await assertRestored({ ...conflict, current: remote });
  assert.equal(restorationRequests, requests + 2);
  console.log(
    'PASS actual CAS conflict, read-only refresh/recomparison, explicit restoration retry and concurrent whole-file history retained',
  );
  return success;
}
/** 격리 정책에서 시험 계정만 읽기 전용으로 바꾸고 재로그인한 실제 권한을 확인합니다. */
async function verifyReadOnlyRestore(fixture: RestoreFixture): Promise<void> {
  await js("location.hash='#/settings'");
  await click('로그아웃');
  await until("!!document.querySelector('#account-title')");
  const config = join(root, 'server/.local/tenancy/access.json');
  const policy = z
    .object({
      users: z.record(
        z.string(),
        z
          .object({
            display_name: z.string(),
            memberships: z.record(
              z.string(),
              z
                .object({
                  permissions: z.array(z.string()),
                })
                .loose(),
            ),
          })
          .loose(),
      ),
    })
    .loose()
    .parse(JSON.parse(await readFile(config, 'utf8')));
  const account = Object.values(policy.users).find(
    (user: (typeof policy.users)[string]): boolean =>
      user.display_name === '별도 탐색 사용자',
  );
  assert.ok(account);
  for (const membership of Object.values(account.memberships))
    membership.permissions = ['read'];
  await writeFile(config, JSON.stringify(policy) + '\n', { mode: 0o600 });
  // 로그아웃한 계정은 기억된 계정 카드로 남으므로 이름을 다시 입력하지 않고 로그인합니다.
  await click('로그인');
  await until('!!document.querySelector(\'a[href="#/documents"]\')');
  const before = await read(fixture.document);
  const requests = restorationRequests;
  await selectRestore(fixture);
  // 비활성 단추 옆에는 문구를 두지 않으므로 이유는 단추의 title로 확인합니다.
  await until(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='이 버전으로 복원' && b.disabled && b.title==='읽기 전용 권한에서는 버전을 복원할 수 없습니다.')",
  );
  assert.ok(
    await js(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='이 버전으로 복원' && b.disabled)",
    ),
  );
  assert.equal((await read(fixture.document)).content, before.content);
  assert.equal(restorationRequests, requests);
  await capture('restore-readonly');
  console.log(
    'PASS actual read-only account blocks historical restoration with no write',
  );
}
/** 제품 등록 컴포넌트의 영수증별 상태를 별도 fixture 창에서 확인합니다. */
async function verifyRegistrationFixtures(): Promise<void> {
  window.webContents.on('console-message', (details): void => {
    if (details.level === 'error')
      console.error('Registration fixture:', details.message);
  });
  await window.loadURL(
    pathToFileURL(join(root, 'registration/index.html')).href,
  );
  await until("document.body.innerText.includes('실행할 준비가 되었습니다')");
  assert.equal(
    await js(
      "getComputedStyle(document.documentElement).getPropertyValue('--wiki-component-control-height').trim()",
    ),
    '36px',
  );
  for (const [phase, label, expected] of [
    ['ready', 'ready', '실행할 준비가 되었습니다'],
    ['running', 'running', '개인 CLI가 작업을 진행 중입니다'],
    ['error', 'error', '문서를 만들지 못했습니다'],
    ['partial', 'partial', 'Markdown 본문은 저장됐습니다'],
    ['complete', 'complete', '문서를 만들고 관계를 추출했습니다'],
    ['error', 'saved-error', '저장한 문서의 상태를 다시 확인해 주세요'],
  ]) {
    await js(`window.__registrationFixture.change(${JSON.stringify(phase)})`);
    await until(
      `document.body.innerText.includes(${JSON.stringify(expected)})`,
    );
    for (const width of [1440, 480, 320]) {
      window.setContentSize(width, 960);
      await capture(`registration-fixture-${label}-${width}`);
      assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
    }
    if (phase === 'complete' || phase === 'partial') {
      assert.ok(
        await js(
          "[...document.querySelectorAll('a')].some(a=>a.textContent.includes('문서 열기') && a.getAttribute('href')==='/document?path='+encodeURIComponent('운영-안내.md'))",
        ),
      );
      assert.equal(
        await js("document.body.innerText.includes('저장 결과')"),
        true,
      );
    }
    if (phase === 'error')
      assert.ok(await js("!!document.querySelector('[role=alert]')"));
  }
  // 등록 직후 관계 추출은 자동으로 한 번만 시작되며, 이후 상태 변화나 새로고침이 다시 실행하지 않습니다.
  assert.equal(await js('window.__registrationFixture.executions()'), 1);
  console.log(
    'PASS receipt-schema fixtures: registration ready/running/partial/complete/error at wide/480/320px, saved-document actions and error visibility; exactly one automatic start (fixture API, no real AI)',
  );
}
/** 임시 서버의 합성 자료로 실제 앱 흐름을 검증합니다. */
async function verify(): Promise<void> {
  await app.whenReady();
  const location = pathToFileURL(join(appRoot, 'out/renderer/index.html')).href;
  stop = await registerConnectionHandlers(
    (): BrowserWindow | null => window ?? null,
    location,
  );
  window = new BrowserWindow({
    show: false,
    width: 1440,
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
  if (process.env.WIKI_REGISTRATION_FIXTURE_ONLY === '1') {
    await verifyRegistrationFixtures();
    return;
  }
  await window.loadURL(location);
  await until("!!document.querySelector('input[name=name]')");
  await auditAccessibility(window, 'doc-login', {
    textSpacing: true,
    zoom: true,
  });
  await input('input[name=name]', '문서 비교 격리 검증');
  await input('input[name=serverUrl]', url);
  await js("document.querySelector('input[value=signup]').click()");
  await click('가입하고 시작');
  await until('!!document.querySelector(\'a[href="#/documents"]\')');
  await verifyRichReading();
  if (process.env.WIKI_DOCUMENT_READING_ONLY === '1') {
    const document = await read('문서-변경과-검토-안내.md');
    const artifact = await operation('createSavedResult', {
      request_id: randomUUID().replaceAll('-', ''),
      title: '문서 검토 안내 초안',
      content: document.body ?? document.content,
      context_request: { documents: ['문서-변경과-검토-안내.md'] },
    });
    await js(`location.hash='#/artifact?artifactId=${artifact.record.id}'`);
    await until("document.body.innerText.includes('개인 초안 ·')");
    console.log(
      'ARTIFACT TABLE DIAGNOSTIC',
      await js(
        `JSON.stringify(Array.from(document.querySelectorAll('article table, article thead, article th, article tbody td')).map(e=>({tag:e.tagName,html:e.outerHTML.slice(0,400),display:getComputedStyle(e).display,position:getComputedStyle(e).position,left:e.getBoundingClientRect().left,width:e.getBoundingClientRect().width,padding:getComputedStyle(e).padding})))`,
      ),
    );
    await capture('artifact-reference-wide');
    window.setContentSize(480, 820);
    await capture('artifact-reference-480');
    return;
  }
  const body = Array.from(
    { length: 180 },
    (_value: unknown, i: number): string =>
      `문장 ${i} 한글과 😀 공백  보존\r\n`,
  ).join('');
  await operation('saveDocument', {
    document: 'comparison.md',
    content: body,
    expected_revision: null,
  });
  const original = await read();
  for (let i = 0; i < 12; i++) {
    const current = await read();
    await operation('saveDocument', {
      document: 'comparison.md',
      content: current.content + `이력 ${i}\n`,
      expected_revision: current.revision,
    });
  }
  await js("location.hash='#/document?path=comparison.md'");
  await until('!!document.querySelector(\'[aria-label="문서 본문"]\')');
  await click('본문 편집');
  await openMetadata();
  await input('input[name=description]', '적용 버튼 없이 보존한 설명');
  await input('input[name=title]', '비교 검증 제목');
  await input('input[placeholder^="태그 입력"]', '한글, 검증');
  await click('변경 내용 확인');
  await js(
    'document.querySelector(\'[aria-label="문서 정보 비교"] summary\').click()',
  );
  await until(
    "document.querySelector('[aria-label=\"문서 정보 비교\"]').innerText.includes('적용 버튼 없이 보존한 설명')",
  );
  // 비교는 사용자가 편집한 내용을 보존하고 서버 소유 참조를 펼침 안에도 남기지 않습니다.
  const metadataComparison = await js(
    'document.querySelector(\'[aria-label="문서 정보 비교"]\').textContent',
  );
  assert.equal(typeof metadataComparison, 'string');
  assert.ok(String(metadataComparison).includes('비교 검증 제목'));
  assert.ok(String(metadataComparison).includes('한글'));
  assert.equal(String(metadataComparison).includes('document_id'), false);
  assert.ok(original.documentId);
  assert.equal(String(metadataComparison).includes(original.documentId), false);
  assert.equal(String(metadataComparison).includes('schema_version'), false);
  assert.ok(
    await js(
      "document.querySelector('[aria-label=\"본문 비교\"]').innerText.includes('변경 없음')",
    ),
  );
  await click('계속 편집');
  await openMetadata();
  assert.equal(
    await js("document.querySelector('input[name=description]').value"),
    '적용 버튼 없이 보존한 설명',
  );
  await click('취소');
  await click('본문 편집');
  await openMetadata();
  assert.equal(
    await js("document.querySelector('input[name=title]').value"),
    '비교 검증 제목',
  );
  await input('input[name=title]', '');
  await click('변경 내용 확인');
  await openMetadata();
  assert.equal(
    await js("document.querySelector('input[name=title]').value"),
    '',
  );
  await click('취소');
  await click('본문 편집');
  await openMetadata();
  assert.equal(
    await js("document.querySelector('input[name=title]').value"),
    '',
  );
  await input('input[name=title]', '비교 검증 제목');
  await click('변경 내용 확인');
  await click('저장');
  await until("document.body.innerText.includes('본문 저장 완료')");
  let saved = await read();
  assert.equal(saved.metadata?.description, '적용 버튼 없이 보존한 설명');
  assert.equal(saved.metadata?.title, '비교 검증 제목');
  assert.equal(saved.documentId, original.documentId);
  assert.equal(
    saved.body,
    body +
      Array.from(
        { length: 12 },
        (_value: unknown, i: number): string => `이력 ${i}\n`,
      ).join(''),
  );
  console.log(
    'PASS real HTTP metadata-only save, invalid draft/read transition preservation, stable document ID and exact CRLF body',
  );
  await operation('saveDocument', {
    document: 'comparison.md',
    content: saved.content.replaceAll('\r\n', '\n'),
    expected_revision: saved.revision,
  });
  saved = await read();
  await js("location.hash='#/documents'");
  await until('!!document.querySelector(\'[aria-label="문서 보관함"]\')');
  await js("location.hash='#/document?path=comparison.md'");
  await until('!!document.querySelector(\'[aria-label="문서 본문"]\')');
  await click('본문 편집');
  await until("!!document.querySelector('textarea[name=document-markdown]')");
  assert.equal(
    await js(
      "document.querySelector('textarea[name=document-markdown]').value",
    ),
    saved.body ?? saved.content,
  );
  await input(
    'textarea[name=document-markdown]',
    (saved.body ?? saved.content)
      .replace('문장 50 ', '수정 50 ')
      .replace('문장 130 ', '수정 130 '),
  );
  await click('변경 내용 확인');
  await until(
    "document.querySelector('[aria-label=\"본문 비교\"]').innerText.includes('1 / 2 변경 구간')",
  );
  await js(
    "document.querySelector('[aria-label=\"본문 비교\"] h4').scrollIntoView({block:'start'})",
  );
  await capture('comparison-wide');
  await click('다음 변경');
  assert.ok(
    await js(
      "document.querySelector('[aria-label=\"본문 비교\"]').innerText.includes('수정 130')",
    ),
  );
  assert.equal(await js('document.activeElement.tagName'), 'H4');
  await click('전체 줄 보기');
  assert.ok(await js("document.querySelectorAll('[data-kind]').length <= 120"));
  await click('다음 줄');
  await capture('comparison-page');
  window.setContentSize(480, 820);
  await js(
    "document.querySelector('[aria-label=\"본문 비교\"] h4').scrollIntoView({block:'start'})",
  );
  await until(
    "document.querySelector('[data-kind]').getBoundingClientRect().width < 640",
  );
  assert.equal(
    await js("getComputedStyle(document.querySelector('[data-kind]')).display"),
    'block',
  );
  assert.ok(
    await js(
      'document.querySelector(\'[aria-label="본문 비교"]\').scrollWidth <= document.querySelector(\'[aria-label="본문 비교"]\').clientWidth + 1',
    ),
  );
  await capture('comparison-narrow');
  // 테마는 설정의 화면 구분에서 고르며, 다녀온 뒤에도 보관된 비교 화면이 그대로여야 합니다.
  await js("location.hash='#/settings?section=appearance'");
  await until("!!document.querySelector('input[type=radio][value=dark]')");
  await js("document.querySelector('input[type=radio][value=dark]').click()");
  await js('history.back()');
  await until(
    "!!document.querySelector('[aria-label=\"본문 비교\"]') && document.querySelector('[data-wiki-theme]')?.getAttribute('data-wiki-theme') === 'dark'",
  );
  await capture('comparison-dark');
  window.setContentSize(1440, 960);
  console.log(
    'PASS change navigation/focus, paged full context, 480px unified view, light/dark rendering',
  );
  // External writer creates a real CAS conflict; UI must keep both drafts.
  const remote = saved.content + '다른 사람 수정\n';
  await operation('saveDocument', {
    document: 'comparison.md',
    content: remote,
    expected_revision: saved.revision,
  });
  await click('저장');
  await until("document.body.innerText.includes('다른 사람이 먼저')");
  await click('최신 본문과 내 초안 비교');
  await until("!!document.querySelector('textarea[name=reconciled-document]')");
  assert.ok(
    await js(
      "document.querySelector('textarea[name=reconciled-document]').value.includes('다른 사람 수정')",
    ),
  );
  await input('input[name=description]', '충돌에서 검토한 설명');
  await input(
    'textarea[name=reconciled-document]',
    (saved.body ?? saved.content) + '다른 사람 수정\n검토한 재반영\n',
  );
  await click('검토한 본문으로 비교 계속');
  await click('저장');
  await until(
    "document.body.innerText.includes('본문 저장 완료') && document.querySelector('[aria-label=\"문서 본문\"]')?.innerText.includes('검토한 재반영') && !document.querySelector('textarea[name=document-markdown]')",
  );
  const reconciled = await read();
  assert.equal(reconciled.metadata?.description, '충돌에서 검토한 설명');
  assert.ok(reconciled.body?.endsWith('다른 사람 수정\n검토한 재반영\n'));
  const history = await operation('documentVersions', {
    document: 'comparison.md',
    cursor: null,
    limit: 50,
  });
  assert.ok(
    history.items.some(
      (item: (typeof history.items)[number]): boolean =>
        item.revision === saved.revision,
    ),
  );
  const originalVersion = history.items.find(
    (item: (typeof history.items)[number]): boolean =>
      item.revision === original.revision,
  );
  assert.ok(originalVersion);
  const historical = z.object({ content: z.string() }).parse(
    await operation('documentVersion', {
      document: 'comparison.md',
      history_id: originalVersion.history_id,
    }),
  );
  assert.equal(historical.content, original.content);
  console.log(
    'PASS actual concurrent writer/CAS conflict, explicit rebase with metadata and full history retained',
  );
  // 버전 칩의 말풍선에서 저장 이력을 고르면 본문 자리에 그 버전의 변경 보기가 열립니다.
  await js(
    "(() => { const b = [...document.querySelectorAll('button')].find(b => /^버전 \\d+\\+?개/.test(b.textContent.trim())); b.click(); })()",
  );
  await until(
    'document.querySelectorAll(\'[aria-label="버전 선택"] li\').length >= 12',
  );
  await js(
    'document.querySelector(\'[aria-label="버전 선택"] li:nth-child(2) button\').click()',
  );
  await until('!!document.querySelector(\'[aria-label="버전 변경 보기"]\')');
  assert.ok(
    await js("location.hash.includes('version=')"),
    'selected version is addressable',
  );
  assert.equal(
    await js('document.querySelectorAll(\'[aria-label="버전 선택"]\').length'),
    0,
  );
  await capture('history');
  window.setContentSize(480, 820);
  await until('!!document.querySelector(\'[aria-label="버전 변경 보기"]\')');
  await capture('history-narrow');
  window.setContentSize(320, 820);
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
  await capture('history-320');
  await click('현재 본문으로 돌아가기');
  await until(
    '!document.querySelector(\'[aria-label="버전 변경 보기"]\') && !!document.querySelector(\'[aria-label="문서 본문"]\')',
  );
  window.setContentSize(1440, 960);
  assert.equal(await js("location.hash.includes('version=')"), false);
  console.log(
    'PASS version chip menu opens the selected version change view, 480/320px fit and return to current body',
  );
  await goToList();
  await until('!!document.querySelector(\'input[aria-label="문서 검색"]\')');
  await input('input[aria-label="문서 검색"]', '검토한 재반영');
  // 검색은 Enter(양식 제출)로 실행합니다.
  await js(
    'document.querySelector(\'input[aria-label="문서 검색"]\').form.requestSubmit()',
  );
  await until(
    "document.querySelector('table')?.innerText.includes('comparison')",
  );
  await click('comparison');
  await until('!!document.querySelector(\'[aria-label="문서 본문"]\')');
  await goToList();
  await until("!!document.querySelector('tr[data-selected=true]')");
  assert.equal(
    await js('document.querySelector(\'input[aria-label="문서 검색"]\').value'),
    '검토한 재반영',
  );
  assert.equal(await js('document.activeElement.tagName'), 'TR');
  console.log('PASS search/detail/list return context and selected row focus');
  const id = (): string => randomUUID().replaceAll('-', '');
  let conversation = await operation('createConversation', {
    request_id: id(),
    title: '읽는 위치 검증',
  });
  const questionId = id();
  conversation = await operation('appendTurn', {
    record_id: conversation.record.id,
    request_id: questionId,
    expected_revision: conversation.revision,
    role: 'user',
    content: '검증용 질문',
    context_request: { documents: ['comparison.md'] },
  });
  conversation = await operation('appendTurn', {
    record_id: conversation.record.id,
    request_id: id(),
    expected_revision: conversation.revision,
    role: 'assistant',
    content: Array.from(
      { length: 90 },
      (_value: unknown, i: number): string =>
        `문단 ${i} 보관된 시험 답변입니다.\n\n`,
    ).join(''),
    reply_to: questionId,
  });
  await js(`location.hash='#/chat?conversationId=${conversation.record.id}'`);
  await until(
    "document.querySelector('[role=log]')?.innerText.includes('문단 89')",
  );
  await until(
    "!!document.querySelector('#knowledge-chat-question') && !document.querySelector('#knowledge-chat-question').disabled",
  );
  await js(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
  );
  await js(
    "(() => { const log=document.querySelector('[role=log]');log.scrollTop=0;log.dispatchEvent(new Event('scroll')); })()",
  );
  await until("document.body.innerText.includes('최신 답변으로 이동')");
  const question = '센서 경고 조건을 한글과 영어로 적어 주세요. #한글영문';
  const reply = 'Sensor alarm 조건: threshold 초과 시 ALARM. 이모지 확인 ✅ 😀';
  await input('#knowledge-chat-question', question);
  await click('질문 보내기');
  await until(
    `[...document.querySelectorAll('[role=log] article')].some(article => article.innerText.includes(${JSON.stringify(reply)}))`,
  );
  // 진행 중 미리보기와 구별해 같은 서버 대화에 질문과 그 답변이 저장되었는지 확인합니다.
  const savedTurns = await js(`(async () => {
    const result = await ${request}('conversation', {record_id: ${JSON.stringify(conversation.record.id)}});
    if (!result.ok) throw new Error(result.error.code);
    const events = result.data.data.record.events;
    const [question, answer] = events.slice(-2);
    return [events.length, question.role, question.content.includes(${JSON.stringify(question)}),
      answer.role, answer.reply_to === question.id, answer.content];
  })()`);
  assert.deepEqual(savedTurns, [4, 'user', true, 'assistant', true, reply]);
  assert.equal(await js("document.querySelector('[role=log]').scrollTop"), 0);
  await capture('chat-reading-position');
  await click('최신 답변으로 이동');
  assert.ok(await js("document.querySelector('[role=log]').scrollTop > 0"));
  console.log(
    'PASS isolated fake CLI answer saved to the same conversation, reading position retained until explicit latest jump',
  );
  const artifactDocument = await read('문서-변경과-검토-안내.md');
  const artifact = await operation('createSavedResult', {
    request_id: id(),
    title: '개인 산출물 검증',
    content: artifactDocument.body ?? artifactDocument.content,
    context_request: { documents: ['문서-변경과-검토-안내.md'] },
  });
  await js(`location.hash='#/artifact?artifactId=${artifact.record.id}'`);
  await until("document.body.innerText.includes('개인 초안 ·')");
  assert.ok(
    await js(
      `!!document.querySelector('select[aria-label="내려받을 형식"]:enabled')?.querySelector('option[value="md"]') &&
       [...document.querySelectorAll('button:enabled')].some(b => b.textContent.trim() === '내려받기')`,
    ),
  );
  await capture('artifact-content-wide');
  window.setContentSize(480, 820);
  await capture('artifact-content-narrow');
  window.setContentSize(1440, 960);
  await click('본문 편집');
  await input('#artifact-title', '개인 초안 수정 제목');
  await capture('artifact-editing-wide');
  await click('프리뷰 보기');
  assert.ok(
    await js("document.body.innerText.includes('개인 초안 수정 제목')"),
  );
  console.log(
    'PASS actual saved artifact preview/edit retention, personal scope before long text, desktop Markdown export available',
  );
  for (let i = 0; i < 12; i++)
    await operation('saveDocument', {
      document: `target-${i}.md`,
      content: `연결 대상 ${i}\n`,
      expected_revision: null,
    });
  await operation('saveDocument', {
    document: 'connection-index.md',
    content: Array.from(
      { length: 12 },
      (_value: unknown, i: number): string => `[target-${i}](target-${i}.md)\n`,
    ).join(''),
    expected_revision: null,
  });
  await js("location.hash='#/connections?path=connection-index.md'");
  await until(
    "location.hash==='#/document?path=connection-index.md' && document.querySelector('[aria-label=\"문서 본문\"]')?.innerText.includes('target-11')",
  );
  window.setContentSize(480, 820);
  assert.equal(
    await js('document.querySelector(\'[aria-label="문서 연결 지도"]\')'),
    null,
  );
  assert.equal(
    await js('document.querySelector(\'a[href="#/connections"]\')'),
    null,
  );
  await capture('connections-selected-narrow');
  window.setContentSize(1440, 960);
  console.log(
    'PASS legacy connection address opens its actual document with reference text preserved and hidden map absent',
  );
  await js("location.hash='#/settings'");
  await until(
    '!!document.querySelector(\'[role=tablist][aria-label="설정 구분"]\')',
  );
  await js(
    'document.querySelector(\'[role=tablist][aria-label="설정 구분"] button\').focus()',
  );
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await until("document.activeElement.innerText.includes('AI 실행')");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await until(
    "document.activeElement.getAttribute('aria-selected')==='true' && document.activeElement.innerText.includes('AI 실행')",
  );
  await until(`(() => {
    const button = [...document.querySelectorAll('[role=tabpanel] [role=group][aria-label="연결할 AI 선택"] button:enabled')]
      .find(b => b.textContent.trim() === 'Claude Code');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await until(
    `!!document.querySelector('[aria-label="연결할 AI 선택"] button[aria-pressed=true]:enabled')?.textContent.includes('Claude Code')`,
  );
  const pathsSummary = `[...document.querySelectorAll('[role=tabpanel] details > summary')].find(s => s.textContent.trim().startsWith('프로그램 위치 · 문서 처리 진단'))`;
  await js(`${pathsSummary}.click()`);
  await click('변경한 위치 저장');
  await until(
    "!![...document.querySelectorAll('[role=status]')].find(n=>n.innerText.includes('다시 열어'))",
  );
  await js(`${pathsSummary}.click()`);
  assert.equal(await js(`${pathsSummary}.parentElement.open`), false);
  assert.ok(
    await js(
      "[...document.querySelectorAll('[role=status]')].find(n=>n.innerText.includes('다시 열어')).getBoundingClientRect().height>0",
    ),
  );
  assert.ok(
    await js(
      "[...document.querySelectorAll('[role=status]')].find(n=>n.innerText.includes('다시 열어')).closest('details')===null",
    ),
  );
  await capture('settings-ai');
  console.log(
    'PASS settings tab arrow-key navigation, temporary runtime save and restart notice outside closed details',
  );
  for (const route of [
    'connections',
    'chat',
    'artifact',
    'register',
    'settings',
  ]) {
    await js(`location.hash='#/${route}'`);
    await new Promise<void>((done: () => void): void => {
      setTimeout(done, 400);
    });
    await capture(route + '-wide');
    window.setContentSize(480, 820);
    await capture(route + '-narrow');
    window.setContentSize(1440, 960);
  }
  console.log(
    'PASS non-ontology routes mounted, wide/narrow screenshots (no AI call or synthetic returned files)',
  );
  await js("location.hash='#/register'");
  await click('텍스트 붙여넣기');
  await input('#import-title', '운영 안내 원본');
  await input(
    '#import-content',
    '등록한 원본은 그대로 보관합니다.\n\n편집 가능한 위키 문서와 원본 자료의 판본을 구분해 확인합니다.',
  );
  await capture('register-text');
  await click('등록하고 관계 추출');
  await until(
    "document.querySelector('[aria-label=\"등록 진행 결과\"]')?.innerText.includes('등록 원본 열기')",
  );
  // 등록은 원본 보관 뒤 관계 추출까지 자동으로 이어지며, 시험 서버에는 분석 규약이 없어 AI 실행 전에 멈춥니다.
  await until(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='다른 문서 등록' && !b.disabled)",
  );
  await capture('register-prepared');
  window.setContentSize(480, 820);
  await capture('register-prepared-480');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
  window.setContentSize(1440, 960);
  await click('등록 원본 열기');
  await until(
    "document.body.innerText.includes('편집 가능한 위키 문서와 원본 자료의 판본을 구분해 확인합니다.')",
  );
  await click('문서 정보');
  await until("!!document.querySelector('#source-facts')");
  const sourceFacts = await js(
    "document.querySelector('#source-facts').textContent",
  );
  assert.ok(String(sourceFacts).includes('등록 시각'));
  assert.equal(String(sourceFacts).includes('원본 ID'), false);
  assert.equal(String(sourceFacts).includes('버전 ID'), false);
  assert.equal(/[a-f0-9]{32}/.test(String(sourceFacts)), false);
  await click('문서 정보');
  console.log(
    'PASS actual text registration, preserved original preview and prepared-state wide/480px rendering without AI execution',
  );
  await js("location.hash='#/document?path=missing-fixture.md'");
  await until("document.body.innerText.includes('문서를 찾을 수 없습니다')");
  assert.ok(
    await js(
      "[...document.querySelectorAll('button')].some(b=>b.textContent==='다시 불러오기')",
    ),
  );
  await operation('saveDocument', {
    document: 'empty-fixture.md',
    content: '',
    expected_revision: null,
  });
  await js("location.hash='#/document?path=empty-fixture.md'");
  await until('!!document.querySelector(\'[aria-label="문서 본문"]\')');
  await click('본문 편집');
  await click('변경 내용 확인');
  await until("document.body.innerText.includes('두 본문 모두 비어 있습니다')");
  assert.ok(
    await js("document.body.innerText.includes('빈 본문을 저장합니다')"),
  );
  console.log('PASS actual missing-document error and empty-body comparison');
  const restoration = await verifyRestoration();
  await js("location.hash='#/settings'");
  await click('로그아웃');
  await until(
    "!!document.querySelector('#account-title') && !document.querySelector('aside')",
  );
  // 기억된 계정 카드가 있으면 이름 입력란이 없으므로 가입 방식을 먼저 고릅니다.
  await js("document.querySelector('input[value=signup]').click()");
  await input('input[name=name]', '별도 탐색 사용자');
  await click('가입하고 시작');
  await until(
    "!document.querySelector('#account-title') && !!document.querySelector('aside')",
  );
  await js("location.hash='#/documents'");
  await until('!!document.querySelector(\'input[aria-label="문서 검색"]\')');
  assert.equal(
    await js('document.querySelector(\'input[aria-label="문서 검색"]\').value'),
    '',
  );
  console.log('PASS account transition clears previous navigation context');
  await verifyReadOnlyRestore(restoration);
  await verifyRegistrationFixtures();
}
/** 모듈 평가가 Electron ready를 막지 않게 실행하고 창을 정리합니다. */
async function run(): Promise<void> {
  try {
    await verify();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    globalThis.fetch = actualFetch;
    if (window && !window.isDestroyed()) window.destroy();
    if (stop) await stop();
    app.exit(process.exitCode ? 1 : 0);
  }
}
void run();

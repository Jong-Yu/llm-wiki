import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const upstream = new URL(process.argv[2]);
assert.equal(upstream.protocol, 'http:');
assert.equal(upstream.hostname, '127.0.0.1');
const temporary = await mkdtemp('/private/tmp/wiki-expanded-cache-');
const output = resolve('test-results/query-cache-expanded');
await mkdir(output, { recursive: true });
let application;
try {
  application = await electron.launch({
    args: [
      resolve('out/main/index.js'),
      `--user-data-dir=${join(temporary, 'user')}`,
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      WIKI_CLIENT_ROOT: resolve('..'),
      WIKI_PYTHON: resolve('../.venv/bin/python'),
      WIKI_ANALYSIS_CODEX_CLI: '/usr/bin/false',
      WIKI_QUESTION_CODEX_CLI: '/usr/bin/false',
    },
  });
  await application.evaluate(() => {
    const original = globalThis.fetch;
    const probe = {
      operations: [],
      pending: 0,
      denyNextSearch: false,
      currentDocument: null,
    };
    globalThis.expandedCacheProbe = probe;
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      const path = url.pathname;
      const kind =
        url.hostname !== '127.0.0.1'
          ? null
          : path.endsWith('/documents/search')
            ? 'library-search'
            : path.endsWith('/documents/content')
              ? 'document-content'
              : path.endsWith('/analysis-jobs')
                ? 'analysis-list'
                : path.endsWith('/question-runs')
                  ? 'question-list'
                  : path.endsWith('/knowledge-comparisons')
                    ? 'comparison-list'
                    : null;
      if (!kind) return original(input, init);
      if (kind === 'document-content' && url.searchParams.has('document'))
        probe.currentDocument = url.searchParams.get('document');
      probe.operations.push(kind);
      probe.pending++;
      try {
        await new Promise((done) => setTimeout(done, 600));
        if (kind === 'library-search' && probe.denyNextSearch) {
          probe.denyNextSearch = false;
          return Response.json(
            {
              error: { code: 'forbidden', message: '확대 캐시 권한 회수 검증' },
              meta: { trace_id: 'a'.repeat(32) },
            },
            { status: 403 },
          );
        }
        return await original(input, init);
      } finally {
        probe.pending--;
      }
    };
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page
    .getByRole('textbox', { name: '계정 이름', exact: true })
    .fill('지도 탐색 검증');
  await page
    .getByRole('textbox', { name: '서버 주소', exact: true })
    .fill(upstream.href);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByRole('textbox', { name: '문서 검색', exact: true }).waitFor();
  await page
    .locator('tbody')
    .getByRole('button', { name: /예약 플랫폼/ })
    .first()
    .waitFor();
  const stats = () =>
    application.evaluate(() => ({
      ...globalThis.expandedCacheProbe,
      operations: [...globalThis.expandedCacheProbe.operations],
    }));
  const settle = async () => {
    const deadline = Date.now() + 15_000;
    while ((await stats()).pending && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 25));
    assert.equal((await stats()).pending, 0);
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
  };
  const searches = [];
  for (const text of ['결제 서비스', '개인정보 처리', '결제 서비스']) {
    await page
      .getByRole('textbox', { name: '문서 검색', exact: true })
      .fill(text);
    const before = (await stats()).operations.filter(
      (kind) => kind === 'library-search',
    ).length;
    const start = performance.now();
    await page
      .getByRole('textbox', { name: '문서 검색', exact: true })
      .press('Enter');
    await page
      .locator('tbody')
      .getByText(text, { exact: false })
      .first()
      .waitFor();
    const visible = Math.round(performance.now() - start);
    await settle();
    searches.push({
      visible_ms: visible,
      requests:
        (await stats()).operations.filter((kind) => kind === 'library-search')
          .length - before,
    });
  }
  assert.deepEqual(
    searches.map((row) => row.requests),
    [1, 1, 0],
  );
  await page.screenshot({ path: resolve(output, 'library.png') });
  await page
    .locator('tbody')
    .getByRole('button', { name: /예약 플랫폼/ })
    .first()
    .click();
  await page.getByRole('region', { name: '문서 본문', exact: true }).waitFor();
  await settle();
  const documentPath = (await stats()).currentDocument;
  assert.equal(typeof documentPath, 'string');
  // 별도 작성자의 실제 CAS 저장도 이 실행기의 격리 서버 자료에만 수행합니다.
  const externalSave = async (suffix) => {
    const result = await page.evaluate(
      async ({ document, suffix }) => {
        const connection = await window.wiki.connection.getState();
        if (!connection.ok) return connection;
        const c = connection.data;
        const read = await window.wiki.documents.content({
          connectionId: c.connectionId,
          document,
        });
        if (!read.ok) return read;
        return window.wiki.workspace.execute({
          connectionId: c.connectionId,
          expectedScope: {
            userId: c.userId,
            tenant: c.selection.tenant,
            profileId: c.selection.profile,
            policyRevision: c.policyRevision,
            accessRevision: c.accessRevision,
          },
          operation: 'saveDocument',
          input: {
            document,
            content: read.data.content + '\n' + suffix + '\n',
            expected_revision: read.data.revision,
          },
        });
      },
      { document: documentPath, suffix },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  };
  await externalSave('읽기 화면 배경 갱신 검증');
  await page.evaluate(() =>
    window.dispatchEvent(new Event('wiki-data-changed')),
  );
  await expect(
    page.getByRole('region', { name: '문서 본문', exact: true }),
  ).toContainText('읽기 화면 배경 갱신 검증');
  await settle();
  await page.getByRole('button', { name: '본문 편집', exact: true }).click();
  const editor = page
    .getByRole('region', { name: 'Markdown 편집' })
    .locator('textarea')
    .first();
  const original = await editor.inputValue();
  assert(original.includes('읽기 화면 배경 갱신 검증'));
  await editor.fill(original + '\n미저장 캐시 보호 검사\n');
  await externalSave('편집 중 동시 작성 검증');
  const beforeDirty = (await stats()).operations.filter(
    (kind) => kind === 'document-content',
  ).length;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('wiki-data-changed'));
    window.dispatchEvent(new Event('focus'));
  });
  await settle();
  assert.equal(
    await editor.inputValue(),
    original + '\n미저장 캐시 보호 검사\n',
  );
  assert.equal(
    (await stats()).operations.filter((kind) => kind === 'document-content')
      .length,
    beforeDirty,
  );
  await page.screenshot({ path: resolve(output, 'draft-preserved.png') });
  await editor.fill(original);
  await page.getByRole('link', { name: 'AI 세션', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '새로고침', exact: true }),
  ).toBeEnabled();
  await settle();
  const beforeHistory = (await stats()).operations;
  const startHistory = performance.now();
  await page.getByRole('button', { name: '지난 기록', exact: true }).click();
  await page.getByRole('heading', { name: '지난 기록', exact: true }).waitFor();
  await page
    .getByText('불러온 지난 기록이 없습니다.', { exact: true })
    .waitFor();
  const historyVisible = Math.round(performance.now() - startHistory);
  await settle();
  const historyRequests = (await stats()).operations.slice(
    beforeHistory.length,
  );
  assert.equal(
    historyRequests.filter(
      (kind) => kind === 'question-list' || kind === 'comparison-list',
    ).length,
    0,
  );
  assert(
    historyRequests.filter((kind) => kind === 'analysis-list').length <= 1,
  );
  await page.screenshot({ path: resolve(output, 'history.png') });
  await page.getByRole('link', { name: '문서', exact: true }).click();
  await settle();
  await application.evaluate(() => {
    globalThis.expandedCacheProbe.denyNextSearch = true;
  });
  await page
    .getByRole('textbox', { name: '문서 검색', exact: true })
    .press('Enter');
  await page.waitForFunction(
    () =>
      !document.querySelector('[aria-label="Markdown 편집"]') &&
      !document.querySelector('tbody button'),
  );
  assert.equal((await stats()).denyNextSearch, false);
  assert.equal(
    await page.getByRole('region', { name: '문서 본문', exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole('region', { name: 'Markdown 편집' }).count(),
    0,
  );
  assert.equal(
    await page
      .locator('tbody')
      .getByRole('button', { name: /예약 플랫폼/ })
      .count(),
    0,
  );
  await page.screenshot({ path: resolve(output, 'scope-cleared.png') });
  assert.deepEqual(errors, []);
  const result = {
    actual_electron: true,
    fixture_documents: 10,
    fixture_concepts: 500,
    injected_delay_ms: 600,
    searches,
    pristine_background_update_adopted: true,
    concurrent_external_save: true,
    dirty_draft_preserved: true,
    dirty_draft_background_content_requests: 0,
    history_visible_ms: historyVisible,
    history_requests: historyRequests,
    historical_catalog_reused: true,
    scope_denial_clears_content_and_lists: true,
    browser_errors: errors,
  };
  await writeFile(
    resolve(output, 'measurements.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}

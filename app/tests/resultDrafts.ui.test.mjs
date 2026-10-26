import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';

const app = resolve(import.meta.dirname, '..');
// 실제 feature를 임시 번들로 렌더링하며 서비스와 main의 실제 왕복 검증은 별도 검사에 둡니다.
void test('fixture UI: explicit creation, edit preservation, manual merge, full comparison and receipt-only recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ui3-browser-'));
  let browser;
  try {
    await build({
      configFile: false,
      root: resolve(app, 'tests/fixtures'),
      base: './',
      logLevel: 'silent',
      plugins: [react()],
      resolve: {
        alias: {
          '@renderer': resolve(app, 'src/renderer'),
          '@contracts': resolve(app, 'src/shared/contracts'),
        },
      },
      build: {
        outDir: join(directory, 'ui'),
        emptyOutDir: true,
        rolldownOptions: {
          input: resolve(app, 'tests/fixtures/result-drafts.html'),
        },
      },
    });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
      args: ['--allow-file-access-from-files'],
    });
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const id = 'a'.repeat(32),
        revision = 'c'.repeat(64),
        observed = 'd'.repeat(64);
      const access = {
        userId: 'alice',
        tenant: 'alpha',
        profileId: 'business',
        policyRevision: revision,
      };
      const snapshot = {
        status: 'connected',
        connectionId: 'fixture',
        ...access,
        selection: { tenant: 'alpha', profile: 'business' },
        workspaces: [
          { id: 'alpha', permissions: ['read', 'write', 'result_write'] },
        ],
      };
      const record = {
        id,
        kind: 'result-drafts',
        tenant: 'alpha',
        user_id: 'alice',
        created_at: '2026-10-25',
        data: {
          title: '원래 제목',
          content: '원래 생성문',
          original_generated_title: '원래 제목',
          original_generated_content: '원래 생성문',
          source_result_id: id,
          source_result_revision: revision,
          basis: {
            documents: [
              {
                document: 'Guide.md',
                content: '작성 당시 전체 원문',
                knowledge: { state_revision: revision, claims: [] },
              },
            ],
            originals: [],
            selected_claims: [],
            snapshot_revision: observed,
          },
          answer_provenance: {
            citations: ['당시 답변 인용'],
            execution: { origin: 'client_reported' },
          },
          origin: 'client_reported',
          human_approval: false,
        },
        requests: {},
        events: [],
      };
      const fixture = {
        calls: [],
        mode: 'normal',
        created: false,
        record,
        revision,
        draft: { title: record.data.title, content: record.data.content },
        observed,
        receipt: null,
        snapshot,
      };
      // 브라우저 fixture만 sessionStorage를 사용합니다. 제품은 main의 OS 암호 저장을 사용합니다.
      const priorServer = sessionStorage.getItem('recovery-fixture-server');
      if (priorServer) {
        Object.assign(fixture, JSON.parse(priorServer));
        Object.assign(record, fixture.record);
        fixture.record = record;
        Object.assign(snapshot, fixture.snapshot);
        fixture.snapshot = snapshot;
      }
      window.fixture = fixture;
      function detail() {
        const rendered =
          '# ' +
          fixture.draft.title +
          '\n\n' +
          fixture.draft.content +
          '\n\n## 작성 당시 근거\n' +
          JSON.stringify({
            frozen_basis: record.data.basis,
            original_generated_content: record.data.original_generated_content,
            answer_provenance: record.data.answer_provenance,
          });
        return {
          record,
          revision: fixture.revision,
          draft: fixture.draft,
          rendered_content: rendered,
          rendered_size_bytes: new TextEncoder().encode(rendered).byteLength,
          can_apply_size: true,
          basis_observation: {
            status: 'changed',
            observation_revision: fixture.observed,
            documents: [{ document: 'Guide.md', status: 'changed' }],
            originals: [],
            profile_changed: false,
          },
        };
      }
      window.wiki = {
        recovery: {
          async execute(request) {
            const storageKey =
              'recovery-fixture-' + JSON.stringify(request.expectedScope);
            let entries = JSON.parse(
              sessionStorage.getItem(storageKey) || '[]',
            );
            if (request.operation === 'list')
              return {
                ok: true,
                data: {
                  entries: entries.filter(
                    (entry) => entry.kind === request.kind,
                  ),
                  cleanupWarningCount: 0,
                },
              };
            const old = entries.find(
              (entry) =>
                entry.kind === request.kind && entry.key === request.key,
            );
            if ((old?.revision || null) !== request.expectedRevision)
              return {
                ok: false,
                error: {
                  code: 'recovery_conflict',
                  message: 'fixture conflict',
                },
              };
            entries = entries.filter((entry) => entry !== old);
            let entry;
            if (request.operation === 'put') {
              entry = {
                kind: request.kind,
                key: request.key,
                payload: request.payload,
                revision: crypto.randomUUID().replaceAll('-', '').repeat(2),
                savedAt: new Date().toISOString(),
              };
              entries.push(entry);
            }
            sessionStorage.setItem(storageKey, JSON.stringify(entries));
            return {
              ok: true,
              data: { entries: entry ? [entry] : [], cleanupWarningCount: 0 },
            };
          },
        },
        connection: {
          async getState() {
            return { ok: true, data: snapshot };
          },
        },
        documents: {
          async content(request) {
            return {
              ok: true,
              data: {
                connectionId: 'fixture',
                document: request.document,
                content: '대상 Wiki의 이전 전체 본문',
                revision,
                access,
              },
            };
          },
        },
        resultDrafts: {
          async execute(request) {
            fixture.calls.push(request);
            let data;
            switch (request.operation) {
              case 'list':
                data = {
                  items: fixture.created
                    ? [
                        {
                          id,
                          title: fixture.draft.title,
                          created_at: record.created_at,
                          revision: fixture.revision,
                          kind: 'result-drafts',
                        },
                      ]
                    : [],
                  next_cursor: null,
                  complete: true,
                  truncated: false,
                  skipped: [],
                };
                break;
              case 'create':
                fixture.created = true;
                record.requests[request.input.request_id] = revision;
                data = { record, revision: fixture.revision };
                break;
              case 'read':
                data = detail();
                break;
              case 'edit':
                if (fixture.mode === 'conflict') {
                  fixture.mode = 'normal';
                  fixture.revision = 'e'.repeat(64);
                  fixture.draft = {
                    title: '다른 창의 최신 제목',
                    content: '다른 창의 최신 편집문',
                  };
                  return {
                    ok: false,
                    error: {
                      code: 'conflict',
                      status: 409,
                      message: '초안 기준이 변경되었습니다.',
                    },
                  };
                }
                record.requests[request.input.request_id] = revision;
                record.events.push({
                  operation: 'edit',
                  title: request.input.title,
                  content: request.input.content,
                });
                fixture.revision = 'f'.repeat(64);
                fixture.draft = {
                  title: request.input.title,
                  content: request.input.content,
                };
                data = { record, revision: fixture.revision };
                break;
              case 'apply':
                fixture.receipt = {
                  record_id: id,
                  request_id: request.input.request_id,
                  state: 'complete',
                  saved: true,
                  cleanup_failures: ['fixture cleanup warning'],
                  receipt: {
                    draft_id: id,
                    draft_revision: request.input.expected_revision,
                    document: request.input.document,
                    source_revision: '9'.repeat(64),
                    history_id: 'history.md',
                    changed: true,
                  },
                };
                return {
                  ok: false,
                  error: {
                    code: 'outcome_unknown',
                    message: '반영 후 응답 유실 시험',
                  },
                };
              case 'applicationReceipt':
                data = fixture.receipt;
                break;
              default:
                throw new Error('unexpected operation');
            }
            return {
              ok: true,
              data: {
                operation: request.operation,
                connectionId: 'fixture',
                access,
                traceId: id,
                data: structuredClone(data),
              },
            };
          },
        },
      };
    });
    await page.goto(
      pathToFileURL(join(directory, 'ui/result-drafts.html')).href,
    );
    await expect(
      page.getByRole('button', { name: '이 저장 결과로 초안 만들기' }),
    ).toBeEnabled();
    assert.equal(
      await page.evaluate(
        () =>
          fixture.calls.filter((call) => call.operation === 'create').length,
      ),
      0,
    );
    await page
      .getByRole('button', { name: '이 저장 결과로 초안 만들기' })
      .click();
    const content = page.getByLabel('편집할 Markdown 본문');
    await expect(content).toHaveValue('원래 생성문');
    await content.fill('충돌 전에 작성한 내 편집');
    await expect(
      page.getByText('종료 후 복구용 보호 저장 완료', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      sessionStorage.setItem(
        'recovery-fixture-server',
        JSON.stringify(fixture),
      ),
    );
    await page.reload();
    await expect(content).toHaveValue('충돌 전에 작성한 내 편집');
    assert.equal(
      await page.evaluate(
        () =>
          fixture.calls.filter((call) =>
            ['edit', 'apply'].includes(call.operation),
          ).length,
      ),
      0,
      'reload never saves or applies the recovered text',
    );
    await page.evaluate(() => {
      fixture.mode = 'conflict';
    });
    await page
      .getByRole('button', { name: '개인 초안 저장', exact: true })
      .click();
    await expect(content).toHaveValue('충돌 전에 작성한 내 편집');
    await expect(
      page.getByRole('button', { name: 'Wiki에 명시 반영' }),
    ).toBeDisabled();
    await page.getByRole('button', { name: '최신 초안·근거 읽기' }).click();
    await expect(content).toHaveValue('충돌 전에 작성한 내 편집');
    await page
      .getByRole('button', { name: '최신 초안으로 병합 편집 시작' })
      .click();
    await expect(content).toHaveValue('다른 창의 최신 편집문');
    await expect(
      page.getByText('충돌 전에 작성한 내 편집', { exact: true }),
    ).toBeVisible();
    await content.fill('직접 병합한 최종 편집문');
    await page
      .getByRole('button', { name: '개인 초안 저장', exact: true })
      .click();
    await expect(content).toHaveValue('직접 병합한 최종 편집문');
    await expect(
      page.getByRole('button', { name: '개인 초안 저장', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('대상 Wiki 경로').fill('Result.md');
    await page.getByRole('button', { name: '대상 본문 읽기·비교' }).click();
    await expect(
      page.getByText('대상 Wiki의 이전 전체 본문', { exact: true }),
    ).toBeVisible();
    await page.getByLabel(/대상 본문과 전체 반영 내용을 비교/).check();
    await expect(
      page.getByRole('button', { name: 'Wiki에 명시 반영' }),
    ).toBeDisabled();
    await page.getByLabel(/최신 관측과 작성 당시 근거의 차이/).check();
    await expect(
      page.getByRole('button', { name: 'Wiki에 명시 반영' }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '근거 변화 새로 확인' }).click();
    await expect(
      page.getByLabel(/최신 관측과 작성 당시 근거의 차이/),
    ).not.toBeChecked();
    await page.getByLabel(/최신 관측과 작성 당시 근거의 차이/).check();
    await page.getByLabel(/대상 본문과 전체 반영 내용을 비교/).check();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(content).toHaveValue('직접 병합한 최종 편집문');
    await page.getByRole('button', { name: '전체 근거', exact: true }).click();
    await expect(
      page.getByRole('complementary', { name: '작성 당시 전체 근거' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '편집·비교', exact: true }).click();
    await expect(content).toHaveValue('직접 병합한 최종 편집문');
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.getByRole('button', { name: 'Wiki에 명시 반영' }).click();
    await expect(
      page.getByRole('button', { name: '동일 요청 영수증 확인' }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Wiki에 명시 반영' }),
    ).toBeDisabled();
    await expect(
      page.getByText('종료 후 복구용 보호 저장 완료', { exact: true }),
    ).toBeVisible();
    const lostRequest = await page.evaluate(() => fixture.receipt.request_id);
    await page.evaluate(() =>
      sessionStorage.setItem(
        'recovery-fixture-server',
        JSON.stringify(fixture),
      ),
    );
    await page.reload();
    await expect(
      page.getByRole('button', { name: '동일 요청 영수증 확인' }),
    ).toBeEnabled();
    assert.equal(
      await page.evaluate(
        () => fixture.calls.filter((call) => call.operation === 'apply').length,
      ),
      1,
    );
    await page.getByRole('button', { name: '동일 요청 영수증 확인' }).click();
    assert.equal(
      await page.evaluate(
        () =>
          fixture.calls.findLast(
            (call) => call.operation === 'applicationReceipt',
          ).input.request_id,
      ),
      lostRequest,
    );
    await expect(
      page.getByText(/저장은 완료되었으며 임시 파일 정리 경고가/),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(
        () => fixture.calls.filter((call) => call.operation === 'apply').length,
      ),
      1,
    );
    assert.equal(
      await page.evaluate(
        () =>
          fixture.calls.filter(
            (call) => call.operation === 'applicationReceipt',
          ).length,
      ),
      1,
    );
    assert.deepEqual(errors, []);
    const evidence = process.env.UI3_SCREENSHOT_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: join(evidence, 'result-drafts-1280.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1920, height: 1080 });
      await expect(page.locator('[data-layout-density]')).toHaveAttribute(
        'data-layout-density',
        'wide',
      );
      await page.screenshot({
        path: join(evidence, 'result-drafts-1920.png'),
        fullPage: true,
      });
    }
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

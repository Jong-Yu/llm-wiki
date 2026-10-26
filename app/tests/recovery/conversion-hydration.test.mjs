import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
void test('conversion hydration and refresh share visible request lifetime; no first click is lost', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-conversion-hydration-'));
  let browser;
  try {
    await build({
      configFile: false,
      root: join(root, 'tests/fixtures'),
      base: './',
      logLevel: 'silent',
      plugins: [react()],
      resolve: {
        alias: {
          '@renderer': join(root, 'src/renderer'),
          '@contracts': join(root, 'src/shared/contracts'),
        },
      },
      build: {
        outDir: join(directory, 'ui'),
        emptyOutDir: true,
        rolldownOptions: {
          input: join(root, 'tests/fixtures/source-conversion-hydration.html'),
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
    const url = pathToFileURL(
      join(directory, 'ui/source-conversion-hydration.html'),
    ).href;
    async function open(options = {}) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript((options) => {
        const fixture = {
          reads: [],
          starts: [],
          cancels: [],
          recoveries: [],
          saves: [],
          removals: [],
          options,
        };
        function run(source, label = '복원 원문') {
          const original = {
            sourceId: source.sourceId,
            sourceVersion: source.sourceVersion,
            sourceSha256: source.sourceSha256,
            registrationRevision: source.registrationRevision,
          };
          return {
            requestId: '1'.repeat(32),
            source: original,
            state: 'complete',
            format: 'txt',
            progress: null,
            report: {
              method: 'verbatim',
              units: [
                {
                  unit_id: 'u1',
                  content: label,
                  location: { kind: 'lines', start: 1, end: 1 },
                },
              ],
              complete: true,
              unread_ranges: [],
              warnings: [],
              origin: 'client_reported',
              coverage: 'reported_units_only',
              original_coverage: 'not_verified',
              semantic_validation: 'not_run',
              diagnostics: [],
              unit_methods: {},
            },
            receiptState: 'saved',
            reference: {
              ...original,
              conversionId: '2'.repeat(32),
              conversionRevision: '3'.repeat(64),
              requestId: '1'.repeat(32),
            },
            message: label,
            diagnosticCodes: [],
            cleanupWarning: false,
          };
        }
        function source(request) {
          const [sourceId, sourceVersion] = request.key?.split(':') || [
            'a'.repeat(32),
            'b'.repeat(32),
          ];
          return {
            sourceId,
            sourceVersion,
            sourceSha256: 'c'.repeat(64),
            registrationRevision: 'd'.repeat(64),
          };
        }
        fixture.run = run;
        fixture.source = source;
        fixture.resolveRead = (index, result) =>
          fixture.reads[index].resolve(result);
        fixture.resolveRecovery = (index, label) => {
          const item = fixture.recoveries[index];
          item.resolve({
            ok: true,
            data: {
              entries: label
                ? [
                    {
                      kind: 'source-conversions',
                      key: item.key,
                      payload: JSON.stringify(run(source(item), label)),
                      revision: '4'.repeat(64),
                      savedAt: new Date().toISOString(),
                    },
                  ]
                : [],
              cleanupWarningCount: 0,
            },
          });
        };
        window.conversionFixture = fixture;
        window.wiki = {
          recovery: {
            execute(request) {
              if (request.operation === 'list') {
                const promise = new Promise((resolve) => {
                  fixture.recoveries.push({
                    ...request,
                    key:
                      options.probe && fixture.recoveries.length
                        ? 'f'.repeat(32) + ':' + 'b'.repeat(32)
                        : 'a'.repeat(32) + ':' + 'b'.repeat(32),
                    resolve,
                  });
                });
                if (!options.holdRecovery)
                  fixture.resolveRecovery(
                    fixture.recoveries.length - 1,
                    options.recovered ? '복원한 원문' : null,
                  );
                return promise;
              }
              if (request.operation === 'remove')
                fixture.removals.push(request);
              else fixture.saves.push(request);
              return Promise.resolve({
                ok: true,
                data: {
                  entries:
                    request.operation === 'put'
                      ? [
                          {
                            kind: request.kind,
                            key: request.key,
                            payload: request.payload,
                            revision: '5'.repeat(64),
                            savedAt: new Date().toISOString(),
                          },
                        ]
                      : [],
                  cleanupWarningCount: 0,
                },
              });
            },
          },
          sourceConversion: {
            read(request) {
              return new Promise((resolve) =>
                fixture.reads.push({ request, resolve }),
              );
            },
            start(request) {
              fixture.starts.push(request);
              return Promise.resolve({
                ok: true,
                data: run(request, '새 변환 원문'),
              });
            },
            cancel(request) {
              fixture.cancels.push(request);
              return Promise.resolve({
                ok: true,
                data: {
                  ...run(request),
                  state: 'cancelled',
                  receiptState: 'not_submitted',
                  reference: null,
                },
              });
            },
          },
        };
      }, options);
      await page.goto(url + (options.probe ? '?probe=1' : ''));
      return { page, errors };
    }
    await t.test(
      'initial GET remains locked until completion; first enabled click starts once and hands off exact saved report',
      async () => {
        const { page, errors } = await open();
        try {
          await page.waitForFunction(
            () => conversionFixture.reads.length === 1,
          );
          const start = page.getByRole('button', {
            name: '이 PC에서 변환하고 보고 저장',
            exact: true,
          });
          await expect(start).toBeDisabled();
          await expect(
            page.getByRole('button', { name: '변환 상태 확인', exact: true }),
          ).toBeDisabled();
          assert.equal(
            await page.evaluate(() => conversionFixture.starts.length),
            0,
          );
          await page.evaluate(() =>
            conversionFixture.resolveRead(0, { ok: true, data: null }),
          );
          await expect(start).toBeEnabled();
          await start.click();
          await expect(
            page.getByText('새 변환 원문', { exact: true }).first(),
          ).toBeVisible();
          assert.equal(
            await page.evaluate(() => conversionFixture.starts.length),
            1,
          );
          await page
            .getByRole('button', {
              name: '이 변환 보고로 분석 범위 설정',
              exact: true,
            })
            .click();
          const planned = JSON.parse(
            await page.getByLabel('전달한 분석 계획 기준').innerText(),
          );
          assert.equal(planned.conversionId, '2'.repeat(32));
          assert.equal(planned.conversionRevision, '3'.repeat(64));
          assert.equal(planned.sourceSha256, 'c'.repeat(64));
          assert.equal(planned.sourceVersion, 'b'.repeat(32));
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      'manual refresh disables starts and retains restored report through network error and permission revocation',
      async () => {
        const { page, errors } = await open({ recovered: true });
        try {
          await page.waitForFunction(
            () => conversionFixture.reads.length === 1,
          );
          await page.evaluate(() =>
            conversionFixture.resolveRead(0, { ok: true, data: null }),
          );
          await expect(
            page.getByText(
              '보관된 로컬 보고 · 서버 최신 저장 기록은 아직 확인되지 않았습니다.',
            ),
          ).toBeVisible();
          await expect(
            page.getByRole('button', {
              name: '이 변환 보고로 분석 범위 설정',
              exact: true,
            }),
          ).toBeDisabled();
          await page
            .getByRole('button', { name: '변환 상태 확인', exact: true })
            .click();
          await page.waitForFunction(
            () => conversionFixture.reads.length === 2,
          );
          await expect(
            page.getByRole('button', { name: '변환 상태 확인', exact: true }),
          ).toBeDisabled();
          await page.evaluate(() =>
            conversionFixture.resolveRead(1, {
              ok: false,
              error: {
                code: 'conversion_unavailable',
                message: '오프라인 시험',
              },
            }),
          );
          await expect(
            page.getByText('오프라인 시험', { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByLabel('실제 변환 문자와 원본 위치'),
          ).toContainText('복원한 원문');
          assert.equal(
            await page.evaluate(() => conversionFixture.removals.length),
            0,
          );
          await page
            .getByRole('button', { name: '변환 상태 확인', exact: true })
            .click();
          await page.waitForFunction(
            () => conversionFixture.reads.length === 3,
          );
          await page.evaluate(() =>
            conversionFixture.resolveRead(2, {
              ok: true,
              data: conversionFixture.run(
                conversionFixture.reads[2].request,
                '서버 확인 원문',
              ),
            }),
          );
          await expect(
            page.getByRole('button', {
              name: '이 PC에서 변환하고 보고 저장',
              exact: true,
            }),
          ).toBeEnabled();
          await page
            .getByRole('button', { name: '변환 상태 확인', exact: true })
            .click();
          await page.waitForFunction(
            () => conversionFixture.reads.length === 4,
          );
          await expect(
            page.getByRole('button', {
              name: '이 PC에서 변환하고 보고 저장',
              exact: true,
            }),
          ).toBeDisabled();
          await expect(
            page.getByLabel('실제 변환 문자와 원본 위치'),
          ).toContainText('서버 확인 원문');
          await page.evaluate(() =>
            conversionFixture.resolveRead(3, {
              ok: false,
              error: {
                code: 'forbidden',
                status: 403,
                message: '현재 권한 없음',
              },
            }),
          );
          await expect(page.getByLabel('권한 변경 알림')).toHaveText('1');
          await expect(
            page.getByLabel('실제 변환 문자와 원본 위치'),
          ).toHaveCount(0);
          await expect(
            page.getByRole('button', {
              name: '이 PC에서 변환하고 보고 저장',
              exact: true,
            }),
          ).toBeDisabled();
          assert.equal(
            await page.evaluate(() => conversionFixture.removals.length),
            0,
          );
          assert.equal(
            await page.evaluate(() => conversionFixture.starts.length),
            0,
          );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      'late recovery and read completions cannot replace a new generation or clear its busy state',
      async () => {
        const { page, errors } = await open({
          probe: true,
          holdRecovery: true,
        });
        try {
          await page.waitForFunction(
            () => conversionFixture.recoveries.length === 1,
          );
          await page
            .getByRole('button', { name: '다른 원본 선택', exact: true })
            .click();
          await page.waitForFunction(
            () => conversionFixture.recoveries.length === 2,
          );
          await page.evaluate(() =>
            conversionFixture.resolveRecovery(1, '현재 원본 복구'),
          );
          await page.waitForFunction(
            () => conversionFixture.reads.length === 1,
          );
          await page.evaluate(() =>
            conversionFixture.resolveRecovery(0, '이전 원본 복구'),
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '"busy":true',
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '"recovering":true',
          );
          await page.evaluate(() =>
            conversionFixture.resolveRead(0, { ok: true, data: null }),
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '현재 원본 복구',
          );
          await expect(page.getByLabel('변환 모델')).not.toContainText(
            '이전 원본 복구',
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '"busy":false',
          );
          assert.equal(
            await page.evaluate(() => conversionFixture.reads.length),
            1,
          );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
    await t.test(
      'superseded GET cannot unlock another scope or reveal its old report after a failed read',
      async () => {
        const { page, errors } = await open({ probe: true });
        try {
          await page.waitForFunction(
            () => conversionFixture.reads.length === 1,
          );
          await page.evaluate(() =>
            conversionFixture.resolveRead(0, {
              ok: true,
              data: conversionFixture.run(
                conversionFixture.reads[0].request,
                '이전 범위 서버 원문',
              ),
            }),
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '이전 범위 서버 원문',
          );
          await page
            .getByRole('button', { name: '모델 새로 조회', exact: true })
            .click();
          await page.waitForFunction(
            () => conversionFixture.reads.length === 2,
          );
          await page
            .getByRole('button', { name: '다른 원본 선택', exact: true })
            .click();
          await page.waitForFunction(
            () => conversionFixture.reads.length === 3,
          );
          await expect(page.getByLabel('변환 모델')).not.toContainText(
            '이전 범위 서버 원문',
          );
          await page.evaluate(() =>
            conversionFixture.resolveRead(1, {
              ok: true,
              data: conversionFixture.run(
                conversionFixture.reads[1].request,
                '늦게 온 이전 원문',
              ),
            }),
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '"busy":true',
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '"recovering":true',
          );
          await page.evaluate(() =>
            conversionFixture.resolveRead(2, {
              ok: false,
              error: {
                code: 'conversion_unavailable',
                message: '새 범위 조회 실패',
              },
            }),
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '새 범위 조회 실패',
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '"run":null',
          );
          await expect(page.getByLabel('변환 모델')).toContainText(
            '"busy":false',
          );
          assert.equal(
            await page.evaluate(() => conversionFixture.starts.length),
            0,
          );
          assert.equal(
            await page.evaluate(() => conversionFixture.removals.length),
            0,
          );
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      },
    );
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

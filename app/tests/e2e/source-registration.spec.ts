import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import type { Dialog } from 'electron';
import { z } from 'zod';

const detailsSchema = z.object({ port: z.number().int(), policy: z.string() });
const statsSchema = z.object({
  registrations: z.number(),
  receipt_requests: z.number(),
});

/** 네이티브 선택 창의 사용자 선택만 대체하고 실제 파일 읽기/업로드는 main에서 실행합니다. */
async function selectedFile(
  application: ElectronApplication,
  path: string | null,
): Promise<void> {
  await application.evaluate(
    ({ dialog }: { dialog: Dialog }, selected: string | null): void => {
      dialog.showOpenDialog = async (): Promise<{
        canceled: boolean;
        filePaths: string[];
      }> => ({
        canceled: selected === null,
        filePaths: selected ? [selected] : [],
      });
    },
    path,
  );
}

/** 등록부터 새 목록/미리보기와 응답 유실 복구까지 임시 데이터의 실제 API로 확인합니다. */
test('원본 등록·권한·파일/직접 입력·페이지 밖 자동 선택·영수증 복구', async (): Promise<void> => {
  const profile = await mkdtemp(join(tmpdir(), 'wiki-registration-ui-'));
  const filePath = join(profile, '업로드 원본.md');
  const fileBody = '\ufeff# 업로드 원본\r\n\r\n공백  그대로 🌱\r\n';
  await writeFile(filePath, fileBody);
  const invalidPath = join(profile, 'invalid.txt');
  await writeFile(invalidPath, Buffer.from([255, 254]));
  const largePath = join(profile, 'large.txt');
  await writeFile(largePath, Buffer.alloc(20 * 1024 * 1024 + 1, 120));
  const tokens = {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    none: randomBytes(32).toString('hex'),
    documents: true,
    registration: true,
  };
  const server = spawn(
    resolve('../.venv/bin/python'),
    ['-B', resolve('tests/fixtures/connection_server.py')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  server.stderr.on('data', (chunk: Buffer): void => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: server.stdout });
  let application: ElectronApplication | undefined;
  try {
    const ready = Promise.race([
      once(lines, 'line').then((values: unknown[]): unknown => {
        if (typeof values[0] !== 'string')
          throw new Error('등록 서버 준비 오류');
        return JSON.parse(values[0]);
      }),
      once(server, 'exit').then((): never => {
        throw new Error(`등록 서버 시작 실패: ${stderr}`);
      }),
    ]);
    server.stdin.end(JSON.stringify(tokens) + '\n');
    const details = detailsSchema.parse(await ready);
    const base = `http://127.0.0.1:${details.port}`;
    await expect
      .poll(async (): Promise<number> => {
        try {
          return (await fetch(`${base}/fixture-stats`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    /** POST 수와 영수증 GET 수는 등록 중복 여부를 각각 확인합니다. */
    async function stats(): Promise<z.infer<typeof statsSchema>> {
      return statsSchema.parse(
        await (await fetch(`${base}/fixture-stats`)).json(),
      );
    }
    /** 시험 실패 주입은 운영 서버와 무관한 임시 ASGI 경로에만 적용합니다. */
    async function mode(value: string): Promise<void> {
      expect(
        (
          await fetch(`${base}/fixture-registration-mode/${value}`, {
            method: 'POST',
          })
        ).ok,
      ).toBe(true);
    }
    application = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    });
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on('pageerror', (error: Error): void => {
      errors.push(error.message);
    });
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    await page
      .getByRole('textbox', { name: '서버 주소', exact: true })
      .fill(`${base}/proxy`);
    await page.getByLabel('개인 토큰').fill(tokens.alice);
    await page
      .getByRole('button', { name: '서버 연결 확인', exact: true })
      .click();
    await expect(page.getByText('alice', { exact: true })).toBeVisible();
    await page
      .getByRole('combobox', { name: '작업 공간', exact: true })
      .selectOption('beta');
    await page
      .getByRole('button', { name: '작업 공간 선택', exact: true })
      .click();
    await page
      .getByRole('link', { name: '문서 목록 보기 →', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '원본 등록', exact: true }),
    ).toBeDisabled();
    await page.getByRole('link', { name: '서버 연결', exact: true }).click();
    await page
      .getByRole('combobox', { name: '작업 공간', exact: true })
      .selectOption('alpha');
    await page
      .getByRole('combobox', { name: '관점', exact: true })
      .selectOption('business');
    await page
      .getByRole('button', { name: '작업 공간 선택', exact: true })
      .click();
    await page
      .getByRole('link', { name: '문서 목록 보기 →', exact: true })
      .click();
    const open = page.getByRole('button', { name: '원본 등록', exact: true });
    const modal = page.getByRole('dialog', { name: '원본 등록', exact: true });
    const submit = modal.getByRole('button', {
      name: '등록하고 미리보기',
      exact: true,
    });
    const reader = page.getByRole('region', { name: '문서 영역', exact: true });
    const original = reader.getByRole('article', {
      name: '원본 미리보기',
      exact: true,
    });
    const catalogue = page.getByRole('list', {
      name: '문서 목록',
      exact: true,
    });
    await expect(catalogue.getByRole('button')).toHaveCount(20);
    await open.click();
    await submit.click();
    await expect(
      modal.getByText('제목을 입력해 주세요.', { exact: true }),
    ).toBeVisible();
    await expect(
      modal.getByText('등록할 파일을 선택해 주세요.', { exact: true }),
    ).toBeVisible();
    expect((await stats()).registrations).toBe(0);
    await selectedFile(application, null);
    await modal.getByRole('button', { name: '파일 선택', exact: true }).click();
    await expect(submit).toBeEnabled();
    await selectedFile(application, invalidPath);
    await modal.getByRole('button', { name: '파일 선택', exact: true }).click();
    await expect(
      modal.getByText(
        '파일을 읽을 수 없습니다. 지원되는 일반 문서·이미지 파일인지, 텍스트는 UTF-8인지 확인해 주세요.',
        { exact: true },
      ),
    ).toBeVisible();
    await selectedFile(application, largePath);
    await modal.getByRole('button', { name: '파일 선택', exact: true }).click();
    await expect(
      modal.getByText('원본 파일은 20 MiB 이내여야 합니다.', { exact: true }),
    ).toBeVisible();
    expect((await stats()).registrations).toBe(0);

    await modal.getByRole('tab', { name: '직접 입력', exact: true }).click();
    await modal
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('새 등록 자료');
    await modal
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill('# 등록 완료 미리보기\n\n실제 **등록한 본문**입니다.\n');
    await page.screenshot({
      path: 'test-results-registration/source-registration-dialog.png',
    });
    await mode('pinned');
    await submit.click();
    await expect(modal).not.toBeVisible();
    await expect(
      original.getByRole('heading', {
        name: '등록 완료 미리보기',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      catalogue.getByRole('button', {
        name: /등록 원본 · 새 등록 자료 ·/,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByText('방금 등록한 원본을 현재 페이지에 함께 표시합니다.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(catalogue.getByRole('button')).toHaveCount(21);
    expect((await stats()).registrations).toBe(1);
    await page.screenshot({
      path: 'test-results-registration/source-registration-preview.png',
    });

    // 선택 후 로컬 파일이 바뀌어도 사용자에게 확인된 snapshot을 업로드합니다.
    await mode('normal');
    await open.click();
    await selectedFile(application, filePath);
    await modal.getByRole('button', { name: '파일 선택', exact: true }).click();
    await expect(
      modal.getByRole('textbox', { name: '원본 제목', exact: true }),
    ).toHaveValue('업로드 원본');
    await writeFile(filePath, 'Changed after selection.\n');
    await submit.click();
    await expect(
      original.getByRole('heading', { name: '업로드 원본', exact: true }),
    ).toBeVisible();
    await expect(original).toContainText('공백  그대로 🌱');
    expect(await readFile(filePath, 'utf8')).toBe('Changed after selection.\n');
    expect((await stats()).registrations).toBe(2);

    // 실제 저장 뒤 응답이 손상돼도 재POST하지 않고 영수증으로 완료를 복구합니다.
    await open.click();
    await modal.getByRole('tab', { name: '직접 입력', exact: true }).click();
    await modal
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('응답 유실 자료');
    await modal
      .getByRole('combobox', { name: '원본 형식', exact: true })
      .selectOption('txt');
    await modal
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill('응답 유실 복구 원문');
    await mode('lost');
    await submit.click();
    await expect(
      modal.getByText('등록 결과 확인이 필요합니다', { exact: true }),
    ).toBeVisible();
    await expect(submit).toBeDisabled();
    expect(await page.locator('body').innerText()).not.toContain(tokens.alice);
    await modal
      .getByRole('button', { name: '닫기', exact: true })
      .last()
      .click();
    await open.click();
    await expect(
      modal.getByRole('textbox', { name: '원본 제목', exact: true }),
    ).toHaveValue('응답 유실 자료');
    await modal
      .getByRole('button', { name: '등록 상태 확인', exact: true })
      .click();
    await expect(original.locator('pre')).toHaveText('응답 유실 복구 원문');
    expect((await stats()).registrations).toBe(3);
    expect((await stats()).receipt_requests).toBe(1);

    await open.click();
    await modal.getByRole('tab', { name: '직접 입력', exact: true }).click();
    await modal
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('완료 영수증 대기 자료');
    await modal
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill('# 대기 후 확인된 원본\n');
    await mode('pending');
    await submit.click();
    await expect(
      modal.getByText('등록 결과 확인이 필요합니다', { exact: true }),
    ).toBeVisible();
    await modal
      .getByRole('button', { name: '등록 상태 확인', exact: true })
      .click();
    await expect(
      original.getByRole('heading', {
        name: '대기 후 확인된 원본',
        exact: true,
      }),
    ).toBeVisible();
    expect((await stats()).registrations).toBe(4);

    // 저장 성공과 목록 읽기 실패를 구분하고 새로고침은 등록을 다시 전송하지 않습니다.
    await mode('normal');
    await open.click();
    await modal.getByRole('tab', { name: '직접 입력', exact: true }).click();
    await modal
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('목록 갱신 확인 자료');
    await modal
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill('# 목록 복구 미리보기\n');
    expect(
      (await fetch(`${base}/fixture-mode/broken`, { method: 'POST' })).ok,
    ).toBe(true);
    await submit.click();
    await expect(
      page.getByText('원본 등록 완료 · 목록을 다시 불러와 주세요.', {
        exact: true,
      }),
    ).toBeVisible();
    expect((await stats()).registrations).toBe(5);
    expect(
      (await fetch(`${base}/fixture-mode/normal`, { method: 'POST' })).ok,
    ).toBe(true);
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(
      original.getByRole('heading', {
        name: '목록 복구 미리보기',
        exact: true,
      }),
    ).toBeVisible();
    expect((await stats()).registrations).toBe(5);

    // 파일 수신 뒤 실제 source_write가 회수되면 성공/목록 반영으로 표시하지 않습니다.
    await open.click();
    await modal.getByRole('tab', { name: '직접 입력', exact: true }).click();
    await modal
      .getByRole('textbox', { name: '원본 제목', exact: true })
      .fill('권한 회수 자료');
    await modal
      .getByRole('textbox', { name: '원본 내용', exact: true })
      .fill('공개되면 안 되는 원본');
    await mode('revoke');
    await submit.click();
    await expect(
      page.getByText('작업 공간을 먼저 선택해 주세요', { exact: true }),
    ).toBeVisible();
    await expect(original).toHaveCount(0);
    expect((await stats()).registrations).toBe(6);
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
    lines.close();
    await rm(profile, { recursive: true, force: true });
  }
});

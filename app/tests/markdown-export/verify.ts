import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import type { SaveDialogReturnValue } from 'electron';
import type {
  AnalysisContext,
  ConnectionService,
} from '../../src/main/backend/ConnectionService';
import { apiFailure } from '../../src/main/backend/readApi';
import {
  MarkdownExportService,
  saveMarkdownExport,
} from '../../src/main/backend/MarkdownExportService';
import { registerFileExportHandlers } from '../../src/main/ipc/registerFileExportHandlers';
import {
  markdownExportFilename,
  markdownExportResultSchema,
} from '../../src/shared/contracts/fileExports.contract';
import type {
  DesktopMarkdownExportRequest,
  MarkdownExportResult,
} from '../../src/shared/contracts/fileExports.contract';
import { verifyFileUi } from '../web-test/fileUi';

/** ESM 모듈 평가를 완료한 다음 Electron ready와 실제 IPC를 검증합니다. */
async function run(): Promise<void> {
  const temporary = process.env.WIKI_EXPORT_TEST_ROOT;
  if (!temporary) throw new Error('격리 테스트 경로가 없습니다.');
  app.setPath('userData', join(temporary, 'electron'));
  await app.whenReady();
  const options = {
    show: false,
    webPreferences: {
      preload: join(temporary, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
  const window = new BrowserWindow(options);
  const other = new BrowserWindow(options);
  let selected: BrowserWindow | null = window;
  const renderer = pathToFileURL(join(temporary, 'index.html')).href;
  const output = join(temporary, 'exports');
  await mkdir(output);
  const request: DesktopMarkdownExportRequest = {
    title: '수정 중인/제목',
    content: '\ufeff# 편집본\r\n끝 공백  \r\n',
    connectionId: 'connection-one',
    expectedScope: {
      userId: 'user-one',
      tenant: 'tenant-one',
      profileId: 'default',
      policyRevision: 'a'.repeat(64),
    },
  };
  const context: AnalysisContext = {
    active: {
      status: 'connected',
      connectionId: request.connectionId,
      serverUrl: 'http://127.0.0.1:1',
      userId: request.expectedScope.userId,
      policyRevision: request.expectedScope.policyRevision,
      selection: { tenant: 'tenant-one', profile: 'default' },
      checkedAt: new Date(0).toISOString(),
      workspaces: [
        {
          id: 'tenant-one',
          permissions: ['read'],
          defaultProfile: 'default',
          profiles: [{ id: 'default', domain: null, viewpoint: null }],
        },
      ],
    },
    generation: 1,
    token: 'isolated-test-token',
    selection: { tenant: 'tenant-one', profile: 'default' },
  };
  let current = true;
  let permission = true;
  let reads = 0;
  let choices = 0;
  let destination = join(output, 'current.md');
  let choose: () => Promise<SaveDialogReturnValue> = async () => ({
    canceled: false,
    filePath: destination,
  });
  const connection: Pick<
    ConnectionService,
    'analysisContext' | 'isAnalysisCurrent'
  > = {
    analysisContext: async (connectionId: string) => {
      reads++;
      assert.equal(connectionId, request.connectionId);
      return permission
        ? context
        : apiFailure('forbidden', '접근 권한이 없습니다.');
    },
    isAnalysisCurrent: (): boolean => current,
  };
  const service = new MarkdownExportService(connection, {
    choose: async (
      parent: BrowserWindow,
      filename: string,
    ): Promise<SaveDialogReturnValue> => {
      choices++;
      assert.equal(parent, window);
      assert.equal(filename, '수정 중인_제목.md');
      return choose();
    },
    save: saveMarkdownExport,
  });
  const unregister = registerFileExportHandlers(
    (): BrowserWindow | null => selected,
    renderer,
    service,
  );

  /** 결과는 실제 preload와 IPC를 거쳐 엄격한 공개 계약으로 검증합니다. */
  async function invoke(
    args: unknown[] = [request],
    from: BrowserWindow = window,
    bridge: boolean = false,
  ): Promise<MarkdownExportResult> {
    const result: unknown = await from.webContents.executeJavaScript(
      `${bridge ? 'window.wiki.fileExports.exportMarkdown' : 'window.exportProbe'}(...${JSON.stringify(args)})`,
    );
    return markdownExportResultSchema.parse(result);
  }
  function failed(result: MarkdownExportResult, code: string): void {
    assert(!result.ok);
    assert.equal(result.error.code, code);
    assert(!result.error.message.includes(output));
  }
  async function absent(path: string): Promise<void> {
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert(
      !(await readdir(output)).some((name: string): boolean =>
        name.startsWith('.wiki-export-'),
      ),
    );
  }

  try {
    await Promise.all([window.loadURL(renderer), other.loadURL(renderer)]);
    let checks = 0;
    assert.deepEqual(await invoke([request], window, true), {
      ok: true,
      data: { started: true },
    });
    assert.deepEqual(
      await readFile(destination),
      Buffer.from(request.content, 'utf8'),
    );
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal(reads, 2);
    checks++;

    const before = choices;
    failed(await invoke([], window), 'invalid_request');
    failed(await invoke([request, 'extra']), 'invalid_request');
    failed(
      await invoke([{ ...request, path: join(output, 'arbitrary.md') }]),
      'invalid_request',
    );
    failed(
      await invoke([{ ...request, content: '가'.repeat(350000) }]),
      'invalid_request',
    );
    failed(
      await invoke([{ ...request, expectedScope: undefined }]),
      'invalid_request',
    );
    failed(await invoke([request], other), 'forbidden');
    assert.equal(choices, before);
    checks++;

    failed(
      await invoke([
        {
          ...request,
          expectedScope: { ...request.expectedScope, tenant: 'wrong' },
        },
      ]),
      'scope_changed',
    );
    assert.equal(choices, before);
    checks++;

    destination = join(output, 'canceled.md');
    choose = async (): Promise<SaveDialogReturnValue> => ({
      canceled: true,
      filePath: destination,
    });
    assert.deepEqual(await invoke(), { ok: true, data: { started: false } });
    await absent(destination);
    checks++;

    let finish: (value: SaveDialogReturnValue) => void = (): void => {
      throw new Error('저장 창이 아직 열리지 않았습니다.');
    };
    let opened: () => void = (): void => {};
    const opening = new Promise<void>((resolve): void => {
      opened = resolve;
    });
    choose = (): Promise<SaveDialogReturnValue> =>
      new Promise((resolve): void => {
        finish = resolve;
        opened();
      });
    const pending = invoke();
    await opening;
    failed(await invoke(), 'export_in_progress');
    finish({ canceled: true, filePath: '' });
    assert.deepEqual(await pending, { ok: true, data: { started: false } });
    checks++;

    destination = join(output, 'changed.md');
    choose = async (): Promise<SaveDialogReturnValue> => {
      current = false;
      return { canceled: false, filePath: destination };
    };
    failed(await invoke(), 'scope_changed');
    await absent(destination);
    current = true;
    checks++;

    choose = async (): Promise<SaveDialogReturnValue> => {
      selected = other;
      return { canceled: false, filePath: destination };
    };
    failed(await invoke(), 'scope_changed');
    await absent(destination);
    selected = window;
    checks++;

    choose = async (): Promise<SaveDialogReturnValue> => {
      permission = false;
      return { canceled: false, filePath: destination };
    };
    failed(await invoke(), 'forbidden');
    await absent(destination);
    permission = true;
    checks++;

    choose = async (): Promise<SaveDialogReturnValue> => ({
      canceled: false,
      filePath: destination,
    });
    destination = join(output, 'current.md');
    failed(await invoke(), 'file_save_failed');
    assert.deepEqual(
      await readFile(destination),
      Buffer.from(request.content, 'utf8'),
    );
    destination = join(output, 'link.md');
    const target = join(output, 'preserve.md');
    await writeFile(target, '기존 사용자 파일');
    await symlink(target, destination);
    failed(await invoke(), 'file_save_failed');
    assert.equal(await readFile(target, 'utf8'), '기존 사용자 파일');
    destination = join(output, 'directory.md');
    await mkdir(destination);
    failed(await invoke(), 'file_save_failed');
    assert((await stat(destination)).isDirectory());
    destination = join(output, 'missing', 'failed.md');
    failed(await invoke(), 'file_save_failed');
    await absent(destination);
    checks++;

    destination = join(output, 'before-publish.md');
    await assert.rejects(
      saveMarkdownExport(destination, request.content, (): boolean => false),
    );
    await absent(destination);
    const competing = await Promise.allSettled([
      saveMarkdownExport(destination, 'first', (): boolean => true),
      saveMarkdownExport(destination, 'second', (): boolean => true),
    ]);
    assert.equal(
      competing.filter((result): boolean => result.status === 'fulfilled')
        .length,
      1,
    );
    assert(['first', 'second'].includes(await readFile(destination, 'utf8')));
    assert(
      !(await readdir(output)).some((name: string): boolean =>
        name.startsWith('.wiki-export-'),
      ),
    );
    checks++;

    // 형식별 파일명·본문: txt는 본문 그대로, md는 기존 동작을 유지합니다.
    assert.equal(markdownExportFilename('보고서', 'txt'), '보고서.txt');
    assert.equal(markdownExportFilename('보고서', 'docx'), '보고서.docx');
    assert.equal(markdownExportFilename('보고서', 'pdf'), '보고서.pdf');
    let askedFormat = '';
    let askedName = '';
    const formatService = new MarkdownExportService(connection, {
      choose: async (
        _parent: BrowserWindow,
        filename: string,
        format?: string,
      ): Promise<SaveDialogReturnValue> => {
        askedName = filename;
        askedFormat = format ?? '';
        return { canceled: false, filePath: destination };
      },
      save: saveMarkdownExport,
    });
    const formatted = await formatService.exportMarkdown(
      { ...request, title: '형식', format: 'txt' },
      window,
      (): boolean => true,
    );
    destination = join(output, 'plain.txt');
    assert(formatted.ok || formatted.error.code === 'file_save_failed');
    destination = join(output, 'plain2.txt');
    const plain = await formatService.exportMarkdown(
      { ...request, title: '형식', format: 'txt' },
      window,
      (): boolean => true,
    );
    assert.deepEqual(plain, { ok: true, data: { started: true } });
    assert.equal(askedFormat, 'txt');
    assert.equal(askedName, '형식.txt');
    assert.deepEqual(
      await readFile(destination),
      Buffer.from(request.content, 'utf8'),
    );
    checks++;

    // DOCX·PDF: 내장 변환기가 올바른 파일 시그니처로 저장하고, 원본 HTML은 실행 글자로 남지 않습니다.
    const converting = new MarkdownExportService(connection, {
      choose: async (): Promise<SaveDialogReturnValue> => ({
        canceled: false,
        filePath: destination,
      }),
      save: saveMarkdownExport,
    });
    {
      const body =
        '# 제목\n\n본문 **굵게** 한글\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n';
      destination = join(output, 'real.docx');
      assert.deepEqual(
        await converting.exportMarkdown(
          { ...request, content: body, format: 'docx' },
          window,
          (): boolean => true,
        ),
        { ok: true, data: { started: true } },
      );
      assert.equal(
        (await readFile(destination)).subarray(0, 2).toString(),
        'PK',
      );
      destination = join(output, 'real.pdf');
      assert.deepEqual(
        await converting.exportMarkdown(
          { ...request, content: body, format: 'pdf' },
          window,
          (): boolean => true,
        ),
        { ok: true, data: { started: true } },
      );
      assert.equal(
        (await readFile(destination)).subarray(0, 5).toString(),
        '%PDF-',
      );
      for (const format of ['xlsx', 'pptx'] as const) {
        destination = join(output, `real.${format}`);
        assert.deepEqual(
          await converting.exportMarkdown(
            { ...request, content: body, format },
            window,
            (): boolean => true,
          ),
          { ok: true, data: { started: true } },
        );
        assert.equal(
          (await readFile(destination)).subarray(0, 2).toString(),
          'PK',
        );
      }
      console.log('built-in DOCX/PDF/XLSX/PPTX checked');
    }
    checks++;

    assert.equal(markdownExportFilename('CON.txt'), '_CON.txt.md');
    assert.equal(markdownExportFilename('LPT9'), '_LPT9.md');
    assert.equal(markdownExportFilename('..'), 'result.md');
    checks++;
    checks += await verifyFileUi();
    console.log(
      `PASS: ${checks} Markdown export service/IPC and file UI checks`,
    );
  } catch (error: unknown) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    unregister();
    window.destroy();
    other.destroy();
    app.exit(process.exitCode ? 1 : 0);
  }
}

void run().catch((error: unknown): void => {
  console.error(error);
  app.exit(1);
});

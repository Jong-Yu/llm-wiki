import assert from 'node:assert/strict';
import { mkdir, readdir, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { AttachmentReader } from '@main/backend/AttachmentReader';
import type { QuestionRuntime } from '@main/backend/QuestionRunService';
import { registerAttachmentHandlers } from '@main/ipc/registerAttachmentHandlers';
import { attachmentPickResultSchema } from '@contracts/attachments.contract';
import type { AttachmentPickResult } from '@contracts/attachments.contract';
import { createWikiBridge } from '../../src/shared/createWikiBridge';

/** 앱의 선택/드롭 직렬화와 한도, 격리 preload의 실제 drop 출처 검사를 확인합니다. */
async function verify(): Promise<void> {
  const temporary = import.meta.dirname;
  const project = resolve('..');
  const privateRoot = join(temporary, 'private');
  app.setPath('userData', join(temporary, 'user'));
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(temporary, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const url = pathToFileURL(join(temporary, 'index.html')).href;
  const runtime: QuestionRuntime = {
    privateRoot,
    projectRoot: project,
    sessionRoot: join(temporary, 'sessions'),
    python: join(
      project,
      process.platform === 'win32'
        ? '.venv/Scripts/python.exe'
        : '.venv/bin/python',
    ),
    ai: { provider: 'codex', model: 'default', cli: 'unused' },
  };
  let resumeRead: () => void = (): void => {};
  const firstRead = new Promise<void>((done: () => void): void => {
    resumeRead = done;
  });
  const reader = new AttachmentReader(
    async (): Promise<QuestionRuntime> => {
      await firstRead;
      return runtime;
    },
    async (): Promise<null> => null,
  );
  let active: BrowserWindow | null = window;
  const unregister = registerAttachmentHandlers(
    (): BrowserWindow | null => active,
    url,
    reader,
  );
  await window.loadURL(url);
  const web = window.webContents;
  const inspect = (script: string): Promise<unknown> =>
    web.executeJavaScript(script);
  const invoke = async (script: string): Promise<AttachmentPickResult> =>
    attachmentPickResultSchema.parse(await inspect(script));
  const api = 'window.wiki.attachments';
  // 기존 브리지 생성/선택에는 네이티브 드롭 구현이 필요하지 않습니다.
  assert.equal(
    createWikiBridge(async (): Promise<null> => null).attachments?.drop,
    undefined,
  );
  assert.equal(
    await inspect('window.attachments.supportsAttachmentDrop()'),
    true,
  );
  assert.deepEqual(
    await invoke('window.attachments.pickAttachment({limit:1})'),
    {
      ok: true,
      data: null,
    },
  );

  const first = join(temporary, '첫째.txt');
  const second = join(temporary, '둘째.md');
  await writeFile(first, '가😀나');
  await writeFile(second, '본문 두 번째');
  const picking = reader.pick(window, { limit: 2 });
  assert.equal((await reader.drop(first, { limit: 2 })).ok, false);
  assert.deepEqual(await picking, { ok: true, data: null });
  const directory = join(temporary, 'folder.txt');
  await mkdir(directory);
  const huge = join(temporary, 'huge.txt');
  await writeFile(huge, '');
  await truncate(huge, 20 * 1024 * 1024 + 1);
  for (const [path, code] of [
    [huge, 'file_too_large'],
    [directory, 'file_unreadable'],
    [join(temporary, 'bad.exe'), 'unsupported_format'],
  ]) {
    const result = await reader.drop(path, { limit: 1 });
    assert.equal(!result.ok && result.error.code, code);
  }

  // Renderer가 만든 경로 문자열, 경로 흉내 객체, JS File은 읽기 권한을 얻지 못합니다.
  for (const value of [
    JSON.stringify(first),
    `({path:${JSON.stringify(first)}})`,
    'new File(["가짜"], "첫째.txt")',
  ]) {
    const result = await invoke(`${api}.drop(${value}, {limit:2})`);
    assert.equal(!result.ok && result.error.code, 'invalid_request');
  }
  await inspect(`window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      window.dropped = Array.from(e.dataTransfer.files);
      window.trustedDrop = e.isTrusted;
    });`);
  web.debugger.attach();
  /** Chromium이 실제 파일 목록을 담아 신뢰된 OS 드롭과 같은 DOM 이벤트를 발행합니다. */
  async function dispatchDrop(files: string[]): Promise<void> {
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await web.debugger.sendCommand('Input.dispatchDragEvent', {
        type,
        x: 15,
        y: 15,
        data: { items: [], files, dragOperationsMask: 1 },
      });
  }
  await dispatchDrop([first, second, huge]);
  assert.equal(await inspect('window.trustedDrop'), true);
  assert.deepEqual(await inspect('dropped.map(f => f.name)'), [
    '첫째.txt',
    '둘째.md',
    'huge.txt',
  ]);
  for (const request of [
    '{limit:0}',
    '{limit:12001}',
    `{limit:4,path:${JSON.stringify(second)}}`,
  ]) {
    const invalid = await invoke(`${api}.drop(dropped[0], ${request})`);
    assert.equal(!invalid.ok && invalid.error.code, 'invalid_request');
  }
  await inspect(
    'window.original = dropped; window.pending = attachments.dropAttachment(original[0], {limit:2}); void 0',
  );
  // 읽는 동안 들어와 무시된 새 drop이 기존 배치의 두 번째 파일 권한을 지우면 안 됩니다.
  await dispatchDrop([first]);
  resumeRead();
  const one = await invoke('pending');
  assert.deepEqual(one, {
    ok: true,
    data: {
      name: '첫째.txt',
      text: '가',
      totalChars: 3,
      truncated: true,
      notes: [],
    },
  });
  const two = await invoke(
    'attachments.dropAttachment(original[1], {limit:1})',
  );
  assert.deepEqual(two, {
    ok: true,
    data: {
      name: '둘째.md',
      text: '본',
      totalChars: 7,
      truncated: true,
      notes: [],
    },
  });
  active = null;
  const forbidden = await invoke(`${api}.drop(original[2], {limit:1})`);
  assert.equal(!forbidden.ok && forbidden.error.code, 'forbidden');
  active = window;
  // 실제 디스크 File을 들고 있어도 합성 drop으로 소비한 권한을 되살릴 수 없습니다.
  await inspect(`const nativeFile = original[0]; const transfer = new DataTransfer();
    transfer.items.add(nativeFile); window.dispatchEvent(new DragEvent('drop', {dataTransfer:transfer}));`);
  const replay = await invoke(`${api}.drop(nativeFile, {limit:4})`);
  assert.equal(!replay.ok && replay.error.code, 'invalid_request');
  assert.deepEqual(await readdir(privateRoot), []);
  web.debugger.detach();
  unregister();
  window.destroy();
  console.log(
    'PASS: native multi-file drop, per-file limits, provenance, replay, size/type, pick cancellation, shared lock, cleanup',
  );
}

void verify().then(
  () => app.exit(0),
  (error: unknown) => {
    console.error(error);
    app.exit(1);
  },
);

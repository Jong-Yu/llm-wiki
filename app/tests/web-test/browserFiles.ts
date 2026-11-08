import assert from 'node:assert/strict';
import {
  chooseBrowserSource,
  downloadBrowserSource,
  invalidateBrowserFiles,
} from '../../src/web-test/browserFiles';
import type { SourceDownloadRequest } from '../../src/shared/contracts/sources.contract';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type GlobalOverride = { target: object; key: string; value: unknown };

/** 외부 응답의 완료 시점을 시험이 결정해 실제 await 경계를 재현합니다. */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (): void => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<T>((accept: (value: T) => void): void => {
    resolve = accept;
  });
  return { promise, resolve };
}

/** 전역 대역은 각 사례가 끝나면 기존 descriptor까지 정확히 복원합니다. */
async function withGlobals(
  overrides: GlobalOverride[],
  run: () => Promise<void>,
): Promise<void> {
  const originals = overrides.map(
    (item: GlobalOverride): PropertyDescriptor | undefined =>
      Object.getOwnPropertyDescriptor(item.target, item.key),
  );
  try {
    for (const item of overrides)
      Object.defineProperty(item.target, item.key, {
        value: item.value,
        configurable: true,
        writable: true,
      });
    await run();
  } finally {
    invalidateBrowserFiles();
    for (let index = overrides.length - 1; index >= 0; index--) {
      const item = overrides[index];
      assert(item);
      const original = originals[index];
      if (original) Object.defineProperty(item.target, item.key, original);
      else Reflect.deleteProperty(item.target, item.key);
    }
  }
}

/** 파일 선택과 링크 시작 여부만 관찰하는 DOM 대역이며 실제 UI를 조작하지 않습니다. */
function documentDouble(file?: File): {
  value: object;
  counts: { inputs: number; anchors: number; downloads: number };
} {
  const counts = { inputs: 0, anchors: 0, downloads: 0 };
  const listeners = new Map<string, () => void>();
  const input = {
    type: '',
    accept: '',
    hidden: false,
    files: file ? [file] : [],
    setAttribute: (): void => {},
    addEventListener: (event: string, callback: () => void): void => {
      listeners.set(event, callback);
    },
    click: (): void => {
      queueMicrotask((): void => listeners.get('change')?.());
    },
    remove: (): void => {},
  };
  const anchor = {
    href: '',
    download: '',
    hidden: false,
    click: (): void => {
      counts.downloads++;
    },
    remove: (): void => {},
  };
  const value = {
    createElement: (tag: string): typeof input | typeof anchor => {
      if (tag === 'input') {
        counts.inputs++;
        return input;
      }
      assert.equal(tag, 'a');
      counts.anchors++;
      return anchor;
    },
    body: { append: (): void => {} },
  };
  return { value, counts };
}

/** 첫 바이트를 소비한 뒤 남은 응답은 명시 해제까지 대기합니다. */
function delayedBody(bytes: Uint8Array): {
  body: ReadableStream<Uint8Array>;
  reading: Promise<void>;
  release: () => void;
} {
  const reading = deferred<void>();
  const released = deferred<void>();
  const body = new ReadableStream<Uint8Array>({
    start: (controller: ReadableStreamDefaultController<Uint8Array>): void => {
      controller.enqueue(bytes.slice(0, 1));
    },
    pull: async (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ): Promise<void> => {
      reading.resolve();
      await released.promise;
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
  return {
    body,
    reading: reading.promise,
    release: (): void => released.resolve(),
  };
}

/** 늦은 응답·해시 계산·손상 데이터가 브라우저 다운로드로 이어지지 않는지 확인합니다. */
export async function verifyBrowserFiles(): Promise<number> {
  const bytes = new TextEncoder().encode('웹 파일 수명 검증');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (byte: number): string =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const request: SourceDownloadRequest = {
    connectionId: 'test-connection',
    sourceId: 'a'.repeat(32),
    sourceVersion: 'b'.repeat(32),
    sourceSha256: hash,
    format: 'txt',
    sizeBytes: bytes.byteLength,
  };
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Source-Sha256': hash,
  };
  const windowDouble = {
    setTimeout: (callback: () => void): number => {
      callback();
      return 0;
    },
  };
  const noBlobUrl = (): string => 'blob:unit-test';
  const noRevoke = (): void => {};
  let checks = 0;

  // 로그아웃 중 도착한 파일 선택 성공 응답은 기존 계정의 선택으로 승격하지 않습니다.
  const selectedFile = new File([bytes], 'scope-test.txt');
  const selectionDocument = documentDouble(selectedFile);
  const selectionBody = delayedBody(
    new TextEncoder().encode(
      JSON.stringify({
        ok: true,
        data: {
          fileId: 'c'.repeat(32),
          filename: selectedFile.name,
          format: 'txt',
          sizeBytes: bytes.byteLength,
        },
      }),
    ),
  );
  await withGlobals(
    [
      { target: globalThis, key: 'document', value: selectionDocument.value },
      {
        target: globalThis,
        key: 'fetch',
        value: async (): Promise<Response> =>
          new Response(selectionBody.body, {
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ],
    async (): Promise<void> => {
      const pending = chooseBrowserSource({
        connectionId: request.connectionId,
      });
      await selectionBody.reading;
      invalidateBrowserFiles();
      selectionBody.release();
      const result = await pending;
      assert(!result.ok);
      assert.equal(selectionDocument.counts.inputs, 1);
      assert.equal(selectionDocument.counts.anchors, 0);
      assert.equal(selectionDocument.counts.downloads, 0);
    },
  );
  checks++;

  // 응답 스트림이 abort 신호를 무시해도 연결 세대 검사가 다운로드를 차단해야 합니다.
  const streamDocument = documentDouble();
  const stream = delayedBody(bytes);
  await withGlobals(
    [
      { target: globalThis, key: 'document', value: streamDocument.value },
      { target: globalThis, key: 'window', value: windowDouble },
      { target: URL, key: 'createObjectURL', value: noBlobUrl },
      { target: URL, key: 'revokeObjectURL', value: noRevoke },
      {
        target: globalThis,
        key: 'fetch',
        value: async (): Promise<Response> =>
          new Response(stream.body, { headers }),
      },
    ],
    async (): Promise<void> => {
      const pending = downloadBrowserSource(request);
      await stream.reading;
      invalidateBrowserFiles();
      stream.release();
      const result = await pending;
      assert(!result.ok);
      assert.equal(streamDocument.counts.anchors, 0);
      assert.equal(streamDocument.counts.downloads, 0);
    },
  );
  checks++;

  // 전체 응답을 받은 뒤 취소할 수 없는 해시 계산 중 로그아웃되는 경우를 분리합니다.
  const hashDocument = documentDouble();
  const hashing = deferred<void>();
  const hashed = deferred<ArrayBuffer>();
  await withGlobals(
    [
      { target: globalThis, key: 'document', value: hashDocument.value },
      { target: globalThis, key: 'window', value: windowDouble },
      { target: URL, key: 'createObjectURL', value: noBlobUrl },
      { target: URL, key: 'revokeObjectURL', value: noRevoke },
      {
        target: globalThis,
        key: 'fetch',
        value: async (): Promise<Response> => new Response(bytes, { headers }),
      },
      {
        target: globalThis,
        key: 'crypto',
        value: {
          subtle: {
            digest: (): Promise<ArrayBuffer> => {
              hashing.resolve();
              return hashed.promise;
            },
          },
        },
      },
    ],
    async (): Promise<void> => {
      const pending = downloadBrowserSource(request);
      await hashing.promise;
      invalidateBrowserFiles();
      hashed.resolve(digest);
      const result = await pending;
      assert(!result.ok);
      assert.equal(hashDocument.counts.anchors, 0);
      assert.equal(hashDocument.counts.downloads, 0);
    },
  );
  checks++;

  // 길이 또는 실제 본문 해시가 잘못되면 DOM 링크 생성 이전에 실패해야 합니다.
  const wrongHash = new Uint8Array(bytes);
  wrongHash[0] = 65;
  for (const malformed of [wrongHash, bytes.slice(0, bytes.byteLength - 1)]) {
    const invalidDocument = documentDouble();
    await withGlobals(
      [
        { target: globalThis, key: 'document', value: invalidDocument.value },
        { target: globalThis, key: 'window', value: windowDouble },
        { target: URL, key: 'createObjectURL', value: noBlobUrl },
        { target: URL, key: 'revokeObjectURL', value: noRevoke },
        {
          target: globalThis,
          key: 'fetch',
          value: async (): Promise<Response> =>
            new Response(malformed, { headers }),
        },
      ],
      async (): Promise<void> => {
        const result = await downloadBrowserSource(request);
        assert(!result.ok);
        assert.equal(invalidDocument.counts.anchors, 0);
        assert.equal(invalidDocument.counts.downloads, 0);
      },
    );
  }
  checks++;
  return checks;
}

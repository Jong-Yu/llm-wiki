import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { SourcePreviewRequest } from '../../src/shared/contracts/documents.contract';
import { MAX_SOURCE_BYTES } from '../../src/shared/contracts/documents.contract';
import { readApiSourceBytes } from '../../src/main/backend/readApi';
import { sourceContentType } from '../../src/main/backend/sourceOriginal';

type ByteCase = {
  name: string;
  wire: Buffer;
  headers: Record<string, string>;
  expected: SourcePreviewRequest;
  error?: string;
};

/** 전송 프레이밍과 무관하게 원본 바이트 지문을 만드는 시험 보조 함수입니다. */
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 실제 HTTP·gzip 응답으로 압축 길이와 원본 길이 및 무결성 실패를 구분합니다. */
export async function verifySourceBytes(): Promise<number> {
  const original = Buffer.from('\ufeff# 원본\r\n웹 다운로드 시험\r\n', 'utf8');
  const expected: SourcePreviewRequest = {
    connectionId: 'test-connection',
    sourceId: 'a'.repeat(32),
    sourceVersion: 'b'.repeat(32),
    sourceSha256: digest(original),
    sizeBytes: original.byteLength,
    format: 'md',
  };
  const headers = {
    'Content-Type': sourceContentType(expected.format),
    'X-Source-Sha256': expected.sourceSha256,
  };
  const compressed = gzipSync(original);
  const changed = Buffer.from(original);
  changed[changed.length - 1] = 65;
  const fakePdf = Buffer.from('not-pdf');
  const cases: ByteCase[] = [
    {
      name: 'identity-length',
      wire: original,
      headers: { ...headers, 'Content-Length': String(original.byteLength) },
      expected,
    },
    { name: 'chunked', wire: original, headers, expected },
    {
      name: 'gzip-chunked',
      wire: compressed,
      headers: { ...headers, 'Content-Encoding': 'gzip' },
      expected,
    },
    {
      name: 'gzip-wire-length',
      wire: compressed,
      headers: {
        ...headers,
        'Content-Encoding': 'gzip',
        'Content-Length': String(compressed.byteLength),
      },
      expected,
    },
    {
      name: 'identity-wrong-length',
      wire: original,
      headers: {
        ...headers,
        'Content-Length': String(original.byteLength + 1),
      },
      expected,
      error: 'source_mismatch',
    },
    {
      name: 'actual-too-large',
      wire: Buffer.concat([original, Buffer.from('extra')]),
      headers,
      expected,
      error: 'response_too_large',
    },
    {
      name: 'gzip-expansion-too-large',
      wire: gzipSync(Buffer.alloc(100_000, 65)),
      headers: { ...headers, 'Content-Encoding': 'gzip' },
      expected,
      error: 'response_too_large',
    },
    {
      name: 'actual-too-short',
      wire: original.subarray(0, original.byteLength - 1),
      headers,
      expected,
      error: 'source_mismatch',
    },
    {
      name: 'hash-header-mismatch',
      wire: original,
      headers: { ...headers, 'X-Source-Sha256': 'c'.repeat(64) },
      expected,
      error: 'source_mismatch',
    },
    {
      name: 'hash-body-mismatch',
      wire: changed,
      headers,
      expected,
      error: 'source_mismatch',
    },
    {
      name: 'mime-mismatch',
      wire: original,
      headers: { ...headers, 'Content-Type': 'text/html' },
      expected,
      error: 'source_mismatch',
    },
    {
      name: 'signature-mismatch',
      wire: fakePdf,
      headers: {
        'Content-Type': 'application/pdf',
        'X-Source-Sha256': digest(fakePdf),
      },
      expected: {
        ...expected,
        format: 'pdf',
        sourceSha256: digest(fakePdf),
        sizeBytes: fakePdf.byteLength,
      },
      error: 'source_mismatch',
    },
    {
      name: 'declared-source-over-limit',
      wire: original,
      headers,
      expected: { ...expected, sizeBytes: MAX_SOURCE_BYTES + 1 },
      error: 'source_mismatch',
    },
  ];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse): void => {
      const item = cases.find(
        (candidate: ByteCase): boolean => request.url === `/${candidate.name}`,
      );
      if (!item) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, item.headers);
      // 길이 없는 사례는 write로 chunked 전송을 강제합니다.
      response.write(item.wire);
      response.end();
    },
  );
  await new Promise<void>(
    (accept: () => void, reject: (error: Error) => void): void => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', accept);
    },
  );
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    for (const item of cases) {
      const result = await readApiSourceBytes(
        `http://127.0.0.1:${address.port}/${item.name}`,
        null,
        new AbortController(),
        item.expected,
      );
      if (item.error) {
        assert(!result.ok, item.name);
        assert.equal(result.error.code, item.error, item.name);
      } else {
        assert(result.ok, item.name);
        assert(result.value instanceof Uint8Array, item.name);
        assert.deepEqual(Buffer.from(result.value), original, item.name);
      }
    }
    return cases.length;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(
      (accept: () => void, reject: (error: Error) => void): void => {
        server.close((error?: Error): void =>
          error ? reject(error) : accept(),
        );
      },
    );
  }
}

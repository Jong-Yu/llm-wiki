import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { MAX_SOURCE_BYTES } from '@contracts/documents.contract';
import { sourceSessionSchema } from '@contracts/sources.contract';
import type { WebServices } from './services';
type WebServerOptions = {
  assetsRoot: string;
  services: WebServices;
  port: number;
};
const requestSchema = z.strictObject({
  channel: z.string().min(1).max(100),
  args: z.array(z.unknown()).max(1),
});
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const fileMetadataSchema = z.strictObject({
  request: sourceSessionSchema,
  filename: z.string().min(1).max(255),
});
const POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'self'",
].join('; ');
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** 실행 때 만든 세션 쿠키만 비교하며 토큰을 응답이나 로그에 넣지 않습니다. */
function validCookie(
  request: IncomingMessage,
  secret: string,
  cookieName: string,
): boolean {
  const candidates = (request.headers.cookie ?? '')
    .split(';')
    .map((value: string): string => value.trim());
  const expected = Buffer.from(`${cookieName}=${secret}`);
  return candidates.some((value: string): boolean => {
    const actual = Buffer.from(value);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
}

/** 내부 오류나 요청 본문을 반사하지 않는 고정 응답만 보냅니다. */
function fail(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(
    JSON.stringify({
      ok: false,
      error: {
        code,
        message:
          '웹 테스트 요청을 처리하지 못했습니다. 연결 상태를 확인해 주세요.',
      },
    }),
  );
}

/** 선언 길이를 신뢰하지 않고 실제 읽은 요청 바이트 수를 제한합니다. */
async function readBytes(
  request: IncomingMessage,
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(value)) throw new Error('invalid_body');
    size += value.length;
    if (size > maximum) {
      request.resume();
      throw new Error('request_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 일반 작업의 JSON 한도는 바이너리 업로드와 별도로 유지합니다. */
async function readRequest(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(request, MAX_REQUEST_BYTES);
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  return value;
}

/** 완성된 테스트 번들만 제공하며 프로젝트·설정·임의 파일은 열지 않습니다. */
async function staticFile(
  request: IncomingMessage,
  response: ServerResponse,
  assetsRoot: string,
  secret: string,
  cookieName: string,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const index = pathname === '/' || pathname === '/index.html';
  const relative = index ? 'index.html' : decodeURIComponent(pathname).slice(1);
  if (
    !index &&
    !relative.startsWith('assets/') &&
    relative !== 'user-guide/index.html' &&
    relative !== 'user-guide/reference.html'
  ) {
    fail(response, 404, 'not_found');
    return;
  }
  const file = await realpath(resolve(assetsRoot, relative));
  if (!file.startsWith(`${assetsRoot}${sep}`)) {
    fail(response, 404, 'not_found');
    return;
  }
  const type = MIME[extname(file)];
  if (!type || !(await stat(file)).isFile()) {
    fail(response, 404, 'not_found');
    return;
  }
  if (index)
    response.setHeader(
      'Set-Cookie',
      `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/`,
    );
  response.writeHead(200, { 'Content-Type': type });
  response.end(request.method === 'HEAD' ? undefined : await readFile(file));
}

/** loopback·정확한 Host/Origin·쿠키·고정 헤더를 통과한 작업만 기존 서비스에 전달합니다. */
export async function startWebTestServer(options: WebServerOptions): Promise<{
  server: Server;
  url: string;
  close: () => Promise<void>;
}> {
  const assetsRoot = await realpath(options.assetsRoot);
  const secret = randomBytes(32).toString('hex');
  let origin = '';
  let cookieName = '';
  let closing = false;
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse): void => {
      response.setHeader('Cache-Control', 'no-store');
      // 가이드 문서는 자산에 삽입한 해시 CSP를 사용하며 같은 앱의 프레임에서만 엽니다.
      const guideAsset = /^\/user-guide\/(?:index\.html|reference\.html)$/.test(
        request.url ?? '',
      );
      if (!guideAsset) response.setHeader('Content-Security-Policy', POLICY);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Frame-Options', guideAsset ? 'SAMEORIGIN' : 'DENY');
      response.setHeader('Referrer-Policy', 'no-referrer');
      void (async (): Promise<void> => {
        if (
          closing ||
          request.headers.host !== origin.slice('http://'.length)
        ) {
          fail(response, 403, 'forbidden_host');
          return;
        }
        if (request.headers.origin && request.headers.origin !== origin) {
          fail(response, 403, 'forbidden_origin');
          return;
        }
        if (
          request.url === '/__wiki_test/invoke' ||
          request.url === '/__wiki_test/source-file' ||
          request.url === '/__wiki_test/source-download'
        ) {
          if (request.method !== 'POST') {
            fail(response, 405, 'method_not_allowed');
            return;
          }
          if (
            request.headers.origin !== origin ||
            request.headers['x-wiki-test-request'] !== '1' ||
            !validCookie(request, secret, cookieName)
          ) {
            fail(response, 403, 'forbidden_request');
            return;
          }
          const upload = request.url === '/__wiki_test/source-file';
          if (
            request.headers['content-type'] !==
            (upload ? 'application/octet-stream' : 'application/json')
          ) {
            fail(response, 415, 'unsupported_media_type');
            return;
          }
          if (upload) {
            const metadata = request.headers['x-wiki-file-metadata'];
            if (typeof metadata !== 'string' || metadata.length > 12_000)
              throw new Error('invalid_request');
            const decoded: unknown = JSON.parse(decodeURIComponent(metadata));
            const file = fileMetadataSchema.parse(decoded);
            const bytes = await readBytes(request, MAX_SOURCE_BYTES);
            const result = await options.services.uploadSource(
              file.request,
              file.filename,
              bytes,
            );
            response.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
            });
            response.end(JSON.stringify(result));
            return;
          }
          if (request.url === '/__wiki_test/source-download') {
            const result = await options.services.downloadSource(
              await readRequest(request),
            );
            if (!result.ok) {
              response.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
              });
              response.end(JSON.stringify(result));
              return;
            }
            response.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': result.data.sizeBytes,
              'Content-Disposition': `attachment; filename="original.${result.data.format}"`,
              'X-Source-Sha256': result.data.sourceSha256,
            });
            response.end(result.data.bytes);
            return;
          }
          const input = requestSchema.parse(await readRequest(request));
          const result = await options.services.invoke(
            input.channel,
            input.args,
          );
          response.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
          });
          response.end(JSON.stringify(result));
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          fail(response, 405, 'method_not_allowed');
          return;
        }
        await staticFile(request, response, assetsRoot, secret, cookieName);
      })().catch((error: unknown): void => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const tooLarge =
          error instanceof Error && error.message === 'request_too_large';
        fail(
          response,
          tooLarge ? 413 : request.url?.startsWith('/__wiki_test/') ? 400 : 404,
          tooLarge ? 'request_too_large' : 'invalid_request',
        );
      });
    },
  );
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>(
    (accept: () => void, reject: (error: Error) => void): void => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', accept);
    },
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen_failed');
  origin = `http://127.0.0.1:${address.port}`;
  cookieName = `wiki_web_test_${address.port}`;
  return {
    server,
    url: origin,
    close: async (): Promise<void> => {
      if (closing) return;
      closing = true;
      await options.services.close();
      server.closeAllConnections();
      await new Promise<void>(
        (accept: () => void, reject: (error: Error) => void): void => {
          server.close((error?: Error): void =>
            error ? reject(error) : accept(),
          );
        },
      );
    },
  };
}

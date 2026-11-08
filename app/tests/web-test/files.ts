import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  parseChooseSourceFileResult,
  parseSourceRegistrationResult,
} from '../../src/shared/contracts/sources.contract';
import {
  MAX_SOURCE_BYTES,
  parseDocumentListResult,
  parseSourcePreviewResult,
} from '../../src/shared/contracts/documents.contract';
import type { WebServices } from '../../src/web-test/services';

type Post = (channel: string, args: unknown[]) => Promise<unknown>;

/** 실제 API의 파일 등록 영수증·다운로드와 웹 업로드의 실패/권한 경계를 검증합니다. */
export async function verifyFiles(
  origin: string,
  headers: Record<string, string>,
  post: Post,
  connectionId: string,
  services: WebServices,
): Promise<number> {
  let checks = 0;
  const list = parseDocumentListResult(
    await post('documents:list', [{ connectionId, cursor: null, limit: 20 }]),
  );
  assert(list.ok);
  const { userId, tenant, profileId, policyRevision, accessRevision } =
    list.data.access;
  const expectedScope = {
    userId,
    tenant,
    profileId,
    policyRevision,
    accessRevision,
  };
  const text = Buffer.from(
    '\ufeff# 웹 파일 왕복\r\n한글과 CRLF를 그대로 보존합니다.\r\n',
    'utf8',
  );
  const uploadUrl = `${origin}/__wiki_test/source-file`;
  const uploadHeaders = {
    ...headers,
    'Content-Type': 'application/octet-stream',
    'X-Wiki-File-Metadata': encodeURIComponent(
      JSON.stringify({ request: { connectionId }, filename: '웹 파일.md' }),
    ),
  };
  const upload = async (body: Buffer, filename: string): Promise<Response> =>
    fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...uploadHeaders,
        'X-Wiki-File-Metadata': encodeURIComponent(
          JSON.stringify({ request: { connectionId }, filename }),
        ),
      },
      body: new Uint8Array(body),
    });
  assert.equal(
    (
      await fetch(uploadUrl, {
        method: 'POST',
        headers: { ...uploadHeaders, Cookie: '' },
        body: text,
      })
    ).status,
    403,
  );
  checks++;
  assert.equal(
    (
      await fetch(uploadUrl, {
        method: 'POST',
        headers: { ...uploadHeaders, Origin: 'https://example.invalid' },
        body: text,
      })
    ).status,
    403,
  );
  checks++;
  const chosenResponse = await upload(text, '웹 파일.md');
  assert.equal(chosenResponse.status, 200);
  const chosen = parseChooseSourceFileResult(await chosenResponse.json());
  assert(chosen.ok && chosen.data);
  assert.equal(chosen.data.filename, '웹 파일.md');
  assert.equal(chosen.data.sizeBytes, text.byteLength);
  checks++;
  for (const bad of [
    { bytes: text, name: '../escape.md' },
    { bytes: text, name: 'bad.exe' },
    { bytes: text, name: 'fake.pdf' },
    { bytes: Buffer.from([0xff, 0xfe]), name: 'invalid.txt' },
  ]) {
    const rejected = parseChooseSourceFileResult(
      await (await upload(bad.bytes, bad.name)).json(),
    );
    assert(!rejected.ok, bad.name);
    checks++;
  }
  assert.equal(
    (await upload(Buffer.alloc(MAX_SOURCE_BYTES + 1, 65), 'large.txt')).status,
    413,
  );
  checks++;
  // 실패한 선택 이후에도 원래 고른 snapshot을 등록할 수 있어야 합니다.
  const saved = parseSourceRegistrationResult(
    await post('sources:register', [
      {
        connectionId,
        kind: 'file',
        expectedScope,
        requestId: randomUUID().replaceAll('-', ''),
        title: '웹 파일 왕복',
        fileId: chosen.data.fileId,
      },
    ]),
  );
  assert(saved.ok && saved.data.state === 'complete', JSON.stringify(saved));
  const item = saved.data.item;
  const request = {
    connectionId,
    sourceId: item.sourceId,
    sourceVersion: item.sourceVersion,
    sourceSha256: item.sourceSha256,
    format: item.format,
    sizeBytes: item.sizeBytes,
  };
  assert.equal(
    item.sourceSha256,
    createHash('sha256').update(text).digest('hex'),
  );
  checks++;
  const preview = parseSourcePreviewResult(
    await post('documents:source-preview', [request]),
  );
  assert(preview.ok && preview.data.previewStatus === 'text');
  assert.equal(preview.data.content, text.toString('utf8'));
  checks++;
  const download = await fetch(`${origin}/__wiki_test/source-download`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal(download.headers.get('x-source-sha256'), item.sourceSha256);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), text);
  checks++;
  const wrongHash = await fetch(`${origin}/__wiki_test/source-download`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, sourceSha256: '0'.repeat(64) }),
  });
  assert.match(
    wrongHash.headers.get('content-type') ?? '',
    /application\/json/,
  );
  assert.equal(
    JSON.stringify(await wrongHash.json()).includes('"ok":false'),
    true,
  );
  checks++;
  const wrongConnection = parseChooseSourceFileResult(
    await services.uploadSource(
      { connectionId: 'old-connection' },
      'file.md',
      text,
    ),
  );
  assert(!wrongConnection.ok);
  checks++;
  // 서비스 외부에서 입력 배열을 바꿔도 선택 당시 원본은 바뀌지 않아야 합니다.
  const snapshot = Buffer.from('snapshot preservation\n');
  const selected = await services.uploadSource(
    { connectionId },
    'snapshot.txt',
    snapshot,
  );
  assert(selected.ok && selected.data);
  snapshot.fill(65);
  const snapshotSaved = parseSourceRegistrationResult(
    await post('sources:register', [
      {
        connectionId,
        kind: 'file',
        expectedScope,
        requestId: randomUUID().replaceAll('-', ''),
        title: 'snapshot',
        fileId: selected.data.fileId,
      },
    ]),
  );
  assert(snapshotSaved.ok && snapshotSaved.data.state === 'complete');
  assert.equal(
    snapshotSaved.data.item.sourceSha256,
    createHash('sha256').update('snapshot preservation\n').digest('hex'),
  );
  checks++;
  return checks;
}

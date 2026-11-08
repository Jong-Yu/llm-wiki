import assert from 'node:assert/strict';
import type { SourceVersions } from '../../src/shared/contracts/sources.contract';
import type { DocumentListItem } from '../../src/shared/contracts/documents.contract';
import {
  readSourceDetail,
  readSourceDocuments,
} from '../../src/renderer/features/browse-document-library/api/sourceDetail.api';

/** 직접 주소의 원본 판본·권한·파생 문서 범위를 격리된 bridge로 검증합니다. */
export async function verifySourceDetail(): Promise<number> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const scope = {
    connectionId: 'source-test',
    userId: 'user',
    tenant: 'space',
    profileId: 'default',
    policyRevision: 'a'.repeat(64),
    domain: null,
    viewpoint: null,
  };
  const sourceId = 'b'.repeat(32);
  const oldVersion = 'c'.repeat(32);
  const newVersion = 'd'.repeat(32);
  const versions: SourceVersions = {
    ...scope,
    access: scope,
    sourceId,
    title: '원본',
    currentVersion: newVersion,
    registrationRevision: 'e'.repeat(64),
    documents: [],
    traceId: 'f'.repeat(32),
    versions: [oldVersion, newVersion].map(
      (sourceVersion: string): SourceVersions['versions'][number] => ({
        sourceVersion,
        sourceSha256: '1'.repeat(64),
        sizeBytes: 4,
        kind: 'text',
        format: 'txt',
        filename: null,
        title: sourceVersion === oldVersion ? '이전 원본' : '새 원본',
        createdAt: '2026-10-29T00:00:00Z',
        actor: scope,
      }),
    ),
  };
  let connected = true;
  let changeWhileReading = false;
  let wrongViewpoint = false;
  let wrongListScope = false;
  let suppliedCursor: string | null = null;
  const document = (
    path: string,
    id: string,
    version: string,
  ): DocumentListItem => ({
    kind: 'wiki',
    document: path,
    revision: '2'.repeat(64),
    sourceStatus: 'linked',
    metadata: { source: { id, version } },
  });
  const mock = {
    wiki: {
      connection: {
        getState: async (): Promise<unknown> => ({
          ok: true,
          data: connected
            ? {
                ...scope,
                status: 'connected',
                selection: { tenant: scope.tenant, profile: scope.profileId },
                workspaces: [
                  {
                    id: scope.tenant,
                    permissions: ['read'],
                    profiles: [
                      { id: scope.profileId, domain: null, viewpoint: null },
                    ],
                  },
                ],
              }
            : { status: 'disconnected' },
        }),
      },
      sources: {
        versions: async (): Promise<unknown> => {
          if (changeWhileReading) connected = false;
          return {
            ok: true,
            data: {
              ...versions,
              access: { ...scope, viewpoint: wrongViewpoint ? 'other' : null },
            },
          };
        },
      },
      documents: {
        list: async (request: { cursor?: string | null }): Promise<unknown> => {
          suppliedCursor = request.cursor ?? null;
          return {
            ok: true,
            data: {
              connectionId: scope.connectionId,
              access: {
                ...scope,
                profileId: wrongListScope ? 'other' : scope.profileId,
              },
              items: [
                document('old.md', sourceId, oldVersion),
                document('new.md', sourceId, newVersion),
                document('unrelated.md', '9'.repeat(32), oldVersion),
              ],
              complete: false,
              truncated: false,
              skipped: [{ document: 'unreadable.md', code: 'read_failed' }],
              nextCursor: 'next-page',
              requiresRefresh: false,
            },
          };
        },
      },
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: mock,
    configurable: true,
  });
  let checks = 0;
  try {
    const old = await readSourceDetail(sourceId, oldVersion);
    assert.equal(old.item.sourceVersion, oldVersion);
    assert.equal(old.item.title, '이전 원본');
    checks++;
    assert.equal(
      (await readSourceDetail(sourceId, '')).item.sourceVersion,
      newVersion,
    );
    checks++;
    await assert.rejects(
      readSourceDetail(sourceId, '0'.repeat(32)),
      /최신 버전으로 대체하지 않았습니다/,
    );
    checks++;
    await assert.rejects(
      readSourceDetail('9'.repeat(32), oldVersion),
      /원본과 응답/,
    );
    checks++;
    wrongViewpoint = true;
    await assert.rejects(readSourceDetail(sourceId, oldVersion), /조회 범위/);
    checks++;
    wrongViewpoint = false;
    changeWhileReading = true;
    await assert.rejects(readSourceDetail(sourceId, oldVersion), /권한 범위/);
    checks++;
    changeWhileReading = false;
    connected = true;
    const linked = await readSourceDocuments(old, null);
    assert.deepEqual(
      linked.documents.map((item: DocumentListItem): string =>
        item.kind === 'wiki' ? item.document : '',
      ),
      ['old.md'],
    );
    assert.equal(linked.incomplete, true);
    assert.equal(linked.omitted, true);
    assert.equal(linked.nextCursor, 'next-page');
    checks++;
    await readSourceDocuments(old, 'next-page');
    assert.equal(suppliedCursor, 'next-page');
    checks++;
    wrongListScope = true;
    await assert.rejects(readSourceDocuments(old, null), /목록의 범위/);
    checks++;
    return checks;
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

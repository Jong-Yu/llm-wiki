import assert from 'node:assert/strict';
import type {
  SourceDownloadRequest,
  SourceDownloadResult,
} from '../../src/shared/contracts/sources.contract';
import type {
  MarkdownExportRequest,
  MarkdownExportResult,
} from '../../src/shared/contracts/fileExports.contract';
import { markdownExportRequestSchema } from '../../src/shared/contracts/fileExports.contract';
import { downloadLibrarySource } from '../../src/renderer/features/browse-document-library/api/documentLibrary.queries';
import {
  canDownloadArtifactMarkdown,
  downloadArtifactMarkdown,
} from '../../src/renderer/features/create-document-artifact/api/documentArtifact.api';
import type { ArtifactSession } from '../../src/renderer/features/create-document-artifact/model/documentArtifact';
import type { LibraryScope } from '../../src/renderer/features/browse-document-library/model/documentLibrary.types';
import type { DocumentListItem } from '../../src/shared/contracts/documents.contract';

/** UI adapter가 현재 범위만 사용하고 편집본의 바이트 표현을 바꾸지 않는지 확인합니다. */
export async function verifyFileUi(): Promise<number> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const scope: LibraryScope = {
    connectionId: 'connection-one',
    userId: 'user-one',
    tenant: 'tenant-one',
    profileId: 'default',
    policyRevision: 'a'.repeat(64),
    domain: null,
    viewpoint: null,
  };
  const session: ArtifactSession = { ...scope, permissions: ['read', 'write'] };
  const item: Extract<DocumentListItem, { kind: 'source' }> = {
    kind: 'source',
    sourceId: 'b'.repeat(32),
    title: '검증 원본',
    sourceVersion: 'c'.repeat(32),
    sourceSha256: 'd'.repeat(64),
    sizeBytes: 17,
    format: 'txt',
    registrationRevision: 'e'.repeat(64),
    linkedDocumentCount: 0,
    analysisStatus: 'not_started',
  };
  let connected = true;
  let changeDuringDownload = false;
  let sourceResult: SourceDownloadResult = { ok: true, data: { saved: true } };
  const downloaded: SourceDownloadRequest[] = [];
  const exports: MarkdownExportRequest[] = [];
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
                    permissions: ['read', 'write'],
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
        download: async (
          request: SourceDownloadRequest,
        ): Promise<SourceDownloadResult> => {
          downloaded.push(request);
          if (changeDuringDownload) connected = false;
          return sourceResult;
        },
      },
      fileExports: {
        exportMarkdown: async (
          request: MarkdownExportRequest,
        ): Promise<MarkdownExportResult> => {
          exports.push(request);
          return { ok: true, data: { started: true } };
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
    assert(canDownloadArtifactMarkdown());
    checks++;
    const form = {
      title: '수정 중인 제목',
      content: '\ufeff# 편집본\r\n끝 공백  \r\n',
    };
    assert.deepEqual(
      await downloadArtifactMarkdown(session, form, (): boolean => true),
      { ok: true, data: { started: true } },
    );
    assert.deepEqual(exports, [
      {
        ...form,
        connectionId: session.connectionId,
        expectedScope: {
          userId: session.userId,
          tenant: session.tenant,
          profileId: session.profileId,
          policyRevision: session.policyRevision,
        },
      },
    ]);
    checks++;
    const staleView = await downloadArtifactMarkdown(
      session,
      form,
      (): boolean => false,
    );
    assert(!staleView.ok && staleView.error.code === 'scope_changed');
    assert.equal(exports.length, 1);
    checks++;
    connected = false;
    const staleScope = await downloadArtifactMarkdown(
      session,
      form,
      (): boolean => true,
    );
    assert(!staleScope.ok && staleScope.error.code === 'scope_changed');
    assert.equal(exports.length, 1);
    checks++;
    const blocked = await downloadLibrarySource(item, scope);
    assert(!blocked.ok && blocked.error.code === 'scope_changed');
    assert.equal(downloaded.length, 0);
    checks++;
    connected = true;
    assert.deepEqual(await downloadLibrarySource(item, scope), sourceResult);
    assert.deepEqual(downloaded[0], {
      connectionId: scope.connectionId,
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceSha256: item.sourceSha256,
      sizeBytes: item.sizeBytes,
      format: item.format,
    });
    checks++;
    sourceResult = { ok: true, data: { saved: false } };
    assert.deepEqual(await downloadLibrarySource(item, scope), sourceResult);
    checks++;
    sourceResult = {
      ok: false,
      error: { code: 'source_mismatch', message: '해시 불일치' },
    };
    assert.deepEqual(await downloadLibrarySource(item, scope), sourceResult);
    checks++;
    changeDuringDownload = true;
    const changed = await downloadLibrarySource(item, scope);
    assert(!changed.ok && changed.error.code === 'scope_changed');
    checks++;
    assert(
      !markdownExportRequestSchema.safeParse({
        title: '잘못\n된 제목',
        content: '',
      }).success,
    );
    assert(
      !markdownExportRequestSchema.safeParse({
        title: '제목',
        content: '가'.repeat(350000),
      }).success,
    );
    assert(
      !markdownExportRequestSchema.safeParse({
        title: '제목',
        content: '',
        path: '/tmp/arbitrary',
      }).success,
    );
    checks++;
    connected = true;
    const invalid = await downloadArtifactMarkdown(
      session,
      { title: '', content: '본문 유지' },
      (): boolean => true,
    );
    assert(!invalid.ok && invalid.error.code === 'invalid_input');
    assert.equal(exports.length, 1);
    checks++;
    Object.defineProperty(globalThis, 'window', {
      value: { wiki: { connection: mock.wiki.connection } },
      configurable: true,
    });
    assert(!canDownloadArtifactMarkdown());
    const unavailable = await downloadArtifactMarkdown(
      session,
      form,
      (): boolean => true,
    );
    assert(
      !unavailable.ok &&
        unavailable.error.code === 'markdown_export_unavailable',
    );
    checks++;
    return checks;
  } finally {
    if (originalWindow)
      Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

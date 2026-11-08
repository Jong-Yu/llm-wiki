import type { DocumentListItem } from '@contracts/documents.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import type { ExportFormat } from '@contracts/fileExports.contract';
import type { SourceVersions } from '@contracts/sources.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { exportMarkdownFile } from '@renderer/platform/fileExports';
import { sourcesGateway } from '@renderer/platform/sources';
import type { LibraryScope } from '../model/documentLibrary.types';

export type SourceDetail = {
  versions: SourceVersions;
  item: Extract<DocumentListItem, { kind: 'source' }>;
  scope: LibraryScope;
};
export type LinkedSourceDocuments = {
  documents: Extract<DocumentListItem, { kind: 'wiki' }>[];
  nextCursor: string | null;
  incomplete: boolean;
  omitted: boolean;
};

/** 원본을 조회한 사용자·공간·관점이 여전히 같을 때만 내용을 표시합니다. */
async function verifyScope(scope: LibraryScope): Promise<void> {
  const result = await connectionGateway.getState();
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    result.data.connectionId !== scope.connectionId ||
    result.data.userId !== scope.userId ||
    result.data.selection?.tenant !== scope.tenant ||
    result.data.selection?.profile !== scope.profileId ||
    !sameAccessRevision(result.data, scope)
  )
    throw new Error(
      '연결 또는 권한 범위가 변경되었습니다. 다시 확인해 주세요.',
    );
}

/** 주소의 판본을 실제 원본 목록과 대조하며 없는 판본을 최신으로 바꾸지 않습니다. */
export async function readSourceDetail(
  sourceId: string,
  version: string,
): Promise<SourceDetail> {
  const connection = await connectionGateway.getState();
  if (!connection.ok) throw new Error(connection.error.message);
  if (connection.data.status !== 'connected' || !connection.data.selection)
    throw new Error('작업 공간을 선택해 주세요.');
  const result = await sourcesGateway.versions({
    connectionId: connection.data.connectionId,
    sourceId,
  });
  if (!result.ok) throw new Error(result.error.message);
  const data = result.data;
  const selection = connection.data.selection;
  const membership = connection.data.workspaces.find(
    (item: (typeof connection.data.workspaces)[number]): boolean =>
      item.id === selection.tenant,
  );
  const profile = membership?.profiles.find(
    (item: NonNullable<typeof membership>['profiles'][number]): boolean =>
      item.id === selection.profile,
  );
  if (
    data.connectionId !== connection.data.connectionId ||
    data.access.userId !== connection.data.userId ||
    data.access.tenant !== selection.tenant ||
    data.access.profileId !== selection.profile ||
    !sameAccessRevision(data.access, connection.data) ||
    !membership?.permissions.includes('read') ||
    !profile ||
    data.access.domain !== profile.domain ||
    data.access.viewpoint !== profile.viewpoint
  )
    throw new Error('원본 응답의 조회 범위를 확인할 수 없습니다.');
  const scope = { ...data.access, connectionId: data.connectionId };
  await verifyScope(scope);
  if (data.sourceId !== sourceId)
    throw new Error('요청한 원본과 응답이 일치하지 않습니다.');
  const selected = data.versions.find(
    (item: SourceVersions['versions'][number]): boolean =>
      item.sourceVersion === (version || data.currentVersion),
  );
  if (!selected)
    throw new Error(
      '요청한 원본 버전을 찾을 수 없습니다. 최신 버전으로 대체하지 않았습니다.',
    );
  return {
    versions: data,
    scope,
    item: {
      kind: 'source',
      sourceId,
      sourceVersion: selected.sourceVersion,
      sourceSha256: selected.sourceSha256,
      sizeBytes: selected.sizeBytes,
      format: selected.format,
      title: selected.title,
      registrationRevision: data.registrationRevision,
      linkedDocumentCount: data.documents.length,
      analysisStatus: 'not_started',
    },
  };
}

/** 파생 문서는 실제 메타데이터로 대조하고 목록의 미조회 범위를 그대로 알립니다. */
export async function readSourceDocuments(
  detail: SourceDetail,
  cursor: string | null,
): Promise<LinkedSourceDocuments> {
  await verifyScope(detail.scope);
  const result = await documentsGateway.list({
    connectionId: detail.scope.connectionId,
    limit: 50,
    cursor,
  });
  if (!result.ok) throw new Error(result.error.message);
  await verifyScope(detail.scope);
  const data = result.data;
  if (
    data.connectionId !== detail.scope.connectionId ||
    data.access.userId !== detail.scope.userId ||
    data.access.tenant !== detail.scope.tenant ||
    data.access.profileId !== detail.scope.profileId ||
    data.access.domain !== detail.scope.domain ||
    data.access.viewpoint !== detail.scope.viewpoint ||
    !sameAccessRevision(data.access, detail.scope) ||
    data.requiresRefresh
  )
    throw new Error(
      '문서 목록의 범위가 변경되었습니다. 원본을 다시 확인해 주세요.',
    );
  return {
    documents: data.items.filter(
      (
        item: DocumentListItem,
      ): item is Extract<DocumentListItem, { kind: 'wiki' }> => {
        if (item.kind !== 'wiki') return false;
        const source = item.metadata?.source;
        return (
          !!source &&
          typeof source === 'object' &&
          !Array.isArray(source) &&
          source.id === detail.item.sourceId &&
          source.version === detail.item.sourceVersion
        );
      },
    ),
    nextCursor: data.nextCursor,
    incomplete: !data.complete || data.truncated || data.skipped.length > 0,
    omitted: data.truncated || data.skipped.length > 0,
  };
}

/** 원본에서 만든 문서의 현재 본문을 읽어 고른 형식 파일로 내보냅니다. 원본 서식은 복원하지 않습니다. */
export async function exportLinkedDocument(
  detail: SourceDetail,
  document: string,
  title: string,
  format: ExportFormat = 'md',
): Promise<{ ok: boolean; message: string }> {
  try {
    await verifyScope(detail.scope);
    const content = await documentsGateway.content({
      connectionId: detail.scope.connectionId,
      document,
    });
    if (!content.ok) return { ok: false, message: content.error.message };
    await verifyScope(detail.scope);
    const result = await exportMarkdownFile({
      title,
      format,
      content: content.data.content,
      connectionId: detail.scope.connectionId,
      expectedScope: {
        userId: detail.scope.userId,
        tenant: detail.scope.tenant,
        profileId: detail.scope.profileId,
        policyRevision: detail.scope.policyRevision,
        ...(detail.scope.accessRevision
          ? { accessRevision: detail.scope.accessRevision }
          : {}),
      },
    });
    if (!result.ok) return { ok: false, message: result.error.message };
    return {
      ok: true,
      message: result.data.started
        ? '문서 내려받기를 시작했습니다.'
        : '내려받기를 취소했습니다.',
    };
  } catch (reason: unknown) {
    return {
      ok: false,
      message:
        reason instanceof Error
          ? reason.message
          : '문서를 내려받지 못했습니다.',
    };
  }
}

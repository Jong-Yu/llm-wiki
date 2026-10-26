import type {
  DocumentContent,
  DocumentListItem,
  SourcePreview,
} from '@contracts/documents.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { sameScope, selectedScope } from './documentList.api';
import type { DocumentListError, DocumentListScope } from './documentList.api';

export type DocumentPreviewOutcome =
  | { status: 'ready'; content: DocumentContent | SourcePreview }
  | { status: 'error'; error: DocumentListError; scopeInvalidated: boolean };

/** 본문 응답은 요청한 문서와 main의 현재 사용자/공간/관점에 모두 일치해야 합니다. */
function contentMatchesScope(
  content: DocumentContent | SourcePreview,
  item: DocumentListItem,
  scope: DocumentListScope,
): boolean {
  return (
    (item.kind === 'wiki'
      ? 'document' in content && content.document === item.document
      : 'sourceId' in content &&
        content.sourceId === item.sourceId &&
        content.sourceVersion === item.sourceVersion &&
        content.sourceSha256 === item.sourceSha256 &&
        content.sizeBytes === item.sizeBytes &&
        content.format === item.format) &&
    content.connectionId === scope.connectionId &&
    content.access.userId === scope.userId &&
    content.access.tenant === scope.tenant &&
    content.access.profileId === scope.profileId &&
    content.access.policyRevision === scope.policyRevision &&
    content.access.domain === scope.domain &&
    content.access.viewpoint === scope.viewpoint
  );
}

/** 범위가 바뀐 응답은 본문으로 사용하지 않고 부모 목록의 재확인을 요청합니다. */
function changedScope(): DocumentPreviewOutcome {
  return {
    status: 'error',
    scopeInvalidated: true,
    error: {
      code: 'scope_changed',
      message:
        '조회 중 연결 범위가 변경되어 본문을 숨겼습니다. 현재 작업 공간을 다시 확인해 주세요.',
    },
  };
}

/** 선택 자료의 종류에 맞는 API를 읽고 현재 범위와 불변 원본 참조를 대조합니다. */
export async function loadDocumentPreview(
  item: DocumentListItem,
  expectedScope: DocumentListScope,
): Promise<DocumentPreviewOutcome> {
  try {
    const beforeResult = await connectionGateway.getState();
    if (!beforeResult.ok)
      return {
        status: 'error',
        error: beforeResult.error,
        scopeInvalidated: true,
      };
    const before = selectedScope(beforeResult);
    if (!before || !sameScope(expectedScope, before)) return changedScope();
    const result =
      item.kind === 'wiki'
        ? await documentsGateway.content({
            connectionId: before.connectionId,
            document: item.document,
          })
        : await documentsGateway.sourcePreview({
            connectionId: before.connectionId,
            sourceId: item.sourceId,
            sourceVersion: item.sourceVersion,
            sourceSha256: item.sourceSha256,
            sizeBytes: item.sizeBytes,
            format: item.format,
          });
    const afterResult = await connectionGateway.getState();
    if (!afterResult.ok)
      return {
        status: 'error',
        error: afterResult.error,
        scopeInvalidated: true,
      };
    const after = selectedScope(afterResult);
    if (!result.ok)
      return {
        status: 'error',
        error: result.error,
        scopeInvalidated:
          result.error.status === 401 ||
          result.error.status === 403 ||
          !after ||
          !sameScope(expectedScope, after),
      };
    if (
      !after ||
      !sameScope(before, after) ||
      !sameScope(expectedScope, after) ||
      !contentMatchesScope(result.data, item, after)
    )
      return changedScope();
    return { status: 'ready', content: result.data };
  } catch {
    return {
      status: 'error',
      scopeInvalidated: false,
      error: {
        code: 'bridge_unavailable',
        message:
          '문서 본문을 확인할 수 없습니다. 앱의 서버 연결 상태를 확인해 주세요.',
      },
    };
  }
}

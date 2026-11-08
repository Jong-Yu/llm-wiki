import { sameAccessRevision } from '@contracts/connection.contract';
import {
  ReadQueryError,
  invalidatesReadScope,
} from '@renderer/shared/lib/readQueries';
import { z } from 'zod';
import type {
  ConnectionResult,
  WorkspaceMembership,
  WorkspaceProfile,
} from '@contracts/connection.contract';
import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import type {
  DocumentContent,
  DocumentContentResult,
  DocumentListItem,
  SourcePreviewResult,
} from '@contracts/documents.contract';
import {
  isDocumentPath,
  parseDocumentContentResult,
  sourceFormatSchema,
} from '@contracts/documents.contract';
import type { ReadQueryCache } from '@renderer/shared/lib/readQueries';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { sourcesGateway } from '@renderer/platform/sources';
import type { SourceDownloadResult } from '@contracts/sources.contract';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { workspaceGateway } from '@renderer/platform/workspace';
import type {
  LibraryOutcome,
  LibraryRequest,
  LibraryResult,
  LibraryRow,
  LibraryScope,
} from '../model/documentLibrary.types';

const searchSchema = z.object({
  matches: z.array(
    z.object({
      document: z.string().min(1).max(4096).refine(isDocumentPath),
      revision: z.string().regex(/^[a-f0-9]{64}$/),
      snippet: z.string(),
    }),
  ),
  truncated: z.boolean(),
  skipped: z.array(z.object({ document: z.string(), code: z.string() })),
  scanned: z.number().int().nonnegative(),
  // 아직 위키로 변환되지 않은 등록 원본의 제목 검색 결과입니다(목록의 원본 항목과 같은 모양).
  sources: z
    .object({
      matches: z.array(
        z.object({
          source_id: z.string().min(1),
          title: z.string().min(1),
          source_version: z.string().min(1),
          source_sha256: z.string().min(1),
          size_bytes: z.number().int().nonnegative(),
          format: sourceFormatSchema,
          registration_revision: z.string().min(1),
          documents: z.array(z.record(z.string(), z.unknown())),
        }),
      ),
      truncated: z.boolean(),
    })
    .optional(),
});
type SearchMatch = z.infer<typeof searchSchema>['matches'][number];
type SourceMatch = NonNullable<
  z.infer<typeof searchSchema>['sources']
>['matches'][number];
type WikiLibraryItem = Extract<DocumentListItem, { kind: 'wiki' }>;
export type LibraryDocumentInfo = {
  metadata: NonNullable<DocumentContent['metadata']>;
  source: { id: string; version: string; title?: string } | null;
  sourceMessage: string | null;
};

/** 등록 원본 연결은 실제 문서 메타정보의 식별자와 판본이 있을 때만 제공합니다. */
export function librarySourceReference(
  metadata: DocumentContent['metadata'],
): LibraryDocumentInfo['source'] {
  const value = metadata?.source;
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0
    ? { id: value.id, version: value.version }
    : null;
}

/** 같은 세션에서 이미 읽은 정확한 판본의 제목·원본 연결만 재사용합니다. */
export function cachedLibraryDocument(
  cache: ReadQueryCache,
  item: WikiLibraryItem,
  scope: LibraryScope,
): DocumentContent | null {
  const session = z
    .object({ current: z.unknown() })
    .safeParse(
      cache.client.getQueryData(cache.key('document-content', item.document)),
    );
  if (!session.success) return null;
  try {
    const result = parseDocumentContentResult({
      ok: true,
      data: session.data.current,
    });
    if (
      !result.ok ||
      result.data.document !== item.document ||
      result.data.revision !== item.revision ||
      !sameScope(scope, {
        ...result.data.access,
        connectionId: result.data.connectionId,
      })
    )
      return null;
    return result.data;
  } catch {
    return null;
  }
}

/** 선택한 검색 행의 정보만 읽으며 전체 검색 결과의 본문을 미리 읽지 않습니다. */
export async function readLibraryDocumentInfo(
  item: WikiLibraryItem,
  scope: LibraryScope,
  known: DocumentContent | null,
): Promise<LibraryDocumentInfo> {
  if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
    throw new ReadQueryError({
      code: 'scope_changed',
      message: '조회 범위가 바뀌었습니다. 문서 목록을 새로고침해 주세요.',
    });
  const result: DocumentContentResult = known
    ? { ok: true, data: known }
    : await documentsGateway.content({
        connectionId: scope.connectionId,
        document: item.document,
      });
  if (!result.ok) throw new ReadQueryError(result.error);
  const current = result.data;
  if (
    current.document !== item.document ||
    !sameScope(scope, {
      ...current.access,
      connectionId: current.connectionId,
    })
  )
    throw new ReadQueryError({
      code: 'scope_changed',
      message: '문서 정보의 조회 범위가 변경되었습니다.',
    });
  if (current.revision !== item.revision)
    throw new ReadQueryError({
      code: 'catalog_changed',
      message: '검색 이후 문서가 바뀌었습니다. 다시 검색해 주세요.',
    });
  const source = librarySourceReference(current.metadata);
  let sourceMessage: string | null = null;
  if (source) {
    const catalog = await sourcesGateway.versions({
      connectionId: scope.connectionId,
      sourceId: source.id,
    });
    if (!catalog.ok) {
      if (invalidatesReadScope(catalog.error))
        throw new ReadQueryError(catalog.error);
      sourceMessage =
        '원본 제목을 확인하지 못했습니다. 원본에서 다시 확인해 주세요.';
    } else {
      if (
        catalog.data.sourceId !== source.id ||
        !sameScope(scope, {
          ...catalog.data.access,
          connectionId: catalog.data.connectionId,
        })
      )
        throw new ReadQueryError({
          code: 'scope_changed',
          message: '원본 정보의 조회 범위가 변경되었습니다.',
        });
      const version = catalog.data.versions.find(
        (entry: (typeof catalog.data.versions)[number]): boolean =>
          entry.sourceVersion === source.version,
      );
      if (version) source.title = version.title;
      else sourceMessage = '문서에 연결된 원본 판본을 확인하지 못했습니다.';
    }
  }
  if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
    throw new ReadQueryError({
      code: 'scope_changed',
      message: '조회 중 범위가 바뀌어 문서 정보를 숨겼습니다.',
    });
  return { metadata: current.metadata ?? {}, source, sourceMessage };
}

/** main이 허용한 사용자·공간·관점을 읽어 응답 대조 기준으로 보존합니다. */
function selectedScope(result: ConnectionResult): LibraryScope | null {
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return null;
  const session = result.data;
  const selection = session.selection;
  if (!selection) return null;
  const workspace = session.workspaces.find(
    (value: WorkspaceMembership): boolean => value.id === selection.tenant,
  );
  const profile = workspace?.profiles.find(
    (value: WorkspaceProfile): boolean => value.id === selection.profile,
  );
  if (!workspace?.permissions.includes('read') || !profile) return null;
  return {
    connectionId: session.connectionId,
    userId: session.userId,
    tenant: selection.tenant,
    profileId: selection.profile,
    policyRevision: session.policyRevision,
    ...(session.accessRevision
      ? { accessRevision: session.accessRevision }
      : {}),
    domain: profile.domain,
    viewpoint: profile.viewpoint,
  };
}

/** 연결·권한 판본·관점이 바뀌면 이전 페이지와 늦은 응답을 숨깁니다. */
function sameScope(left: LibraryScope, right: LibraryScope | null): boolean {
  return (
    right !== null &&
    left.connectionId === right.connectionId &&
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    sameAccessRevision(left, right) &&
    left.domain === right.domain &&
    left.viewpoint === right.viewpoint
  );
}

/** 지식 조회 실패는 미추출이나 관계 0개로 바꾸지 않습니다. */
function unknownRow(
  item: DocumentListItem,
  snippet: string | null,
  message: string,
): LibraryRow {
  return {
    item,
    snippet,
    extraction: 'unknown',
    extractionMessage: message,
    relationCount: null,
  };
}

/** 현재 본문과 기계 그래프의 판본 상태를 서버 응답 그대로 표시합니다. */
function knowledgeRow(
  item: DocumentListItem,
  snippet: string | null,
  data: DocumentKnowledge,
): LibraryRow {
  if (item.kind !== 'wiki' || data.sourceRevision !== item.revision)
    return unknownRow(
      item,
      snippet,
      '목록 조회 이후 버전이 바뀌었습니다. 새로고침해 주세요.',
    );
  const graph = data.machineGraph;
  if (graph.status === 'stale' || graph.needs_reextraction === true)
    return {
      item,
      snippet,
      extraction: 'stale',
      extractionMessage: null,
      relationCount: null,
    };
  if (graph.status === 'missing')
    return {
      item,
      snippet,
      extraction: 'missing',
      extractionMessage: null,
      relationCount: null,
    };
  if (graph.status !== 'ready')
    return unknownRow(
      item,
      snippet,
      '이 문서의 추출 상태를 확인할 수 없습니다.',
    );
  return {
    item,
    snippet,
    extraction: 'ready',
    extractionMessage: null,
    relationCount: data.effectiveGraph.relations.length,
  };
}

/** 개별 지식 조회의 응답 범위를 확인하며 원본과 Wiki의 추출을 섞지 않습니다. */
async function enrichRow(
  item: DocumentListItem,
  snippet: string | null,
  scope: LibraryScope,
): Promise<LibraryRow> {
  if (item.kind === 'source')
    return {
      item,
      snippet,
      extraction: 'missing',
      extractionMessage: '등록 원본 · 분석 전',
      relationCount: null,
    };
  try {
    const result = await knowledgeGateway.read({
      connectionId: scope.connectionId,
      document: item.document,
    });
    if (!result.ok) {
      if (invalidatesReadScope(result.error))
        throw new ReadQueryError(result.error);
      return unknownRow(item, snippet, result.error.message);
    }
    if (
      result.data.document !== item.document ||
      !sameScope(scope, {
        ...result.data.access,
        connectionId: result.data.connectionId,
      })
    )
      throw new ReadQueryError({
        code: 'scope_changed',
        message: '조회 범위가 변경되었습니다.',
      });
    return knowledgeRow(item, snippet, result.data);
  } catch (error) {
    if (error instanceof ReadQueryError) throw error;
    return unknownRow(
      item,
      snippet,
      '추출 상태 조회에 실패했습니다. 다시 불러와 주세요.',
    );
  }
}

/** 한 페이지의 추가 조회를 네 개씩 제한해 많은 문서가 서버를 점유하지 않게 합니다. */
async function enrichRows(
  items: DocumentListItem[],
  snippets: Map<string, string>,
  scope: LibraryScope,
): Promise<LibraryRow[]> {
  const rows: LibraryRow[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    rows.push(
      ...(await Promise.all(
        items
          .slice(offset, offset + 4)
          .map((item: DocumentListItem): Promise<LibraryRow> =>
            enrichRow(
              item,
              item.kind === 'wiki'
                ? (snippets.get(item.document) ?? null)
                : null,
              scope,
            ),
          ),
      )),
    );
  }
  return rows;
}

/** 목록과 본문 검색은 기존 bridge만 사용하고 마지막에 현재 인증 범위를 다시 대조합니다. */
export async function queryDocumentLibrary(
  request: LibraryRequest,
): Promise<LibraryOutcome> {
  try {
    const connection = await connectionGateway.getState();
    if (!connection.ok)
      return {
        status: 'error',
        message: connection.error.message,
        failure: connection.error,
      };
    const scope = selectedScope(connection);
    if (!scope) return { status: 'unselected' };
    if (request.expectedScope && !sameScope(request.expectedScope, scope))
      return {
        status: 'error',
        message:
          '연결이나 작업 공간이 변경되었습니다. 처음부터 다시 불러와 주세요.',
        failure: {
          code: 'scope_changed',
          message: '연결이나 작업 공간이 변경되었습니다.',
        },
      };
    let loaded: LibraryResult;
    if (request.query) {
      const response = await workspaceGateway.execute({
        connectionId: scope.connectionId,
        expectedScope: {
          userId: scope.userId,
          tenant: scope.tenant,
          profileId: scope.profileId,
          policyRevision: scope.policyRevision,
          ...(scope.accessRevision
            ? { accessRevision: scope.accessRevision }
            : {}),
        },
        operation: 'search',
        input: { query: request.query, limit: 50 },
      });
      if (!response.ok)
        return {
          status: 'error',
          message: response.error.message,
          failure: response.error,
        };
      if (
        response.data.operation !== 'search' ||
        !sameScope(scope, {
          ...response.data.access,
          connectionId: response.data.connectionId,
        })
      )
        return {
          status: 'error',
          message:
            '검색 결과의 조회 범위가 변경되었습니다. 다시 불러와 주세요.',
          failure: {
            code: 'scope_changed',
            message: '검색 결과의 조회 범위가 변경되었습니다.',
          },
        };
      const data = searchSchema.parse(response.data.data);
      const items = data.matches.map(
        (match: SearchMatch): DocumentListItem => ({
          kind: 'wiki',
          document: match.document,
          revision: match.revision,
          sourceStatus: 'unknown',
        }),
      );
      const sourceMatches = data.sources?.matches ?? [];
      const sourceItems = sourceMatches.map(
        (match: SourceMatch): DocumentListItem => ({
          kind: 'source',
          sourceId: match.source_id,
          title: match.title,
          sourceVersion: match.source_version,
          sourceSha256: match.source_sha256,
          sizeBytes: match.size_bytes,
          format: match.format,
          registrationRevision: match.registration_revision,
          linkedDocumentCount: match.documents.length,
          analysisStatus: 'not_started',
        }),
      );
      loaded = {
        scope,
        rows: await enrichRows(
          [...items, ...sourceItems],
          new Map(
            data.matches.map((match: SearchMatch): [string, string] => [
              match.document,
              match.snippet,
            ]),
          ),
          scope,
        ),
        nextCursor: null,
        incomplete:
          data.truncated ||
          data.skipped.length > 0 ||
          data.sources?.truncated === true,
        skipped: data.skipped,
        requiresRefresh: false,
      };
    } else {
      const response = await documentsGateway.list({
        connectionId: scope.connectionId,
        cursor: request.cursor,
        limit: 20,
      });
      if (!response.ok)
        return {
          status: 'error',
          message: response.error.message,
          failure: response.error,
        };
      const data = response.data;
      if (
        data.scope.tenant !== scope.tenant ||
        !sameScope(scope, { ...data.access, connectionId: data.connectionId })
      )
        return {
          status: 'error',
          message: '목록의 조회 범위가 변경되었습니다. 다시 불러와 주세요.',
          failure: {
            code: 'scope_changed',
            message: '목록의 조회 범위가 변경되었습니다.',
          },
        };
      if (data.requiresRefresh)
        return {
          status: 'error',
          message: '문서 목록이 변경되었습니다. 처음부터 다시 불러와 주세요.',
        };
      loaded = {
        scope,
        rows: await enrichRows(data.items, new Map(), scope),
        nextCursor: data.nextCursor,
        incomplete: data.truncated || data.skipped.length > 0,
        skipped: data.skipped,
        requiresRefresh: data.requiresRefresh,
      };
    }
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return {
        status: 'error',
        message:
          '조회 중 연결이나 권한이 변경되어 결과를 숨겼습니다. 다시 불러와 주세요.',
        failure: {
          code: 'scope_changed',
          message: '조회 중 연결이나 권한이 변경되었습니다.',
        },
      };
    return { status: 'ready', result: loaded };
  } catch (error) {
    if (error instanceof ReadQueryError)
      return {
        status: 'error',
        message: error.message,
        failure: error.failure,
      };
    return {
      status: 'error',
      message:
        '문서 목록을 확인할 수 없습니다. 연결 상태를 확인한 뒤 다시 불러와 주세요.',
    };
  }
}

/** 목록의 불변 원본 참조와 현재 범위를 그대로 사용해 보관 원본을 조회합니다. */
export async function queryLibrarySourcePreview(
  item: Extract<DocumentListItem, { kind: 'source' }>,
  scope: LibraryScope,
): Promise<SourcePreviewResult> {
  try {
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return {
        ok: false,
        error: {
          code: 'scope_changed',
          message: '조회 범위가 바뀌었습니다. 문서 목록을 새로고침해 주세요.',
        },
      };
    const result = await documentsGateway.sourcePreview({
      connectionId: scope.connectionId,
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceSha256: item.sourceSha256,
      sizeBytes: item.sizeBytes,
      format: item.format,
    });
    if (
      result.ok &&
      (result.data.sourceId !== item.sourceId ||
        result.data.sourceVersion !== item.sourceVersion ||
        result.data.sourceSha256 !== item.sourceSha256 ||
        result.data.sizeBytes !== item.sizeBytes ||
        result.data.format !== item.format)
    )
      return {
        ok: false,
        error: {
          code: 'source_changed',
          message:
            '원본 참조가 일치하지 않아 내용을 숨겼습니다. 목록을 새로고침해 주세요.',
        },
      };
    if (
      !sameScope(scope, selectedScope(await connectionGateway.getState())) ||
      (result.ok &&
        !sameScope(scope, {
          ...result.data.access,
          connectionId: result.data.connectionId,
        }))
    )
      return {
        ok: false,
        error: {
          code: 'scope_changed',
          message:
            '조회 범위가 바뀌어 원본을 숨겼습니다. 목록을 새로고침해 주세요.',
        },
      };
    return result;
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '원본을 불러오지 못했습니다. 다시 시도해 주세요.',
      },
    };
  }
}

/** 내려받기 직전과 완료 뒤의 범위를 대조하고 불변 원본 참조만 전달합니다. */
export async function downloadLibrarySource(
  item: Extract<DocumentListItem, { kind: 'source' }>,
  scope: LibraryScope,
): Promise<SourceDownloadResult> {
  const changed: SourceDownloadResult = {
    ok: false,
    error: {
      code: 'scope_changed',
      message: '연결 범위가 바뀌었습니다. 문서 목록을 새로고침해 주세요.',
    },
  };
  try {
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return changed;
    const result = await sourcesGateway.download({
      connectionId: scope.connectionId,
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceSha256: item.sourceSha256,
      sizeBytes: item.sizeBytes,
      format: item.format,
    });
    if (!sameScope(scope, selectedScope(await connectionGateway.getState())))
      return changed;
    return result;
  } catch {
    return {
      ok: false,
      error: {
        code: 'download_failed',
        message: '원본을 내려받지 못했습니다. 연결 상태를 확인해 주세요.',
      },
    };
  }
}

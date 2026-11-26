import { z } from 'zod';
import type { DocumentListItem } from '@contracts/documents.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import { workspaceGateway } from '@renderer/platform/workspace';
import { ReadQueryError } from '@renderer/shared/lib/readQueries';

export type TrashScope = WorkspaceRequest['expectedScope'] & {
  connectionId: string;
};

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const common = { title: z.string(), deleted_at: z.string() };
const wikiItem = z.object({
  ...common,
  kind: z.literal('wiki'),
  document: z.string(),
  revision,
});
const sourceItem = z.object({
  ...common,
  kind: z.literal('source'),
  source_id: z.string().regex(/^[a-f0-9]{32}$/),
  registration_revision: revision,
});
const trashItem = z.discriminatedUnion('kind', [wikiItem, sourceItem]);
const page = z.object({
  items: z.array(trashItem),
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(z.unknown()),
});
export type TrashItem = z.infer<typeof trashItem>;
export type TrashPage = { items: TrashItem[]; incomplete: boolean };
export type TrashTarget = DocumentListItem | TrashItem;

/** 표시용 대상에서 원래 읽은 식별자와 기준 판본만 가져옵니다. */
export function trashTarget(target: TrashTarget): {
  kind: 'wiki' | 'source';
  id: string;
  revision: string;
} {
  if (target.kind === 'wiki')
    return { kind: 'wiki', id: target.document, revision: target.revision };
  return 'sourceId' in target
    ? {
        kind: 'source',
        id: target.sourceId,
        revision: target.registrationRevision,
      }
    : {
        kind: 'source',
        id: target.source_id,
        revision: target.registration_revision,
      };
}

/** 읽었던 접근 범위를 쓰기와 응답에 고정하며 늦은 다른 공간 응답을 거부합니다. */
async function execute(
  scope: TrashScope,
  request: WorkspaceRequest,
): Promise<unknown> {
  const result = await workspaceGateway.execute(request);
  if (!result.ok) throw new ReadQueryError(result.error);
  const access = result.data.access;
  if (
    result.data.connectionId !== scope.connectionId ||
    result.data.operation !== request.operation ||
    access.userId !== scope.userId ||
    access.tenant !== scope.tenant ||
    access.profileId !== scope.profileId ||
    access.policyRevision !== scope.policyRevision ||
    !sameAccessRevision(access, scope)
  )
    throw new ReadQueryError({
      code: 'scope_changed',
      message: '작업 공간이 변경되었습니다. 다시 확인해 주세요.',
    });
  return result.data.data;
}

/** 원본과 Wiki 휴지통을 함께 읽되 부분 조회를 전체 결과로 표시하지 않습니다. */
export async function readDocumentTrash(scope: TrashScope): Promise<TrashPage> {
  const expectedScope = {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
    ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
  };
  const pages = await Promise.all(
    (['documentTrash', 'sourceTrash'] as const).map(
      async (
        operation: 'documentTrash' | 'sourceTrash',
      ): Promise<z.infer<typeof page>> =>
        page.parse(
          await execute(scope, {
            connectionId: scope.connectionId,
            expectedScope,
            operation,
            input: {},
          }),
        ),
    ),
  );
  return {
    items: pages.flatMap(
      (value: z.infer<typeof page>): TrashItem[] => value.items,
    ),
    incomplete: pages.some(
      (value: z.infer<typeof page>): boolean =>
        !value.complete || value.truncated || value.skipped.length > 0,
    ),
  };
}

/** 삭제와 복원은 같은 기준 판본으로 한 번만 요청하며 응답 유실을 자동 재시도하지 않습니다. */
export async function changeDocumentTrash(
  scope: TrashScope,
  target: TrashTarget,
  restore: boolean,
): Promise<number> {
  const item = trashTarget(target);
  const base = {
    connectionId: scope.connectionId,
    expectedScope: {
      userId: scope.userId,
      tenant: scope.tenant,
      profileId: scope.profileId,
      policyRevision: scope.policyRevision,
      ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
    },
  };
  const request: WorkspaceRequest =
    item.kind === 'wiki'
      ? {
          ...base,
          operation: restore ? 'restoreTrashedDocument' : 'trashDocument',
          input: { document: item.id, expected_revision: item.revision },
        }
      : {
          ...base,
          operation: restore ? 'restoreTrashedSource' : 'trashSource',
          input: {
            source_id: item.id,
            expected_registration_revision: item.revision,
          },
        };
  const result = z
    .object({
      state: z.enum(['trashed', 'restored']),
      cleanup_failures: z.array(z.unknown()),
      document: z.string().optional(),
      source_id: z.string().optional(),
    })
    .parse(await execute(scope, request));
  if (
    result.state !== (restore ? 'restored' : 'trashed') ||
    (item.kind === 'wiki' ? result.document : result.source_id) !== item.id
  )
    throw new Error(
      '처리 결과를 확인할 수 없습니다. 목록과 휴지통을 다시 확인해 주세요.',
    );
  return result.cleanup_failures.length;
}

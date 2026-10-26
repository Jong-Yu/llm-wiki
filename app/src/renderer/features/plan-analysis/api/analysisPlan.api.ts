import { z } from 'zod';
import type { SourceVersionScope } from '@contracts/sources.contract';
import type {
  DocumentListItem,
  DocumentListPage,
} from '@contracts/documents.contract';
import type {
  WorkspaceRequest,
  WorkspaceScope,
} from '@contracts/workspace.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { knowledgeGateway } from '@renderer/platform/knowledge';
import { workspaceGateway } from '@renderer/platform/workspace';
import { analysisLocation } from '../model/analysisPlan.schema';
import type {
  PlanFields,
  ConversionFields,
  LocationFields,
} from '../model/analysisPlan.schema';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const jsonRecord = z.record(z.string(), z.json());
const recordSchema = z
  .object({
    manifest: z
      .object({
        id,
        request_id: id,
        kind: z.enum(['plans', 'conversions']),
        tenant: z.string(),
        user_id: z.string(),
        payload_hash: revision,
        actor: jsonRecord,
        ready: z.boolean().optional(),
        complete: z.boolean().optional(),
      })
      .catchall(z.json()),
    revision,
    components: z.record(z.string(), z.string()),
  })
  .catchall(z.json());
const validationSchema = z
  .object({
    plan_id: id,
    plan_revision: revision,
    ready: z.boolean(),
    execution_started: z.literal(false),
  })
  .catchall(z.json());
const handoffSchema = z
  .object({
    handoff_id: id,
    plan_id: id,
    plan_revision: revision,
    jobs: z.array(
      z
        .object({
          document: z.string(),
          state: z.string(),
          job_id: id.nullable().optional(),
          request_id: id.optional(),
        })
        .catchall(z.json()),
    ),
    execution_started: z.literal(false),
    state: z.enum(['complete', 'pending_reconcile']).optional(),
  })
  .catchall(z.json());
export const recoverySchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('conversion'),
    input: z.object({ conversion_id: id }),
  }),
  z.object({
    operation: z.literal('analysisPlan'),
    input: z.object({ plan_id: id }),
  }),
  z.object({
    operation: z.literal('analysisPlanReceipt'),
    input: z.object({ plan_id: id, request_id: id }),
  }),
]);
export type PlanScope = SourceVersionScope;
export type PlanRecord = z.infer<typeof recordSchema>;
export type PlanValidation = z.infer<typeof validationSchema>;
export type PlanHandoff = z.infer<typeof handoffSchema>;
export type PlanRecovery = z.infer<typeof recoverySchema>;
export type PlanError = {
  code: string;
  message: string;
  status?: number;
  recovery?: PlanRecovery;
};
export type PlanResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PlanError };
export type Catalog = {
  scope: PlanScope;
  page: DocumentListPage;
  canWrite: boolean;
};
export type SourceReference = {
  source_id: string;
  source_version: string;
  source_sha256: string;
  registration_revision: string;
};
export type WikiReference = {
  document: string;
  source_revision: string;
  graph_revision: string | null;
  state_revision: string;
};
export type PlanningSource = {
  item: DocumentListItem;
  scope: PlanScope;
  sourceRef: SourceReference | null;
  wikiRef: WikiReference | null;
  content: string | null;
};
export type CreatePlanBody = Extract<
  WorkspaceRequest,
  { operation: 'createAnalysisPlan' }
>['input'];
export type CreateConversionBody = Extract<
  WorkspaceRequest,
  { operation: 'createConversion' }
>['input'];

/** 연결 ID와 권한 비교 메타데이터를 서로 다른 계약 필드로 전달합니다. */
export function expectedPlanScope(scope: PlanScope): WorkspaceScope {
  return {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
  };
}

/** 전후 대조 실패는 자료가 없다는 의미로 해석하지 않습니다. */
function changed<T>(): PlanResult<T> {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결·사용자·관점·정책이 변경되었습니다. 초안은 원래 범위에 보관했습니다. 현재 연결을 다시 확인해 주세요.',
    },
  };
}

/** 실제 main의 현재 범위만 사용하고 renderer 입력으로 인증을 선택하지 않습니다. */
async function currentScope(): Promise<PlanScope | null> {
  const result = await connectionGateway.getState();
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return null;
  const selected = result.data.selection;
  const profile = result.data.workspaces
    .find(
      (workspace: (typeof result.data.workspaces)[number]): boolean =>
        workspace.id === selected.tenant,
    )
    ?.profiles.find(
      (
        profile: (typeof result.data.workspaces)[number]['profiles'][number],
      ): boolean => profile.id === selected.profile,
    );
  if (!profile) return null;
  return {
    domain: profile.domain,
    viewpoint: profile.viewpoint,
    connectionId: result.data.connectionId,
    userId: result.data.userId,
    tenant: result.data.selection.tenant,
    profileId: result.data.selection.profile,
    policyRevision: result.data.policyRevision,
  };
}
/** 같은 범위의 응답만 이전 입력 기준과 함께 표시합니다. */
function sameScope(left: PlanScope | null, right: PlanScope): boolean {
  return (
    !!left &&
    left.connectionId === right.connectionId &&
    left.userId === right.userId &&
    left.tenant === right.tenant &&
    left.profileId === right.profileId &&
    left.domain === right.domain &&
    left.viewpoint === right.viewpoint &&
    left.policyRevision === right.policyRevision
  );
}

/** 실제 목록 cursor를 사용하며 불완전 조회 정보도 함께 반환합니다. */
export async function loadPlanCatalog(
  cursor: string | null,
  expected?: PlanScope,
): Promise<PlanResult<Catalog>> {
  try {
    const scope = await currentScope();
    if (!scope)
      return {
        ok: false,
        error: {
          code: 'selection_required',
          message: '서버 연결과 작업 공간을 먼저 선택해 주세요.',
        },
      };
    if (expected && !sameScope(scope, expected)) return changed();
    const [page, connection] = await Promise.all([
      documentsGateway.list({
        connectionId: scope.connectionId,
        cursor,
        limit: 50,
      }),
      connectionGateway.getState(),
    ]);
    if (!sameScope(await currentScope(), scope)) return changed();
    if (!page.ok) return page;
    if (
      page.data.access.userId !== scope.userId ||
      page.data.access.tenant !== scope.tenant ||
      page.data.access.profileId !== scope.profileId ||
      page.data.access.policyRevision !== scope.policyRevision
    )
      return changed();
    const canWrite =
      connection.ok &&
      connection.data.status === 'connected' &&
      connection.data.workspaces.some(
        (workspace: (typeof connection.data.workspaces)[number]): boolean =>
          workspace.id === scope.tenant &&
          workspace.permissions.includes('source_write'),
      );
    return { ok: true, data: { scope, page: page.data, canWrite } };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '분석할 자료 목록을 읽지 못했습니다.',
      },
    };
  }
}

/** 실제 본문·지식 기준을 함께 읽어 Wiki CAS 또는 불변 원본 참조를 고정합니다. */
export async function selectPlanningSource(
  scope: PlanScope,
  item: DocumentListItem,
): Promise<PlanResult<PlanningSource>> {
  try {
    if (!sameScope(await currentScope(), scope)) return changed();
    if (item.kind === 'source') {
      let content: string | null = null;
      if (item.format === 'md' || item.format === 'txt') {
        const preview = await documentsGateway.sourcePreview({
          connectionId: scope.connectionId,
          sourceId: item.sourceId,
          sourceVersion: item.sourceVersion,
          sourceSha256: item.sourceSha256,
          sizeBytes: item.sizeBytes,
          format: item.format,
        });
        if (!preview.ok) return preview;
        content = preview.data.content;
      }
      if (!sameScope(await currentScope(), scope)) return changed();
      return {
        ok: true,
        data: {
          item,
          scope,
          content,
          wikiRef: null,
          sourceRef: {
            source_id: item.sourceId,
            source_version: item.sourceVersion,
            source_sha256: item.sourceSha256,
            registration_revision: item.registrationRevision,
          },
        },
      };
    }
    const [body, knowledge] = await Promise.all([
      documentsGateway.content({
        connectionId: scope.connectionId,
        document: item.document,
      }),
      knowledgeGateway.read({
        connectionId: scope.connectionId,
        document: item.document,
      }),
    ]);
    if (!sameScope(await currentScope(), scope)) return changed();
    if (!body.ok) return body;
    if (!knowledge.ok) return knowledge;
    if (body.data.revision !== knowledge.data.sourceRevision)
      return {
        ok: false,
        error: {
          code: 'basis_changed',
          message:
            '본문과 지식의 원문 판본이 달라 기준을 고정하지 않았습니다. 자료를 다시 선택해 주세요.',
        },
      };
    return {
      ok: true,
      data: {
        item,
        scope,
        content: body.data.content,
        sourceRef: null,
        wikiRef: {
          document: item.document,
          source_revision: body.data.revision,
          graph_revision: knowledge.data.graphRevision,
          state_revision: knowledge.data.stateRevision,
        },
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '선택 자료의 실제 분석 기준을 읽지 못했습니다.',
      },
    };
  }
}

/** 모든 계획 요청은 실제 고정 scope를 전후 대조하며 오류의 GET 복구 참조를 유지합니다. */
async function execute<T>(
  scope: PlanScope,
  request: WorkspaceRequest,
  schema: z.ZodType<T>,
  mutation: boolean,
): Promise<PlanResult<T>> {
  try {
    if (!sameScope(await currentScope(), scope)) return changed();
    const result = await workspaceGateway.execute(request);
    if (!sameScope(await currentScope(), scope)) {
      if (mutation && !result.ok) {
        const recovery = recoverySchema.safeParse(result.error.recovery);
        return {
          ok: false,
          error: {
            code: 'outcome_unknown',
            message:
              '전송 이후 허용 범위가 바뀌었습니다. 원래 요청을 다시 보내지 말고 같은 기록을 읽어 확인해 주세요.',
            ...(recovery.success ? { recovery: recovery.data } : {}),
          },
        };
      }
      return changed();
    }
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      result.data.connectionId !== scope.connectionId ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.policyRevision !== scope.policyRevision
    ) {
      return mutation
        ? {
            ok: false,
            error: {
              code: 'outcome_unknown',
              message:
                '응답의 작업 공간과 원래 요청 범위가 달라 결과를 확정하지 못했습니다. 같은 요청을 다시 보내지 마세요.',
            },
          }
        : changed();
    }
    const parsed = schema.safeParse(result.data.data);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          code: mutation ? 'outcome_unknown' : 'invalid_response',
          message:
            '서버 기록의 응답을 확정하지 못했습니다. 저장 요청을 반복하지 마세요.',
        },
      };
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: mutation ? 'outcome_unknown' : 'bridge_unavailable',
        message: mutation
          ? '전송 결과를 확인하지 못했습니다. 원래 요청을 재전송하지 말고 동일 기록의 읽기만 확인해 주세요.'
          : '저장된 분석 계획을 읽지 못했습니다.',
      },
    };
  }
}

/** 전체는 빈 locations로 표시해 변환의 모든 보고 단위를 서버 규칙대로 선택합니다. */
function planLocations(
  ranges: LocationFields[],
): ReturnType<typeof analysisLocation>[] {
  return ranges.length === 1 && ranges[0]?.kind === 'whole'
    ? []
    : ranges.map(analysisLocation);
}

/** 사용자가 확인한 범위·산출물·필수 문맥을 원래 출처 기준에 묶습니다. */
export function planBody(
  source: PlanningSource,
  fields: PlanFields,
  conversion: PlanRecord | null,
  requestId: string,
): CreatePlanBody {
  return {
    request_id: requestId,
    ...(source.sourceRef ? { source_ref: source.sourceRef } : {}),
    ...(source.wikiRef ? { wiki_ref: source.wikiRef } : {}),
    ...(conversion
      ? {
          conversion_ref: {
            conversion_id: conversion.manifest.id,
            conversion_revision: conversion.revision,
          },
        }
      : {}),
    locations: planLocations(fields.locations),
    outputs: fields.outputs.map(
      (
        output: PlanFields['outputs'][number],
      ): CreatePlanBody['outputs'][number] => ({
        document: output.document,
        title: output.title,
        purpose: output.purpose,
        locations:
          output.selectedRanges.length === 0
            ? []
            : planLocations(
                fields.locations.filter(
                  (_range: LocationFields, index: number): boolean =>
                    output.selectedRanges.includes(String(index)),
                ),
              ),
        outputs: output.outputs,
      }),
    ),
    context_documents: fields.contexts,
  };
}

/** 변환 결과는 사용자가 실제 보고한 문자열과 위치를 그대로 기록합니다. */
export function conversionBody(
  source: SourceReference,
  fields: ConversionFields,
  requestId: string,
): CreateConversionBody {
  return {
    request_id: requestId,
    source_ref: source,
    method: fields.method,
    units: fields.units.map(
      (
        unit: ConversionFields['units'][number],
      ): CreateConversionBody['units'][number] => ({
        unit_id: unit.unitId,
        location: analysisLocation(unit.location),
        content: unit.content,
      }),
    ),
    complete: fields.complete,
    unread_ranges: fields.unreadRanges
      .split('\n')
      .filter((value: string): boolean => value.trim().length > 0),
    warnings: fields.warnings
      .split('\n')
      .filter((value: string): boolean => value.trim().length > 0),
  };
}

/** 새 불변 변환 보고를 한 번만 명시 생성합니다. */
export async function createConversion(
  scope: PlanScope,
  input: CreateConversionBody,
): Promise<PlanResult<PlanRecord>> {
  return execute(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedPlanScope(scope),
      operation: 'createConversion',
      input,
    },
    recordSchema,
    true,
  );
}
/** 실제 ID의 변환 설명서·문자를 읽어 확인합니다. */
export async function readConversion(
  scope: PlanScope,
  conversionId: string,
): Promise<PlanResult<PlanRecord>> {
  return execute(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedPlanScope(scope),
      operation: 'conversion',
      input: { conversion_id: conversionId },
    },
    recordSchema,
    false,
  );
}
/** 새 불변 계획은 생성 후 별도 검증과 명시 인계가 필요합니다. */
export async function createAnalysisPlan(
  scope: PlanScope,
  input: CreatePlanBody,
): Promise<PlanResult<PlanRecord>> {
  return execute(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedPlanScope(scope),
      operation: 'createAnalysisPlan',
      input,
    },
    recordSchema,
    true,
  );
}
/** 과거 계획의 고정 내용을 현재 입력으로 치환하지 않고 읽습니다. */
export async function readAnalysisPlan(
  scope: PlanScope,
  planId: string,
): Promise<PlanResult<PlanRecord>> {
  return execute(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedPlanScope(scope),
      operation: 'analysisPlan',
      input: { plan_id: planId },
    },
    recordSchema,
    false,
  );
}
/** 현재 원본·문맥·관점과 고정 계획을 서버가 검증하며 실행하지 않습니다. */
export async function validateAnalysisPlan(
  scope: PlanScope,
  plan: PlanRecord,
): Promise<PlanResult<PlanValidation>> {
  return execute(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedPlanScope(scope),
      operation: 'validateAnalysisPlan',
      input: {
        plan_id: plan.manifest.id,
        expected_plan_revision: plan.revision,
      },
    },
    validationSchema,
    false,
  );
}
/** 검증한 판본의 선택 문자를 별도 원본과 기존 작업으로 명시 인계합니다. */
export async function handoffAnalysisPlan(
  scope: PlanScope,
  plan: PlanRecord,
  requestId: string,
): Promise<PlanResult<PlanHandoff>> {
  return execute(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedPlanScope(scope),
      operation: 'handoffAnalysisPlan',
      input: {
        plan_id: plan.manifest.id,
        expected_plan_revision: plan.revision,
        request_id: requestId,
      },
    },
    handoffSchema,
    true,
  );
}
/** 응답 유실·부분 인계는 같은 request ID의 읽기 영수증으로만 확인합니다. */
export async function readAnalysisPlanReceipt(
  scope: PlanScope,
  planId: string,
  requestId: string,
): Promise<PlanResult<PlanHandoff>> {
  return execute(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedPlanScope(scope),
      operation: 'analysisPlanReceipt',
      input: { plan_id: planId, request_id: requestId },
    },
    handoffSchema,
    false,
  );
}

/** 저장된 변환 보고가 선택한 실제 원본의 동일 판본에 속하는지 대조합니다. */
export function conversionMatches(
  record: PlanRecord,
  source: PlanningSource,
): boolean {
  const parsed = z
    .object({
      source_id: z.string(),
      source_version: z.string(),
      source_sha256: z.string(),
      registration_revision: z.string(),
    })
    .safeParse(record.manifest.source_ref);
  const expected = source.sourceRef;
  return (
    !!expected &&
    record.manifest.kind === 'conversions' &&
    record.manifest.tenant === source.scope.tenant &&
    record.manifest.user_id === source.scope.userId &&
    parsed.success &&
    parsed.data.source_id === expected.source_id &&
    parsed.data.source_version === expected.source_version &&
    parsed.data.source_sha256 === expected.source_sha256 &&
    parsed.data.registration_revision === expected.registration_revision
  );
}

/** 기존 계획은 같은 출처의 기록만 연결하고 판본은 저장 당시 값을 그대로 둡니다. */
export function planMatchesSource(
  record: PlanRecord,
  source: PlanningSource,
): boolean {
  const origin = z
    .object({ kind: z.enum(['original', 'wiki']), reference: jsonRecord })
    .safeParse(record.manifest.origin);
  if (!origin.success) return false;
  return source.sourceRef
    ? origin.data.kind === 'original' &&
        origin.data.reference.source_id === source.sourceRef.source_id
    : !!source.wikiRef &&
        origin.data.kind === 'wiki' &&
        origin.data.reference.document === source.wikiRef.document;
}

/** 모든 선언 문서의 작업 영수증이 있어야 전체 인계를 완료로 표시합니다. */
export function handoffComplete(
  handoff: PlanHandoff,
  plan: PlanRecord | null,
): boolean {
  if (!plan || handoff.state === 'pending_reconcile') return false;
  const outputs = z
    .object({ outputs: z.array(z.object({ document: z.string() })) })
    .safeParse(plan.manifest.plan);
  if (!outputs.success || outputs.data.outputs.length !== handoff.jobs.length)
    return false;
  return outputs.data.outputs.every((output: { document: string }): boolean =>
    handoff.jobs.some(
      (job: PlanHandoff['jobs'][number]): boolean =>
        job.document === output.document &&
        job.state === 'complete' &&
        typeof job.job_id === 'string',
    ),
  );
}

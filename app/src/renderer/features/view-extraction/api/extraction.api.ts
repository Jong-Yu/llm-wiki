import { z } from 'zod';
import type { AnalysisJob } from '@contracts/analysis.contract';
import type {
  WorkspaceRequest,
  WorkspaceScope,
} from '@contracts/workspace.contract';
import type {
  ArtifactFile,
  ArtifactUploadRequest,
} from '@contracts/artifacts.contract';
import { workspaceGateway } from '@renderer/platform/workspace';
import { analysisGateway } from '@renderer/platform/analysis';
import { artifactsGateway } from '@renderer/platform/artifacts';
import { connectionGateway } from '@renderer/platform/connection';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const record = z.record(z.string(), z.json());
const extractionProfileSchema = z
  .object({
    profile_id: z.string(),
    domain: z.string().nullable(),
    viewpoint: z.string().nullable(),
  })
  .catchall(z.json());
const bundle = z.object({ bundle_id: id, bundle_revision: revision });
const eventSchema = z.object({
  kind: z.literal('reported'),
  details: z.object({
    operation: z.literal('extraction_submitted'),
    extraction_id: id,
    extraction_revision: revision,
    run_id: id,
  }),
});
const preparedSchema = z.object({
  kind: z.literal('reported'),
  details: bundle.extend({
    operation: z.literal('input_prepared'),
    stage: z.literal('read_source'),
    run_id: id,
  }),
});
const artifactSchema = z.object({
  artifact_id: id,
  artifact_revision: revision,
  sha256: revision,
  size_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(20 * 1024 * 1024),
});
const manifestSchema = z
  .object({
    extraction_id: id,
    extraction_revision: revision,
    job_id: id,
    run_id: id,
    tenant: z.string(),
    user_id: z.string(),
    created_at: z.string(),
    source_ref: record,
    actor: extractionProfileSchema,
    read_source_bundle: bundle,
    content_sha256: revision,
    content_size_bytes: z.number().int().nonnegative(),
    method: z.string(),
    scope: record,
    warnings: z.array(z.string()),
    omissions: z.array(z.string()),
    complete: z.boolean(),
  })
  .catchall(z.json());
const extractionSchema = z
  .object({
    manifest: manifestSchema,
    artifacts: z.array(artifactSchema),
    artifact_collection_revision: revision,
    access: extractionProfileSchema.extend({
      user_id: z.string(),
      tenant: z.string(),
      policy_revision: revision,
    }),
  })
  .catchall(z.json());
const contentSchema = z
  .object({
    extraction_id: id,
    extraction_revision: revision,
    content_sha256: revision,
    content_size_bytes: z.number().int().nonnegative(),
    content: z.string(),
    offset: z.number().int().nonnegative(),
    next_offset: z.number().int().nonnegative().nullable(),
    complete: z.boolean(),
    extraction_complete: z.boolean(),
    truncated: z.boolean(),
    skipped: z.array(z.json()),
  })
  .catchall(z.json());
const uploadSchema = z
  .object({
    job_id: id,
    run_id: id,
    request_id: id,
    job_revision: revision,
    artifact_id: id,
    artifact_revision: revision,
    extraction_id: id,
    sha256: revision,
    size_bytes: z.number().int().nonnegative(),
    state: z.enum(['complete', 'pending_reconcile']),
    replayed: z.boolean(),
    cleanup_failures: z.array(z.json()),
  })
  .catchall(z.json());
const receiptSchema = uploadSchema.extend({
  published: z.boolean(),
  payload_hash: revision,
  request: z
    .object({
      job_id: id,
      run_id: id,
      request_id: id,
      expected_job_revision: revision,
      bundle_id: id,
      bundle_revision: revision,
      extraction_id: id,
      extraction_revision: revision,
      sha256: revision,
      size_bytes: z.number().int().nonnegative(),
      filename: z.string(),
      media_type: z.string(),
    })
    .catchall(z.json()),
});
export type ExtractionScope = {
  connectionId: string;
  userId: string;
  tenant: string;
  profileId: string;
  policyRevision: string;
};
export type ExtractionRef = z.infer<typeof eventSchema>['details'];
export type ExtractionData = z.infer<typeof extractionSchema>;
export type ExtractionContentPage = z.infer<typeof contentSchema>;
export type ExtractionArtifact = z.infer<typeof artifactSchema>;
export type ArtifactOutcome = z.infer<typeof uploadSchema>;
export type ArtifactReceipt = z.infer<typeof receiptSchema>;
export type ExtractionInput = {
  scope: ExtractionScope;
  jobId: string;
  extraction: ExtractionRef;
};
export type ExtractionFailure = {
  code: string;
  message: string;
  status?: number;
};
export type ExtractionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ExtractionFailure };
export type PendingArtifact = {
  request: ArtifactUploadRequest;
  file: ArtifactFile;
};

/** renderer의 연결 식별자는 권한 비교 메타데이터와 분리합니다. */
export function expectedExtractionScope(
  scope: ExtractionScope,
): WorkspaceScope {
  return {
    userId: scope.userId,
    tenant: scope.tenant,
    profileId: scope.profileId,
    policyRevision: scope.policyRevision,
  };
}

/** 공개 작업 이벤트의 실제 식별자와 판본만 추출 선택 항목으로 사용합니다. */
export function extractionRefs(job: AnalysisJob): ExtractionRef[] {
  const seen = new Set<string>();
  const values: ExtractionRef[] = [];
  for (const event of job.events) {
    const parsed = eventSchema.safeParse(event);
    if (parsed.success && !seen.has(parsed.data.details.extraction_id)) {
      seen.add(parsed.data.details.extraction_id);
      values.push(parsed.data.details);
    }
  }
  return values;
}

/** 읽은 manifest의 원래 read_source 묶음과 같은 실행의 준비 근거를 대조합니다. */
export function uploadBlocker(
  job: AnalysisJob,
  data: ExtractionData,
  scope: ExtractionScope,
): string | null {
  const manifest = data.manifest;
  // 제출 직전 bundle 의존 기준 검사가 성공한 actor가 추출물에 보존됩니다.
  // 작업 접수 actor와 정책 revision은 입력의 관점 일치 판정에 사용하지 않습니다.
  const prepared = manifest.actor;
  const current = data.access;
  if (
    current.profile_id !== scope.profileId ||
    prepared.profile_id !== current.profile_id ||
    prepared.domain !== current.domain ||
    prepared.viewpoint !== current.viewpoint
  )
    return `추출 입력을 준비한 관점(${prepared.profile_id})과 현재 관점(${scope.profileId})의 정의가 달라 첨부 자료를 읽기만 합니다. 현재 관점에서 새 입력·추출 준비를 확인해 주세요.`;
  if (job.state !== 'claimed')
    return '현재 실행 중인 작업이 아니므로 첨부 자료를 읽기만 합니다.';
  if (
    job.lease_status !== 'active' ||
    !job.lease_expires_at ||
    !Number.isFinite(Date.parse(job.lease_expires_at)) ||
    Date.parse(job.lease_expires_at) <= Date.now()
  )
    return '유효한 실행 사용권이 없어 첨부 자료를 읽기만 합니다.';
  if (job.basis_status !== 'current')
    return '작업 입력 기준이 현재 원본과 일치하지 않아 첨부 자료를 읽기만 합니다.';
  if (!job.run_id || job.run_id !== manifest.run_id)
    return '이 추출물의 실행과 현재 작업 실행이 달라 첨부 자료를 읽기만 합니다.';
  const expected = manifest.read_source_bundle;
  const active = job.active_input_ref;
  const activeMatches =
    active?.stage === 'read_source' &&
    active.bundle_id === expected.bundle_id &&
    active.bundle_revision === expected.bundle_revision;
  const eventMatches = job.events.some(
    (event: AnalysisJob['events'][number]): boolean => {
      const parsed = preparedSchema.safeParse(event);
      return (
        parsed.success &&
        parsed.data.details.run_id === job.run_id &&
        parsed.data.details.bundle_id === expected.bundle_id &&
        parsed.data.details.bundle_revision === expected.bundle_revision
      );
    },
  );
  if (!activeMatches && !eventMatches)
    return '당시 read_source 입력 묶음의 준비 계보를 확인하지 못해 첨부 자료를 읽기만 합니다.';
  return null;
}

/** 범위를 인증값으로 사용하지 않고 main의 현재 선택과 전후 대조합니다. */
async function matchesScope(scope: ExtractionScope): Promise<boolean> {
  const result = await connectionGateway.getState();
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return false;
  return (
    result.data.connectionId === scope.connectionId &&
    result.data.userId === scope.userId &&
    result.data.policyRevision === scope.policyRevision &&
    result.data.selection.tenant === scope.tenant &&
    result.data.selection.profile === scope.profileId
  );
}

/** 연결·권한 변경은 과거 자료를 현재 범위로 표시하지 않도록 반환합니다. */
function changed<T>(): ExtractionResult<T> {
  return {
    ok: false,
    error: {
      code: 'scope_changed',
      message:
        '연결 또는 허용 범위가 변경되었습니다. 작업 공간을 다시 확인해 주세요.',
    },
  };
}

/** 조회 응답의 실제 접근 범위와 전체 업무 JSON을 유지한 채 검사합니다. */
async function read<T>(
  scope: ExtractionScope,
  request: WorkspaceRequest,
  schema: z.ZodType<T>,
): Promise<ExtractionResult<T>> {
  try {
    if (!(await matchesScope(scope))) return changed();
    const result = await workspaceGateway.execute(request);
    if (!(await matchesScope(scope))) return changed();
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.policyRevision !== scope.policyRevision
    )
      return changed();
    const parsed = schema.safeParse(result.data.data);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : {
          ok: false,
          error: {
            code: 'invalid_response',
            message: '서버 응답의 추출물 정보를 확인하지 못했습니다.',
          },
        };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '추출 자료를 읽지 못했습니다. 서버 연결을 확인해 주세요.',
      },
    };
  }
}

/** 작업 소유권과 이벤트 판본이 일치한 실제 추출 설명서를 읽습니다. */
export async function loadExtraction(
  input: ExtractionInput,
): Promise<ExtractionResult<ExtractionData>> {
  const result = await read(
    input.scope,
    {
      connectionId: input.scope.connectionId,
      expectedScope: expectedExtractionScope(input.scope),
      operation: 'extraction',
      input: {
        job_id: input.jobId,
        extraction_id: input.extraction.extraction_id,
      },
    },
    extractionSchema,
  );
  if (!result.ok) return result;
  const manifest = result.data.manifest;
  if (
    manifest.extraction_id !== input.extraction.extraction_id ||
    manifest.extraction_revision !== input.extraction.extraction_revision ||
    manifest.job_id !== input.jobId ||
    manifest.user_id !== input.scope.userId ||
    manifest.tenant !== input.scope.tenant ||
    manifest.run_id !== input.extraction.run_id
  )
    return {
      ok: false,
      error: {
        code: 'basis_changed',
        message:
          '작업 이벤트와 추출물의 판본 또는 소유 근거가 다릅니다. 현재 작업 기록을 다시 확인해 주세요.',
      },
    };
  return result;
}

/** 문자 위치를 서버가 준 next_offset으로만 이동하며 동일 불변 판본을 읽습니다. */
export async function loadExtractionContent(
  input: ExtractionInput,
  data: ExtractionData,
  offset: number,
): Promise<ExtractionResult<ExtractionContentPage>> {
  const result = await read(
    input.scope,
    {
      connectionId: input.scope.connectionId,
      expectedScope: expectedExtractionScope(input.scope),
      operation: 'extractionContent',
      input: {
        job_id: input.jobId,
        extraction_id: input.extraction.extraction_id,
        extraction_revision: input.extraction.extraction_revision,
        offset,
        limit: 65536,
      },
    },
    contentSchema,
  );
  if (!result.ok) return result;
  const page = result.data;
  if (
    page.extraction_id !== input.extraction.extraction_id ||
    page.extraction_revision !== input.extraction.extraction_revision ||
    page.offset !== offset ||
    page.content_sha256 !== data.manifest.content_sha256 ||
    page.content_size_bytes !== data.manifest.content_size_bytes ||
    page.extraction_complete !== data.manifest.complete ||
    (page.next_offset !== null && page.next_offset <= offset) ||
    page.complete !== (page.next_offset === null)
  )
    return {
      ok: false,
      error: {
        code: 'basis_changed',
        message:
          '본문 페이지가 선택한 추출 판본과 일치하지 않습니다. 다른 페이지로 대체하지 않았습니다.',
      },
    };
  return result;
}

/** 최신 작업을 읽되 변경된 revision을 기존 업로드 요청에 끼워 넣지 않습니다. */
export async function loadExtractionJob(
  scope: ExtractionScope,
  jobId: string,
): Promise<ExtractionResult<AnalysisJob>> {
  try {
    if (!(await matchesScope(scope))) return changed();
    const result = await analysisGateway.read({
      connectionId: scope.connectionId,
      jobId,
    });
    if (!(await matchesScope(scope))) return changed();
    if (!result.ok) return result;
    const job = result.data.job;
    if (
      job.job_id !== jobId ||
      job.user_id !== scope.userId ||
      job.tenant !== scope.tenant
    )
      return changed();
    return { ok: true, data: job };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '현재 작업 상태를 확인하지 못했습니다.',
      },
    };
  }
}

/** 조회 권한과 별도로 현재 작업 공간의 source_write 허용 정보를 표시합니다. */
export async function loadArtifactWritePermission(
  scope: ExtractionScope,
): Promise<ExtractionResult<boolean>> {
  try {
    if (!(await matchesScope(scope))) return changed();
    const result = await connectionGateway.getState();
    if (!result.ok || result.data.status !== 'connected') return changed();
    const workspace = result.data.workspaces.find(
      (item: (typeof result.data.workspaces)[number]): boolean =>
        item.id === scope.tenant,
    );
    if (!(await matchesScope(scope))) return changed();
    return {
      ok: true,
      data: workspace?.permissions.includes('source_write') === true,
    };
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '현재 첨부 쓰기 권한을 확인하지 못했습니다.',
      },
    };
  }
}

/** 경로·바이트 없이 main이 보관한 파일의 메타데이터만 선택합니다. */
export async function chooseArtifact(
  scope: ExtractionScope,
): Promise<ExtractionResult<ArtifactFile>> {
  try {
    if (!(await matchesScope(scope))) return changed();
    const result = await artifactsGateway.chooseFile({
      connectionId: scope.connectionId,
      expectedScope: expectedExtractionScope(scope),
    });
    if (!(await matchesScope(scope))) return changed();
    return result;
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '첨부 파일을 선택하지 못했습니다.',
      },
    };
  }
}

/** 선택 파일의 SHA를 전송하고 응답 유실은 재전송 없이 영수증 확인으로 남깁니다. */
export async function uploadArtifact(
  pending: PendingArtifact,
): Promise<ExtractionResult<ArtifactOutcome>> {
  try {
    const scope: ExtractionScope = {
      connectionId: pending.request.connectionId,
      ...pending.request.expectedScope,
    };
    if (!(await matchesScope(scope))) return changed();
    const result = await artifactsGateway.upload(pending.request);
    if (!(await matchesScope(scope))) return changed();
    if (!result.ok) return result;
    const access = result.data.access;
    if (
      result.data.connectionId !== scope.connectionId ||
      access.userId !== scope.userId ||
      access.tenant !== scope.tenant ||
      access.profileId !== scope.profileId ||
      access.policyRevision !== scope.policyRevision
    )
      return changed();
    const parsed = uploadSchema.safeParse(result.data.data);
    if (!parsed.success || !matchesOutcome(parsed.data, pending))
      return {
        ok: false,
        error: {
          code: 'outcome_unknown',
          message:
            '업로드 응답을 확정하지 못했습니다. 같은 요청의 영수증을 확인해 주세요.',
        },
      };
    return { ok: true, data: parsed.data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '업로드 응답이 유실되었습니다. 같은 요청의 영수증을 확인해 주세요.',
      },
    };
  }
}

/** 파일 지문만 같다는 이유로 다른 요청의 성공을 자신의 성공으로 표시하지 않습니다. */
function matchesOutcome(
  value: ArtifactOutcome,
  pending: PendingArtifact,
): boolean {
  return (
    value.job_id === pending.request.jobId &&
    value.run_id === pending.request.runId &&
    value.request_id === pending.request.requestId &&
    value.extraction_id === pending.request.extractionId &&
    value.sha256 === pending.file.sha256 &&
    value.size_bytes === pending.file.sizeBytes
  );
}

/** 동일 요청의 영수증 payload를 원래 고정 실행·묶음·파일과 모두 대조합니다. */
export async function loadArtifactReceipt(
  scope: ExtractionScope,
  pending: PendingArtifact,
): Promise<ExtractionResult<ArtifactReceipt>> {
  const result = await read(
    scope,
    {
      connectionId: scope.connectionId,
      expectedScope: expectedExtractionScope(scope),
      operation: 'artifactReceipt',
      input: {
        job_id: pending.request.jobId,
        request_id: pending.request.requestId,
      },
    },
    receiptSchema,
  );
  if (!result.ok) return result;
  const value = result.data;
  const request = value.request;
  if (
    !matchesOutcome(value, pending) ||
    request.job_id !== pending.request.jobId ||
    request.run_id !== pending.request.runId ||
    request.request_id !== pending.request.requestId ||
    request.expected_job_revision !== pending.request.expectedJobRevision ||
    request.bundle_id !== pending.request.bundleId ||
    request.bundle_revision !== pending.request.bundleRevision ||
    request.extraction_id !== pending.request.extractionId ||
    request.extraction_revision !== pending.request.extractionRevision ||
    request.sha256 !== pending.file.sha256 ||
    request.size_bytes !== pending.file.sizeBytes ||
    request.filename !== pending.file.filename ||
    request.media_type !== 'application/octet-stream' ||
    value.published !== (value.state === 'complete')
  )
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '영수증이 원래 요청과 일치하지 않아 완료를 확정할 수 없습니다. 재전송하지 말고 요청 기록을 확인해 주세요.',
      },
    };
  return result;
}

/** 서버가 명시 연결한 지문·크기를 고정하고 안전한 기본 이름으로 네이티브 저장합니다. */
export async function downloadArtifact(
  input: ExtractionInput,
  artifact: ExtractionArtifact,
): Promise<ExtractionResult<string>> {
  try {
    if (!(await matchesScope(input.scope))) return changed();
    const result = await artifactsGateway.download({
      connectionId: input.scope.connectionId,
      expectedScope: expectedExtractionScope(input.scope),
      jobId: input.jobId,
      extractionId: input.extraction.extraction_id,
      artifactId: artifact.artifact_id,
      expectedSha256: artifact.sha256,
      sizeBytes: artifact.size_bytes,
      filename: `artifact-${artifact.artifact_id}.bin`,
    });
    if (!(await matchesScope(input.scope))) return changed();
    return result.ok ? { ok: true, data: result.data.filename } : result;
  } catch {
    return {
      ok: false,
      error: {
        code: 'bridge_unavailable',
        message: '첨부 자료를 저장하지 못했습니다.',
      },
    };
  }
}

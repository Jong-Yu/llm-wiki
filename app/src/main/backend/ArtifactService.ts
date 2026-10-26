import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { dialog } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';
import { z } from 'zod';
import type {
  ArtifactFile,
  ChooseArtifactFileRequest,
  ChooseArtifactFileResult,
  ArtifactUploadRequest,
  ArtifactUploadResult,
  ArtifactDownloadRequest,
  ArtifactDownloadResult,
} from '@contracts/artifacts.contract';
import { artifactFileSchema } from '@contracts/artifacts.contract';
import type { WorkspaceScope } from '@contracts/workspace.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import {
  WorkspaceApiService,
  readWorkspaceJsonBody,
  workspaceHttpFailure,
} from './WorkspaceApiService';
import { apiFailure, readApiJson } from './readApi';

const MAX_BYTES = 20 * 1024 * 1024;
const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const accessSchema = z.object({
  user_id: z.string(),
  tenant: z.string(),
  profile_id: z.string(),
  domain: z.string().nullable(),
  viewpoint: z.string().nullable(),
  policy_revision: revision,
});
const envelopeSchema = z.object({
  data: knowledgeValueSchema,
  meta: z.object({ trace_id: id }),
});
const manifestSchema = z.object({
  extraction_id: id,
  extraction_revision: revision,
  job_id: id,
  run_id: id,
  tenant: z.string(),
  user_id: z.string(),
  read_source_bundle: z.object({ bundle_id: id, bundle_revision: revision }),
});
const artifactRefSchema = z.object({
  artifact_id: id,
  artifact_revision: revision,
  sha256: revision,
  size_bytes: z.number().int().min(0).max(MAX_BYTES),
});
const jobSchema = z.object({
  job_id: id,
  tenant: z.string(),
  user_id: z.string(),
  job_revision: revision,
  run_id: id.nullable(),
  state: z.string(),
  lease_status: z.string(),
  basis_status: z.string(),
  events: z.array(
    z.object({
      kind: z.string(),
      actor: accessSchema,
      details: knowledgeValueSchema,
    }),
  ),
  access: accessSchema,
});
type Failure = Extract<ArtifactUploadResult, { ok: false }>;
type Selected = { info: ArtifactFile; bytes: Buffer; context: AnalysisContext };

/** 인증 정보나 외부 오류 본문을 포함하지 않는 범위 변경 안내입니다. */
function changed(): Failure {
  return apiFailure(
    'scope_changed',
    '연결 또는 작업 공간이 변경되었습니다. 현재 범위에서 다시 선택해 주세요.',
  );
}
/** 표시 중인 과거 범위는 권한이 아니라 현재 선택과 비교하는 기준입니다. */
function matches(scope: WorkspaceScope, context: AnalysisContext): boolean {
  return (
    scope.userId === context.active.userId &&
    scope.tenant === context.selection.tenant &&
    scope.profileId === context.selection.profile &&
    scope.policyRevision === context.active.policyRevision
  );
}
/** 응답 유실은 실패로 확정하지 않고 같은 요청의 영수증 확인을 요구합니다. */
function unknownOutcome(): Failure {
  return {
    ok: false,
    error: {
      code: 'outcome_unknown',
      message:
        '업로드 결과를 확인하지 못했습니다. 같은 요청의 영수증을 다시 확인해 주세요.',
      retry: 'reconcile',
    },
  };
}

/** 파일의 로컬 경로·바이트를 main에만 보관하고 고정 API로만 전송합니다. */
export class ArtifactService {
  #connection: ConnectionService;
  #workspace: WorkspaceApiService;
  #selected: Selected | null = null;
  #requests = new Set<AbortController>();
  #choosing = false;
  #uploading = false;
  #downloading = false;
  constructor(connection: ConnectionService) {
    this.#connection = connection;
    this.#workspace = new WorkspaceApiService(connection);
    connection.onScopeChanged((): void => {
      this.#selected = null;
      for (const controller of this.#requests) controller.abort();
    });
  }

  /** 현재 서버에서 새로 확인한 read·source_write만 파일 선택과 업로드에 사용합니다. */
  async #context(
    connectionId: string,
    scope: WorkspaceScope,
    write: boolean,
  ): Promise<AnalysisContext | Failure> {
    const context = await this.#connection.analysisContext(connectionId);
    if ('ok' in context) return context;
    if (!matches(scope, context)) return changed();
    const workspace = context.active.workspaces.find(
      (value: AnalysisContext['active']['workspaces'][number]): boolean =>
        value.id === context.selection.tenant,
    );
    if (
      !workspace ||
      !workspace.permissions.includes('read') ||
      (write && !workspace.permissions.includes('source_write'))
    )
      return apiFailure(
        'forbidden',
        '이 파일 작업을 실행할 권한이 없습니다.',
        403,
      );
    return context;
  }

  /** 일반 파일 하나를 제한 크기로 읽어 선택 당시 바이트와 해시를 고정합니다. */
  async chooseFile(
    request: ChooseArtifactFileRequest,
    parent?: BrowserWindow,
  ): Promise<ChooseArtifactFileResult> {
    if (this.#choosing || this.#uploading)
      return apiFailure(
        'artifact_busy',
        '진행 중인 파일 작업을 기다려 주세요.',
      );
    this.#choosing = true;
    try {
      const context = await this.#context(
        request.connectionId,
        request.expectedScope,
        true,
      );
      if ('ok' in context) return context;
      const options: OpenDialogOptions = {
        title: '산출물 파일 선택',
        properties: ['openFile'],
      };
      const selection = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      const path = selection.filePaths[0];
      if (selection.canceled || !path)
        return apiFailure('cancelled', '파일 선택을 취소했습니다.');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES)
          return apiFailure(
            'artifact_limit',
            '일반 파일 하나를 20 MiB 이내로 선택해 주세요.',
          );
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
          const buffer = Buffer.alloc(65536);
          const read = await file.read(buffer, 0, buffer.byteLength, null);
          if (!this.#connection.isAnalysisCurrent(context)) return changed();
          if (read.bytesRead === 0) break;
          total += read.bytesRead;
          if (total > MAX_BYTES)
            return apiFailure(
              'artifact_limit',
              '산출물은 20 MiB 이내여야 합니다.',
            );
          chunks.push(buffer.subarray(0, read.bytesRead));
        }
        bytes = Buffer.concat(chunks, total);
      } finally {
        await file.close();
      }
      const parsed = artifactFileSchema.safeParse({
        fileId: randomUUID().replaceAll('-', ''),
        filename: basename(path),
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      if (!parsed.success)
        return apiFailure(
          'invalid_filename',
          '경로 문자가 없는 255자 이내 파일 이름을 선택해 주세요.',
        );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      this.#selected = { context, bytes, info: parsed.data };
      return { ok: true, data: parsed.data };
    } catch {
      return apiFailure(
        'file_read_failed',
        '선택한 파일을 읽지 못했습니다. 파일 상태를 확인해 주세요.',
      );
    } finally {
      this.#choosing = false;
    }
  }

  /** 현재 작업·실행·read_source 입력과 불변 추출 계보를 업로드 직전에 대조합니다. */
  async #basis(
    context: AnalysisContext,
    request: ArtifactUploadRequest,
  ): Promise<Failure | null> {
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      const result = await readApiJson(
        `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/analysis-jobs/${request.jobId}`,
        context.token,
        controller,
        { maxResponseBytes: 16 * 1024 * 1024 },
      );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (!result.ok) {
        this.#connection.invalidateApiScope(
          result.error.code,
          result.error.status,
        );
        return result;
      }
      const envelope = envelopeSchema.parse(result.value);
      const job = jobSchema.parse(envelope.data);
      if (
        job.access.user_id !== context.active.userId ||
        job.access.tenant !== context.selection.tenant ||
        job.access.policy_revision !== context.active.policyRevision ||
        job.user_id !== context.active.userId ||
        job.tenant !== context.selection.tenant ||
        job.job_id !== request.jobId
      )
        return changed();
      if (
        job.job_revision !== request.expectedJobRevision ||
        job.run_id !== request.runId ||
        job.state !== 'claimed' ||
        job.lease_status !== 'active' ||
        job.basis_status !== 'current'
      )
        return {
          ok: false,
          error: {
            code: 'conflict',
            message:
              '작업·실행·원본 기준이 변경되었습니다. 현재 작업을 다시 확인해 주세요.',
            retry: 'reconcile',
          },
        };
      const prepared = job.events.find(
        (event: z.infer<typeof jobSchema>['events'][number]): boolean =>
          event.kind === 'reported' &&
          event.details.operation === 'input_prepared' &&
          event.details.run_id === request.runId &&
          event.details.stage === 'read_source' &&
          event.details.bundle_id === request.bundleId &&
          event.details.bundle_revision === request.bundleRevision,
      );
      if (!prepared)
        return apiFailure(
          'input_basis_changed',
          '현재 실행에 연결된 원본 읽기 입력을 확인해 주세요.',
        );
      const profile = context.active.workspaces
        .find(
          (
            workspace: AnalysisContext['active']['workspaces'][number],
          ): boolean => workspace.id === context.selection.tenant,
        )
        ?.profiles.find(
          (
            item: AnalysisContext['active']['workspaces'][number]['profiles'][number],
          ): boolean => item.id === context.selection.profile,
        );
      // 서버의 입력 지문도 준비 당시의 profile/domain/viewpoint를 포함합니다. 접수 관점은 비교 기준이 아닙니다.
      if (
        !profile ||
        prepared.actor.user_id !== context.active.userId ||
        prepared.actor.tenant !== context.selection.tenant ||
        prepared.actor.profile_id !== context.selection.profile ||
        prepared.actor.domain !== profile.domain ||
        prepared.actor.viewpoint !== profile.viewpoint
      )
        return {
          ok: false,
          error: {
            code: 'input_basis_changed',
            message:
              '원본 읽기 입력을 준비한 관점과 현재 관점이 다릅니다. 입력을 준비한 관점으로 전환하거나 현재 관점에서 새 입력을 준비해 주세요.',
            status: 409,
            retry: 'reconcile',
          },
        };
      const extraction = await this.#workspace.execute({
        connectionId: request.connectionId,
        expectedScope: request.expectedScope,
        operation: 'extraction',
        input: { job_id: request.jobId, extraction_id: request.extractionId },
      });
      if (!extraction.ok) return extraction;
      const manifest = manifestSchema.parse(extraction.data.data.manifest);
      if (
        manifest.tenant !== context.selection.tenant ||
        manifest.user_id !== context.active.userId ||
        manifest.job_id !== request.jobId ||
        manifest.run_id !== request.runId ||
        manifest.extraction_id !== request.extractionId ||
        manifest.extraction_revision !== request.extractionRevision ||
        manifest.read_source_bundle.bundle_id !== request.bundleId ||
        manifest.read_source_bundle.bundle_revision !== request.bundleRevision
      )
        return apiFailure(
          'extraction_basis_changed',
          '추출물의 실행·입력 판본이 달라졌습니다. 현재 자료를 다시 확인해 주세요.',
        );
      return this.#connection.isAnalysisCurrent(context) ? null : changed();
    } catch {
      return apiFailure(
        'invalid_response',
        '현재 작업과 추출물 기준을 확인하지 못했습니다.',
      );
    } finally {
      this.#requests.delete(controller);
    }
  }

  /** 업로드 응답과 영수증 모두 실제 선택 파일·실행·요청의 참조를 대조합니다. */
  #uploaded(
    value: unknown,
    context: AnalysisContext,
    request: ArtifactUploadRequest,
    file: ArtifactFile,
  ): ArtifactUploadResult {
    const parsed = envelopeSchema.parse(value);
    const access = accessSchema.parse(parsed.data.access);
    const profile = context.active.workspaces
      .find(
        (item: AnalysisContext['active']['workspaces'][number]): boolean =>
          item.id === context.selection.tenant,
      )
      ?.profiles.find(
        (
          item: AnalysisContext['active']['workspaces'][number]['profiles'][number],
        ): boolean => item.id === context.selection.profile,
      );
    if (
      !profile ||
      access.user_id !== context.active.userId ||
      access.tenant !== context.selection.tenant ||
      access.profile_id !== context.selection.profile ||
      access.domain !== profile.domain ||
      access.viewpoint !== profile.viewpoint ||
      access.policy_revision !== context.active.policyRevision
    ) {
      this.#connection.invalidateApiScope('scope_changed');
      return unknownOutcome();
    }
    const receipt = z
      .object({
        request_id: id,
        job_id: id,
        run_id: id,
        extraction_id: id,
        artifact_id: id,
        artifact_revision: revision,
        job_revision: revision,
        sha256: revision,
        size_bytes: z.number().int().min(0).max(MAX_BYTES),
        state: z.enum(['complete', 'pending_reconcile']),
      })
      .parse(parsed.data);
    if (
      receipt.request_id !== request.requestId ||
      receipt.job_id !== request.jobId ||
      receipt.run_id !== request.runId ||
      receipt.extraction_id !== request.extractionId ||
      receipt.sha256 !== file.sha256 ||
      receipt.size_bytes !== file.sizeBytes
    )
      return unknownOutcome();
    return {
      ok: true,
      data: {
        connectionId: context.active.connectionId,
        data: parsed.data,
        access: {
          userId: access.user_id,
          tenant: access.tenant,
          profileId: access.profile_id,
          domain: access.domain,
          viewpoint: access.viewpoint,
          policyRevision: access.policy_revision,
        },
        traceId: parsed.meta.trace_id,
      },
    };
  }

  /** 응답 유실 뒤에는 GET 영수증만 읽으며 같은 파일 POST를 자동 반복하지 않습니다. */
  async #receipt(
    context: AnalysisContext,
    request: ArtifactUploadRequest,
    file: ArtifactFile,
  ): Promise<ArtifactUploadResult> {
    if (!this.#connection.isAnalysisCurrent(context)) return unknownOutcome();
    const result = await this.#workspace.execute({
      connectionId: request.connectionId,
      expectedScope: request.expectedScope,
      operation: 'artifactReceipt',
      input: { job_id: request.jobId, request_id: request.requestId },
    });
    if (!result.ok) return unknownOutcome();
    try {
      const receiptRequest = z
        .object({
          job_id: id,
          run_id: id,
          request_id: id,
          extraction_id: id,
          expected_job_revision: revision,
          bundle_id: id,
          bundle_revision: revision,
          extraction_revision: revision,
          sha256: revision,
          size_bytes: z.number(),
          filename: z.string(),
        })
        .parse(result.data.data.request);
      if (
        receiptRequest.expected_job_revision !== request.expectedJobRevision ||
        receiptRequest.bundle_id !== request.bundleId ||
        receiptRequest.bundle_revision !== request.bundleRevision ||
        receiptRequest.extraction_revision !== request.extractionRevision ||
        receiptRequest.filename !== file.filename
      )
        return unknownOutcome();
      return this.#uploaded(
        { data: result.data.data, meta: { trace_id: result.data.traceId } },
        context,
        request,
        file,
      );
    } catch {
      return unknownOutcome();
    }
  }

  /** 고정 snapshot을 현재 CAS로 한 번 전송하고 불명확한 결과는 영수증으로만 확인합니다. */
  async upload(request: ArtifactUploadRequest): Promise<ArtifactUploadResult> {
    if (this.#uploading || this.#choosing)
      return apiFailure(
        'artifact_busy',
        '진행 중인 파일 작업을 기다려 주세요.',
      );
    const selected = this.#selected;
    if (
      !selected ||
      selected.info.fileId !== request.fileId ||
      selected.info.sha256 !== request.contentSha256
    )
      return apiFailure(
        'file_selection_changed',
        '선택한 파일과 SHA-256을 다시 확인해 주세요.',
      );
    this.#uploading = true;
    const controller = new AbortController();
    this.#requests.add(controller);
    let context: AnalysisContext | null = null;
    let dispatched = false;
    try {
      const current = await this.#context(
        request.connectionId,
        request.expectedScope,
        true,
      );
      if ('ok' in current) return current;
      context = current;
      if (!this.#connection.isAnalysisCurrent(selected.context))
        return changed();
      const basis = await this.#basis(context, request);
      if (basis) return basis;
      const form = new FormData();
      const metadata = {
        profile: context.selection.profile,
        request_id: request.requestId,
        run_id: request.runId,
        expected_job_revision: request.expectedJobRevision,
        bundle_id: request.bundleId,
        bundle_revision: request.bundleRevision,
        extraction_id: request.extractionId,
        extraction_revision: request.extractionRevision,
        content_sha256: selected.info.sha256,
      };
      for (const [key, value] of Object.entries(metadata)) form.set(key, value);
      form.set(
        'file',
        new Blob([Uint8Array.from(selected.bytes)], {
          type: 'application/octet-stream',
        }),
        selected.info.filename,
      );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      dispatched = true;
      const response = await fetch(
        `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/analysis-jobs/${request.jobId}/artifacts`,
        {
          method: 'POST',
          body: form,
          headers: {
            Authorization: `Bearer ${context.token}`,
            Accept: 'application/json',
          },
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]),
        },
      );
      if (!this.#connection.isAnalysisCurrent(context)) return unknownOutcome();
      let value: unknown = null;
      try {
        value = await readWorkspaceJsonBody(response);
      } catch {
        if (response.status === 401 || response.status === 403) {
          const failure = workspaceHttpFailure(response.status, null, true);
          this.#connection.invalidateApiScope(
            failure.error.code,
            failure.error.status,
          );
          return failure;
        }
        return await this.#receipt(context, request, selected.info);
      }
      if (!this.#connection.isAnalysisCurrent(context)) return unknownOutcome();
      if (![200, 201, 202].includes(response.status)) {
        const failure = workspaceHttpFailure(response.status, value, true);
        this.#connection.invalidateApiScope(
          failure.error.code,
          failure.error.status,
        );
        return failure.error.code === 'outcome_unknown'
          ? await this.#receipt(context, request, selected.info)
          : failure;
      }
      const uploaded = this.#uploaded(value, context, request, selected.info);
      return !uploaded.ok && uploaded.error.code === 'outcome_unknown'
        ? await this.#receipt(context, request, selected.info)
        : uploaded;
    } catch {
      return dispatched && context
        ? await this.#receipt(context, request, selected.info)
        : apiFailure(
            'upload_preparation_failed',
            '업로드 기준을 확인하지 못했습니다. 현재 파일과 작업을 다시 확인해 주세요.',
          );
    } finally {
      this.#uploading = false;
      this.#requests.delete(controller);
    }
  }

  /** 큰 바이너리 다운로드는 창에서 하나씩 실행해 메모리 사용량을 제한합니다. */
  async download(
    request: ArtifactDownloadRequest,
    parent?: BrowserWindow,
  ): Promise<ArtifactDownloadResult> {
    if (this.#downloading)
      return apiFailure(
        'artifact_busy',
        '진행 중인 파일 다운로드를 기다려 주세요.',
      );
    this.#downloading = true;
    try {
      return await this.#download(request, parent);
    } finally {
      this.#downloading = false;
    }
  }

  /** 실제 카탈로그 참조·수신 크기·해시가 모두 맞는 바이너리만 새 파일에 저장합니다. */
  async #download(
    request: ArtifactDownloadRequest,
    parent?: BrowserWindow,
  ): Promise<ArtifactDownloadResult> {
    const context = await this.#context(
      request.connectionId,
      request.expectedScope,
      false,
    );
    if ('ok' in context) return context;
    const catalog = await this.#workspace.execute({
      connectionId: request.connectionId,
      expectedScope: request.expectedScope,
      operation: 'extraction',
      input: { job_id: request.jobId, extraction_id: request.extractionId },
    });
    if (!catalog.ok) return catalog;
    const manifest = manifestSchema.safeParse(catalog.data.data.manifest);
    if (
      !manifest.success ||
      manifest.data.job_id !== request.jobId ||
      manifest.data.extraction_id !== request.extractionId ||
      manifest.data.tenant !== context.selection.tenant ||
      manifest.data.user_id !== context.active.userId
    )
      return apiFailure(
        'artifact_basis_changed',
        '현재 작업에 연결된 추출물을 확인하지 못했습니다.',
      );
    const refs = z
      .array(artifactRefSchema)
      .safeParse(catalog.data.data.artifacts);
    const ref = refs.success
      ? refs.data.find(
          (item: z.infer<typeof artifactRefSchema>): boolean =>
            item.artifact_id === request.artifactId,
        )
      : undefined;
    if (
      !ref ||
      ref.sha256 !== request.expectedSha256 ||
      ref.size_bytes !== request.sizeBytes
    )
      return apiFailure(
        'artifact_basis_changed',
        '파일의 현재 참조·크기·해시를 다시 확인해 주세요.',
      );
    const controller = new AbortController();
    this.#requests.add(controller);
    try {
      const url = new URL(
        `${context.active.serverUrl}tenants/${encodeURIComponent(context.selection.tenant)}/extractions/${request.extractionId}/artifacts/${request.artifactId}`,
      );
      url.searchParams.set('job_id', request.jobId);
      url.searchParams.set('profile', context.selection.profile);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${context.token}`,
          Accept: 'application/octet-stream',
        },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(30_000),
        ]),
      });
      if (!this.#connection.isAnalysisCurrent(context)) {
        await response.body?.cancel();
        return changed();
      }
      if (!response.ok) {
        let value: unknown = null;
        try {
          value = await readWorkspaceJsonBody(response);
        } catch {
          /* 원격 실패 본문은 공개하지 않습니다. */
        }
        const failure = workspaceHttpFailure(response.status, value, false);
        this.#connection.invalidateApiScope(
          failure.error.code,
          failure.error.status,
        );
        return failure;
      }
      if (
        !response.body ||
        response.headers.get('content-type')?.split(';')[0].trim() !==
          'application/octet-stream' ||
        response.headers.get('x-artifact-sha256') !== ref.sha256 ||
        response.headers.get('content-length') !== String(ref.size_bytes)
      ) {
        await response.body?.cancel();
        return apiFailure(
          'invalid_artifact',
          '파일 전송의 크기·해시 헤더를 확인하지 못했습니다.',
        );
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BYTES || total > ref.size_bytes)
            throw new Error('artifact_limit');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch((): void => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks, total);
      if (
        total !== ref.size_bytes ||
        createHash('sha256').update(bytes).digest('hex') !== ref.sha256
      )
        return apiFailure(
          'invalid_artifact',
          '파일의 실제 크기 또는 SHA-256이 다릅니다.',
        );
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      const options = {
        title: '산출물 내려받기',
        defaultPath: request.filename,
      };
      const destination = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (!this.#connection.isAnalysisCurrent(context)) return changed();
      if (destination.canceled || !destination.filePath)
        return apiFailure('cancelled', '파일 저장을 취소했습니다.');
      const savedInfo = artifactFileSchema.safeParse({
        fileId: request.artifactId,
        filename: basename(destination.filePath),
        sizeBytes: total,
        sha256: ref.sha256,
      });
      if (!savedInfo.success)
        return apiFailure(
          'invalid_filename',
          '경로 문자가 없는 255자 이내 파일 이름을 선택해 주세요.',
        );
      await writeFile(destination.filePath, bytes, { flag: 'wx', mode: 0o600 });
      return {
        ok: true,
        data: {
          filename: basename(destination.filePath),
          sizeBytes: total,
          sha256: ref.sha256,
        },
      };
    } catch {
      return apiFailure(
        'file_transfer_failed',
        '파일을 받거나 새 파일로 저장하지 못했습니다. 기존 파일과 다른 이름을 선택해 주세요.',
      );
    } finally {
      this.#requests.delete(controller);
    }
  }
}

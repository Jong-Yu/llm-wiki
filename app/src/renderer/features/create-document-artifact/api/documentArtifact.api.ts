import { connectionGateway } from '@renderer/platform/connection';
import { workspaceGateway } from '@renderer/platform/workspace';
import { resultDraftsGateway } from '@renderer/platform/resultDrafts';
import { questionRunsGateway } from '@renderer/platform/questionRuns';
import { createRecoverySlot } from '@renderer/platform/recovery';
import {
  exportMarkdownFile,
  supportsMarkdownExport,
} from '@renderer/platform/fileExports';
import { markdownExportRequestSchema } from '@contracts/fileExports.contract';
import type { ExportFormat } from '@contracts/fileExports.contract';
import type { RecoverySlot } from '@renderer/platform/recovery';
import type { QuestionDetail } from '@contracts/questionRuns.contract';
import {
  artifactDraftSchema,
  artifactRecoverySchema,
  savedArtifactSchema,
  sameArtifactScope,
} from '../model/documentArtifact';
import type {
  ArtifactDraft,
  ArtifactForm,
  ArtifactOutcome,
  ArtifactRecovery,
  ArtifactSession,
  DraftCommand,
  SavedArtifact,
} from '../model/documentArtifact';

/** 연결에서 선택된 tenant/profile과 서버가 허용한 권한을 그대로 읽습니다. */
export async function loadArtifactSession(): Promise<
  ArtifactOutcome<ArtifactSession>
> {
  try {
    const result = await connectionGateway.getState();
    if (!result.ok) return result;
    const current = result.data;
    if (current.status !== 'connected' || !current.selection)
      return fail('connection_required', '설정에서 작업 공간을 선택해 주세요.');
    const selection = current.selection;
    const workspace = current.workspaces.find(
      (item: (typeof current.workspaces)[number]): boolean =>
        item.id === selection.tenant,
    );
    if (!workspace)
      return fail('scope_changed', '현재 허용된 작업 공간을 확인해 주세요.');
    return {
      ok: true,
      data: {
        connectionId: current.connectionId,
        userId: current.userId,
        tenant: selection.tenant,
        profileId: selection.profile,
        policyRevision: current.policyRevision,
        ...(current.accessRevision
          ? { accessRevision: current.accessRevision }
          : {}),
        permissions: workspace.permissions,
      },
    };
  } catch {
    return fail('unavailable', '앱 연결을 읽지 못했습니다.');
  }
}

/** 안전한 오류 코드와 안내만 UI로 전달합니다. */
export function fail<T>(code: string, message: string): ArtifactOutcome<T> {
  return { ok: false, error: { code, message } };
}

/** 요청 전후 연결과 응답 범위가 모두 일치해야 개인 자료를 사용합니다. */
async function currentScope(session: ArtifactSession): Promise<boolean> {
  const result = await loadArtifactSession();
  return result.ok && sameArtifactScope(session, result.data);
}

/** 저장 결과 조회 오류를 생성 실패나 빈 결과로 바꾸지 않습니다. */
export async function readArtifact(
  session: ArtifactSession,
  artifactId: string,
): Promise<ArtifactOutcome<SavedArtifact>> {
  try {
    if (!(await currentScope(session)))
      return fail('scope_changed', '연결 범위가 변경되었습니다.');
    const result = await workspaceGateway.execute({
      connectionId: session.connectionId,
      expectedScope: scopeOf(session),
      operation: 'savedResult',
      input: { record_id: artifactId },
    });
    if (!result.ok) return result;
    if (
      !(await currentScope(session)) ||
      !sameArtifactScope(session, {
        ...result.data.access,
        connectionId: result.data.connectionId,
        permissions: [],
      }) ||
      result.data.operation !== 'savedResult'
    )
      return fail('scope_changed', '결과의 허용 범위를 다시 확인해 주세요.');
    const parsed = savedArtifactSchema.safeParse(result.data.data);
    if (
      !parsed.success ||
      parsed.data.record.id !== artifactId ||
      parsed.data.record.tenant !== session.tenant ||
      parsed.data.record.user_id !== session.userId
    )
      return fail('invalid_response', '저장 결과를 확인하지 못했습니다.');
    return { ok: true, data: parsed.data };
  } catch {
    return fail(
      'unavailable',
      '저장 결과를 읽지 못했습니다. 다시 시도해 주세요.',
    );
  }
}

/** 요청 scope에서 권한 목록과 연결 식별자를 분리합니다. */
function scopeOf(session: ArtifactSession): {
  userId: string;
  tenant: string;
  profileId: string;
  policyRevision: string;
  accessRevision?: string;
} {
  return {
    userId: session.userId,
    tenant: session.tenant,
    profileId: session.profileId,
    policyRevision: session.policyRevision,
    ...(session.accessRevision
      ? { accessRevision: session.accessRevision }
      : {}),
  };
}

/** 불변 결과와 분리된 초안 명령을 전송하고 미확인 쓰기를 자동 재시도하지 않습니다. */
export async function requestArtifactDraft(
  session: ArtifactSession,
  command: DraftCommand,
): Promise<ArtifactOutcome<unknown>> {
  const mutation =
    command.operation === 'create' || command.operation === 'edit';
  try {
    if (!(await currentScope(session)))
      return fail(
        'scope_changed',
        '작업 공간이 변경되었습니다. 원래 범위에서 편집을 계속해 주세요.',
      );
    const result = await resultDraftsGateway.execute({
      ...command,
      connectionId: session.connectionId,
      expectedScope: scopeOf(session),
    });
    if (!(await currentScope(session)))
      return fail(
        'scope_changed',
        '응답 중 연결 범위가 변경되었습니다. 원래 범위에서 같은 요청의 저장 결과를 확인해 주세요.',
      );
    if (!result.ok) return result;
    if (
      !sameArtifactScope(session, {
        ...result.data.access,
        connectionId: result.data.connectionId,
        permissions: [],
      }) ||
      result.data.operation !== command.operation
    )
      return fail(
        'scope_changed',
        '응답 범위가 달라졌습니다. 원래 범위에서 저장 결과를 확인해 주세요.',
      );
    return { ok: true, data: result.data.data };
  } catch {
    if (!(await currentScope(session)))
      return fail(
        'scope_changed',
        '연결 범위를 확인하지 못했습니다. 편집 내용과 저장 요청은 원래 범위에 보존했습니다.',
      );
    return fail(
      mutation ? 'outcome_unknown' : 'unavailable',
      mutation
        ? '저장 응답을 확인하지 못했습니다. 같은 요청의 저장 결과를 확인해 주세요.'
        : '초안을 읽지 못했습니다.',
    );
  }
}

/** 선택 결과에서 만들어진 초안인지, 소유자와 기준 판본까지 확인합니다. */
export async function readArtifactDraft(
  session: ArtifactSession,
  draftId: string,
  artifact: SavedArtifact,
): Promise<ArtifactOutcome<ArtifactDraft>> {
  const result = await requestArtifactDraft(session, {
    operation: 'read',
    input: { draft_id: draftId },
  });
  if (!result.ok) return result;
  const parsed = artifactDraftSchema.safeParse(result.data);
  if (
    !parsed.success ||
    parsed.data.record.id !== draftId ||
    parsed.data.record.tenant !== session.tenant ||
    parsed.data.record.user_id !== session.userId ||
    parsed.data.record.data.source_result_id !== artifact.record.id ||
    parsed.data.record.data.source_result_revision !== artifact.revision
  )
    return fail(
      'invalid_response',
      '현재 결과에 연결된 편집 초안을 확인하지 못했습니다.',
    );
  return { ok: true, data: parsed.data };
}

/** 실제 질문 실행 상태를 읽어 생성 실패와 미확인 저장을 구별합니다. */
export async function readArtifactGeneration(
  session: ArtifactSession,
  questionRunId: string,
): Promise<ArtifactOutcome<QuestionDetail>> {
  try {
    if (!(await currentScope(session)))
      return fail('scope_changed', '작업 공간이 변경되었습니다.');
    const result = await questionRunsGateway.read({
      connectionId: session.connectionId,
      expectedScope: scopeOf(session),
      questionRunId,
    });
    if (!result.ok) return result;
    if (
      !(await currentScope(session)) ||
      result.data.id !== questionRunId ||
      result.data.profileId !== session.profileId
    )
      return fail('scope_changed', '생성 상태의 범위를 확인하지 못했습니다.');
    return result;
  } catch {
    return fail('unavailable', '생성 상태를 읽지 못했습니다.');
  }
}

/** main의 보호 저장에만 초안을 보관하며 브라우저 저장소를 사용하지 않습니다. */
export function artifactRecoverySlot(
  session: ArtifactSession,
  artifactId: string,
): RecoverySlot<ArtifactRecovery> {
  return createRecoverySlot(
    session,
    'result-drafts',
    // 저장된 산출물의 식별자는 화면 경로 정리와 무관하게 유지합니다.
    `renewal-artifact:${artifactId}`,
    (value: unknown): ArtifactRecovery => artifactRecoverySchema.parse(value),
  );
}

/** 제공되는 환경에서만 화면의 Markdown 내보내기 행동을 엽니다. */
export function canDownloadArtifactMarkdown(): boolean {
  return supportsMarkdownExport();
}

/** 현재 편집 본문을 그대로 내보내며 서버 저장·승인으로 처리하지 않습니다. */
export async function downloadArtifactMarkdown(
  session: ArtifactSession,
  form: ArtifactForm,
  stillCurrent: () => boolean,
  format: ExportFormat = 'md',
): Promise<ArtifactOutcome<{ started: boolean; warning?: string }>> {
  const parsed = markdownExportRequestSchema.safeParse(form);
  if (!parsed.success)
    return fail(
      'invalid_input',
      parsed.error.issues[0]?.message ??
        '내려받을 제목과 본문을 확인해 주세요.',
    );
  try {
    if (!(await currentScope(session)) || !stillCurrent())
      return fail(
        'scope_changed',
        '화면이나 연결 범위가 변경되어 내려받기를 중단했습니다.',
      );
    return await exportMarkdownFile({
      ...parsed.data,
      // Markdown은 기존 요청 모양(형식 생략)을 유지합니다.
      ...(format === 'md' ? {} : { format }),
      connectionId: session.connectionId,
      expectedScope: scopeOf(session),
    });
  } catch {
    return fail(
      'download_failed',
      '파일 내려받기를 시작하지 못했습니다. 편집 내용은 그대로 유지됩니다.',
    );
  }
}

import type {
  ConnectionResult,
  WorkspaceMembership,
  WorkspaceProfile,
} from '@contracts/connection.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import type {
  ChooseSourceFileResult,
  SourceRegistrationRequest,
  SourceRegistrationResult,
} from '@contracts/sources.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { documentsGateway } from '@renderer/platform/documents';
import { sourcesGateway } from '@renderer/platform/sources';

export type ImportScope = SourceConversionScope & {
  canRegister: boolean;
  canPrepare: boolean;
  canExtract: boolean;
};
export type ImportScopeResult =
  | { status: 'ready'; scope: ImportScope }
  | { status: 'unselected' }
  | { status: 'error'; message: string };

/** 기존에 확인된 tenant/profile 선택만 사용하고 임의 기본 공간을 고르지 않습니다. */
function scopeFromConnection(result: ConnectionResult): ImportScope | null {
  if (
    !result.ok ||
    result.data.status !== 'connected' ||
    !result.data.selection
  )
    return null;
  const connection = result.data;
  const selection = connection.selection;
  if (!selection) return null;
  const workspace = connection.workspaces.find(
    (item: WorkspaceMembership): boolean => item.id === selection.tenant,
  );
  if (!workspace?.permissions.includes('read')) return null;
  if (
    !workspace.profiles.some(
      (item: WorkspaceProfile): boolean => item.id === selection.profile,
    )
  )
    return null;
  return {
    connectionId: connection.connectionId,
    userId: connection.userId,
    tenant: selection.tenant,
    profileId: selection.profile,
    policyRevision: connection.policyRevision,
    ...(connection.accessRevision
      ? { accessRevision: connection.accessRevision }
      : {}),
    canRegister: workspace.permissions.includes('source_write'),
    canPrepare: ['write', 'source_write', 'ontology_write'].every(
      (permission: string): boolean =>
        workspace.permissions.includes(permission),
    ),
    canExtract: workspace.permissions.includes('ontology_write'),
  };
}

/** 전체 사용자·연결·정책 기준으로 초안의 수명을 격리합니다. */
export function importScopeKey(scope: ImportScope): string {
  return JSON.stringify([
    scope.connectionId,
    scope.userId,
    scope.tenant,
    scope.profileId,
    scope.accessRevision ?? scope.policyRevision,
  ]);
}

/** 페이지 진입과 현재 선택 재확인에만 사용하는 읽기입니다. */
export async function readImportScope(): Promise<ImportScopeResult> {
  try {
    const result = await connectionGateway.getState();
    if (!result.ok) return { status: 'error', message: result.error.message };
    const scope = scopeFromConnection(result);
    return scope ? { status: 'ready', scope } : { status: 'unselected' };
  } catch {
    return {
      status: 'error',
      message:
        '연결 상태를 확인하지 못했습니다. 데스크톱 연결을 확인하고 다시 시도해 주세요.',
    };
  }
}

/** 전후 scope 검사로 다른 공간의 응답과 파일 선택을 현재 초안에 섞지 않습니다. */
export async function confirmImportScope(scope: ImportScope): Promise<boolean> {
  const current = await readImportScope();
  return (
    current.status === 'ready' &&
    importScopeKey(scope) === importScopeKey(current.scope)
  );
}

/** 전송 도중 범위가 바뀐 경우도 저장 결과를 단정하지 않습니다. */
function changedScope(
  beforeWrite: boolean = false,
): Extract<SourceRegistrationResult, { ok: false }> {
  return {
    ok: false,
    error: {
      code: beforeWrite ? 'scope_changed_before_write' : 'scope_changed',
      message:
        '연결·사용자·작업 공간을 다시 확인해 주세요. 원래 범위의 입력과 등록 요청은 보존했습니다.',
    },
  };
}

/** 실제 파일은 main의 네이티브 선택기를 통해서만 선택합니다. */
export async function chooseImportFile(
  scope: ImportScope,
): Promise<ChooseSourceFileResult> {
  if (!(await confirmImportScope(scope))) return changedScope(true);
  try {
    const result = await sourcesGateway.chooseFile({
      connectionId: scope.connectionId,
    });
    return (await confirmImportScope(scope)) ? result : changedScope(true);
  } catch {
    return {
      ok: false,
      error: {
        code: 'file_unavailable',
        message: '파일을 선택하지 못했습니다. 파일과 연결을 확인해 주세요.',
      },
    };
  }
}

/** 쓰기 응답이 유실되면 같은 요청의 조회만 허용하는 오류를 반환합니다. */
export async function submitImport(
  scope: ImportScope,
  request: SourceRegistrationRequest,
): Promise<SourceRegistrationResult> {
  if (!(await confirmImportScope(scope))) return changedScope(true);
  try {
    const result = await sourcesGateway.register(request);
    return (await confirmImportScope(scope)) ? result : changedScope();
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '원본 등록 응답을 확인하지 못했습니다. 다시 업로드하지 않고 같은 요청의 등록 상태를 확인해 주세요.',
      },
    };
  }
}

/** 본인 요청의 영수증 GET만 재시도하며 POST는 반복하지 않습니다. */
export async function checkImport(
  scope: ImportScope,
  requestId: string,
): Promise<SourceRegistrationResult> {
  if (!(await confirmImportScope(scope))) return changedScope();
  try {
    const result = await sourcesGateway.receipt({
      connectionId: scope.connectionId,
      requestId,
    });
    return (await confirmImportScope(scope)) ? result : changedScope();
  } catch {
    return {
      ok: false,
      error: {
        code: 'outcome_unknown',
        message:
          '등록 상태를 아직 확인하지 못했습니다. 입력과 원래 요청을 유지합니다.',
      },
    };
  }
}

/** 저장 경로의 문서 존재 여부입니다. 'unknown'은 확인하지 못한 경우입니다. */
export type TargetExistence = 'exists' | 'free' | 'unknown';

/** 저장 전에 같은 이름의 문서가 있는지 읽기로만 확인합니다. 최종 덮어쓰기 방지는 서버가 맡습니다. */
export async function checkTargetExistence(
  scope: ImportScope,
  document: string,
): Promise<TargetExistence> {
  try {
    const result = await documentsGateway.content({
      connectionId: scope.connectionId,
      document,
    });
    if (result.ok) return 'exists';
    return result.error.code === 'not_found' ? 'free' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 겹치지 않는 첫 번호 경로를 찾습니다. 확인이 어려우면 null입니다. */
export async function findFreeTarget(
  scope: ImportScope,
  base: string,
  numbered: (base: string, number: number) => string,
): Promise<string | null> {
  for (let number = 2; number < 50; number += 1) {
    const candidate = numbered(base, number);
    const state = await checkTargetExistence(scope, candidate);
    if (state === 'free') return candidate;
    if (state === 'unknown') return null;
  }
  return null;
}

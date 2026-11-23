import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import type { DocumentListItem } from '@contracts/documents.contract';
import {
  checkTargetExistence,
  findFreeTarget,
  readImportScope,
  importScopeKey,
} from '../api/importRegistration.api';
import type { ImportScope } from '../api/importRegistration.api';
import type { ImportProcessingSession } from './ImportProcessingSession';
import {
  importProcessingSession,
  readSourceProcessingSession,
  sourceProcessingSession,
} from './importProcessingSessions';
import { baseNameFromTitle, targetWithNumber } from './importTargetName';

export type RegisteredSource = Extract<DocumentListItem, { kind: 'source' }>;
export type SourceAnalysisStartResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 이 앱에서 시작해 아직 진행 중인 원본 판본인지 알려 줍니다. */
export function isSourceAnalysisInFlight(
  item: RegisteredSource,
  scope: SourceConversionScope,
): boolean {
  const snapshot = sourceProcessingSession(item, scope)?.getSnapshot();
  return (
    !!snapshot &&
    !snapshot.scopeInvalid &&
    (snapshot.busy ||
      ['converting', 'planning', 'running'].includes(snapshot.phase))
  );
}

/** 작업 접수 전에도 같은 원본의 변환 상태와 재시도 화면으로 돌아갈 수 있습니다. */
export function sourceAnalysisProgressPath(
  item: RegisteredSource,
  scope: SourceConversionScope,
): string | null {
  const session = sourceProcessingSession(item, scope);
  if (!session || session.getSnapshot().scopeInvalid) return null;
  return `/register?${new URLSearchParams({ sourceId: item.sourceId, version: item.sourceVersion })}`;
}

/** 처리 세션의 최종 상태를 사용자에게 알릴 한 줄로 바꿉니다. */
function outcome(session: ImportProcessingSession): SourceAnalysisStartResult {
  const snapshot = session.getSnapshot();
  if (snapshot.error) return { ok: false, message: snapshot.error };
  return { ok: true, message: snapshot.message };
}

/**
 * 이미 등록된 원본의 변환 → 등록 작업 접수 → AI 추출을 등록 직후와 같은 흐름으로 시작합니다.
 * 같은 판본의 진행 중 세션이 있으면 새로 만들지 않고 그 세션을 그대로 돌려줍니다.
 * 같은 판본의 서버 작업이 이미 있는지는 호출하는 쪽이 목록으로 먼저 확인합니다.
 */
export async function startSourceAnalysis(
  item: RegisteredSource,
  expectedScope: SourceConversionScope,
): Promise<SourceAnalysisStartResult> {
  const read = await readImportScope();
  if (read.status !== 'ready')
    return {
      ok: false,
      message:
        read.status === 'error'
          ? read.message
          : '작업 공간을 선택한 뒤 다시 시도해 주세요.',
    };
  const scope: ImportScope = read.scope;
  if (importScopeKey(scope) !== importScopeKey(expectedScope))
    return {
      ok: false,
      message:
        '작업 공간이나 권한이 변경되었습니다. 현재 원본 목록을 다시 확인해 주세요.',
    };
  if (!scope.canPrepare)
    return {
      ok: false,
      message: '이 작업 공간에서 분석을 시작할 쓰기 권한이 없습니다.',
    };
  const existing = readSourceProcessingSession(
    scope,
    item.sourceId,
    item.sourceVersion,
  );
  if (existing) {
    if (isSourceAnalysisInFlight(item, scope))
      return { ok: true, message: '이미 분석을 진행하고 있습니다.' };
    await existing.session.restart();
    return outcome(existing.session);
  }
  // 저장 이름은 등록 화면과 같은 규칙으로 정하고, 겹치면 번호를 붙입니다.
  const base = baseNameFromTitle(item.title);
  let target = targetWithNumber(base, 1);
  const existence = await checkTargetExistence(scope, target);
  if (existence === 'unknown')
    return {
      ok: false,
      message:
        '저장할 문서 이름을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
    };
  if (existence === 'exists') {
    const numbered = await findFreeTarget(scope, base, targetWithNumber);
    if (!numbered)
      return {
        ok: false,
        message:
          '같은 이름의 문서가 있어 번호를 붙일 이름을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
      };
    target = numbered;
  }
  const session = importProcessingSession(
    scope,
    { item, cleanupWarningCount: 0 },
    { targetDocument: target, extract: true },
  );
  await session.begin();
  return outcome(session);
}

import type { DocumentListItem } from '@contracts/documents.contract';
import {
  checkTargetExistence,
  findFreeTarget,
  importScopeKey,
  readImportScope,
} from '../api/importRegistration.api';
import type { ImportScope } from '../api/importRegistration.api';
import { ImportProcessingSession } from './ImportProcessingSession';
import { baseNameFromTitle, targetWithNumber } from './importTargetName';

export type RegisteredSource = Extract<DocumentListItem, { kind: 'source' }>;
export type SourceAnalysisStartResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

type Started = { scopeKey: string; session: ImportProcessingSession };

/** 같은 원본 판본은 앱이 켜져 있는 동안 하나의 처리 세션만 가집니다(중복 클릭·화면 재진입 방지). */
const started = new Map<string, Started>();
/** 변환·접수·실행이 이어지는 단계입니다. 이 동안은 "분석 중"으로 봅니다. */
const activePhases = new Set(['converting', 'planning', 'running']);
/** 화면 밖에서도 끝까지 이어가되 무한히 붙잡지 않는 상한(약 30분)입니다. */
const maxDriveTicks = 1200;

function sourceKey(item: RegisteredSource): string {
  return `${item.sourceId}:${item.sourceVersion}`;
}

/** 이 앱에서 시작해 아직 진행 중인 원본 판본인지 알려 줍니다. */
export function isSourceAnalysisInFlight(item: RegisteredSource): boolean {
  const session = started.get(sourceKey(item))?.session;
  if (!session) return false;
  const snapshot = session.getSnapshot();
  return (
    !snapshot.scopeInvalid &&
    (snapshot.busy || activePhases.has(snapshot.phase))
  );
}

/** 화면을 떠나도 변환·접수·실행이 끝나거나 멈출 때까지 같은 세션의 상태를 이어서 확인합니다. */
async function drive(session: ImportProcessingSession): Promise<void> {
  for (let tick = 0; tick < maxDriveTicks; tick += 1) {
    const snapshot = session.getSnapshot();
    if (snapshot.scopeInvalid) return;
    if (!snapshot.busy && !activePhases.has(snapshot.phase)) return;
    await new Promise<void>((resolve: () => void): void => {
      window.setTimeout(resolve, 1500);
    });
    await session.refresh();
  }
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
  if (!scope.canPrepare)
    return {
      ok: false,
      message: '이 작업 공간에서 분석을 시작할 쓰기 권한이 없습니다.',
    };
  const key = sourceKey(item);
  const existing = started.get(key);
  if (existing && existing.scopeKey === importScopeKey(scope)) {
    if (isSourceAnalysisInFlight(item))
      return { ok: true, message: '이미 분석을 진행하고 있습니다.' };
    await existing.session.refresh();
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
  const session = new ImportProcessingSession(
    scope,
    { item, cleanupWarningCount: 0 },
    target,
    true,
  );
  started.set(key, { scopeKey: importScopeKey(scope), session });
  await session.begin();
  void drive(session);
  return outcome(session);
}

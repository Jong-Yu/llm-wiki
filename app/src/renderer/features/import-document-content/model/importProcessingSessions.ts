import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import type { ImportScope } from '../api/importRegistration.api';
import { importScopeKey } from '../api/importRegistration.api';
import { ImportProcessingSession } from './ImportProcessingSession';
import type { ImportRegisteredSource } from './importProcessing.types';
import type { ImportDocumentValues } from './importDocument.schema';

export type SourceProcessingSession = {
  scope: ImportScope;
  registered: ImportRegisteredSource;
  targetDocument: string;
  session: ImportProcessingSession;
};
const sessions = new Map<string, SourceProcessingSession>();

/** 같은 접근 범위·원본 판본의 등록 후 처리와 목록에서 시작한 처리를 함께 찾습니다. */
function sessionKey(
  scope: SourceConversionScope,
  sourceId: string,
  version: string,
): string {
  return JSON.stringify([importScopeKey(scope), sourceId, version]);
}

/** 현재 접근 범위에서 확인된 원본 세션만 진행 화면에 전달합니다. */
export function readSourceProcessingSession(
  scope: SourceConversionScope,
  sourceId: string,
  version: string,
): SourceProcessingSession | null {
  return sessions.get(sessionKey(scope, sourceId, version)) ?? null;
}

/** 목록에도 사용자·공간·관점·권한 판본까지 같은 처리 세션만 제공합니다. */
export function sourceProcessingSession(
  item: ImportRegisteredSource['item'],
  scope: SourceConversionScope,
): ImportProcessingSession | null {
  const entry = readSourceProcessingSession(
    scope,
    item.sourceId,
    item.sourceVersion,
  );
  return entry?.registered.item.registrationRevision ===
    item.registrationRevision
    ? entry.session
    : null;
}

/** 등록 영수증과 원본 판본별로 세션을 보존해 화면 재진입 때 중복 작업을 만들지 않습니다. */
export function importProcessingSession(
  scope: ImportScope,
  registered: ImportRegisteredSource,
  draft: Pick<ImportDocumentValues, 'targetDocument' | 'extract'>,
): ImportProcessingSession {
  const key = sessionKey(
    scope,
    registered.item.sourceId,
    registered.item.sourceVersion,
  );
  const existing = sessions.get(key);
  if (existing) return existing.session;
  const session = new ImportProcessingSession(
    scope,
    registered,
    draft.targetDocument,
    true,
  );
  sessions.set(key, {
    scope,
    registered,
    targetDocument: draft.targetDocument,
    session,
  });
  return session;
}

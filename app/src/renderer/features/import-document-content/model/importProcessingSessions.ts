import type { ImportScope } from '../api/importRegistration.api';
import { importScopeKey } from '../api/importRegistration.api';
import { ImportProcessingSession } from './ImportProcessingSession';
import type { CompletedImport } from './ImportRegistrationSession';
import type { ImportDocumentValues } from './importDocument.schema';

const sessions = new Map<string, ImportProcessingSession>();

/** 등록 영수증과 고정 입력별로 처리 세션을 보존하고 라우트 재진입 시 새 작업을 만들지 않습니다. */
export function importProcessingSession(
  scope: ImportScope,
  registered: CompletedImport,
  draft: ImportDocumentValues,
): ImportProcessingSession {
  const key = JSON.stringify([
    importScopeKey(scope),
    registered.requestId,
    draft.targetDocument,
    draft.extract,
  ]);
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new ImportProcessingSession(
    scope,
    registered,
    draft.targetDocument,
    true,
  );
  sessions.set(key, session);
  return session;
}

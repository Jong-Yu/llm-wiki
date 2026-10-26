import type {
  RecoveryEntry,
  RecoveryKind,
  RecoveryRequest,
  RecoveryResult,
} from '@contracts/recovery.contract';
import type { AnalysisContext } from './ConnectionService';

export type ProcessRecovery = {
  capture: (
    context: AnalysisContext,
    kind: RecoveryKind,
    key: string,
    payload: string,
    expectedRevision: string | null,
  ) => Promise<RecoveryResult>;
  readContext: (
    context: AnalysisContext,
    kind: RecoveryKind,
  ) => Promise<RecoveryResult>;
  execute: (request: RecoveryRequest) => Promise<RecoveryResult>;
};

/** 현재 재인증 범위의 보호된 요청 식별자만 읽으며 복원으로 실행을 시작하지 않습니다. */
export async function readProcessJournal(
  recovery: ProcessRecovery | undefined,
  context: AnalysisContext,
  kind: RecoveryKind,
): Promise<RecoveryEntry[]> {
  if (!recovery) return [];
  const result = await recovery.readContext(context, kind);
  if (!result.ok) throw new Error('process_recovery_unavailable');
  return result.data.entries;
}

/** 원격 쓰기/프로세스 시작 전에 ID를 보관하고 CAS 실패에는 해당 동작을 진행하지 않습니다. */
export async function writeProcessJournal(
  recovery: ProcessRecovery | undefined,
  context: AnalysisContext,
  kind: RecoveryKind,
  key: string,
  payload: unknown,
  expectedRevision: string | null = null,
): Promise<RecoveryEntry | null> {
  if (!recovery) return null;
  const result = await recovery.capture(
    context,
    kind,
    key,
    JSON.stringify(payload),
    expectedRevision,
  );
  if (!result.ok) throw new Error('process_recovery_write_failed');
  const entry = result.data.entries.find(
    (value: RecoveryEntry): boolean => value.key === key && value.kind === kind,
  );
  if (!entry) throw new Error('process_recovery_write_unconfirmed');
  return entry;
}

/** 실제 영수증을 확인한 요청만 관측한 로컬 판본으로 제거합니다. 정리 실패는 자동 재전송을 허용하지 않습니다. */
export async function removeProcessJournal(
  recovery: ProcessRecovery | undefined,
  context: AnalysisContext,
  entry: RecoveryEntry | null,
): Promise<void> {
  if (!recovery || !entry) return;
  const result = await recovery.execute({
    connectionId: context.active.connectionId,
    expectedScope: {
      userId: context.active.userId,
      tenant: context.selection.tenant,
      profileId: context.selection.profile,
      policyRevision: context.active.policyRevision,
    },
    operation: 'remove',
    kind: entry.kind,
    key: entry.key,
    expectedRevision: entry.revision,
  });
  if (!result.ok) throw new Error('process_recovery_cleanup_failed');
}

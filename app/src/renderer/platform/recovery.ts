import { parseRecoveryResult } from '@contracts/recovery.contract';
import type {
  RecoveryBridge,
  RecoveryKind,
  RecoveryResult,
  RecoveryRequest,
} from '@contracts/recovery.contract';
import type { WorkspaceScope } from '@contracts/workspace.contract';

export type RecoverySession = WorkspaceScope & { connectionId: string };
export type RecoverySlot<T> = {
  load: () => Promise<T | null>;
  save: (value: T) => Promise<void>;
  remove: () => Promise<void>;
};
/** 오래된 preload·웹 fixture에서는 복구 완료로 가장하지 않고 오류를 노출합니다. */
function bridge(): RecoveryBridge {
  if (!window.wiki || !('recovery' in window.wiki) || !window.wiki.recovery)
    throw new Error('이 환경은 종료 후 보호 복구를 지원하지 않습니다.');
  const value = window.wiki.recovery;
  if (
    typeof value !== 'object' ||
    !('execute' in value) ||
    typeof value.execute !== 'function'
  )
    throw new Error('복구 연결을 확인할 수 없습니다.');
  const execute = value.execute;
  return {
    execute: async (request: RecoveryRequest): Promise<RecoveryResult> =>
      parseRecoveryResult(await execute(request)),
  };
}
/** 복구 오류를 토큰·본문 없는 사용자 메시지로 전달합니다. */
function accepted(
  result: RecoveryResult,
): Extract<RecoveryResult, { ok: true }>['data'] {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
/** feature별 디코더와 저장 CAS를 유지하며 충돌 시 자동 덮어쓰기를 금지합니다. */
export function createRecoverySlot<T>(
  session: RecoverySession,
  kind: RecoveryKind,
  key: string,
  decode: (value: unknown) => T,
): RecoverySlot<T> {
  const {
    connectionId,
    userId,
    tenant,
    profileId,
    accessRevision,
    policyRevision,
  } = session;
  const scope = {
    connectionId,
    expectedScope: {
      userId,
      tenant,
      profileId,
      accessRevision,
      policyRevision,
    },
    kind,
  };
  let revision: string | null | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let blocked = false;
  /** 이어지는 입력은 직전 확정 revision을 사용하며 실패 후에는 다시 열어 검토합니다. */
  function serial<R>(operation: () => Promise<R>): Promise<R> {
    const task = queue.then(operation);
    queue = task.catch((): void => {});
    return task;
  }
  return {
    load: (): Promise<T | null> =>
      serial(async (): Promise<T | null> => {
        const data = accepted(
          await bridge().execute({ ...scope, operation: 'list' }),
        );
        const entry = data.entries.find(
          (value: (typeof data.entries)[number]): boolean => value.key === key,
        );
        const decoded = entry ? decode(JSON.parse(entry.payload)) : null;
        revision = entry?.revision ?? null;
        blocked = false;
        return decoded;
      }),
    save: (value: T): Promise<void> => {
      // 호출 당시 값 전체를 캡처하여 후속 입력의 참조 변경을 섞지 않습니다.
      const payload = JSON.stringify(value);
      return serial(async (): Promise<void> => {
        if (blocked || revision === undefined)
          throw new Error(
            '복구 자료의 기준을 먼저 확인해 주세요. 현재 입력은 메모리에 남아 있습니다.',
          );
        try {
          const data = accepted(
            await bridge().execute({
              ...scope,
              operation: 'put',
              key,
              payload,
              expectedRevision: revision,
            }),
          );
          const saved = data.entries.find(
            (entry: (typeof data.entries)[number]): boolean =>
              entry.key === key,
          );
          if (!saved) throw new Error('복구 저장의 확인 응답이 없습니다.');
          revision = saved.revision;
          if (data.cleanupWarningCount)
            throw new Error(
              '복구 저장은 완료했지만 파일 정리/내구성 확인 경고가 있습니다. 저장을 반복하지 마세요.',
            );
        } catch (error: unknown) {
          blocked = true;
          throw error;
        }
      });
    },
    remove: (): Promise<void> =>
      serial(async (): Promise<void> => {
        if (blocked || revision === undefined)
          throw new Error('삭제할 복구 자료를 먼저 확인해 주세요.');
        if (revision === null) return;
        accepted(
          await bridge().execute({
            ...scope,
            operation: 'remove',
            key,
            expectedRevision: revision,
          }),
        );
        revision = null;
      }),
  };
}

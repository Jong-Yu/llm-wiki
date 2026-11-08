import { createHash, randomUUID } from 'node:crypto';
import { recoveryEntrySchema } from '@contracts/recovery.contract';
import type {
  RecoveryEntry,
  RecoveryKind,
  RecoveryResult,
} from '@contracts/recovery.contract';
import type { RecoveryScope } from '@main/backend/ProtectedRecoveryStore';
import type { RecoveryStore } from '@main/backend/RecoveryService';

type MemoryScope = { identity: string; entries: RecoveryEntry[] };
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 128;

/** 현재 사용자·접근 판본·관점이 같은 메모리 자료만 다시 찾습니다. */
function scopeKey(scope: RecoveryScope): string {
  return JSON.stringify([
    scope.serverUrl,
    scope.userId,
    scope.tenant,
    scope.accessRevision ?? scope.policyRevision,
    scope.profileId,
    scope.domain,
    scope.viewpoint,
  ]);
}

/** 로그아웃은 같은 서버·사용자의 모든 관점에서 보관한 임시 초안을 비웁니다. */
function identityKey(scope: RecoveryScope): string {
  return JSON.stringify([scope.serverUrl, scope.userId]);
}

/** 호출자가 내부 entry 배열을 변경하지 못하도록 복사합니다. */
function success(entries: RecoveryEntry[]): RecoveryResult {
  return {
    ok: true,
    data: {
      entries: entries.map((entry: RecoveryEntry): RecoveryEntry => ({
        ...entry,
      })),
      cleanupWarningCount: 0,
    },
  };
}

/** 시험 서버의 내부 상태나 사용자 본문을 오류에 반사하지 않습니다. */
function failure(code: string): RecoveryResult {
  return {
    ok: false,
    error: {
      code,
      message: `웹 시험의 임시 복구 자료를 처리하지 못했습니다 (${code}). 현재 입력과 연결을 확인해 주세요.`,
    },
  };
}

/** 브라우저 새로고침만 지원하며 서버 종료 시 사라지는 한정된 메모리 복구 저장소입니다. */
export class WebMemoryRecoveryStore implements RecoveryStore {
  readonly #scopes = new Map<string, MemoryScope>();

  /** 디스크·브라우저 저장소에 본문이나 인증 정보를 쓰지 않습니다. */
  clear(): void {
    this.#scopes.clear();
  }

  /** 현재 범위를 확인한 뒤 요청한 종류의 불변 복사본만 반환합니다. */
  async list(
    scope: RecoveryScope,
    kind: RecoveryKind,
    current: () => boolean,
  ): Promise<RecoveryResult> {
    if (!current()) return failure('scope_changed');
    const entries = this.#scopes.get(scopeKey(scope))?.entries ?? [];
    return success(
      entries.filter((entry: RecoveryEntry): boolean => entry.kind === kind),
    );
  }

  /** 같은 메모리 판본에만 반영하며 동기 임계 구간 안에서 크기·범위를 재확인합니다. */
  async put(
    scope: RecoveryScope,
    kind: RecoveryKind,
    key: string,
    payload: string | null,
    expectedRevision: string | null,
    current: () => boolean,
  ): Promise<RecoveryResult> {
    if (!current()) return failure('scope_changed');
    const address = scopeKey(scope);
    const entries = this.#scopes.get(address)?.entries ?? [];
    const prior = entries.find(
      (entry: RecoveryEntry): boolean =>
        entry.kind === kind && entry.key === key,
    );
    if ((prior?.revision ?? null) !== expectedRevision)
      return failure('recovery_conflict');
    const next = entries.filter(
      (entry: RecoveryEntry): boolean => entry !== prior,
    );
    const changedEntries: RecoveryEntry[] = [];
    if (payload !== null) {
      const parsed = recoveryEntrySchema.safeParse({
        kind,
        key,
        payload,
        revision: createHash('sha256')
          .update(`${randomUUID()}:${payload}`)
          .digest('hex'),
        savedAt: new Date().toISOString(),
      });
      if (!parsed.success) return failure('invalid_request');
      changedEntries.push(parsed.data);
      next.push(parsed.data);
    }
    if (next.length > MAX_ENTRIES) return failure('recovery_too_large');
    let total = Buffer.byteLength(JSON.stringify(next));
    for (const [otherAddress, otherScope] of this.#scopes)
      if (otherAddress !== address)
        total += Buffer.byteLength(JSON.stringify(otherScope.entries));
    if (total > MAX_BYTES - 1024) return failure('recovery_too_large');
    if (!current()) return failure('scope_changed');
    this.#scopes.set(address, {
      identity: identityKey(scope),
      entries: next,
    });
    return success(changedEntries);
  }

  /** 로그아웃 확인 뒤 해당 사용자의 메모리 자료만 제거합니다. */
  async forgetIdentity(
    scope: RecoveryScope,
    current: () => boolean,
  ): Promise<RecoveryResult> {
    if (!current()) return failure('scope_changed');
    const identity = identityKey(scope);
    for (const [address, value] of this.#scopes)
      if (value.identity === identity) this.#scopes.delete(address);
    return success([]);
  }
}

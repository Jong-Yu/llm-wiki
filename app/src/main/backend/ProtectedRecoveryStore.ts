import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConnectionCipher } from './ProtectedConnectionStore';
import { recoveryEntrySchema } from '@contracts/recovery.contract';
import type {
  RecoveryEntry,
  RecoveryKind,
  RecoveryResult,
} from '@contracts/recovery.contract';

export type RecoveryScope = {
  serverUrl: string;
  userId: string;
  tenant: string;
  profileId: string;
  policyRevision: string;
  accessRevision?: string;
  domain: string | null;
  viewpoint: string | null;
};
const fileSchema = z.strictObject({
  version: z.literal(1),
  scope: z.strictObject({
    serverUrl: z.string(),
    userId: z.string(),
    tenant: z.string(),
    profileId: z.string(),
    policyRevision: z.string(),
    accessRevision: z.string().min(1).optional(),
    domain: z.string().nullable(),
    viewpoint: z.string().nullable(),
  }),
  entries: z.array(recoveryEntrySchema).max(128),
  legacySource: z
    .strictObject({
      policyRevision: z.string(),
      entriesHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});
const MAX_BYTES = 32 * 1024 * 1024;
/** 경로·암호문·본문을 예외 출력에 포함하지 않습니다. */
class RecoveryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
/** 파일 시스템 오류에서는 코드만 사용합니다. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
/** 파일 이름에는 안정된 식별자의 hash만 사용합니다. */
function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
/** 권한·정책·관점 의미가 같은 자료만 재발견합니다. */
function scopeKey(scope: RecoveryScope): string {
  return JSON.stringify([
    scope.serverUrl,
    scope.userId,
    scope.tenant,
    scope.profileId,
    scope.accessRevision ?? scope.policyRevision,
    scope.domain,
    scope.viewpoint,
  ]);
}
/** 저장 성공과 임시 파일 정리 경고를 구별합니다. */
function success(
  entries: RecoveryEntry[],
  cleanupWarningCount: number = 0,
): RecoveryResult {
  return { ok: true, data: { entries, cleanupWarningCount } };
}
/** OS 보호 저장 외에는 평문 fallback 없이 실패합니다. */
export class ProtectedRecoveryStore {
  #queue: Promise<unknown> = Promise.resolve();
  #legacySources = new Map<
    string,
    { policyRevision: string; entriesHash: string }
  >();
  readonly directory: string;
  readonly cipher: ConnectionCipher;
  constructor(directory: string, cipher: ConnectionCipher) {
    this.directory = directory;
    this.cipher = cipher;
  }
  /** 같은 앱의 연속 입력은 순서대로 저장하며 다른 앱은 디스크 CAS로 검사합니다. */
  #serial(operation: () => Promise<RecoveryResult>): Promise<RecoveryResult> {
    const task = this.#queue.then(async (): Promise<RecoveryResult> => {
      try {
        return await operation();
      } catch (error: unknown) {
        const code =
          error instanceof RecoveryError ? error.code : 'recovery_write_failed';
        return {
          ok: false,
          error: {
            code,
            message: `로컬 복구 자료를 처리하지 못했습니다 (${code}). 기존 파일과 현재 입력을 보존했습니다.`,
          },
        };
      }
    });
    this.#queue = task;
    return task;
  }
  /** 보호 경계의 디렉터리·소유권을 확인하고 기존 권한을 바꾸지 않습니다. */
  async #directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new RecoveryError('recovery_unsafe_path');
  }
  /** 인증 주체별 디렉터리 안에서 정책·공간별 파일을 분리합니다. */
  async #paths(
    scope: RecoveryScope,
    requireProtection: boolean = true,
  ): Promise<{ directory: string; path: string }> {
    if (requireProtection) {
      const availability = await this.cipher.availability();
      if (availability.availability !== 'protected')
        throw new RecoveryError('recovery_unavailable');
    }
    await this.#directory(this.directory);
    const directory = join(
      this.directory,
      hash(JSON.stringify([scope.serverUrl, scope.userId])),
    );
    await this.#directory(directory);
    return { directory, path: join(directory, `${hash(scopeKey(scope))}.bin`) };
  }
  /** 손상·치환·링크·과도한 크기를 거부하고 원본 암호문은 그대로 둡니다. */
  async #read(path: string, scope: RecoveryScope): Promise<RecoveryEntry[]> {
    try {
      const before = await lstat(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > MAX_BYTES ||
        (process.platform !== 'win32' &&
          ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))
      )
        throw new RecoveryError('recovery_corrupt');
      const file = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let bytes: Buffer;
      try {
        const after = await file.stat();
        if (
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          after.size > MAX_BYTES ||
          after.nlink !== 1
        )
          throw new RecoveryError('recovery_conflict');
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) throw new RecoveryError('recovery_corrupt');
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      const parsed = fileSchema.parse(
        JSON.parse(await this.cipher.decrypt(bytes)),
      );
      if (
        scopeKey(parsed.scope) !== scopeKey(scope) ||
        new Set(
          parsed.entries.map(
            (entry: RecoveryEntry): string => `${entry.kind}:${entry.key}`,
          ),
        ).size !== parsed.entries.length
      )
        throw new RecoveryError('recovery_corrupt');
      if (parsed.legacySource) {
        if (!scope.accessRevision) throw new RecoveryError('recovery_corrupt');
        const legacyScope = {
          ...scope,
          accessRevision: undefined,
          policyRevision: parsed.legacySource.policyRevision,
        };
        const legacy = await this.#paths(legacyScope);
        const entries = await this.#read(legacy.path, legacyScope);
        if (hash(JSON.stringify(entries)) !== parsed.legacySource.entriesHash)
          throw new RecoveryError('recovery_conflict');
        this.#legacySources.set(path, parsed.legacySource);
      } else this.#legacySources.delete(path);
      return parsed.entries;
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return [];
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError('recovery_corrupt');
    }
  }
  /** 새 기준의 파일이 없을 때만 같은 감사 기준의 구 파일을 읽고 후속 변경 충돌을 추적합니다. */
  async #readCompatible(
    path: string,
    scope: RecoveryScope,
  ): Promise<RecoveryEntry[]> {
    try {
      await lstat(path);
      return await this.#read(path, scope);
    } catch (error: unknown) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    this.#legacySources.delete(path);
    if (!scope.accessRevision) return [];
    const legacyScope = { ...scope, accessRevision: undefined };
    const legacy = await this.#paths(legacyScope);
    try {
      await lstat(legacy.path);
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const entries = await this.#read(legacy.path, legacyScope);
    this.#legacySources.set(path, {
      policyRevision: scope.policyRevision,
      entriesHash: hash(JSON.stringify(entries)),
    });
    return entries;
  }
  /** 읽기에는 저장 잠금이 남아 있어도 마지막 확정 파일만 사용합니다. */
  list(
    scope: RecoveryScope,
    kind: RecoveryKind,
    current: () => boolean,
  ): Promise<RecoveryResult> {
    return this.#serial(async (): Promise<RecoveryResult> => {
      const { path } = await this.#paths(scope);
      const entries = await this.#readCompatible(path, scope);
      if (!current()) throw new RecoveryError('scope_changed');
      return success(
        entries.filter((entry: RecoveryEntry): boolean => entry.kind === kind),
      );
    });
  }
  /** 오래된 프로세스의 잠금은 추측해 지우지 않으며 다른 앱과의 충돌을 노출합니다. */
  async #locked(
    directory: string,
    action: () => Promise<RecoveryResult>,
  ): Promise<RecoveryResult> {
    const lockPath = join(directory, 'records.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error: unknown) {
      if (hasCode(error, 'EEXIST')) throw new RecoveryError('recovery_busy');
      throw error;
    }
    let result: RecoveryResult | undefined;
    let cleanup = 0;
    try {
      result = await action();
    } finally {
      try {
        await lock.close();
      } catch {
        cleanup += 1;
      }
      try {
        await unlink(lockPath);
      } catch {
        cleanup += 1;
      }
    }
    if (result.ok) result.data.cleanupWarningCount += cleanup;
    return result;
  }
  /** 읽었던 entry revision에만 암호화·fsync·원자 교체를 적용합니다. */
  put(
    scope: RecoveryScope,
    kind: RecoveryKind,
    key: string,
    payload: string | null,
    expectedRevision: string | null,
    current: () => boolean,
  ): Promise<RecoveryResult> {
    return this.#serial(async (): Promise<RecoveryResult> => {
      const { directory, path } = await this.#paths(scope);
      return this.#locked(directory, async (): Promise<RecoveryResult> => {
        const entries = await this.#readCompatible(path, scope);
        const prior = entries.find(
          (entry: RecoveryEntry): boolean =>
            entry.kind === kind && entry.key === key,
        );
        if ((prior?.revision ?? null) !== expectedRevision)
          throw new RecoveryError('recovery_conflict');
        const next = entries.filter(
          (entry: RecoveryEntry): boolean => entry !== prior,
        );
        let entry: RecoveryEntry | undefined;
        if (payload !== null) {
          entry = recoveryEntrySchema.parse({
            kind,
            key,
            payload,
            revision: hash(`${randomUUID()}:${payload}`),
            savedAt: new Date().toISOString(),
          });
          next.push(entry);
        }
        const plain = JSON.stringify(
          fileSchema.parse({
            version: 1,
            scope,
            entries: next,
            ...(this.#legacySources.has(path)
              ? { legacySource: this.#legacySources.get(path) }
              : {}),
          }),
        );
        if (Buffer.byteLength(plain) > MAX_BYTES - 1024)
          throw new RecoveryError('recovery_too_large');
        const encrypted = await this.cipher.encrypt(plain);
        if (!encrypted.length || encrypted.length > MAX_BYTES)
          throw new RecoveryError('recovery_too_large');
        const temporary = join(directory, `.recovery-${randomUUID()}.tmp`);
        let committed = false;
        let cleanupWarningCount = 0;
        try {
          const file = await open(temporary, 'wx', 0o600);
          try {
            await file.writeFile(encrypted);
            await file.sync();
          } finally {
            await file.close();
          }
          if (!current()) throw new RecoveryError('scope_changed');
          await rename(temporary, path);
          committed = true;
          // rename 이후 fsync 실패는 저장 완료와 내구성 경고로 구분합니다.
          if (process.platform !== 'win32') {
            try {
              const dir = await open(directory, 'r');
              try {
                await dir.sync();
              } finally {
                await dir.close();
              }
            } catch {
              cleanupWarningCount += 1;
            }
          }
        } finally {
          if (!committed) {
            try {
              await unlink(temporary);
            } catch (error: unknown) {
              if (!hasCode(error, 'ENOENT')) cleanupWarningCount += 1;
            }
          }
        }
        return success(entry ? [entry] : [], cleanupWarningCount);
      });
    });
  }
  /** 명시 로그아웃만 현재 서버·주체의 모든 로컬 복구 파일을 삭제합니다. */
  forgetIdentity(
    scope: RecoveryScope,
    current: () => boolean,
  ): Promise<RecoveryResult> {
    return this.#serial(async (): Promise<RecoveryResult> => {
      const { directory } = await this.#paths(scope, false);
      return this.#locked(directory, async (): Promise<RecoveryResult> => {
        if (!current()) throw new RecoveryError('scope_changed');
        const files = await readdir(directory);
        let deleted = 0;
        for (const file of files) {
          if (!/^[a-f0-9]{64}\.bin$/.test(file)) continue;
          try {
            if (!current()) throw new RecoveryError('scope_changed');
            await unlink(join(directory, file));
            deleted += 1;
          } catch {
            return {
              ok: false,
              error: {
                code: 'recovery_delete_incomplete',
                message: `로컬 복구 파일 ${deleted}개를 삭제한 뒤 중단되었습니다. 남은 파일은 보존되어 있으며 삭제 완료로 처리하지 않았습니다.`,
              },
            };
          }
        }
        return success([]);
      });
    });
  }
}

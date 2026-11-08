import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ConnectionProtection } from '@contracts/connection.contract';

const savedConnectionSchema = z
  .object({
    version: z.literal(1),
    serverUrl: z.string().min(1).max(2048),
    token: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/),
    userId: z.string().min(1).max(4096),
    policyRevision: z.string().min(1).max(4096),
    accessRevision: z.string().min(1).max(4096).optional(),
    displayName: z.string().min(1).max(160).optional(),
    selection: z
      .object({
        tenant: z.string().min(1).max(4096),
        profile: z.string().min(1).max(4096),
        domain: z.string().max(4096).nullable(),
        viewpoint: z.string().max(4096).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** 원문 인증정보를 포함하므로 main 전용 저장 모듈 밖으로 직렬화하지 않습니다. */
export type SavedConnection = z.infer<typeof savedConnectionSchema>;
type ProtectionIssue = ConnectionProtection['issue'];
type Availability = Pick<ConnectionProtection, 'availability' | 'backend'>;
export type ConnectionCipher = {
  availability: () => Promise<Availability>;
  encrypt: (plainText: string) => Promise<Buffer>;
  decrypt: (encrypted: Buffer) => Promise<string>;
};
type LoadResult = { ok: true; entry: SavedConnection | null } | { ok: false };
const MAX_BYTES = 128 * 1024;

/** 원래 예외에 포함될 수 있는 경로·암호문·비밀을 외부로 전달하지 않습니다. */
class ProtectionError extends Error {
  readonly issue: ProtectionIssue;
  constructor(issue: ProtectionIssue) {
    super(issue);
    this.issue = issue;
  }
}

/** 운영체제 파일 오류의 코드만 판별합니다. */
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** 저장된 암호문 전체의 기준 버전을 계산합니다. */
function revision(bytes: Buffer | null): string | null {
  return bytes === null
    ? null
    : createHash('sha256').update(bytes).digest('hex');
}

/** 암호화 전용 파일을 CAS와 배타 잠금으로 교체하며 손상된 기존 파일은 보존합니다. */
export class ProtectedConnectionStore {
  readonly #directory: string;
  readonly #cipher: ConnectionCipher;
  #revision: string | null | undefined;
  #writable = false;
  #availability: Availability = {
    availability: 'session_only',
    backend: 'unavailable',
  };
  #issue: ProtectionIssue = 'none';
  #queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, cipher: ConnectionCipher) {
    this.#directory = directory;
    this.#cipher = cipher;
  }

  /** 파일 경로나 저장 본문 없이 진단용 상태만 복사합니다. */
  status(): ConnectionProtection {
    return {
      ...this.#availability,
      saved: typeof this.#revision === 'string',
      remembered: false,
      issue: this.#issue,
    };
  }

  /** 한 인스턴스의 저장·삭제·읽기를 순서대로 완료합니다. */
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch((): void => {});
    return result;
  }

  /** main이 정한 디렉터리의 symlink·권한 오류를 복구 명목으로 바꾸지 않습니다. */
  async #prepare(): Promise<void> {
    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    const info = await lstat(this.#directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    )
      throw new ProtectionError('storage_unavailable');
  }

  /** 일반 파일 하나만 제한된 크기로 읽고 symlink·hardlink·느슨한 권한은 거부합니다. */
  async #bytes(): Promise<Buffer | null> {
    const path = join(this.#directory, 'selected.bin');
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
        throw new ProtectionError('storage_corrupt');
      const file = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const after = await file.stat();
        if (
          after.ino !== before.ino ||
          after.dev !== before.dev ||
          after.size > MAX_BYTES ||
          after.nlink !== 1
        )
          throw new ProtectionError('storage_changed');
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_BYTES) throw new ProtectionError('storage_corrupt');
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    } catch (error: unknown) {
      if (hasCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  /** 보호 저장소가 실제 사용 가능할 때만 암호화·복호화를 허용합니다. */
  async #available(): Promise<boolean> {
    try {
      this.#availability = await this.#cipher.availability();
    } catch {
      this.#availability = {
        availability: 'session_only',
        backend: 'unavailable',
      };
    }
    return this.#availability.availability === 'protected';
  }

  /** 고정 오류 코드로만 실패를 보존합니다. */
  #failed(error: unknown, fallback: ProtectionIssue): void {
    this.#issue = error instanceof ProtectionError ? error.issue : fallback;
  }

  /** 기존 파일을 검사하며 실패해도 삭제·재생성하지 않습니다. */
  load(): Promise<LoadResult> {
    return this.#serial(async (): Promise<LoadResult> => {
      this.#issue = 'none';
      this.#writable = false;
      try {
        await this.#prepare();
        const bytes = await this.#bytes();
        this.#revision = revision(bytes);
        if (!(await this.#available())) {
          this.#issue = 'storage_unavailable';
          return { ok: false };
        }
        if (bytes === null) {
          this.#writable = true;
          return { ok: true, entry: null };
        }
        const text = await this.#cipher.decrypt(bytes);
        const parsed: unknown = JSON.parse(text);
        const entry = savedConnectionSchema.parse(parsed);
        this.#writable = true;
        return { ok: true, entry };
      } catch (error: unknown) {
        this.#failed(error, 'storage_corrupt');
        return { ok: false };
      }
    });
  }

  /** 배타 잠금 아래 읽었던 암호문과 같은 파일에만 변경을 적용합니다. */
  async #mutate(bytes: Buffer | null, current: () => boolean): Promise<void> {
    await this.#prepare();
    const lockPath = join(this.#directory, 'selected.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error: unknown) {
      if (hasCode(error, 'EEXIST')) throw new ProtectionError('storage_busy');
      throw error;
    }
    let temporary: string | null = null;
    try {
      if (
        this.#revision === undefined ||
        revision(await this.#bytes()) !== this.#revision
      )
        throw new ProtectionError('storage_changed');
      if (!current()) return;
      if (bytes === null) {
        if (this.#revision !== null)
          await unlink(join(this.#directory, 'selected.bin'));
      } else {
        temporary = join(this.#directory, `.selected-${randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        // 암호화·fsync 대기 중 연결이 바뀌었다면 이전 저장을 확정하지 않습니다.
        if (!current()) return;
        await rename(temporary, join(this.#directory, 'selected.bin'));
        temporary = null;
      }
      this.#revision = revision(bytes);
      this.#writable = true;
      this.#issue = 'none';
    } finally {
      try {
        if (temporary) await unlink(temporary);
      } finally {
        try {
          await lock.close();
        } finally {
          await unlink(lockPath);
        }
      }
    }
  }

  /** 검사된 연결 전체를 암호화한 뒤에만 디스크에 씁니다. */
  save(entry: SavedConnection, current: () => boolean): Promise<boolean> {
    return this.#serial(async (): Promise<boolean> => {
      try {
        if (!current()) return false;
        if (!(await this.#available()))
          throw new ProtectionError('storage_unavailable');
        if (!this.#writable) throw new ProtectionError('storage_corrupt');
        const bytes = await this.#cipher.encrypt(
          JSON.stringify(savedConnectionSchema.parse(entry)),
        );
        if (!bytes.length || bytes.length > MAX_BYTES)
          throw new ProtectionError('storage_write_failed');
        await this.#mutate(bytes, current);
        return current() && this.#issue === 'none';
      } catch (error: unknown) {
        this.#failed(error, 'storage_write_failed');
        return false;
      }
    });
  }

  /** 명시 삭제만 허용하며 복호화가 불가능해도 확인한 암호문 기준을 유지합니다. */
  forget(current: () => boolean): Promise<boolean> {
    return this.#serial(async (): Promise<boolean> => {
      try {
        await this.#mutate(null, current);
        return current() && this.#issue === 'none';
      } catch (error: unknown) {
        this.#failed(error, 'storage_write_failed');
        return false;
      }
    });
  }
}

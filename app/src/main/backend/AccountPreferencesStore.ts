import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const preferencesSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().min(1).max(160),
  serverUrl: z.string().min(1).max(2048),
  autoRestore: z.boolean(),
});
export type AccountPreferences = z.infer<typeof preferencesSchema>;

/** 이름·주소와 자동 복원 허용만 저장합니다. 토큰은 이 파일에 들어갈 수 없습니다. */
export class AccountPreferencesStore {
  #queue: Promise<unknown> = Promise.resolve();
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }

  /** 손상·링크 파일은 덮어쓰지 않고 복원을 차단합니다. */
  async load(): Promise<AccountPreferences | null> {
    try {
      const directory = await lstat(this.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.platform !== 'win32' &&
          ((directory.mode & 0o077) !== 0 ||
            directory.uid !== process.getuid?.()))
      )
        throw new Error('account_storage_unavailable');
      const path = join(this.directory, 'account.json');
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 8192 ||
        (process.platform !== 'win32' &&
          ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
      )
        throw new Error('account_storage_unavailable');
      const file = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const after = await file.stat();
        if (
          after.ino !== info.ino ||
          after.dev !== info.dev ||
          after.size > 8192
        )
          throw new Error('account_storage_changed');
        const bytes = Buffer.alloc(8193);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 8192) throw new Error('account_storage_unavailable');
        return preferencesSchema.parse(
          JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')),
        );
      } finally {
        await file.close();
      }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw new Error('account_storage_unavailable');
    }
  }

  /** 로그아웃 차단 기록을 원자적으로 확정하고 늦은 로그인 저장은 버립니다. */
  save(entry: AccountPreferences, current: () => boolean): Promise<boolean> {
    const task = this.#queue.then(async (): Promise<boolean> => {
      let temporary: string | null = null;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const info = await lstat(this.directory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (process.platform !== 'win32' &&
            ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
        )
          return false;
        await this.load();
        if (!current()) return false;
        temporary = join(this.directory, `.account-${randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(JSON.stringify(preferencesSchema.parse(entry)));
          await file.sync();
        } finally {
          await file.close();
        }
        if (!current()) return false;
        await rename(temporary, join(this.directory, 'account.json'));
        temporary = null;
        if (process.platform !== 'win32') {
          const directory = await open(this.directory, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        return true;
      } catch {
        return false;
      } finally {
        if (temporary) await unlink(temporary).catch((): void => {});
      }
    });
    this.#queue = task;
    return task;
  }
}

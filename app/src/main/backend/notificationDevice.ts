import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { z } from 'zod';

const deviceSchema = z.strictObject({
  deviceId: z.string().regex(/^[a-f0-9]{32}$/),
  deviceName: z.string().min(1).max(80),
});
export type NotificationDevice = z.infer<typeof deviceSchema>;
/** 재시작해도 같은 PC가 되도록 비밀 없는 기기 식별자를 원자적으로 최초 보관합니다. */
export async function loadNotificationDevice(
  path: string,
): Promise<NotificationDevice> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return deviceSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const device = {
    deviceId: randomUUID().replaceAll('-', ''),
    deviceName: hostname().slice(0, 80) || '내 PC',
  };
  try {
    await writeFile(path, JSON.stringify(device), { flag: 'wx', mode: 0o600 });
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
    return deviceSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  return device;
}

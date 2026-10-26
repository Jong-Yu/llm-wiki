import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export type PersonalRuntime = { projectRoot: string; python: string };
export type PrivateExecution = {
  directory: string;
  tokenFile: string;
  workDirectory: string;
  cleanupAuth: () => Promise<void>;
};
const ownedProcesses = new WeakSet<ChildProcess>();
const closedProcesses = new WeakSet<ChildProcess>();
const stoppingProcesses = new WeakMap<ChildProcess, Promise<void>>();
const readyRuntimes = new Set<string>();
const capabilitiesSchema = z.object({
  private_files: z.literal(true),
  process_tree: z.literal(true),
  platform: z.literal('win32'),
  mechanism: z.literal('windows_job_and_dacl'),
});
const runtimeProbeSchema = capabilitiesSchema.extend({
  runtime_ready: z.literal(true),
  probe: z.literal('private_file_and_process_tree'),
});
const preparationSchema = capabilitiesSchema.extend({
  probe: z.literal('job_assignment_and_private_file'),
});

/** 보호 도우미의 제한된 JSON만 읽고 원문 오류나 비밀을 호출자에게 전달하지 않습니다. */
async function bridgeJson(
  runtime: PersonalRuntime,
  args: string[],
  input?: string,
): Promise<unknown> {
  const child = spawn(
    runtime.python,
    ['-B', '-m', 'core.runtime.desktop_bridge', ...args],
    {
      cwd: runtime.projectRoot,
      env: personalEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return new Promise<unknown>(
    (done: (value: unknown) => void, fail: (error: Error) => void): void => {
      let output = '';
      let rejected = false;
      const timer = setTimeout((): void => {
        rejected = true;
        child.kill('SIGKILL');
      }, 10_000);
      child.stdout.on('data', (chunk: Buffer): void => {
        if (output.length + chunk.length > 16384) {
          rejected = true;
          child.kill('SIGKILL');
        } else output += chunk.toString('utf8');
      });
      child.stderr.resume();
      child.stdin.on('error', (): void => {});
      child.on('error', (): void => {
        clearTimeout(timer);
        fail(new Error('private_runtime_unavailable'));
      });
      child.on('close', (code: number | null): void => {
        clearTimeout(timer);
        if (rejected || code !== 0) {
          fail(new Error('private_runtime_unavailable'));
          return;
        }
        try {
          done(JSON.parse(output));
        } catch {
          fail(new Error('private_runtime_invalid'));
        }
      });
      child.stdin.end(input);
    },
  );
}

/** 현재 Windows의 실제 파일/Job 검사를 요구하며 별도 앱 배포 인증과 구분합니다. */
export async function assertPersonalRuntime(
  runtime: PersonalRuntime,
): Promise<void> {
  if (process.platform !== 'win32') return;
  const result = z
    .object({ ok: z.literal(true), capabilities: runtimeProbeSchema })
    .safeParse(await bridgeJson(runtime, ['probe']));
  if (!result.success) throw new Error('windows_runtime_unverified');
}

/** 비밀은 argv/env에 넣지 않고 실행에 필요한 위치·언어 설정만 전달합니다. */
export function personalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowed = new Set([
    'PATH',
    'HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'XDG_CONFIG_HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TESSDATA_PREFIX',
  ]);
  for (const [name, value] of Object.entries(process.env))
    if (allowed.has(name.toUpperCase()) && value !== undefined)
      environment[name] = value;
  environment.PYTHONUNBUFFERED = '1';
  environment.PYTHONUTF8 = '1';
  return environment;
}

/** 기존 경로의 공개 권한을 조용히 고치거나 symlink를 따라 비밀을 쓰지 않습니다. */
async function privatePosixRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  let ancestor = absolute;
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('unsafe_private_path');
    } catch (error: unknown) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error('private_directory_required');
  return realpath(absolute);
}

/** 실행별 작업 자료는 보존하고 이번 생성한 인증 디렉터리만 삭제합니다. */
export async function createPrivateExecution(
  runtime: PersonalRuntime,
  privateRoot: string,
  token: string,
): Promise<PrivateExecution> {
  if (process.platform === 'win32') {
    await assertPersonalRuntime(runtime);
    const name = `exec-${randomUUID()}`;
    const directory = resolve(privateRoot, name);
    const auth = join(directory, 'auth');
    try {
      const result = z
        .object({
          ok: z.literal(true),
          directory: z.string(),
          token_file: z.string(),
          work_directory: z.string(),
          capabilities: preparationSchema,
        })
        .parse(
          await bridgeJson(
            runtime,
            ['prepare', '--root', privateRoot, '--name', name],
            token,
          ),
        );
      if (
        resolve(result.directory) !== directory ||
        resolve(result.token_file) !== join(auth, 'token') ||
        resolve(result.work_directory) !== join(directory, 'work')
      )
        throw new Error('private_runtime_path_mismatch');
      readyRuntimes.add(JSON.stringify(runtime));
      return {
        directory,
        tokenFile: result.token_file,
        workDirectory: result.work_directory,
        cleanupAuth: async (): Promise<void> => {
          await rm(auth, { recursive: true, force: true });
        },
      };
    } catch (error: unknown) {
      // 실패해도 이번 요청의 인증 경로만 정리하며 작업 자료나 기존 디렉터리를 지우지 않습니다.
      await rm(auth, { recursive: true, force: true }).catch((): void => {});
      throw error;
    }
  }
  const root = await privatePosixRoot(privateRoot);
  const directory = await mkdtemp(join(root, 'exec-'));
  const auth = join(directory, 'auth');
  const tokenFile = join(auth, 'token');
  const workDirectory = join(directory, 'work');
  try {
    await mkdir(auth, { mode: 0o700 });
    await mkdir(workDirectory, { mode: 0o700 });
    await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    await rm(auth, { recursive: true, force: true }).catch((): void => {});
    throw error;
  }
  return {
    directory,
    tokenFile,
    workDirectory,
    cleanupAuth: async (): Promise<void> => {
      await rm(auth, { recursive: true, force: true });
    },
  };
}

/** main이 생성한 프로세스만 독립 그룹으로 등록합니다. 셸 명령이나 임의 PID는 받지 않습니다. */
export function spawnPersonalProcess(
  runtime: PersonalRuntime,
  args: string[],
): ChildProcess {
  if (
    process.platform === 'win32' &&
    !readyRuntimes.has(JSON.stringify(runtime))
  )
    throw new Error('windows_runtime_unverified');
  const command =
    process.platform === 'win32'
      ? [
          '-B',
          '-m',
          'core.runtime.desktop_bridge',
          'launch',
          '--parent-pid',
          String(process.pid),
          '--',
          ...args,
        ]
      : args;
  const child = spawn(runtime.python, command, {
    cwd: runtime.projectRoot,
    env: personalEnvironment(),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  ownedProcesses.add(child);
  child.once('close', (): void => {
    closedProcesses.add(child);
  });
  child.stdin?.on('error', (): void => {});
  return child;
}

/** 종료된 PID를 재사용하지 않으며 이 helper가 시작한 그룹에만 신호를 보냅니다. */
function signalOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (
    !ownedProcesses.has(child) ||
    closedProcesses.has(child) ||
    (process.platform === 'win32' &&
      (child.exitCode !== null || child.signalCode !== null))
  )
    return;
  try {
    if (process.platform !== 'win32' && child.pid)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* 이미 종료한 프로세스에는 다시 신호를 보내지 않습니다. */
  }
}

/** 협력 취소 후 제한 시간 안에 자기 프로세스 트리를 회수하며 중복 취소는 하나로 합칩니다. */
export function stopPersonalProcess(
  child: ChildProcess,
  closed: Promise<void>,
  graceMs: number = 10_000,
): Promise<void> {
  const existing = stoppingProcesses.get(child);
  if (existing) return existing;
  if (!ownedProcesses.has(child))
    return Promise.reject(new Error('unowned_process'));
  const stopping = (async (): Promise<void> => {
    if (child.stdin?.writable) {
      child.stdin.write(
        '{"type":"cancel"}\n',
        (error: Error | null | undefined): void => {
          if (error) signalOwned(child, 'SIGTERM');
        },
      );
    } else signalOwned(child, 'SIGTERM');
    // stdin은 감독 프로세스의 부모 수명 통로이므로 취소 직후 닫지 않습니다.
    const timer = setTimeout(
      (): void => signalOwned(child, 'SIGKILL'),
      graceMs,
    );
    timer.unref();
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  })();
  stoppingProcesses.set(child, stopping);
  return stopping;
}

import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type { AiProvider } from '@contracts/runtime.contract';

export type CliLoginResult = {
  status: 'logged_in' | 'logged_out' | 'error';
  code?: string;
};
type CliCommand = { executable: string; arguments: string[] };
type CommandResult = { exitCode: number | null; output: string; code?: string };

/** 계정 위치만 공유하고 서버 토큰·API 키·실행 훅용 환경변수는 전달하지 않습니다. */
export function loginEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ]) {
    if (process.env[name]) result[name] = process.env[name];
  }
  return result;
}

/** 존재하는 일반 실행 파일만 후보로 사용하며 원시 파일 오류는 공개하지 않습니다. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Windows npm shim은 알려진 Node 진입점으로 바꾸고 임의 cmd 스크립트는 실행하지 않습니다. */
export async function cliCommand(
  provider: AiProvider,
  cli: string,
): Promise<CliCommand> {
  if (!isAbsolute(cli) || !(await isFile(cli)))
    throw new Error('cli_not_found');
  if (process.platform !== 'win32' || extname(cli).toLowerCase() === '.exe')
    return { executable: cli, arguments: [] };
  if (
    !['.cmd', '.ps1'].includes(extname(cli).toLowerCase()) ||
    basename(cli, extname(cli)).toLowerCase() !== provider
  )
    throw new Error('cli_native_executable_required');
  const script = join(
    dirname(cli),
    'node_modules',
    provider === 'claude'
      ? '@anthropic-ai/claude-code/cli.js'
      : '@openai/codex/bin/codex.js',
  );
  if (!(await isFile(script)))
    throw new Error('cli_native_executable_required');
  const directories = [dirname(cli)];
  for (const entry of (process.env.PATH || '').split(';')) {
    const value = entry.replace(/^"(.*)"$/, '$1');
    if (isAbsolute(value)) directories.push(value);
  }
  for (const root of [process.env.ProgramFiles, process.env.ProgramW6432])
    if (root && isAbsolute(root)) directories.push(join(root, 'nodejs'));
  for (const directory of new Set(directories)) {
    const node = join(directory, 'node.exe');
    if (await isFile(node)) return { executable: node, arguments: [script] };
  }
  throw new Error('cli_node_unavailable');
}

/** 상태 확인과 터미널 시작 결과는 제한된 코드로만 반환합니다. */
function execute(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve: (result: CommandResult) => void): void => {
    execFile(
      executable,
      args,
      {
        cwd: homedir(),
        env: environment,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        signal,
      },
      (error: ExecFileException | null, stdout: string): void => {
        if (!error) {
          resolve({ exitCode: 0, output: stdout });
          return;
        }
        const code =
          error.name === 'AbortError'
            ? 'cli_login_cancelled'
            : error.killed
              ? 'cli_login_timeout'
              : error.code === 'ENOENT'
                ? 'cli_not_found'
                : 'cli_login_check_failed';
        resolve({
          exitCode: typeof error.code === 'number' ? error.code : null,
          output: stdout,
          code,
        });
      },
    );
  });
}

/** Python이나 모델 기능 검사 없이 CLI 자신의 로그인 상태만 읽습니다. */
export async function checkCliLogin(
  provider: AiProvider,
  cli: string,
  signal?: AbortSignal,
): Promise<CliLoginResult> {
  try {
    if (signal?.aborted)
      return { status: 'error', code: 'cli_login_cancelled' };
    const command = await cliCommand(provider, cli);
    const result = await execute(
      command.executable,
      [
        ...command.arguments,
        ...(provider === 'claude' ? ['auth', 'status'] : ['login', 'status']),
      ],
      loginEnvironment(),
      signal,
    );
    if (result.exitCode !== 0 && result.exitCode !== 1)
      return { status: 'error', code: result.code || 'cli_login_check_failed' };
    if (provider === 'claude') {
      const value: unknown = JSON.parse(result.output.replace(/^\uFEFF/, ''));
      if (
        !value ||
        typeof value !== 'object' ||
        !('loggedIn' in value) ||
        typeof value.loggedIn !== 'boolean' ||
        value.loggedIn !== (result.exitCode === 0)
      )
        return { status: 'error', code: 'cli_login_status_invalid' };
      return { status: value.loggedIn ? 'logged_in' : 'logged_out' };
    }
    return { status: result.exitCode === 0 ? 'logged_in' : 'logged_out' };
  } catch (error: unknown) {
    const code =
      error instanceof Error &&
      [
        'cli_not_found',
        'cli_native_executable_required',
        'cli_node_unavailable',
      ].includes(error.message)
        ? error.message
        : 'cli_login_status_invalid';
    return { status: 'error', code };
  }
}

/** 셸에는 고정 명령과 완전히 인용한 인수만 전달합니다. */
function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** PowerShell 문자열은 작은따옴표를 이중화하며 명령 해석에 삽입하지 않습니다. */
function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 새 사용자 터미널을 열기만 하며 완료 여부는 별도 auth status로 확인합니다. */
export async function openCliLoginTerminal(
  provider: AiProvider,
  cli: string,
): Promise<void> {
  const command = await cliCommand(provider, cli);
  const environment = loginEnvironment();
  const args = [
    ...command.arguments,
    ...(provider === 'claude' ? ['auth', 'login'] : ['login']),
  ];
  if (process.platform === 'darwin') {
    const assignments = Object.entries(environment)
      .filter(
        (entry: [string, string | undefined]): entry is [string, string] =>
          entry[1] !== undefined,
      )
      .map(([key, value]: [string, string]): string =>
        quoteShell(`${key}=${value}`),
      );
    const invocation = [
      quoteShell(command.executable),
      ...args.map(quoteShell),
    ].join(' ');
    const shellCommand = `cd ${quoteShell(homedir())} && /usr/bin/env -i ${assignments.join(' ')} ${invocation}; printf '\\n위키 앱에서 로그인 완료 여부를 확인하고 있습니다. 이 창은 직접 닫아도 됩니다.\\n'`;
    const script =
      'on run argv\n tell application "Terminal"\n  do script (item 1 of argv)\n  activate\n end tell\nend run';
    const result = await execute(
      '/usr/bin/osascript',
      ['-e', script, shellCommand],
      environment,
    );
    if (result.exitCode !== 0)
      throw new Error('cli_login_terminal_unavailable');
    return;
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (!systemRoot || !isAbsolute(systemRoot))
      throw new Error('cli_login_terminal_unavailable');
    const powershell = join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const invocation = [
      quotePowerShell(command.executable),
      ...args.map(quotePowerShell),
    ].join(' ');
    const script = `Set-Location -LiteralPath ${quotePowerShell(homedir())}; & ${invocation}; Write-Host '\n위키 앱에서 로그인 완료 여부를 확인하고 있습니다. 이 창은 직접 닫아도 됩니다.'`;
    // 새 콘솔의 표준 입력은 사용자의 키보드에 연결하고 숨겨진 시작 프로세스만 기다립니다.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const launch = `Start-Process -FilePath ${quotePowerShell(powershell)} -ArgumentList '-NoLogo','-NoProfile','-NoExit','-EncodedCommand',${quotePowerShell(encoded)} -WorkingDirectory ${quotePowerShell(homedir())} -WindowStyle Normal -ErrorAction Stop`;
    const result = await execute(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(launch, 'utf16le').toString('base64'),
      ],
      environment,
    );
    if (result.exitCode !== 0)
      throw new Error('cli_login_terminal_unavailable');
    return;
  }
  throw new Error('cli_login_terminal_unsupported');
}

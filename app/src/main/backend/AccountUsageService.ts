import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type {
  AccountUsage,
  AccountUsageWindow,
} from '@contracts/aiSessions.contract';
import { personalAi, discoverAiExecutable } from './personalAi';
import type { PersonalAi } from './personalAi';
import { cliCommand, loginEnvironment } from '../settings/cliLogin';

const windowSchema = z.object({
  usedPercent: z.number().nonnegative(),
  windowDurationMins: z.number().nonnegative().nullish(),
  resetsAt: z.number().nullish(),
});
const bucketSchema = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  primary: windowSchema.nullish(),
  secondary: windowSchema.nullish(),
});
const limitsSchema = z.object({
  rateLimits: bucketSchema.nullish(),
  rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullish(),
});
const accountSchema = z.object({
  account: z
    .object({
      type: z.string(),
      email: z.string().nullish(),
      planType: z.string().nullish(),
    })
    .nullable(),
});
const rpcSchema = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

/** 제공하지 않은 값을 0으로 만들지 않고 실제 제공된 한도 창만 투영합니다. */
export function projectAccountUsage(
  accountValue: unknown,
  limitsValue: unknown,
  checkedAt: string,
): AccountUsage {
  const account = accountSchema.parse(accountValue).account;
  const limits = limitsSchema.parse(limitsValue);
  const buckets =
    limits.rateLimitsByLimitId != null
      ? Object.entries(limits.rateLimitsByLimitId)
      : limits.rateLimits
        ? [[limits.rateLimits.limitId ?? 'codex', limits.rateLimits] as const]
        : [];
  const windows: AccountUsageWindow[] = [];
  for (const [key, bucket] of buckets) {
    for (const kind of ['primary', 'secondary'] as const) {
      const value = bucket[kind];
      if (!value) continue;
      const reset =
        value.resetsAt == null ? null : new Date(value.resetsAt * 1000);
      windows.push({
        name: `${bucket.limitName ?? bucket.limitId ?? key} · ${kind === 'primary' ? '기본' : '추가'}`,
        usedPercent: value.usedPercent,
        remainingPercent: Math.max(0, 100 - value.usedPercent),
        windowMinutes: value.windowDurationMins ?? null,
        resetsAt:
          reset && Number.isFinite(reset.getTime())
            ? reset.toISOString()
            : null,
      });
    }
  }
  return {
    provider: 'codex',
    status: windows.length ? 'available' : 'unavailable',
    accountLabel: account?.email ?? account?.planType ?? null,
    checkedAt,
    stale: false,
    windows,
    message: windows.length
      ? null
      : '이 계정에서 한도 정보를 제공하지 않습니다.',
  };
}

/** 문서나 서버 인증정보를 넘기지 않고 공식 읽기 전용 RPC만 실행합니다. */
export async function readCodexAccount(cli: string): Promise<AccountUsage> {
  const command = await cliCommand('codex', cli);
  const child = spawn(
    command.executable,
    [...command.arguments, 'app-server', '--listen', 'stdio://'],
    {
      cwd: tmpdir(),
      env: loginEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  return readAccountProtocol(child);
}

/** 제한된 JSONL 응답만 읽고 오류·stderr의 계정 정보는 외부에 노출하지 않습니다. */
export function readAccountProtocol(
  child: ChildProcessWithoutNullStreams,
): Promise<AccountUsage> {
  return new Promise<AccountUsage>(
    (
      resolve: (value: AccountUsage) => void,
      reject: (error: Error) => void,
    ): void => {
      let done = false;
      let buffer = '';
      let account: unknown;
      let limits: unknown;
      let accountDone = false;
      let limitsDone = false;
      const timeout = setTimeout((): void => finish(), 12_000);
      /** 성공과 실패 모두 해당 읽기 프로세스만 정리합니다. */
      function finish(value?: AccountUsage): void {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        child.stdin.end();
        child.kill();
        const reap = setTimeout((): void => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 1500);
        reap.unref();
        child.once('close', (): void => clearTimeout(reap));
        if (value) resolve(value);
        else reject(new Error('account_usage_unavailable'));
      }
      /** RPC 목록을 고정해 계정 변경·모델 실행 요청을 만들지 않습니다. */
      function send(value: unknown): void {
        child.stdin.write(`${JSON.stringify(value)}\n`);
      }
      child.stdin.on('error', (): void => finish());
      child.on('error', (): void => finish());
      child.on('close', (): void => {
        if (!done) finish();
      });
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string): void => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) {
          finish();
          return;
        }
        let newline = buffer.indexOf('\n');
        while (newline !== -1 && !done) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = rpcSchema.parse(JSON.parse(line));
            if (message.id != null && message.error !== undefined) {
              finish();
              return;
            }
            if (message.id === 1) {
              send({ method: 'initialized', params: {} });
              send({
                method: 'account/read',
                id: 2,
                params: { refreshToken: false },
              });
              send({ method: 'account/rateLimits/read', id: 3 });
            }
            if (message.id === 2) {
              account = message.result;
              accountDone = true;
            }
            if (message.id === 3) {
              limits = message.result;
              limitsDone = true;
            }
            if (accountDone && limitsDone)
              finish(
                projectAccountUsage(account, limits, new Date().toISOString()),
              );
          } catch {
            finish();
          }
          newline = buffer.indexOf('\n');
        }
      });
      send({
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: {
            name: 'llm_wiki_usage',
            title: 'LLM Wiki',
            version: '0.1.0',
          },
        },
      });
    },
  );
}

/** 로컬 로그인 파일의 변경 여부만 확인하고 토큰 값은 읽지 않습니다. */
async function accountStamp(): Promise<string> {
  try {
    const value = await stat(
      join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'),
    );
    return `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  } catch {
    return 'unavailable';
  }
}

/** 계정·제공자별 짧은 캐시를 사용하고 연결 전환 시 이전 값을 폐기합니다. */
export class AccountUsageService {
  #cached: { key: string; at: number; value: AccountUsage } | null = null;
  #pending: { key: string; promise: Promise<AccountUsage> } | null = null;
  #epoch = 0;
  readonly #runtime: () => Promise<PersonalAi>;
  readonly #read: (cli: string) => Promise<AccountUsage>;
  constructor(
    runtime: () => Promise<PersonalAi> = (): Promise<PersonalAi> =>
      personalAi('analysis'),
    read: (cli: string) => Promise<AccountUsage> = readCodexAccount,
  ) {
    this.#runtime = runtime;
    this.#read = read;
  }

  /** 사용자가 바뀌면 진행 중 조회도 새 캐시에 반영하지 못하게 합니다. */
  clear(): void {
    this.#epoch += 1;
    this.#cached = null;
    this.#pending = null;
  }

  /** 계정 한도 조회는 모델 실행이나 크레딧 소비 동작을 호출하지 않습니다. */
  async read(refresh: boolean = false): Promise<AccountUsage> {
    const runtime = await this.#runtime();
    const stamp = await accountStamp();
    const key = `${runtime.provider}:${runtime.cli}:${stamp}`;
    if (
      !refresh &&
      this.#cached?.key === key &&
      Date.now() - this.#cached.at < 60_000
    )
      return this.#cached.value;
    if (this.#pending?.key === key) return this.#pending.promise;
    const epoch = this.#epoch;
    const promise = this.#query(runtime)
      .then(async (value: AccountUsage): Promise<AccountUsage> => {
        const selected = await this.#runtime();
        if (
          epoch !== this.#epoch ||
          runtime.provider !== selected.provider ||
          runtime.cli !== selected.cli ||
          stamp !== (await accountStamp())
        )
          return {
            ...value,
            status: 'unavailable',
            accountLabel: null,
            checkedAt: null,
            windows: [],
            stale: true,
            message: '계정이 변경되어 한도를 다시 확인해야 합니다.',
          };
        this.#cached = { key, at: Date.now(), value };
        return value;
      })
      .finally((): void => {
        if (this.#pending?.promise === promise) this.#pending = null;
      });
    this.#pending = { key, promise };
    return promise;
  }

  /** 미지원 제공자는 숫자를 추정하지 않고 미제공 상태로 표시합니다. */
  async #query(runtime: PersonalAi): Promise<AccountUsage> {
    if (runtime.provider === 'claude')
      return {
        provider: 'claude',
        status: 'unavailable',
        accountLabel: null,
        checkedAt: new Date().toISOString(),
        stale: false,
        windows: [],
        message:
          'Claude는 계정 한도 수치를 제공하지 않습니다. 연결 상태와는 관계없습니다.',
      };
    try {
      const cli = isAbsolute(runtime.cli)
        ? runtime.cli
        : await discoverAiExecutable('codex');
      if (!cli) throw new Error('cli_unavailable');
      return await this.#read(cli);
    } catch {
      return {
        provider: 'codex',
        status: 'error',
        accountLabel: null,
        checkedAt: new Date().toISOString(),
        stale: false,
        windows: [],
        message:
          '계정 한도를 확인하지 못했습니다. CLI 로그인 상태를 확인해 주세요.',
      };
    }
  }
}

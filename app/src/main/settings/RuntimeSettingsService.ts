import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { discoverAiExecutable } from '../backend/personalAi';
import type { BundledRuntimePaths } from './bundledRuntime';
import { checkCliLogin, openCliLoginTerminal } from './cliLogin';
import {
  DEFAULT_AI_MODEL,
  aiModelSchema,
  aiProviderSchema,
  storedRuntimeSettingsSchema,
} from '@contracts/runtime.contract';
import type {
  RuntimeSettings,
  RuntimeSnapshot,
  RuntimeCheck,
  CliConnection,
  RuntimePathKind,
  AiProvider,
} from '@contracts/runtime.contract';

// 모델 필드가 없는 옛 파일은 읽을 때 default로 보충하며 저장 전까지 파일을 바꾸지 않습니다.
const fileSchema = z.union([
  z
    .object({
      version: z.literal(2),
      settings: storedRuntimeSettingsSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      settings: storedRuntimeSettingsSchema.omit({
        provider: true,
        claude: true,
      }),
    })
    .strict()
    .transform(
      (value: {
        version: 1;
        settings: Omit<RuntimeSettings, 'provider' | 'claude'>;
      }): { version: 2; settings: RuntimeSettings } => ({
        version: 2,
        settings: { ...value.settings, provider: 'codex', claude: 'claude' },
      }),
    ),
]);
type ChoosePath = (kind: RuntimePathKind) => Promise<string | null>;
type FindCli = (provider: AiProvider) => Promise<string | null>;
/** 진단에 필요한 로컬 환경만 전달하며 서버 인증을 포함하지 않습니다. */
function environment(settings: RuntimeSettings): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    // macOS의 Claude Code 로그인 정보는 키체인에 있고 USER가 없으면 로그아웃으로 읽힙니다.
    'USER',
    'LOGNAME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
  ]) {
    if (process.env[key]) result[key] = process.env[key];
  }
  result.PYTHONNOUSERSITE = '1';
  result.PATH = withMacToolPaths(result.PATH);
  if (settings.tesseract)
    result.PATH = `${dirname(settings.tesseract)}${delimiter}${result.PATH || ''}`;
  if (settings.tessdata) result.TESSDATA_PREFIX = settings.tessdata;
  return result;
}
/**
 * Finder·Dock으로 연 앱은 셸의 PATH를 받지 못해 Homebrew로 설치한 도구(Tesseract 등)를 찾지 못합니다.
 * macOS의 표준 설치 위치를 PATH 뒤에 덧붙여 시스템 도구가 먼저 선택되게 합니다.
 */
function withMacToolPaths(path: string | undefined): string {
  const base = path ?? '';
  if (process.platform !== 'darwin') return base;
  const known = new Set(base.split(delimiter));
  return [
    base,
    ...['/opt/homebrew/bin', '/usr/local/bin'].filter(
      (directory: string): boolean => !known.has(directory),
    ),
  ]
    .filter((value: string): boolean => value.length > 0)
    .join(delimiter);
}
/** 제한된 JSON만 받아들이며 원시 stderr나 경로가 든 예외를 UI에 보내지 않습니다. */
function runJson(
  python: string,
  args: string[],
  settings: RuntimeSettings,
): Promise<unknown> {
  return new Promise(
    (
      resolve: (value: unknown) => void,
      reject: (error: Error) => void,
    ): void => {
      execFile(
        python,
        args,
        {
          cwd: settings.root,
          env: environment(settings),
          timeout: 60_000,
          maxBuffer: 512 * 1024,
          windowsHide: true,
        },
        (error: Error | null, stdout: string): void => {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(
              new Error(error ? 'runtime_unavailable' : 'invalid_diagnostic'),
            );
          }
        },
      );
    },
  );
}
/** 같은 제공자의 자동 로그인 확인 사이 최소 간격입니다. */
const AUTO_CHECK_INTERVAL_MS = 30_000;
/** 설정 파일의 전체 기준을 고정해 다른 인스턴스의 변경을 덮어쓰지 않습니다. */
function digest(bytes: Buffer | null): string | null {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
}
/** 비밀이 아닌 실행 경로만 저장하고 현재 실행 환경은 시작 때만 갱신합니다. */
export class RuntimeSettingsService {
  readonly #directory: string;
  readonly #choose: ChoosePath;
  readonly #findCli: FindCli;
  #settings: RuntimeSettings;
  #initial: RuntimeSettings;
  #revision: string | null = null;
  #savedSettings: RuntimeSettings | null = null;
  #issue: string | null = null;
  #checks: RuntimeCheck[] = [];
  #connection: CliConnection | null = null;
  #busy = false;
  #autoCheck: { provider: AiProvider; at: number } | null = null;
  constructor(
    directory: string,
    defaultRoot: string,
    choose: ChoosePath,
    bundled: BundledRuntimePaths | null = null,
    findCli: FindCli = discoverAiExecutable,
  ) {
    this.#directory = directory;
    this.#choose = choose;
    this.#findCli = findCli;
    const explicitRoot =
      process.env.WIKI_CLIENT_ROOT || process.env.WIKI_ANALYSIS_PROJECT_ROOT;
    const root = explicitRoot || bundled?.root || defaultRoot;
    // 외부 프로젝트를 명시했으면 그 프로젝트의 Python을 기본값으로 사용합니다.
    const defaultPython =
      !explicitRoot && bundled
        ? bundled.python
        : root
          ? join(
              root,
              process.platform === 'win32'
                ? '.venv/Scripts/python.exe'
                : '.venv/bin/python',
            )
          : '';
    const provider = aiProviderSchema.safeParse(
      process.env.WIKI_AI_PROVIDER || 'codex',
    );
    if (!provider.success)
      this.#issue =
        'AI 제공자 설정을 확인해 주세요. Codex 또는 Claude Code를 선택할 수 있습니다.';
    this.#settings = {
      root,
      provider: provider.success ? provider.data : 'codex',
      python:
        process.env.WIKI_PYTHON ||
        process.env.WIKI_CLIENT_PYTHON ||
        process.env.WIKI_ANALYSIS_PYTHON ||
        defaultPython,
      codex: process.env.WIKI_ANALYSIS_CODEX_CLI || 'codex',
      claude: process.env.WIKI_CLAUDE_CLI || 'claude',
      tesseract: process.env.WIKI_TESSERACT || bundled?.tesseract || '',
      tessdata:
        process.env.TESSDATA_PREFIX ||
        (process.env.WIKI_TESSERACT ? '' : bundled?.tessdata || ''),
      models: { codex: DEFAULT_AI_MODEL, claude: DEFAULT_AI_MODEL },
    };
    this.#initial = { ...this.#settings };
  }
  /** 기존 파일의 형식·링크·크기를 검사한 뒤 읽습니다. */
  async #bytes(): Promise<Buffer | null> {
    const path = join(this.#directory, 'runtime.json');
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 32_768
      )
        throw new Error('invalid_settings');
      return await readFile(path);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return null;
      throw error;
    }
  }
  /** 앱 시작 전에 설정을 읽고 손상된 파일은 보존합니다. */
  async initialize(): Promise<void> {
    try {
      const bytes = await this.#bytes();
      this.#revision = digest(bytes);
      if (bytes) {
        this.#settings = fileSchema.parse(
          JSON.parse(bytes.toString('utf8')),
        ).settings;
        this.#issue = null;
      } else if (this.#issue) return;
      await this.#resolveDefaultCli('codex');
      await this.#resolveDefaultCli('claude');
      this.#initial = { ...this.#settings };
      if (bytes) this.#savedSettings = { ...this.#settings };
      this.applyEnvironment();
    } catch {
      this.#issue = '저장 설정을 읽을 수 없습니다. 기존 파일을 보존했습니다.';
    }
  }
  /** 분석·질문·변환이 같은 시작 설정을 사용하도록 별칭을 함께 지정합니다. */
  applyEnvironment(): void {
    const value = this.#settings;
    process.env.WIKI_AI_PROVIDER = value.provider;
    process.env.WIKI_CLAUDE_CLI = value.claude;
    // 시작 때 선택한 제공자의 모델만 실행기에 전달합니다('default'면 인자를 넘기지 않음).
    process.env.WIKI_AI_MODEL = value.models[value.provider];
    if (value.root) {
      process.env.WIKI_CLIENT_ROOT = value.root;
      process.env.WIKI_ANALYSIS_PROJECT_ROOT = value.root;
    }
    if (value.python)
      for (const key of [
        'WIKI_PYTHON',
        'WIKI_CLIENT_PYTHON',
        'WIKI_ANALYSIS_PYTHON',
      ])
        process.env[key] = value.python;
    if (value.codex)
      for (const key of [
        'WIKI_ANALYSIS_CODEX_CLI',
        'WIKI_QUESTION_CODEX_CLI',
        'WIKI_PROPOSAL_CODEX_CLI',
      ]) {
        // 저장한 공통 선택이 없으면 실행기별로 명시한 기존 설정을 보존합니다.
        if (this.#savedSettings !== null || !process.env[key])
          process.env[key] = value.codex;
      }
    process.env.PATH = withMacToolPaths(process.env.PATH);
    if (value.tesseract)
      process.env.PATH = `${dirname(value.tesseract)}${delimiter}${process.env.PATH || ''}`;
    if (value.tessdata) process.env.TESSDATA_PREFIX = value.tessdata;
  }
  /** 설정 복사본만 공개합니다. */
  snapshot(): RuntimeSnapshot {
    return {
      settings: { ...this.#settings, models: { ...this.#settings.models } },
      activeProvider: this.#initial.provider,
      activeModel: this.#initial.models[this.#initial.provider],
      restartRequired:
        this.#savedSettings !== null &&
        JSON.stringify(this.#initial) !== JSON.stringify(this.#savedSettings),
      saved:
        this.#savedSettings !== null &&
        JSON.stringify(this.#settings) === JSON.stringify(this.#savedSettings),
      issue: this.#issue,
      checks: [...this.#checks],
      ...(this.#connection ? { cliConnection: { ...this.#connection } } : {}),
      platform: process.platform,
    };
  }
  /** 네이티브 선택 창에서 고른 경로만 사용합니다. */
  async choose(kind: RuntimePathKind): Promise<RuntimeSnapshot> {
    if (this.#busy) throw new Error('busy');
    const path = await this.#choose(kind);
    if (path) {
      this.#settings = { ...this.#settings, [kind]: path };
      this.#checks = [];
    }
    return this.snapshot();
  }
  /** 제공자 초안만 바꾸며 현재 실행 중인 프로세스 환경에는 적용하지 않습니다. */
  selectProvider(provider: AiProvider): RuntimeSnapshot {
    if (this.#busy) throw new Error('busy');
    this.#settings = {
      ...this.#settings,
      provider: aiProviderSchema.parse(provider),
    };
    this.#checks = [];
    this.#connection = null;
    return this.snapshot();
  }
  /**
   * 모델은 고르는 즉시 저장하고 다음 AI 실행부터 적용합니다. 제공자·경로의 저장 전 초안은 건드리지 않고
   * 저장된 설정(없으면 현재 설정)에 모델만 바꿔 씁니다.
   */
  async selectModel(
    provider: AiProvider,
    model: string,
  ): Promise<RuntimeSnapshot> {
    if (this.#busy || this.#issue) throw new Error('settings_unavailable');
    const name = aiProviderSchema.parse(provider);
    const value = aiModelSchema.parse(model);
    const base = this.#savedSettings ?? this.#settings;
    const saved = { ...base, models: { ...base.models, [name]: value } };
    await this.#writeSettings(saved);
    this.#savedSettings = saved;
    this.#settings = {
      ...this.#settings,
      models: { ...this.#settings.models, [name]: value },
    };
    // 이번 실행에 적용 중인 제공자의 모델이면 재시작 없이 새 실행부터 바로 씁니다.
    this.#initial = {
      ...this.#initial,
      models: { ...this.#initial.models, [name]: value },
    };
    if (this.#initial.provider === name) process.env.WIKI_AI_MODEL = value;
    return this.snapshot();
  }
  /**
   * 연결에 성공한 제공자를 바로 사용 제공자로 저장하고 다음 AI 실행부터 적용합니다.
   * 경로 초안은 건드리지 않고 시작 때 적용한 설정에 제공자만 바꿔 쓰며, 저장에 실패하면 초안으로 남겨 재시작 안내를 따릅니다.
   * 진행 중인 실행은 시작할 때의 환경을 유지하므로 영향을 받지 않습니다.
   */
  async #activateProvider(provider: AiProvider): Promise<void> {
    if (this.#issue || provider === this.#initial.provider) return;
    try {
      const saved = {
        ...(this.#savedSettings ?? this.#initial),
        provider,
      };
      await this.#writeSettings(saved);
      this.#savedSettings = saved;
      this.#initial = { ...this.#initial, provider };
      process.env.WIKI_AI_PROVIDER = provider;
      process.env.WIKI_AI_MODEL = this.#initial.models[provider];
    } catch {
      // 저장하지 못하면 선택은 초안으로 남고, 설정 화면의 저장·재시작 안내가 그대로 적용됩니다.
    }
  }
  /** 연결 진행 상태를 제한된 문구로 기록합니다. */
  #setConnection(
    status: CliConnection['status'],
    message: string,
    code: string | null = null,
    verifiedAt: string | null = null,
  ): void {
    this.#connection = {
      provider: this.#settings.provider,
      status,
      message,
      code,
      verifiedAt,
    };
  }
  /** 실행 파일을 찾고 로그인되어 있지 않으면 사용자 터미널에서 로그인을 시작합니다. */
  async connectCli(): Promise<RuntimeSnapshot> {
    if (this.#busy) throw new Error('busy');
    this.#busy = true;
    try {
      const provider = this.#settings.provider;
      const name = provider === 'claude' ? 'Claude Code' : 'Codex';
      await this.#resolveDefaultCli(provider);
      const login = await checkCliLogin(provider, this.#settings[provider]);
      if (login.status === 'logged_in') {
        this.#setConnection('connected', `${name} 로그인이 확인되었습니다.`);
        await this.#activateProvider(provider);
      } else if (login.status === 'logged_out') {
        try {
          await openCliLoginTerminal(provider, this.#settings[provider]);
          this.#setConnection(
            'waiting_login',
            `${name} 로그인 터미널을 열었습니다. 로그인을 마치면 앱이 자동으로 확인합니다.`,
          );
        } catch (error: unknown) {
          this.#setConnection(
            'error',
            '로그인 터미널을 열지 못했습니다. 터미널에서 직접 로그인한 뒤 다시 확인해 주세요.',
            error instanceof Error
              ? error.message
              : 'cli_login_terminal_unavailable',
          );
        }
      } else {
        this.#setConnection(
          'error',
          `${name} 실행 파일을 확인하지 못했습니다. ${name}를 설치했는지 확인하거나 ‘프로그램 위치 변경’에서 실행 파일을 선택해 주세요.`,
          login.code ?? null,
        );
      }
      return this.snapshot();
    } finally {
      this.#busy = false;
    }
  }
  /** 로그인 상태만 다시 읽으며 터미널을 새로 열지 않습니다. */
  async checkCliLogin(): Promise<RuntimeSnapshot> {
    if (this.#busy) throw new Error('busy');
    this.#busy = true;
    try {
      const provider = this.#settings.provider;
      const name = provider === 'claude' ? 'Claude Code' : 'Codex';
      const login = await checkCliLogin(provider, this.#settings[provider]);
      if (login.status === 'logged_in') {
        this.#setConnection('connected', `${name} 로그인이 확인되었습니다.`);
        await this.#activateProvider(provider);
      } else if (login.status === 'logged_out')
        this.#setConnection(
          'waiting_login',
          `${name} 로그인을 기다리고 있습니다. 터미널에서 로그인을 마쳐 주세요.`,
        );
      else
        this.#setConnection(
          'error',
          `${name} 로그인 상태를 확인하지 못했습니다.`,
          login.code ?? null,
        );
      return this.snapshot();
    } finally {
      this.#busy = false;
    }
  }
  /**
   * 연결 기록이 없을 때 이미 로그인된 CLI를 한 번 자동으로 확인합니다.
   * 터미널을 열거나 저장하지 않으며 로그아웃·오류는 기록을 만들지 않아 '연결 전'으로 남습니다.
   * 읽기 요청마다 CLI를 실행하지 않도록 같은 제공자는 일정 시간 안에 다시 확인하지 않습니다.
   */
  async refreshConnection(): Promise<RuntimeSnapshot> {
    const provider = this.#settings.provider;
    const recent =
      this.#autoCheck?.provider === provider &&
      Date.now() - this.#autoCheck.at < AUTO_CHECK_INTERVAL_MS;
    if (this.#busy || this.#connection?.provider === provider || recent)
      return this.snapshot();
    this.#busy = true;
    this.#autoCheck = { provider, at: Date.now() };
    try {
      await this.#resolveDefaultCli(provider);
      const login = await checkCliLogin(provider, this.#settings[provider]);
      // 확인하는 동안 제공자나 연결 기록이 바뀌었으면 결과를 버립니다.
      if (
        login.status === 'logged_in' &&
        this.#settings.provider === provider &&
        this.#connection === null
      ) {
        this.#setConnection(
          'connected',
          `${provider === 'claude' ? 'Claude Code' : 'Codex'} 로그인이 확인되었습니다.`,
        );
        await this.#activateProvider(provider);
      }
    } finally {
      this.#busy = false;
    }
    return this.snapshot();
  }
  /**
   * 로그인 확인과 별개로 선택한 AI를 짧게 한 번 호출해 실제로 응답하는지 봅니다.
   * 위키·서버·인증정보를 쓰지 않고 고정 질문 한 줄만 보내며, 결과는 연결 상태 문구에만 반영합니다.
   */
  async testAi(): Promise<RuntimeSnapshot> {
    if (this.#busy) throw new Error('busy');
    this.#busy = true;
    const provider = this.#settings.provider;
    const name = provider === 'claude' ? 'Claude Code' : 'Codex';
    let directory: string | null = null;
    try {
      await this.#resolveDefaultCli(provider);
      const settings = { ...this.#settings };
      // AI 어댑터는 심볼릭 링크를 지나는 폴더를 거부하므로 macOS의 /var → /private/var를 풀어 둡니다.
      directory = await mkdtemp(
        join(await realpath(tmpdir()), 'wiki-ai-test-'),
      );
      await mkdir(join(directory, 'work'), { mode: 0o700 });
      const questionFile = join(directory, 'question.txt');
      await writeFile(questionFile, '연결 확인', {
        encoding: 'utf8',
        mode: 0o600,
      });
      const model = settings.models[provider];
      const raw = z
        .object({
          ok: z.boolean(),
          error: z.object({ code: z.string() }).optional(),
        })
        .parse(
          await runJson(
            settings.python,
            [
              '-B',
              '-m',
              'tools.search_terms_cli',
              '--work-dir',
              join(directory, 'work'),
              '--question-file',
              questionFile,
              '--ai-provider',
              provider,
              '--ai-cli',
              settings[provider],
              ...(model === DEFAULT_AI_MODEL ? [] : ['--ai-model', model]),
              '--ai-timeout',
              '45',
            ],
            settings,
          ),
        );
      if (raw.ok)
        this.#setConnection(
          'connected',
          `${name}를 실제로 호출해 응답을 확인했습니다.`,
          null,
          new Date().toISOString(),
        );
      else {
        const code = raw.error?.code ?? 'ai_test_failed';
        this.#setConnection(
          'error',
          code === 'ai_cli_unavailable'
            ? `${name} 실행 파일을 실행하지 못했습니다. 설치 위치를 ‘프로그램 위치 변경’에서 다시 선택해 주세요.`
            : code === 'ai_rate_limited'
              ? `${name}의 사용 한도에 도달했습니다. 한도가 풀린 뒤 다시 시험해 주세요.`
              : `${name} 로그인은 확인됐지만 실제 호출에 실패했습니다. 터미널에서 ${provider}가 응답하는지 확인해 주세요.`,
          code,
        );
      }
    } catch {
      this.#setConnection(
        'error',
        `${name}를 호출해 보지 못했습니다. Python·프로젝트 폴더 설정과 ${name} 설치를 확인해 주세요.`,
        'ai_test_unavailable',
      );
    } finally {
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch(
          (): void => {},
        );
      this.#busy = false;
    }
    return this.snapshot();
  }
  /** 로그인 대기 표시만 해제합니다. */
  cancelCliLogin(): RuntimeSnapshot {
    this.#connection = null;
    return this.snapshot();
  }
  /** 기본 명령일 때만 설치 위치를 찾아 직접 선택한 경로를 보존합니다. */
  async #resolveDefaultCli(provider: AiProvider): Promise<void> {
    if (this.#settings[provider] !== provider) return;
    const path = await this.#findCli(provider);
    if (path) this.#settings = { ...this.#settings, [provider]: path };
  }
  /** 사용자가 요청한 재검색 결과만 초안에 반영하며 저장·로그인은 실행하지 않습니다. */
  async discoverCli(): Promise<RuntimeSnapshot> {
    if (this.#busy) throw new Error('busy');
    this.#busy = true;
    try {
      const provider = this.#settings.provider;
      const name = provider === 'claude' ? 'Claude Code' : 'Codex';
      const path = await this.#findCli(provider);
      if (path) this.#settings = { ...this.#settings, [provider]: path };
      this.#checks = [
        {
          name: `${name} CLI 실행 파일`,
          status: path ? 'ok' : 'missing',
          detail: path
            ? '설치된 실행 파일을 찾았습니다. 실행 준비 확인으로 로그인을 확인하세요.'
            : '기본 설치 위치에서 찾지 못했습니다. 설치 후 다시 찾거나 ‘프로그램 위치 변경’에서 실행 파일을 선택하세요.',
        },
        {
          name: `${name} CLI·로그인`,
          status: 'not_run',
          detail:
            '실행 파일 검색만 완료했습니다. 로그인은 아직 확인하지 않았습니다.',
        },
      ];
      return this.snapshot();
    } finally {
      this.#busy = false;
    }
  }
  /** 기준 판본을 대조하고 원자 저장하며 진행 중 실행 환경을 유지합니다. */
  async save(): Promise<RuntimeSnapshot> {
    if (this.#busy || this.#issue) throw new Error('settings_unavailable');
    await this.#writeSettings(this.#settings);
    this.#savedSettings = { ...this.#settings };
    return this.snapshot();
  }
  /** 경로 검사 뒤 설정 파일을 원자적으로 바꿉니다. 저장 성공 뒤 판본만 갱신하고 메모리 상태는 호출자가 바꿉니다. */
  async #writeSettings(settings: RuntimeSettings): Promise<void> {
    for (const [key, value] of Object.entries(settings)) {
      if (
        typeof value === 'string' &&
        value &&
        key !== 'provider' &&
        !isAbsolute(value) &&
        !((key === 'codex' || key === 'claude') && value === key)
      )
        throw new Error('absolute_path_required');
    }
    if (!settings.root || !settings.python)
      throw new Error('runtime_paths_required');
    await access(join(settings.root, 'tools/runtime_doctor.py'));
    await access(settings.python);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('invalid_directory');
    const lockPath = join(this.#directory, 'runtime.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    const temporary = join(this.#directory, `.runtime-${randomUUID()}.tmp`);
    try {
      if (digest(await this.#bytes()) !== this.#revision)
        throw new Error('settings_conflict');
      const bytes = Buffer.from(JSON.stringify({ version: 2, settings }));
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.#directory, 'runtime.json'));
      this.#revision = digest(bytes);
    } finally {
      await unlink(temporary).catch((): void => {});
      await lock.close();
      await unlink(lockPath);
    }
  }
  /** 기존 읽기 전용 진단을 호출하며 모델·로그인·설치를 시작하지 않습니다. */
  async diagnose(): Promise<RuntimeSnapshot> {
    if (this.#busy) throw new Error('busy');
    this.#busy = true;
    try {
      // 앱을 연 뒤 CLI를 설치한 경우에도 파일 선택 없이 다시 찾습니다.
      await this.#resolveDefaultCli(this.#settings.provider);
      const settings = { ...this.#settings };
      const raw = await runJson(
        settings.python,
        [
          '-B',
          '-m',
          'tools.runtime_doctor',
          '--ai-provider',
          settings.provider,
          '--ai-cli',
          settings[settings.provider],
        ],
        settings,
      );
      const doctor = z
        .object({
          python_supported: z.boolean(),
          dependencies: z.array(z.object({ status: z.string() })),
          ai: z.object({ status: z.string(), login: z.string().optional() }),
        })
        .parse(raw);
      this.#checks = [
        {
          name: 'Python 3.12 이상',
          status: doctor.python_supported ? 'ok' : 'error',
          detail: doctor.python_supported
            ? '실행 확인'
            : '지원하는 Python을 설치해 주세요.',
        },
        {
          name: '고정 Python 의존성',
          status: doctor.dependencies.every(
            (row: { status: string }): boolean => row.status === 'ok',
          )
            ? 'ok'
            : 'missing',
          detail: 'requirements.lock 기준 검사',
        },
        {
          name: `${settings.provider === 'claude' ? 'Claude Code' : 'Codex'} CLI·로그인`,
          status: doctor.ai.status === 'ok' ? 'ok' : 'error',
          detail:
            doctor.ai.login === 'credentials_present'
              ? '로컬 로그인 정보 존재. 실제 모델 사용 가능성은 미검증입니다.'
              : `선택한 ${settings.provider === 'claude' ? 'Claude Code' : 'Codex'} CLI의 설치와 개인 로그인을 확인해 주세요.`,
        },
      ];
      try {
        const conversion = z
          .object({
            diagnostics: z
              .object({
                tesseract: z
                  .object({
                    available: z.boolean(),
                    ready: z.boolean().optional(),
                    missing_languages: z.array(z.string()).optional(),
                  })
                  .loose(),
              })
              .loose(),
          })
          .parse(
            await runJson(
              settings.python,
              [
                '-B',
                '-m',
                'tools.source_conversion_cli',
                '--diagnose',
                '--ocr-language',
                'kor+eng',
              ],
              settings,
            ),
          );
        this.#checks.push({
          name: 'Tesseract OCR',
          status:
            conversion.diagnostics.tesseract.ready === true ? 'ok' : 'missing',
          detail: conversion.diagnostics.tesseract.available
            ? `실행 파일 탐지. 한국어·영어 준비: ${conversion.diagnostics.tesseract.ready === true ? '확인' : '미확인 또는 누락'}. 인식 정확도는 별도 검증합니다.`
            : 'Tesseract 실행 파일과 사용할 언어 데이터를 설치해 주세요.',
          optional: true,
        });
      } catch {
        this.#checks.push({
          name: 'Tesseract OCR',
          status: 'error',
          detail: '변환기 진단을 실행하지 못했습니다.',
          optional: true,
        });
      }
    } catch {
      this.#checks = [
        {
          name: '개인 실행 환경',
          status: 'error',
          detail:
            'Python 경로·프로젝트 폴더·의존성을 확인해 주세요. 설정과 기존 자료는 보존했습니다.',
        },
      ];
    } finally {
      this.#busy = false;
    }
    return this.snapshot();
  }
}

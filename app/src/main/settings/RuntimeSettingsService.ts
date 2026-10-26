import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  mkdir,
  open,
  rename,
  unlink,
  access,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { claudeExecutable } from '../backend/personalAi';
import {
  aiProviderSchema,
  runtimeSettingsSchema,
} from '@contracts/runtime.contract';
import type {
  RuntimeSettings,
  RuntimeSnapshot,
  RuntimeCheck,
  RuntimePathKind,
  AiProvider,
} from '@contracts/runtime.contract';

const fileSchema = z.union([
  z.object({ version: z.literal(2), settings: runtimeSettingsSchema }).strict(),
  z
    .object({
      version: z.literal(1),
      settings: runtimeSettingsSchema.omit({ provider: true, claude: true }),
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
const bundledCodex =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
type ChoosePath = (kind: RuntimePathKind) => Promise<string | null>;
/** 진단에 필요한 로컬 환경만 전달하며 서버 인증을 포함하지 않습니다. */
function environment(settings: RuntimeSettings): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
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
  if (settings.tesseract)
    result.PATH = `${dirname(settings.tesseract)}${delimiter}${result.PATH || ''}`;
  if (settings.tessdata) result.TESSDATA_PREFIX = settings.tessdata;
  return result;
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
/** 설정 파일의 전체 기준을 고정해 다른 인스턴스의 변경을 덮어쓰지 않습니다. */
function digest(bytes: Buffer | null): string | null {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
}
/** 비밀이 아닌 실행 경로만 저장하고 현재 실행 환경은 시작 때만 갱신합니다. */
export class RuntimeSettingsService {
  readonly #directory: string;
  readonly #choose: ChoosePath;
  #settings: RuntimeSettings;
  #initial: RuntimeSettings;
  #revision: string | null = null;
  #savedSettings: RuntimeSettings | null = null;
  #issue: string | null = null;
  #checks: RuntimeCheck[] = [];
  #busy = false;
  constructor(directory: string, defaultRoot: string, choose: ChoosePath) {
    this.#directory = directory;
    this.#choose = choose;
    const root =
      process.env.WIKI_CLIENT_ROOT ||
      process.env.WIKI_ANALYSIS_PROJECT_ROOT ||
      defaultRoot;
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
        (root
          ? join(
              root,
              process.platform === 'win32'
                ? '.venv/Scripts/python.exe'
                : '.venv/bin/python',
            )
          : ''),
      codex: process.env.WIKI_ANALYSIS_CODEX_CLI || 'codex',
      claude: process.env.WIKI_CLAUDE_CLI || 'claude',
      tesseract: process.env.WIKI_TESSERACT || '',
      tessdata: process.env.TESSDATA_PREFIX || '',
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
      if (this.#settings.codex === 'codex' && process.platform === 'darwin') {
        try {
          await access(bundledCodex);
          this.#settings.codex = bundledCodex;
        } catch {
          /* PATH를 사용합니다. */
        }
      }
      this.#settings.claude = await claudeExecutable(this.#settings.claude);
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
    if (value.tesseract)
      process.env.PATH = `${dirname(value.tesseract)}${delimiter}${process.env.PATH || ''}`;
    if (value.tessdata) process.env.TESSDATA_PREFIX = value.tessdata;
  }
  /** 설정 복사본만 공개합니다. */
  snapshot(): RuntimeSnapshot {
    return {
      settings: { ...this.#settings },
      activeProvider: this.#initial.provider,
      restartRequired:
        this.#savedSettings !== null &&
        JSON.stringify(this.#initial) !== JSON.stringify(this.#savedSettings),
      saved:
        this.#savedSettings !== null &&
        JSON.stringify(this.#settings) === JSON.stringify(this.#savedSettings),
      issue: this.#issue,
      checks: [...this.#checks],
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
    return this.snapshot();
  }
  /** 기준 판본을 대조하고 원자 저장하며 진행 중 실행 환경을 유지합니다. */
  async save(): Promise<RuntimeSnapshot> {
    if (this.#busy || this.#issue) throw new Error('settings_unavailable');
    for (const [key, value] of Object.entries(this.#settings)) {
      if (
        value &&
        key !== 'provider' &&
        !isAbsolute(value) &&
        !((key === 'codex' || key === 'claude') && value === key)
      )
        throw new Error('absolute_path_required');
    }
    if (!this.#settings.root || !this.#settings.python)
      throw new Error('runtime_paths_required');
    await access(join(this.#settings.root, 'tools/runtime_doctor.py'));
    await access(this.#settings.python);
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
      const bytes = Buffer.from(
        JSON.stringify({ version: 2, settings: this.#settings }),
      );
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.#directory, 'runtime.json'));
      this.#revision = digest(bytes);
      this.#savedSettings = { ...this.#settings };
    } finally {
      await unlink(temporary).catch((): void => {});
      await lock.close();
      await unlink(lockPath);
    }
    return this.snapshot();
  }
  /** 기존 읽기 전용 진단을 호출하며 모델·로그인·설치를 시작하지 않습니다. */
  async diagnose(): Promise<RuntimeSnapshot> {
    if (this.#busy) throw new Error('busy');
    this.#busy = true;
    const settings = { ...this.#settings };
    try {
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
        });
      } catch {
        this.#checks.push({
          name: 'Tesseract OCR',
          status: 'error',
          detail: '변환기 진단을 실행하지 못했습니다.',
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

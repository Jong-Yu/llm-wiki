import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_AI_MODEL,
  aiModelSchema,
  aiProviderSchema,
} from '@contracts/runtime.contract';
import type { AiProvider } from '@contracts/runtime.contract';

export type PersonalAi = { provider: AiProvider; cli: string; model: string };

/** 'default'가 아닌 모델만 --ai-model로 넘기며, 모든 AI 실행이 이 인자를 공유합니다. */
export function aiModelArguments(ai: PersonalAi): string[] {
  return ai.model === DEFAULT_AI_MODEL ? [] : ['--ai-model', ai.model];
}

interface AiDiscoveryOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

/** 기본 설치 위치와 절대 PATH 항목만 읽어 찾으며 셸이나 CLI를 실행하지 않습니다. */
export async function discoverAiExecutable(
  provider: AiProvider,
  options: AiDiscoveryOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory =
    options.homeDirectory ??
    (platform === 'win32' ? environment.USERPROFILE : environment.HOME) ??
    homedir();
  const names =
    platform === 'win32' ? [`${provider}.exe`, `${provider}.cmd`] : [provider];
  const directories: string[] = [];
  const candidates: string[] = [];
  if (provider === 'claude')
    directories.push(join(homeDirectory, '.local', 'bin'));
  if (provider === 'codex' && platform === 'darwin')
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    );
  const pathKey = Object.keys(environment).find((key: string): boolean =>
    platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH',
  );
  const path = pathKey ? environment[pathKey] : '';
  for (const entry of (path || '').split(platform === 'win32' ? ';' : ':')) {
    // 빈 값·상대 경로는 작업 폴더의 동명 파일을 자동 선택할 수 있어 제외합니다.
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (isAbsolute(directory)) directories.push(directory);
  }
  if (platform === 'darwin')
    directories.push('/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'win32') {
    if (environment.APPDATA) directories.push(join(environment.APPDATA, 'npm'));
    if (environment.LOCALAPPDATA)
      directories.push(
        join(environment.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      );
  }
  for (const directory of new Set(directories)) {
    if (!isAbsolute(directory)) continue;
    for (const name of names) candidates.push(join(directory, name));
  }
  for (const candidate of new Set(candidates)) {
    try {
      const file = await stat(candidate);
      if (!file.isFile()) continue;
      await access(
        candidate,
        platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return candidate;
    } catch {
      // 누락·깨진 링크·실행 권한 없는 후보는 건너뛰고 다음 설치 위치를 확인합니다.
    }
  }
  return null;
}

/** 기본값일 때만 설치를 탐지하고 사용자가 직접 지정한 경로는 그대로 보존합니다. */
export async function claudeExecutable(
  cli: string,
  homeDirectory: string = homedir(),
): Promise<string> {
  if (cli !== 'claude') return cli;
  return (await discoverAiExecutable('claude', { homeDirectory })) || cli;
}

/** 시작 때 적용한 제공자와 해당 실행 경로만 고르고 기존 Codex 환경 별칭을 보존합니다. */
export async function personalAi(
  operation: 'analysis' | 'question' | 'proposal',
): Promise<PersonalAi> {
  const provider = aiProviderSchema.parse(
    process.env.WIKI_AI_PROVIDER || 'codex',
  );
  // 형식이 맞지 않는 값은 인자로 넘기지 않고 기본 모델로 둡니다.
  const parsedModel = aiModelSchema.safeParse(
    process.env.WIKI_AI_MODEL || DEFAULT_AI_MODEL,
  );
  const model = parsedModel.success ? parsedModel.data : DEFAULT_AI_MODEL;
  if (provider === 'claude')
    return {
      provider,
      cli: await claudeExecutable(process.env.WIKI_CLAUDE_CLI || 'claude'),
      model,
    };
  const specific = {
    analysis: process.env.WIKI_ANALYSIS_CODEX_CLI,
    question: process.env.WIKI_QUESTION_CODEX_CLI,
    proposal: process.env.WIKI_PROPOSAL_CODEX_CLI,
  }[operation];
  const cli = specific || process.env.WIKI_ANALYSIS_CODEX_CLI;
  if (cli) return { provider, cli, model };
  const bundled =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  if (process.platform === 'darwin') {
    try {
      await access(bundled);
      return { provider, cli: bundled, model };
    } catch {
      /* 설치된 번들이 없으면 PATH에서 찾습니다. */
    }
  }
  return { provider, cli: 'codex', model };
}

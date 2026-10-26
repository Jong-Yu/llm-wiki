import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aiProviderSchema } from '@contracts/runtime.contract';
import type { AiProvider } from '@contracts/runtime.contract';

export type PersonalAi = { provider: AiProvider; cli: string };

/** GUI의 짧은 PATH에서도 기본 native 설치만 찾고 명시한 실행 경로는 유지합니다. */
export async function claudeExecutable(
  cli: string,
  homeDirectory: string = homedir(),
): Promise<string> {
  if (cli !== 'claude' || process.platform === 'win32') return cli;
  const native = join(homeDirectory, '.local', 'bin', 'claude');
  try {
    await access(native);
    return native;
  } catch {
    return cli;
  }
}

/** 시작 때 적용한 제공자와 해당 실행 경로만 고르고 기존 Codex 환경 별칭을 보존합니다. */
export async function personalAi(
  operation: 'analysis' | 'question' | 'proposal',
): Promise<PersonalAi> {
  const provider = aiProviderSchema.parse(
    process.env.WIKI_AI_PROVIDER || 'codex',
  );
  if (provider === 'claude')
    return {
      provider,
      cli: await claudeExecutable(process.env.WIKI_CLAUDE_CLI || 'claude'),
    };
  const specific = {
    analysis: process.env.WIKI_ANALYSIS_CODEX_CLI,
    question: process.env.WIKI_QUESTION_CODEX_CLI,
    proposal: process.env.WIKI_PROPOSAL_CODEX_CLI,
  }[operation];
  const cli = specific || process.env.WIKI_ANALYSIS_CODEX_CLI;
  if (cli) return { provider, cli };
  const bundled =
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  if (process.platform === 'darwin') {
    try {
      await access(bundled);
      return { provider, cli: bundled };
    } catch {
      /* 설치된 번들이 없으면 PATH에서 찾습니다. */
    }
  }
  return { provider, cli: 'codex' };
}

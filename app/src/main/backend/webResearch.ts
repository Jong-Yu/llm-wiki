import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { aiModelArguments } from './personalAi';
import {
  assertPersonalRuntime,
  createPrivateExecution,
  runPersonalCommand,
} from './personalProcess';
import type { PrivateExecution } from './personalProcess';
import type { QuestionRuntime } from './QuestionRunService';
import { parseQuestionWebSearchResult } from '@contracts/questionRuns.contract';
import type { QuestionWebSearchResult } from '@contracts/questionRuns.contract';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const AI_TIMEOUT_SECONDS = 60;
const PROCESS_TIMEOUT_MS = 150_000;
const cliResultSchema = z.object({
  protocol: z.literal('web-search-cli-v1'),
  ok: z.literal(true),
  web: z.unknown(),
});

/** 웹 실패를 내부 근거 부재와 구분하며 원시 제공자 오류를 공개하지 않습니다. */
function unavailable(query: string): QuestionWebSearchResult {
  return {
    web: {
      query,
      status: 'unavailable',
      sources: [],
      warnings: ['web_search_failed'],
    },
  };
}

/** CLI 봉투와 고정 출처를 검사하고 검색어·중복·본문 지문이 다른 결과를 거부합니다. */
function readResearchResult(
  output: string,
  query: string,
): QuestionWebSearchResult {
  const envelope = cliResultSchema.parse(
    JSON.parse(output.trim().split('\n').at(-1) ?? ''),
  );
  const result = parseQuestionWebSearchResult({ web: envelope.web });
  if (result.web.query !== query) throw new Error('invalid_web_result');
  const urls = new Set<string>();
  for (const source of result.web.sources) {
    if (
      urls.has(source.url) ||
      createHash('sha256').update(source.content, 'utf8').digest('hex') !==
        source.content_sha256
    )
      throw new Error('invalid_web_result');
    urls.add(source.url);
  }
  return result;
}

/** 인증정보 없이 명시 검색어 하나만 별도 개인 AI와 공개 페이지 읽기에 전달합니다. */
export async function researchPublicWeb(
  runtime: QuestionRuntime,
  query: string,
  signal: AbortSignal,
): Promise<QuestionWebSearchResult> {
  let execution: PrivateExecution | null = null;
  try {
    await assertPersonalRuntime(runtime);
    execution = await createPrivateExecution(
      runtime,
      runtime.privateRoot,
      'unused',
    );
    const queryFile = join(execution.workDirectory, 'query.txt');
    await writeFile(queryFile, query, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    if (signal.aborted) throw new Error('scope_changed');
    const result = await runPersonalCommand(
      runtime,
      [
        '-B',
        '-m',
        'tools.web_search_cli',
        '--work-dir',
        execution.workDirectory,
        '--query-file',
        queryFile,
        '--ai-provider',
        runtime.ai.provider,
        '--ai-cli',
        runtime.ai.cli,
        ...aiModelArguments(runtime.ai),
        '--ai-timeout',
        String(AI_TIMEOUT_SECONDS),
      ],
      { maxBytes: MAX_OUTPUT_BYTES, timeoutMs: PROCESS_TIMEOUT_MS, signal },
    );
    if (result.timedOut || result.tooLarge || result.exitCode !== 0)
      return unavailable(query);
    return readResearchResult(result.output, query);
  } catch {
    if (signal.aborted) throw new Error('scope_changed');
    return unavailable(query);
  } finally {
    if (execution) {
      await execution.cleanupAuth().catch((): void => {});
      await rm(execution.directory, { recursive: true, force: true }).catch(
        (): void => {},
      );
    }
  }
}

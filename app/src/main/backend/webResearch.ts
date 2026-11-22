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
import type {
  QuestionWebSearchInput,
  QuestionWebSearchResult,
} from '@contracts/questionRuns.contract';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const AI_TIMEOUT_SECONDS = 60;
const PROCESS_TIMEOUT_MS = 150_000;
const cliResultSchema = z.object({
  protocol: z.literal('web-search-cli-v1'),
  ok: z.literal(true),
  web: z.unknown(),
});

/** 웹 실패를 내부 근거 부재와 구분하며 원시 제공자 오류를 공개하지 않습니다. */
function unavailable(
  query: string,
  questionBased: boolean,
): QuestionWebSearchResult {
  return {
    web: {
      query,
      status: 'unavailable',
      sources: [],
      warnings: questionBased
        ? ['web_search_failed', 'search_query_unavailable']
        : ['web_search_failed'],
    },
  };
}

/** CLI 봉투와 고정 출처를 검사하고 검색어·중복·본문 지문이 다른 결과를 거부합니다. */
function readResearchResult(
  output: string,
  query: string | null,
): QuestionWebSearchResult {
  const envelope = cliResultSchema.parse(
    JSON.parse(output.trim().split('\n').at(-1) ?? ''),
  );
  const result = parseQuestionWebSearchResult({ web: envelope.web });
  if (query !== null && result.web.query !== query)
    throw new Error('invalid_web_result');
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

/** 인증정보 없이 이번 질문 또는 명시 검색어만 별도 개인 AI와 공개 페이지 읽기에 전달합니다. */
export async function researchPublicWeb(
  runtime: QuestionRuntime,
  input: string | QuestionWebSearchInput,
  signal: AbortSignal,
): Promise<QuestionWebSearchResult> {
  const request = typeof input === 'string' ? { query: input } : input;
  const questionBased = request.question !== undefined;
  const text = request.question ?? request.query;
  const query = request.query ?? null;
  const fallbackQuery = query ?? '질문 기반 웹 검색 (검색어 미확인)';
  let execution: PrivateExecution | null = null;
  try {
    await assertPersonalRuntime(runtime);
    execution = await createPrivateExecution(
      runtime,
      runtime.privateRoot,
      'unused',
    );
    const inputFile = join(
      execution.workDirectory,
      questionBased ? 'question.txt' : 'query.txt',
    );
    await writeFile(inputFile, text, {
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
        questionBased ? '--question-file' : '--query-file',
        inputFile,
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
      return unavailable(fallbackQuery, questionBased);
    return readResearchResult(result.output, query);
  } catch {
    if (signal.aborted) throw new Error('scope_changed');
    return unavailable(fallbackQuery, questionBased);
  } finally {
    if (execution) {
      await execution.cleanupAuth().catch((): void => {});
      await rm(execution.directory, { recursive: true, force: true }).catch(
        (): void => {},
      );
    }
  }
}

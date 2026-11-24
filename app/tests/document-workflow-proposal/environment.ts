import { visualConnection, visualJob } from '../ai-sessions/visualFixtures';
import { readTasks } from './previewStore';
import type { PreviewTask } from './model';
import { jobFixture } from './jobFixture';

const previewRuntime = {
  ok: true,
  data: {
    settings: {
      root: '',
      python: '',
      provider: 'codex',
      codex: '',
      claude: '',
      tesseract: '',
      tessdata: '',
      models: { codex: 'default', claude: 'default' },
    },
    activeProvider: 'codex',
    activeModel: 'default',
    restartRequired: false,
    saved: true,
    issue: null,
    checks: [],
    platform: 'win32',
    cliConnection: {
      provider: 'codex',
      status: 'connected',
      message: '',
      code: null,
    },
  },
};
/** 모든 경계를 합성 응답으로 고정해 외부 연결을 만들지 않습니다. */
Object.defineProperty(window, 'wiki', {
  configurable: true,
  value: {
    connection: { getState: async (): Promise<unknown> => visualConnection },
    runtime: { execute: async (): Promise<unknown> => previewRuntime },
    documents: {
      content: async (): Promise<unknown> => ({
        ok: false,
        error: {
          code: 'not_found',
          message: '시안의 새 문서 이름입니다.',
          status: 404,
        },
      }),
    },
    analysis: {
      list: async (): Promise<unknown> => ({
        ok: true,
        data: {
          items: readTasks()
            .filter((task: PreviewTask): boolean => task.phase !== 'conversion')
            .map((task: PreviewTask): unknown => {
              const job = visualJob(
                task.savedWiki ?? `설계/${task.title}.md`,
                task.title,
                task.sourceId,
              ).job;
              return {
                ...job,
                source_ref: {
                  ...job.source_ref,
                  source_id: task.sourceId,
                  source_version: task.version,
                },
              };
            }),
          nextCursor: null,
          complete: true,
          truncated: false,
          skippedCount: 0,
          requiresRefresh: false,
        },
      }),
      read: async (request: { jobId: string }): Promise<unknown> => {
        const task = readTasks().find(
          (item: PreviewTask): boolean => item.sourceId === request.jobId,
        );
        return task
          ? { ok: true, data: jobFixture(task) }
          : {
              ok: false,
              error: {
                code: 'not_found',
                message: '모의 작업을 찾지 못했습니다.',
              },
            };
      },
    },
    aiSessions: {
      read: async (): Promise<unknown> => ({
        ok: true,
        data: {
          activities: [],
          usage: {
            provider: 'codex',
            status: 'unavailable',
            accountLabel: null,
            checkedAt: null,
            stale: false,
            windows: [],
            message: null,
          },
        },
      }),
    },
    knowledgeComparisons: {
      list: async (): Promise<unknown> => ({
        ok: true,
        data: {
          items: [],
          latestId: null,
          nextCursor: null,
          incomplete: false,
        },
      }),
    },
  },
});

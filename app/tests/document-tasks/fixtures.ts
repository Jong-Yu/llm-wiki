import { z } from 'zod';
import { analysisDetailSchema } from '@contracts/analysis.contract';
import type { AnalysisDetail } from '@contracts/analysis.contract';
import {
  documentTaskSchema,
  documentTaskDetailResultSchema,
} from '@contracts/documentTasks.contract';
import type {
  DocumentTask,
  DocumentTaskCreateRequest,
  DocumentTaskReadRequest,
} from '@contracts/documentTasks.contract';
import { sourceConversionRunSchema } from '@contracts/sourceConversion.contract';
import type {
  SourceConversionReadRequest,
  SourceConversionCancelRequest,
} from '@contracts/sourceConversion.contract';
import type { SourceRegistrationRequest } from '@contracts/sources.contract';
import { visualConnection, visualJob } from '../ai-sessions/visualFixtures';
import { listSourceProcessingSessions } from '@renderer/features/import-document-content/model/importProcessingSessions';

export const longTitle =
  '문서 처리 실패 후에도 원본과 이전 성공 결과가 보존되는지 확인하는 아주 긴 문서 제목 '
    .repeat(3)
    .trim();
export const fixtureRevision = 'e'.repeat(64);
export const fixtureAccess = {
  userId: 'fixture-user',
  tenant: 'fixture',
  profileId: 'default',
  domain: null,
  viewpoint: null,
  policyRevision: fixtureRevision,
};
export const fixtureConnection = {
  ...visualConnection,
  data: {
    ...visualConnection.data,
    workspaces: [
      {
        ...visualConnection.data.workspaces[0],
        permissions: ['read', 'source_write', 'write', 'ontology_write'],
      },
    ],
  },
};
const countersSchema = z.object({
  registrations: z.number(),
  creates: z.number(),
  conversions: z.number(),
  conversionCancels: z.number().default(0),
  analysisStarts: z.number(),
  analysisExecutes: z.number(),
  taskReads: z.number(),
  lists: z.number(),
});
const fixtureStoreSchema = z.object({
  tasks: z.array(documentTaskSchema),
  analysis: z.record(z.string(), analysisDetailSchema),
  counters: countersSchema,
});
type FixtureStore = z.infer<typeof fixtureStoreSchema>;
type FixtureScenario =
  | 'empty'
  | 'unknown'
  | 'linked'
  | 'previous-success'
  | 'running';
const storageKey = 'wiki-isolated-document-task-fixture';

/** 이 테스트의 합성 응답만 보관하며 실제 보호 저장 검증과 구별합니다. */
function emptyStore(): FixtureStore {
  return {
    tasks: [],
    analysis: {},
    counters: {
      registrations: 0,
      creates: 0,
      conversions: 0,
      conversionCancels: 0,
      analysisStarts: 0,
      analysisExecutes: 0,
      taskReads: 0,
      lists: 0,
    },
  };
}

/** renderer 재시작 전후에 동일한 모의 main 응답을 제공합니다. */
function loadStore(): FixtureStore {
  const value = localStorage.getItem(storageKey);
  return value ? fixtureStoreSchema.parse(JSON.parse(value)) : emptyStore();
}
let store = loadStore();
let nextTitle = longTitle;
let deny = false;

/** 합성 자료만 테스트 전용 Electron userData에 보관합니다. */
function persist(): void {
  localStorage.setItem(storageKey, JSON.stringify(store));
}

/** 공개 스키마를 통과한 원본 작업을 만들며 실제 변경 요청에는 쓰지 않습니다. */
function taskFixture(index: number, title: string): DocumentTask {
  const sourceId = index.toString(16).padStart(32, '0');
  const sourceVersion = (index + 100).toString(16).padStart(32, '0');
  const source = {
    sourceId,
    sourceVersion,
    sourceSha256: fixtureRevision,
    registrationRevision: fixtureRevision,
  };
  return documentTaskSchema.parse({
    taskId: (index + 200).toString(16).padStart(32, '0'),
    source,
    item: {
      kind: 'source',
      ...source,
      title,
      sizeBytes: 3400,
      format: 'pdf',
      linkedDocumentCount: 0,
      analysisStatus: 'not_started',
    },
    targetDocument: `fixture-${index}.md`,
    createdAt: '2026-11-23T04:00:00Z',
    updatedAt: '2026-11-23T04:01:00Z',
    conversions: [],
    analysisSummary: null,
    registration: {
      requestId: (index + 300).toString(16).padStart(32, '0'),
      state: 'not_started',
      jobId: null,
      errorCode: null,
    },
  });
}

/** worker_failed를 합성 실패 보고의 원래 진단 코드로 제공합니다. */
function failedConversion(
  task: DocumentTask,
  attempt: number,
): z.infer<typeof sourceConversionRunSchema> {
  return sourceConversionRunSchema.parse({
    requestId: (attempt + 400).toString(16).padStart(32, '0'),
    source: task.source,
    state: 'partial',
    format: 'pdf',
    progress: { stage: 'convert', completed: 73, total: 170 },
    receiptState: 'saved',
    reference: null,
    message: '원본은 보관됐지만 전체 본문 변환을 완료하지 못했습니다.',
    diagnosticCodes: ['worker_failed'],
    cleanupWarning: false,
    report: {
      method: 'ocr',
      units: [],
      complete: false,
      unread_ranges: ['remaining source: worker_failed'],
      warnings: [],
      origin: 'client_reported',
      coverage: 'reported_units_only',
      original_coverage: 'not_verified',
      semantic_validation: 'not_run',
      diagnostics: [],
      unit_methods: {},
    },
  });
}

/** 항목의 고정 참조와 일치하는 합성 분석 결과만 만듭니다. */
function linkedAnalysis(
  task: DocumentTask,
  previousFailure: boolean,
): AnalysisDetail {
  const detail = visualJob(task.targetDocument, task.item.title);
  detail.job.source_ref = {
    source_id: task.source.sourceId,
    source_version: task.source.sourceVersion,
    source_sha256: task.source.sourceSha256,
    registration_revision: task.source.registrationRevision,
    size_bytes: task.item.sizeBytes,
  };
  detail.job.request_id = task.registration.requestId;
  if (previousFailure) {
    detail.job.outputs = ['wiki', 'ontology'];
    detail.job.result_summary.status = 'partial';
    detail.job.result_summary.required_count = 2;
    detail.job.result_summary.results = detail.job.result_summary.results.map(
      (
        result: AnalysisDetail['job']['result_summary']['results'][number],
      ): AnalysisDetail['job']['result_summary']['results'][number] => ({
        ...result,
        current_run: false,
      }),
    );
    detail.job.reported_status = 'failed';
    detail.local = {
      status: 'failed',
      message:
        '이번 관계 추출은 실패했지만 이전 Wiki 문서는 보존되어 있습니다.',
    };
  }
  return analysisDetailSchema.parse(detail);
}

/** 보고 내용과 별도로 저장된 현재 시도 상태를 정확히 복원합니다. */
function currentConversion(
  task: DocumentTask,
): z.infer<typeof sourceConversionRunSchema> | null {
  const attempt = task.conversions.at(-1);
  if (!attempt) return null;
  const {
    startedAt: _startedAt,
    updatedAt: _updatedAt,
    reportSummary: _reportSummary,
    ...summary
  } = attempt;
  return sourceConversionRunSchema.parse({
    ...failedConversion(task, 1),
    ...summary,
  });
}

/** 상태만 준비하며 화면 열기가 실제 실행을 유발하는지 계수로 확인합니다. */
function scenario(mode: FixtureScenario): void {
  store = emptyStore();
  deny = false;
  if (mode !== 'empty') {
    const task = taskFixture(1, longTitle);
    if (mode === 'unknown') task.registration.state = 'unconfirmed';
    else if (mode === 'running') {
      const { report: _report, ...run } = failedConversion(task, 1);
      task.conversions.push({
        ...run,
        state: 'running',
        receiptState: 'not_submitted',
        message: '원본에서 문자를 읽고 있습니다.',
        startedAt: task.createdAt,
        updatedAt: task.updatedAt,
        reportSummary: null,
      });
    } else {
      const detail = linkedAnalysis(task, mode === 'previous-success');
      task.registration.state = 'linked';
      task.registration.jobId = detail.job.job_id;
      task.analysisSummary = {
        state: detail.job.state,
        reportedStatus: detail.job.reported_status,
        resultStatus: detail.job.result_summary.status,
        basisStatus: detail.job.basis_status,
        updatedAt: task.updatedAt,
      };
      store.analysis[task.taskId] = detail;
    }
    store.tasks = [documentTaskSchema.parse(task)];
  }
  persist();
}

/** 합성 fixture만 조작하는 제어기이며 제품 코드는 이 이름을 참조하지 않습니다. */
export function installFixtureBridge(): void {
  Reflect.set(window, '__documentTaskChecks', {
    snapshot: (): FixtureStore => structuredClone(store),
    processing: (): unknown =>
      listSourceProcessingSessions({
        connectionId: 'fixture',
        userId: 'fixture-user',
        tenant: 'fixture',
        profileId: 'default',
        policyRevision: fixtureRevision,
      }).map(
        (
          entry: ReturnType<typeof listSourceProcessingSessions>[number],
        ): unknown => ({
          source: entry.registered.item,
          target: entry.targetDocument,
          snapshot: entry.session.getSnapshot(),
        }),
      ),
    scenario,
    nextTitle: (title: string): void => {
      nextTitle = title;
    },
    deny: (): void => {
      deny = true;
      window.dispatchEvent(new Event('wiki-connection-changed'));
    },
  });
  const forbidden = {
    ok: false,
    error: {
      code: 'forbidden',
      status: 403,
      message: '작업 공간 접근이 거부되었습니다.',
    },
  };
  Object.defineProperty(window, 'wiki', {
    configurable: true,
    value: {
      connection: {
        getState: async (): Promise<unknown> =>
          deny ? forbidden : fixtureConnection,
      },
      runtime: {
        execute: async (): Promise<unknown> => ({
          ok: false,
          error: {
            code: 'fixture',
            message: '실제 AI를 사용하지 않는 검증입니다.',
          },
        }),
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
      questionRuns: {
        list: async (): Promise<unknown> => ({
          ok: true,
          data: { items: [], nextCursor: null, incomplete: false },
        }),
      },
      documents: {
        content: async (): Promise<unknown> => ({
          ok: false,
          error: { code: 'not_found', message: '격리된 문서가 없습니다.' },
        }),
      },
      sources: {
        chooseFile: async (): Promise<unknown> => ({
          ok: true,
          data: {
            fileId: 'f'.repeat(32),
            filename: `${nextTitle}.pdf`,
            format: 'pdf',
            sizeBytes: 3400,
          },
        }),
        register: async (
          request: SourceRegistrationRequest,
        ): Promise<unknown> => {
          store.counters.registrations += 1;
          const item = taskFixture(
            store.counters.registrations,
            request.title,
          ).item;
          persist();
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              requestId: request.requestId,
              cleanupWarningCount: 0,
              access: fixtureAccess,
              state: 'complete',
              item,
            },
          };
        },
      },
      documentTasks: {
        create: async (
          request: DocumentTaskCreateRequest,
        ): Promise<unknown> => {
          store.counters.creates += 1;
          const task = taskFixture(store.counters.creates, request.item.title);
          task.item = request.item;
          task.source = {
            sourceId: request.item.sourceId,
            sourceVersion: request.item.sourceVersion,
            sourceSha256: request.item.sourceSha256,
            registrationRevision: request.item.registrationRevision,
          };
          task.targetDocument = request.targetDocument;
          store.tasks.push(documentTaskSchema.parse(task));
          persist();
          return { ok: true, data: task };
        },
        list: async (): Promise<unknown> => {
          store.counters.lists += 1;
          persist();
          return deny
            ? forbidden
            : {
                ok: true,
                data: {
                  items: structuredClone(store.tasks),
                  scope: 'this_device',
                  cleanupWarningCount: 0,
                },
              };
        },
        read: async (request: DocumentTaskReadRequest): Promise<unknown> => {
          store.counters.taskReads += 1;
          persist();
          if (deny) return forbidden;
          const task = store.tasks.find(
            (value: DocumentTask): boolean => value.taskId === request.taskId,
          );
          if (!task)
            return {
              ok: false,
              error: { code: 'not_found', message: '선택한 작업이 없습니다.' },
            };
          const conversion = currentConversion(task);
          return documentTaskDetailResultSchema.parse({
            ok: true,
            data: {
              task: structuredClone(task),
              conversion,
              analysis: store.analysis[task.taskId] ?? null,
              errors:
                task.registration.state === 'unconfirmed'
                  ? [
                      {
                        stage: 'analysis',
                        code: 'creation_unconfirmed',
                        message:
                          '같은 요청의 접수 결과를 아직 확인하지 못했습니다.',
                      },
                    ]
                  : [],
            },
          });
        },
      },
      sourceConversion: {
        read: async (
          request: SourceConversionReadRequest,
        ): Promise<unknown> => {
          const task = store.tasks.find(
            (value: DocumentTask): boolean => value.taskId === request.taskId,
          );
          return {
            ok: true,
            data: task ? currentConversion(task) : null,
          };
        },
        cancel: async (
          request: SourceConversionCancelRequest,
        ): Promise<unknown> => {
          const task = store.tasks.find(
            (value: DocumentTask): boolean => value.taskId === request.taskId,
          );
          const attempt = task?.conversions.at(-1);
          if (
            !task ||
            !attempt ||
            attempt.requestId !== request.requestId ||
            task.source.sourceId !== request.sourceId
          )
            throw new Error('Wrong conversion cancellation target');
          store.counters.conversionCancels += 1;
          attempt.state = 'cancelled';
          attempt.message = '이 기기의 변환을 중단했습니다. 원본은 보존됩니다.';
          persist();
          return { ok: true, data: currentConversion(task) };
        },
        start: async (
          request: SourceConversionReadRequest,
        ): Promise<unknown> => {
          const task = store.tasks.find(
            (value: DocumentTask): boolean => value.taskId === request.taskId,
          );
          if (!task)
            throw new Error('Conversion started before durable task creation');
          store.counters.conversions += 1;
          const run = failedConversion(task, store.counters.conversions);
          const { report, ...summary } = run;
          task.conversions.push({
            ...summary,
            startedAt: task.createdAt,
            updatedAt: task.updatedAt,
            reportSummary: report
              ? {
                  complete: report.complete,
                  unreadRanges: report.unread_ranges,
                  warnings: report.warnings,
                }
              : null,
          });
          persist();
          return { ok: true, data: run };
        },
      },
      analysis: {
        list: async (): Promise<unknown> => ({
          ok: true,
          data: {
            items: Object.values(store.analysis).map(
              (detail: AnalysisDetail): AnalysisDetail['job'] => detail.job,
            ),
            nextCursor: null,
            complete: true,
            truncated: false,
            skippedCount: 0,
            requiresRefresh: false,
          },
        }),
        read: async (request: { jobId: string }): Promise<unknown> => ({
          ok: true,
          data: Object.values(store.analysis).find(
            (detail: AnalysisDetail): boolean =>
              detail.job.job_id === request.jobId,
          ),
        }),
        inspectExecution: async (request: {
          jobId: string;
        }): Promise<unknown> => ({
          ok: true,
          data: {
            detail: Object.values(store.analysis).find(
              (detail: AnalysisDetail): boolean =>
                detail.job.job_id === request.jobId,
            ),
            mode: null,
            blockers: ['이 검증에서는 AI를 실행하지 않습니다.'],
            checkedAt: '2026-11-23T04:00:00Z',
          },
        }),
        start: async (): Promise<never> => {
          store.counters.analysisStarts += 1;
          persist();
          throw new Error('Unexpected analysis registration');
        },
        execute: async (): Promise<never> => {
          store.counters.analysisExecutes += 1;
          persist();
          throw new Error('Unexpected AI execution');
        },
      },
    },
  });
}

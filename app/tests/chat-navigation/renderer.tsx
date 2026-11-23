import { StrictMode, useState, useEffect } from 'react';
import type { JSX } from 'react';
import { WorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import {
  workspaceRequestSchema,
  type WorkspaceRequest,
} from '@contracts/workspace.contract';
import type {
  QuestionDetail,
  QuestionCommentary,
  QuestionLocal,
  QuestionCreateRequest,
  QuestionStartRequest,
  QuestionClarificationOptionDetail,
} from '@contracts/questionRuns.contract';
import type {
  RecoveryRequest,
  RecoveryEntry,
} from '@contracts/recovery.contract';
import { KnowledgeChatPage } from '@renderer/pages/chat/KnowledgeChatPage';
import { emptyChat } from '@renderer/features/chat-with-knowledge/model/chatState';
import type {
  ChatEnvelope,
  ChatTurn,
} from '@renderer/features/chat-with-knowledge/model/chatState';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import { AppShell } from '@renderer/app/AppShell';
import { visualActivity } from '../ai-sessions/visualFixtures';
const visual = new URLSearchParams(location.search).has('visual');
const clarificationMode = new URLSearchParams(location.search).has(
  'clarification',
);
const optionDetailsMode = new URLSearchParams(location.search).get(
  'option-details',
);
const optionDetails: QuestionClarificationOptionDetail[] | undefined =
  optionDetailsMode
    ? [
        {
          option: '상한 초과',
          description: '상한값보다 높을 때 발생하는 경고와 예외를 정리합니다.',
          recommended: false,
        },
        {
          option: '하한 미달',
          description: '하한값보다 낮을 때 발생하는 경고와 예외를 정리합니다.',
          recommended: optionDetailsMode === 'recommended',
        },
      ]
    : undefined;

const a = 'a'.repeat(32);
const b = 'b'.repeat(32);
const t1 = '1'.repeat(32);
const t2 = '2'.repeat(32);
const answer = '3'.repeat(32);
const rev = 'f'.repeat(64);
const scope = {
  userId: 'test-user',
  tenant: 'test',
  profileId: 'default',
  policyRevision: rev,
};
const calls: WorkspaceRequest[] = [];
let entry: RecoveryEntry = {
  kind: 'question-runs',
  key: 'renewal-chat',
  revision: rev,
  savedAt: '2026-10-29T00:00:00.000Z',
  payload: JSON.stringify({
    activeId: t1,
    pending: null,
    threads: [
      {
        ...emptyChat(),
        id: t1,
        conversationId: a,
        title: visual ? '센서 경고 조건 정리' : '대화 A',
        draft: visual || clarificationMode ? '' : 'A의 초안',
        runId: visual ? null : '7'.repeat(32),
      },
      {
        ...emptyChat(),
        id: t2,
        conversationId: b,
        title: visual ? '운전 모드 검토' : '대화 B',
        draft: visual ? '' : 'B의 초안',
      },
    ],
  }),
};
const connection = {
  ok: true,
  data: {
    status: 'connected',
    connectionId: 'fixture',
    userId: scope.userId,
    policyRevision: rev,
    selection: { tenant: 'test', profile: 'default' },
    serverUrl: 'http://fixture.invalid',
    displayName: '디자인 검증',
    checkedAt: '2026-10-31T02:00:00Z',
    workspaces: [
      {
        id: 'test',
        displayName: '제품 연구',
        permissions: ['read', 'conversation_write', 'result_write'],
        profiles: [{ id: 'default' }],
      },
    ],
  },
};
// 내 폴더 결과물 저장소 모의: 요청 ID별 기록이며 failSave가 켜지면 새 저장만 실패합니다.
const savedResults = new Map<string, Record<string, unknown>>();
// 같은 실행의 중간 단계와 확정 답변을 별도로 바꿔 폴링·종료 화면을 검증합니다.
const run: {
  phase: string;
  preview: string;
  commentaries: QuestionCommentary[];
  status: QuestionDetail['status'];
  localStatus: QuestionLocal['status'];
  savedAnswer: boolean;
  errorCode: string | null;
} = {
  phase: 'starting',
  preview: '',
  commentaries: [],
  status: 'running',
  localStatus: 'running',
  savedAnswer: false,
  errorCode: null,
};
const checks = {
  failSave: false,
  answerMode: 'ordinary' as 'ordinary' | 'file' | 'empty' | 'failed',
  forgetSaved: (): void => savedResults.clear(),
  calls,
  activeRun: !visual,
  run,
  cancels: 0,
  cancelEnabled: false,
  localReads: 0,
  runReads: 0,
  delayLocal: false,
  localDelayed: false,
  releaseLocal: (): void => {},
  delayConversation: false,
  conversationDelayed: false,
  releaseConversation: (): void => {},
  delayExport: false,
  releaseExport: (): void => {},
  delayContext: false,
  releaseContext: (): void => {},
  clarificationOptions: ['상한 초과', '하한 미달'],
  clarificationOptionDetails: optionDetails,
  clarificationRevision: rev,
  replyId: '',
  replyContent: '',
  replyStarted: false,
  replyFinal: false,
  loseReplyResponse: false,
  delayReply: false,
  replyDelayed: false,
  releaseReply: (): void => {},
  creates: [] as QuestionCreateRequest[],
  starts: [] as string[],
  exports: [] as { title: string; content: string }[],
  setReadOnly: (): void => {
    connection.data.workspaces[0].permissions = ['read'];
  },
};
/** 추가 질문의 대기·응답·최종 결과를 서버 저장 기록으로 모의합니다. */
function clarificationRecord(): ChatEnvelope {
  const events: ChatTurn[] = [
    {
      id: '4'.repeat(32),
      role: 'user',
      content: '센서 경고 조건을 정리해 주세요.',
    },
    {
      id: 'e'.repeat(32),
      role: 'assistant',
      content: '상한 초과와 하한 미달 중 어떤 조건을 정리할까요?',
      reply_to: '4'.repeat(32),
      status: 'complete',
      clarification: {
        options: checks.clarificationOptions,
        ...(checks.clarificationOptionDetails === undefined
          ? {}
          : { option_details: checks.clarificationOptionDetails }),
      },
    },
  ];
  if (checks.replyId)
    events.push({
      id: checks.replyId,
      role: 'user',
      content: checks.replyContent,
      clarification_turn_id: 'e'.repeat(32),
      status: 'complete',
    });
  if (checks.replyFinal)
    events.push({
      id: 'd'.repeat(32),
      role: 'assistant',
      content: '하한 미달 조건을 원래 자료에서 확인했습니다.',
      reply_to: checks.replyId,
      status: 'complete',
      citations: [],
    });
  return {
    revision: checks.clarificationRevision,
    record: {
      id: a,
      kind: 'conversations',
      tenant: 'test',
      user_id: scope.userId,
      data: { title: '추가 질문 대화' },
      events,
      requests: checks.replyId
        ? { [checks.replyId]: checks.clarificationRevision }
        : {},
    },
  };
}
/** 실행 접수는 사용자 전송 뒤에만 기록하며 다음 조회에서 최종 답변을 돌려줍니다. */
function clarificationDetail(runId: string): QuestionDetail {
  const continued = runId === '8'.repeat(32);
  const complete = !continued || checks.replyFinal;
  return {
    id: runId,
    conversationId: a,
    questionTurnId: continued ? checks.replyId : '4'.repeat(32),
    question: '센서 경고',
    profileId: 'default',
    basisRevision: rev,
    evidence: [],
    stateRevision: rev,
    status: complete ? 'complete' : checks.replyStarted ? 'running' : 'queued',
    progress: '',
    leaseStatus: !complete && checks.replyStarted ? 'active' : 'none',
    receipts: [],
    answers: complete
      ? [
          {
            turnId: continued ? 'd'.repeat(32) : 'e'.repeat(32),
            content: continued
              ? '하한 미달 조건을 원래 자료에서 확인했습니다.'
              : '상한 초과와 하한 미달 중 어떤 조건을 정리할까요?',
            citations: [],
            ...(!continued
              ? {
                  clarification: {
                    options: checks.clarificationOptions,
                    ...(checks.clarificationOptionDetails === undefined
                      ? {}
                      : { option_details: checks.clarificationOptionDetails }),
                  },
                }
              : {}),
          },
        ]
      : [],
    answerReadError: null,
    local: {
      status: !complete && checks.replyStarted ? 'running' : 'exited',
      phase: '',
      preview: '',
      requestId: null,
      errorCode: null,
      cleanupWarning: false,
    },
  };
}
let localSequence = 0;
const localSnapshots = new Map<
  string,
  { serialized: string; local: QuestionLocal }
>();
/** 로컬 상태와 서버 조회가 다른 시점에 도착하는 상황을 같은 순서 번호로 모의합니다. */
function localFor(runId: string): QuestionLocal {
  const value: QuestionLocal = {
    status:
      checks.activeRun && runId === '7'.repeat(32)
        ? checks.run.localStatus
        : 'idle',
    phase: runId === '7'.repeat(32) ? checks.run.phase : '',
    preview: runId === '7'.repeat(32) ? checks.run.preview : '',
    commentaries: runId === '7'.repeat(32) ? checks.run.commentaries : [],
    requestId: null,
    errorCode: runId === '7'.repeat(32) ? checks.run.errorCode : null,
    cleanupWarning: false,
  };
  const serialized = JSON.stringify(value);
  const previous = localSnapshots.get(runId);
  if (previous?.serialized === serialized) return previous.local;
  const local = { ...structuredClone(value), sequence: ++localSequence };
  localSnapshots.set(runId, { serialized, local });
  return local;
}
Object.defineProperty(window, '__chatChecks', { value: checks });
Object.defineProperty(window, 'wiki', {
  value: {
    ...(visual
      ? {
          aiSessions: {
            read: async (): Promise<unknown> =>
              visualActivity.ok
                ? {
                    ...visualActivity,
                    data: { ...visualActivity.data, activities: [] },
                  }
                : visualActivity,
          },
        }
      : {}),
    connection: { getState: async (): Promise<unknown> => connection },
    // 내려받기는 파일 저장 창을 여는 호스트 기능이므로 요청만 기록합니다.
    fileExports: {
      exportMarkdown: async (request: {
        title: string;
        content: string;
      }): Promise<unknown> => {
        if (checks.delayExport)
          await new Promise<void>((done: () => void): void => {
            checks.releaseExport = done;
          });
        checks.exports.push({ title: request.title, content: request.content });
        return { ok: true, data: { started: true } };
      },
    },
    recovery: {
      execute: async (request: RecoveryRequest): Promise<unknown> => {
        if (request.operation === 'put')
          entry = { ...entry, payload: request.payload };
        return { ok: true, data: { entries: [entry], cleanupWarningCount: 0 } };
      },
    },
    runtime: {
      execute: async (): Promise<unknown> => ({
        ok: true,
        data: {
          activeProvider: 'codex',
          checks: [],
          settings: {},
          cliConnection: { status: 'connected' },
        },
      }),
    },
    questionRuns: {
      create: async (request: QuestionCreateRequest): Promise<unknown> => {
        checks.creates.push(request);
        return { ok: true, data: clarificationDetail('8'.repeat(32)) };
      },
      start: async (request: QuestionStartRequest): Promise<unknown> => {
        checks.starts.push(request.questionRunId);
        checks.replyStarted = true;
        return { ok: true, data: clarificationDetail(request.questionRunId) };
      },
      readLocal: async (request: {
        questionRunId: string;
      }): Promise<unknown> => {
        checks.localReads += 1;
        if (clarificationMode) return { ok: true, data: null };
        const result = {
          ok: true,
          data: {
            runId: request.questionRunId,
            local: localFor(request.questionRunId),
          },
        };
        if (checks.delayLocal) {
          checks.localDelayed = true;
          await new Promise<void>((resolve: () => void): void => {
            checks.releaseLocal = resolve;
          });
        }
        return result;
      },
      async cancel(request: { questionRunId: string }): Promise<unknown> {
        checks.cancels += 1;
        if (checks.cancelEnabled) {
          checks.run.status = 'cancelled';
          checks.run.localStatus = 'exited';
          return this.read(request);
        }
        return {
          ok: false,
          error: { code: 'unexpected', message: '이동 중 중단됨' },
        };
      },
      read: async (request: { questionRunId: string }): Promise<unknown> => (
        (checks.runReads += 1),
        clarificationMode
          ? ((checks.replyFinal = checks.replyStarted),
            { ok: true, data: clarificationDetail(request.questionRunId) })
          : {
              ok: true,
              data: {
                id: request.questionRunId,
                conversationId:
                  request.questionRunId === '7'.repeat(32) ? a : b,
                questionTurnId: '4'.repeat(32),
                question: '저장 질문',
                profileId: 'default',
                basisRevision: rev,
                evidence: [],
                stateRevision: rev,
                status:
                  checks.activeRun && request.questionRunId === '7'.repeat(32)
                    ? checks.run.status
                    : 'complete',
                progress: '',
                leaseStatus:
                  checks.activeRun &&
                  checks.run.status === 'running' &&
                  request.questionRunId === '7'.repeat(32)
                    ? 'active'
                    : 'none',
                receipts: [],
                answers:
                  request.questionRunId === '6'.repeat(32)
                    ? [
                        {
                          turnId: answer,
                          content: '답변',
                          citations: [
                            {
                              kind: 'document',
                              document: 'example.md',
                              quote: '원문 인용',
                              start_line: 1,
                              end_line: 1,
                            },
                            {
                              kind: 'document',
                              document: 'second.md',
                              quote: '두 번째 원문의 인용',
                              start_line: 2,
                              end_line: 3,
                            },
                          ],
                        },
                      ]
                    : request.questionRunId === '7'.repeat(32) &&
                        checks.run.savedAnswer
                      ? [
                          {
                            turnId: 'e'.repeat(32),
                            content: '완성된 최종 답변입니다.',
                            citations: [],
                          },
                        ]
                      : [],
                answerReadError: null,
                local: localFor(request.questionRunId),
              },
            }
      ),
    },
    workspace: {
      execute: async (request: WorkspaceRequest): Promise<unknown> => {
        workspaceRequestSchema.parse(request);
        calls.push(request);
        if (clarificationMode && request.operation === 'appendTurn') {
          if (checks.delayReply) {
            checks.replyDelayed = true;
            await new Promise<void>((done: () => void): void => {
              checks.releaseReply = done;
            });
          }
          checks.replyId = request.input.request_id;
          checks.replyContent = request.input.content;
          checks.clarificationRevision = '2'.repeat(64);
          if (checks.loseReplyResponse)
            return {
              ok: false,
              error: {
                code: 'outcome_unknown',
                message: '응답 저장 결과 미확인',
                outcomeUnknown: true,
              },
            };
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              access: scope,
              operation: request.operation,
              data: clarificationRecord(),
            },
          };
        }
        if (
          clarificationMode &&
          request.operation === 'personalReceipt' &&
          request.input.request_id === checks.replyId
        )
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              access: scope,
              operation: request.operation,
              data: {
                ...clarificationRecord(),
                request_id: checks.replyId,
                request_confirmed: true,
              },
            },
          };
        if (request.operation === 'questionContext') {
          if (checks.delayContext)
            await new Promise<void>((done: () => void): void => {
              checks.releaseContext = done;
            });
          return {
            ok: false,
            error: {
              code: 'fixture_stop',
              status: 422,
              message: '범위 확인 후 AI 실행 전 중단',
            },
          };
        }
        if (request.operation === 'personalReceipt') {
          const found = savedResults.get(request.input.request_id);
          if (!found)
            return {
              ok: false,
              error: { code: 'not_found', status: 404, message: '없는 요청' },
            };
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              access: scope,
              operation: request.operation,
              data: { revision: rev, record: found },
            },
          };
        }
        if (request.operation === 'createSavedResult') {
          if (checks.failSave)
            return {
              ok: false,
              error: { code: 'unavailable', status: 503, message: '저장 실패' },
            };
          const record = {
            id: 'c'.repeat(32),
            kind: 'saved-results',
            tenant: 'test',
            user_id: scope.userId,
            data: {
              title: request.input.title,
              content: '저장 당시 답변 본문',
            },
            requests: { [request.input.request_id]: rev },
          };
          savedResults.set(request.input.request_id, record);
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              access: scope,
              operation: request.operation,
              data: { revision: rev, record },
            },
          };
        }
        if (request.operation === 'conversation') {
          const id = request.input.record_id;
          if (clarificationMode && id === a)
            return {
              ok: true,
              data: {
                connectionId: 'fixture',
                access: scope,
                operation: request.operation,
                data: clarificationRecord(),
              },
            };
          if (![a, b].includes(id))
            return {
              ok: false,
              error: { code: 'not_found', status: 404, message: '없는 대화' },
            };
          // refresh가 실행 상세를 이미 받은 뒤 대화 본문만 늦게 도착하는 경합입니다.
          if (id === a && checks.delayConversation) {
            checks.conversationDelayed = true;
            await new Promise<void>((done: () => void): void => {
              checks.releaseConversation = (): void => {
                checks.delayConversation = false;
                done();
              };
            });
          }
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              access: scope,
              operation: request.operation,
              data: {
                revision: rev,
                record: {
                  id,
                  kind: 'conversations',
                  tenant: 'test',
                  user_id: scope.userId,
                  data: {
                    title: visual
                      ? '센서 경고 조건 정리'
                      : id === a
                        ? '대화 A'
                        : '대화 B',
                  },
                  requests: {},
                  events: [
                    {
                      id: '4'.repeat(32),
                      role: 'user',
                      content: visual
                        ? '센서가 경고를 보내는 조건을 정리하고, 운전 모드가 바뀔 때 확인할 점을 알려줘.'
                        : '저장된 질문',
                    },
                    {
                      id: id === a ? 'e'.repeat(32) : answer,
                      role: 'assistant',
                      content: visual
                        ? '## 경고가 발생하는 조건\n\n센서는 온도가 설정 범위를 벗어나면 경고 신호를 보냅니다. 문서에 명시된 조건과 운전 모드 전환 시의 처리를 나누어 확인했습니다.\n\n- **온도 범위 이탈:** 설정된 상한 또는 하한을 벗어났는지 확인합니다.\n- **운전 모드 전환:** 전환 중에는 기존 경고 상태를 유지합니다.\n\n## 추가로 확인할 점\n\n경고를 해제하는 임계값과 복귀 지연 시간은 이 두 문서에서 확인되지 않았습니다. 적용 전에 해당 조건의 근거를 추가로 확인해야 합니다.'
                        : id === a && checks.run.savedAnswer
                          ? '완성된 최종 답변입니다.'
                          : checks.answerMode === 'empty'
                            ? '[[파일: md]]\n   '
                            : (checks.answerMode === 'ordinary'
                                ? ''
                                : '[[파일: md]]\n') +
                              Array.from(
                                { length: 40 },
                                (_: unknown, i: number): string =>
                                  `문단 ${i + 1}. 보존된 답변의 본문입니다.`,
                              ).join('\n\n'),
                      status:
                        !visual && checks.answerMode === 'failed'
                          ? 'failed'
                          : 'complete',
                      citations: [
                        {
                          kind: 'document',
                          document: visual
                            ? '설계/온도-센서-인터페이스.md'
                            : 'example.md',
                          quote: visual
                            ? '온도가 설정 범위를 벗어나면 경고 신호를 보낸다.'
                            : '원문 인용',
                          start_line: 1,
                          end_line: 1,
                        },
                        ...(visual || id === b
                          ? [
                              {
                                kind: 'document',
                                document: visual
                                  ? '설계/운전-모드-전환.md'
                                  : 'second.md',
                                quote: visual
                                  ? '운전 모드가 전환되는 동안 기존 경고 상태를 유지한다.'
                                  : '두 번째 원문의 인용',
                                start_line: 2,
                                end_line: 3,
                              },
                            ]
                          : []),
                      ],
                    },
                  ],
                },
              },
            },
          };
        }
        return {
          ok: false,
          error: {
            code: 'unexpected',
            status: 400,
            message: '이 테스트에서 허용하지 않은 작업',
          },
        };
      },
    },
  },
});
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
/** 보관된 비활성 화면에서 완료 응답이 주소를 바꾸는지 검증합니다. */
function TestActivity(): JSX.Element {
  const [active, setActive] = useState(true);
  useEffect((): (() => void) => {
    const change = (): void =>
      setActive(document.documentElement.dataset.active !== 'false');
    window.addEventListener('fixture-activity', change);
    return (): void => window.removeEventListener('fixture-activity', change);
  }, []);
  return (
    <WorkspaceActivity active={active}>
      <KnowledgeChatPage />
    </WorkspaceActivity>
  );
}
createRoot(root).render(
  <StrictMode>
    <ReadQueriesProvider identity="chat-navigation-fixture">
      <HashRouter>
        {visual ? (
          <AppShell>
            <TestActivity />
          </AppShell>
        ) : (
          <TestActivity />
        )}
      </HashRouter>
    </ReadQueriesProvider>
  </StrictMode>,
);

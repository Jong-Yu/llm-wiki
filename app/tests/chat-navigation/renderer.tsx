import { StrictMode, useState, useEffect } from 'react';
import type { JSX } from 'react';
import { WorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import type {
  RecoveryRequest,
  RecoveryEntry,
} from '@contracts/recovery.contract';
import { KnowledgeChatPage } from '@renderer/pages/chat/KnowledgeChatPage';
import { emptyChat } from '@renderer/features/chat-with-knowledge/model/chatState';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import { AppShell } from '@renderer/app/AppShell';
import { visualActivity } from '../ai-sessions/visualFixtures';
const visual = new URLSearchParams(location.search).has('visual');

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
        draft: visual ? '' : 'A의 초안',
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
const checks = {
  failSave: false,
  forgetSaved: (): void => savedResults.clear(),
  calls,
  activeRun: !visual,
  cancels: 0,
  delayExport: false,
  releaseExport: (): void => {},
  exports: [] as { title: string; content: string }[],
  setReadOnly: (): void => {
    connection.data.workspaces[0].permissions = ['read'];
  },
};
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
      cancel: async (): Promise<unknown> => {
        checks.cancels += 1;
        return {
          ok: false,
          error: { code: 'unexpected', message: '이동 중 중단됨' },
        };
      },
      read: async (request: { questionRunId: string }): Promise<unknown> => ({
        ok: true,
        data: {
          id: request.questionRunId,
          conversationId: request.questionRunId === '7'.repeat(32) ? a : b,
          questionTurnId: '4'.repeat(32),
          question: '저장 질문',
          profileId: 'default',
          basisRevision: rev,
          evidence: [],
          stateRevision: rev,
          status:
            checks.activeRun && request.questionRunId === '7'.repeat(32)
              ? 'running'
              : 'complete',
          progress: '',
          leaseStatus:
            checks.activeRun && request.questionRunId === '7'.repeat(32)
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
              : [],
          answerReadError: null,
          local: {
            status:
              checks.activeRun && request.questionRunId === '7'.repeat(32)
                ? 'running'
                : 'idle',
            phase: '',
            preview: '',
            requestId: null,
            errorCode: null,
            cleanupWarning: false,
          },
        },
      }),
    },
    workspace: {
      execute: async (request: WorkspaceRequest): Promise<unknown> => {
        calls.push(request);
        if (request.operation === 'questionContext')
          return {
            ok: false,
            error: {
              code: 'fixture_stop',
              status: 422,
              message: '범위 확인 후 AI 실행 전 중단',
            },
          };
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
          if (![a, b].includes(id))
            return {
              ok: false,
              error: { code: 'not_found', status: 404, message: '없는 대화' },
            };
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
                        : Array.from(
                            { length: 40 },
                            (_: unknown, i: number): string =>
                              `문단 ${i + 1}. 보존된 답변의 본문입니다.`,
                          ).join('\n\n'),
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
    <HashRouter>
      {visual ? (
        <AppShell>
          <TestActivity />
        </AppShell>
      ) : (
        <TestActivity />
      )}
    </HashRouter>
  </StrictMode>,
);

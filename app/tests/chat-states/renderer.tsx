import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import type { RecoveryEntry } from '@contracts/recovery.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import { KnowledgeChatPage } from '@renderer/pages/chat/KnowledgeChatPage';
import { AppShell } from '@renderer/app/AppShell';
import { emptyChat } from '@renderer/features/chat-with-knowledge/model/chatState';
import { NO_EVIDENCE_MARKER } from '@renderer/features/chat-with-knowledge/model/externalMaterial';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';

/** AI 채팅의 상태별 화면을 모의 자료로 띄웁니다. 주소의 ?state= 값으로 상태를 고릅니다. */
type State =
  | 'empty'
  | 'noai'
  | 'answer'
  | 'nowiki'
  | 'file'
  | 'chips'
  | 'running'
  | 'failed'
  | 'aibroken'
  | 'reload';
const state = (new URLSearchParams(location.search).get('state') ??
  'empty') as State;
const a = 'a'.repeat(32);
const t1 = '1'.repeat(32);
const q = '4'.repeat(32);
const run = '7'.repeat(32);
const rev = 'f'.repeat(64);
const scope = {
  userId: 'test-user',
  tenant: 'test',
  profileId: 'default',
  policyRevision: rev,
};
const hasConversation =
  state !== 'empty' && state !== 'noai' && state !== 'chips';
const hasAnswer =
  state === 'answer' ||
  state === 'reload' ||
  state === 'nowiki' ||
  state === 'file';
const noWiki = state === 'nowiki';
const question =
  state === 'file'
    ? '수주 사례별로 고객사·계약 기간·할인을 짝지어서 엑셀로 만들어줘'
    : noWiki
  ? '자동차 배터리 열관리 정책이 뭐야?' + NO_EVIDENCE_MARKER
  : '센서가 경고를 보내는 조건을 정리하고, 운전 모드가 바뀔 때 확인할 점을 알려줘.';
const answerText =
  state === 'file'
    ? '[[파일: md]]\n# 수주 사례 매핑\n\n수주 사례 2건을 표로 정리했어요. 3년 계약인 A사만 12% 할인이 적용돼요.\n\n| 고객사 | 계약 기간 | 할인 |\n| --- | --- | --- |\n| A사 | 3년 | 12% |\n| B사 | 1년 | 0% |'
    : noWiki
  ? '위키에는 배터리 열관리 정책 문서가 없습니다. 그래서 근거를 갖춘 답은 드릴 수 없어요.\n\n답을 받으려면 관련 자료(예: BMS 열관리 사양서)를 먼저 등록하거나, 차종·문서명 같은 구체적인 단어를 넣어 다시 물어봐 주세요.'
  : '## 경고가 발생하는 조건\n\n센서는 온도가 설정 범위를 벗어나면 경고 신호를 보냅니다. 문서에 명시된 조건과 운전 모드 전환 시의 처리를 나누어 확인했습니다.\n\n- **온도 범위 이탈:** 설정된 상한 또는 하한을 벗어났는지 확인합니다.\n- **운전 모드 전환:** 전환 중에는 기존 경고 상태를 유지합니다.\n\n## 추가로 확인할 점\n\n경고를 해제하는 임계값과 복귀 지연 시간은 이 두 문서에서 확인되지 않았습니다.';
const citations = [
  {
    kind: 'document',
    document: '설계/온도-센서-인터페이스.md',
    quote: '온도가 설정 범위를 벗어나면 경고 신호를 보낸다.',
    start_line: 1,
    end_line: 1,
  },
  {
    kind: 'document',
    document: '설계/운전-모드-전환.md',
    quote: '운전 모드가 전환되는 동안 기존 경고 상태를 유지한다.',
    start_line: 2,
    end_line: 3,
  },
];
const entry: RecoveryEntry = {
  kind: 'question-runs',
  key: 'renewal-chat',
  revision: rev,
  savedAt: '2026-11-03T00:00:00.000Z',
  payload: JSON.stringify({
    activeId: t1,
    pending: null,
    threads: [
      hasConversation
        ? {
            ...emptyChat(),
            id: t1,
            conversationId: a,
            questionTurnId: q,
            runId: run,
            title: '센서 경고 조건 정리',
          }
        : state === 'chips'
          ? {
              ...emptyChat(),
              id: t1,
              template: 'mapping-table',
              draft: '첨부한 자료를 우리 SWOT와 비교해 줘',
              attachments: [
                { id: '1', kind: 'text', name: '붙여넣은 텍스트 #1', text: 'a\n'.repeat(25), truncated: false },
                { id: '2', kind: 'text', name: '붙여넣은 텍스트 #2', text: 'a\nb\nc\nd', truncated: false },
                { id: '3', kind: 'file', name: '매핑_초안.xlsx', text: 'x'.repeat(3200), truncated: false },
                { id: '4', kind: 'file', name: '경쟁사_분석.pdf', text: 'x'.repeat(12000), truncated: true },
              ],
            }
          : { ...emptyChat(), id: t1 },
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
    checkedAt: '2026-11-03T02:00:00Z',
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
const broken = state === 'noai' || state === 'aibroken';
const runtimeData = {
  activeProvider: 'claude',
  activeModel: 'default',
  checks: broken
    ? [
        {
          name: 'Claude Code',
          status: 'missing',
          detail: 'Claude Code 실행 파일을 찾지 못했습니다.',
        },
      ]
    : [],
  settings: { models: { claude: 'default', codex: 'default' } },
  cliConnection: { status: broken ? 'idle' : 'connected', provider: 'claude' },
  restartRequired: false,
  saved: true,
  issue: null,
  platform: 'darwin',
};
const running = state === 'running';
const failed = state === 'failed' || state === 'aibroken';
Object.defineProperty(window, 'wiki', {
  value: {
    aiSessions: {
      read: async (): Promise<unknown> => ({
        ok: false,
        error: { code: 'unavailable', message: '이 화면에서는 읽지 않습니다.' },
      }),
    },
    connection: { getState: async (): Promise<unknown> => connection },
    fileExports: {
      exportMarkdown: async (): Promise<unknown> => ({
        ok: true,
        data: { started: true },
      }),
    },
    recovery: {
      execute: async (): Promise<unknown> => ({
        ok: true,
        data: { entries: [entry], cleanupWarningCount: 0 },
      }),
    },
    runtime: {
      execute: async (): Promise<unknown> => ({ ok: true, data: runtimeData }),
    },
    questionRuns: {
      cancel: async (): Promise<unknown> => ({ ok: true, data: {} }),
      resumable: async (): Promise<unknown> => ({
        resumable: state !== 'reload',
      }),
      searchTerms: async (): Promise<unknown> => ({ terms: [] }),
      read: async (): Promise<unknown> => ({
        ok: true,
        data: {
          id: run,
          conversationId: a,
          questionTurnId: q,
          question,
          profileId: 'default',
          basisRevision: rev,
          evidence: [],
          stateRevision: rev,
          status: hasAnswer ? 'complete' : failed ? 'failed' : 'running',
          progress: '',
          leaseStatus: running ? 'active' : 'none',
          receipts: [],
          answers: hasAnswer
            ? [{ turnId: '3'.repeat(32), content: answerText, citations }]
            : [],
          answerReadError: null,
          local: {
            status: running ? 'running' : failed ? 'failed' : 'idle',
            phase: running ? 'answering' : '',
            preview: running
              ? '센서는 온도가 설정 범위를 벗어나면 경고 신호를 보냅니다. 문서에 명시된 조건을 먼저 정리하면'
              : '',
            requestId: null,
            errorCode: state === 'aibroken' ? 'cli_not_found' : null,
            cleanupWarning: false,
          },
        },
      }),
    },
    workspace: {
      execute: async (request: WorkspaceRequest): Promise<unknown> => {
        if (request.operation === 'conversation')
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              access: scope,
              operation: request.operation,
              data: {
                revision: rev,
                record: {
                  id: a,
                  kind: 'conversations',
                  tenant: 'test',
                  user_id: scope.userId,
                  data: { title: '센서 경고 조건 정리' },
                  requests: {},
                  events: [
                    { id: q, role: 'user', content: question },
                    ...(hasAnswer
                      ? [
                          {
                            id: '3'.repeat(32),
                            role: 'assistant',
                            content: answerText,
                            citations,
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
          };
        return {
          ok: false,
          error: { code: 'unexpected', status: 400, message: '허용하지 않은 작업' },
        };
      },
    },
  },
});
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <AppShell>
        <KnowledgeChatPage />
      </AppShell>
    </HashRouter>
  </StrictMode>,
);

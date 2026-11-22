import { StrictMode } from 'react';
import type { ChangeEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import type {
  RecoveryEntry,
  RecoveryRequest,
} from '@contracts/recovery.contract';
import type {
  QuestionCreateRequest,
  QuestionDetail,
  QuestionReceipt,
  QuestionWebSearchRequest,
} from '@contracts/questionRuns.contract';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import { KnowledgeChatPage } from '@renderer/pages/chat/KnowledgeChatPage';
import { AppShell } from '@renderer/app/AppShell';
import { emptyChat } from '@renderer/features/chat-with-knowledge/model/chatState';
import type { ChatTurn } from '@renderer/features/chat-with-knowledge/model/chatState';
import {
  NO_EVIDENCE_MARKER,
  splitQuestion,
} from '@renderer/features/chat-with-knowledge/model/externalMaterial';
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
  | 'reload'
  | 'longquestion'
  | 'markdown'
  | 'script'
  | 'cancelled'
  | 'toolfailed'
  | 'disconnected';
const states: readonly State[] = [
  'empty',
  'noai',
  'answer',
  'nowiki',
  'file',
  'chips',
  'running',
  'failed',
  'aibroken',
  'reload',
  'longquestion',
  'markdown',
  'script',
  'cancelled',
  'toolfailed',
  'disconnected',
];
const stateNames: Record<State, string> = {
  empty: '첫 화면 · 질문 작성',
  noai: 'AI 연결 전',
  answer: '근거가 있는 답변',
  nowiki: '관련 문서 없음',
  file: '파일 답변',
  chips: '첨부한 질문',
  running: '답변 진행 중 · 중단',
  failed: '응답 실패',
  aibroken: 'AI 연결 오류',
  reload: '불러온 대화',
  longquestion: '긴 질문 · 더 보기',
  markdown: '마크다운 · 내려받기',
  script: '스크립트 안전 표시',
  cancelled: '응답 중단 후',
  toolfailed: '도구 실행 차단',
  disconnected: '서버 연결 끊김',
};
/** 알 수 없는 주소 입력은 첫 화면으로만 돌립니다. */
function isState(value: string | null): value is State {
  return states.some((candidate: State): boolean => candidate === value);
}
const requestedState = new URLSearchParams(location.search).get('state');
const state = isState(requestedState) ? requestedState : 'empty';
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
  state === 'file' ||
  state === 'longquestion' ||
  state === 'markdown' ||
  state === 'script' ||
  state === 'disconnected';
const noWiki = state === 'nowiki';
const initialTitle =
  state === 'file'
    ? '수주 사례 매핑'
    : state === 'script'
      ? 'HTML 답변 표시 안전성'
      : '센서 경고 조건 정리';
const question =
  state === 'file'
    ? '수주 사례별로 고객사·계약 기간·할인을 짝지어서 엑셀로 만들어줘'
    : state === 'longquestion'
      ? '센서 경고 조건을 검토하려고 합니다. 다음 항목을 순서대로 확인해 주세요.\n\n1. 상한 온도를 벗어날 때 경고가 발생하는지 확인해 주세요.\n2. 하한 온도를 벗어나는 경우도 같은 경고인지 확인해 주세요.\n3. 온도 단위와 측정 위치가 명시되어 있는지 확인해 주세요.\n4. 조건을 벗어난 뒤 바로 경고하는지 지연 시간이 있는지 구분해 주세요.\n5. 운전 모드 전환 중 경고 상태가 유지되는지 알려 주세요.\n6. 전환이 완료된 후 상태를 어떻게 판단하는지 확인해 주세요.\n7. 경고 해제 임계값이 별도로 있는지 찾아 주세요.\n8. 복귀 지연 시간이 명시되어 있는지 확인해 주세요.\n9. 확인한 문서와 해당 원문을 함께 보여 주세요.\n10. 문서에 없는 조건을 추측하지 말고 미확인으로 남겨 주세요.\n11. 구현 담당자가 확인할 항목을 목록으로 정리해 주세요.\n12. 마지막에 핵심 조건을 한 문장으로 요약해 주세요.'
      : state === 'markdown'
        ? '센서 경고 처리 절차를 비교표와 확인 순서, 설정 예시로 정리해줘.'
        : state === 'script'
          ? '답변에 HTML이나 스크립트가 들어오면 어떻게 안전하게 표시해야 할까? 실행되면 안 되는 예시도 보여줘.'
          : noWiki
            ? '자동차 배터리 열관리 정책이 뭐야?' + NO_EVIDENCE_MARKER
            : '센서가 경고를 보내는 조건을 정리하고, 운전 모드가 바뀔 때 확인할 점을 알려줘.';
const answerText =
  state === 'file'
    ? '[[파일: md]]\n# 수주 사례 매핑\n\n수주 사례 2건을 표로 정리했어요. 3년 계약인 A사만 12% 할인이 적용돼요.\n\n| 고객사 | 계약 기간 | 할인 |\n| --- | --- | --- |\n| A사 | 3년 | 12% |\n| B사 | 1년 | 0% |'
    : state === 'markdown'
      ? '# 센서 경고 처리 안내\n\n센서는 설정 범위를 벗어나면 경고를 보내며, 운전 모드가 바뀌는 동안에는 기존 경고를 유지합니다.\n\n## 조건 비교\n\n| 상황 | 처리 | 확인할 근거 |\n| --- | --- | --- |\n| 온도 범위 이탈 | 경고 신호 전송 | 온도 센서 인터페이스 |\n| 운전 모드 전환 | 기존 경고 유지 | 운전 모드 전환 |\n| 정상 범위 복귀 | 해제 조건 미확인 | 추가 사양 확인 필요 |\n\n## 확인 순서\n\n1. 현재 온도가 설정 범위를 벗어났는지 확인합니다.\n2. 운전 모드가 전환 중이면 기존 경고 상태를 유지합니다.\n3. 경고 해제 임계값과 복귀 지연 시간은 추가 자료에서 확인합니다.\n\n### 검토용 설정 예시\n\n아래 값은 동작을 설명하기 위한 예시이며 실제 제품 설정이 아닙니다.\n\n```json\n{\n  "warning": "out_of_range",\n  "mode_transition": "preserve_warning"\n}\n```\n\n> 운전 모드가 전환되는 동안 기존 경고 상태를 유지한다.\n\n- **확인됨:** 온도 이탈과 모드 전환의 경고 처리\n- **미확인:** 경고 해제 임계값과 복귀 지연 시간'
      : state === 'script'
        ? 'HTML 태그가 포함된 답변은 태그를 실행하지 않고 텍스트로 표시해야 합니다. 아래는 script 태그와 이미지 오류 이벤트가 실행되지 않는지 확인하는 예시입니다.\n\n```html\n<script>window.__injected = true</script><img src=x onerror="window.__injected = true">\n```\n\n<script>window.__injected = true</script><img src=x onerror="window.__injected = true">\n\n이 예시는 문자로만 보여야 하며, 스크립트 실행이나 이미지 요청이 발생해서는 안 됩니다.'
        : noWiki
          ? '위키에는 배터리 열관리 정책 문서가 없습니다. 그래서 근거를 갖춘 답은 드릴 수 없어요.\n\n답을 받으려면 관련 자료(예: BMS 열관리 사양서)를 먼저 등록하거나, 차종·문서명 같은 구체적인 단어를 넣어 다시 물어봐 주세요.'
          : '## 경고가 발생하는 조건\n\n센서는 온도가 설정 범위를 벗어나면 경고 신호를 보냅니다. 문서에 명시된 조건과 운전 모드 전환 시의 처리를 나누어 확인했습니다.\n\n- **온도 범위 이탈:** 설정된 상한 또는 하한을 벗어났는지 확인합니다.\n- **운전 모드 전환:** 전환 중에는 기존 경고 상태를 유지합니다.\n\n## 추가로 확인할 점\n\n경고를 해제하는 임계값과 복귀 지연 시간은 이 두 문서에서 확인되지 않았습니다.';
const sensorCitations = [
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
const citations =
  noWiki || state === 'script'
    ? []
    : state === 'file'
      ? [
          {
            kind: 'document',
            document: '영업/수주-사례.md',
            quote:
              'A사는 3년 계약으로 12% 할인을 적용하고 B사는 1년 계약으로 할인을 적용하지 않는다.',
            start_line: 1,
            end_line: 2,
          },
        ]
      : sensorCitations;
let entry: RecoveryEntry | null = {
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
            title: initialTitle,
          }
        : state === 'chips'
          ? {
              ...emptyChat(),
              id: t1,
              template: 'mapping-table',
              draft: '첨부한 자료를 우리 SWOT와 비교해 줘',
              attachments: [
                {
                  id: '1',
                  kind: 'text',
                  name: '붙여넣은 텍스트 #1',
                  text: 'a\n'.repeat(25),
                  truncated: false,
                },
                {
                  id: '2',
                  kind: 'text',
                  name: '붙여넣은 텍스트 #2',
                  text: 'a\nb\nc\nd',
                  truncated: false,
                },
                {
                  id: '3',
                  kind: 'file',
                  name: '매핑_초안.xlsx',
                  text: 'x'.repeat(3200),
                  truncated: false,
                },
                {
                  id: '4',
                  kind: 'file',
                  name: '경쟁사_분석.pdf',
                  text: 'x'.repeat(12000),
                  truncated: true,
                },
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
    serverUnreachable: state === 'disconnected',
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
  cliConnection: {
    status: broken ? 'idle' : 'connected',
    provider: 'claude',
    verifiedAt: broken ? null : '2026-11-10T01:00:00.000Z',
  },
  restartRequired: false,
  saved: true,
  issue: null,
  platform: 'darwin',
};
const failed =
  state === 'failed' || state === 'aibroken' || state === 'toolfailed';
let runStatus: QuestionDetail['status'] = hasAnswer
  ? 'complete'
  : state === 'cancelled'
    ? 'cancelled'
    : failed
      ? 'failed'
      : state === 'running'
        ? 'running'
        : 'queued';
let currentQuestion = question;
let currentQuestionId = q;
let currentRunId = run;
let conversationTitle = initialTitle;
let conversationRevision = rev;
let revisionCount = 0;
let completionTimer: number | null = null;
let preview =
  state === 'running'
    ? '센서는 온도가 설정 범위를 벗어나면 경고 신호를 보냅니다. 운전 모드 전환 중의 경고 상태도 확인하고 있습니다.'
    : '';
const events: ChatTurn[] = [];
const conversationRequests = new Map<string, string>();
const runReceipts: QuestionReceipt[] = [];
if (hasConversation) events.push({ id: q, role: 'user', content: question });
if (hasConversation) conversationRequests.set(q, rev);
if (hasAnswer)
  events.push({
    id: '3'.repeat(32),
    role: 'assistant',
    reply_to: q,
    content: answerText,
    citations,
  });
if (hasAnswer) runReceipts.push(completedReceipt('3'.repeat(32)));
/** 저장 완료된 답변과 대화 판본을 연결하여 후속 초안을 안전하게 유지합니다. */
function completedReceipt(answerId: string): QuestionReceipt {
  return {
    record_id: answerId,
    request_id: answerId,
    state: 'complete',
    saved: true,
    receipt: {
      conversation_id: a,
      conversation_revision: conversationRevision,
      answer_turn_id: answerId,
      question_run_id: currentRunId,
      basis_snapshot_revision: rev,
      human_approval: false,
      semantic_validation: 'not_run',
      citation_validation: 'fixture',
      execution: {},
    },
    cleanup_failures: [],
  };
}
/** 모의 변경만 메모리에서 반영하여 다음 질문과 완료 답변의 판본을 구분합니다. */
function advanceRevision(): string {
  revisionCount += 1;
  return revisionCount.toString(16).padStart(64, '0');
}
/** 실제 계약에 맞는 상태를 읽되 파일·AI·서버에는 접근하지 않습니다. */
function readRun(): QuestionDetail {
  const active = runStatus === 'running';
  return {
    id: currentRunId,
    conversationId: a,
    questionTurnId: currentQuestionId,
    question: currentQuestion,
    profileId: 'default',
    basisRevision: rev,
    evidence: citations.map(
      (
        citation: (typeof citations)[number],
      ): QuestionDetail['evidence'][number] => ({
        kind: 'document',
        label: citation.document,
        sourceRevision: rev,
        graphRevision: null,
        stateRevision: null,
        sourceId: null,
        sourceVersion: null,
      }),
    ),
    stateRevision: rev,
    status: runStatus,
    progress: '',
    leaseStatus: active ? 'active' : 'none',
    receipts: [...runReceipts],
    answers: events
      .filter(
        (event: ChatTurn): boolean =>
          event.role === 'assistant' && event.reply_to === currentQuestionId,
      )
      .map((event: ChatTurn): QuestionDetail['answers'][number] => ({
        turnId: event.id,
        content: event.content,
        citations: event.citations ?? [],
      })),
    answerReadError: null,
    local: {
      status: active ? 'running' : runStatus === 'failed' ? 'failed' : 'idle',
      phase: active ? 'answering' : '',
      preview,
      requestId: null,
      errorCode:
        runStatus !== 'failed'
          ? null
          : state === 'aibroken'
            ? 'cli_not_found'
            : state === 'toolfailed'
              ? 'ai_unexpected_tool_activity'
              : 'ai_execution_failed',
      cleanupWarning: false,
    },
  };
}
/** 이 메모리 원장은 현재 창을 닫거나 새로 고치면 초기화됩니다. */
function conversation(): object {
  return {
    revision: conversationRevision,
    record: {
      id: a,
      kind: 'conversations',
      tenant: 'test',
      user_id: scope.userId,
      data: { title: conversationTitle },
      requests: Object.fromEntries(conversationRequests),
      events: [...events],
    },
  };
}
/** 전송 직후·실행 중·완료 상태를 관찰할 수 있게 모의 응답만 지연합니다. */
function waitForDisplay(milliseconds: number): Promise<void> {
  return new Promise((resolve: () => void): void => {
    window.setTimeout(resolve, milliseconds);
  });
}
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
      execute: async (request: RecoveryRequest): Promise<unknown> => {
        if (request.operation === 'put')
          entry = {
            kind: request.kind,
            key: request.key,
            payload: request.payload,
            revision: advanceRevision(),
            savedAt: '2026-11-10T01:00:00.000Z',
          };
        if (request.operation === 'remove') entry = null;
        return {
          ok: true,
          data: { entries: entry ? [entry] : [], cleanupWarningCount: 0 },
        };
      },
    },
    runtime: {
      execute: async (): Promise<unknown> => ({ ok: true, data: runtimeData }),
    },
    questionRuns: {
      create: async (request: QuestionCreateRequest): Promise<unknown> => {
        currentQuestionId = request.questionTurnId;
        currentRunId = request.requestId;
        runReceipts.length = 0;
        runStatus = 'queued';
        preview = '';
        return { ok: true, data: readRun() };
      },
      start: async (): Promise<unknown> => {
        runStatus = 'running';
        preview =
          '질문을 받았습니다. 모의 자료에서 관련 내용을 정리하고 있습니다.';
        completionTimer = window.setTimeout((): void => {
          if (runStatus !== 'running') return;
          runStatus = 'complete';
          preview = '';
          const text = splitQuestion(currentQuestion).question;
          const answerId = crypto.randomUUID().replaceAll('-', '');
          events.push({
            id: answerId,
            role: 'assistant',
            reply_to: currentQuestionId,
            content: /센서|경고|운전 모드/u.test(text)
              ? answerText
              : `입력한 질문은 “${text}”입니다.\n\n이 답변은 전송 직후 질문 표시, 진행 상태, 완료 뒤 후속 입력을 확인하는 모의 응답입니다. 실제 AI를 호출하거나 자료를 조회하지 않았습니다.`,
            citations: /센서|경고|운전 모드/u.test(text) ? sensorCitations : [],
          });
          conversationRevision = advanceRevision();
          conversationRequests.set(answerId, conversationRevision);
          runReceipts.push(completedReceipt(answerId));
        }, 3500);
        return { ok: true, data: readRun() };
      },
      cancel: async (): Promise<unknown> => {
        if (completionTimer !== null) window.clearTimeout(completionTimer);
        runStatus = 'cancelled';
        preview = '';
        return { ok: true, data: readRun() };
      },
      resumable: async (): Promise<unknown> => ({
        resumable: state !== 'reload',
      }),
      searchTerms: async (): Promise<unknown> => ({ terms: [] }),
      webSearch: async (
        request: QuestionWebSearchRequest,
      ): Promise<unknown> => {
        await waitForDisplay(1600);
        const text = 'question' in request ? request.question : request.query;
        return {
          web: {
            query: text.slice(0, 200),
            status: 'empty',
            sources: [],
            warnings: [],
          },
        };
      },
      read: async (): Promise<unknown> => ({ ok: true, data: readRun() }),
    },
    workspace: {
      execute: async (request: WorkspaceRequest): Promise<unknown> => {
        /** 기존 브리지의 응답 모양만 만들며 네트워크로 전달하지 않습니다. */
        function result(data: object): object {
          return {
            ok: true,
            data: {
              connectionId: 'fixture',
              access: scope,
              operation: request.operation,
              data,
            },
          };
        }
        if (request.operation === 'conversation') return result(conversation());
        if (request.operation === 'personalReceipt') {
          if (
            request.input.kind !== 'conversations' ||
            (request.input.record_id && request.input.record_id !== a) ||
            !conversationRequests.has(request.input.request_id)
          )
            return {
              ok: false,
              error: {
                code: 'not_found',
                status: 404,
                message: '동일 요청의 저장 기록이 없습니다.',
              },
            };
          return result({
            ...conversation(),
            request_confirmed: true,
            request_id: request.input.request_id,
          });
        }
        if (request.operation === 'questionContext') {
          await waitForDisplay(1600);
          if (state === 'disconnected')
            return {
              ok: false,
              error: {
                code: 'unavailable',
                status: 503,
                message: '서버 연결이 끊겼습니다.',
              },
            };
          return result({
            can_prepare: true,
            complete: true,
            truncated: false,
            skipped: [],
            documents: citations.map(
              (citation: (typeof citations)[number]): string =>
                citation.document,
            ),
            retrieval: { complete: true },
          });
        }
        if (request.operation === 'createConversation') {
          if (conversationRequests.has(request.input.request_id))
            return result(conversation());
          events.length = 0;
          conversationRequests.clear();
          conversationTitle = request.input.title;
          conversationRevision = advanceRevision();
          conversationRequests.set(
            request.input.request_id,
            conversationRevision,
          );
          return result(conversation());
        }
        if (request.operation === 'appendTurn') {
          if (conversationRequests.has(request.input.request_id))
            return result(conversation());
          if (request.input.expected_revision !== conversationRevision)
            return {
              ok: false,
              error: {
                code: 'conflict',
                status: 409,
                message: '대화가 변경되었습니다.',
              },
            };
          currentQuestionId = request.input.request_id;
          currentQuestion = request.input.content;
          events.push({
            id: currentQuestionId,
            role: request.input.role,
            content: currentQuestion,
          });
          conversationRevision = advanceRevision();
          conversationRequests.set(
            request.input.request_id,
            conversationRevision,
          );
          return result(conversation());
        }
        return {
          ok: false,
          error: {
            code: 'unexpected',
            status: 400,
            message: '허용하지 않은 작업',
          },
        };
      },
    },
  },
});
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <StrictMode>
    <nav className="preview-toolbar" aria-label="미리보기 화면 선택">
      <span>채팅 미리보기 · 예시 데이터</span>
      <label>
        화면
        <select
          value={state}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            location.assign(`?state=${event.target.value}#/chat`);
          }}
        >
          {states.map((item: State) => (
            <option key={item} value={item}>
              {stateNames[item]}
            </option>
          ))}
        </select>
      </label>
    </nav>
    <div className="preview-app">
      <HashRouter>
        <AppShell>
          <KnowledgeChatPage />
        </AppShell>
      </HashRouter>
    </div>
  </StrictMode>,
);

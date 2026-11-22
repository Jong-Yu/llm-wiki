import type { QuestionEvidence } from '@contracts/questionRuns.contract';
import type { JSX } from 'react';
import { Link } from 'react-router';
import { Icon } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { KnowledgeChatModel } from '../model/useKnowledgeChat';
import type { ChatRunNotice as ChatRunNoticeValue } from '../model/chatState';
import { chatRunFailure } from '../model/chatRunFeedback';
import { AssistantMessage } from './AssistantMessage';
import { ChatAnswer } from './ChatAnswer';
import styles from './KnowledgeChat.module.scss';

type Problem =
  | 'pending'
  | 'uncertain'
  | 'connection'
  | 'recovery'
  | 'failed'
  | 'other';
/** 앱을 다시 열어 실행 상세의 로컬 오류가 없어도 보호 저장한 같은 실행의 분류를 씁니다. */
function currentRunErrorCode(model: KnowledgeChatModel): string | null {
  return (
    model.run?.local.errorCode ??
    model.thread.runNotices.find(
      (notice: ChatRunNoticeValue): boolean => notice.runId === model.run?.id,
    )?.errorCode ??
    null
  );
}
/** 저장 결과를 먼저 확인해야 할 때에는 새 실행이나 연결 안내보다 우선한다. */
export function chatProblem(
  model: KnowledgeChatModel,
  uncertain: boolean,
  failed: boolean,
  unavailable: boolean,
): Problem | null {
  if (model.pending) return 'pending';
  if (uncertain) return 'uncertain';
  if (model.recoveryNotice) return 'recovery';
  if (failed) {
    const code = currentRunErrorCode(model);
    return chatRunFailure(code).connection || (!code && unavailable)
      ? 'connection'
      : 'failed';
  }
  return model.error ? 'other' : null;
}
type FeedbackProps = {
  model: KnowledgeChatModel;
  working: boolean;
  running: boolean;
  preview: string;
  problem: Problem | null;
  disabled: boolean;
  provider: string;
  showRetry: boolean;
};
const titles: Record<Problem, string> = {
  pending: '저장 결과를 확인해야 해요',
  uncertain: '저장 결과를 확인해야 해요',
  connection: 'AI 실행 환경을 확인해 주세요',
  recovery: '초안 보관 상태를 확인해 주세요',
  failed: '답변을 만들지 못했어요',
  other: '대화 작업을 완료하지 못했어요',
};
type FailureAction = { label: string } & (
  | { command: 'confirm' | 'diagnose' | 'retry' | 'refresh' }
  | { to: string }
);
const failureActions = {
  confirm: { label: '같은 요청 확인', command: 'confirm' },
  connect: { label: 'AI 연결하기', to: '/settings?section=ai' },
  diagnose: { label: '연결 다시 확인', command: 'diagnose' },
  retry: { label: '다시 시도', command: 'retry' },
  refresh: { label: '저장 상태 다시 확인', command: 'refresh' },
  retryAnswer: { label: '답변 다시 시도', command: 'retry' },
} satisfies Record<string, FailureAction>;
type FailureActionId = keyof typeof failureActions;
type FailureProps = Pick<FeedbackProps, 'model' | 'disabled' | 'showRetry'> & {
  problem: Problem;
};
/** 오류 설명과 복구 동작을 제공하며 불확실한 저장을 자동 재시도하지 않는다. */
function FailureNotice({
  model,
  problem,
  disabled,
  showRetry,
}: FailureProps): JSX.Element {
  const errorCode = currentRunErrorCode(model);
  const failure = chatRunFailure(errorCode);
  const reasons = {
    pending:
      '이전 요청의 응답을 확인하지 못했어요. 같은 요청의 저장 상태를 먼저 확인해 주세요.',
    uncertain: '생성된 답변의 저장 여부를 확인하지 못했어요.',
    connection:
      model.runtime?.cliConnection?.message ||
      'AI 설정에서 연결 상태를 확인해 주세요.',
    recovery: model.recoveryNotice,
    failed: failure.message,
    other: model.error,
  };
  const fallback: FailureActionId[] = showRetry
    ? ['refresh', 'retryAnswer']
    : ['refresh'];
  // 상태별 행동과 순서를 명시하고 동일한 버튼·링크 조립은 한 번만 유지합니다.
  const actions: Record<Problem, FailureActionId[]> = {
    pending: ['confirm'],
    connection: ['connect', 'diagnose'],
    failed: showRetry ? ['retry'] : fallback,
    uncertain: fallback,
    recovery: fallback,
    other: fallback,
  };
  const classes = {
    primary: `${styles.button} ${styles.primaryAction}`,
    secondary: styles.button,
  };
  return (
    <div role="alert" data-chat-run-failure>
      <StatusNotice
        role="presentation"
        variant="box"
        tone="error"
        title={problem === 'failed' ? failure.title : titles[problem]}
      >
        {problem === 'failed' || (problem === 'connection' && errorCode)
          ? failure.message
          : model.error || reasons[problem]}
      </StatusNotice>
      <div className={styles.answerActions}>
        {actions[problem].map(
          (id: FailureActionId, index: number): JSX.Element => {
            const action = failureActions[id];
            // 행동이 retry→refresh로 갱신돼도 같은 역할의 버튼과 키보드 초점을 유지합니다.
            const slot = index === 0 ? 'primary' : 'secondary';
            const className = classes[slot];
            return 'command' in action ? (
              <button
                key={slot}
                className={className}
                disabled={disabled}
                type="button"
                onClick={(): void => {
                  void model[action.command]();
                }}
              >
                {action.label}
              </button>
            ) : (
              <Link key={slot} className={className} to={action.to}>
                {action.label}
              </Link>
            );
          },
        )}
      </div>
    </div>
  );
}
type ChatRunNoticeProps = { notice: ChatRunNoticeValue };
/** 과거 실패·중단을 AI 답변으로 만들지 않고 해당 질문의 실행 상태로 읽습니다. */
export function ChatRunNotice({ notice }: ChatRunNoticeProps): JSX.Element {
  if (notice.status === 'cancelled')
    return <StatusNotice tone="info" title="응답을 중단했습니다" />;
  const failure = chatRunFailure(notice.errorCode);
  return (
    <StatusNotice tone="warning" title={failure.title}>
      {failure.message}
    </StatusNotice>
  );
}
type ProgressProps = { count: number | null; phase: string; provider: string };
/** 검색 완료와 생성 진행을 나누며 찾은 문서가 없으면 일반 답변 작성으로 표시한다. */
function AnswerProgress({
  count,
  phase,
  provider,
}: ProgressProps): JSX.Element {
  const current =
    count === null
      ? phase || `${provider}에서 답변을 준비하는 중…`
      : count > 0
        ? '근거를 읽고 답변 쓰는 중…'
        : '답변을 쓰는 중…';
  return (
    <ul className={styles.steps} role="status">
      {count !== null && (
        <li>
          <span className={styles.stepMark}>
            <Icon name="check" size={10} />
          </span>
          {count > 0
            ? `관련 문서 찾기 · 문서 ${count}개`
            : '관련 문서를 찾지 못했어요 · 위키 근거 없이 답해요'}
        </li>
      )}
      <li className={styles.stepActive}>
        <span className={styles.stepSpinner} />
        {current}
      </li>
    </ul>
  );
}
/** 생성 중 미리보기와 클라이언트의 오류·저장 상태를 구분해 표시합니다. */
export function ChatRunFeedback({
  model,
  working,
  running,
  preview,
  problem,
  disabled,
  provider,
  showRetry,
}: FeedbackProps): JSX.Element {
  const run = model.run;
  const count =
    running && run
      ? run.evidence.filter(
          (item: QuestionEvidence): boolean => item.kind === 'document',
        ).length
      : model.foundCount;
  return (
    <>
      {(working || preview) && (
        <AssistantMessage>
          {working && (
            <AnswerProgress
              count={count}
              phase={model.phase}
              provider={provider}
            />
          )}
          {preview && (
            <>
              {!working && (
                <small className={styles.previewStatus}>
                  {run?.status === 'cancelled'
                    ? '중단 전 생성된 내용'
                    : '응답 일부 · 저장 미확인'}
                </small>
              )}
              <ChatAnswer content={preview} />
            </>
          )}
        </AssistantMessage>
      )}
      {!working && problem && (
        <FailureNotice
          model={model}
          problem={problem}
          disabled={disabled}
          showRetry={showRetry}
        />
      )}
      {run?.answerReadError && (
        <StatusNotice variant="box" tone="warning">
          {run.answerReadError}
        </StatusNotice>
      )}
      {run?.local.cleanupWarning && (
        <StatusNotice variant="box" tone="warning">
          답변 처리 후 인증 임시 파일을 정리하지 못했어요. 설정에서 확인해
          주세요.
        </StatusNotice>
      )}
    </>
  );
}

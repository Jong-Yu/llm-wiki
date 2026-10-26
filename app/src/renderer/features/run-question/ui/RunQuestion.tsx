import { useMemo } from 'react';
import type { JSX } from 'react';
import { questionSessionSchema } from '@contracts/questionRuns.contract';
import type {
  QuestionSession,
  QuestionEvidence,
  QuestionAnswer,
  QuestionReceipt,
} from '@contracts/questionRuns.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import { useQuestionRun } from '../model/useQuestionRun';
import {
  canStartQuestion,
  questionStorageLabel,
  hasUnconfirmedQuestionAnswer,
} from '../model/questionRun';
import type { StoredQuestion } from '../model/questionRun';
import styles from './RunQuestion.module.scss';

export type RunQuestionProps = {
  session: QuestionSession;
  question?: StoredQuestion;
  initialRunId?: string;
  canWrite?: boolean;
  onChanged?: () => void;
};
/** 저장된 질문의 명시 실행부터 임시 생성문·실제 저장 답변까지 이어 줍니다. */
export function RunQuestion({
  session,
  question,
  initialRunId,
  canWrite = true,
  onChanged,
}: RunQuestionProps): JSX.Element {
  const sessionKey = JSON.stringify(session);
  const stableSession = useMemo(
    (): QuestionSession => questionSessionSchema.parse(JSON.parse(sessionKey)),
    [sessionKey],
  );
  const model = useQuestionRun(
    stableSession,
    question,
    initialRunId,
    onChanged,
  );
  const detail = model.detail;
  const disabled = model.busy || model.invalidScope || model.recovering;
  const pendingAnswer = detail !== null && hasUnconfirmedQuestionAnswer(detail);
  const running =
    detail?.local.status === 'running' ||
    detail?.local.status === 'stopping' ||
    (detail?.status === 'running' && detail.leaseStatus === 'active');
  return (
    <section className={styles.root} aria-label="개인 AI 질문 실행">
      <header className={styles.header}>
        <div>
          <h2>개인 AI 질문</h2>
          <p>
            관점 {session.expectedScope.profileId} · 질문 당시 근거 판본을
            사용합니다.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={(): void => {
            void model.refresh();
          }}
        >
          서버 상태 확인
        </Button>
      </header>
      {model.recoveryNotice && (
        <p role="status" className={styles.notice}>
          {model.recoveryNotice}
        </p>
      )}
      {question && (
        <div className={styles.actions}>
          <Button
            disabled={
              disabled ||
              !canWrite ||
              running ||
              model.pendingCreation !== null ||
              pendingAnswer
            }
            onClick={(): void => {
              void model.createAndStart();
            }}
          >
            저장한 질문으로 개인 AI 실행
          </Button>
          <small>질문·근거 저장과 AI 실행은 각각 확인합니다.</small>
        </div>
      )}
      {model.pendingCreation && (
        <div role="status" className={styles.notice}>
          질문 접수 결과를 확인해야 합니다. 새 요청을 만들지 않습니다.
          <Button
            disabled={disabled}
            onClick={(): void => {
              void model.confirmCreation();
            }}
          >
            같은 접수 요청 확인
          </Button>
          <code>{model.pendingCreation}</code>
        </div>
      )}
      {model.error && (
        <p role="alert" className={styles.notice}>
          {model.error.message} ({model.error.code})
        </p>
      )}
      <div className={styles.workspace}>
        <aside className={styles.history} aria-label="기존 질문 실행">
          <h3>기존 실행</h3>
          {model.page?.items.length === 0 && (
            <p>저장된 질문 실행이 없습니다.</p>
          )}
          <ul>
            {model.page?.items.map(
              (
                item: NonNullable<typeof model.page>['items'][number],
              ): JSX.Element => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={detail?.id === item.id}
                    onClick={(): void => {
                      void model.select(item.id);
                    }}
                  >
                    <span>{item.title}</span>
                    <small>{item.created_at}</small>
                  </button>
                </li>
              ),
            )}
          </ul>
          {model.page?.incomplete && <p>목록은 일부만 조회되었습니다.</p>}
          {model.page?.nextCursor && (
            <Button
              disabled={disabled}
              variant="secondary"
              onClick={(): void => {
                void model.loadMore();
              }}
            >
              실행 더 보기
            </Button>
          )}
        </aside>
        <section className={styles.answer} aria-label="질문 실행 상세">
          {!detail && (
            <p>
              저장한 질문을 실행하거나 기존 실행을 선택하세요. 조회만으로 AI가
              시작되지는 않습니다.
            </p>
          )}
          {detail && (
            <>
              <blockquote>{detail.question}</blockquote>
              <div role="status" className={styles.notice}>
                <strong>{questionStorageLabel(detail)}</strong>
                <span>
                  서버 {detail.status} · 진행 {detail.progress} · 로컬{' '}
                  {detail.local.status}
                  {detail.local.phase && ` / ${detail.local.phase}`}
                </span>
                {detail.leaseStatus === 'expired' && (
                  <span>이전 실행의 사용권이 만료되었습니다.</span>
                )}
              </div>
              <div className={styles.actions}>
                {canStartQuestion(detail) && (
                  <Button
                    disabled={disabled || !canWrite}
                    onClick={(): void => {
                      void model.start();
                    }}
                  >
                    {detail.leaseStatus === 'expired'
                      ? '만료 실행 명시 재접수'
                      : '개인 AI 실행'}
                  </Button>
                )}
                {(running || detail.status === 'queued') && (
                  <Button
                    variant="secondary"
                    disabled={
                      disabled ||
                      !canWrite ||
                      detail.local.status === 'stopping'
                    }
                    onClick={(): void => {
                      void model.cancel();
                    }}
                  >
                    실행 중단
                  </Button>
                )}
              </div>
              {detail.local.errorCode && (
                <p role="alert">
                  개인 실행 오류: {detail.local.errorCode}. 서버 저장 여부를
                  별도로 확인하세요.
                </p>
              )}
              {detail.local.cleanupWarning && (
                <p role="alert">
                  로컬 인증 임시 파일을 정리하지 못했습니다. 저장 결과와 별개의
                  정리 문제입니다.
                </p>
              )}
              {detail.local.preview && (
                <section
                  className={styles.preview}
                  aria-label="미저장 생성 미리보기"
                >
                  <h3>생성 미리보기 · 미저장</h3>
                  <p className={styles.content}>{detail.local.preview}</p>
                </section>
              )}
              <p className={styles.caption}>
                생성문은 CLI가 제공하는 시점에 갱신됩니다. 환경에 따라 생성 완료
                뒤 한 번 표시될 수 있습니다. 토큰 단위 전송이나 저장 완료를
                뜻하지 않습니다.
              </p>
              {detail.answers.map((answer: QuestionAnswer): JSX.Element => (
                <article
                  className={styles.saved}
                  key={answer.turnId}
                  aria-label="저장 확인된 답변"
                >
                  <h3>저장된 답변</h3>
                  <p className={styles.content}>{answer.content}</p>
                  <p className={styles.caption}>
                    개인 AI 자기보고(client_reported) · 사람 승인 없음 · 별도
                    의미 검사 미실행
                  </p>
                  <h4>답변 출처</h4>
                  {answer.citations.length === 0 && (
                    <p>첨부된 인용이 없습니다.</p>
                  )}
                  {answer.citations.map(
                    (citation: KnowledgeValue, index: number): JSX.Element => (
                      <details key={`${answer.turnId}-${index}`}>
                        <summary>
                          {typeof citation.document === 'string'
                            ? citation.document
                            : typeof citation.source_id === 'string'
                              ? `원본 ${citation.source_id}`
                              : '근거 참조'}{' '}
                          ·{' '}
                          {typeof citation.kind === 'string'
                            ? citation.kind
                            : '출처'}
                        </summary>
                        {typeof citation.quote === 'string' && (
                          <blockquote>{citation.quote}</blockquote>
                        )}
                        <pre>{JSON.stringify(citation, null, 2)}</pre>
                      </details>
                    ),
                  )}
                </article>
              ))}
              {detail.answerReadError && (
                <p role="alert">{detail.answerReadError}</p>
              )}
              <details>
                <summary>
                  질문 당시 고정 근거 ({detail.evidence.length})
                </summary>
                <p>
                  근거 묶음 판본 <code>{detail.basisRevision}</code>
                </p>
                {detail.evidence.map(
                  (evidence: QuestionEvidence): JSX.Element => (
                    <div
                      className={styles.evidence}
                      key={`${evidence.kind}:${evidence.label}:${evidence.sourceVersion}`}
                    >
                      <strong>
                        {evidence.kind === 'source' ? '원본' : '위키'} ·{' '}
                        {evidence.label}
                      </strong>
                      <span>
                        {evidence.kind === 'source'
                          ? '원본 SHA-256'
                          : '본문 판본'}
                        : <code>{evidence.sourceRevision}</code>
                      </span>
                      {evidence.sourceVersion && (
                        <span>
                          원본 판본: <code>{evidence.sourceVersion}</code>
                        </span>
                      )}
                      {evidence.graphRevision && (
                        <span>
                          추출 판본: <code>{evidence.graphRevision}</code>
                        </span>
                      )}
                      {evidence.stateRevision && (
                        <span>
                          검토 상태 판본: <code>{evidence.stateRevision}</code>
                        </span>
                      )}
                    </div>
                  ),
                )}
              </details>
              <details>
                <summary>
                  서버 답변 저장 영수증 ({detail.receipts.length})
                </summary>
                {detail.receipts.map(
                  (receipt: QuestionReceipt): JSX.Element => (
                    <div className={styles.evidence} key={receipt.request_id}>
                      <strong>
                        {receipt.saved === true
                          ? '저장 확인'
                          : receipt.saved === false
                            ? '저장 안 됨'
                            : '저장 미확인'}{' '}
                        · {receipt.state}
                      </strong>
                      <code>{receipt.request_id}</code>
                      {receipt.state === 'pending_reconcile' && (
                        <p>
                          후속 상태 반영을 확인해야 합니다. 답변을 자동
                          재전송하지 않습니다.
                        </p>
                      )}
                      {receipt.cleanup_failures.length > 0 && (
                        <p>
                          저장 이후 정리 경고 {receipt.cleanup_failures.length}
                          건
                        </p>
                      )}
                      {receipt.receipt && (
                        <p>
                          답변 ID <code>{receipt.receipt.answer_turn_id}</code>{' '}
                          · 대화 판본{' '}
                          <code>{receipt.receipt.conversation_revision}</code>
                        </p>
                      )}
                    </div>
                  ),
                )}
              </details>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

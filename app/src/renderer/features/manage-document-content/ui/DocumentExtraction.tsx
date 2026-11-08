import { Button } from '@renderer/shared/ui/Button';
import { useEffect, useEffectEvent } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import type { DocumentContent } from '@contracts/documents.contract';
import type { ProposalExecutionLocal } from '@contracts/proposalExecution.contract';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { Icon } from '@renderer/shared/ui/Icon';
import type { DocumentExtractionModel } from '../model/useDocumentExtraction';
import chips from './DocumentChips.module.scss';
import styles from './ManageDocumentContent.module.scss';

const phaseLabels: Record<string, string> = {
  starting: '입력 준비',
  claimed: '실행 확인',
  extracting: '관계 후보 생성',
  submitting_candidate: '추출 결과 제출',
  linking_candidate: '후보 연결',
  candidate_saved: '후보 저장 확인',
  semantic_check: '별도 의미 검사',
  submitting_diagnostics: '검사 보고 제출',
  linking_diagnostics: '검사 보고 연결',
  diagnostics_saved: '검사 보고 저장 확인',
  candidate_ready: '후보 저장 기록 확인',
  partial: '일부 단계 실패',
  cancelled: '중단됨',
  unconfirmed: '서버 저장 확인 필요',
};
const POLL_MS = 4000;

/** 실행이 진행 중인지(응답 유실로 확인 못 한 경우 포함) 판단합니다. */
function isRunning(model: DocumentExtractionModel): boolean {
  const { state } = model;
  const status: ProposalExecutionLocal['status'] | undefined =
    state.execution?.local.status;
  return (
    model.busy ||
    (state.executionId !== null &&
      !state.error &&
      (status === undefined || status === 'running' || status === 'stopping'))
  );
}

type ExtractionButtonProps = {
  model: DocumentExtractionModel;
  disabled: boolean;
};
/** 준비와 시작을 한 번에 실행하는 상단 버튼. 응답 유실 후에는 같은 요청의 결과 확인으로 바뀝니다. */
export function DocumentExtractionButton({
  model,
  disabled,
}: ExtractionButtonProps): JSX.Element {
  const { state } = model;
  const running = isRunning(model);
  // AI 연결이 필요하면 새 추출만 막습니다. 이유는 화면 맨 위 연결 알림이 알립니다.
  const aiRequired = useAiConnection().status === 'required';
  const confirm = state.recoveryId
    ? model.recover
    : state.executionId && state.error
      ? model.refresh
      : null;
  if (confirm)
    return (
      <Button
        variant="surface"
        type="button"
        className={styles.button}
        disabled={model.busy || disabled}
        onClick={(): void => {
          void confirm();
        }}
      >
        <Icon name="refresh-cw" /> 결과 확인
      </Button>
    );
  return (
    <Button
      variant="surface"
      type="button"
      className={styles.button}
      disabled={
        running ||
        disabled ||
        aiRequired ||
        !(model.canPrepare || state.prepared)
      }
      onClick={(): void => {
        void model.run();
      }}
    >
      <Icon
        name={running ? 'loader-circle' : 'refresh-cw'}
        className={running ? chips.spin : undefined}
      />
      {running ? '추출 중…' : '관계 재추출'}
    </Button>
  );
}

type ExtractionBannerProps = {
  model: DocumentExtractionModel;
  current: DocumentContent;
};
/** 본문 위에 실행 단계와 저장 확인에 필요한 안내를 표시합니다. */
export function DocumentExtractionBanner({
  model,
  current,
}: ExtractionBannerProps): JSX.Element | null {
  const { state } = model;
  const running = isRunning(model);
  // 연결 알림이 맨 위에 있으면 오류 줄에서 같은 링크를 반복하지 않습니다.
  const aiRequired = useAiConnection().status === 'required';
  const status = state.execution?.local.status;
  const proposalId = state.prepared?.proposalId ?? state.recoveryId;
  const proposalLink = proposalId
    ? `/analysis-proposals?document=${encodeURIComponent(current.document)}&proposalId=${encodeURIComponent(proposalId)}`
    : null;
  const poll = useEffectEvent((): void => {
    if (!model.busy) void model.refresh();
  });
  const polling = running && !!state.executionId;
  useEffect((): (() => void) | undefined => {
    if (!polling) return;
    const timer = window.setInterval(poll, POLL_MS);
    return (): void => window.clearInterval(timer);
  }, [polling]);
  const stale = Boolean(
    state.prepared && state.prepared.sourceRevision !== current.revision,
  );
  const detail = state.execution && (
    <details className={styles.technicalDetails}>
      <summary>진행 단계</summary>
      <p>{phaseLabels[state.execution.local.phase] ?? '진행 기록 확인'}</p>
      {state.execution.local.cleanupWarning && (
        <p>실행 정리 경고가 있습니다. 같은 작업을 자동 재실행하지 않습니다.</p>
      )}
    </details>
  );
  if (state.error)
    return (
      <div className={chips.progress} data-tone="error" role="alert">
        <span>실패</span>
        <span className={chips.grow}>
          {state.error.message} 본문을 다시 저장할 필요는 없습니다.
        </span>
        {!aiRequired && (
          <Link className={styles.link} to="/settings?section=ai">
            AI 연결하기
          </Link>
        )}
      </div>
    );
  if (running)
    return (
      <div className={chips.progress} role="status">
        <span>추출 중</span>
        <span className={chips.grow}>
          저장된 본문을 읽고 관계 후보를 만들고 있습니다…
          {detail}
        </span>
      </div>
    );
  if (status === 'failed')
    return (
      <div className={chips.progress} data-tone="error" role="alert">
        <span>실패</span>
        <span className={chips.grow}>
          관계 추출 실행이 실패했습니다.
          {detail}
        </span>
        {proposalLink && (
          <Link className={styles.button} to={proposalLink}>
            결과 비교·반영
          </Link>
        )}
      </div>
    );
  if (status === 'exited')
    return (
      <div className={chips.progress} data-tone="success" role="status">
        <span>완료</span>
        <span className={chips.grow}>
          관계 추출을 마쳤습니다. 비교한 뒤 반영해야 관계가 새 버전으로
          바뀝니다.
          {stale && ' 추출 뒤 본문이 변경되어 이전 버전 기준입니다.'}
          {detail}
        </span>
        {proposalLink && (
          <Link className={styles.primaryButton} to={proposalLink}>
            결과 비교·반영
          </Link>
        )}
      </div>
    );
  if (state.prepared && !state.executionId)
    return (
      <div className={chips.progress} role="status">
        <span>준비 완료</span>
        <span className={chips.grow}>
          {stale
            ? '준비 뒤 본문이 변경되었습니다. 다시 재추출해 주세요.'
            : '저장된 본문으로 입력을 준비했습니다.'}
        </span>
        {!stale && (
          <Button
            variant="primary"
            type="button"
            className={styles.primaryButton}
            onClick={(): void => {
              void model.start();
            }}
          >
            추출 시작
          </Button>
        )}
      </div>
    );
  return null;
}

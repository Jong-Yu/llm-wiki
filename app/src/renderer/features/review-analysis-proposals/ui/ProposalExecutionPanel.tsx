import { useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX, ChangeEvent } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { ProposalExecutionSession } from '../model/ProposalExecutionSession';
import type { ProposalRecord } from '../model/analysisProposal.schema';
import styles from './ReviewAnalysisProposals.module.scss';

type ProposalExecutionPanelProps = {
  execution: ProposalExecutionSession;
  record: ProposalRecord;
  disabled: boolean;
  onCompare: () => void;
};
const statusLabels = {
  idle: '로컬 실행 없음',
  running: '개인 AI 실행 중',
  stopping: '중단 처리 중',
  exited: '개인 실행 종료',
  failed: '개인 실행 실패',
};
const phaseLabels: Record<string, string> = {
  starting: '고정 입력 준비',
  claimed: '실행 사용권 확인',
  extracting: '새 후보 생성',
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
  failed: '실행 실패',
  not_started: '서버 기록 조회',
  restored_receipt_check: '복원된 실행 기록 확인',
};
/** 고정 입력의 명시 실행과 실제 후보 영수증·부분 실패를 별도 표시합니다. */
export function ProposalExecutionPanel({
  execution,
  record,
  disabled,
  onCompare,
}: ProposalExecutionPanelProps): JSX.Element {
  const state = useSyncExternalStore(execution.subscribe, execution.snapshot);
  const [semanticCheck, setSemanticCheck] = useState(false);
  const running =
    state.detail?.local.status === 'running' ||
    state.detail?.local.status === 'stopping';
  useEffect((): (() => void) | undefined => {
    if (!running) return;
    const timer = setInterval((): void => {
      void execution.read();
    }, 1500);
    return (): void => clearInterval(timer);
  }, [execution, running]);
  return (
    <section className={styles.form} aria-label="개인 AI 재추출">
      {state.previous.length > 0 && (
        <details>
          <summary>보존한 이전 실행 요청·영수증</summary>
          <pre>{JSON.stringify(state.previous, null, 2)}</pre>
        </details>
      )}
      <h2>개인 AI로 새 후보 만들기</h2>
      <p>
        고정한 전체 원문·맥락·규약과 현재 후보를 기준으로 실행합니다. 결과는
        후보로 보관하며 적용과 사람 검토는 별도입니다.
      </p>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={semanticCheck}
          disabled={disabled || !!state.request}
          onChange={(event: ChangeEvent<HTMLInputElement>): void =>
            setSemanticCheck(event.target.checked)
          }
        />
        <span>새 후보의 별도 AI 의미 검사도 실행</span>
      </label>
      <Button
        disabled={disabled || state.busy || !!state.request}
        onClick={(): void => {
          void execution.start(record, semanticCheck);
        }}
      >
        명시 AI 재추출 실행
      </Button>
      {state.error && (
        <StatusNotice tone="warning" title="실행 확인 필요">
          {state.error}
        </StatusNotice>
      )}
      {execution.canPrepareNext() && (
        <Button
          variant="secondary"
          onClick={(): void => execution.prepareNext()}
        >
          기록 보존 후 새 실행 준비
        </Button>
      )}
      {state.request && (
        <>
          <p>
            실행 요청 <code>{state.request.requestId}</code>
          </p>
          <p role="status">
            {state.detail
              ? statusLabels[state.detail.local.status]
              : '실행 접수 미확인'}{' '}
            ·{' '}
            {state.detail
              ? (phaseLabels[state.detail.local.phase] ?? '진행 기록 확인')
              : '같은 실행 기록을 조회해 주세요.'}
          </p>
          {state.detail?.local.errorCode && (
            <p>실행 오류: {state.detail.local.errorCode}</p>
          )}
          {state.detail?.local.cleanupWarning && (
            <p>
              임시 인증 파일 정리 경고가 있습니다. 후보 저장 여부와 별도로
              확인해 주세요.
            </p>
          )}
          <Button
            variant="secondary"
            disabled={state.busy}
            onClick={(): void => {
              void execution.read();
            }}
          >
            같은 실행·후보 영수증 조회
          </Button>
          <Button
            variant="secondary"
            disabled={state.busy || state.detail?.local.status === 'stopping'}
            onClick={(): void => {
              void execution.cancel();
            }}
          >
            실행 중단 요청
          </Button>
          {state.detail?.local.preview && (
            <details>
              <summary>
                생성 중 미저장 미리보기
                {state.detail.local.previewTruncated ? ' · 일부 표시' : ''}
              </summary>
              <pre>{state.detail.local.preview}</pre>
            </details>
          )}
          {state.detail?.server && (
            <details>
              <summary>실제 실행·후보 저장 기록</summary>
              <pre>{JSON.stringify(state.detail.server, null, 2)}</pre>
            </details>
          )}
          <p>
            프로세스 종료만으로 후보 저장을 확정하지 않습니다. 의미 검사 실패
            뒤에도 저장된 후보가 있을 수 있습니다.
          </p>
          <Button disabled={state.busy || running} onClick={onCompare}>
            현재 후보 조회·이전 결과와 비교
          </Button>
        </>
      )}
    </section>
  );
}

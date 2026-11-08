import { useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX, ChangeEvent } from 'react';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type {
  ProposalExecutionSession,
  ProposalExecutionState,
} from '../model/ProposalExecutionSession';
import { parseObject } from '../model/analysisProposal.schema';
import type { ProposalRecord } from '../model/analysisProposal.schema';
import { ProposalGraphDetails } from './ProposalGraphDetails';
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
  starting: '입력 준비',
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
const serverStateLabels: Record<string, string> = {
  pending_reconcile: '실행 접수 확인 필요',
  ready: '실행 접수 확인됨',
  candidate_ready: '새 후보 저장 확인됨',
  cancelled: '실행 취소됨',
  superseded: '다른 실행이나 후보로 변경됨',
  basis_changed: '원문이나 입력 기준이 변경됨',
};
/** 확인된 서버 상태만 사용자 문구로 표시하고 알 수 없는 상태는 추정하지 않습니다. */
function serverState(value: unknown): string {
  return typeof value === 'string'
    ? (serverStateLabels[value] ?? '서버 기록 확인 필요')
    : '서버 기록 미확인';
}
/** 입력의 명시 실행과 실제 후보 확인 기록·부분 실패를 별도 표시합니다. */
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
          <summary>이전 실행 · {state.previous.length}건</summary>
          <ol>
            {state.previous.map(
              (
                previous: ProposalExecutionState['previous'][number],
                index: number,
              ): JSX.Element => (
                <li key={index}>
                  {previous.detail
                    ? statusLabels[previous.detail.local.status]
                    : '실행 결과 미확인'}{' '}
                  · {serverState(previous.detail?.server?.state)}
                  {previous.detail?.local.cleanupWarning && (
                    <p>임시 파일 정리 경고가 있습니다.</p>
                  )}
                </li>
              ),
            )}
          </ol>
        </details>
      )}
      <details className={styles.executionPrepare} open={!record.submission}>
        <summary>개인 AI로 새 후보 만들기</summary>
        <div className={styles.form}>
          <p>
            전체 원문·맥락·규약과 현재 후보를 기준으로 실행합니다. 결과는 후보로
            보관하며 적용과 사람 검토는 별도입니다.
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
        </div>
      </details>
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
            <p>
              AI 실행을 마치지 못했습니다. 연결 상태를 확인하고 같은 실행 기록을
              조회해 주세요.
            </p>
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
            같은 실행·후보 확인 기록 조회
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
              {((): JSX.Element => {
                const graph = parseObject(state.detail.local.preview);
                return graph ? (
                  <ProposalGraphDetails graph={graph} />
                ) : (
                  <p>
                    새 후보를 작성하고 있습니다. 저장 확인 후 전체 내용을 비교할
                    수 있습니다.
                  </p>
                );
              })()}
            </details>
          )}
          {state.detail?.server && (
            <p>서버 확인: {serverState(state.detail.server.state)}</p>
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

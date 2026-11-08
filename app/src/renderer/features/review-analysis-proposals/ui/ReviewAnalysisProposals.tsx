import type { JSX } from 'react';
import { Link } from 'react-router';
import { Icon } from '@renderer/shared/ui/Icon';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import type { AnalysisProposalsBridge } from '@contracts/analysisProposals.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { ProposalExecutionBridge } from '@contracts/proposalExecution.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { ProposalSession } from '../model/ProposalSession';
import { useProposalWorkspace } from '../model/useProposalWorkspace';
import { useProposalSession } from '../model/useProposalSession';
import type {
  ProposalClaim,
  ProposalRecord,
  SubmitFields,
} from '../model/analysisProposal.schema';
import {
  MissingClaimDecisionForm,
  ProposalCompletionForm,
} from './ProposalForms';
import { ProposalDiagnostics } from './ProposalDiagnostics';
import { ProposalComparison } from './ProposalComparison';
import { ProposalRelationDiff } from './ProposalRelationDiff';
import { ProposalExecutionPanel } from './ProposalExecutionPanel';
import { ProposalGraphDetails } from './ProposalGraphDetails';
import {
  ProposalRecordDetails,
  ProposalActivity,
} from './ProposalRecordDetails';
import { parseObject } from '../model/analysisProposal.schema';
import styles from './ReviewAnalysisProposals.module.scss';

export type ReviewAnalysisProposalsProps = {
  gateway: AnalysisProposalsBridge;
  executionGateway?: ProposalExecutionBridge;
  initialDocument?: string;
  initialProposalId?: string;
};
type ProposalWorkspaceProps = {
  session: ProposalSession;
  document: string;
  onRefreshScope: () => void;
};
/** 객체에 보존된 실제 본문 문자열만 읽습니다. */
function sourceText(source: KnowledgeValue | null): string {
  return source && typeof source.content === 'string'
    ? source.content
    : '이 버전의 원문을 확보하지 못했습니다.';
}

/** 전체 후보·근거·현재 검토를 분리한 저장 전 추출 결과 작업 화면입니다. */
function ProposalWorkspace({
  session,
  document,
  onRefreshScope,
}: ProposalWorkspaceProps): JSX.Element {
  const {
    state,
    record,
    selectedId,
    setSelectedId,
    selected,
    relations,
    automaticPassed,
    isConfirmed,
    setConfirmed,
    receipt,
    saved,
    canWrite,
    diagnosticRecord,
    controls,
    editLocked,
    draftKey,
    currentSource,
    review,
    proposalCurrentForCompletion,
    reviewCurrent,
    completions,
    decide,
    readReview,
    complete,
    read,
    validateOrApply,
  } = useProposalWorkspace(session);

  // 화면 제목과 대상 문서는 앱 Header의 경로가 보이고, 행동 버튼(최대 3개)은 Header 오른쪽에 놓입니다.
  const toolbar = (
    <>
      <HeaderActions>
        <Button
          variant="secondary"
          onClick={onRefreshScope}
          disabled={state.busy}
        >
          새로고침
        </Button>
      </HeaderActions>
    </>
  );
  const notices = (
    <>
      {' '}
      {state.archived.length > 0 && (
        <details>
          <summary>보존된 이전 추출 결과·전체 근거</summary>
          {state.archived.map(
            (previous: ProposalRecord, index: number): JSX.Element => (
              <details key={index}>
                <summary>이전 추출 결과 {index + 1}</summary>
                <ProposalRecordDetails record={previous} />
              </details>
            ),
          )}
        </details>
      )}
      {state.recoveryNotice && (
        <StatusNotice tone="warning" title="종료 후 복구">
          {state.recoveryNotice}
        </StatusNotice>
      )}
      {state.error && (
        <StatusNotice tone="error" title="요청 결과 확인">
          {state.error}
          <p>입력한 전체 초안과 근거는 이 앱 세션의 원래 범위에 보존됩니다.</p>
        </StatusNotice>
      )}
      {state.pending && (
        <section className={styles.notice}>
          <h2>요청 결과 확인 필요</h2>
          <p>원래 요청과 입력을 보존하고 저장 기록을 확인합니다.</p>

          <Button
            disabled={state.busy || !state.recovery}
            onClick={(): void => {
              void session.reconcile();
            }}
          >
            같은 요청 기록 조회
          </Button>
        </section>
      )}
      {state.observed && (
        <section className={styles.notice}>
          <h2>새로 관측한 서버 추출 결과</h2>
          {record && (
            <ProposalComparison previous={record} next={state.observed} />
          )}
          <details>
            <summary>새로 확인한 추출 내용과 근거</summary>
            <ProposalRecordDetails record={state.observed} />
          </details>
          <p>
            현재 폼은 기존 기준을 유지합니다. 아래 동작은 서버의 전체 후보로 새
            편집을 시작하며 이전 입력을 별도 보존합니다.
          </p>
          <Button
            disabled={controls.lookupDisabled}
            onClick={(): void => {
              session.adoptObserved();
              setConfirmed(false);
            }}
          >
            대조한 서버 후보로 새 편집 시작
          </Button>
        </section>
      )}
    </>
  );
  const diagnosticsPart = (
    <>
      <ProposalDiagnostics
        report={state.validation}
        record={diagnosticRecord}
      />
    </>
  );
  const applyPart = (
    <>
      {record?.candidate_ref && (
        <section className={styles.form}>
          <Button
            variant="secondary"
            disabled={controls.validateDisabled}
            onClick={(): void => validateOrApply('validate')}
          >
            검사
          </Button>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={isConfirmed}
              disabled={editLocked}
              onChange={(): void => setConfirmed(!isConfirmed)}
            />
            추가·사라진 관계와 근거를 모두 확인했고, 전체를 반영합니다.
          </label>
          <Button
            disabled={controls.applyDisabled}
            onClick={(): void => validateOrApply('apply')}
          >
            검사 후 반영
          </Button>
        </section>
      )}
    </>
  );
  const recordsPart = (
    <>
      {record && (
        <>
          <h3>사라진 관계 판단</h3>
          <ProposalActivity items={record.decisions} record={record} />
          <h3>요청·적용 기록</h3>
          <ProposalActivity items={record.events} record={record} />
          {Object.keys(record.applications).map(
            (id: string, index: number): JSX.Element => (
              <Button
                key={id}
                variant="secondary"
                disabled={state.busy}
                onClick={(): void => {
                  void session.run({
                    ...session.requestFields(),
                    operation: 'receipt',
                    input: {
                      proposal_id: record.proposal_id,
                      request_id: id,
                    },
                  });
                }}
              >
                적용 기록 {index + 1} 확인
              </Button>
            ),
          )}
        </>
      )}
    </>
  );
  const savedPart = (
    <>
      {record && saved && (
        <section className={styles.form}>
          <StatusNotice tone="success" title="반영됨">
            관계가 새 버전으로 바뀌었습니다. 추가된 관계를 검토해 주세요.
          </StatusNotice>
          <h2>새 관계 검토</h2>
          {!proposalCurrentForCompletion && (
            <p>
              적용으로 추출 결과 상태가 갱신되었습니다. 현재 추출 결과을 다시
              읽고 서버 후보로 새 편집을 시작한 뒤 완료해 주세요.
            </p>
          )}
          <Link
            to={`/ontology?${new URLSearchParams({ path: record.basis.target_document, view: 'reviews' })}`}
          >
            검토함에서 보기
          </Link>
          <Button
            variant="secondary"
            disabled={state.busy}
            onClick={(): void => {
              void readReview();
            }}
          >
            현재 새 관계 검토 읽기
          </Button>
          {review && (
            <>
              {!reviewCurrent && (
                <StatusNotice
                  tone="warning"
                  title="적용 결과와 현재 검토가 다름"
                >
                  원문 또는 그래프 버전이 달라 완료할 수 없습니다.
                </StatusNotice>
              )}
              <ProposalCompletionForm
                drafts={session.forms}
                key={`${draftKey}:${review.stateRevision}`}
                draftKey={`${draftKey}:${review.stateRevision}`}
                review={review}
                disabled={controls.completionDisabled}
                onComplete={complete}
              />
            </>
          )}
        </section>
      )}
    </>
  );
  if (!record)
    return (
      <section
        className={`${styles.workspace} ${styles.initialWorkspace}`}
        aria-label="저장 전 추출 결과 검토"
      >
        {toolbar}
        <div className={styles.initialContent}>
          {notices}
          <div className={styles.emptyCard}>
            <Icon name="files" size={24} />
            <h2>비교할 추출 결과가 없습니다</h2>
            <p>
              문서의 &lsquo;관계 재추출&rsquo; 결과에서 이 화면으로 들어옵니다.
            </p>
            {document && (
              <Link
                className={styles.toolbarLink}
                to={`/document?${new URLSearchParams({ path: document })}`}
              >
                문서 열기
              </Link>
            )}
          </div>
        </div>
      </section>
    );

  return (
    <section className={styles.workspace} aria-label="저장 전 추출 결과 검토">
      <div className={styles.flow}>
        {toolbar}
        <div className={styles.content}>
          {notices}
          {record ? (
            <>
              <section className={styles.intro} aria-label="이 화면에서 할 일">
                <h2>AI가 다시 뽑은 관계를 저장된 관계와 비교했습니다</h2>
                <p>
                  달라진 관계만 모아 보여 줍니다. 사라진 관계는 복구·재추출·제외
                  중 하나로 판단하고, 판단을 마치면 검사 후 반영합니다.
                </p>
                <p
                  className={styles.todo}
                  data-state={
                    saved
                      ? 'done'
                      : relations.undecidedIds.length > 0
                        ? 'todo'
                        : 'ready'
                  }
                >
                  {saved
                    ? '새 버전으로 반영되었습니다.'
                    : relations.undecidedIds.length > 0
                      ? `지금 할 일: 사라진 관계 ${relations.undecidedIds.length}건을 판단해 주세요.`
                      : '지금 할 일: 아래 “진단하고 반영하기”에서 검사한 뒤 반영해 주세요.'}
                </p>
              </section>
              {record.basis_status !== 'current' && (
                <StatusNotice tone="warning" title="입력의 현재성 변경">
                  원문·검토·규약이 바뀌었거나 현재성을 확인할 수 없습니다. 기존
                  초안은 보존되며 적용을 중지합니다.
                </StatusNotice>
              )}
              {session.execution && (
                <ProposalExecutionPanel
                  execution={session.execution}
                  record={record}
                  disabled={controls.executionDisabled}
                  onCompare={(): void => read(record.proposal_id)}
                />
              )}
              <ProposalRelationDiff
                record={record}
                automaticPassed={automaticPassed}
                relations={relations}
                selectedId={selectedId}
                onSelect={setSelectedId}
                renderDecision={(claim: ProposalClaim): JSX.Element => (
                  <MissingClaimDecisionForm
                    drafts={session.forms}
                    key={`${draftKey}:${claim.claim_id}`}
                    draftKey={`${draftKey}:${claim.claim_id}`}
                    claim={claim}
                    graph={record.submission}
                    canRestore={canWrite}
                    disabled={controls.decisionDisabled}
                    onDecide={decide}
                  />
                )}
              />
              {record.candidate_ref && (
                <section className={styles.applyStep} aria-label="반영하기">
                  <h2>반영하기</h2>
                  {applyPart}
                </section>
              )}
              {savedPart}
              <details className={styles.diagSection} open>
                <summary>진단 결과</summary>
                <div className={styles.diagBody}>{diagnosticsPart}</div>
              </details>
              <details className={styles.diagSection}>
                <summary>판단·적용 기록</summary>
                <div className={styles.diagBody}>{recordsPart}</div>
              </details>
              <details
                open={
                  !selected || !record.basis.previous.source || !currentSource
                }
              >
                <summary>원문 전체 비교</summary>
                <div className={styles.pair}>
                  <section>
                    <h3>
                      이전 그래프의 근거 ·{' '}
                      {record.basis.previous.source
                        ? '원문 확보'
                        : '원문 미확보'}
                    </h3>
                    <pre>{sourceText(record.basis.previous.source)}</pre>
                    <details>
                      <summary>이전 추출 내용</summary>
                      <ProposalGraphDetails
                        graph={record.basis.previous.graph}
                      />
                    </details>
                  </section>
                  <section>
                    <h3>이번 추출의 전체 원문</h3>
                    <pre>{sourceText(currentSource)}</pre>
                    <details>
                      <summary>전체 추출 내용과 맥락</summary>
                      <ProposalRecordDetails record={record} />
                    </details>
                  </section>
                </div>
              </details>
              <Button
                variant="secondary"
                disabled={state.busy}
                onClick={(): void => read(record.proposal_id)}
              >
                현재 추출 결과 다시 읽기
              </Button>
              {session.forms.submit.size > 0 && (
                <details>
                  <summary>보존된 이전 편집 입력</summary>
                  {[...session.forms.submit.entries()].map(
                    (
                      [key, draft]: [string, SubmitFields],
                      index: number,
                    ): JSX.Element => {
                      const graph = parseObject(draft.whole);
                      return (
                        <details key={key}>
                          <summary>이전 편집 입력 {index + 1}</summary>
                          {graph ? (
                            <ProposalGraphDetails graph={graph} />
                          ) : (
                            <pre>{draft.whole}</pre>
                          )}
                        </details>
                      );
                    },
                  )}
                </details>
              )}
              {saved && (
                <StatusNotice title="그래프 저장 증거 확인">
                  새 버전이 저장되었습니다. 새 관계 검토와 명시 범위 완료는
                  별도입니다.
                </StatusNotice>
              )}
              {receipt && (
                <StatusNotice title="반영 요청 확인">
                  {receipt.saved === true
                    ? '저장이 확인되었습니다.'
                    : '저장 여부를 확인해 주세요.'}
                  {((): JSX.Element | null => {
                    const value = receipt.receipt;
                    const failures =
                      value !== null &&
                      typeof value === 'object' &&
                      !Array.isArray(value)
                        ? value.cleanup_failures
                        : null;
                    return Array.isArray(failures) && failures.length > 0 ? (
                      <p>
                        저장은 완료되었으며 임시 파일 정리에 문제가 있습니다.
                        같은 저장을 반복하지 마세요.
                      </p>
                    ) : null;
                  })()}
                </StatusNotice>
              )}
              {completions.length > 0 && (
                <section>
                  <h2>명시 범위 완료 기록</h2>
                  <p>
                    기록된 사라진 관계 처리·선택 주장만 완료했습니다. 전체
                    문서와 다른 주장의 승인으로 확대하지 않습니다.
                  </p>
                  <ProposalActivity items={completions} record={record} />
                </section>
              )}
            </>
          ) : (
            <p>
              현재 문서에서 추출 결과을 준비하거나 기존 추출 결과을 불러오세요.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** 연결·계정·관점·정책별 세션을 분리하며 늦은 응답이 다른 화면에 섞이지 않게 합니다. */
export function ReviewAnalysisProposals({
  gateway,
  executionGateway,
  initialDocument = '',
  initialProposalId = '',
}: ReviewAnalysisProposalsProps): JSX.Element {
  const { current, error, retry, refreshScope } = useProposalSession(
    gateway,
    executionGateway,
    initialDocument,
    initialProposalId,
  );
  if (!current)
    return (
      <section className={styles.loading}>
        <StatusNotice
          tone={error ? 'error' : 'info'}
          title={error ? '추출 결과 연결 확인' : '현재 연결 확인 중'}
        >
          {error ?? '허용된 사용자와 작업 공간을 확인합니다.'}
        </StatusNotice>
        {error && (
          <div className={styles.toolbar}>
            <Link to="/settings">연결하기</Link>
            <Button variant="secondary" onClick={retry}>
              다시 확인
            </Button>
          </div>
        )}
      </section>
    );
  return (
    <ProposalWorkspace
      key={current.key}
      session={current.session}
      document={initialDocument}
      onRefreshScope={refreshScope}
    />
  );
}

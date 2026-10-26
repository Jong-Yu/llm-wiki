import { useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import type {
  AnalysisProposalsBridge,
  AnalysisProposalRequest,
} from '@contracts/analysisProposals.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type { ProposalExecutionBridge } from '@contracts/proposalExecution.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import {
  loadProposalScope,
  loadProposalKnowledge,
} from '../api/analysisProposal.api';
import { ProposalSession } from '../model/ProposalSession';
import {
  canApplyProposal,
  confirmedApplication,
  currentProposalSource,
  parseContexts,
  parseObject,
  parseBindings,
  splitIds,
} from '../model/analysisProposal.schema';
import type {
  ProposalClaim,
  PrepareFields,
  SubmitFields,
  DecisionFields,
  CompletionFields,
} from '../model/analysisProposal.schema';
import {
  ProposalPrepareForm,
  ProposalLookupForm,
  ProposalSubmitForm,
  MissingClaimDecisionForm,
  ProposalCompletionForm,
} from './ProposalForms';
import { ProposalDiagnostics } from './ProposalDiagnostics';
import { ProposalComparison } from './ProposalComparison';
import { ProposalExecutionPanel } from './ProposalExecutionPanel';
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
type RawDetailsProps = { title: string; value: unknown };
const sessions = new Map<string, ProposalSession>();
const sessionReadiness = new Map<string, Promise<void>>();

/** 긴 근거·한정어·경고를 생략하지 않고 접힌 상세로 보존합니다. */
function RawDetails({ title, value }: RawDetailsProps): JSX.Element {
  return (
    <details>
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
/** 요청별 고정 ID는 전송 전에 만들며 재조회 시 동일 ID를 유지합니다. */
function requestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}
/** 객체에 보존된 실제 본문 문자열만 읽습니다. */
function sourceText(source: KnowledgeValue | null): string {
  return source && typeof source.content === 'string'
    ? source.content
    : '이 판본의 원문을 확보하지 못했습니다.';
}

/** 전체 후보·고정 근거·현재 검토를 분리한 저장 전 추출안 작업 화면입니다. */
function ProposalWorkspace({
  session,
  document,
  onRefreshScope,
}: ProposalWorkspaceProps): JSX.Element {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isConfirmed, setConfirmed] = useState(false);
  const record = state.record;
  const selected =
    record?.missing_claims.find(
      (claim: ProposalClaim): boolean => claim.claim_id === selectedId,
    ) ?? null;
  const savedApplications = record
    ? Object.values(record.applications).filter(
        (entry: KnowledgeValue): boolean => confirmedApplication(entry),
      )
    : [];
  const receipt = confirmedApplication(state.receipt)
    ? state.receipt
    : (savedApplications.at(-1) ?? null);
  const saved = confirmedApplication(receipt);
  const hasUncertainApplication = record
    ? Object.values(record.applications).some(
        (entry: KnowledgeValue): boolean =>
          entry.state !== 'complete' && entry.saved !== false,
      )
    : false;
  const executionState = session.execution?.snapshot();
  const executing =
    executionState?.busy ||
    executionState?.detail?.local.status === 'running' ||
    executionState?.detail?.local.status === 'stopping';
  const executionUnresolved =
    !!executionState?.request && !executionState.detail;
  const locked =
    state.busy ||
    !!state.pending ||
    state.blocked ||
    hasUncertainApplication ||
    !!executing ||
    executionUnresolved;
  const canWrite = session.scope.permissions.includes('ontology_write');
  const canReview = session.scope.permissions.includes('ontology_review');
  const editLocked =
    locked || !canWrite || record?.basis_status !== 'current' || saved;
  const draftKey = `${record?.proposal_id ?? 'prepare'}:${record?.state_revision ?? ''}`;
  const currentSource = record ? currentProposalSource(record) : null;
  const review = state.review;
  const applied =
    receipt &&
    typeof receipt.receipt === 'object' &&
    receipt.receipt !== null &&
    !Array.isArray(receipt.receipt)
      ? receipt.receipt
      : null;
  const proposalCurrentForCompletion =
    !state.receipt || state.receipt.state_revision === record?.state_revision;
  const reviewCurrent =
    !!review &&
    !!applied &&
    review.sourceRevision === applied.source_revision &&
    review.graphRevision === applied.graph_revision;
  const completions =
    record?.events.filter(
      (event: KnowledgeValue): boolean => event.kind === 'comparison_completed',
    ) ?? [];

  /** 원문 고정 전에 현재 원문·검토 판본을 읽어 서버 CAS에 전달합니다. */
  async function prepare(values: PrepareFields): Promise<void> {
    try {
      const contexts = parseContexts(values.contexts);
      if (!contexts) return;
      const knowledge = await loadProposalKnowledge(
        session.scope,
        values.document,
      );
      await session.run({
        ...session.requestFields(),
        operation: 'prepare',
        input: {
          request_id: requestId(),
          document: values.document,
          expected_source_revision: knowledge.sourceRevision,
          expected_state_revision: knowledge.stateRevision,
          context_documents: contexts,
        },
      });
    } catch (error: unknown) {
      session.fail(
        error instanceof Error
          ? error.message
          : '입력 기준 조회에 실패했습니다.',
      );
    }
  }
  /** 새 전체 결과와 명시 대응은 현재 폼의 고정 proposal 상태로 제출합니다. */
  function submit(values: SubmitFields): void {
    if (!record) return;
    const submission = parseObject(values.whole);
    const bindings = parseBindings(values.bindings);
    if (!submission || !bindings) return;
    void session.run({
      ...session.requestFields(),
      operation: 'submit',
      input: {
        proposal_id: record.proposal_id,
        request_id: requestId(),
        expected_state_revision: record.state_revision,
        submission,
        resolves_decision_ids: splitIds(values.resolves),
        resolution_bindings: bindings,
      },
    });
  }
  /** 복구·제외·재추출은 현재 선택한 실제 미발견 claim에만 적용합니다. */
  function decide(values: DecisionFields): void {
    if (!record?.candidate_ref || !selected) return;
    void session.run({
      ...session.requestFields(),
      operation: 'decide',
      input: {
        proposal_id: record.proposal_id,
        request_id: requestId(),
        expected_state_revision: record.state_revision,
        candidate_revision: record.candidate_ref.candidate_revision,
        old_claim_id: selected.claim_id,
        action: values.action,
        reason: values.reason,
        evidence: values.evidence,
        checked_whole: values.checkedWhole,
        replacement:
          values.action === 'keep' ? parseObject(values.replacement) : null,
      },
    });
  }
  /** 새 세대의 실제 서버 검토를 별도로 읽고 화면에 판본을 표시합니다. */
  async function readReview(): Promise<void> {
    if (!record) return;
    try {
      session.setReview(
        await loadProposalKnowledge(
          session.scope,
          record.basis.target_document,
        ),
      );
    } catch (error: unknown) {
      session.fail(
        error instanceof Error
          ? error.message
          : '현재 검토를 조회하지 못했습니다.',
      );
    }
  }
  /** 완료 요청은 방금 읽은 실제 검토 판본과 명시 선택만 사용합니다. */
  function complete(values: CompletionFields): void {
    if (!record || !review || !reviewCurrent) return;
    void session.run({
      ...session.requestFields(),
      operation: 'complete',
      input: {
        proposal_id: record.proposal_id,
        request_id: requestId(),
        expected_state_revision: record.state_revision,
        expected_review_state_revision: review.stateRevision,
        reviewed_claim_ids: values.reviewed,
        reason: values.reason,
      },
    });
  }
  /** 읽기는 현재 폼의 기준을 바꾸지 않고 옆의 관측 결과로 보존합니다. */
  function read(id: string): void {
    void session.run({
      ...session.requestFields(),
      operation: 'read',
      input: { proposal_id: id },
    });
  }
  /** 상태 변경 없는 검증과 고정 후보 적용을 구분합니다. */
  function validateOrApply(operation: 'validate' | 'apply'): void {
    if (!record?.candidate_ref) return;
    const request: AnalysisProposalRequest =
      operation === 'validate'
        ? {
            ...session.requestFields(),
            operation,
            input: { proposal_id: record.proposal_id },
          }
        : {
            ...session.requestFields(),
            operation,
            input: {
              proposal_id: record.proposal_id,
              request_id: requestId(),
              expected_state_revision: record.state_revision,
              candidate_revision: record.candidate_ref.candidate_revision,
            },
          };
    setConfirmed(false);
    void session.run(request);
  }

  return (
    <section className={styles.workspace} aria-label="저장 전 추출안 검토">
      <WorkspaceToolbar className={styles.toolbar}>
        <h1>추출안 비교·적용</h1>
        <span>
          {session.scope.tenant} / {session.scope.profileId}
        </span>
        <Button
          variant="secondary"
          onClick={onRefreshScope}
          disabled={state.busy}
        >
          현재 연결 확인
        </Button>
        <Link to="/analysis">AI 작업</Link>
      </WorkspaceToolbar>
      <WorkspaceLayout
        className={styles.layout}
        labels={{
          index: '추출안·미발견',
          content: '원문·전체 결과',
          inspector: '판단·적용',
        }}
      >
        <WorkspacePane name="index">
          <aside className={styles.sidebar}>
            {
              <details open={!record}>
                <summary>현재 Wiki로 새 추출안 준비</summary>
                <ProposalPrepareForm
                  drafts={session.forms}
                  draftKey="prepare"
                  document={document}
                  disabled={
                    state.busy ||
                    !!state.pending ||
                    !canWrite ||
                    !!executing ||
                    executionUnresolved
                  }
                  onPrepare={prepare}
                />
              </details>
            }
            <ProposalLookupForm
              disabled={
                state.busy ||
                !!state.pending ||
                !!executing ||
                executionUnresolved
              }
              onRead={read}
            />
            {record && (
              <>
                <h2>{record.basis.target_document}</h2>
                <p>
                  이전 주장 {record.basis.previous.claims.length} · 새 주장{' '}
                  {record.preview_claims.length} · 미발견{' '}
                  {record.missing_claims.length}
                </p>
                <p>
                  미발견은 현재 초안에 없는 관찰입니다. 삭제·누락 원인은
                  확정되지 않았습니다.
                </p>
                <ul className={styles.queue}>
                  {record.missing_claims.map(
                    (claim: ProposalClaim): JSX.Element => (
                      <li key={claim.claim_id}>
                        <button
                          type="button"
                          aria-pressed={selectedId === claim.claim_id}
                          onClick={(): void => setSelectedId(claim.claim_id)}
                        >
                          <strong>미발견 · {claim.collection}</strong>
                          <code>{claim.claim_id}</code>
                          <span>{JSON.stringify(claim.value)}</span>
                        </button>
                      </li>
                    ),
                  )}
                </ul>
                <RawDetails
                  title="추출안 ID·고정 판본"
                  value={{
                    proposal_id: record.proposal_id,
                    input_revision: record.input_revision,
                    state_revision: record.state_revision,
                    candidate_ref: record.candidate_ref,
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={state.busy}
                  onClick={(): void => read(record.proposal_id)}
                >
                  현재 추출안 다시 읽기
                </Button>
              </>
            )}
          </aside>
        </WorkspacePane>
        <WorkspacePane name="content">
          <main className={styles.content}>
            {state.archived.length > 0 && (
              <RawDetails
                title="보존된 이전 추출안·전체 근거"
                value={state.archived}
              />
            )}
            {state.recoveryNotice && (
              <StatusNotice tone="warning" title="종료 후 복구">
                {state.recoveryNotice}
              </StatusNotice>
            )}
            {state.error && (
              <StatusNotice tone="error" title="요청 결과 확인">
                {state.error}
                <p>
                  입력한 전체 초안과 근거는 이 앱 세션의 원래 범위에 보존됩니다.
                </p>
              </StatusNotice>
            )}
            {state.pending && (
              <section className={styles.notice}>
                <h2>요청 결과 확인 필요</h2>
                <p>
                  자동 재전송하지 않습니다. 요청 ID와 원래 입력으로 저장 기록을
                  확인합니다.
                </p>
                <RawDetails title="미확정 요청·판본" value={state.pending} />
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
                <h2>새로 관측한 서버 추출안</h2>
                {record && (
                  <ProposalComparison previous={record} next={state.observed} />
                )}
                <RawDetails
                  title="현재 결과와 기존 편집안 대조"
                  value={state.observed}
                />
                <p>
                  현재 폼은 기존 기준을 유지합니다. 아래 동작은 서버의 전체
                  후보로 새 편집을 시작하며 이전 입력을 별도 보존합니다.
                </p>
                <Button
                  disabled={
                    state.busy ||
                    !!state.pending ||
                    !!executing ||
                    executionUnresolved
                  }
                  onClick={(): void => {
                    session.adoptObserved();
                    setConfirmed(false);
                  }}
                >
                  대조한 서버 후보로 새 편집 시작
                </Button>
              </section>
            )}
            {record ? (
              <>
                {record.basis_status !== 'current' && (
                  <StatusNotice tone="warning" title="고정 입력의 현재성 변경">
                    원문·검토·규약이 바뀌었거나 현재성을 확인할 수 없습니다.
                    기존 초안은 보존되며 적용을 중지합니다.
                  </StatusNotice>
                )}
                <h2>이전 원문과 고정한 현재 전체 원문</h2>
                {session.execution && (
                  <ProposalExecutionPanel
                    execution={session.execution}
                    record={record}
                    disabled={
                      editLocked ||
                      !session.scope.permissions.includes('source_write')
                    }
                    onCompare={(): void => read(record.proposal_id)}
                  />
                )}
                <div className={styles.pair}>
                  <section>
                    <h3>
                      이전 그래프의 근거 ·{' '}
                      {record.basis.previous.source_restoration}
                    </h3>
                    <pre>{sourceText(record.basis.previous.source)}</pre>
                    <RawDetails
                      title="이전 전체 그래프·검토 이력"
                      value={record.basis.previous}
                    />
                  </section>
                  <section>
                    <h3>이번 추출의 전체 원문</h3>
                    <pre>{sourceText(currentSource)}</pre>
                    <RawDetails
                      title="고정 맥락·판본·미확보 범위"
                      value={record.basis}
                    />
                  </section>
                </div>
                {selected && (
                  <section>
                    <h2>선택한 이전 주장</h2>
                    <pre>{JSON.stringify(selected, null, 2)}</pre>
                    <p>
                      새 ID의 대응은 이름·문구 유사성으로 자동 추정하지
                      않습니다.
                    </p>
                  </section>
                )}
                <RawDetails
                  title="새 전체 추출안·주장 ID"
                  value={{
                    submission: record.submission,
                    claims: record.preview_claims,
                  }}
                />
                <details>
                  <summary>전체 추출안 편집·명시 대응</summary>
                  <ProposalSubmitForm
                    drafts={session.forms}
                    key={draftKey}
                    draftKey={draftKey}
                    record={record}
                    disabled={editLocked}
                    onSubmit={submit}
                  />
                </details>
                <RawDetails
                  title="고정 제출 스키마·발행 규약"
                  value={{
                    schema: record.submission_schema,
                    rules: record.rules_components,
                  }}
                />
                {saved && (
                  <StatusNotice title="그래프 저장 증거 확인">
                    새 세대의 저장 영수증이 있습니다. 실제 새 주장 검토와 명시
                    범위 완료는 별도입니다.
                  </StatusNotice>
                )}
                {receipt && (
                  <RawDetails
                    title="실제 요청 영수증·정리 경고·현재성"
                    value={receipt}
                  />
                )}
                {completions.length > 0 && (
                  <section>
                    <h2>명시 범위 완료 기록</h2>
                    <p>
                      기록된 미발견 처리·선택 주장만 완료했습니다. 전체 문서와
                      다른 주장의 승인으로 확대하지 않습니다.
                    </p>
                    <RawDetails
                      title="완료 범위·실제 검토 판본"
                      value={completions}
                    />
                  </section>
                )}
              </>
            ) : (
              <p>
                현재 Wiki로 추출안을 준비하거나 보관된 추출안 ID를 조회해
                주세요.
              </p>
            )}
          </main>
        </WorkspacePane>
        <WorkspacePane name="inspector">
          <aside className={styles.inspector}>
            <ProposalDiagnostics
              report={state.validation}
              record={
                !executing &&
                (!executionState?.request ||
                  record?.active_execution_id === executionState.executionId)
                  ? record
                  : null
              }
            />
            {record?.candidate_ref && (
              <section className={styles.form}>
                <Button
                  variant="secondary"
                  disabled={locked || saved}
                  onClick={(): void => validateOrApply('validate')}
                >
                  현재 기준·구조·인용 검증
                </Button>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={isConfirmed}
                    disabled={editLocked}
                    onChange={(): void => setConfirmed(!isConfirmed)}
                  />
                  전체 후보·미발견·근거를 확인하고 새 그래프 적용을 요청합니다.
                </label>
                <Button
                  disabled={
                    editLocked ||
                    !isConfirmed ||
                    !canApplyProposal(record, state.validation)
                  }
                  onClick={(): void => validateOrApply('apply')}
                >
                  검증한 전체 추출안 명시 적용
                </Button>
              </section>
            )}
            {selected && record && (
              <MissingClaimDecisionForm
                drafts={session.forms}
                key={`${draftKey}:${selected.claim_id}`}
                draftKey={`${draftKey}:${selected.claim_id}`}
                claim={selected}
                canRestore={canWrite}
                disabled={
                  locked ||
                  !canReview ||
                  saved ||
                  record.basis_status !== 'current'
                }
                onDecide={decide}
              />
            )}
            {record && (
              <>
                <RawDetails
                  title="미발견 판단·재추출 결정 ID"
                  value={record.decisions}
                />
                <RawDetails
                  title="요청·적용·이전 비교 기록"
                  value={record.events}
                />
                {Object.keys(record.applications).map(
                  (id: string): JSX.Element => (
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
                      적용 영수증 조회 {id.slice(0, 8)}
                    </Button>
                  ),
                )}
              </>
            )}
            {record && saved && (
              <section className={styles.form}>
                <h2>새 세대 검토</h2>
                {!proposalCurrentForCompletion && (
                  <p>
                    적용으로 추출안 상태가 갱신되었습니다. 현재 추출안을 다시
                    읽고 서버 후보로 새 편집을 시작한 뒤 완료해 주세요.
                  </p>
                )}
                <Link
                  to={`/documents?document=${encodeURIComponent(record.basis.target_document)}`}
                >
                  문서에서 실제 새 주장 검토
                </Link>
                <Button
                  variant="secondary"
                  disabled={state.busy}
                  onClick={(): void => {
                    void readReview();
                  }}
                >
                  현재 새 세대 검토 읽기
                </Button>
                {review && (
                  <>
                    <RawDetails title="현재 검토·주장·판본" value={review} />
                    {!reviewCurrent && (
                      <StatusNotice
                        tone="warning"
                        title="적용 결과와 현재 검토가 다름"
                      >
                        원문 또는 그래프 판본이 달라 완료할 수 없습니다.
                      </StatusNotice>
                    )}
                    <ProposalCompletionForm
                      drafts={session.forms}
                      key={`${draftKey}:${review.stateRevision}`}
                      draftKey={`${draftKey}:${review.stateRevision}`}
                      review={review}
                      disabled={
                        locked ||
                        !canReview ||
                        !reviewCurrent ||
                        !proposalCurrentForCompletion
                      }
                      onComplete={complete}
                    />
                  </>
                )}
              </section>
            )}
          </aside>
        </WorkspacePane>
      </WorkspaceLayout>
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
  const [refresh, setRefresh] = useState(0);
  const [current, setCurrent] = useState<{
    key: string;
    session: ProposalSession;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) => {
    let alive = true;
    void loadProposalScope()
      .then(
        async (
          scope: Awaited<ReturnType<typeof loadProposalScope>>,
        ): Promise<void> => {
          if (!alive) return;
          const key = JSON.stringify([
            scope.connectionId,
            scope.userId,
            scope.tenant,
            scope.profileId,
            scope.policyRevision,
            initialDocument,
            initialProposalId,
          ]);
          let session = sessions.get(key);
          if (!session) {
            session = new ProposalSession(scope, gateway, executionGateway);
            sessions.set(key, session);
            const recoverySession = session;
            const ready = (async (): Promise<void> => {
              const digest = await crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(
                  JSON.stringify([initialDocument, initialProposalId]),
                ),
              );
              const recoveryKey = [...new Uint8Array(digest)]
                .map((value: number): string =>
                  value.toString(16).padStart(2, '0'),
                )
                .join('');
              await recoverySession.initializeRecovery(recoveryKey);
            })();
            sessionReadiness.set(key, ready);
          }
          await sessionReadiness.get(key);
          if (!alive) return;
          setCurrent({ key, session });
          if (
            initialProposalId &&
            !session.snapshot().record &&
            !session.snapshot().busy
          )
            void session.run({
              ...session.requestFields(),
              operation: 'read',
              input: { proposal_id: initialProposalId },
            });
        },
      )
      .catch((reason: unknown): void => {
        if (alive)
          setError(
            reason instanceof Error
              ? reason.message
              : '연결 범위를 확인할 수 없습니다.',
          );
      });
    return (): void => {
      alive = false;
    };
  }, [gateway, executionGateway, initialDocument, initialProposalId, refresh]);
  if (!current)
    return (
      <section className={styles.loading}>
        <StatusNotice
          tone={error ? 'error' : 'info'}
          title={error ? '추출안 연결 확인' : '현재 연결 확인 중'}
        >
          {error ?? '허용된 사용자·작업 공간·관점을 확인합니다.'}
        </StatusNotice>
        <Link to="/setup/connection">서버 연결·작업 공간 선택</Link>
        <Button
          variant="secondary"
          onClick={(): void => setRefresh(refresh + 1)}
        >
          다시 확인
        </Button>
      </section>
    );
  return (
    <ProposalWorkspace
      key={current.key}
      session={current.session}
      document={initialDocument}
      onRefreshScope={(): void => {
        setCurrent(null);
        setError(null);
        setRefresh(refresh + 1);
      }}
    />
  );
}

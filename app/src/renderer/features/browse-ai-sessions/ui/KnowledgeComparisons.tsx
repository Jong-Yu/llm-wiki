import { documentDisplayName } from '@renderer/domains/documents';
import { Icon } from '@renderer/shared/ui/Icon';
import type { ChangeEvent, JSX } from 'react';
import { Link } from 'react-router';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import type {
  KnowledgeComparisonCandidate,
  KnowledgeComparisonItem,
  KnowledgeComparisonReference,
} from '@contracts/knowledgeComparisons.contract';
import { useKnowledgeComparisons } from '../model/useKnowledgeComparisons';
import { usageTime } from '../model/sessionPresentation';
import { KnowledgeComparisonSkeleton } from './KnowledgeComparisonSkeleton';
import styles from './AiSessions.module.scss';

type KnowledgeComparisonsProps = {
  jobId: string | null;
  documentPath: string | null;
  comparisonId?: string | null;
  watch?: boolean;
};
type CandidateCardProps = {
  candidate: KnowledgeComparisonCandidate;
  reference?: KnowledgeComparisonReference;
  excluded?: boolean;
};

/** 저장 상태 표현은 원문 그대로 두되 알 수 없는 구조를 승인으로 해석하지 않습니다. */
function reviewLabel(value: unknown): string {
  if (typeof value !== 'string') return '상세 근거에서 확인';
  const labels: Record<string, string> = {
    unreviewed: '미검토',
    accepted: '수용',
    rejected: '기각',
    pending: '검토 대기',
    active: '적용 중',
    inactive: '비활성',
    current: '현재',
    stale: '이전 기준',
    not_reviewed: '미검토',
  };
  return labels[value] ?? value;
}

/** AI 후보의 이유와 실제 검색 참조만 표시하고 확정 관계·전문가 승인으로 바꾸지 않습니다. */
function CandidateCard({
  candidate,
  reference,
  excluded,
}: CandidateCardProps): JSX.Element {
  const snapshot = reference?.target_ref.snapshot;
  const anchor = reference?.target_ref.anchor;
  const evidence =
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? Reflect.get(snapshot, 'evidence')
      : undefined;
  const quotes = Array.isArray(evidence)
    ? evidence
        .filter(
          (entry: unknown): entry is { quote: string } =>
            entry !== null &&
            typeof entry === 'object' &&
            'quote' in entry &&
            typeof entry.quote === 'string',
        )
        .map((entry: { quote: string }): string => entry.quote)
    : [];
  if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
    const quote: unknown = Reflect.get(anchor, 'quote');
    if (typeof quote === 'string') quotes.push(quote);
  }
  return (
    <details
      className={styles.candidate}
      open={candidate.unconfirmed.length > 0 || !reference}
    >
      <summary>
        <h4>
          {reference?.document
            ? documentDisplayName(reference.document)
            : excluded
              ? '제외한 항목'
              : '관련 후보'}
        </h4>
        <p>{candidate.reason}</p>
      </summary>
      {!reference && (
        <p role="status">보관된 근거 참조를 확인하지 못했습니다.</p>
      )}
      {reference && (
        <>
          <p className={styles.note}>
            일치한 검색 단서: {reference.matched_terms.join(' · ') || '없음'}
          </p>
          {reference.matched_fields.map(
            (
              item: KnowledgeComparisonReference['matched_fields'][number],
              index: number,
            ): JSX.Element => (
              <blockquote key={`${item.field}:${index}`}>
                {item.expression}
              </blockquote>
            ),
          )}
          {[...new Set(quotes)].map((quote: string): JSX.Element => (
            <blockquote key={quote}>{quote}</blockquote>
          ))}
          <p className={styles.note}>
            원문 검토: {reviewLabel(reference.review_status)} · 전문가 판단:{' '}
            {reviewLabel(reference.policy_status)}
          </p>
          {reference.document && (
            <Link
              to={`/document?path=${encodeURIComponent(reference.document)}`}
            >
              근거 문서 열기 <Icon name="external-link" size={14} />
            </Link>
          )}
        </>
      )}
      {candidate.unconfirmed.length > 0 && (
        <div>
          <h5>확인하지 못한 점</h5>
          <ul className={styles.checkList}>
            {candidate.unconfirmed.map((item: string): JSX.Element => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}

/** 최신·이전 대조 결과와 부분 실패를 보관된 실행별로 확인하고 재대조는 명시 요청합니다. */
export function KnowledgeComparisons({
  jobId,
  documentPath,
  comparisonId,
  watch = false,
}: KnowledgeComparisonsProps): JSX.Element {
  const model = useKnowledgeComparisons(
    jobId,
    documentPath,
    comparisonId,
    watch,
  );
  const detail = model.detail;
  const running =
    model.local?.status === 'running' || model.local?.status === 'stopping';
  const uncertain =
    model.local?.requestId !== null && model.local?.requestId !== undefined;
  const labels = {
    running: '대조 진행 중',
    complete: '대조 완료',
    incomplete: '대조 미완료',
  };
  return (
    <WorkspaceSection
      title="기존 지식 대조"
      className={styles.comparisons}
      actions={
        <button type="button" disabled={model.busy} onClick={model.reload}>
          대조 결과 새로고침
        </button>
      }
    >
      {model.error && <p role="alert">{model.error}</p>}
      {model.busy && !detail && model.items.length === 0 && (
        <KnowledgeComparisonSkeleton />
      )}
      {model.items.length === 0 && !model.busy && !model.error && (
        <p className={styles.note}>저장된 대조 결과가 없습니다.</p>
      )}
      {model.items.length > 0 && (
        <label className={styles.recordPicker}>
          실행 기록{' '}
          <select
            value={model.selectedId ?? ''}
            disabled={model.busy}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
              model.select(event.currentTarget.value)
            }
          >
            {model.items.map(
              (item: KnowledgeComparisonItem, index: number): JSX.Element => (
                <option key={item.id} value={item.id}>
                  {index === 0 ? '최신 · ' : '이전 · '}
                  {usageTime(item.created_at)} · {labels[item.status]}
                </option>
              ),
            )}
          </select>
        </label>
      )}
      {model.busy && !detail && model.items.length > 0 && (
        <KnowledgeComparisonSkeleton showPicker={false} />
      )}
      {model.incomplete && (
        <p role="status">
          최근 실행 일부를 표시합니다. 이전 기록은 계속 보관됩니다.
        </p>
      )}
      {detail && (
        <details
          className={styles.comparisonResult}
          open={
            !!comparisonId ||
            running ||
            uncertain ||
            detail.status !== 'complete' ||
            !detail.coverage?.complete ||
            detail.coverage?.truncated ||
            !!detail.coverage?.skipped.length ||
            detail.currentness.status === 'needs_recheck' ||
            !!detail.result?.unconfirmed.length ||
            !!detail.result?.unassessed_reference_ids?.length ||
            !!model.local?.cleanupWarning
          }
        >
          <summary>
            {labels[detail.status]} · 관련 후보{' '}
            {detail.result?.candidates.length ?? 0}개
            <small>
              조회 {detail.lookup_count} / {detail.lookup_limit}회
            </small>
          </summary>
          <div className={styles.comparisonBody}>
            {(!detail.coverage ||
              !detail.coverage.complete ||
              detail.coverage.truncated ||
              detail.coverage.skipped.length > 0) && (
              <p role="status">
                검색·조회 범위 일부를 확인하지 못했습니다. 후보가 없다는 이유로
                관련 지식이 없다고 확정할 수 없습니다.
              </p>
            )}
            {detail.coverage?.lookup_limit_reached && (
              <p role="status">
                조회 5회 한도에 도달했습니다. 확인하지 못한 범위가 남을 수
                있습니다.
              </p>
            )}
            {detail.coverage?.seed_terms_truncated && (
              <p role="status">첫 검색은 추출된 단서 일부를 사용했습니다.</p>
            )}
            {detail.currentness.status === 'needs_recheck' && (
              <p role="status">
                재확인 필요: 대조에 사용한 문서·근거가 변경됐거나 현재 읽을 수
                없습니다. 이전 결과는 보존됩니다.
              </p>
            )}
            {model.local?.message && <p role="status">{model.local.message}</p>}
            {model.local?.cleanupWarning && (
              <p role="status">
                저장 확인 기록 정리 경고가 있습니다. 결과를 다시 확인한 뒤
                진행해 주세요.
              </p>
            )}
            {model.local?.resultId &&
              model.local.resultId !== model.selectedId && (
                <button
                  type="button"
                  disabled={model.busy}
                  onClick={(): void => {
                    if (model.local?.resultId)
                      model.select(model.local.resultId);
                  }}
                >
                  새 대조 결과 보기
                </button>
              )}
            <div className={styles.actions}>
              <button
                type="button"
                disabled={
                  model.busy ||
                  running ||
                  uncertain ||
                  detail.status === 'running'
                }
                onClick={(): void => {
                  void model.restart();
                }}
              >
                최신 자료로 검색·대조 다시 실행
              </button>
              {(running || detail.status === 'running') && (
                <button
                  type="button"
                  disabled={model.busy || model.local?.status === 'stopping'}
                  onClick={(): void => {
                    void model.stop();
                  }}
                >
                  이 대조 중단
                </button>
              )}
            </div>
            <p className={styles.note}>
              재실행은 검색·대조만 새로 시작하며 이전 결과는 남습니다.
            </p>
            {detail.result?.failure && (
              <p role="alert">미완료 사유: {detail.result.failure}</p>
            )}
            {detail.result?.unconfirmed.length ? (
              <section className={styles.resultGroup}>
                <h3>남은 확인 사항</h3>
                <ul className={styles.checkList}>
                  {detail.result.unconfirmed.map(
                    (item: string): JSX.Element => (
                      <li key={item}>{item}</li>
                    ),
                  )}
                </ul>
              </section>
            ) : null}
            <section className={styles.resultGroup}>
              <h3>
                관련 후보 {detail.result?.candidates.length ?? 0}개
                <small>AI 검색 후보 · 확정 관계 아님</small>
              </h3>
              {detail.result?.candidates.map(
                (candidate: KnowledgeComparisonCandidate): JSX.Element => (
                  <CandidateCard
                    key={candidate.reference_id}
                    candidate={candidate}
                    reference={detail.references.find(
                      (item: KnowledgeComparisonReference): boolean =>
                        item.reference_id === candidate.reference_id,
                    )}
                  />
                ),
              )}
              {detail.result && detail.result.candidates.length === 0 && (
                <p>이번 실행에서 관련 후보로 남긴 항목이 없습니다.</p>
              )}
            </section>
            {detail.result?.excluded.length ? (
              <details className={styles.record}>
                <summary>
                  제외한 항목과 이유 {detail.result.excluded.length}개
                </summary>
                {detail.result.excluded.map(
                  (candidate: KnowledgeComparisonCandidate): JSX.Element => (
                    <CandidateCard
                      key={candidate.reference_id}
                      candidate={candidate}
                      excluded
                      reference={detail.references.find(
                        (item: KnowledgeComparisonReference): boolean =>
                          item.reference_id === candidate.reference_id,
                      )}
                    />
                  ),
                )}
              </details>
            ) : null}
            {!detail.result && detail.references.length > 0 && (
              <p>
                현재까지 {detail.references.length}개 검색 참조가 보관됐습니다.
                관련성 판단은 아직 완료되지 않았습니다.
              </p>
            )}
            {!!detail.result?.unassessed_reference_ids?.length && (
              <p role="status">
                관련성을 끝까지 확인하지 못한 검색 참조{' '}
                {detail.result.unassessed_reference_ids.length}개가 남아
                있습니다.
              </p>
            )}
          </div>
        </details>
      )}
    </WorkspaceSection>
  );
}

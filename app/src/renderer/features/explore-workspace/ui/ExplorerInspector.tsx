import type { JSX } from 'react';
import { Link } from 'react-router';
import type {
  KnowledgeValue,
  KnowledgeJson,
} from '@contracts/knowledge.contract';
import { Button } from '@renderer/shared/ui/Button';
import {
  evidenceTexts,
  object,
  stringField,
  statusLabel,
  kindLabel,
  eventDescription,
  assertionTitle,
} from '../model/explorerPresentation';
import type { ExplorerRow } from '../model/explorerPresentation';
import styles from './WorkspaceExplorer.module.scss';

type ExplorerInspectorProps = {
  row: ExplorerRow | null;
  onQueryTarget: (target: KnowledgeValue) => void;
  onReview?: () => void;
  busy: boolean;
  presentation?: 'inspector' | 'detail';
};
type EventSnapshotProps = { label: string; value: KnowledgeJson | undefined };

/** 변경 당시 판단을 요약하고 전체 저장 값은 펼쳐 확인합니다. */
function EventSnapshot({ label, value }: EventSnapshotProps): JSX.Element {
  const record = object(value);
  const assertion = record
    ? object(record.reviewed_value) || object(record.value)
    : null;
  const decision = record
    ? stringField(record, 'decision') || stringField(record, 'action')
    : null;
  return (
    <section className={styles.snapshot}>
      <h4>{label}</h4>
      {decision && (
        <span className={styles.badge}>{statusLabel(decision)}</span>
      )}
      {assertion && <p>{assertionTitle(assertion)}</p>}
      <details>
        <summary>{label} 전체 값</summary>
        <pre>{JSON.stringify(value ?? null, null, 2)}</pre>
      </details>
    </section>
  );
}

/** 선택 주장의 인용을 먼저 보여주고 판본과 원형 값은 펼쳐 확인합니다. */
export function ExplorerInspector({
  row,
  onQueryTarget,
  onReview,
  busy,
  presentation = 'inspector',
}: ExplorerInspectorProps): JSX.Element {
  if (!row)
    return (
      <aside
        className={styles.inspector}
        data-presentation={presentation}
        aria-label="선택 항목 근거"
      >
        <header>
          <h2>근거와 범위</h2>
        </header>
        <p className={styles.caption}>
          목록이나 지도에서 항목을 선택하면 원문 인용과 조건을 확인할 수
          있습니다.
        </p>
      </aside>
    );
  const event = object(row.value.event);
  const claim = object(row.value.claim);
  // 이력의 앞뒤 전체 원장에서 다른 주장의 인용을 현재 선택의 근거로 섞지 않습니다.
  const evidenceValue = event
    ? { reason: event.reason ?? null }
    : claim
      ? object(claim.reviewed_value) || object(claim.value) || claim
      : row.value;
  const evidence = evidenceTexts(evidenceValue);
  const ref =
    object(row.value.ref) || object(row.value.provenance) || row.target;
  const sourceRef = object(row.value.source_ref);
  const fields: KnowledgeValue = {
    ...ref,
    ...sourceRef,
    ...(event || {}),
    ...row.value,
  };
  const names: { key: string; label: string }[] = [
    { key: 'source_revision', label: '원문 판본' },
    { key: 'graph_revision', label: '그래프 판본' },
    { key: 'state_revision', label: '검토 상태 판본' },
    { key: 'history_revision', label: '이력 판본' },
    { key: 'review_revision', label: '검토 원장 판본' },
    { key: 'snapshot_revision', label: '조회 지문' },
    { key: 'timestamp', label: '기록 시각' },
    { key: 'created_at', label: '생성 시각' },
    { key: 'id', label: '이벤트/개체 번호' },
    { key: 'source_id', label: '등록 원본 번호' },
    { key: 'source_version', label: '고정 원본 판본' },
    { key: 'source_sha256', label: '원본 SHA-256' },
  ];
  const content = stringField(row.value, 'content');
  const assertion = claim
    ? object(claim.reviewed_value) || object(claim.value)
    : ['relations', 'attributes', 'relation_candidates'].includes(row.kind)
      ? row.value
      : null;
  const qualifiers = assertion ? object(assertion.qualifiers) : null;
  const qualifierLabels: Record<string, string> = {
    condition: '적용 조건',
    conditions: '적용 조건',
    exceptions: '예외',
    exception: '예외',
    scope: '적용 범위',
    time: '시점',
    temporal: '시점',
    polarity: '극성',
    modality: '양태',
    certainty: '확실성',
    attribution: '발화 주체',
  };
  const visibleQualifiers = Object.entries(qualifiers || {}).filter(
    ([, value]: [string, KnowledgeJson]): boolean =>
      value !== null &&
      value !== '' &&
      (!Array.isArray(value) || value.length > 0),
  );
  const eventMeta = eventDescription(row);
  const target = row.target;
  return (
    <aside
      className={styles.inspector}
      data-presentation={presentation}
      aria-label="선택 항목 근거"
    >
      <header>
        <h2>
          {event
            ? '변경 기록'
            : row.kind === 'entities'
              ? '선택한 개념'
              : '선택한 근거'}
        </h2>
        <span className={styles.badge}>
          {statusLabel(row.status) || kindLabel(row.kind)}
        </span>
      </header>
      <div className={styles.detailHeading}>
        <h3>{row.title}</h3>
        {eventMeta && <p className={styles.caption}>{eventMeta}</p>}
      </div>
      <div className={styles.detailActions}>
        {row.document && (
          <Link
            className={styles.link}
            to={`/documents?document=${encodeURIComponent(row.document)}`}
          >
            문서 열기 · {row.document}
          </Link>
        )}
        {target && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={(): void => onQueryTarget(target)}
          >
            이 대상의 연결 조회
          </Button>
        )}
        {onReview && (
          <Button disabled={busy} onClick={onReview}>
            현재 원문과 대조해 검토
          </Button>
        )}
      </div>
      {evidence.length > 0 && (
        <section className={styles.evidence}>
          <h3>{event ? '기록한 이유' : '원문 근거'}</h3>
          {evidence.map((quote: string, index: number): JSX.Element => (
            <blockquote key={index}>{quote}</blockquote>
          ))}
        </section>
      )}
      {evidence.length === 0 && content === null && (
        <p className={styles.caption}>
          이 항목에 표시할 인용은 없습니다. 문서와 저장된 상세 값을 확인해
          주세요.
        </p>
      )}
      {visibleQualifiers.length > 0 && (
        <section>
          <h3>조건·적용 범위</h3>
          <dl className={styles.qualifiers}>
            {visibleQualifiers.map(
              ([key, value]: [string, KnowledgeJson]): JSX.Element => (
                <div key={key}>
                  <dt>{qualifierLabels[key] || key}</dt>
                  <dd>
                    {typeof value === 'string' ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ),
            )}
          </dl>
        </section>
      )}
      {content !== null && (
        <details open className={styles.sourceDetails}>
          <summary>조회한 원문 전체</summary>
          <pre className={styles.source}>{content}</pre>
        </details>
      )}
      {event && (event.before !== undefined || event.after !== undefined) && (
        <section aria-label="기록 당시 변경">
          <h3>기록 당시 변경</h3>
          <p className={styles.caption}>이 사건을 저장했을 때의 값입니다.</p>
          <div className={styles.snapshots}>
            <EventSnapshot label="변경 전" value={event.before} />
            <EventSnapshot label="변경 후" value={event.after} />
          </div>
        </section>
      )}
      <details className={styles.technicalDetails}>
        <summary>판본과 출처 정보</summary>
        <dl>
          {names.flatMap(
            (entry: { key: string; label: string }): JSX.Element[] => {
              const value = fields[entry.key];
              return typeof value === 'string'
                ? [
                    <div key={entry.key}>
                      <dt>{entry.label}</dt>
                      <dd>{value}</dd>
                    </div>,
                  ]
                : [];
            },
          )}
        </dl>
      </details>
      <details className={styles.technicalDetails}>
        <summary>저장된 항목 전체</summary>
        <pre>{JSON.stringify(row.value, null, 2)}</pre>
      </details>
    </aside>
  );
}

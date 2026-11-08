import {
  formatTimestamp,
  formatTimestampWithZone,
} from '@renderer/shared/lib/formatTimestamp';
import { Icon } from '@renderer/shared/ui/Icon';
import { useId, useState } from 'react';
import type { ChangeEvent, JSX, SubmitEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router';
import type {
  CleanupEvent,
  CleanupItem,
  CleanupPreview,
} from '@contracts/ontologyCleanup.contract';
import type {
  DocumentKnowledge,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { WorkspacePage } from '@renderer/shared/ui/WorkspacePage';
import type { OntologyScope } from '../model/ontologyMap.types';
import { useOntologyCleanup } from '../model/useOntologyCleanup';
import { OntologyCleanupItem } from './OntologyCleanupItem';
import styles from './OntologyCleanupPage.module.scss';
import { Tabs } from '@renderer/shared/ui/Tabs';
import { useOntologyTaskFocus } from '../model/useOntologyTaskFocus';

type OntologyCleanupPageProps = {
  scope: OntologyScope;
  documents: DocumentKnowledge[];
  incomplete: boolean;
  selectedDocument: string | null;
  onDocumentChange: (document: string) => void;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  onInvalidate: () => void;
};
const reasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, '이유를 입력해 주세요.')
    .max(1000, '이유는 1,000자 이내로 입력해 주세요.'),
});
type ReasonValues = z.infer<typeof reasonSchema>;
const kindNames: Record<string, string> = {
  archive_rejected: '반려된 관계·후보',
  archive_pending_review: '과거 버전의 검토',
  exact_duplicates: '동일 관계 중복',
  deferred_or_uncertain: '보류·근거 부족·미검토',
};
const reasonNames: Record<string, string> = {
  eligible_items: '선택하여 정리 가능',
  no_eligible_items: '해당 항목 없음',
  duplicate_claims_prevented_by_validation:
    '동일 관계는 저장 시 중복이 차단됩니다. 병합 대상이 아닙니다.',
  requires_explicit_review:
    '별도 검토가 필요합니다. 근거 부족을 틀림으로 바꾸지 않습니다.',
};

/** 서버 미리보기에서 고른 항목만 정리하고 결과 확인·이력·되돌림을 제공합니다. */
export function OntologyCleanupPage({
  scope,
  documents,
  incomplete,
  selectedDocument,
  onDocumentChange,
  open,
  onClose,
  onChanged,
  onInvalidate,
}: OntologyCleanupPageProps): JSX.Element {
  const labelId = useId();
  const focusAnchor = useOntologyTaskFocus(open);
  const model = useOntologyCleanup(
    scope,
    selectedDocument || documents[0]?.document || '',
    onChanged,
    onInvalidate,
  );
  const [tab, setTab] = useState<'preview' | 'history'>('preview');
  const [undoId, setUndoId] = useState<string | null>(null);
  const form = useForm<ReasonValues>({
    resolver: zodResolver(reasonSchema),
    defaultValues: { reason: '' },
  });
  const knowledge = documents.find(
    (item: DocumentKnowledge): boolean => item.document === model.document,
  );
  const canWrite = scope.permissions.includes('ontology_review');
  const blocked = model.busy || !!model.pending;
  const undoEvent = model.history?.items.find(
    (event: CleanupEvent): boolean => event.id === undoId,
  );
  const incompletePreview =
    !!model.preview &&
    (!model.preview.complete ||
      model.preview.truncated ||
      model.preview.skipped.length > 0 ||
      model.preview.requires_refresh);
  const undone = new Set(
    model.history?.items.map(
      (event: CleanupEvent): string | null => event.undo_of,
    ),
  );

  /** 원래 판단 이력은 현재 목록에 되살리지 않고 근거 표시에만 사용합니다. */
  function judgment(item: CleanupItem): KnowledgeValue | undefined {
    return knowledge?.history.find(
      (entry: KnowledgeValue): boolean => entry.id === item.event_id,
    );
  }
  /** 선택과 이유를 갖춘 명시 제출만 실행합니다. */
  async function submit(values: ReasonValues): Promise<void> {
    if (tab === 'preview') await model.apply(values.reason);
    else if (undoEvent) await model.undo(undoEvent, values.reason);
  }

  const previewContent = (
    <div className={styles.previewBody}>
      {model.preview && (
        <>
          <dl
            className={styles.capabilitySummary}
            aria-label="정리 가능한 유형"
          >
            {model.preview.capabilities
              .filter(
                (capability: CleanupPreview['capabilities'][number]): boolean =>
                  capability.kind === 'archive_rejected' ||
                  capability.kind === 'archive_pending_review',
              )
              .map(
                (
                  capability: CleanupPreview['capabilities'][number],
                ): JSX.Element => (
                  <div key={capability.kind}>
                    <dt>{kindNames[capability.kind]}</dt>
                    <dd>{capability.count}개</dd>
                  </div>
                ),
              )}
          </dl>
          <details className={styles.excludedTypes}>
            <summary>정리 범위와 제외 유형의 이유</summary>
            <ul className={styles.capabilities}>
              {model.preview.capabilities.map(
                (
                  capability: CleanupPreview['capabilities'][number],
                ): JSX.Element => (
                  <li key={capability.kind}>
                    <strong>
                      {kindNames[capability.kind] || '기타 유형'} ·{' '}
                      {capability.kind === 'archive_rejected' ||
                      capability.kind === 'archive_pending_review'
                        ? `${capability.count}개`
                        : '정리 제외'}
                    </strong>
                    <span>
                      {reasonNames[capability.reason] ||
                        (capability.available
                          ? '선택하여 정리 가능'
                          : '현재 처리할 수 없는 유형입니다.')}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </details>
          {model.preview.status !== 'ready' && (
            <p className={styles.notice}>
              현재 원문 기준의 관계가 준비되지 않았습니다. 과거 검토 여부는 아래
              항목에서 확인해 주세요.
            </p>
          )}
          {incompletePreview && (
            <p role="status" className={styles.notice}>
              일부 결과입니다. 현재 {model.preview.items.length}개 / 전체{' '}
              {model.preview.total_items}개
              {model.preview.requires_refresh
                ? ' · 자료가 변경되어 새 미리보기가 필요합니다.'
                : ''}
              {model.preview.skipped.length > 0
                ? ` · 읽지 못한 항목 ${model.preview.skipped.length}개`
                : ''}
            </p>
          )}
          {model.preview.items.length === 0 && (
            <p className={styles.empty}>
              {incompletePreview
                ? '현재 페이지에 정리 대상이 없습니다.'
                : '이 문서에 정리할 항목이 없습니다.'}
            </p>
          )}
          <ul className={styles.items}>
            {model.preview.items.map((item: CleanupItem): JSX.Element => (
              <li
                key={item.item_id}
                data-selected={
                  model.selected.includes(item.item_id) || undefined
                }
              >
                <input
                  type="checkbox"
                  id={`${labelId}-${item.item_id}-select`}
                  aria-labelledby={`${labelId}-${item.item_id}-title`}
                  aria-describedby={`${labelId}-${item.item_id}-kind`}
                  checked={model.selected.includes(item.item_id)}
                  disabled={
                    blocked ||
                    !canWrite ||
                    model.preview?.requires_refresh ||
                    (!model.selected.includes(item.item_id) &&
                      model.selected.length >= 50)
                  }
                  onChange={(): void => model.toggle(item.item_id)}
                />
                <OntologyCleanupItem
                  item={item}
                  judgment={judgment(item)}
                  titleId={`${labelId}-${item.item_id}-title`}
                  checkboxId={`${labelId}-${item.item_id}-select`}
                  kindId={`${labelId}-${item.item_id}-kind`}
                />
              </li>
            ))}
          </ul>
          {model.preview.next_cursor && (
            <button
              type="button"
              disabled={blocked}
              onClick={(): void => {
                void model.previewPage(true);
              }}
            >
              다음 정리 대상 읽기
            </button>
          )}
        </>
      )}
    </div>
  );
  const historyContent = (
    <div className={styles.previewBody}>
      {model.history && (
        <>
          {(!model.history.complete ||
            model.history.truncated ||
            model.history.skipped.length > 0 ||
            model.history.requires_refresh) && (
            <p className={styles.notice}>
              이력 일부를 표시합니다. {model.history.items.length}개 / 전체{' '}
              {model.history.total_items}개
            </p>
          )}
          {model.history.items.length === 0 && (
            <p className={styles.empty}>이 문서의 정리 이력이 없습니다.</p>
          )}
          <ul className={styles.history}>
            {model.history.items.map((event: CleanupEvent): JSX.Element => {
              const sameScope =
                event.scope.domain === knowledge?.selection.domain &&
                event.scope.viewpoint === knowledge?.selection.viewpoint;
              return (
                <li key={event.id}>
                  <strong>
                    {event.action === 'cleanup_apply'
                      ? '정리 적용'
                      : '정리 되돌림'}{' '}
                    · {event.items.length}개
                  </strong>
                  <time
                    dateTime={event.timestamp}
                    title={formatTimestampWithZone(event.timestamp)}
                  >
                    {formatTimestamp(event.timestamp)}
                  </time>
                  <p>{event.reason}</p>
                  {event.action === 'cleanup_apply' && (
                    <label>
                      <input
                        type="radio"
                        name="cleanup-undo"
                        checked={undoId === event.id}
                        disabled={
                          blocked ||
                          !canWrite ||
                          !sameScope ||
                          undone.has(event.id) ||
                          model.history?.requires_refresh
                        }
                        onChange={(): void => {
                          setUndoId(event.id);
                          form.reset();
                        }}
                      />
                      {undone.has(event.id)
                        ? '되돌림 완료'
                        : sameScope
                          ? '이 정리 전체 되돌리기'
                          : '이전 조회 기준의 정리'}
                    </label>
                  )}
                  <details>
                    <summary>보존된 항목·근거 {event.items.length}개</summary>
                    {event.items.map((item: CleanupItem): JSX.Element => (
                      <OntologyCleanupItem
                        key={item.item_id}
                        item={item}
                        judgment={judgment(item)}
                      />
                    ))}
                  </details>
                </li>
              );
            })}
          </ul>
          {model.history.next_cursor && (
            <button
              type="button"
              disabled={model.busy}
              onClick={(): void => {
                void model.historyPage(true);
              }}
            >
              이전 정리 이력 읽기
            </button>
          )}
        </>
      )}
    </div>
  );

  return (
    <WorkspacePage
      hidden={!open}
      onBack={onClose}
      title="관계 정리"
      className={styles.page}
    >
      <div ref={focusAnchor} className={styles.root}>
        <div className={styles.toolbar}>
          <label className={styles.scope}>
            대상 문서
            <select
              aria-label="정리할 문서"
              value={model.document}
              disabled={blocked}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                onDocumentChange(event.target.value);
              }}
            >
              {documents.map((item: DocumentKnowledge): JSX.Element => (
                <option key={item.document} value={item.document}>
                  {item.document}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!!model.pending || !model.document}
            aria-disabled={model.busy || undefined}
            onClick={(): void => {
              if (blocked) return;
              if (tab === 'preview') void model.previewPage();
              else {
                setUndoId(null);
                void model.historyPage();
              }
            }}
          >
            <Icon name="refresh-cw" size={14} />
            {tab === 'preview'
              ? model.phase === 'preview'
                ? '확인 중…'
                : '새 미리보기 확인'
              : model.phase === 'history'
                ? '읽는 중…'
                : '이력 새로고침'}
          </button>
        </div>
        {incomplete && (
          <p className={styles.muted}>
            현재 불러온 문서만 선택할 수 있습니다. 다른 문서는 이전 목록에서
            다음 문서 범위를 읽어 주세요.
          </p>
        )}
        {!canWrite && (
          <p className={styles.notice}>
            현재 계정은 미리보기와 이력만 조회할 수 있습니다. 적용에는 검토
            권한이 필요합니다.
          </p>
        )}
        {model.error && (
          <div role="alert" className={styles.error}>
            <strong>
              {model.pending
                ? '저장 결과 확인 필요'
                : model.error.status === 409
                  ? '자료가 변경되었습니다'
                  : '처리하지 못했습니다'}
            </strong>
            <p>{model.error.message}</p>
            {(model.preview || model.history) && (
              <p>아래에는 마지막으로 확인한 결과를 표시합니다.</p>
            )}
            {model.error.cleanupWarningCount ? (
              <p>임시 파일 정리 경고 {model.error.cleanupWarningCount}건</p>
            ) : null}
            {model.error.status === 409 && (
              <p>새 미리보기 또는 이력을 읽고 선택을 다시 확인해 주세요.</p>
            )}
          </div>
        )}
        {model.pending && (
          <div className={styles.notice} role="status">
            <p>
              {model.phase === 'apply' || model.phase === 'undo'
                ? '적용 중입니다. 다른 화면으로 이동해도 저장이 취소되지는 않습니다.'
                : '결과를 확인할 때까지 재적용하지 않습니다.'}
            </p>
            <button
              type="button"
              disabled={model.busy}
              onClick={(): void => {
                void model.checkReceipt();
              }}
            >
              저장 결과 확인
            </button>
          </div>
        )}
        {model.receipt && (
          <div role="status" className={styles.success}>
            <strong>
              {model.receipt.event.action === 'cleanup_undo'
                ? '정리를 되돌렸습니다.'
                : `${model.receipt.event.items.length}개 항목을 정리했습니다.`}
            </strong>
            <p>
              {model.receipt.event.action === 'cleanup_undo'
                ? '과거 버전의 판단을 현재 승인으로 바꾸지는 않습니다.'
                : '원문과 판단 이력은 보존되었습니다.'}
            </p>
            {model.receipt.cleanup_failures.length > 0 && (
              <p>
                저장은 완료됐지만 임시 파일 정리{' '}
                {model.receipt.cleanup_failures.length}건을 확인해야 합니다.
                다시 적용하지 마세요.
              </p>
            )}
          </div>
        )}
        <Tabs
          label="정리 보기"
          value={tab}
          onValueChange={(value: string): void => {
            if (value === 'history') {
              setTab('history');
              setUndoId(null);
              void model.historyPage();
            } else setTab('preview');
          }}
          items={[
            {
              id: 'preview',
              label: '미리보기',
              disabled: model.busy,
              content: previewContent,
            },
            {
              id: 'history',
              label: '변경 이력',
              disabled: model.busy,
              content: historyContent,
            },
          ]}
        />
        {canWrite &&
          ((tab === 'preview' &&
            model.preview &&
            model.preview.items.length > 0) ||
            (tab === 'history' && undoEvent)) && (
            <form
              className={styles.form}
              onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
                void form.handleSubmit(submit)(event);
              }}
            >
              <label>
                {tab === 'preview' ? '정리 이유' : '되돌림 이유'}
                <textarea
                  {...form.register('reason')}
                  disabled={blocked}
                  rows={2}
                  aria-invalid={!!form.formState.errors.reason}
                  aria-describedby={
                    form.formState.errors.reason
                      ? `${labelId}-reason-error`
                      : undefined
                  }
                />
              </label>
              {form.formState.errors.reason && (
                <p role="alert" id={`${labelId}-reason-error`}>
                  {form.formState.errors.reason.message}
                </p>
              )}
              <p className={styles.muted}>
                {tab === 'preview'
                  ? '선택한 항목을 현재 목록에서 정리합니다.'
                  : '선택한 정리의 항목을 되돌립니다.'}{' '}
                원문·인용·판단 이력은 유지됩니다.
              </p>
              <button
                type="submit"
                disabled={
                  blocked ||
                  (tab === 'preview' &&
                    (model.selected.length === 0 ||
                      !!model.preview?.requires_refresh))
                }
              >
                {tab === 'preview'
                  ? `선택 ${model.selected.length}개 정리 적용`
                  : `선택한 정리 ${undoEvent?.items.length || 0}개 되돌리기`}
              </button>
            </form>
          )}
        <Link
          to={`/document?path=${encodeURIComponent(model.document)}`}
          onClick={onClose}
        >
          문서와 원문 이력 확인 <Icon name="external-link" size={14} />
        </Link>
      </div>
    </WorkspacePage>
  );
}

import { Button } from '@renderer/shared/ui/Button';
import type { JSX } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import {
  formatTimestamp,
  formatTimestampWithZone,
} from '@renderer/shared/lib/formatTimestamp';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { DocumentContent } from '@contracts/documents.contract';
import type {
  HistoricalContent,
  HistoryPage,
} from '../api/documentContent.api';
import type { DocumentHistoryModel } from '../model/useDocumentHistory';
import { DocumentChipPopover } from './DocumentChipPopover';
import { DocumentComparison } from './DocumentComparison';
import chips from './DocumentChips.module.scss';
import styles from './ManageDocumentContent.module.scss';

export type VersionComparisonTarget = 'previous' | 'current';
type VersionItem = HistoryPage['items'][number];

/** 목록을 끝까지 읽었을 때만 오래된 순서로 버전 번호를 매기며, 일부만 읽었으면 번호를 추정하지 않습니다. */
function versionNumber(page: HistoryPage | null, id: string): number | null {
  if (!page || page.next_cursor) return null;
  const index = page.items.findIndex(
    (item: VersionItem): boolean => item.history_id === id,
  );
  return index < 0 ? null : page.items.length - index;
}

/** 서버가 기록한 작성자와 생성 경로만 표시하며 과거 미기록 값은 추정하지 않습니다. */
function historyAuthor(item: VersionItem): string {
  const author =
    typeof item.author === 'object' ? item.author?.display_name : null;
  const origin =
    item.origin?.kind === 'ai'
      ? 'AI 작성'
      : item.origin?.kind === 'human'
        ? '사람 수정'
        : null;
  return [origin, author].filter(Boolean).join(' · ');
}
/** 이력에 기록된 시각을 읽기 쉽게 표시하고 잘못된 시각은 미기록으로 남깁니다. */
function historyTime(value: string | null): string {
  if (!value) return '보관 시각 미기록';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '보관 시각 미기록'
    : formatTimestamp(value);
}

type DocumentVersionMenuProps = {
  model: DocumentHistoryModel;
  selectedId: string | null;
  onSelect: (historyId: string | null) => void;
};
/** 요약 줄의 버전 칩: 저장된 이력 수를 항상 보여 주고 누르면 버전을 고릅니다. */
export function DocumentVersionMenu({
  model,
  selectedId,
  onSelect,
}: DocumentVersionMenuProps): JSX.Element {
  const page = model.page;
  const count = page
    ? `${page.items.length + 1}${page.next_cursor ? '+' : ''}`
    : null;
  const selected = page?.items.find(
    (item: VersionItem): boolean => item.history_id === selectedId,
  );
  const label = !page
    ? model.error
      ? '버전 확인 불가'
      : '버전 확인 중'
    : `버전 ${count}개 ${selected ? historyTime(selected.archived_at) : '현재'}`;
  return (
    <DocumentChipPopover
      icon="clock"
      label={label}
      popoverLabel="버전 선택"
      active={selectedId !== null}
      accent
      disabled={!page || (page.items.length === 0 && !page.next_cursor)}
    >
      {(close: () => void): JSX.Element => (
        <>
          <ul className={chips.versionList}>
            <li>
              <button
                type="button"
                className={chips.versionChoice}
                aria-current={selectedId === null}
                onClick={(): void => {
                  onSelect(null);
                  close();
                }}
              >
                <b>현재 버전</b>
              </button>
            </li>
            {page?.items.map((item: VersionItem): JSX.Element => (
              <li key={item.history_id}>
                <button
                  type="button"
                  className={chips.versionChoice}
                  aria-current={selectedId === item.history_id}
                  title={
                    item.archived_at
                      ? formatTimestampWithZone(item.archived_at)
                      : undefined
                  }
                  onClick={(): void => {
                    onSelect(item.history_id);
                    close();
                  }}
                >
                  <b>
                    {versionNumber(page, item.history_id) !== null
                      ? `버전 ${versionNumber(page, item.history_id)}`
                      : historyTime(item.archived_at)}
                  </b>
                  {versionNumber(page, item.history_id) !== null && (
                    <small>{historyTime(item.archived_at)}</small>
                  )}
                  {historyAuthor(item) && <small>{historyAuthor(item)}</small>}
                  {item.reason && <small>{item.reason}</small>}
                </button>
              </li>
            ))}
          </ul>
          {page?.next_cursor && (
            <Button
              variant="surface"
              type="button"
              className={styles.button}
              disabled={model.busy || page.requires_refresh}
              onClick={(): void => {
                void model.load(page.next_cursor);
              }}
            >
              이전 버전 더 보기
            </Button>
          )}
          <p className={chips.popoverNote}>
            버전을 고르면 그 저장에서 바뀐 내용(바로 앞 버전과 비교)을 보여
            줍니다.
          </p>
        </>
      )}
    </DocumentChipPopover>
  );
}

type DocumentVersionViewProps = {
  current: DocumentContent;
  model: DocumentHistoryModel;
  selectedId: string;
  against: VersionComparisonTarget;
  onAgainst: (value: VersionComparisonTarget) => void;
  onClose: () => void;
  restoreDisabledReason: string | null;
  onRestore: (historical: HistoricalContent) => Promise<void>;
};
/** 본문 자리에서 선택한 버전의 변경을 보여 주며 복원은 기존 규칙을 따릅니다. */
export function DocumentVersionView({
  current,
  model,
  selectedId,
  against,
  onAgainst,
  onClose,
  restoreDisabledReason,
  onRestore,
}: DocumentVersionViewProps): JSX.Element {
  const selected =
    model.selected?.history_id === selectedId ? model.selected : null;
  const previous = selected ? model.previous : null;
  const canPrevious = previous !== null && previous.status !== 'unavailable';
  const selectedNumber = versionNumber(model.page, selectedId);
  const previousNumber =
    selectedNumber !== null && selectedNumber > 1 ? selectedNumber - 1 : null;
  const mode: VersionComparisonTarget =
    against === 'previous' && canPrevious ? 'previous' : 'current';
  return (
    <section aria-label="버전 변경 보기" aria-busy={model.busy}>
      <div className={chips.versionBar}>
        <div className={chips.versionHead}>
          <h3>
            {selected
              ? selectedNumber !== null
                ? `버전 ${selectedNumber}`
                : '선택한 버전'
              : '버전을 불러오는 중'}
          </h3>
          {selected && (
            <span>{historyTime(selected.archived_at)}에 저장됨</span>
          )}
        </div>
        <div className={chips.versionControls}>
          <div className={chips.segment} role="group" aria-label="비교 대상">
            <button
              type="button"
              className={chips.chip}
              data-active={mode === 'previous'}
              aria-pressed={mode === 'previous'}
              disabled={!selected || !canPrevious}
              onClick={(): void => onAgainst('previous')}
            >
              {previousNumber !== null
                ? `버전 ${previousNumber}과 비교`
                : '바로 앞 버전과 비교'}
            </button>
            <button
              type="button"
              className={chips.chip}
              data-active={mode === 'current'}
              aria-pressed={mode === 'current'}
              disabled={!selected}
              onClick={(): void => onAgainst('current')}
            >
              현재 본문과 비교
            </button>
          </div>
          <div className={chips.versionActions}>
            <Button
              variant="surface"
              type="button"
              className={styles.button}
              onClick={onClose}
            >
              <Icon name="arrow-left" />
              현재 본문으로 돌아가기
            </Button>
            <Button
              variant="primary"
              type="button"
              className={styles.primaryButton}
              disabled={
                !selected || model.busy || restoreDisabledReason !== null
              }
              title={restoreDisabledReason ?? undefined}
              onClick={(): void => {
                if (selected) void onRestore(selected);
              }}
            >
              이 버전으로 복원
            </Button>
          </div>
        </div>
      </div>
      {model.error && (
        <StatusNotice tone="error" title="버전을 불러오지 못했습니다">
          {model.error.message}
        </StatusNotice>
      )}
      {model.page && model.page.current.revision !== current.revision && (
        <StatusNotice tone="warning" title="현재 본문이 변경되었습니다">
          아래 비교는 화면에서 읽은 본문 기준입니다. 저장 전 최신 본문을 다시
          확인해 주세요.
        </StatusNotice>
      )}
      {!selected ? (
        !model.error && (
          <p role="status" aria-busy="true" className={styles.hint}>
            선택한 버전을 불러오고 있습니다.
          </p>
        )
      ) : (
        <>
          {previous?.status === 'none' && mode === 'previous' && (
            <p className={styles.hint}>
              가장 오래된 버전이라 비교할 앞 버전이 없습니다. 전체가 추가된
              내용으로 표시합니다.
            </p>
          )}
          {previous?.status === 'unavailable' && (
            <p className={styles.hint}>
              바로 앞 버전을 확인하지 못해 현재 본문과 비교합니다.
            </p>
          )}
          <DocumentComparison
            metadata={!!current.documentId}
            leftTitle={
              mode === 'previous'
                ? previousNumber !== null
                  ? `버전 ${previousNumber}`
                  : '바로 앞 버전'
                : selectedNumber !== null
                  ? `버전 ${selectedNumber}`
                  : '선택한 버전'
            }
            left={
              mode === 'previous'
                ? previous?.status === 'content'
                  ? previous.content
                  : ''
                : selected.content
            }
            rightTitle={
              mode === 'previous'
                ? selectedNumber !== null
                  ? `버전 ${selectedNumber}`
                  : '선택한 버전'
                : '현재 본문'
            }
            right={mode === 'previous' ? selected.content : current.content}
          />
          <p className={styles.hint}>
            복원하면 선택한 버전이 새 저장이 되고 지금 본문은 버전으로 남습니다.
            제목·태그·원본 연결은 당시 정보로 돌아갑니다. 과거 관계와 검토
            승인은 복원하지 않습니다.
          </p>
        </>
      )}
    </section>
  );
}

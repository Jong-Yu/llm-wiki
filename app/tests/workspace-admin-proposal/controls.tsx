import { useEffect, useId, useState } from 'react';
import type {
  ChangeEvent,
  JSX,
  KeyboardEvent,
  ReactNode,
  SubmitEvent,
} from 'react';
import { UserRoundPlus } from 'lucide-react';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import listStyles from '@renderer/features/manage-templates/ui/TemplateWorkspace.module.scss';
import styles from './Proposal.module.scss';
import type { Entity, SearchState } from './model';

type IconActionProps = {
  label: string;
  icon: IconName | 'user-plus';
  onClick: () => void;
  disabled?: boolean;
};
/** 공통 아이콘 조작의 투명 배경과 키보드 focus·Escape 도움말을 유지합니다. */
export function IconAction({
  label,
  icon,
  onClick,
  disabled,
}: IconActionProps): JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className={styles.iconWrap}
      onMouseEnter={(): void => setOpen(true)}
      onMouseLeave={(): void => setOpen(false)}
    >
      <Button
        variant="surface"
        size="small"
        className={styles.iconOnly}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        disabled={disabled}
        onFocus={(): void => setOpen(true)}
        onBlur={(): void => setOpen(false)}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>): void => {
          if (event.key === 'Escape') {
            setOpen(false);
            event.preventDefault();
          }
        }}
        onClick={(): void => {
          setOpen(false);
          onClick();
        }}
      >
        {icon === 'user-plus' ? (
          <UserRoundPlus size={16} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Icon name={icon} />
        )}
      </Button>
      {open && !disabled && (
        <span role="tooltip" id={id} className={styles.tooltip}>
          {label}
        </span>
      )}
    </span>
  );
}
export function Chip({
  children,
  onRemove,
  label,
}: {
  children: ReactNode;
  onRemove?: () => void;
  label?: string;
}): JSX.Element {
  return (
    <span
      className={styles.chip}
      data-count={
        typeof children === 'string' && /^\+\d+$/.test(children)
          ? true
          : undefined
      }
    >
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label={label ?? '선택 해제'}
          onClick={onRemove}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}
type EntityBrowserProps = {
  label: string;
  items: Entity[];
  state: SearchState;
  onState: (state: SearchState) => void;
  onOpen?: (id: string) => void;
  selected?: string[];
  onSelect?: (ids: string[]) => void;
  onEdit?: (id: string) => void;
  actions?: (item: Entity) => ReactNode;
  emptyLabel?: string;
  columns?: [string, string, string];
  singleLineChips?: boolean;
};
/** 결과를 20개씩만 표시하고 지연된 이전 검색은 폐기합니다. */
export function EntityBrowser({
  label,
  items,
  state,
  onState,
  onOpen,
  selected,
  onSelect,
  onEdit,
  actions,
  emptyLabel,
  columns,
  singleLineChips = false,
}: EntityBrowserProps): JSX.Element {
  const [results, setResults] = useState<{
    items: Entity[];
    total: number;
    source: Entity[] | null;
    query: string;
    page: number;
  }>({ items: [], total: 0, source: null, query: '', page: -1 });
  const loading =
    results.source !== items ||
    results.query !== state.query ||
    results.page !== state.page;
  useEffect((): (() => void) => {
    const timer = window.setTimeout((): void => {
      const q = state.query.trim().toLocaleLowerCase();
      const matches = items.filter(
        (item): boolean =>
          !q ||
          `${item.name} ${item.id} ${item.secondary}`
            .toLocaleLowerCase()
            .includes(q),
      );
      const visible = matches.slice(state.page * 20, (state.page + 1) * 20);
      setResults({
        items: visible,
        total: matches.length,
        source: items,
        query: state.query,
        page: state.page,
      });
    }, 100);
    return (): void => window.clearTimeout(timer);
  }, [items, state.query, state.page]);
  useEffect((): void => {
    if (!loading && state.focusId) {
      document
        .getElementById(`${label}-${state.focusId}`)
        ?.focus({ preventScroll: true });
    }
  }, [loading, state.focusId, label]);
  function toggle(id: string): void {
    if (!onSelect) return;
    onSelect(
      selected?.includes(id)
        ? selected.filter((v: string): boolean => v !== id)
        : [...(selected ?? []), id],
    );
  }
  return (
    <section
      className={`${styles.browser} ${singleLineChips ? styles.singleLineChips : ''}`}
      aria-label={label}
    >
      <div className={listStyles.finder}>
        <div className={listStyles.toolbar}>
          <form
            className={listStyles.search}
            role="search"
            onSubmit={(event: SubmitEvent<HTMLFormElement>): void =>
              event.preventDefault()
            }
          >
            <label className={listStyles.searchInput}>
              <Icon name="search" />
              <input
                aria-label={`${label} 검색`}
                placeholder="이름으로 검색"
                maxLength={200}
                value={state.query}
                onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                  onState({ query: event.target.value, page: 0 })
                }
              />
            </label>
          </form>
          {state.query && (
            <IconAction
              label="검색어 지우기"
              icon="x"
              onClick={(): void => onState({ query: '', page: 0 })}
            />
          )}
        </div>
      </div>
      {selected && selected.length > 0 && (
        <div className={styles.chips} aria-label="선택한 항목">
          {selected.map((id: string): JSX.Element => {
            const entity = items.find((item): boolean => item.id === id);
            return (
              <Chip
                key={id}
                label={`${entity?.name ?? id} 선택 해제`}
                onRemove={(): void => toggle(id)}
              >
                {entity?.name ?? id}
                {entity?.secondary ? ` · ${entity.secondary}` : ''}
              </Chip>
            );
          })}
        </div>
      )}
      {columns && (
        <div className={styles.listColumns} aria-hidden="true">
          <span>{columns[0]}</span>
          <span>{columns[1]}</span>
          <span>{columns[2]}</span>
          <span>작업</span>
        </div>
      )}
      {loading ? (
        <div role="status" className={styles.loading}>
          검색 중…
        </div>
      ) : results.items.length === 0 ? (
        <div className={styles.empty}>
          <Icon name="search" size={24} />
          <h2>
            {state.query
              ? '검색 결과가 없습니다'
              : (emptyLabel ?? '검색 결과가 없습니다')}
          </h2>
          {state.query && <span>검색어를 바꿔 주세요.</span>}
          {state.query && (
            <Button
              variant="surface"
              onClick={(): void => onState({ query: '', page: 0 })}
            >
              검색 초기화
            </Button>
          )}
        </div>
      ) : (
        <ul
          className={`${listStyles.list} ${styles.entityList} ${columns ? styles.columnList : ''}`}
          aria-label={`${label} 결과`}
        >
          {results.items.map((item: Entity): JSX.Element => (
            <li key={item.id}>
              <div className={styles.identity}>
                {onSelect ? (
                  <label className={styles.pick}>
                    <input
                      type="checkbox"
                      aria-label={`${item.name} · ${item.secondary}`}
                      checked={selected?.includes(item.id) ?? false}
                      onChange={(): void => toggle(item.id)}
                    />
                    <span className={styles.entityIcon}>
                      {item.kind === 'person' ? (
                        item.name.slice(0, 1)
                      ) : (
                        <Icon name="folder-open" />
                      )}
                    </span>
                  </label>
                ) : (
                  <span className={styles.entityIcon}>
                    {item.kind === 'person' ? (
                      item.name.slice(0, 1)
                    ) : (
                      <Icon name="folder-open" />
                    )}
                  </span>
                )}
                <div>
                  <h3>
                    {onOpen ? (
                      <button
                        id={`${label}-${item.id}`}
                        className={`${listStyles.title} ${styles.entityName}`}
                        onClick={(): void => onOpen(item.id)}
                      >
                        {item.name}
                      </button>
                    ) : (
                      <span>{item.name}</span>
                    )}
                  </h3>
                  {item.secondary && (
                    <span className={styles.note}>{item.secondary}</span>
                  )}
                </div>
              </div>
              <div className={styles.chips}>
                {item.chips.map((chip: string, index: number): JSX.Element => (
                  <Chip key={`${chip}-${index}`}>{chip}</Chip>
                ))}
              </div>
              {columns && <span className={styles.rowMeta}>{item.meta}</span>}
              {actions ? (
                <div className={styles.rowActions}>{actions(item)}</div>
              ) : onEdit ? (
                <IconAction
                  label={`${item.name} 권한 편집`}
                  icon="pencil"
                  onClick={(): void => onEdit(item.id)}
                />
              ) : (
                onOpen && (
                  <IconAction
                    label={`${item.name} 열기`}
                    icon="chevron-right"
                    onClick={(): void => onOpen(item.id)}
                  />
                )
              )}
            </li>
          ))}
        </ul>
      )}
      <nav className={listStyles.pagination} aria-label={`${label} 페이지`}>
        <span className={styles.note} aria-live="polite">
          {loading
            ? '조회 중'
            : results.total === 0
              ? '0개'
              : `${state.page * 20 + 1}–${Math.min((state.page + 1) * 20, results.total)} / ${results.total}`}
        </span>
        <IconAction
          label="이전 페이지"
          icon="chevron-left"
          disabled={state.page === 0 || loading}
          onClick={(): void =>
            onState({ ...state, page: state.page - 1, focusId: undefined })
          }
        />
        <IconAction
          label="다음 페이지"
          icon="chevron-right"
          disabled={(state.page + 1) * 20 >= results.total || loading}
          onClick={(): void =>
            onState({ ...state, page: state.page + 1, focusId: undefined })
          }
        />
      </nav>
    </section>
  );
}

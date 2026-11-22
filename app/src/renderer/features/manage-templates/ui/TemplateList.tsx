import { useState } from 'react';
import type { ChangeEvent, JSX, SubmitEvent } from 'react';
import type { TemplateSummary } from '@contracts/templates.contract';
import { templateFileType } from '@renderer/domains/templates';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './TemplateWorkspace.module.scss';

type TemplateListProps = {
  items: TemplateSummary[];
  onOpen: (id: string) => void;
  onRegister?: () => void;
};
const PAGE_SIZE = 20;

/** 승인된 세션 행 배치로 이름과 파일명을 각각 한 번 표시합니다. */
export function TemplateList({
  items,
  onOpen,
  onRegister,
}: TemplateListProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [format, setFormat] = useState('all');
  const [page, setPage] = useState(0);
  const keyword = search.trim().toLocaleLowerCase();
  const formats = [
    ...new Set(
      items.map((item: TemplateSummary): string =>
        templateFileType(item.filename),
      ),
    ),
  ].sort();
  const matches = items.filter(
    (item: TemplateSummary): boolean =>
      (format === 'all' || templateFileType(item.filename) === format) &&
      (!keyword ||
        `${item.name}\n${item.filename}`.toLocaleLowerCase().includes(keyword)),
  );
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1),
  );
  const visible = matches.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  if (items.length === 0)
    return (
      <div className={styles.state}>
        <Icon name="file-text" size={24} />
        <h2>첫 템플릿을 등록해 보세요</h2>
        <p>양식 파일과 지침을 함께 저장하세요.</p>
        {onRegister && <Button onClick={onRegister}>템플릿 등록</Button>}
      </div>
    );
  return (
    <>
      <section className={styles.finder} aria-label="템플릿 찾기">
        <div className={styles.toolbar}>
          <form
            className={styles.search}
            role="search"
            onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
              event.preventDefault();
              setSearch(query);
              setPage(0);
            }}
          >
            <label className={styles.searchInput}>
              <Icon name="search" />
              <input
                aria-label="템플릿 검색"
                placeholder="템플릿 이름이나 파일명으로 검색 (Enter)"
                maxLength={200}
                value={query}
                onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                  setQuery(event.target.value)
                }
              />
            </label>
          </form>
          <select
            className={styles.filter}
            aria-label="템플릿 형식 필터"
            value={format}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
              setFormat(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">전체 템플릿</option>
            {formats.map((value: string): JSX.Element => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </section>
      {visible.length > 0 ? (
        <ul className={styles.list} aria-label="템플릿 목록">
          {visible.map((item: TemplateSummary): JSX.Element => (
            <li key={item.id}>
              <div>
                <h3>
                  <span className={styles.kind}>
                    {templateFileType(item.filename)}
                  </span>
                  <button
                    type="button"
                    className={styles.title}
                    title={item.name}
                    onClick={(): void => onOpen(item.id)}
                  >
                    {item.name}
                  </button>
                </h3>
              </div>
              <span className={styles.fileName}>{item.filename}</span>
              <button
                className={styles.textButton}
                type="button"
                aria-label={`${item.name} 열기`}
                onClick={(): void => onOpen(item.id)}
              >
                열기 <Icon name="arrow-right" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.state}>
          <Icon name="search" size={24} />
          <h2>검색 결과가 없습니다</h2>
          <p>검색어나 형식 필터를 바꿔 주세요.</p>
          <Button
            variant="surface"
            onClick={(): void => {
              setQuery('');
              setSearch('');
              setFormat('all');
              setPage(0);
            }}
          >
            검색 조건 초기화
          </Button>
        </div>
      )}
      <nav className={styles.pagination} aria-label="템플릿 페이지">
        <Button
          variant="surface"
          aria-label="이전 페이지"
          disabled={current === 0}
          onClick={(): void => setPage(current - 1)}
        >
          <Icon name="chevron-left" />
        </Button>
        <b aria-current="page">{current + 1}</b>
        <Button
          variant="surface"
          aria-label="다음 페이지"
          disabled={(current + 1) * PAGE_SIZE >= matches.length}
          onClick={(): void => setPage(current + 1)}
        >
          <Icon name="chevron-right" />
        </Button>
      </nav>
    </>
  );
}

import { useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent, MouseEvent } from 'react';
import styles from './ConceptPicker.module.scss';

export type ConceptOption = { id: string; label: string };

type ConceptPickerProps = {
  name: string;
  value: string;
  options: ConceptOption[];
  /** 같은 이름이 여러 문서에 있을 수 있어 항목 아래에 보조 문구로 보입니다. */
  documentName: string;
  invalid: boolean;
  describedBy?: string;
  onChange: (id: string) => void;
};

const MAX_VISIBLE = 20;

/** 이름 앞부분 일치를 먼저, 부분 일치를 그다음에 두어 입력어로 개념을 거릅니다. */
export function filterConcepts(
  options: ConceptOption[],
  query: string,
): ConceptOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return options;
  const starts: ConceptOption[] = [];
  const contains: ConceptOption[] = [];
  for (const option of options) {
    const index = option.label.toLowerCase().indexOf(needle);
    if (index === 0) starts.push(option);
    else if (index > 0) contains.push(option);
  }
  return [...starts, ...contains];
}

/** 이름으로 검색해 개념 하나를 고르는 combobox이며 선택 값은 개념 ID입니다. */
export function ConceptPicker({
  name,
  value,
  options,
  documentName,
  invalid,
  describedBy,
  onChange,
}: ConceptPickerProps): JSX.Element {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const selected = options.find(
    (option: ConceptOption): boolean => option.id === value,
  );
  // 필터는 입력이 바뀔 때만 다시 계산합니다.
  const matches = useMemo(
    (): ConceptOption[] => filterConcepts(options, query),
    [options, query],
  );
  const visible = matches.slice(0, MAX_VISIBLE);
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0));
  const optionId = (id: string): string => `${baseId}-opt-${id}`;

  function close(): void {
    setOpen(false);
    setQuery('');
    setActive(0);
  }
  function choose(id: string): void {
    onChange(id);
    close();
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const count = visible.length;
      if (count > 0) setActive((activeIndex + step + count) % count);
    } else if (event.key === 'Enter' && open) {
      // 목록이 열려 있을 때의 Enter는 양식 제출이 아니라 선택입니다.
      event.preventDefault();
      const target = visible[activeIndex];
      if (target) choose(target.id);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }
  const activeOption = open ? visible[activeIndex] : undefined;
  return (
    <div className={styles.field}>
      <label className={styles.name} htmlFor={`${baseId}-input`}>
        {{ subject: '주체', object: '대상' }[name] ?? name}
      </label>
      <input
        ref={inputRef}
        id={`${baseId}-input`}
        role="combobox"
        type="text"
        autoComplete="off"
        placeholder="개념 이름으로 검색"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOption && optionId(activeOption.id)}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        value={open ? query : (selected?.label ?? '')}
        onFocus={(): void => setOpen(true)}
        onBlur={close}
        onKeyDown={onKeyDown}
        onChange={(event: ChangeEvent<HTMLInputElement>): void => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className={styles.list}>
          {visible.map((option: ConceptOption, index: number): JSX.Element => (
            <li
              key={option.id}
              id={optionId(option.id)}
              role="option"
              aria-selected={index === activeIndex}
              className={styles.option}
              // 입력의 blur보다 먼저 선택되도록 기본 포커스 이동을 막습니다.
              onMouseDown={(event: MouseEvent<HTMLLIElement>): void => {
                event.preventDefault();
                choose(option.id);
              }}
              onMouseEnter={(): void => setActive(index)}
            >
              <span>{option.label}</span>
              <small>{documentName}</small>
            </li>
          ))}
          {visible.length === 0 && (
            <li role="presentation" className={styles.hint}>
              이 문서에서 같은 이름의 개념을 찾지 못했습니다. 다른 이름으로
              검색해 보세요.
            </li>
          )}
          {matches.length > visible.length && (
            <li role="presentation" className={styles.hint}>
              더 입력해 좁혀 주세요
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

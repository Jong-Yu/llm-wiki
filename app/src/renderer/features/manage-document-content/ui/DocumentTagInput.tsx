import { useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import chips from './DocumentChips.module.scss';

type DocumentTagInputProps = {
  id: string;
  value: string[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (tags: string[]) => void;
};

/** 쉼표로 구분한 태그 문자열을 칩 목록으로 바꿉니다. */
export function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((item: string): string => item.trim())
    .filter(Boolean);
}

/** Enter·쉼표로 태그 칩을 추가하고 ×나 빈 입력의 Backspace로 지웁니다. */
export function DocumentTagInput({
  id,
  value,
  disabled = false,
  invalid = false,
  describedBy,
  onChange,
}: DocumentTagInputProps): JSX.Element {
  const [text, setText] = useState('');
  /** 입력 중인 글자를 중복 없이 태그로 확정합니다. */
  function commit(raw: string): void {
    const additions = parseTags(raw).filter(
      (tag: string): boolean => !value.includes(tag),
    );
    setText('');
    if (additions.length > 0) onChange([...new Set([...value, ...additions])]);
  }
  function change(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.currentTarget.value;
    if (next.includes(',')) commit(next);
    else setText(next);
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      // 태그 확정 Enter가 상위 폼 제출로 번지지 않게 합니다.
      event.preventDefault();
      commit(text);
    } else if (event.key === 'Backspace' && text === '' && value.length > 0)
      onChange(value.slice(0, -1));
  }
  return (
    <div className={chips.tagInput}>
      {value.map((tag: string): JSX.Element => (
        <span className={chips.tag} key={tag}>
          {tag}
          <button
            type="button"
            disabled={disabled}
            aria-label={`태그 ${tag} 삭제`}
            onClick={(): void =>
              onChange(value.filter((item: string): boolean => item !== tag))
            }
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder="태그 입력 후 Enter 또는 쉼표"
        onChange={change}
        onKeyDown={keyDown}
        onBlur={(): void => commit(text)}
      />
    </div>
  );
}

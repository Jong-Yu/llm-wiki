import { useId, useRef, useState } from 'react';
import type { FocusEvent, JSX, KeyboardEvent, ReactNode } from 'react';
import styles from './Tabs.module.scss';

export type TabItem = {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
};

export type TabsProps = {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  items: readonly TabItem[];
  className?: string;
  activationMode?: 'manual' | 'automatic';
};

/** 선택은 호출자가 소유하며 숨긴 패널도 유지해 입력·초안의 수명을 보존합니다. */
export function Tabs({
  label,
  value,
  onValueChange,
  items,
  className,
  activationMode = 'manual',
}: TabsProps): JSX.Element {
  const groupId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [focused, setFocused] = useState({ selection: value, id: value });
  if (focused.selection !== value) setFocused({ selection: value, id: value });
  const enabled = items.filter((item: TabItem): boolean => !item.disabled);
  const focusId = enabled.some(
    (item: TabItem): boolean => item.id === focused.id,
  )
    ? focused.id
    : enabled[0]?.id;
  const tabId = (id: string): string =>
    `${groupId}-tab-${encodeURIComponent(id)}`;
  const panelId = (id: string): string =>
    `${groupId}-panel-${encodeURIComponent(id)}`;

  /** 방향키는 초점만 이동하며 지연 조회 탭은 Enter/Space로 명시 선택합니다. */
  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ): void => {
    const index = enabled.findIndex((item: TabItem): boolean => item.id === id);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % enabled.length;
        break;
      case 'ArrowLeft':
        nextIndex = (index - 1 + enabled.length) % enabled.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = enabled.length - 1;
        break;
      default:
        return;
    }
    const next = enabled[nextIndex];
    if (!next) return;
    event.preventDefault();
    if (activationMode === 'automatic' && next.id !== value)
      onValueChange(next.id);
    buttons.current.get(next.id)?.focus();
  };

  return (
    <div className={[styles.tabs, className].filter(Boolean).join(' ')}>
      <div
        className={styles.tabList}
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onBlur={(event: FocusEvent<HTMLDivElement>): void => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setFocused({ selection: value, id: value });
        }}
      >
        {items.map((item: TabItem): JSX.Element => (
          <button
            key={item.id}
            ref={(button: HTMLButtonElement | null): void => {
              if (button) buttons.current.set(item.id, button);
              else buttons.current.delete(item.id);
            }}
            id={tabId(item.id)}
            className={styles.tab}
            type="button"
            role="tab"
            aria-selected={item.id === value}
            aria-controls={panelId(item.id)}
            disabled={item.disabled}
            tabIndex={item.id === focusId ? 0 : -1}
            onFocus={(): void => setFocused({ selection: value, id: item.id })}
            onClick={(): void => {
              if (item.id !== value) onValueChange(item.id);
            }}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>): void =>
              handleKeyDown(event, item.id)
            }
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item: TabItem): JSX.Element => (
        <div
          key={item.id}
          id={panelId(item.id)}
          className={styles.panel}
          role="tabpanel"
          aria-labelledby={tabId(item.id)}
          hidden={item.id !== value}
          tabIndex={0}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}

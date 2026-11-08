import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX, KeyboardEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Icon } from '@renderer/shared/ui/Icon';
import { chatWebSearchFormSchema } from '../model/chatState';
import type { ChatWebSearchForm } from '../model/chatState';
import styles from './ComposerWebSearch.module.scss';

type ComposerWebSearchProps = {
  enabled: boolean;
  query: string;
  disabled: boolean;
  onEnabledChange: (value: boolean) => void;
  onQueryChange: (value: string) => void;
};

/** 공개 검색어 설정·검증·초점 복귀를 소유하며 질문이나 웹 조사를 실행하지 않습니다. */
export function ComposerWebSearch({
  enabled,
  query,
  disabled,
  onEnabledChange,
  onQueryChange,
}: ComposerWebSearchProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChatWebSearchForm>({
    resolver: zodResolver(chatWebSearchFormSchema),
    defaultValues: { webQuery: query },
    mode: 'onBlur',
  });
  if (disabled && open) setOpen(false);

  useLayoutEffect((): void => {
    if (open) panel.current?.querySelector('input')?.focus();
  }, [open]);

  useEffect((): (() => void) | undefined => {
    if (!open) return;
    const dismissOutside = (event: Event): void => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return (): void => {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
    };
  }, [open]);

  /** 입력한 검색어를 남겨 두고 시작 버튼으로 초점을 돌립니다. */
  function close(): void {
    setOpen(false);
    trigger.current?.focus();
  }

  /** 검증한 검색어를 이번 질문에만 적용합니다. */
  function apply(): void {
    void handleSubmit((values: ChatWebSearchForm): void => {
      onQueryChange(values.webQuery);
      onEnabledChange(true);
      close();
    })();
  }

  /** 현재 대화의 검색어로 열어 다른 대화의 폼 상태를 가져오지 않습니다. */
  function toggle(): void {
    if (open) close();
    else {
      reset({ webQuery: query });
      setOpen(true);
    }
  }

  /** IME 조합을 유지하고 Escape와 검색어 입력란의 Enter만 처리합니다. */
  function handleKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (
      event.key === 'Enter' &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault();
      event.stopPropagation();
      apply();
    }
  }

  return (
    <div className={styles.webAnchor} ref={anchor}>
      <button
        ref={trigger}
        className={styles.webButton}
        type="button"
        aria-label="웹 검색"
        aria-pressed={enabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        title={enabled ? `웹 검색: ${query}` : '웹 검색'}
        disabled={disabled}
        onClick={toggle}
      >
        <Icon name="globe" size={16} />
        {enabled && <span>웹</span>}
      </button>
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label="웹 검색 설정"
          className={styles.webPanel}
          onKeyDown={handleKey}
        >
          <div className={styles.webPanelHeader}>
            <strong>웹 검색</strong>
            <span>이번 질문에만</span>
          </div>
          <label htmlFor={`${panelId}-query`}>외부 검색어</label>
          <input
            {...register('webQuery', {
              onChange: (event: ChangeEvent<HTMLInputElement>): void =>
                onQueryChange(event.currentTarget.value),
            })}
            id={`${panelId}-query`}
            maxLength={200}
            aria-describedby={`${panelId}-hint${errors.webQuery ? ` ${panelId}-error` : ''}`}
            aria-invalid={Boolean(errors.webQuery)}
            placeholder="외부에서 찾아볼 공개 검색어"
          />
          <p id={`${panelId}-hint`}>이 검색어만 외부로 보내요.</p>
          {errors.webQuery && (
            <p id={`${panelId}-error`} role="alert">
              {errors.webQuery.message}
            </p>
          )}
          <div className={styles.webPanelActions}>
            {enabled && (
              <button
                type="button"
                onClick={(): void => {
                  onEnabledChange(false);
                  close();
                }}
              >
                사용 안 함
              </button>
            )}
            <button type="button" className={styles.webApply} onClick={apply}>
              적용
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

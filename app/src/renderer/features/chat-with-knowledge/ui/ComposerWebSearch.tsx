import type { JSX } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './ComposerWebSearch.module.scss';

type ComposerWebSearchProps = {
  enabled: boolean;
  disabled: boolean;
  onEnabledChange: (value: boolean) => void;
};

/** 현재 대화에서 질문을 바탕으로 웹을 검색할지 바로 켜고 끕니다. 실행은 전송 때만 시작합니다. */
export function ComposerWebSearch({
  enabled,
  disabled,
  onEnabledChange,
}: ComposerWebSearchProps): JSX.Element {
  return (
    <button
      className={styles.webButton}
      type="button"
      aria-label="웹 검색"
      aria-pressed={enabled}
      title={
        enabled ? '웹 검색 켜짐 · 질문을 바탕으로 검색합니다' : '웹 검색 켜기'
      }
      disabled={disabled}
      onClick={(): void => onEnabledChange(!enabled)}
    >
      <Icon name="globe" size={16} />
      {enabled && <span>웹</span>}
    </button>
  );
}

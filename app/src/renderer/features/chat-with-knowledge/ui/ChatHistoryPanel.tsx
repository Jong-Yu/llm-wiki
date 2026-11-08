import type { Ref, JSX } from 'react';
import type { ChatThread } from '../model/chatState';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './KnowledgeChat.module.scss';

type ChatHistoryPanelProps = {
  panelRef: Ref<HTMLElement>;
  visible: boolean;
  narrow: boolean;
  disabled: boolean;
  threads: ChatThread[];
  selected: string | null;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
};
/** 기기에 저장된 대화 목록과 새 대화 동작을 표시합니다. */
export function ChatHistoryPanel({
  panelRef,
  visible,
  narrow,
  disabled,
  threads,
  selected,
  onClose,
  onNew,
  onSelect,
}: ChatHistoryPanelProps): JSX.Element {
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      hidden={!visible}
      className={styles.historyPanel}
      aria-label="대화 목록"
      id="chat-history"
    >
      <header className={styles.panelHeader}>
        <h2 aria-label="이 기기의 대화">대화</h2>
        <div className={styles.historyHeaderActions}>
          <button
            className={`${styles.ghost} ${styles.iconButton}`}
            type="button"
            aria-label="새 대화"
            title="새 대화"
            disabled={disabled}
            onClick={onNew}
          >
            <Icon name="pencil" size={15} />
          </button>
          <button
            className={`${styles.ghost} ${narrow ? '' : styles.iconButton}`}
            type="button"
            aria-label={narrow ? '대화로 돌아가기' : '대화 목록 닫기'}
            title={narrow ? '대화로 돌아가기' : '대화 목록 닫기'}
            onClick={onClose}
          >
            <Icon name={narrow ? 'arrow-left' : 'panel-left'} />
            {narrow && '대화로'}
          </button>
        </div>
      </header>
      {threads.length === 0 && (
        <div className={styles.historyEmpty}>
          <Icon name="message-square" size={20} />
          <strong>대화가 없습니다</strong>
          <small>질문을 보내면 여기에 쌓입니다.</small>
        </div>
      )}
      <div className={styles.history}>
        {threads.map((item: ChatThread): JSX.Element => {
          const hasDraft = Boolean(item.draft.trim());
          return (
            <button
              type="button"
              className={styles.historyItem}
              key={item.id}
              title={item.title}
              aria-pressed={item.id === selected}
              disabled={disabled}
              onClick={(): void => onSelect(item.id)}
            >
              <Icon name={hasDraft ? 'pencil' : 'message-square'} size={14} />
              <span className={styles.historyTitle}>{item.title}</span>
              {hasDraft && (
                <small className={styles.historyDraft}>작성 중</small>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

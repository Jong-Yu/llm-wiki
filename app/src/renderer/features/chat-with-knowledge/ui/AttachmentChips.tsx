import { useId, useState } from 'react';
import type { JSX } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import { lineCount } from '../model/attachments';
import type { ChatAttachment } from '../model/attachments';
import styles from './AttachmentChips.module.scss';

type AttachmentChipsProps = {
  items: readonly ChatAttachment[];
  /** 주어지면 칩마다 지우기(×)를 보입니다. 보낸 질문에서는 주지 않습니다. */
  onRemove?: (id: string) => void;
  removeDisabled?: boolean;
  /** 칩을 눌러 내용을 펼쳐 볼 수 있게 합니다. */
  expandable?: boolean;
  className?: string;
};

/** 칩 앞의 형식 배지입니다. 붙여넣은 글은 TXT, 파일은 확장자(없으면 FILE)입니다. */
function chipBadge(item: ChatAttachment): string {
  if (item.kind === 'text') return 'TXT';
  const dot = item.name.lastIndexOf('.');
  const extension = dot >= 0 ? item.name.slice(dot + 1) : '';
  return /^[A-Za-z0-9]{1,5}$/.test(extension)
    ? extension.toUpperCase()
    : 'FILE';
}

/** "붙여넣은 텍스트 #1 +24줄", "3,200자 읽음", "앞 12,000자만 읽음"처럼 얼마나 담았는지 알립니다. */
function chipDetail(item: ChatAttachment): string {
  if (item.kind === 'text')
    return item.truncated
      ? `앞 ${item.text.length.toLocaleString()}자만`
      : `+${Math.max(0, lineCount(item.text) - 1)}줄`;
  const size = item.text.length.toLocaleString();
  return item.truncated ? `앞 ${size}자만 읽음` : `${size}자 읽음`;
}

/** 칩 앞 배지의 색 구분(표 파일은 초록, 나머지는 파랑)입니다. */
function badgeClass(item: ChatAttachment): string {
  return /^(XLSX|XLS|CSV)$/.test(chipBadge(item))
    ? styles.badgeSheet
    : styles.badge;
}

/** 작성 중인 자료는 개별 삭제하고, 보낸 질문의 자료는 눌러 원문을 확인합니다. */
export function AttachmentChips({
  items,
  onRemove,
  removeDisabled,
  expandable,
  className,
}: AttachmentChipsProps): JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null);
  const previewId = useId();
  if (items.length === 0) return null;
  const opened = items.find(
    (item: ChatAttachment): boolean => item.id === open,
  );
  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      <ul className={styles.chips}>
        {items.map((item: ChatAttachment): JSX.Element => {
          const label = (
            <>
              <b className={badgeClass(item)}>{chipBadge(item)}</b>
              <span title={item.name}>{item.name}</span>
              <small>{chipDetail(item)}</small>
            </>
          );
          return (
            <li
              key={item.id}
              className={`${styles.chip} ${item.truncated ? styles.partial : ''}`}
            >
              {expandable ? (
                <button
                  type="button"
                  className={styles.body}
                  aria-expanded={open === item.id}
                  aria-controls={open === item.id ? previewId : undefined}
                  onClick={(): void =>
                    setOpen(open === item.id ? null : item.id)
                  }
                >
                  {label}
                </button>
              ) : (
                <span className={styles.body}>{label}</span>
              )}
              {onRemove && (
                <button
                  type="button"
                  className={styles.remove}
                  disabled={removeDisabled}
                  aria-label={`${item.name} 지우기`}
                  onClick={(): void => onRemove(item.id)}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {opened && (
        <pre id={previewId} className={styles.preview}>
          {opened.text}
        </pre>
      )}
    </div>
  );
}

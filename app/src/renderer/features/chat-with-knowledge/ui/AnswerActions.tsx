import { useState, useEffect, useRef } from 'react';
import type { ExportFormat } from '@contracts/fileExports.contract';
import {
  EXPORT_FORMAT_NAMES,
  availableExportFormats,
} from '@renderer/platform/fileExports';
import { Icon } from '@renderer/shared/ui/Icon';
import type { JSX } from 'react';
import styles from './KnowledgeChat.module.scss';

type AnswerActionsProps = {
  body: string;
  fileFormat: ExportFormat | null;
  recommended: ExportFormat;
  failed: boolean;
  downloading: boolean;
  canAsk: boolean;
  onAsk: () => void;
  onDownload: (format: ExportFormat) => void;
  onCopyError: () => void;
};
/** 각 답변의 복사와 내려받기 메뉴는 해당 답변의 수명 안에서만 열립니다. */
export function AnswerActions({
  body,
  fileFormat,
  recommended,
  failed,
  downloading,
  canAsk,
  onAsk,
  onDownload,
  onCopyError,
}: AnswerActionsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const supported = availableExportFormats();
  const formats = supported.includes(recommended)
    ? [
        recommended,
        ...supported.filter(
          (item: ExportFormat): boolean => item !== recommended,
        ),
      ]
    : supported;
  useEffect((): (() => void) | undefined => {
    if (!open) return;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') {
          setOpen(false);
          menu.current?.querySelector('button')?.focus();
        }
      } else if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return (): void => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  useEffect((): (() => void) | undefined => {
    if (!copied) return;
    const timer = window.setTimeout((): void => setCopied(false), 1600);
    return (): void => window.clearTimeout(timer);
  }, [copied]);
  async function copyAnswer(): Promise<void> {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
    } catch {
      onCopyError();
    }
  }
  return (
    <div className={styles.answerActions}>
      <button
        type="button"
        className={styles.action}
        disabled={!body.trim()}
        onClick={(): void => {
          void copyAnswer();
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={14} />{' '}
        {copied ? '복사됨' : '복사'}
      </button>
      <button
        type="button"
        className={styles.action}
        disabled={!canAsk}
        onClick={(): void => onAsk()}
      >
        <Icon name="rotate-ccw" size={14} /> 다시 묻기
      </button>
      <div className={styles.downloadMenu} ref={menu}>
        <button
          type="button"
          className={`${styles.action} ${styles.actionBox}`}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={downloading || failed || !body.trim()}
          onClick={(): void => setOpen(!open)}
        >
          <Icon name="download" size={14} />{' '}
          {downloading
            ? '내려받는 중…'
            : fileFormat
              ? '다른 형식으로'
              : '내려받기'}
          <Icon name="chevron-down" size={14} />
        </button>
        {open && (
          <div
            className={styles.formatMenu}
            role="menu"
            aria-label="내려받을 형식"
          >
            {formats.map((format: ExportFormat): JSX.Element => (
              <button
                key={format}
                type="button"
                role="menuitem"
                className={styles.formatItem}
                onClick={(): void => {
                  setOpen(false);

                  onDownload(format);
                }}
              >
                {EXPORT_FORMAT_NAMES[format]}
                {format === recommended && !fileFormat ? ' · 추천' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

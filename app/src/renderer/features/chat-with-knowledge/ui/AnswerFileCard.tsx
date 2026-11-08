import { useId, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { ChatAnswer } from './ChatAnswer';
import styles from './KnowledgeChat.module.scss';
import type { ExportFormat } from '@contracts/fileExports.contract';
import { availableExportFormats } from '@renderer/platform/fileExports';
import { markdownExportFilename } from '@contracts/fileExports.contract';
import { fileComposition } from '../model/fileSummary';
type AnswerFileCardProps = {
  format: ExportFormat;
  body: string;
  title: string;
  sources: number;
  preview: boolean;
  downloading: boolean;
  onDownload: (format: ExportFormat) => void;
};
/** 요청한 형식으로 바로 받을 수 있는 파일 카드입니다. */
export function AnswerFileCard({
  format,
  body,
  title,
  sources,
  preview,
  downloading,
  onDownload,
}: AnswerFileCardProps): JSX.Element {
  const previewId = useId();
  const [expanded, setExpanded] = useState(false);
  const composition = useMemo(
    (): string => fileComposition(format, body),
    [format, body],
  );
  const usable = availableExportFormats().includes(format);
  const filename = markdownExportFilename(title, format);
  return (
    <>
      <div className={styles.fileCard}>
        <span className={styles.fileTile} aria-hidden="true">
          {format.toUpperCase()}
        </span>
        <span className={styles.fileText}>
          {preview ? (
            <button
              type="button"
              className={styles.previewTrigger}
              aria-label={filename + ' 내용 미리 보기'}
              title="내용 미리 보기"
              aria-expanded={expanded}
              aria-controls={expanded ? previewId : undefined}
              onClick={(): void => setExpanded(!expanded)}
            >
              {filename}
            </button>
          ) : (
            <strong>{filename}</strong>
          )}
          <small>
            {usable
              ? [composition, sources > 0 ? `근거 문서 ${sources}개` : '']
                  .filter(Boolean)
                  .join(' · ')
              : '이 환경에서는 이 형식으로 저장할 수 없어요. 아래 "다른 형식으로"에서 골라 주세요.'}
          </small>
        </span>
        {usable && (
          <button
            type="button"
            className={`${styles.button} ${styles.primaryAction}`}
            disabled={downloading}
            onClick={(): void => {
              onDownload(format);
            }}
          >
            {downloading ? '내려받는 중…' : '내려받기'}
          </button>
        )}
      </div>
      {preview && expanded && (
        <div id={previewId} className={styles.filePreview}>
          <ChatAnswer content={body} />
        </div>
      )}
    </>
  );
}

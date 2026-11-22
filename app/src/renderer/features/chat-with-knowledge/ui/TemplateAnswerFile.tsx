import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import type {
  TemplatePreparedResult,
  TemplateSession,
} from '@contracts/templates.contract';
import { templatesGateway } from '@renderer/platform/templates';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { Button } from '@renderer/shared/ui/Button';
import { ChatAnswer } from './ChatAnswer';
import { splitTemplateResult } from '../model/templateSnapshot';
import type { TemplateSnapshot } from '../model/templateSnapshot';
import styles from './KnowledgeChat.module.scss';

type TemplateAnswerFileProps = {
  session: TemplateSession;
  snapshot: TemplateSnapshot;
  content: string;
};

/** 실제 고정판 렌더가 성공한 파일만 완료 카드로 보여 줍니다. */
export function TemplateAnswerFile({
  session,
  snapshot,
  content,
}: TemplateAnswerFileProps): JSX.Element {
  const [file, setFile] = useState<TemplatePreparedResult | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const previewId = useId();
  const plan = splitTemplateResult(content);
  const templateId = snapshot.template.id;
  const revision = snapshot.template.revision;
  useEffect((): (() => void) => {
    let active = true;
    async function prepare(): Promise<void> {
      try {
        const result = await templatesGateway.prepareResult({
          ...session,
          templateId,
          revision,
          content,
        });
        if (!active) return;
        if (result.ok) setFile(result.data);
        else setError(result.error.message);
      } catch {
        if (active)
          setError('결과 파일을 준비하지 못했습니다. 다시 시도해 주세요.');
      }
    }
    void prepare();
    return (): void => {
      active = false;
    };
  }, [session, templateId, revision, content, attempt]);

  /** 메모리에서 만료된 파일도 같은 원본 판본과 답변으로 다시 만듭니다. */
  async function download(): Promise<void> {
    if (!file || downloading) return;
    setDownloading(true);
    setError('');
    try {
      let result = await templatesGateway.downloadResult({
        ...session,
        resultId: file.resultId,
      });
      if (!result.ok && result.error.code === 'result_expired') {
        const prepared = await templatesGateway.prepareResult({
          ...session,
          templateId,
          revision,
          content,
        });
        if (!prepared.ok) {
          setError(prepared.error.message);
          return;
        }
        setFile(prepared.data);
        result = await templatesGateway.downloadResult({
          ...session,
          resultId: prepared.data.resultId,
        });
      }
      if (!result.ok) setError(result.error.message);
      else if (result.data.warning) setError(result.data.warning);
    } catch {
      setError('파일을 내려받지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      {!file && !error && (
        <p role="status" className={styles.scopeNote}>
          템플릿에 내용을 적용하고 파일을 확인하고 있습니다.
        </p>
      )}
      {file && (
        <div className={styles.fileCard}>
          <span className={styles.fileTile} aria-hidden="true">
            {snapshot.generation.format?.toUpperCase() ?? '파일'}
          </span>
          <span className={styles.fileText}>
            <button
              type="button"
              className={styles.previewTrigger}
              aria-expanded={expanded}
              aria-controls={previewId}
              onClick={(): void => setExpanded(!expanded)}
            >
              {file.filename}
            </button>
            <small>
              {Math.max(1, Math.ceil(file.sizeBytes / 1024)).toLocaleString()}{' '}
              KB · {snapshot.template.name}
            </small>
          </span>
          <Button
            size="small"
            disabled={downloading}
            onClick={(): void => {
              void download();
            }}
          >
            {downloading ? '내려받는 중…' : '내려받기'}
          </Button>
        </div>
      )}
      {file && expanded && (
        <div id={previewId} className={styles.filePreview}>
          <ChatAnswer content={plan.preview} />
        </div>
      )}
      {error && (
        <StatusNotice tone="warning" variant="box">
          {error}{' '}
          {!file && (
            <Button
              variant="secondary"
              size="small"
              onClick={(): void => {
                setError('');
                setAttempt(attempt + 1);
              }}
            >
              파일 다시 만들기
            </Button>
          )}
        </StatusNotice>
      )}
    </>
  );
}

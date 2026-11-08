import { useMemo } from 'react';
import type { JSX } from 'react';
import type { ChatTurn } from '../model/chatState';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { Link } from 'react-router';
import styles from './KnowledgeChat.module.scss';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import type { ExportFormat } from '@contracts/fileExports.contract';
import { splitOutputDirective } from '../model/outputIntent';
import {
  answerFileTitle,
  leadSentence,
  countTables,
} from '../model/fileSummary';
import {
  citationChip,
  citationText,
  webBasisSummary,
} from '../model/chatCitations';
import { AssistantMessage } from './AssistantMessage';
import { ChatAnswer } from './ChatAnswer';
import { AnswerActions } from './AnswerActions';
import { AnswerFileCard } from './AnswerFileCard';
type ChatReplyProps = {
  turn: ChatTurn;
  citations: KnowledgeValue[];
  noWiki: boolean;
  partialSearch: boolean;
  title: string;
  suggested?: ExportFormat;
  disabled: boolean;
  downloading: boolean;
  onAsk: () => void;
  onEvidence: (index: number) => void;
  onDownload: (format: ExportFormat) => void;
  onCopyError: () => void;
};
/** 저장된 답변 하나에 본문, 실제 근거, 요청한 파일, 가능한 동작만 붙입니다. */
export function ChatReply({
  turn,
  citations,
  noWiki,
  partialSearch,
  title,
  suggested,
  disabled,
  downloading,
  onAsk,
  onEvidence,
  onDownload,
  onCopyError,
}: ChatReplyProps): JSX.Element {
  const { format, body } = splitOutputDirective(turn.content);
  const recommended = useMemo(
    (): ExportFormat => suggested ?? (countTables(body) > 0 ? 'xlsx' : 'docx'),
    [body, suggested],
  );
  const summary = format ? leadSentence(body) : '';
  const webSummary = webBasisSummary(turn.basis);
  const webIncluded = webSummary !== null;
  const showEvidence = !noWiki || webIncluded;
  // 형식 표시 없이 저장된 예전 답변도 원문을 보존한다. 명시적인 확인 한계 문단만 보조 색으로 읽는다.
  const lastParagraph =
    body
      .trimEnd()
      .split(/\n\s*\n/)
      .at(-1) ?? '';
  const endsWithLimitation =
    /(?:문서|위키|자료|근거)[^\n.!?。]{0,160}(?:확인되지 않|확인(?:할 수|하기) (?:없|어렵)|명시되지 않)/u.test(
      lastParagraph,
    );
  const sources = new Set(
    citations
      .map(
        (item: KnowledgeValue): string =>
          citationText(item, 'document') || citationText(item, 'url'),
      )
      .filter(Boolean),
  ).size;
  const evidence = citations.length ? (
    <div className={styles.evidenceActions}>
      <span className={styles.evidenceLabel}>근거</span>
      {citations.map((citation: KnowledgeValue, index: number): JSX.Element => (
        <button
          key={index}
          type="button"
          className={styles.citation}
          data-chat-evidence-trigger={turn.id + ':' + index}
          aria-label={`근거 ${index + 1} 확인 · ${citationChip(citation)}`}
          onClick={(): void => onEvidence(index)}
        >
          {citationChip(citation)}
        </button>
      ))}
    </div>
  ) : (
    <StatusNotice variant="box" tone="warning">
      이 답변에는 저장된 인용이 없어요. 확인된 근거로 단정할 수 없어요.
    </StatusNotice>
  );
  const file = !!format && !!body.trim() && turn.status !== 'failed';
  return (
    <AssistantMessage saved>
      <p className={styles.scopeNote}>
        {webSummary ?? '워크스페이스 근거만 사용'}
      </p>
      {noWiki && (
        <StatusNotice
          variant="box"
          tone="info"
          className={styles.inAnswer}
          title="위키에서 관련 문서를 찾지 못했어요"
        >
          {partialSearch
            ? '검색 범위 일부만 확인했어요. 확인한 범위에서는 이 질문에 쓸 문서를 찾지 못했어요.'
            : '이 질문에 쓸 수 있는 문서가 없습니다.'}
        </StatusNotice>
      )}
      <ChatAnswer
        content={summary || body}
        secondaryEnding={(noWiki && !webIncluded) || endsWithLimitation}
      />
      {turn.status === 'failed' && (
        <StatusNotice variant="box" tone="warning">
          이 답변은 실패 상태로 저장되었어요.
        </StatusNotice>
      )}
      {noWiki && !webIncluded && (
        <div className={styles.answerActions}>
          <Link
            className={`${styles.button} ${styles.primaryAction}`}
            to="/register"
          >
            자료 등록하기
          </Link>
          <button
            className={styles.button}
            type="button"
            disabled={disabled}
            onClick={onAsk}
          >
            질문 바꿔 보기
          </button>
        </div>
      )}
      {!noWiki && partialSearch && (
        <p className={styles.scopeNote}>검색 범위 일부만 확인했어요.</p>
      )}
      {showEvidence && !file && evidence}
      {file && (
        <AnswerFileCard
          format={format}
          body={body}
          title={answerFileTitle(body, title)}
          sources={sources}
          preview={Boolean(summary)}
          downloading={downloading}
          onDownload={onDownload}
        />
      )}
      {(showEvidence || file) && (
        <AnswerActions
          body={body}
          fileFormat={format}
          recommended={recommended}
          failed={turn.status === 'failed'}
          downloading={downloading}
          canAsk={!disabled}
          onAsk={onAsk}
          onDownload={onDownload}
          onCopyError={onCopyError}
        />
      )}
      {showEvidence && file && evidence}
    </AssistantMessage>
  );
}

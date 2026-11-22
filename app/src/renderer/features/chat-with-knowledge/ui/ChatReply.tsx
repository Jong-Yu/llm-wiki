import { useMemo } from 'react';
import type { JSX } from 'react';
import type { ChatTurn } from '../model/chatState';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import styles from './KnowledgeChat.module.scss';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { Icon } from '@renderer/shared/ui/Icon';
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
import { TemplateAnswerFile } from './TemplateAnswerFile';
import { splitTemplateResult } from '../model/templateSnapshot';
import type { TemplateSnapshot } from '../model/templateSnapshot';
import type { TemplateSession } from '@contracts/templates.contract';
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
  templateSnapshot?: TemplateSnapshot;
  templateSession?: TemplateSession;
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
  templateSnapshot,
  templateSession,
}: ChatReplyProps): JSX.Element {
  const ordinary = splitOutputDirective(turn.content);
  const plan = templateSnapshot ? splitTemplateResult(turn.content) : null;
  const format = templateSnapshot ? null : ordinary.format;
  const body = plan?.body ?? ordinary.body;
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
      <span className={styles.evidenceLabel}>근거 {citations.length}개</span>
      {citations.map((citation: KnowledgeValue, index: number): JSX.Element => (
        <button
          key={index}
          type="button"
          className={styles.citation}
          data-chat-evidence-trigger={turn.id + ':' + index}
          aria-label={`근거 ${index + 1} 확인 · ${citationChip(citation)}`}
          title="인용문과 출처 보기"
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
      {webSummary && (
        <p className={styles.scopeNote}>
          <Icon name="globe" />
          <span>{webSummary}</span>
        </p>
      )}
      {noWiki && (
        <p className={styles.scopeNote}>
          <Icon name="files" />
          <span>
            {partialSearch
              ? '일부 범위만 검색했으며 관련 위키 근거를 찾지 못했습니다.'
              : '관련 위키 근거 없음'}
          </span>
        </p>
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
      {!noWiki && partialSearch && (
        <p className={styles.scopeNote}>
          <Icon name="info" />
          <span>검색 범위 일부만 확인했어요.</span>
        </p>
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
      {templateSnapshot &&
        templateSession &&
        plan?.hasPlan &&
        turn.status !== 'failed' && (
          <TemplateAnswerFile
            session={templateSession}
            snapshot={templateSnapshot}
            content={turn.content}
          />
        )}
      {(showEvidence || file) && !templateSnapshot && (
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
      {templateSnapshot && (
        <details className={styles.templateRequest}>
          <summary>이 요청에 적용한 템플릿·지침</summary>
          <p>
            {templateSnapshot.template.name} ·{' '}
            {templateSnapshot.template.filename}
          </p>
          <p className={styles.templateInstructions}>
            {templateSnapshot.template.instructions ||
              '등록한 지침이 없습니다.'}
          </p>
          <button
            type="button"
            className={styles.button}
            disabled={disabled}
            onClick={onAsk}
          >
            다시 묻기
          </button>
        </details>
      )}
    </AssistantMessage>
  );
}

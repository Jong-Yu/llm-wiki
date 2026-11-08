import type { JSX, Ref } from 'react';
import { documentDisplayName } from '@renderer/domains/documents';
import {
  citationText,
  citationKind,
  citationWebUrl,
  citationRetrievedAt,
  citationFacts,
} from '../model/chatCitations';
import { Icon } from '@renderer/shared/ui/Icon';
import { Link } from 'react-router';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import styles from './KnowledgeChat.module.scss';

type ChatEvidencePanelProps = {
  panelRef: Ref<HTMLElement>;
  visible: boolean;
  narrow: boolean;
  title: string;
  searchSummary: string;
  citations: KnowledgeValue[];
  all: boolean;
  total: number;
  loading: boolean;
  onClose: () => void;
  onSelect: (index?: number) => void;
};
/** 주소에서 선택한 답변의 근거만 읽고 원문으로 이동합니다. */
export function ChatEvidencePanel({
  panelRef,
  visible,
  narrow,
  title,
  searchSummary,
  citations,
  all,
  total,
  loading,
  onClose,
  onSelect,
}: ChatEvidencePanelProps): JSX.Element {
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      hidden={!visible}
      className={styles.evidencePanel}
      aria-label="답변 근거"
      id="chat-evidence"
    >
      <header className={styles.panelHeader}>
        <h2>{title}</h2>
        <button
          className={`${styles.ghost} ${narrow ? '' : styles.iconButton}`}
          type="button"
          aria-label={narrow ? '대화로 돌아가기' : '답변 근거 닫기'}
          title={narrow ? '대화로 돌아가기' : '답변 근거 닫기'}
          onClick={onClose}
        >
          <Icon name={narrow ? 'arrow-left' : 'x'} />
          {narrow && '대화로'}
        </button>
      </header>
      {searchSummary && <p className={styles.scopeNote}>{searchSummary}</p>}
      {!loading && citations.length === 0 && (
        <p role="status">
          이 답변의 저장된 근거를 찾을 수 없습니다. 다른 답변의 근거로 대신
          표시하지 않습니다.
        </p>
      )}
      {!all && total > 1 && (
        <button
          className={styles.ghost}
          type="button"
          onClick={(): void => onSelect()}
        >
          <Icon name="arrow-left" /> 답변의 모든 근거 {total}개
        </button>
      )}
      {all && citations.length > 1 ? (
        <div className={styles.evidenceList}>
          {citations.map(
            (citation: KnowledgeValue, index: number): JSX.Element => (
              <button
                key={index}
                className={styles.evidenceListItem}
                type="button"
                onClick={(): void => onSelect(index)}
              >
                <span className={styles.citationNumber}>{index + 1}</span>
                <span>
                  <strong>
                    {citationText(citation, 'kind') === 'web'
                      ? citationText(citation, 'title') || '외부 웹 자료'
                      : citationText(citation, 'document')
                        ? documentDisplayName(
                            citationText(citation, 'document'),
                          )
                        : '근거 자료'}
                  </strong>
                  <small>{citationKind(citation)}</small>
                </span>
                <Icon name="chevron-right" />
              </button>
            ),
          )}
        </div>
      ) : (
        citations.map(
          (citation: KnowledgeValue, index: number): JSX.Element => (
            <section key={index} className={styles.evidenceCard}>
              <span className={styles.kind}>{citationKind(citation)}</span>
              <h3>
                {citationText(citation, 'kind') === 'web'
                  ? citationText(citation, 'title') || '외부 웹 자료'
                  : citationText(citation, 'document')
                    ? documentDisplayName(citationText(citation, 'document'))
                    : '근거 자료'}
              </h3>
              {citationText(citation, 'kind') !== 'policy' &&
                citationText(citation, 'kind') !== 'review' &&
                citationText(citation, 'quote') && (
                  <blockquote>{citationText(citation, 'quote')}</blockquote>
                )}
              {(citationText(citation, 'start_line') ||
                citationText(citation, 'end_line')) && (
                <p className={styles.citationLocation}>
                  원문 위치 ·{' '}
                  {citationText(citation, 'start_line') ===
                  citationText(citation, 'end_line')
                    ? `${citationText(citation, 'start_line')}행`
                    : citationText(citation, 'start_line') &&
                        citationText(citation, 'end_line')
                      ? `${citationText(citation, 'start_line')}–${citationText(citation, 'end_line')}행`
                      : citationText(citation, 'start_line')
                        ? `${citationText(citation, 'start_line')}행부터`
                        : `${citationText(citation, 'end_line')}행까지`}
                </p>
              )}
              {citationText(citation, 'document') && (
                <Link
                  className={styles.button}
                  to={`/document?path=${encodeURIComponent(citationText(citation, 'document'))}`}
                >
                  현재 문서 열기 <Icon name="external-link" />
                </Link>
              )}
              {citationWebUrl(citation) && (
                <p>
                  <a
                    href={citationWebUrl(citation) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    외부 출처 열기 <Icon name="external-link" />
                  </a>
                  <br />
                  <small>{citationWebUrl(citation)}</small>
                </p>
              )}
              {citationRetrievedAt(citation) && (
                <p className={styles.citationLocation}>
                  확인 시각 · {citationRetrievedAt(citation)}
                </p>
              )}
              {citationFacts(citation).map(
                (fact: { label: string; text: string }): JSX.Element => (
                  <p className={styles.citationLocation} key={fact.label}>
                    {fact.label} · {fact.text}
                  </p>
                ),
              )}
              {['policy', 'review'].includes(
                citationText(citation, 'kind'),
              ) && (
                <p className={styles.citationLocation}>
                  답변 당시의 판단 기록입니다. 사람의 승인을 의미하지 않습니다.
                </p>
              )}
              {citationText(citation, 'kind') === 'source' &&
                citationText(citation, 'source_id') &&
                citationText(citation, 'source_version') && (
                  <Link
                    className={styles.button}
                    to={`/source?${new URLSearchParams({ sourceId: citationText(citation, 'source_id'), version: citationText(citation, 'source_version') })}`}
                  >
                    인용 당시 원본 열기 <Icon name="external-link" />
                  </Link>
                )}
            </section>
          ),
        )
      )}
    </aside>
  );
}

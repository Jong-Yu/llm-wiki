import type { ChangeEvent, JSX } from 'react';
import { Link } from 'react-router';
import { documentDisplayName } from '@renderer/domains/documents';
import type { DocumentKnowledge } from '@contracts/knowledge.contract';
import styles from './OntologyMapWorkspace.module.scss';
import panelStyles from './OntologyRelationPanel.module.scss';

type OntologyRelationDocumentChoiceProps = {
  documents: DocumentKnowledge[];
  /** 최신 추출이 있어 관계를 추가할 수 있는 문서입니다. */
  ready: DocumentKnowledge[];
  loading: boolean;
  hasMore: boolean;
  onChoose: (knowledge: DocumentKnowledge) => void;
  onLoadMore: () => void;
};

/** 새 관계의 대상 문서가 정해지지 않았을 때 패널 안에서 문서를 고르게 합니다. */
export function OntologyRelationDocumentChoice({
  documents,
  ready,
  loading,
  hasMore,
  onChoose,
  onLoadMore,
}: OntologyRelationDocumentChoiceProps): JSX.Element {
  return (
    <div className={panelStyles.panel}>
      {documents.length === 0 ? (
        <p>
          대상 문서가 없습니다.{' '}
          <Link to="/documents">문서 목록에서 등록·추출 상태 확인</Link>
        </p>
      ) : (
        <div className={`${styles.form} ${panelStyles.plain}`}>
          <label>
            문서
            <select
              value=""
              disabled={loading}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                const chosen = documents.find(
                  (item: DocumentKnowledge): boolean =>
                    item.document === event.target.value,
                );
                if (chosen) onChoose(chosen);
              }}
            >
              <option value="">문서 선택</option>
              {documents.map((knowledge: DocumentKnowledge): JSX.Element => (
                <option
                  key={knowledge.document}
                  value={knowledge.document}
                  disabled={!ready.includes(knowledge)}
                >
                  {documentDisplayName(knowledge.document)}
                  {ready.includes(knowledge) ? '' : ' (최신 추출 필요)'}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {hasMore && (
        <button type="button" disabled={loading} onClick={onLoadMore}>
          다음 문서 범위 읽기
        </button>
      )}
    </div>
  );
}

import type { JSX } from 'react';
import { Link } from 'react-router';
import type { OntologySearchPage } from '@contracts/ontologyExploration.contract';
import { documentDisplayName } from '@renderer/domains/documents';
import styles from './OntologyExplorer.module.scss';

type OntologyCoverageNoticeProps = {
  coverage: OntologySearchPage['coverage'];
  scope: string;
};
const reasons: Record<string, string> = {
  source_anchor_relation_not_projected:
    '원문을 대상으로 한 관계는 문서별 지도에서 확인할 수 있습니다.',
  unavailable_relation_endpoint:
    '관계의 한쪽 개념을 확인하지 못해 지도에서 제외했습니다.',
  source_context_limit:
    '문단이 길어 연결된 인용만 읽었습니다. 전체 문맥은 원문에서 확인해 주세요.',
  ontology_missing: '아직 관계가 추출되지 않았습니다.',
  ontology_stale: '문서가 바뀌어 관계를 다시 추출해야 합니다.',
  review_unavailable: '검토 기록을 읽지 못했습니다.',
  review_capture_limit: '검토 기록의 조회 범위를 초과했습니다.',
  capture_limit: '문서 또는 관계의 조회 범위를 초과했습니다.',
  observation_failed: '문서의 현재 상태를 확인하지 못했습니다.',
  unsafe_path: '이 문서는 현재 경로로 열 수 없습니다.',
};

/** 개수의 집계 범위와 제외 정보의 범위를 구별하고 실제 문서 확인 경로를 제공합니다. */
export function OntologyCoverageNotice({
  coverage,
  scope,
}: OntologyCoverageNoticeProps): JSX.Element | null {
  if (coverage.complete && !coverage.truncated && coverage.skipped.length === 0)
    return null;
  const documents = new Map<string, Set<string>>();
  for (const item of coverage.skipped) {
    const codes = documents.get(item.document) ?? new Set<string>();
    codes.add(item.code);
    documents.set(item.document, codes);
  }
  return (
    <details className={styles.coverage}>
      <summary>
        {documents.size > 0
          ? `문서 ${documents.size}개의 일부 정보를 확인하지 못했습니다`
          : '일부 정보를 확인하지 못했습니다'}
      </summary>
      <p>
        {scope === '검색 대상 전체 문서'
          ? '아래 문서에는 이 지도에서 확인할 수 없는 정보가 있습니다. 문서별 이유를 확인해 주세요.'
          : `${scope}에서 확인하지 못한 정보입니다.`}
      </p>
      {coverage.truncated && <p>조회 범위를 넘어 일부 정보가 제외됐습니다.</p>}
      {documents.size === 0 && (
        <p>
          전체 정보를 확인하지 못했습니다. 문서에서 원문과 분석 상태를 확인해
          주세요.
        </p>
      )}
      <ul>
        {[...documents].map(
          ([document, codes]: [string, Set<string>]): JSX.Element => (
            <li key={document}>
              {codes.has('unsafe_path') ? (
                <strong>{documentDisplayName(document)}</strong>
              ) : (
                <Link
                  to={`/ontology?path=${encodeURIComponent(document)}&from=map`}
                >
                  {documentDisplayName(document)} · 문서별 지도 열기
                </Link>
              )}
              {[...codes].map((code: string): JSX.Element => (
                <p key={code}>
                  {reasons[code] ??
                    '일부 정보를 확인하지 못했습니다. 문서에서 원문과 분석 상태를 확인해 주세요.'}
                </p>
              ))}
            </li>
          ),
        )}
      </ul>
    </details>
  );
}

import { splitExactLines } from '@renderer/shared/lib/lineComparison';
import type { JSX } from 'react';
import { LineComparison } from '@renderer/shared/ui/LineComparison';
import { documentMetadataPreview } from '../model/documentMetadata';
import styles from './ManageDocumentContent.module.scss';

type DocumentComparisonProps = {
  leftTitle: string;
  left: string;
  rightTitle: string;
  right: string;
  metadata?: boolean;
};
/** 서버가 메타정보 문서로 확인한 경우에만 원문 헤더를 본문과 분리합니다. */
function parts(
  value: string,
  metadata: boolean,
): { header: string; body: string } {
  const header = metadata
    ? (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(value)?.[0] ?? '')
    : '';
  return { header, body: value.slice(header.length) };
}
/** 저장용 문자열을 수정하지 않고 메타정보와 본문 변경을 각각 표시합니다. */
export function DocumentComparison({
  leftTitle,
  left,
  rightTitle,
  right,
  metadata = false,
}: DocumentComparisonProps): JSX.Element {
  const before = parts(left, metadata),
    after = parts(right, metadata);
  const beforeMetadata = documentMetadataPreview(before.header);
  const afterMetadata = documentMetadataPreview(after.header);
  return (
    <div className={styles.comparisonSections}>
      {(before.header || after.header) && (
        <section aria-label="문서 정보 비교">
          <h3>
            제목·태그·설명{' '}
            {beforeMetadata === afterMetadata ? '변경 없음' : '변경 있음'}
          </h3>
          <details>
            <summary>제목·태그·설명 비교</summary>
            {beforeMetadata !== afterMetadata ? (
              <LineComparison
                key={`${beforeMetadata.length}:${beforeMetadata}${afterMetadata}`}
                left={beforeMetadata}
                right={afterMetadata}
                leftTitle={leftTitle}
                rightTitle={rightTitle}
              />
            ) : (
              <pre>{beforeMetadata}</pre>
            )}
          </details>
          {before.header !== after.header &&
            beforeMetadata === afterMetadata && (
              <p>원본 연결 또는 문서 관리 정보에 변경이 있습니다.</p>
            )}
        </section>
      )}
      <section aria-label="본문 비교">
        <h3>본문 {before.body === after.body ? '변경 없음' : '변경 있음'}</h3>
        <LineComparison
          key={`${before.body.length}:${before.body}${after.body}`}
          left={before.body}
          leftOffset={splitExactLines(before.header).length}
          rightOffset={splitExactLines(after.header).length}
          right={after.body}
          leftTitle={leftTitle}
          rightTitle={rightTitle}
        />
      </section>
    </div>
  );
}

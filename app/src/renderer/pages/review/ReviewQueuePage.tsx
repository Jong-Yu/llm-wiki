import type { JSX } from 'react';
import { ReviewQueue } from '@renderer/features/browse-review-queue';
import type { ReviewQueueItem } from '@renderer/features/browse-review-queue';
import { OntologyClaimWorkbench } from '@renderer/features/explore-ontology-map';

/** 검토함 목록에 온톨로지의 원문·판단 화면을 연결합니다(feature 사이의 조합은 페이지에서 합니다). */
export function ReviewQueuePage(): JSX.Element {
  return (
    <ReviewQueue
      renderWorkbench={(
        item: ReviewQueueItem,
        onDecided: () => void,
      ): JSX.Element | null =>
        item.kind === 'document_claim' && item.document && item.claimId ? (
          <OntologyClaimWorkbench
            key={item.key}
            document={item.document}
            claimId={item.claimId}
            onDecided={onDecided}
          />
        ) : null
      }
    />
  );
}

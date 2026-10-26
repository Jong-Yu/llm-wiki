import { PageNavigation } from '@renderer/shared/ui/PageNavigation';
import { useState } from 'react';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { isDocumentPath } from '@contracts/documents.contract';
import { WorkspaceExplorer } from '@renderer/features/explore-workspace';
import type {
  ExplorerMode,
  ExplorerReviewSelection,
  ExplorerScope,
} from '@renderer/features/explore-workspace';
import { ReviewDialog } from '@renderer/features/review-document-knowledge';
import { SaveCleanupNotice } from '@renderer/shared/ui/SaveCleanupNotice';

type WorkspaceExplorerPageProps = { mode?: ExplorerMode };
type WorkspaceExplorerContentProps = {
  mode: ExplorerMode;
  initialDocument?: string;
};
type ReviewTarget = {
  selection: ExplorerReviewSelection;
  connectionId: string;
  scope: ExplorerScope;
};

/** 탐색·검토함·이력·질문 준비와 명시 검토 대화상자를 페이지에서 조립합니다. */
export function WorkspaceExplorerPage({
  mode = 'knowledge',
}: WorkspaceExplorerPageProps): JSX.Element {
  const [parameters] = useSearchParams();
  const requested = parameters.get('document');
  const initialDocument =
    requested && isDocumentPath(requested) ? requested : undefined;
  // 경로가 바뀌면 이전 검토 대상과 그 대화상자의 비동기 수명을 종료합니다.
  return (
    <WorkspaceExplorerContent
      key={`${mode}:${initialDocument || ''}`}
      mode={mode}
      initialDocument={initialDocument}
    />
  );
}

/** 같은 화면 수명 안에서 명시 검토 결과를 탐색 새로고침으로 연결합니다. */
function WorkspaceExplorerContent({
  mode,
  initialDocument,
}: WorkspaceExplorerContentProps): JSX.Element {
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [revision, setRevision] = useState(0);
  const [cleanupWarningCount, setCleanupWarningCount] = useState(0);
  return (
    <>
      <WorkspaceExplorer
        navigation={
          mode === 'knowledge' ? (
            <PageNavigation
              links={[{ to: '/correspondences', label: '조건·개념 대응' }]}
            />
          ) : mode === 'questions' ? (
            <PageNavigation
              links={[
                {
                  to: initialDocument
                    ? `/conversations?document=${encodeURIComponent(initialDocument)}`
                    : '/conversations',
                  label: '질문·대화',
                },
              ]}
            />
          ) : undefined
        }
        key={`${mode}:${revision}:${initialDocument || ''}`}
        mode={mode}
        initialDocument={initialDocument}
        onReview={(
          selection: ExplorerReviewSelection,
          connectionId: string,
          scope: ExplorerScope,
        ): void => setReview({ selection, connectionId, scope })}
      />
      {review && (
        <ReviewDialog
          selection={review.selection}
          connectionId={review.connectionId}
          scope={review.scope}
          onClose={(): void => setReview(null)}
          onChanged={(count: number): void => {
            setCleanupWarningCount(count);
            setReview(null);
            setRevision((current: number): number => current + 1);
          }}
        />
      )}
      {cleanupWarningCount > 0 && (
        <SaveCleanupNotice
          count={cleanupWarningCount}
          onClose={(): void => setCleanupWarningCount(0)}
        />
      )}
    </>
  );
}

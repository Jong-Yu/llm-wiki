import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { AiSessions } from '@renderer/features/browse-ai-sessions';

/** 원본·문서별 필터를 세션 목록에 전달합니다. */
export function AiSessionsPage(): JSX.Element {
  const [search] = useSearchParams();
  return (
    <AiSessions
      comparisonId={search.get('comparisonId')}
      filter={{
        sourceId: search.get('sourceId'),
        sourceVersion: search.get('sourceVersion'),
        document: search.get('document'),
      }}
    />
  );
}

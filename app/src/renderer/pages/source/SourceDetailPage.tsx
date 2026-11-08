import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { SourceDetail } from '@renderer/features/browse-document-library';
import { sourceAnalysisStarter } from '../documents/sourceAnalysisStarter';

/** 원본과 판본을 주소에서 읽고 해당 원본 상세에 전달합니다. */
export function SourceDetailPage(): JSX.Element {
  const [parameters] = useSearchParams();
  return (
    <SourceDetail
      analysisStarter={sourceAnalysisStarter}
      key={`${parameters.get('sourceId')}:${parameters.get('version')}`}
      sourceId={parameters.get('sourceId') ?? ''}
      version={parameters.get('version') ?? ''}
    />
  );
}

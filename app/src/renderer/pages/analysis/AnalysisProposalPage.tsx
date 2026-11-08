import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { AnalysisProposalWorkspace } from '@renderer/features/review-analysis-proposals';

/** 추출 당시 문서와 작업 식별자를 보존해 기존 비교·검증·적용 화면에 연결합니다. */
export function AnalysisProposalPage(): JSX.Element {
  const [parameters] = useSearchParams();
  return (
    <AnalysisProposalWorkspace
      document={parameters.get('document') ?? ''}
      proposalId={parameters.get('proposalId') ?? ''}
    />
  );
}

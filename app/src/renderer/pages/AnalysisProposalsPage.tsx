import type { ProposalExecutionBridge } from '@contracts/proposalExecution.contract';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import type { AnalysisProposalsBridge } from '@contracts/analysisProposals.contract';
import { ReviewAnalysisProposals } from '@renderer/features/review-analysis-proposals';

type AnalysisProposalsPageProps = {
  gateway: AnalysisProposalsBridge;
  executionGateway: ProposalExecutionBridge;
};
/** 페이지는 선택 의도와 한정된 bridge를 전달하고 저장·검토는 feature가 소유합니다. */
export function AnalysisProposalsPage({
  gateway,
  executionGateway,
}: AnalysisProposalsPageProps): JSX.Element {
  const [params] = useSearchParams();
  return (
    <ReviewAnalysisProposals
      key={JSON.stringify([params.get('document'), params.get('proposalId')])}
      gateway={gateway}
      executionGateway={executionGateway}
      initialDocument={params.get('document') ?? ''}
      initialProposalId={params.get('proposalId') ?? ''}
    />
  );
}

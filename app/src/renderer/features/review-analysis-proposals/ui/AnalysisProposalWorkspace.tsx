import type { JSX } from 'react';
import { analysisProposalsGateway } from '@renderer/platform/analysisProposals';
import { proposalExecutionGateway } from '@renderer/platform/proposalExecution';
import { ReviewAnalysisProposals } from './ReviewAnalysisProposals';

type AnalysisProposalWorkspaceProps = { document: string; proposalId: string };
/** 페이지의 대상만 받아 기존 검토 서비스와 실행 서비스를 기능 안에서 연결합니다. */
export function AnalysisProposalWorkspace({
  document,
  proposalId,
}: AnalysisProposalWorkspaceProps): JSX.Element {
  return (
    <ReviewAnalysisProposals
      gateway={analysisProposalsGateway}
      executionGateway={proposalExecutionGateway}
      initialDocument={document}
      initialProposalId={proposalId}
    />
  );
}

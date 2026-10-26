import type {
  ProposalExecutionBridge,
  ProposalExecutionStart,
  ProposalExecutionRead,
  ProposalExecutionCancel,
  ProposalExecutionResult,
} from '@contracts/proposalExecution.contract';
/** 기존 실행을 자동 재시작하지 않고 명시한 bridge 동작만 전달합니다. */
function bridge(): ProposalExecutionBridge {
  if (!window.wiki) throw new Error('데스크톱 앱에서 실행해 주세요.');
  return window.wiki.proposalExecution;
}
export const proposalExecutionGateway: ProposalExecutionBridge = {
  /** 현재 후보를 고정한 개인 재추출 요청입니다. */
  start: (request: ProposalExecutionStart): Promise<ProposalExecutionResult> =>
    bridge().start(request),
  /** 실제 영수증과 공개 진행을 조회합니다. */
  read: (request: ProposalExecutionRead): Promise<ProposalExecutionResult> =>
    bridge().read(request),
  /** 현재 실행에만 취소 의도를 전달합니다. */
  cancel: (
    request: ProposalExecutionCancel,
  ): Promise<ProposalExecutionResult> => bridge().cancel(request),
};

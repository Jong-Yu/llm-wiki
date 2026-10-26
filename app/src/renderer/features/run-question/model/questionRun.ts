import type { QuestionDetail } from '@contracts/questionRuns.contract';

export type StoredQuestion = {
  conversationId: string;
  questionTurnId: string;
  conversationRevision: string;
};
/** 저장 증거·미확인 요청이 있으면 새 AI 실행으로 우회하지 않습니다. */
export function canStartQuestion(detail: QuestionDetail): boolean {
  return (
    detail.receipts.length === 0 &&
    detail.local.requestId === null &&
    detail.local.status !== 'running' &&
    detail.local.status !== 'stopping' &&
    (detail.status === 'queued' ||
      (detail.status === 'running' && detail.leaseStatus === 'expired'))
  );
}
/** 서버 실행 상태보다 독립 영수증의 실제 저장 여부를 우선합니다. */
export function questionStorageLabel(detail: QuestionDetail): string {
  if (
    detail.receipts.some(
      (receipt: QuestionDetail['receipts'][number]): boolean =>
        receipt.saved === true,
    )
  )
    return '답변 저장 확인';
  if (
    detail.receipts.some(
      (receipt: QuestionDetail['receipts'][number]): boolean =>
        receipt.saved === null,
    ) ||
    detail.local.requestId
  )
    return '답변 저장 결과 확인 필요';
  if (detail.status === 'cancelled') return '취소됨 · 저장 답변 없음';
  if (detail.status === 'failed' || detail.local.status === 'failed')
    return '실행 실패 · 저장 완료 미확인';
  if (detail.status === 'complete') return '완료 상태 · 저장 영수증 확인 필요';
  return '저장 답변 없음';
}

/** 동일 질문의 답변 저장 미확인을 새 실행으로 우회하지 않습니다. */
export function hasUnconfirmedQuestionAnswer(detail: QuestionDetail): boolean {
  return (
    detail.receipts.some(
      (receipt: QuestionDetail['receipts'][number]): boolean =>
        receipt.saved === null,
    ) ||
    (detail.local.requestId !== null &&
      !detail.receipts.some(
        (receipt: QuestionDetail['receipts'][number]): boolean =>
          receipt.request_id === detail.local.requestId &&
          receipt.saved !== null,
      ))
  );
}

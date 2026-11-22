import type {
  QuestionCommentary,
  QuestionDetail,
} from '@contracts/questionRuns.contract';
import { isAiRuntimePreparationFailure } from '@contracts/runtime.contract';
import { chatRunActive, chatRunUncertain, chatTurns } from './chatState';
import type { ChatEnvelope, ChatRunNotice, ChatTurn } from './chatState';

export type ChatRunFailure = {
  title: string;
  message: string;
  connection: boolean;
};

/** AI 설명을 아직 받지 못했을 때의 대기와 사용자가 요청한 중지만 알립니다. */
export function chatRunProgress(run: QuestionDetail | null): string {
  if (run?.local.status === 'stopping') return '답변 생성을 멈추고 있어요';
  return '답변을 준비하고 있어요';
}

/** 현재 실행의 공개 작업 설명만 보여 주며 완료·중단과 다음 질문에는 남기지 않습니다. */
export function chatRunCommentaries(
  run: QuestionDetail | null,
  preparing: boolean,
): readonly QuestionCommentary[] {
  if (
    !run ||
    preparing ||
    !chatRunActive(run) ||
    run.answers.length > 0 ||
    run.receipts.some(
      (receipt: QuestionDetail['receipts'][number]): boolean =>
        receipt.saved === true,
    )
  )
    return [];
  return run.local.commentaries ?? [];
}

/** 안전한 오류 코드로만 사용자 안내를 고르며 원시 실행 출력은 표시하지 않습니다. */
export function chatRunFailure(code: string | null): ChatRunFailure {
  switch (code) {
    case 'question_source_incomplete':
      return {
        title: '문서 작성에 필요한 원문을 모두 읽지 못했어요',
        message:
          '선택한 자료의 일부를 확인하지 못해 작성을 중단했습니다. 자료의 상태와 선택 범위를 확인해 주세요. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'question_source_judgments_unread':
      return {
        title: '자료에 적용된 검토 판단을 더 확인해야 해요',
        message:
          '수정·반려·정책 등 현재 판단을 모두 반영할 수 없어 작성을 중단했습니다. 검토 내용을 확인한 뒤 다시 진행해 주세요. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'ai_unexpected_tool_activity':
      return {
        title: '도구 실행이 허용되지 않아 답변을 중단했어요',
        message:
          '이 질문에서 사용할 수 없는 도구가 요청되었습니다. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'ai_cli_event_rejected':
      // 훅·하위 작업 등 고정 입력 질문에 끼어든 동작이라 로그인·연결 문제가 아닙니다(D-143).
      return {
        title: 'AI 프로그램이 허용되지 않은 동작을 보내 답변을 중단했어요',
        message:
          '훅·하위 작업 같은 동작은 이 질문에서 쓸 수 없습니다. 연결 설정의 문제 상세에서 메시지 종류를 확인할 수 있어요. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'ai_invalid_result':
      return {
        title: '답변 결과를 확인하지 못했어요',
        message:
          '답변 형식이나 근거를 확인하지 못했습니다. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'ai_incomplete_turn':
      return {
        title: '답변이 끝나기 전에 실행이 종료됐어요',
        message: '완료된 답변을 받지 못했습니다. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'ai_timeout':
      return {
        title: '응답 대기 시간이 지났어요',
        message:
          '정해진 시간 안에 답변을 받지 못했습니다. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'ai_rate_limited':
      return {
        title: 'AI 사용 한도에 도달했어요',
        message:
          '사용량이 회복된 뒤 다시 질문할 수 있습니다. 질문은 그대로 남아 있어요.',
        connection: false,
      };
    case 'ai_cli_unavailable':
    case 'ai_windows_dependency_missing':
    case 'ai_cli_not_found':
    case 'ai_login_required':
    case 'ai_authentication_failed':
    case 'ai_login_or_execution_failed':
    case 'ai_session_credentials_unavailable':
      return {
        title: 'AI 실행 환경을 확인해 주세요',
        message:
          'AI 로그인이나 실행 환경을 확인하지 못했어요. 질문은 그대로 남아 있어요.',
        connection: true,
      };
    default:
      // 실행 준비 실패는 로그인·연결 설정으로 해결되지 않으므로 연결 안내를 열지 않습니다.
      if (isAiRuntimePreparationFailure(code))
        return {
          title: 'AI 실행을 준비하지 못했어요',
          message:
            'AI 로그인 문제가 아니라 이 PC에서 실행을 준비하는 단계(프로세스·작업 폴더 보호)에서 멈췄어요. 질문은 그대로 남아 있어요.',
          connection: false,
        };
      return {
        title: '답변 처리 중 오류가 발생했어요',
        message: '작업을 완료하지 못했습니다. 질문은 그대로 남아 있어요.',
        connection: false,
      };
  }
}

/** 확정된 실패·중단만 기록하고 실행 중·저장 미확인 상태를 종료로 단정하지 않습니다. */
export function rememberChatRunNotice(
  previous: readonly ChatRunNotice[],
  detail: QuestionDetail,
): ChatRunNotice[] {
  if (chatRunActive(detail) || chatRunUncertain(detail)) return [...previous];
  const status =
    detail.status === 'cancelled'
      ? 'cancelled'
      : detail.status === 'failed' || detail.local.status === 'failed'
        ? 'failed'
        : null;
  if (status === null) return [...previous];
  const existing = previous.find(
    (item: ChatRunNotice): boolean => item.runId === detail.id,
  );
  const notice: ChatRunNotice = {
    runId: detail.id,
    questionTurnId: detail.questionTurnId,
    status,
    errorCode:
      detail.local.errorCode !== null &&
      /^[a-z][a-z0-9_]{0,119}$/.test(detail.local.errorCode)
        ? detail.local.errorCode
        : (existing?.errorCode ?? null),
  };
  return existing
    ? previous.map((item: ChatRunNotice): ChatRunNotice =>
        item.runId === detail.id ? notice : item,
      )
    : [...previous, notice];
}

/** 자기 실행의 저장 영수증으로 확인한 답변 추가만 다음 초안의 기준에 반영합니다. */
export function canAdvanceChatDraft(
  previous: ChatEnvelope | null,
  current: ChatEnvelope | null,
  detail: QuestionDetail | null,
  draftRevision: string | null,
): boolean {
  if (
    !previous ||
    !current ||
    !detail ||
    draftRevision !== previous.revision ||
    previous.revision === current.revision ||
    previous.record.id !== current.record.id ||
    detail.conversationId !== current.record.id ||
    previous.record.tenant !== current.record.tenant ||
    previous.record.user_id !== current.record.user_id ||
    JSON.stringify(previous.record.data) !== JSON.stringify(current.record.data)
  )
    return false;
  const before = chatTurns(previous);
  const after = chatTurns(current);
  if (
    after.length <= before.length ||
    before.some(
      (turn: ChatTurn, index: number): boolean =>
        JSON.stringify(turn) !== JSON.stringify(after[index]),
    )
  )
    return false;
  const receipts = detail.receipts.filter(
    (item: QuestionDetail['receipts'][number]): boolean =>
      item.saved === true &&
      item.receipt?.question_run_id === detail.id &&
      item.receipt.conversation_id === current.record.id,
  );
  if (
    !receipts.some(
      (item: QuestionDetail['receipts'][number]): boolean =>
        item.receipt?.conversation_revision === current.revision,
    )
  )
    return false;
  return after
    .slice(before.length)
    .every(
      (turn: ChatTurn): boolean =>
        turn.role === 'assistant' &&
        turn.reply_to === detail.questionTurnId &&
        receipts.some(
          (item: QuestionDetail['receipts'][number]): boolean =>
            item.receipt?.answer_turn_id === turn.id,
        ) &&
        detail.answers.some(
          (answer: QuestionDetail['answers'][number]): boolean =>
            answer.turnId === turn.id && answer.content === turn.content,
        ),
    );
}

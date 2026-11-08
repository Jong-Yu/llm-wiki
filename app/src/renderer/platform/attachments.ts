import {
  attachmentPickRequestSchema,
  attachmentPickResultSchema,
} from '@contracts/attachments.contract';
import type {
  AttachmentPickRequest,
  AttachmentPickResult,
} from '@contracts/attachments.contract';

/** 현재 실행 환경이 파일 첨부(앱이 여는 파일 선택 대화상자)를 제공하는지 확인합니다. */
export function supportsFileAttachment(): boolean {
  return typeof window.wiki?.attachments?.pick === 'function';
}

/** 실제 드롭을 확인할 수 있는 Electron 창에서만 끌어다 놓기를 제공합니다. */
export function supportsAttachmentDrop(): boolean {
  return typeof window.wiki?.attachments?.drop === 'function';
}

/** 드롭 순서대로 파일 하나씩 현재 남은 한도로 호출합니다. 경로는 받거나 반환하지 않습니다. */
export async function dropAttachment(
  file: File,
  request: AttachmentPickRequest,
): Promise<AttachmentPickResult> {
  const drop = window.wiki?.attachments?.drop;
  if (!drop)
    return {
      ok: false,
      error: {
        code: 'attachment_unavailable',
        message: '이 실행 환경에서는 파일을 끌어다 놓을 수 없어요.',
      },
    };
  return attachmentPickResultSchema.parse(
    await drop(file, attachmentPickRequestSchema.parse(request)),
  );
}

/** 화면은 경로를 다루지 않고 담을 수 있는 글자 수만 보냅니다. 사용자가 취소하면 data가 null입니다. */
export async function pickAttachment(
  request: AttachmentPickRequest,
): Promise<AttachmentPickResult> {
  const bridge = window.wiki?.attachments;
  if (!bridge)
    return {
      ok: false,
      error: {
        code: 'attachment_unavailable',
        message: '이 실행 환경에서는 파일을 첨부할 수 없어요.',
      },
    };
  return attachmentPickResultSchema.parse(
    await bridge.pick(attachmentPickRequestSchema.parse(request)),
  );
}

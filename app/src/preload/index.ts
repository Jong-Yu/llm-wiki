/// <reference lib="dom" />
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  ATTACHMENT_CHANNELS,
  attachmentPickRequestSchema,
  attachmentPickResultSchema,
} from '@contracts/attachments.contract';
import type {
  AttachmentBridge,
  AttachmentPickRequest,
  AttachmentPickResult,
} from '@contracts/attachments.contract';
import { createWikiBridge } from '../shared/createWikiBridge';

/** 수락한 drop의 디스크 파일만 한 번씩 허용합니다. 읽기 중 겹친 drop은 기존 목록을 지우지 않습니다. */
function createAttachmentDrop(): AttachmentBridge['drop'] {
  if (typeof window === 'undefined' || !webUtils?.getPathForFile) return;
  const paths = new Set<string>();
  let reading = false;
  window.addEventListener(
    'drop',
    (event: DragEvent): void => {
      if (!event.isTrusted || reading) return;
      paths.clear();
      for (const file of Array.from(event.dataTransfer?.files ?? [])) {
        const path = webUtils.getPathForFile(file);
        if (path) paths.add(path);
      }
    },
    true,
  );
  window.addEventListener('pagehide', (): void => paths.clear());
  return async (
    file: unknown,
    request: AttachmentPickRequest,
  ): Promise<AttachmentPickResult> => {
    const parsed = attachmentPickRequestSchema.safeParse(request);
    const path = file instanceof File && webUtils.getPathForFile(file);
    if (!parsed.success || !path || reading || !paths.delete(path))
      return {
        ok: false,
        error: {
          code: 'invalid_request',
          message: '끌어다 놓은 파일을 다시 확인해 주세요.',
        },
      };
    reading = true;
    try {
      return attachmentPickResultSchema.parse(
        await ipcRenderer.invoke(ATTACHMENT_CHANNELS.drop, {
          path,
          limit: parsed.data.limit,
        }),
      );
    } finally {
      reading = false;
    }
  };
}

// 공개 메서드와 응답 검사는 웹 테스트와 공유하고 Electron 전송만 주입합니다.
const wiki = createWikiBridge(
  (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  createAttachmentDrop(),
);

contextBridge.exposeInMainWorld('wiki', wiki);

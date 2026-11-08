import { pickAttachment, dropAttachment } from '@renderer/platform/attachments';
import { describeNotes } from '../model/attachmentNotes';
import { ATTACHMENT_FULL_MESSAGE } from '../model/attachments';
import type { KnowledgeChatModel } from '../model/useKnowledgeChat';

/** 여러 파일도 같은 초안의 남은 한도를 확인하며 놓은 순서대로 읽는다. */
export async function attachChatFiles(
  model: Pick<KnowledgeChatModel, 'attachmentRoom' | 'addAttachment'>,
  files?: readonly File[],
): Promise<string | null> {
  const notices = new Set<string>();
  for (const source of files ?? [null]) {
    const limit = model.attachmentRoom();
    if (!limit) {
      notices.add(ATTACHMENT_FULL_MESSAGE);
      break;
    }
    const result = source
      ? await dropAttachment(source, { limit })
      : await pickAttachment({ limit });
    if (!result.ok) {
      notices.add(
        source
          ? `${source.name} · ${result.error.message}`
          : result.error.message,
      );
      continue;
    }
    const file = result.data;
    if (!file) continue;
    const added = model.addAttachment({ ...file, kind: 'file' });
    if (added === 'full') {
      notices.add(ATTACHMENT_FULL_MESSAGE);
      break;
    }
    if (added === 'truncated') {
      notices.add(
        file.notes.includes('rows_stopped_at_limit') || !file.truncated
          ? `${file.name} · 앞부분만 담았어요.`
          : `${file.name} · 전체 ${file.totalChars.toLocaleString()}자 중 앞 ${file.text.length.toLocaleString()}자만 담았어요.`,
      );
    }
    const note = describeNotes(file.notes);
    if (note) notices.add(note);
  }
  return Array.from(notices).join(' ') || null;
}

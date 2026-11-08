import { useEffect, useState } from 'react';
import type { AiProvider } from '@contracts/runtime.contract';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { chatRunsApi } from '../api/knowledgeChat.api';

/** 화면·창으로 돌아오면 현재 대화의 로컬 세션만 다시 확인한다. AI를 호출하지 않는다. */
export function useSessionAvailability(
  conversationId: string | undefined,
  provider: AiProvider | undefined,
  messages: number,
  idle: boolean,
): boolean | null {
  const active = useWorkspaceActivity();
  const key =
    active && idle && conversationId && provider && messages
      ? JSON.stringify([conversationId, provider, messages])
      : null;
  const [result, setResult] = useState<{ key: string; value: boolean } | null>(
    null,
  );
  useEffect((): (() => void) | undefined => {
    if (!key || !conversationId || !provider) return;
    let serial = 0;
    async function check(): Promise<void> {
      if (!key || !conversationId || !provider) return;
      const request = ++serial;
      try {
        const value = await chatRunsApi.resumable({
          conversationId,
          provider,
          precedingTurns: messages,
        });
        if (request === serial) setResult({ key, value: value.resumable });
      } catch {
        if (request === serial) setResult(null);
      }
    }
    void check();
    window.addEventListener('focus', check);
    return (): void => {
      serial += 1;
      window.removeEventListener('focus', check);
    };
  }, [key, conversationId, provider, messages]);
  return key && result?.key === key ? result.value : null;
}

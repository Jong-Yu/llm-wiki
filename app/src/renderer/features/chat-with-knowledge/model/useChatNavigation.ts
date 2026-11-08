import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { chatLocationForThread } from './chatNavigation';
import type { ChatLocation } from './chatNavigation';
import type { ChatThread } from './chatState';
import type { KnowledgeChatModel } from './useKnowledgeChat';

type ChatNavigationOptions = {
  model: Pick<
    KnowledgeChatModel,
    'ready' | 'thread' | 'openConversation' | 'selectChat' | 'newChat'
  >;
  location: ChatLocation;
  active: boolean;
  activity: RefObject<boolean>;
  onNavigate: (location: ChatLocation, replace?: boolean) => void;
};
type ChatNavigationState = {
  locationMatches: boolean;
  navigationError: string;
};

/** 주소에서 대화를 선택하고 저장 후 주소를 정규화하며, 늦게 끝난 탐색은 현재 화면을 바꾸지 않습니다. */
export function useChatNavigation({
  model,
  location,
  active,
  activity,
  onNavigate,
}: ChatNavigationOptions): ChatNavigationState {
  const [navigationError, setNavigationError] = useState('');
  const routeSerial = useRef(0);
  const locationMatches = location.conversationId
    ? location.conversationId === model.thread.conversationId &&
      (!location.questionRunId || location.questionRunId === model.thread.runId)
    : location.threadId
      ? location.threadId === model.thread.id
      : !location.document;
  const routeTarget = JSON.stringify([
    location.conversationId,
    location.threadId,
    location.document,
    location.questionRunId,
  ]);
  const applyLocation = useEffectEvent(
    async (serial: number): Promise<void> => {
      let target: ChatThread | null;
      if (location.questionRunId && !location.conversationId) target = null;
      else if (location.conversationId) {
        target =
          location.conversationId === model.thread.conversationId &&
          (!location.questionRunId ||
            location.questionRunId === model.thread.runId)
            ? model.thread
            : await model.openConversation(
                location.conversationId,
                location.questionRunId,
              );
      } else if (location.threadId) {
        target =
          location.threadId === model.thread.id
            ? model.thread
            : model.selectChat(location.threadId);
      } else if (location.document) target = model.newChat(location.document);
      else target = model.thread;
      if (routeSerial.current !== serial || !activity.current) return;
      setNavigationError(
        target
          ? ''
          : '선택한 대화를 열지 못했습니다. 대상이 없거나 이전 실행·저장 결과를 먼저 확인해야 합니다.',
      );
      if (target && !location.conversationId && !location.threadId)
        onNavigate(
          { ...chatLocationForThread(target), panel: location.panel },
          true,
        );
    },
  );
  useEffect((): (() => void) | undefined => {
    if (!model.ready || !active) return;
    const serial = ++routeSerial.current;
    void applyLocation(serial);
    return (): void => {
      routeSerial.current += 1;
    };
  }, [routeTarget, model.ready, active]);
  const normalizeConversation = useEffectEvent((): void => {
    if (
      active &&
      model.thread.conversationId &&
      location.threadId === model.thread.id
    )
      onNavigate(
        {
          ...location,
          ...chatLocationForThread(model.thread),
          threadId: undefined,
        },
        true,
      );
  });
  useEffect((): void => {
    normalizeConversation();
  }, [model.thread.conversationId, location.threadId, active]);
  return { locationMatches, navigationError };
}

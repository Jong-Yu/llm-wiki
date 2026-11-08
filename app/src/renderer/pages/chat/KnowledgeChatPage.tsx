import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { KnowledgeChat } from '@renderer/features/chat-with-knowledge';
import {
  chatLocationSearch,
  readChatLocation,
} from '@renderer/features/chat-with-knowledge';
import type { ChatLocation } from '@renderer/features/chat-with-knowledge';

/** 채팅의 저장 산출물을 새 프리뷰 경로에 연결하고 원문 저장은 해당 화면에 맡깁니다. */
export function KnowledgeChatPage(): JSX.Element {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  return (
    <KnowledgeChat
      location={readChatLocation(params)}
      onNavigate={(location: ChatLocation, replace: boolean = false): void => {
        setParams(chatLocationSearch(location), { replace });
      }}
      onArtifact={(id: string): void => {
        void navigate(
          `/artifact?artifactId=${encodeURIComponent(id)}&mode=edit`,
        );
      }}
    />
  );
}

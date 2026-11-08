import { useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, RefObject } from 'react';
import type { ChatLocation } from '../model/chatNavigation';

type ChatPane = 'history' | 'conversation' | 'evidence';
type ChatLayout = 'wide' | 'medium' | 'narrow';

type ChatPanes = {
  workspace: RefObject<HTMLElement | null>;
  historyPane: RefObject<HTMLElement | null>;
  conversationPane: RefObject<HTMLDivElement | null>;
  evidencePane: RefObject<HTMLElement | null>;
  rememberEvidence: (trigger: string) => void;
  layout: ChatLayout;
  historyVisible: boolean;
  conversationVisible: boolean;
  evidenceVisible: boolean;
  setHistoryOpen: (open: boolean) => void;
  closeEvidence: () => void;
  openEvidence: () => void;
  rememberFocus: (event: FocusEvent<HTMLDivElement>) => void;
};
/** 컨테이너 폭과 주소에 맞게 패널을 배치하고 키보드 초점을 원래 위치에 돌려준다. */
export function useChatPanes(
  location: ChatLocation,
  hasEvidence: boolean,
  navigationError: string,
  onNavigate: (location: ChatLocation, replace?: boolean) => void,
): ChatPanes {
  const workspace = useRef<HTMLElement>(null);
  const historyPane = useRef<HTMLElement>(null);
  const conversationPane = useRef<HTMLDivElement>(null);
  const evidencePane = useRef<HTMLElement>(null);
  const lastConversationFocus = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<ChatPane | null>(null);
  const evidenceTrigger = useRef<string | null>(null);
  const restoreEvidenceTrigger = useRef(false);
  const [layout, setLayout] = useState<ChatLayout>('narrow');
  const [activePane, setActivePane] = useState<ChatPane>('conversation');
  const [historyPreferred, setHistoryPreferred] = useState(true);
  const previousPaneRoute = useRef<{
    answer?: string;
    evidence?: string;
  } | null>(null);
  const showHistory = location.panel === 'history';
  const historyVisible =
    layout === 'wide' ? historyPreferred : activePane === 'history';
  const conversationVisible =
    layout !== 'narrow' ||
    activePane === 'conversation' ||
    (activePane === 'evidence' && (!hasEvidence || !!navigationError));
  const evidenceVisible =
    hasEvidence &&
    !navigationError &&
    (layout === 'wide' ||
      (layout === 'medium' && activePane !== 'history') ||
      activePane === 'evidence');

  useLayoutEffect((): (() => void) | undefined => {
    const element = workspace.current;
    if (!element) return;
    let previous: ChatLayout | undefined;
    /** 너비가 바뀌어도 입력 중인 패널과 선택한 근거를 유지합니다. */
    function measure(): void {
      if (!element) return;
      const width = element.getBoundingClientRect().width;
      const next: ChatLayout =
        width >= 1200 ? 'wide' : width >= 900 ? 'medium' : 'narrow';
      if (previous === next) return;
      previous = next;
      setLayout(next);
      const focused = document.activeElement;
      if (historyPane.current?.contains(focused)) setActivePane('history');
      else if (evidencePane.current?.contains(focused))
        setActivePane('evidence');
      else if (conversationPane.current?.contains(focused))
        setActivePane('conversation');
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);
  useLayoutEffect((): void => {
    const previous = previousPaneRoute.current;
    const changedEvidence =
      !previous ||
      previous.answer !== location.answer ||
      previous.evidence !== location.evidence;
    const requested: ChatPane = showHistory
      ? 'history'
      : location.answer && changedEvidence
        ? 'evidence'
        : 'conversation';
    previousPaneRoute.current = {
      answer: location.answer,
      evidence: location.evidence,
    };
    setActivePane(requested);
    if (showHistory) setHistoryPreferred(true);
    if (previous || requested !== 'conversation')
      pendingFocus.current = requested;
  }, [showHistory, location.answer, location.evidence]);
  useLayoutEffect((): void => {
    const requested = pendingFocus.current;
    const pane =
      requested === 'history'
        ? historyPane.current
        : requested === 'evidence'
          ? evidencePane.current
          : conversationPane.current;
    if (requested && pane && !pane.hidden) {
      pendingFocus.current = null;
      const trigger =
        requested === 'conversation' &&
        restoreEvidenceTrigger.current &&
        evidenceTrigger.current
          ? conversationPane.current?.querySelector(
              `[data-chat-evidence-trigger="${CSS.escape(evidenceTrigger.current)}"]`,
            )
          : null;
      const previous =
        trigger instanceof HTMLElement
          ? trigger
          : requested === 'conversation'
            ? lastConversationFocus.current
            : null;
      if (requested === 'conversation') restoreEvidenceTrigger.current = false;
      if (previous?.isConnected && previous.getClientRects().length > 0)
        previous.focus({ preventScroll: true });
      else pane.focus({ preventScroll: true });
    }
  }, [activePane, historyVisible, conversationVisible, evidenceVisible]);
  /** 목록을 닫아도 질문 초안과 선택한 답변의 근거는 그대로 둡니다. */
  function setHistoryOpen(open: boolean): void {
    setHistoryPreferred(open);
    setActivePane(open ? 'history' : 'conversation');
    pendingFocus.current = open ? 'history' : 'conversation';
    onNavigate({ ...location, panel: open ? 'history' : undefined });
  }
  /** 근거를 열었던 답변의 단추 또는 현재 대화로 초점을 돌려줍니다. */
  function closeEvidence(): void {
    restoreEvidenceTrigger.current = true;
    pendingFocus.current = 'conversation';
    onNavigate({
      ...location,
      panel: undefined,
      answer: undefined,
      evidence: undefined,
    });
  }
  function openEvidence(): void {
    setActivePane('evidence');
    pendingFocus.current = 'evidence';
    onNavigate({ ...location, panel: undefined });
  }
  function rememberFocus(event: FocusEvent<HTMLDivElement>): void {
    if (event.target instanceof HTMLElement)
      lastConversationFocus.current = event.target;
  }
  return {
    workspace,
    historyPane,
    conversationPane,
    evidencePane,
    rememberEvidence: (trigger: string): void => {
      evidenceTrigger.current = trigger;
    },
    layout,
    historyVisible,
    conversationVisible,
    evidenceVisible,
    setHistoryOpen,
    closeEvidence,
    openEvidence,
    rememberFocus,
  };
}

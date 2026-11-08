import type { JSX } from 'react';
import { SessionHistory } from '@renderer/features/browse-ai-sessions';

/** AI 세션 화면에서 들어오는 지난 기록 하위 화면입니다. */
export function SessionHistoryPage(): JSX.Element {
  return <SessionHistory />;
}

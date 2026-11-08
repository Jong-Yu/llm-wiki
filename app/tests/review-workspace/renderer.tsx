import { StrictMode } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, MemoryRouter } from 'react-router';
import { App } from '../../src/renderer/app/App';
import { AppShell } from '../../src/renderer/app/AppShell';
import { AiSessions } from '../../src/renderer/features/browse-ai-sessions/ui/AiSessions';
import { installBridge } from './fixtures';
import '../../src/renderer/shared/theme/tokens.css';

installBridge();

/** 기준 캡처는 현재 앱 프레임과 실제 AI 세션 컴포넌트를 그대로 조합합니다. */
function Fixture(): JSX.Element {
  if (!new URLSearchParams(location.search).has('baseline'))
    return (
      <HashRouter>
        <App />
      </HashRouter>
    );
  return (
    <MemoryRouter initialEntries={['/sessions']}>
      <AppShell>
        <AiSessions
          filter={{ sourceId: null, sourceVersion: null, document: null }}
        />
      </AppShell>
    </MemoryRouter>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root missing');
if (!new URLSearchParams(location.search).has('baseline'))
  location.hash = '/review';
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

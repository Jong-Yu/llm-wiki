import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppProviders } from './app/AppProviders';
import './shared/theme/tokens.css';
import './app/app.scss';

// 최상위 provider와 StrictMode를 한 번 조립해 renderer를 시작합니다.
const root = document.getElementById('root');
if (!root) throw new Error('앱을 표시할 영역이 없습니다.');

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);

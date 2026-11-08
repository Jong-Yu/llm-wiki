import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { App } from './app/App';
import './shared/theme/tokens.css';
import './shared/theme/controls.scss';

// 실제로 사용하는 라우터와 StrictMode만 조립해 renderer를 시작합니다.
const root = document.getElementById('root');
if (!root) throw new Error('앱을 표시할 영역이 없습니다.');

createRoot(root).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);

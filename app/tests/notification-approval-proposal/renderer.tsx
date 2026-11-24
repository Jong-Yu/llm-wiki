import './environment';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import { Preview } from './Preview';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';

const root = document.getElementById('notification-preview');
if (!root) throw new Error('시안의 시작 요소가 없습니다.');
if (!location.hash) location.hash = '/notifications';
createRoot(root).render(
  <HashRouter>
    <ReadQueriesProvider identity="notification-approval-preview">
      <Preview />
    </ReadQueriesProvider>
  </HashRouter>,
);

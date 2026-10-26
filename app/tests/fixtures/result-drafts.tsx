import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { ManageResultDrafts } from '@renderer/features/manage-result-drafts';
import '@renderer/shared/theme/tokens.css';

const root = document.getElementById('root');
if (!root) throw new Error('Fixture root missing');
createRoot(root).render(
  <StrictMode>
    <div
      className="wiki-theme"
      style={{
        height: '100vh',
        width: 'calc(100vw - 148px)',
        marginLeft: '148px',
        boxSizing: 'border-box',
      }}
    >
      <HashRouter>
        <ManageResultDrafts savedResultId={'a'.repeat(32)} />
      </HashRouter>
    </div>
  </StrictMode>,
);

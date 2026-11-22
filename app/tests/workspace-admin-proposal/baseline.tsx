import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { ConnectionSettingsPage } from '@renderer/pages/settings/ConnectionSettingsPage';
import './previewEnvironment';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import './frame.scss';
const root = document.getElementById('workspace-admin-preview');
if (root)
  createRoot(root).render(
    <MemoryRouter initialEntries={['/settings']}>
      <div className="workspace-preview-frame">
        <AppShell>
          <ConnectionSettingsPage />
        </AppShell>
      </div>
    </MemoryRouter>,
  );

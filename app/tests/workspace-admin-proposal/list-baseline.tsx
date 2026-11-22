import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import { TemplateList } from '@renderer/features/manage-templates/ui/TemplateList';
import styles from '@renderer/features/manage-templates/ui/TemplateWorkspace.module.scss';
import type { TemplateSummary } from '@contracts/templates.contract';
import './previewEnvironment';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import './frame.scss';
const items: TemplateSummary[] = ['설계 검토', '기술 리서치', '검증 결과'].map(
  (name: string, index: number): TemplateSummary => ({
    id: `template-${index}`,
    revision: 'a'.repeat(64),
    name,
    filename: `${name}.docx`,
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
    archived: false,
  }),
);
const root = document.getElementById('workspace-admin-preview');
if (root)
  createRoot(root).render(
    <MemoryRouter initialEntries={['/templates']}>
      <div className="workspace-preview-frame">
        <AppShell>
          <section className={styles.root}>
            <TemplateList items={items} onOpen={(): void => {}} />
          </section>
        </AppShell>
      </div>
    </MemoryRouter>,
  );

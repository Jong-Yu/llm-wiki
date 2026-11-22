import type { JSX, RefObject } from 'react';
import { Icon } from '../../src/renderer/shared/ui/Icon';
import sessions from '../../src/renderer/features/browse-ai-sessions/ui/AiSessions.module.scss';
import library from '../../src/renderer/features/browse-document-library/ui/DocumentLibrary.module.scss';
import { templateFileType } from './ReusableTemplateModel';
import styles from './TemplateList.module.scss';
import type { SavedTemplate } from './ReusableTemplateModel';

export type TemplateListProps = {
  templates: SavedTemplate[];
  lastOpenedId: string;
  onOpen: (template: SavedTemplate) => void;
  lastOpenedRef: RefObject<HTMLLIElement | null>;
};

/** 기존 행 배치에서 템플릿 이름과 파일명을 나누고 열기 행동을 표시합니다. */
export function TemplateList({
  templates,
  lastOpenedId,
  onOpen,
  lastOpenedRef,
}: TemplateListProps): JSX.Element {
  return (
    <ul className={sessions.list} aria-label="템플릿 목록">
      {templates.map((template: SavedTemplate): JSX.Element => (
        <li
          key={template.id}
          ref={template.id === lastOpenedId ? lastOpenedRef : undefined}
          tabIndex={template.id === lastOpenedId ? -1 : undefined}
          data-selected={template.id === lastOpenedId}
        >
          <div>
            <h3>
              <span className={sessions.kind}>
                {templateFileType(template.fileName)}
              </span>
              <button
                type="button"
                className={`${library.title} ${sessions.rowTitle}`}
                style={{ minHeight: 'auto' }}
                title={template.name}
                onClick={(): void => onOpen(template)}
              >
                {template.name}
              </button>
            </h3>
          </div>
          <span
            className={`${sessions.rowState} ${styles.fileName}`}
            title={template.fileName}
          >
            {template.fileName}
          </span>
          <div className={sessions.rowActions}>
            <button
              type="button"
              className={`${library.textButton} ${sessions.rowActions}`}
              aria-label={`${template.name} 열기`}
              onClick={(): void => onOpen(template)}
            >
              열기 <Icon name="arrow-right" size={14} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

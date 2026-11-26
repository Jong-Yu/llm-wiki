import { useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentTrash } from '@renderer/features/browse-document-library/ui/DocumentTrash';
import { useDocumentTrash } from '@renderer/features/browse-document-library/model/useDocumentTrash';
import { ReadQueriesProvider } from '@renderer/shared/lib/readQueries';
import type { LibraryScope } from '@renderer/features/browse-document-library/model/documentLibrary.types';
import type { DocumentListItem } from '@contracts/documents.contract';
import type {
  WorkspaceRequest,
  WorkspaceResult,
} from '@contracts/workspace.contract';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';

declare global {
  interface Window {
    fixture: {
      scope: LibraryScope;
      alternateScope: LibraryScope;
      items: DocumentListItem[];
    };
    executeFixture: (request: WorkspaceRequest) => Promise<WorkspaceResult>;
    mode: 'normal' | 'conflict' | 'unknown' | 'delayed' | 'access-unavailable';
    releaseDelayed: (() => void) | undefined;
    delayedSettled: boolean;
    writes: number;
  }
}
window.mode = 'normal';
window.writes = 0;
window.delayedSettled = false;
Object.defineProperty(window, 'wiki', {
  value: {
    workspace: {
      execute: async (request: WorkspaceRequest): Promise<WorkspaceResult> => {
        if (
          window.mode === 'access-unavailable' &&
          request.operation === 'documentTrash'
        )
          return {
            ok: false,
            error: {
              code: 'access_unavailable',
              message: '접근 상태를 확인하지 못했습니다.',
            },
          };
        const mutation = [
          'trashDocument',
          'trashSource',
          'restoreTrashedDocument',
          'restoreTrashedSource',
        ].includes(request.operation);
        if (mutation) window.writes += 1;
        const delayed = mutation && window.mode === 'delayed';
        if (delayed)
          await new Promise<void>((resolve: () => void): void => {
            window.releaseDelayed = resolve;
          });
        if (window.mode === 'conflict' && request.operation === 'trashDocument')
          return window.executeFixture({
            ...request,
            input: { ...request.input, expected_revision: '0'.repeat(64) },
          });
        const result = await window.executeFixture(request);
        if (delayed) window.delayedSettled = true;
        return mutation && window.mode === 'unknown' && result.ok
          ? {
              ok: false,
              error: { code: 'outcome_unknown', message: '응답 유실 모의' },
            }
          : result;
      },
    },
  },
});

/** 실제 휴지통 hook·컴포넌트를 실제 격리 API와 연결한 최소 화면입니다. */
function Harness(): JSX.Element {
  const [scope, setScope] = useState(window.fixture.scope);
  const [changes, setChanges] = useState(0);
  const [showItems, setShowItems] = useState(false);
  const model = useDocumentTrash(
    scope,
    (): void => setChanges((value: number): number => value + 1),
    showItems,
  );
  return (
    <main style={{ padding: 16, maxWidth: 900, margin: 'auto' }}>
      <h1>문서 휴지통 격리 검증</h1>
      <p>제품 컴포넌트 · 새 시험 자료만 사용</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {window.fixture.items.map((item: DocumentListItem): JSX.Element => (
          <button
            key={item.kind}
            disabled={model.busy}
            onClick={(): void => model.choose(item)}
          >
            {item.kind === 'wiki' ? 'Wiki 삭제' : '원본 삭제'}
          </button>
        ))}
        <button onClick={(): void => setShowItems(!showItems)}>
          휴지통 열기
        </button>
        <button onClick={(): void => setScope(window.fixture.alternateScope)}>
          범위 변경
        </button>
      </div>
      <output data-testid="changes">{changes}</output>
      <DocumentTrash model={model} showItems={showItems} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <ReadQueriesProvider identity="trash-fixture">
    <Harness />
  </ReadQueriesProvider>,
);

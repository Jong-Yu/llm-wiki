import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import type { DocumentTask } from '@contracts/documentTasks.contract';
import {
  useImportScope,
  importScopeKey,
  listSourceProcessingSessions,
} from '@renderer/features/import-document-content';
import type { ImportScope } from '@renderer/features/import-document-content';
import {
  buildDocumentTaskView,
  documentTaskNeedsAttention,
} from '@renderer/features/browse-document-tasks';
import { documentTaskApi } from '@renderer/features/browse-document-tasks';
import { documentTaskScope } from './documentTaskScope';

type ActivityProps = { scope: ImportScope };

/** 상태바는 읽음 여부와 관계없이 진행·조치 필요 작업을 계속 찾게 합니다. */
function Activity({ scope }: ActivityProps): JSX.Element {
  const [tasks, setTasks] = useState<readonly DocumentTask[]>([]);
  useEffect((): (() => void) => {
    let mounted = true;
    let pending = false;
    const load = async (): Promise<void> => {
      if (pending) return;
      pending = true;
      try {
        const result = await documentTaskApi.list(documentTaskScope(scope));
        if (mounted) setTasks(result.ok ? result.data.items : []);
      } catch {
        if (mounted) setTasks([]);
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = window.setInterval((): void => {
      void load();
    }, 3000);
    return (): void => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [scope]);
  const sessions = listSourceProcessingSessions(scope);
  const views = tasks.map(
    (task: DocumentTask): ReturnType<typeof buildDocumentTaskView> =>
      buildDocumentTaskView(task, {
        processing: sessions
          .find(
            (entry: (typeof sessions)[number]): boolean =>
              entry.session.getSnapshot().taskId === task.taskId,
          )
          ?.session.getSnapshot(),
      }),
  );
  const running = views.filter(
    (view: ReturnType<typeof buildDocumentTaskView>): boolean =>
      view.state === 'running',
  ).length;
  const attention = views.filter(documentTaskNeedsAttention).length;
  return (
    <Link to="/tasks" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
      작업{running ? ` · 진행 ${running}` : ''}
      {attention ? ` · 조치 필요 ${attention}` : ''} ›
    </Link>
  );
}

/** 연결 변경 때 이전 범위의 작업 수를 즉시 숨깁니다. */
export function DocumentTaskActivity(): JSX.Element {
  const model = useImportScope();
  return model.state.status === 'ready' ? (
    <Activity
      key={importScopeKey(model.state.scope)}
      scope={model.state.scope}
    />
  ) : (
    <Link to="/tasks">작업 ›</Link>
  );
}

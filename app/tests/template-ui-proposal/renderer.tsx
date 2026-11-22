import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, useLocation } from 'react-router';
import { AppShell } from '@renderer/app/AppShell';
import './previewEnvironment';
import { Prototype, readPrototypeSnapshot } from './Prototype';
import type { PrototypeSnapshot } from './Prototype';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import styles from './Preview.module.scss';

type View = 'chat' | 'register' | 'manage' | 'questions' | 'result';
type WidgetState = { modelContent?: unknown; privateContent?: unknown };
type PreviewHost = {
  widgetState?: WidgetState;
  setWidgetState?: (state: WidgetState) => Promise<void>;
};

/** 호스트 객체는 선택 속성의 자료형을 확인한 뒤에만 사용합니다. */
function readHost(value: unknown): PreviewHost | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const saved: unknown = 'widgetState' in value ? value.widgetState : undefined;
  const setter: unknown =
    'setWidgetState' in value ? value.setWidgetState : undefined;
  const widgetState =
    typeof saved === 'object' && saved !== null
      ? {
          modelContent:
            'modelContent' in saved ? saved.modelContent : undefined,
          privateContent:
            'privateContent' in saved ? saved.privateContent : undefined,
        }
      : undefined;
  return {
    widgetState,
    setWidgetState:
      typeof setter === 'function'
        ? async (state: WidgetState): Promise<void> => {
            await setter.call(value, state);
          }
        : undefined,
  };
}

/** 외부 이벤트의 중첩 경로를 자료형 우회 없이 좁힙니다. */
function restoredView(detail: unknown): unknown {
  if (typeof detail !== 'object' || detail === null || !('globals' in detail))
    return null;
  const globals = detail.globals;
  if (
    typeof globals !== 'object' ||
    globals === null ||
    !('widgetState' in globals)
  )
    return null;
  const state = globals.widgetState;
  return typeof state === 'object' &&
    state !== null &&
    'privateContent' in state
    ? state.privateContent
    : null;
}

/** 외부 호스트의 상태는 검증한 화면 선택만 복원합니다. */
function isView(value: unknown): value is View {
  return ['chat', 'register', 'manage', 'questions', 'result'].some(
    (candidate: string): boolean => candidate === value,
  );
}

/** 기존 메뉴를 그대로 유지하고 시안 범위 밖 경로에서는 명시적으로 복귀시킵니다. */
type PreviewContentProps = {
  view: View;
  snapshot?: PrototypeSnapshot;
  generation: number;
};
function PreviewContent({
  view,
  snapshot,
  generation,
}: PreviewContentProps): JSX.Element {
  const location = useLocation();
  return (
    <>
      <div hidden={location.pathname !== '/chat'}>
        <Prototype
          key={generation}
          initialView={view}
          initialSnapshot={snapshot}
        />
      </div>
      {location.pathname !== '/chat' && (
        <div className={styles.outside}>
          <p>이 시안에서는 템플릿 등록과 채팅 흐름을 살펴볼 수 있습니다.</p>
          <Link to="/chat">작성하던 대화로 돌아가기</Link>
        </div>
      )}
    </>
  );
}

/** 호스트가 있는 경우에만 화면 선택과 의미 있는 조작 상태를 기억합니다. */
function Preview(): JSX.Element {
  const [host] = useState((): PreviewHost | undefined =>
    readHost(Reflect.get(window, 'openai')),
  );
  const [view] = useState<View>((): View => {
    const query = new URLSearchParams(location.search).get('view');
    return isView(query) ? query : 'chat';
  });
  const [restored, setRestored] = useState<{
    snapshot?: PrototypeSnapshot;
    generation: number;
  }>((): { snapshot?: PrototypeSnapshot; generation: number } => ({
    snapshot: new URLSearchParams(location.search).has('view')
      ? undefined
      : readPrototypeSnapshot(host?.widgetState?.privateContent),
    generation: 0,
  }));
  const lastSent = useRef('');
  useEffect((): (() => void) => {
    const restore = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const snapshot = readPrototypeSnapshot(restoredView(event.detail));
      if (snapshot && JSON.stringify(snapshot) !== lastSent.current) {
        lastSent.current = JSON.stringify(snapshot);
        setRestored(
          (previous: {
            snapshot?: PrototypeSnapshot;
            generation: number;
          }): { snapshot: PrototypeSnapshot; generation: number } => ({
            snapshot,
            generation: previous.generation + 1,
          }),
        );
      }
    };
    const remember = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const state = readPrototypeSnapshot(event.detail);
      if (!state) return;
      lastSent.current = JSON.stringify(state);
      host
        ?.setWidgetState?.({
          modelContent: {
            view: state.surface,
            phase: state.phase,
            exampleTemplate: state.selectedId === 'screen-spec',
            policy: state.resultPolicy,
            width: state.resultWidth,
            corrected: state.corrected,
          },
          privateContent: state,
        })
        .catch((): void => {});
    };
    window.addEventListener('openai:set_globals', restore);
    window.addEventListener('template-proposal-state', remember);
    return (): void => {
      window.removeEventListener('openai:set_globals', restore);
      window.removeEventListener('template-proposal-state', remember);
    };
  }, [host]);
  return (
    <div className={styles.preview}>
      <div className={styles.label}>
        <strong>템플릿 등록·사용 시안</strong>
        <span>Nori 예시 · 저장·AI 미연결</span>
      </div>
      <div className={styles.shellFrame}>
        <MemoryRouter initialEntries={['/chat']}>
          <AppShell>
            <PreviewContent
              view={view}
              snapshot={restored.snapshot}
              generation={restored.generation}
            />
          </AppShell>
        </MemoryRouter>
      </div>
    </div>
  );
}

const root = document.getElementById('template-workflow-preview');
if (!root) throw new Error('시안 표시 영역이 없습니다.');
createRoot(root).render(<Preview />);

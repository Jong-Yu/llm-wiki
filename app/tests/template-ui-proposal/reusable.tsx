import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router';
import { useRouteTitle } from '@renderer/shared/lib/routeTitle';
import { WorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { AppShell } from '@renderer/app/AppShell';
import { TemplateLibraryScreen } from './TemplateLibraryScreen';
import { TemplateChatScreen } from './TemplateChatScreen';
import { reusableTemplates } from './ReusableTemplateModel';
import type {
  ReusableScreen,
  SavedTemplate,
  TemplateDraft,
} from './ReusableTemplateModel';
import './previewEnvironment';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import preview from './Preview.module.scss';
import styles from './ReusableTemplate.module.scss';

type WorkspaceProps = { initialScreen: ReusableScreen; initialEdit?: boolean };
type Remembered = { screen: ReusableScreen; selectedId: string };
type ContentProps = { initialState: Remembered; initialEdit: boolean };
type Selections = Record<ReusableScreen, string>;

/** 템플릿 관리와 산출물을 요청하는 채팅의 주소를 분리합니다. */
function screenPath(screen: ReusableScreen): string {
  return screen === 'manage' ? '/templates' : '/chat';
}
/** 메뉴의 실제 주소로 현재 과업을 결정합니다. */
function pathScreen(path: string): ReusableScreen | undefined {
  if (path === '/templates') return 'manage';
  if (path === '/chat') return 'chat';
  return undefined;
}

/** 호스트에서는 화면과 공개된 예시 템플릿의 선택만 복원합니다. */
function readRemembered(value: unknown, fallback: ReusableScreen): Remembered {
  const defaultState = { screen: fallback, selectedId: 'screen' };
  if (typeof value !== 'object' || value === null) return defaultState;
  const screen =
    'screen' in value && (value.screen === 'manage' || value.screen === 'chat')
      ? value.screen
      : fallback;
  const id = 'selectedId' in value ? value.selectedId : undefined;
  return {
    screen,
    selectedId:
      (id === '' ||
        reusableTemplates.some(
          (template: SavedTemplate): boolean => template.id === id,
        )) &&
      typeof id === 'string'
        ? id
        : 'screen',
  };
}

/** 호스트에는 화면 선택만 기록하며 업로드 파일명·작성 룰·요청은 보내지 않습니다. */
function remember(screen: ReusableScreen, selectedId: string): void {
  const host: unknown = Reflect.get(window, 'openai');
  if (
    typeof host !== 'object' ||
    host === null ||
    !('setWidgetState' in host) ||
    typeof host.setWidgetState !== 'function'
  )
    return;
  const saved = {
    screen,
    selectedId:
      selectedId === '' ||
      reusableTemplates.some(
        (template: SavedTemplate): boolean => template.id === selectedId,
      )
        ? selectedId
        : 'custom',
  };
  Promise.resolve(
    host.setWidgetState({ modelContent: saved, privateContent: saved }),
  ).catch((): void => {});
}

/** 등록한 양식과 룰을 같은 시안 안에서 작성 화면에 연결합니다. */
function ReusableWorkspace({
  initialState,
  initialEdit,
}: ContentProps): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const screen = pathScreen(location.pathname);
  const previousPath = useRef(location.pathname);
  const [libraryTitle, setLibraryTitle] = useState(
    initialEdit
      ? (reusableTemplates.find(
          (item: SavedTemplate): boolean => item.id === initialState.selectedId,
        )?.name ?? '템플릿')
      : '템플릿',
  );
  const listRequest =
    location.pathname === '/templates' &&
    new URLSearchParams(location.search).get('view') === 'list'
      ? location.key
      : '';
  useRouteTitle('template-preview', libraryTitle);
  const onLibraryView = useCallback(
    (_view: 'list' | 'detail' | 'edit' | 'new', title: string): void => {
      setLibraryTitle(title);
    },
    [],
  );
  useEffect((): void => {
    if (listRequest) void navigate('/templates', { replace: true });
  }, [listRequest, navigate]);
  const [templates, setTemplates] =
    useState<SavedTemplate[]>(reusableTemplates);
  const [selected, setSelected] = useState<Selections>({
    manage: initialState.selectedId,
    chat: initialState.selectedId,
  });
  useEffect((): void => {
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    if (screen) remember(screen, selected[screen]);
  }, [location.pathname, screen, selected]);
  useEffect((): (() => void) => {
    const restore = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (
        typeof detail !== 'object' ||
        detail === null ||
        !('globals' in detail)
      )
        return;
      const globals = detail.globals;
      if (
        typeof globals !== 'object' ||
        globals === null ||
        !('widgetState' in globals)
      )
        return;
      const value = globals.widgetState;
      if (
        typeof value !== 'object' ||
        value === null ||
        !('privateContent' in value)
      )
        return;
      const next = readRemembered(value.privateContent, initialState.screen);
      void navigate(screenPath(next.screen));
      // 파일과 룰을 복원할 수 없는 사용자 템플릿을 예시 양식으로 대체하지 않습니다.
      setSelected((previous: Selections): Selections => ({
        ...previous,
        [next.screen]: previous[next.screen].startsWith('custom-')
          ? previous[next.screen]
          : next.selectedId,
      }));
    };
    window.addEventListener('openai:set_globals', restore);
    return (): void =>
      window.removeEventListener('openai:set_globals', restore);
  }, [initialState.screen, navigate]);
  /** 목록의 선택만 변경하며 생성·저장은 시작하지 않습니다. */
  function select(target: ReusableScreen, id: string): void {
    setSelected((previous: Selections): Selections => ({
      ...previous,
      [target]: id,
    }));
    remember(target, id);
  }
  /** 저장은 메모리 안에서 수행하고 같은 템플릿을 즉시 선택 가능하게 합니다. */
  function save(id: string | null, draft: TemplateDraft): void {
    const saved = { ...draft, id: id ?? `custom-${Date.now()}` };
    setTemplates((previous: SavedTemplate[]): SavedTemplate[] =>
      id
        ? previous.map((template: SavedTemplate): SavedTemplate =>
            template.id === id ? saved : template,
          )
        : [...previous, saved],
    );
    setSelected((previous: Selections): Selections => ({
      ...previous,
      manage: saved.id,
    }));
    remember('manage', saved.id);
  }
  /** 선택한 템플릿과 저장된 룰을 작성 화면에 함께 전달합니다. */
  function useTemplate(id: string): void {
    setSelected((previous: Selections): Selections => ({
      ...previous,
      chat: id,
    }));
    void navigate('/chat');
    remember('chat', id);
  }
  return (
    <>
      <div hidden={!screen} className={styles.workspace}>
        <div hidden={screen !== 'manage'} data-workspace-route="/templates">
          <WorkspaceActivity active={screen === 'manage'}>
            <TemplateLibraryScreen
              templates={templates}
              selectedId={selected.manage}
              onSelect={(id: string): void => select('manage', id)}
              onSave={save}
              onUse={useTemplate}
              onViewChange={onLibraryView}
              listRequest={listRequest}
              initialEdit={initialEdit}
            />
          </WorkspaceActivity>
        </div>
        <div hidden={screen !== 'chat'} data-workspace-route="/chat">
          <WorkspaceActivity active={screen === 'chat'}>
            <TemplateChatScreen
              templates={templates}
              selectedId={selected.chat}
              onSelect={(id: string): void => select('chat', id)}
            />
          </WorkspaceActivity>
        </div>
      </div>
      {!screen && (
        <div className={preview.outside}>
          <p>템플릿 등록과 산출물 작성을 살펴보는 시안입니다.</p>
          <Link to="/templates">템플릿으로 돌아가기</Link>
        </div>
      )}
    </>
  );
}

/** 실제 앱 틀에서 두 진입 화면을 각각 미리 볼 수 있게 합니다. */
function ReusablePreview({
  initialScreen,
  initialEdit = false,
}: WorkspaceProps): JSX.Element {
  const [initialState] = useState<Remembered>((): Remembered => {
    const host: unknown = Reflect.get(window, 'openai');
    const state: unknown =
      typeof host === 'object' && host !== null && 'widgetState' in host
        ? host.widgetState
        : undefined;
    const remembered = readRemembered(
      typeof state === 'object' && state !== null && 'privateContent' in state
        ? state.privateContent
        : undefined,
      initialScreen,
    );
    return initialEdit ? { ...remembered, screen: 'manage' } : remembered;
  });
  return (
    <div className={styles.preview}>
      <div className={styles.frame}>
        <MemoryRouter initialEntries={[screenPath(initialState.screen)]}>
          <AppShell>
            <ReusableWorkspace
              initialState={initialState}
              initialEdit={initialEdit}
            />
          </AppShell>
        </MemoryRouter>
      </div>
    </div>
  );
}

const root = document.getElementById('reusable-template-preview');
if (!root) throw new Error('시안 표시 영역이 없습니다.');
createRoot(root).render(
  <ReusablePreview
    initialEdit={root.dataset.view === 'edit'}
    initialScreen={
      root.dataset.screen === 'chat' || root.dataset.screen === 'compose'
        ? 'chat'
        : 'manage'
    }
  />,
);

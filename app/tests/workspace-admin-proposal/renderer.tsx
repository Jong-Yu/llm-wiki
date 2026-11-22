import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent, JSX, ReactNode, SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { Tabs } from '@renderer/shared/ui/Tabs';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  useThemePreference,
  useResolvedTheme,
} from '@renderer/shared/theme/useThemePreference';
import listStyles from '@renderer/features/manage-templates/ui/TemplateWorkspace.module.scss';
import '@renderer/shared/theme/tokens.css';
import '@renderer/shared/theme/controls.scss';
import { AdminShell } from './AdminShell';
import type { Crumb } from './AdminShell';
import { EntityBrowser, IconAction } from './controls';
import { CreateForm, WorkspaceForm, PermissionForm } from './Forms';
import type { Creation } from './Forms';
import { EntryScreens } from './EntryScreens';
import type { AdminAuthError, EntryScreen } from './EntryScreens';
import {
  emptySearch,
  makeData,
  personEntity,
  workspaceEntity,
  permissionSummary,
  timeLabel,
  permissionDiff,
  permissionLabels,
} from './model';
import type {
  AdminEvent,
  Data,
  Entity,
  Permission,
  SearchState,
  Workspace,
  Person,
  Member,
} from './model';
import styles from './Proposal.module.scss';
import { AssignmentFlow } from './AssignmentFlow';
import type {
  AssignmentAttempt,
  AssignmentTarget,
  AssignmentDraft,
  AssignmentNavigation,
} from './AssignmentFlow';
const snapshotSchema = z.object({
  version: z.literal(6),
  path: z
    .string()
    .regex(
      /^(?:\/admin(?:\/[^?#]*)?(?:\?[^#]*)?|\/login|\/settings(?:\?[^#]*)?|\/waiting)$/,
    )
    .max(500),
  stress: z.boolean(),
  origin: z.enum(['login', 'waiting', 'settings']).default('login'),
  trail: z.array(z.string().max(500)).max(12).default([]),
  membership: z.enum(['all', 'none', 'any']).default('all'),
  filters: z
    .record(
      z.string().max(80),
      z.object({
        workspace: z.string().max(80),
        user: z.string().max(80),
        page: z.number().int().min(0).max(10000),
      }),
    )
    .default({}),
  searches: z.record(
    z.string().max(80),
    z.object({
      query: z.string().max(200),
      page: z.number().int().min(0).max(10000),
      focusId: z.string().max(100).optional(),
    }),
  ),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Host = {
  widgetState?: { privateContent?: unknown };
  setWidgetState?: (value: unknown) => Promise<void>;
};
/** 전 버전의 목록·상세 상태는 복원하지 않습니다. */
function host(): Host | undefined {
  const value: unknown = Reflect.get(window, 'openai');
  if (typeof value !== 'object' || value === null) return undefined;
  const state: unknown = 'widgetState' in value ? value.widgetState : undefined;
  const setter: unknown =
    'setWidgetState' in value ? value.setWidgetState : undefined;
  return {
    widgetState:
      typeof state === 'object' && state !== null
        ? {
            privateContent:
              'privateContent' in state ? state.privateContent : undefined,
          }
        : undefined,
    setWidgetState:
      typeof setter === 'function'
        ? async (next: unknown): Promise<void> => {
            await setter.call(value, next);
          }
        : undefined,
  };
}
function savedState(): Snapshot | undefined {
  const result = snapshotSchema.safeParse(host()?.widgetState?.privateContent);
  return result.success ? result.data : undefined;
}
const restored = savedState();
function workspacePath(id: string, tab = 'members'): string {
  return `/admin/workspace?id=${encodeURIComponent(id)}&tab=${tab}`;
}
function userPath(id: string, tab = 'members'): string {
  return `/admin/user?id=${encodeURIComponent(id)}${tab === 'history' ? '&tab=history' : ''}`;
}
function editPath(
  workspace: string,
  user: string,
  origin = 'workspace',
): string {
  return `/admin/permissions?workspace=${encodeURIComponent(workspace)}&user=${encodeURIComponent(user)}&origin=${origin}`;
}

type HistoryFilter = { workspace: string; user: string; page: number };
type Notice = { text: string; workspaceId?: string; userId?: string };
const emptyFilter: HistoryFilter = { workspace: '', user: '', page: 0 };
/** 이전 주소 별칭은 알려진 관리 화면으로만 정규화합니다. */
function canonical(raw: string): string {
  const url = new URL(raw, 'https://preview.invalid');
  if (url.pathname === '/admin/events' || url.pathname === '/admin/history')
    return '/admin/workspaces';
  if (
    url.pathname === '/admin/history/filter' &&
    (!url.searchParams.get('scope') ||
      url.searchParams.get('scope') === 'global')
  )
    return '/admin/workspaces';
  if (
    url.pathname === '/admin/workspace' &&
    url.searchParams.get('tab') === 'general'
  )
    url.searchParams.set('tab', 'members');
  return [
    '/login',
    '/settings',
    '/waiting',
    '/admin',
    '/admin/workspaces',
    '/admin/users',
    '/admin/user',
    '/admin/assign',
    '/admin/workspace',
    '/admin/workspace/new',
    '/admin/workspace/edit',
    '/admin/permissions',
    '/admin/member/remove',
    '/admin/members/add',
    '/admin/history/filter',
  ].includes(url.pathname)
    ? url.pathname + url.search
    : '/admin/workspaces';
}
type EntryOrigin = Exclude<EntryScreen, 'auth'>;
type PreviewSession = { serverUrl: string; expiresAt: number };
type FormDraft = {
  name?: string;
  creation?: Creation;
  permissions?: Permission[];
};
const defaultServer = 'https://wiki.example.com';
/** 실제 과업별 페이지를 한 번에 하나만 보여주며 출발 위치로 복귀합니다. */
function Proposal(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [stress, setStress] = useState(restored?.stress ?? false);
  const [data, setData] = useState<Data>((): Data =>
    makeData(restored?.stress ?? false),
  );
  const [searches, setSearches] = useState<Record<string, SearchState>>(
    restored?.searches ?? {},
  );
  const [trail, setTrail] = useState<string[]>(
    restored?.trail.map(canonical) ?? [],
  );
  const [membership, setMembership] = useState<'all' | 'none' | 'any'>(
    restored?.membership ?? 'all',
  );
  const [filters, setFilters] = useState<Record<string, HistoryFilter>>(
    restored?.filters ?? {},
  );
  const [mode, setMode] = useState('normal');
  const [entryOrigin, setEntryOrigin] = useState<EntryOrigin>(
    restored?.origin ?? 'login',
  );
  const [ordinaryAccount, setOrdinaryAccount] = useState({
    name: '김민서',
    serverUrl: defaultServer,
  });
  const [adminServer, setAdminServer] = useState(defaultServer);
  const [authError, setAuthError] = useState<AdminAuthError>(null);
  const [session, setSession] = useState<PreviewSession | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  const authGeneration = useRef(0);
  const scopeServer = useRef<string | null>(null);
  const authReturn = useRef(
    restored?.path.startsWith('/admin/')
      ? canonical(restored.path)
      : '/admin/workspaces',
  );
  const [formDrafts, setFormDrafts] = useState<Record<string, FormDraft>>({});
  const restoreEntryFocus = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [attempts, setAttempts] = useState<AssignmentAttempt[]>([]);
  const [receipts, setReceipts] = useState<string[]>([]);
  const [assignmentDrafts, setAssignmentDrafts] = useState<
    Record<string, AssignmentDraft>
  >({});
  const assignmentNavigation = useRef<AssignmentNavigation>(null);
  const [sentSnapshot, setSentSnapshot] = useState('');
  const first = useRef(true);
  const restoring = useRef<string | null>(null);
  const { setPreference } = useThemePreference();
  const theme = useResolvedTheme();
  const path = location.pathname;
  const fullPath = path + location.search;
  const latestPath = useRef(fullPath);
  useLayoutEffect((): void => {
    latestPath.current = fullPath;
  }, [fullPath]);
  const isAdminPath = path === '/admin' || path.startsWith('/admin/');
  const authenticated = session !== null;
  const showConsole = isAdminPath && path !== '/admin' && authenticated;
  const entryScreen: EntryScreen =
    path === '/waiting'
      ? 'waiting'
      : path === '/settings'
        ? 'settings'
        : isAdminPath
          ? 'auth'
          : 'login';
  useEffect((): (() => void) | undefined => {
    if (!restoreEntryFocus.current || isAdminPath) return;
    const frame = window.requestAnimationFrame((): void => {
      document.querySelector<HTMLButtonElement>('[data-admin-entry]')?.focus();
      restoreEntryFocus.current = false;
    });
    return (): void => window.cancelAnimationFrame(frame);
  }, [fullPath, isAdminPath]);
  const query = new URLSearchParams(location.search);
  const rememberAssignment = useCallback(
    (draft: AssignmentDraft): void =>
      setAssignmentDrafts(
        (
          old: Record<string, AssignmentDraft>,
        ): Record<string, AssignmentDraft> => ({ ...old, [fullPath]: draft }),
      ),
    [fullPath],
  );
  const rememberName = useCallback(
    (name: string): void => {
      setFormDrafts(
        (old: Record<string, FormDraft>): Record<string, FormDraft> =>
          old[fullPath]?.name === name ? old : { ...old, [fullPath]: { name } },
      );
    },
    [fullPath],
  );
  const rememberCreation = useCallback(
    (creation: Creation): void => {
      setFormDrafts(
        (old: Record<string, FormDraft>): Record<string, FormDraft> =>
          old[fullPath]?.creation?.name === creation.name &&
          old[fullPath]?.creation?.id === creation.id
            ? old
            : { ...old, [fullPath]: { creation } },
      );
    },
    [fullPath],
  );
  const rememberPermissions = useCallback(
    (permissions: Permission[]): void => {
      setFormDrafts(
        (old: Record<string, FormDraft>): Record<string, FormDraft> =>
          old[fullPath]?.permissions?.join('|') === permissions.join('|')
            ? old
            : { ...old, [fullPath]: { permissions } },
      );
    },
    [fullPath],
  );
  function discardFormDraft(): void {
    setFormDrafts(
      (old: Record<string, FormDraft>): Record<string, FormDraft> => {
        const next = { ...old };
        delete next[fullPath];
        return next;
      },
    );
  }
  const workspaceId = query.get('workspace') ?? query.get('id') ?? '';
  const userId = query.get('user') ?? query.get('id') ?? '';
  const workspace = data.workspaces.find(
    (w: Workspace): boolean => w.id === workspaceId,
  );
  const person = data.people.find((p: Person): boolean => p.id === userId);
  // 관리 세션은 시안 메모리에만 두며 복원된 주소 자체는 인증으로 인정하지 않습니다.
  const expireSession = useCallback(
    (reason: AdminAuthError = 'expired'): void => {
      if (latestPath.current.startsWith('/admin/'))
        authReturn.current = latestPath.current;
      authGeneration.current += 1;
      sessionRef.current = null;
      setSession(null);
      setAuthError(reason);
      void navigate('/admin');
    },
    [navigate],
  );
  useEffect((): (() => void) | undefined => {
    if (!session) return;
    const check = (): void => {
      if (Date.now() >= session.expiresAt) expireSession();
    };
    const timer = window.setTimeout(
      check,
      Math.max(0, session.expiresAt - Date.now()),
    );
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return (): void => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [session, expireSession]);
  useEffect(
    (): (() => void) => (): void => {
      authGeneration.current += 1;
    },
    [],
  );
  /** 활동과 무관한 만료와 인증 범위를 저장 직전에도 확인합니다. */
  function canManage(): boolean {
    const current = sessionRef.current;
    if (current && current !== session) return false;
    if (current && current.expiresAt > Date.now()) return true;
    expireSession();
    return false;
  }
  function guardManagement(event: SyntheticEvent): void {
    if (canManage()) return;
    event.preventDefault();
    event.stopPropagation();
  }
  function clearManagementScope(): void {
    setData(makeData(stress));
    setSearches({});
    setFilters({});
    setTrail([]);
    setAttempts([]);
    setReceipts([]);
    setAssignmentDrafts({});
    setFormDrafts({});
    setNotice(null);
  }
  /** 진입 화면과 일반 연결을 보존한 채 별도 관리 인증으로 이동합니다. */
  function enterAdmin(serverUrl: string): void {
    authGeneration.current += 1;
    const origin = entryScreen === 'auth' ? entryOrigin : entryScreen;
    setEntryOrigin(origin);
    setAdminServer(serverUrl);
    setAuthError(null);
    authReturn.current = '/admin/workspaces';
    sessionRef.current = null;
    setSession(null);
    setTrail([]);
    void navigate('/admin');
  }
  function leaveAdmin(): void {
    authGeneration.current += 1;
    sessionRef.current = null;
    setSession(null);
    setAuthError(null);
    authReturn.current = '/admin/workspaces';
    setTrail([]);
    setNotice(null);
    setAssignmentDrafts({});
    setFormDrafts({});
    restoreEntryFocus.current = true;
    void navigate(`/${entryOrigin}`);
  }
  /** 공개 시안 키만 검사합니다. 실제 키·네트워크·인증 토큰은 사용하지 않습니다. */
  async function authenticateAdmin(
    serverUrl: string,
    key: string,
  ): Promise<AdminAuthError> {
    const generation = ++authGeneration.current;
    const accepted = key === 'demo-admin';
    key = '';
    setAuthError(null);
    await new Promise<void>((resolve: () => void): number =>
      window.setTimeout(resolve, 450),
    );
    if (generation !== authGeneration.current) return 'invalid';
    const error: AdminAuthError =
      mode === 'offline'
        ? 'offline'
        : mode === 'unconfigured'
          ? 'unconfigured'
          : mode === 'denied'
            ? 'denied'
            : !accepted
              ? 'invalid'
              : null;
    if (error) {
      setAuthError(error);
      return error;
    }
    const normalized = serverUrl.replace(/\/+$/, '');
    let destination = authReturn.current;
    if (scopeServer.current && scopeServer.current !== normalized) {
      clearManagementScope();
      destination = '/admin/workspaces';
    }
    scopeServer.current = normalized;
    setAdminServer(normalized);
    const next = {
      serverUrl: normalized,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
    sessionRef.current = next;
    setSession(next);
    setMode('normal');
    void navigate(destination);
    return null;
  }
  function chooseEntry(next: EntryOrigin): void {
    authGeneration.current += 1;
    sessionRef.current = null;
    setSession(null);
    setAuthError(null);
    setEntryOrigin(next);
    setTrail([]);
    void navigate(`/${next}`);
  }
  const persistRoute = useEffectEvent((): void => persist(fullPath));
  useEffect((): void => {
    Object.defineProperty(window, '__adminProposalTest', {
      configurable: true,
      value: Object.freeze({
        attempts: (): AssignmentAttempt[] => structuredClone(attempts),
      }),
    });
  }, [attempts]);
  function persist(
    nextPath: string,
    nextSearches = searches,
    nextTrail = trail,
    nextStress = stress,
    nextMembership = membership,
    nextFilters = filters,
  ): void {
    const snapshot = {
      version: 6,
      path: canonical(nextPath),
      stress: nextStress,
      origin: entryOrigin,
      searches: nextSearches,
      trail: nextTrail.slice(-12),
      membership: nextMembership,
      filters: nextFilters,
    };
    const content = {
      modelContent: { screen: snapshot.path },
      privateContent: snapshot,
    };
    const safe =
      new TextEncoder().encode(JSON.stringify(content)).byteLength < 16 * 1024
        ? content
        : {
            modelContent: content.modelContent,
            privateContent: {
              ...snapshot,
              searches: {},
              trail: [],
              filters: {},
            },
          };
    setSentSnapshot(JSON.stringify(snapshotSchema.parse(safe.privateContent)));
    void host()
      ?.setWidgetState?.(safe)
      .catch((): void => {});
  }
  function go(next: string, push = true): void {
    const normalized = canonical(next);
    const nextTrail = push ? [...trail, fullPath].slice(-12) : [];
    setTrail(nextTrail);
    setNotice(null);
    persist(normalized, searches, nextTrail);
    void navigate(normalized);
  }
  function back(fallback: string, result?: Notice): void {
    const next = trail.at(-1) ?? fallback;
    const nextTrail = trail.slice(0, -1);
    setTrail(nextTrail);
    setNotice(result ?? null);
    persist(next, searches, nextTrail);
    void navigate(next);
  }
  // 상위 위치 선택은 자식 화면을 이력에 쌓지 않고 해당 조상까지 잘라 냅니다.
  function ancestor(next: string): void {
    const normalized = canonical(next);
    const index = trail.lastIndexOf(normalized);
    const root = normalized.startsWith('/admin/user')
      ? '/admin/users'
      : '/admin/workspaces';
    const rootIndex = trail.lastIndexOf(root);
    const nextTrail =
      index >= 0
        ? trail.slice(0, index)
        : normalized === root
          ? []
          : rootIndex >= 0
            ? trail.slice(0, rootIndex + 1)
            : [root];
    setTrail(nextTrail);
    setNotice(null);
    persist(normalized, searches, nextTrail);
    void navigate(normalized);
  }
  function search(key: string, next: SearchState): void {
    const value = { ...searches, [key]: next };
    setSearches(value);
    persist(fullPath, value);
  }
  function openFrom(key: string, id: string, next: string): void {
    const value = {
      ...searches,
      [key]: { ...(searches[key] ?? emptySearch), focusId: id },
    };
    const nextTrail = [...trail, fullPath].slice(-12);
    setSearches(value);
    setTrail(nextTrail);
    setNotice(null);
    persist(next, value, nextTrail);
    void navigate(next);
  }
  useEffect((): void => {
    if (first.current || restoring.current === fullPath) {
      first.current = false;
      restoring.current = null;
      return;
    }
    restoring.current = null;
    persistRoute();
  }, [fullPath]);
  useEffect((): (() => void) => {
    function receive(event: Event): void {
      if (!(event instanceof CustomEvent)) return;
      const parsed = z
        .object({
          globals: z.object({
            widgetState: z.object({ privateContent: snapshotSchema }),
          }),
        })
        .safeParse(event.detail);
      if (!parsed.success) return;
      const state = parsed.data.globals.widgetState.privateContent;
      if (JSON.stringify(state) === sentSnapshot) return;
      const next = canonical(state.path);
      restoring.current = next;
      if (state.stress !== stress) setData(makeData(state.stress));
      setStress(state.stress);
      setSearches(state.searches);
      setTrail(state.trail.map(canonical));
      setMembership(state.membership);
      setFilters(state.filters);
      setEntryOrigin(state.origin);
      authGeneration.current += 1;
      sessionRef.current = null;
      setSession(null);
      setAuthError(null);
      if (next.startsWith('/admin/')) authReturn.current = next;
      void navigate(next);
    }
    window.addEventListener('openai:set_globals', receive);
    return (): void =>
      window.removeEventListener('openai:set_globals', receive);
  }, [navigate, sentSnapshot, stress]);
  function commitWorkspace(
    next: Workspace,
    event: Omit<AdminEvent, 'id' | 'at' | 'workspaceId'>,
  ): void {
    if (!canManage()) return;
    setData((old: Data): Data => ({
      ...old,
      workspaces: old.workspaces.map((w: Workspace): Workspace =>
        w.id === next.id ? next : w,
      ),
      events: [
        {
          ...event,
          id: crypto.randomUUID(),
          workspaceId: next.id,
          at: new Date().toISOString(),
        },
        ...old.events,
      ],
    }));
  }
  function assign(
    target: AssignmentTarget,
    permissions: Permission[],
    operationId: string,
  ): boolean {
    if (!canManage()) return false;
    if (receipts.includes(operationId)) return true;
    const targetWorkspace = data.workspaces.find(
      (w: Workspace): boolean => w.id === target.workspaceId,
    );
    if (
      !targetWorkspace ||
      targetWorkspace.members.some(
        (m: Member): boolean => m.userId === target.userId,
      )
    )
      return false;
    // 사용자별 PUT를 모의합니다. 이미 소속된 사람의 권한은 바꾸지 않습니다.
    setData((old: Data): Data => {
      const current = old.workspaces.find(
        (w: Workspace): boolean => w.id === target.workspaceId,
      );
      if (
        !current ||
        current.members.some((m: Member): boolean => m.userId === target.userId)
      )
        return old;
      return {
        ...old,
        workspaces: old.workspaces.map((w: Workspace): Workspace =>
          w.id === target.workspaceId
            ? {
                ...w,
                members: [
                  ...w.members,
                  { userId: target.userId, permissions: [...permissions] },
                ],
              }
            : w,
        ),
        events: [
          {
            id: crypto.randomUUID(),
            workspaceId: target.workspaceId,
            userId: target.userId,
            action: 'added',
            before: '소속 없음',
            after: '배정',
            beforePermissions: [],
            afterPermissions: [...permissions],
            at: new Date().toISOString(),
          },
          ...old.events,
        ],
      };
    });
    setReceipts((old: string[]): string[] => [...old, operationId]);
    return true;
  }
  function changeFilter(scope: string, next: HistoryFilter): void {
    const value = { ...filters, [scope]: next };
    setFilters(value);
    persist(fullPath, searches, trail, stress, membership, value);
  }
  const listCrumb: Crumb = { label: '워크스페이스', to: '/admin/workspaces' };
  const userCrumb: Crumb = { label: '사용자', to: '/admin/users' };
  let crumbs: Crumb[] = [{ label: '워크스페이스' }];
  let fallback: string | undefined;
  let actions: ReactNode = null;
  let content: ReactNode = null;
  function eventsFor(scope: string): JSX.Element {
    const filter = filters[scope] ?? emptyFilter;
    const scopedUser = scope.startsWith('user:') ? scope.slice(5) : null;
    const matches = data.events.filter(
      (event: AdminEvent): boolean =>
        (scopedUser
          ? event.userId === scopedUser
          : event.workspaceId === scope) &&
        (!filter.workspace || event.workspaceId === filter.workspace) &&
        (!filter.user || event.userId === filter.user),
    );
    const current = matches.slice(filter.page * 20, (filter.page + 1) * 20);
    const filteredSpace = data.workspaces.find(
      (w: Workspace): boolean => w.id === filter.workspace,
    );
    const filteredUser = data.people.find(
      (p: Person): boolean => p.id === filter.user,
    );
    return (
      <section aria-label="관리 변경 이력">
        <div className={styles.filterToolbar}>
          {scopedUser && (
            <div className={styles.filterControl}>
              <Button
                variant="surface"
                onClick={(): void =>
                  go(
                    `/admin/history/filter?scope=${encodeURIComponent(scope)}&kind=workspace`,
                  )
                }
              >
                <Icon name="search" />
                워크스페이스 · {filteredSpace?.name ?? '전체'}
              </Button>
              {filter.workspace && (
                <IconAction
                  label="워크스페이스 필터 해제"
                  icon="x"
                  onClick={(): void =>
                    changeFilter(scope, { ...filter, workspace: '', page: 0 })
                  }
                />
              )}
            </div>
          )}
          {!scopedUser && (
            <div className={styles.filterControl}>
              <Button
                variant="surface"
                onClick={(): void =>
                  go(
                    `/admin/history/filter?scope=${encodeURIComponent(scope)}&kind=user`,
                  )
                }
              >
                <Icon name="search" />
                사용자 · {filteredUser?.name ?? '전체'}
              </Button>
              {filter.user && (
                <IconAction
                  label="사용자 필터 해제"
                  icon="x"
                  onClick={(): void =>
                    changeFilter(scope, { ...filter, user: '', page: 0 })
                  }
                />
              )}
            </div>
          )}
        </div>
        <ol className={styles.events} aria-label="변경 이력 결과">
          {current.map((event: AdminEvent): JSX.Element => {
            const space = data.workspaces.find(
              (w: Workspace): boolean => w.id === event.workspaceId,
            );
            const user = data.people.find(
              (p: Person): boolean => p.id === event.userId,
            );
            const diff =
              event.beforePermissions && event.afterPermissions
                ? permissionDiff(
                    event.beforePermissions,
                    event.afterPermissions,
                  )
                : null;
            return (
              <li key={event.id}>
                <span className={styles.eventIcon}>
                  <Icon
                    name={
                      event.action === 'added' || event.action === 'created'
                        ? 'plus'
                        : event.action === 'removed'
                          ? 'minus'
                          : 'pencil'
                    }
                  />
                </span>
                <div className={styles.eventBody}>
                  <div className={styles.eventHeading}>
                    <div className={styles.eventTitle}>
                      <strong>
                        {event.action === 'added'
                          ? '사용자 배정'
                          : event.action === 'removed'
                            ? '소속 제외'
                            : event.action === 'created'
                              ? '공간 생성'
                              : event.userId
                                ? '권한 변경'
                                : '이름 변경'}
                      </strong>
                      {user && (
                        <button onClick={(): void => go(userPath(user.id))}>
                          {user.name}
                        </button>
                      )}
                      <button
                        onClick={(): void =>
                          go(workspacePath(event.workspaceId))
                        }
                      >
                        {space?.name}
                      </button>
                    </div>
                    <span className={styles.eventMeta}>
                      서버 운영자 · {timeLabel(event.at)}
                    </span>
                  </div>
                  {diff ? (
                    <div className={styles.auditDiff}>
                      {diff.added.length > 0 && (
                        <span>
                          <b>추가</b>{' '}
                          {diff.added
                            .map((p: Permission): string => permissionLabels[p])
                            .join(' · ')}
                        </span>
                      )}
                      {diff.removed.length > 0 && (
                        <span>
                          <b>회수</b>{' '}
                          {diff.removed
                            .map((p: Permission): string => permissionLabels[p])
                            .join(' · ')}
                        </span>
                      )}
                      {diff.added.length === 0 && diff.removed.length === 0 && (
                        <span>
                          {event.action === 'removed'
                            ? '소속 제외'
                            : '소속 배정'}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className={styles.delta}>
                      {event.before && (
                        <>
                          <span>{event.before}</span>
                          <Icon name="arrow-right" size={14} />
                        </>
                      )}
                      <span>{event.after}</span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {current.length === 0 && (
          <p className={styles.empty}>조건에 맞는 변경 이력이 없습니다.</p>
        )}
        <nav className={listStyles.pagination} aria-label="이력 페이지">
          <span>{matches.length}개</span>
          <IconAction
            label="이전 이력"
            icon="chevron-left"
            disabled={filter.page === 0}
            onClick={(): void =>
              changeFilter(scope, { ...filter, page: filter.page - 1 })
            }
          />
          <IconAction
            label="다음 이력"
            icon="chevron-right"
            disabled={(filter.page + 1) * 20 >= matches.length}
            onClick={(): void =>
              changeFilter(scope, { ...filter, page: filter.page + 1 })
            }
          />
        </nav>
      </section>
    );
  }
  if (path === '/admin/workspaces') {
    actions = (
      <IconAction
        label="워크스페이스 생성"
        icon="plus"
        onClick={(): void => go('/admin/workspace/new')}
      />
    );
    content = (
      <EntityBrowser
        label="워크스페이스 목록"
        columns={['워크스페이스', '멤버', '최근 변경']}
        items={data.workspaces.map((w: Workspace): Entity =>
          workspaceEntity(w, data),
        )}
        state={searches.workspaces ?? emptySearch}
        onState={(next: SearchState): void => search('workspaces', next)}
        onOpen={(id: string): void =>
          openFrom('workspaces', id, workspacePath(id))
        }
        actions={(item: Entity): JSX.Element => (
          <>
            <IconAction
              label={`${item.name} 멤버 추가`}
              icon="user-plus"
              onClick={(): void =>
                openFrom(
                  'workspaces',
                  item.id,
                  `/admin/members/add?id=${item.id}`,
                )
              }
            />
            <IconAction
              label={`${item.name} 이름 편집`}
              icon="pencil"
              onClick={(): void =>
                openFrom(
                  'workspaces',
                  item.id,
                  `/admin/workspace/edit?id=${item.id}`,
                )
              }
            />
            <IconAction
              label={`${item.name} 변경 이력`}
              icon="history"
              onClick={(): void =>
                openFrom(
                  'workspaces',
                  item.id,
                  workspacePath(item.id, 'history'),
                )
              }
            />
          </>
        )}
      />
    );
  } else if (path === '/admin/users') {
    crumbs = [{ label: '사용자' }];
    const key = `users-${membership}`;
    const people = data.people.filter((p: Person): boolean => {
      const has = data.workspaces.some((w: Workspace): boolean =>
        w.members.some((m: Member): boolean => m.userId === p.id),
      );
      return membership === 'all' || (membership === 'none' ? !has : has);
    });
    content = (
      <>
        <div
          className={styles.membershipFilters}
          role="group"
          aria-label="사용자 소속 필터"
        >
          {(
            [
              { value: 'all', label: '전체' },
              { value: 'none', label: '배정 대기' },
              { value: 'any', label: '소속 있음' },
            ] as const
          ).map((item): JSX.Element => (
            <Button
              key={item.value}
              variant="surface"
              size="small"
              aria-pressed={membership === item.value}
              onClick={(): void => {
                setMembership(item.value);
                persist(fullPath, searches, trail, stress, item.value);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <EntityBrowser
          label="사용자 목록"
          columns={['사용자', '소속 워크스페이스', '배정 상태']}
          singleLineChips
          items={people.map((p: Person): Entity => personEntity(p, data))}
          state={searches[key] ?? emptySearch}
          onState={(next: SearchState): void => search(key, next)}
          onOpen={(id: string): void => openFrom(key, id, userPath(id))}
          emptyLabel={
            membership === 'none' ? '배정 대기 사용자가 없습니다' : undefined
          }
          actions={(item: Entity): JSX.Element => (
            <IconAction
              label={`${item.name} 워크스페이스 배정`}
              icon="user-plus"
              onClick={(): void =>
                openFrom(key, item.id, `/admin/assign?user=${item.id}`)
              }
            />
          )}
        />
      </>
    );
  } else if (path === '/admin/workspace/new') {
    crumbs = [listCrumb, { label: '새 워크스페이스' }];
    fallback = '/admin/workspaces';
    content = (
      <CreateForm
        existing={data.workspaces}
        initialDraft={formDrafts[fullPath]?.creation}
        onDraftChange={rememberCreation}
        onCreate={(value: Creation): void => {
          if (!canManage()) return;
          discardFormDraft();
          setData((old: Data): Data => ({
            ...old,
            workspaces: [...old.workspaces, { ...value, members: [] }],
            events: [
              {
                id: crypto.randomUUID(),
                workspaceId: value.id,
                userId: null,
                action: 'created',
                before: '',
                after: value.name,
                at: new Date().toISOString(),
              },
              ...old.events,
            ],
          }));
          setNotice({
            text: '워크스페이스를 만들었습니다. 함께 사용할 사용자를 배정하세요.',
            workspaceId: value.id,
          });
          void navigate(workspacePath(value.id));
        }}
      />
    );
  } else if (path === '/admin/workspace' && workspace) {
    crumbs = [listCrumb, { label: workspace.name }];
    fallback = '/admin/workspaces';
    const tab = query.get('tab') === 'history' ? 'history' : 'members';
    actions = (
      <>
        <IconAction
          label="기존 사용자 추가"
          icon="user-plus"
          onClick={(): void => go(`/admin/members/add?id=${workspace.id}`)}
        />
        <IconAction
          label="이름 편집"
          icon="pencil"
          onClick={(): void => go(`/admin/workspace/edit?id=${workspace.id}`)}
        />
      </>
    );
    const key = `members-${workspace.id}`;
    content = (
      <Tabs
        label="워크스페이스 관리"
        value={tab}
        onValueChange={(value: string): void => {
          void navigate(workspacePath(workspace.id, value));
        }}
        items={[
          {
            id: 'members',
            label: `멤버 ${workspace.members.length}`,
            content: (
              <EntityBrowser
                label="멤버 목록"
                items={workspace.members.flatMap((m: Member): Entity[] => {
                  const p = data.people.find(
                    (person: Person): boolean => person.id === m.userId,
                  );
                  return p
                    ? [
                        {
                          ...personEntity(p, data),
                          chips: [permissionSummary(m.permissions)],
                        },
                      ]
                    : [];
                })}
                state={searches[key] ?? emptySearch}
                onState={(next: SearchState): void => search(key, next)}
                onOpen={(id: string): void => openFrom(key, id, userPath(id))}
                onEdit={(id: string): void =>
                  openFrom(key, id, editPath(workspace.id, id))
                }
                emptyLabel="아직 배정된 사용자가 없습니다"
              />
            ),
          },
          {
            id: 'history',
            label: '변경 이력',
            content: eventsFor(workspace.id),
          },
        ]}
      />
    );
  } else if (path === '/admin/workspace/edit' && workspace) {
    crumbs = [
      { label: workspace.name, to: workspacePath(workspace.id) },
      { label: '이름 편집' },
    ];
    fallback = workspacePath(workspace.id);
    content = (
      <WorkspaceForm
        key={workspace.id}
        workspace={workspace}
        conflict={mode === 'conflict'}
        initialName={formDrafts[fullPath]?.name}
        onDraftChange={rememberName}
        onSave={(name: string): void => {
          if (!canManage()) return;
          discardFormDraft();
          commitWorkspace(
            { ...workspace, name },
            {
              userId: null,
              action: 'changed',
              before: workspace.name,
              after: name,
            },
          );
          back(workspacePath(workspace.id), {
            text: '이름을 변경했습니다.',
            workspaceId: workspace.id,
          });
        }}
      />
    );
  } else if (path === '/admin/user' && person) {
    crumbs = [userCrumb, { label: person.name }];
    fallback = '/admin/users';
    actions = (
      <IconAction
        label={`${person.name} 워크스페이스 배정`}
        icon="user-plus"
        onClick={(): void => go(`/admin/assign?user=${person.id}`)}
      />
    );
    const spaces = data.workspaces.filter((w: Workspace): boolean =>
      w.members.some((m: Member): boolean => m.userId === person.id),
    );
    const key = `user-spaces-${person.id}`;
    const tab = query.get('tab') === 'history' ? 'history' : 'members';
    content = (
      <Tabs
        label="사용자 관리"
        value={tab}
        onValueChange={(value: string): void => {
          void navigate(userPath(person.id, value));
        }}
        items={[
          {
            id: 'members',
            label: `소속 ${spaces.length}`,
            content: (
              <>
                {spaces.length === 0 && (
                  <StatusNotice tone="info" title="워크스페이스 배정 대기">
                    소속 워크스페이스가 없습니다. 상단 배정 버튼으로 시작하세요.
                  </StatusNotice>
                )}
                <EntityBrowser
                  label="소속 워크스페이스"
                  columns={['워크스페이스', '업무 권한', '최근 변경']}
                  items={spaces.map((w: Workspace): Entity => ({
                    ...workspaceEntity(w, data),
                    chips: [
                      permissionSummary(
                        w.members.find(
                          (m: Member): boolean => m.userId === person.id,
                        )?.permissions ?? [],
                      ),
                    ],
                  }))}
                  state={searches[key] ?? emptySearch}
                  onState={(next: SearchState): void => search(key, next)}
                  onOpen={(id: string): void =>
                    openFrom(key, id, workspacePath(id))
                  }
                  onEdit={(id: string): void =>
                    openFrom(key, id, editPath(id, person.id, 'user'))
                  }
                  emptyLabel="배정된 워크스페이스가 없습니다"
                />
              </>
            ),
          },
          {
            id: 'history',
            label: '변경 이력',
            content: eventsFor(`user:${person.id}`),
          },
        ]}
      />
    );
  } else if (
    (path === '/admin/assign' && person) ||
    (path === '/admin/members/add' && workspace)
  ) {
    const fixedUser = path === '/admin/assign' ? person : undefined;
    const fixedWorkspace =
      path === '/admin/members/add' ? workspace : undefined;
    crumbs = [
      {
        label: fixedUser?.name ?? fixedWorkspace?.name ?? '',
        to: fixedUser
          ? userPath(fixedUser.id)
          : workspacePath(fixedWorkspace?.id ?? ''),
      },
      {
        label:
          assignmentDrafts[fullPath]?.step === 'permissions'
            ? '권한 설정'
            : assignmentDrafts[fullPath]?.step === 'results'
              ? '배정 결과'
              : fixedUser
                ? '배정할 워크스페이스'
                : '추가할 사용자',
      },
    ];
    fallback = fixedUser
      ? userPath(fixedUser.id)
      : workspacePath(fixedWorkspace?.id ?? '');
    content = (
      <AssignmentFlow
        key={fullPath}
        navigationRef={assignmentNavigation}
        data={data}
        user={fixedUser}
        workspace={fixedWorkspace}
        partial={mode === 'partial'}
        initialDraft={assignmentDrafts[fullPath]}
        onDraft={rememberAssignment}
        onReceipt={(operationId: string): boolean =>
          receipts.includes(operationId)
        }
        onAttempt={(target: AssignmentAttempt): void => {
          if (!canManage()) return;
          setAttempts((old: AssignmentAttempt[]): AssignmentAttempt[] => [
            ...old,
            {
              workspaceId: target.workspaceId,
              userId: target.userId,
              operation: 'put',
              operationId: target.operationId,
            },
          ]);
        }}
        onPut={assign}
        onDone={(count: number, assignedWorkspace?: string): void => {
          setAssignmentDrafts(
            (
              old: Record<string, AssignmentDraft>,
            ): Record<string, AssignmentDraft> => {
              const next = { ...old };
              delete next[fullPath];
              return next;
            },
          );
          back(fallback ?? '/admin/workspaces', {
            text: `${count}건의 배정을 완료했습니다.`,
            workspaceId: fixedWorkspace?.id ?? assignedWorkspace,
            userId: fixedUser?.id,
          });
        }}
      />
    );
  } else if (path === '/admin/permissions' && workspace && person) {
    const member = workspace.members.find(
      (m: Member): boolean => m.userId === person.id,
    );
    fallback =
      query.get('origin') === 'user'
        ? userPath(person.id)
        : workspacePath(workspace.id);
    crumbs = [
      { label: workspace.name, to: workspacePath(workspace.id) },
      { label: `${person.name} 권한` },
    ];
    actions = (
      <IconAction
        label="소속 제외"
        icon="minus"
        onClick={(): void =>
          go(`/admin/member/remove?workspace=${workspace.id}&user=${person.id}`)
        }
      />
    );
    content = member ? (
      <section className={styles.assignmentForm}>
        <div className={styles.taskContext}>
          <strong>{person.name}</strong>
          <span>{workspace.name}</span>
        </div>
        <PermissionForm
          key={`${workspace.id}-${person.id}`}
          permissions={member.permissions}
          initialDraft={formDrafts[fullPath]?.permissions}
          onDraftChange={rememberPermissions}
          onSave={(permissions: Permission[]): void => {
            if (!canManage()) return;
            discardFormDraft();
            commitWorkspace(
              {
                ...workspace,
                members: workspace.members.map((m: Member): Member =>
                  m.userId === person.id ? { ...m, permissions } : m,
                ),
              },
              {
                userId: person.id,
                action: 'changed',
                before: '',
                after: '',
                beforePermissions: member.permissions,
                afterPermissions: permissions,
              },
            );
            back(fallback ?? workspacePath(workspace.id), {
              text: `${person.name}의 권한을 변경했습니다.`,
              workspaceId: workspace.id,
              userId: person.id,
            });
          }}
        />
      </section>
    ) : (
      <StatusNotice tone="warning" title="현재 소속을 확인할 수 없습니다">
        사용자와 공간을 다시 확인하세요.
      </StatusNotice>
    );
  } else if (path === '/admin/member/remove' && workspace && person) {
    fallback = editPath(workspace.id, person.id);
    crumbs = [{ label: workspace.name }, { label: '소속 제외' }];
    content = (
      <section className={styles.form}>
        <h2>{person.name}의 소속을 제외할까요?</h2>
        <p>
          문서·히스토리·개인 기록은 보존합니다. 이 공간에 대한 이후 요청부터
          접근할 수 없습니다.
        </p>
        <Button
          onClick={(): void => {
            const before =
              workspace.members.find(
                (m: Member): boolean => m.userId === person.id,
              )?.permissions ?? [];
            commitWorkspace(
              {
                ...workspace,
                members: workspace.members.filter(
                  (m: Member): boolean => m.userId !== person.id,
                ),
              },
              {
                userId: person.id,
                action: 'removed',
                before: '소속',
                after: '소속 없음',
                beforePermissions: before,
                afterPermissions: [],
              },
            );
            const remaining = trail.slice(0, -1);
            const destination = remaining.at(-1) ?? workspacePath(workspace.id);
            setTrail(remaining.slice(0, -1));
            setNotice({
              text: `${person.name}의 소속을 제외했습니다.`,
              workspaceId: workspace.id,
              userId: person.id,
            });
            void navigate(destination);
          }}
        >
          소속 제외
        </Button>
      </section>
    );
  } else if (path === '/admin/history/filter') {
    const scope = query.get('scope') ?? '';
    const isUser = query.get('kind') === 'user';
    const filter = filters[scope] ?? emptyFilter;
    const key = `history-picker-${scope}-${isUser ? 'user' : 'workspace'}`;
    fallback = scope.startsWith('user:')
      ? userPath(scope.slice(5), 'history')
      : workspacePath(scope, 'history');
    crumbs = [
      { label: '변경 이력', to: fallback },
      { label: isUser ? '사용자 검색' : '워크스페이스 검색' },
    ];
    content = (
      <EntityBrowser
        label={isUser ? '필터 사용자' : '필터 워크스페이스'}
        items={
          isUser
            ? data.people.map((p: Person): Entity => personEntity(p, data))
            : data.workspaces.map((w: Workspace): Entity =>
                workspaceEntity(w, data),
              )
        }
        state={searches[key] ?? emptySearch}
        onState={(next: SearchState): void => search(key, next)}
        onOpen={(id: string): void => {
          changeFilter(scope, {
            ...filter,
            [isUser ? 'user' : 'workspace']: id,
            page: 0,
          });
          back(fallback ?? '/admin/workspaces');
        }}
      />
    );
  } else {
    content = (
      <StatusNotice tone="warning" title="관리 대상을 찾을 수 없습니다">
        목록에서 다시 선택하세요.
      </StatusNotice>
    );
    fallback = '/admin/workspaces';
  }
  return (
    <div className="wiki-theme" data-wiki-theme={theme}>
      {showConsole ? (
        <div onClickCapture={guardManagement} onSubmitCapture={guardManagement}>
          <AdminShell
            crumbs={crumbs}
            onBack={
              fallback
                ? (): void => {
                    if (assignmentNavigation.current?.back()) return;
                    back(fallback ?? '/admin/workspaces');
                  }
                : undefined
            }
            actions={actions}
            onNavigate={(next: string): void => go(next, false)}
            onCrumbNavigate={ancestor}
            onExit={leaveAdmin}
            serverUrl={session.serverUrl}
          >
            <div
              className={`${listStyles.root} ${styles.page}`}
              data-screen={path}
            >
              {notice && (
                <div className={styles.savedNotice}>
                  <p role="status">{notice.text}</p>
                  {notice.workspaceId && (
                    <Button
                      variant="surface"
                      size="small"
                      onClick={(): void => {
                        const id = notice.workspaceId;
                        if (!id) return;
                        if (notice.userId && path.startsWith('/admin/user')) {
                          const scope = `user:${notice.userId}`;
                          changeFilter(scope, {
                            workspace: id,
                            user: '',
                            page: 0,
                          });
                          go(userPath(notice.userId, 'history'));
                          return;
                        }
                        changeFilter(id, {
                          workspace: '',
                          user: notice.userId ?? '',
                          page: 0,
                        });
                        go(workspacePath(id, 'history'));
                      }}
                    >
                      변경 이력
                    </Button>
                  )}
                </div>
              )}
              {content}
            </div>
          </AdminShell>
        </div>
      ) : (
        <div
          data-screen={entryScreen === 'auth' ? '/admin' : `/${entryScreen}`}
        >
          <EntryScreens
            screen={entryScreen}
            serverUrl={
              entryScreen === 'auth' ? adminServer : ordinaryAccount.serverUrl
            }
            userName={ordinaryAccount.name}
            authError={authError}
            onEnterAdmin={enterAdmin}
            onCancelAdmin={leaveAdmin}
            onAuthenticate={authenticateAdmin}
            onUserLogin={(
              name: string,
              serverUrl: string,
              waiting: boolean,
            ): void => {
              setOrdinaryAccount({ name, serverUrl });
              chooseEntry(waiting ? 'waiting' : 'settings');
            }}
            onUserLogout={(): void => chooseEntry('login')}
          />
        </div>
      )}
      <details className={styles.previewSettings}>
        <summary>시안 설정 · 가상 자료</summary>
        <div>
          <label>
            진입 화면{' '}
            <select
              aria-label="진입 화면"
              value={entryOrigin}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                const next = event.target.value;
                if (
                  next === 'login' ||
                  next === 'settings' ||
                  next === 'waiting'
                )
                  chooseEntry(next);
              }}
            >
              <option value="login">로그인</option>
              <option value="waiting">배정 대기</option>
              <option value="settings">설정 · 서버·계정</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              aria-label="대규모 자료 240명"
              checked={stress}
              onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                const next = event.target.checked;
                setStress(next);
                setData(makeData(next));
                setSearches({});
                setFilters({});
                setTrail([]);
                setAttempts([]);
                setReceipts([]);
                setAssignmentDrafts({});
                setFormDrafts({});
                setNotice(null);
                const destination = showConsole
                  ? '/admin/workspaces'
                  : fullPath;
                persist(destination, {}, [], next, membership, {});
                void navigate(destination);
              }}
            />
            대규모 자료 240명
          </label>
          <label>
            상태{' '}
            <select
              aria-label="시안 상태"
              value={mode}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                const next = event.target.value;
                setMode(next);
                if (next === 'expired' || next === 'denied')
                  expireSession(next);
              }}
            >
              <option value="normal">정상</option>
              <option value="partial">일부 배정 실패</option>
              <option value="conflict">이름 충돌</option>
              <option value="expired">인증 만료</option>
              <option value="denied">권한 없음</option>
              <option value="offline">인증 서버 연결 실패</option>
              <option value="unconfigured">관리자 미설정</option>
            </select>
          </label>
          <label>
            테마{' '}
            <select
              aria-label="시안 테마"
              defaultValue="system"
              onChange={(event: ChangeEvent<HTMLSelectElement>): void =>
                setPreference(
                  event.target.value === 'dark'
                    ? 'dark'
                    : event.target.value === 'light'
                      ? 'light'
                      : 'system',
                )
              }
            >
              <option value="system">시스템</option>
              <option value="light">밝게</option>
              <option value="dark">어둡게</option>
            </select>
          </label>
          <span>인증·배정·저장은 모의 동작이며 서버에 전송하지 않습니다.</span>
        </div>
      </details>
    </div>
  );
}
const root = document.getElementById('workspace-admin-preview');
if (root)
  createRoot(root).render(
    <MemoryRouter initialEntries={[canonical(restored?.path ?? '/login')]}>
      <Proposal />
    </MemoryRouter>,
  );

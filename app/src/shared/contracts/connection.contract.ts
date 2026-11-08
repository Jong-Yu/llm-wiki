export const CONNECTION_CHANNELS = {
  connect: 'connection:connect',
  authenticate: 'connection:authenticate',
  getState: 'connection:get-state',
  selectWorkspace: 'connection:select-workspace',
  disconnect: 'connection:disconnect',
  restoreSaved: 'connection:restore-saved',
  forgetSaved: 'connection:forget-saved',
} as const;

export type AccountRequest = {
  serverUrl: string;
  name: string;
  mode: 'signup' | 'login';
};
export type RememberedAccount = { name: string; serverUrl: string };
export type AccessRevision = {
  policyRevision: string;
  accessRevision?: string;
};

/** 신규 계약은 본인 접근 기준을 비교하고 구 계약은 감사 기준까지 같을 때만 호환합니다. */
export function sameAccessRevision(
  left: AccessRevision,
  right: AccessRevision,
): boolean {
  return left.accessRevision && right.accessRevision
    ? left.accessRevision === right.accessRevision
    : left.policyRevision === right.policyRevision;
}

export type ConnectRequest = {
  serverUrl: string;
  token: string;
  remember?: boolean;
};
export type ConnectionProtection = {
  availability: 'protected' | 'session_only';
  backend:
    | 'macos_keychain'
    | 'windows_dpapi'
    | 'linux_secret_store'
    | 'unavailable'
    | 'unsafe_fallback';
  saved: boolean;
  remembered: boolean;
  issue:
    | 'none'
    | 'storage_unavailable'
    | 'storage_corrupt'
    | 'storage_busy'
    | 'storage_changed'
    | 'storage_write_failed'
    | 'restore_failed'
    | 'identity_changed'
    | 'scope_changed';
};
export type SelectWorkspaceRequest = {
  connectionId: string;
  tenant: string;
  profile: string;
};
export type WorkspaceProfile = {
  id: string;
  domain: string | null;
  viewpoint: string | null;
};
export type WorkspaceMembership = {
  id: string;
  displayName?: string;
  permissions: string[];
  defaultProfile: string;
  profiles: WorkspaceProfile[];
};
export type ConnectionSnapshot = (
  | { status: 'disconnected' }
  | {
      status: 'connected';
      connectionId: string;
      serverUrl: string;
      userId: string;
      policyRevision: string;
      accessRevision?: string;
      displayName?: string;
      defaultTenant?: string | null;
      workspaces: WorkspaceMembership[];
      selection: { tenant: string; profile: string } | null;
      checkedAt: string;
    }
) & {
  protection?: ConnectionProtection;
  rememberedAccount?: RememberedAccount;
  warning?: string;
  /** 읽기 요청이 연속으로 서버에 닿지 못했을 때만 true입니다. 로그인 여부와는 별개입니다. */
  serverUnreachable?: true;
};
export type ConnectionResult =
  | { ok: true; data: ConnectionSnapshot }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status?: number;
        traceId?: string;
      };
    };
export type ConnectionBridge = {
  authenticate: (request: AccountRequest) => Promise<ConnectionResult>;
  connect: (request: ConnectRequest) => Promise<ConnectionResult>;
  getState: () => Promise<ConnectionResult>;
  selectWorkspace: (
    request: SelectWorkspaceRequest,
  ) => Promise<ConnectionResult>;
  disconnect: () => Promise<ConnectionResult>;
  restoreSaved: () => Promise<ConnectionResult>;
  forgetSaved: () => Promise<ConnectionResult>;
};
export type AccessContext = {
  userId: string;
  accessRevision?: string;
  displayName?: string;
  defaultTenant?: string | null;
  policyRevision: string;
  workspaces: WorkspaceMembership[];
};

/** 외부 입력이 키로 접근 가능한 객체인지 판별합니다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** 객체가 아닌 외부 입력은 구조 검사 시작 전에 거부합니다. */
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('응답 형식이 올바르지 않습니다.');
  return value;
}
/** 제한 길이 안의 비어 있지 않은 문자열만 받습니다. */
function string(value: unknown, limit: number = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit)
    throw new Error('문자열 형식이 올바르지 않습니다.');
  return value;
}
/** 서버 계약의 nullable 문자열은 null과 빈 문자열을 구분해 보존합니다. */
function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('문자열 형식이 올바르지 않습니다.');
  return value;
}
/** 목록의 각 값을 문자열 검사로 좁힙니다. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('목록 형식이 올바르지 않습니다.');
  return value.map((item: unknown): string => string(item));
}
/** 공개 관점의 ID와 맥락 필드만 명시적으로 복사합니다. */
function profile(value: unknown): WorkspaceProfile {
  const data = record(value);
  return {
    id: string(data.id),
    domain: nullableString(data.domain),
    viewpoint: nullableString(data.viewpoint),
  };
}
/** 공간의 관점 목록과 기본 관점이 일치하는지 검사합니다. */
function membership(value: unknown): WorkspaceMembership {
  const data = record(value);
  if (!Array.isArray(data.profiles))
    throw new Error('작업 공간의 조회 설정을 확인할 수 없습니다.');
  const profiles = data.profiles.map((item: unknown): WorkspaceProfile =>
    profile(item),
  );
  const defaultProfile = string(data.defaultProfile);
  if (
    !profiles.some(
      (item: WorkspaceProfile): boolean => item.id === defaultProfile,
    ) ||
    new Set(profiles.map((item: WorkspaceProfile): string => item.id)).size !==
      profiles.length
  )
    throw new Error('작업 공간의 기본 조회 설정을 확인할 수 없습니다.');
  return {
    id: string(data.id),
    ...(data.displayName === undefined
      ? {}
      : { displayName: string(data.displayName) }),
    permissions: strings(data.permissions),
    defaultProfile,
    profiles,
  };
}

/** 이름과 주소만 받아 토큰이 renderer 입력에 포함되지 않게 합니다. */
export function parseAccountRequest(value: unknown): AccountRequest {
  const data = record(value);
  if (
    Object.keys(data).sort().join(',') !== 'mode,name,serverUrl' ||
    (data.mode !== 'signup' && data.mode !== 'login')
  )
    throw new Error('invalid_request');
  const name = string(data.name, 160).trim();
  if (
    !name ||
    Array.from(name).some(
      (character: string): boolean =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('invalid_request');
  return {
    name,
    serverUrl: string(data.serverUrl, 2048).trim(),
    mode: data.mode,
  };
}

/** 연결 입력의 필드·길이와 토큰 제어문자 여부를 검사합니다. */
export function parseConnectRequest(value: unknown): ConnectRequest {
  const data = record(value);
  if (
    !['serverUrl,token', 'remember,serverUrl,token'].includes(
      Object.keys(data).sort().join(','),
    ) ||
    (data.remember !== undefined && typeof data.remember !== 'boolean')
  )
    throw new Error('연결 입력을 확인해 주세요.');
  const token = string(data.token).trim();
  if (!/^[\x21-\x7e]+$/.test(token))
    throw new Error('개인 토큰을 확인해 주세요.');
  return {
    serverUrl: string(data.serverUrl, 2048).trim(),
    token,
    ...(typeof data.remember === 'boolean' ? { remember: data.remember } : {}),
  };
}
/** 연결 식별자·작업 공간·관점만 포함된 선택 요청을 받습니다. */
export function parseSelectWorkspaceRequest(
  value: unknown,
): SelectWorkspaceRequest {
  const data = record(value);
  if (Object.keys(data).sort().join(',') !== 'connectionId,profile,tenant')
    throw new Error('작업 공간 입력을 확인해 주세요.');
  return {
    connectionId: string(data.connectionId),
    tenant: string(data.tenant),
    profile: string(data.profile),
  };
}

/** 서버의 원래 필드를 명시적으로 매핑하고 비밀/알 수 없는 필드는 버립니다. */
export function parseAccessContext(value: unknown): AccessContext {
  const envelope = record(value);
  const meta = record(envelope.meta);
  if (!/^[a-f0-9]{32}$/.test(string(meta.trace_id)))
    throw new Error('요청 추적 정보를 확인할 수 없습니다.');
  const data = record(envelope.data);
  const memberships = record(data.memberships);
  const workspaces = Object.entries(memberships).map(
    ([id, raw]: [string, unknown]): WorkspaceMembership => {
      const item = record(raw);
      const profiles = Object.entries(record(item.profiles)).map(
        ([profileId, rawProfile]: [string, unknown]): WorkspaceProfile => {
          const details = record(rawProfile);
          return {
            id: profileId,
            domain: nullableString(details.domain),
            viewpoint: nullableString(details.viewpoint),
          };
        },
      );
      return membership({
        id,
        displayName: item.display_name,
        permissions: item.permissions,
        defaultProfile: item.default_profile,
        profiles,
      });
    },
  );
  return {
    userId: string(data.user_id),
    ...(data.access_revision === undefined
      ? {}
      : { accessRevision: string(data.access_revision) }),
    ...(data.display_name === undefined
      ? {}
      : { displayName: string(data.display_name) }),
    ...(data.default_tenant === undefined
      ? {}
      : { defaultTenant: nullableString(data.default_tenant) }),
    policyRevision: string(data.policy_revision),
    workspaces,
  };
}

/** IPC 결과를 재검사해 명시한 공개 연결 상태만 renderer로 전달합니다. */
export function parseConnectionResult(value: unknown): ConnectionResult {
  const result = record(value);
  if (result.ok === false) {
    const error = record(result.error);
    const code = string(error.code, 128);
    if (!/^[a-z0-9_]+$/.test(code))
      throw new Error('오류 코드를 확인할 수 없습니다.');
    const status = error.status;
    const traceId = error.traceId;
    if (
      status !== undefined &&
      (typeof status !== 'number' ||
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599)
    )
      throw new Error('오류 상태를 확인할 수 없습니다.');
    if (
      traceId !== undefined &&
      (typeof traceId !== 'string' || !/^[a-f0-9]{32}$/.test(traceId))
    )
      throw new Error('추적 정보를 확인할 수 없습니다.');
    return {
      ok: false,
      error: {
        code,
        message: string(error.message),
        ...(status !== undefined ? { status } : {}),
        ...(traceId !== undefined ? { traceId } : {}),
      },
    };
  }
  if (result.ok !== true) throw new Error('연결 결과를 확인할 수 없습니다.');
  const data = record(result.data);
  const remembered =
    data.rememberedAccount === undefined
      ? null
      : record(data.rememberedAccount);
  const extras = {
    ...(remembered
      ? {
          rememberedAccount: {
            name: string(remembered.name, 160),
            serverUrl: string(remembered.serverUrl, 2048),
          },
        }
      : {}),
    ...(data.warning === undefined ? {} : { warning: string(data.warning) }),
    ...(data.serverUnreachable === true
      ? { serverUnreachable: true as const }
      : {}),
  };
  const protection =
    data.protection === undefined
      ? {}
      : { protection: parseProtection(data.protection) };
  if (data.status === 'disconnected')
    return {
      ok: true,
      data: { status: 'disconnected', ...protection, ...extras },
    };
  if (data.status !== 'connected' || !Array.isArray(data.workspaces))
    throw new Error('연결 상태를 확인할 수 없습니다.');
  const workspaces = data.workspaces.map((item: unknown): WorkspaceMembership =>
    membership(item),
  );
  if (
    new Set(workspaces.map((item: WorkspaceMembership): string => item.id))
      .size !== workspaces.length
  )
    throw new Error('작업 공간이 중복되었습니다.');
  let selection: { tenant: string; profile: string } | null = null;
  if (data.selection !== null) {
    const chosen = record(data.selection);
    selection = {
      tenant: string(chosen.tenant),
      profile: string(chosen.profile),
    };
    const chosenWorkspace = workspaces.find(
      (item: WorkspaceMembership): boolean => item.id === selection?.tenant,
    );
    if (
      !chosenWorkspace?.profiles.some(
        (item: WorkspaceProfile): boolean => item.id === selection?.profile,
      )
    )
      throw new Error('현재 작업 공간의 조회 설정을 확인할 수 없습니다.');
  }
  const checkedAt = string(data.checkedAt);
  if (!Number.isFinite(Date.parse(checkedAt)))
    throw new Error('확인 시각을 확인할 수 없습니다.');
  return {
    ok: true,
    data: {
      status: 'connected',
      connectionId: string(data.connectionId),
      serverUrl: string(data.serverUrl),
      userId: string(data.userId),
      policyRevision: string(data.policyRevision),
      ...(data.accessRevision === undefined
        ? {}
        : { accessRevision: string(data.accessRevision) }),
      ...(data.displayName === undefined
        ? {}
        : { displayName: string(data.displayName) }),
      ...(data.defaultTenant === undefined
        ? {}
        : { defaultTenant: nullableString(data.defaultTenant) }),
      ...extras,
      workspaces,
      selection,
      checkedAt,
      ...protection,
    },
  };
}

/** 보호 저장 진단의 고정 상태만 허용하고 비밀·경로 등 나머지 필드를 버립니다. */
function parseProtection(value: unknown): ConnectionProtection {
  const data = record(value);
  const { availability, backend, saved, remembered, issue } = data;
  if (
    (availability !== 'protected' && availability !== 'session_only') ||
    (backend !== 'macos_keychain' &&
      backend !== 'windows_dpapi' &&
      backend !== 'linux_secret_store' &&
      backend !== 'unavailable' &&
      backend !== 'unsafe_fallback') ||
    typeof saved !== 'boolean' ||
    typeof remembered !== 'boolean' ||
    (issue !== 'none' &&
      issue !== 'storage_unavailable' &&
      issue !== 'storage_corrupt' &&
      issue !== 'storage_busy' &&
      issue !== 'storage_changed' &&
      issue !== 'storage_write_failed' &&
      issue !== 'restore_failed' &&
      issue !== 'identity_changed' &&
      issue !== 'scope_changed')
  )
    throw new Error('보호 저장 상태를 확인할 수 없습니다.');
  return { availability, backend, saved, remembered, issue };
}

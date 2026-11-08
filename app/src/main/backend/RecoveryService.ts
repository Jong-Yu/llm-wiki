import type { ConnectionResult } from '@contracts/connection.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import type { AnalysisContext, ConnectionService } from './ConnectionService';
import type { ProtectedRecoveryStore } from './ProtectedRecoveryStore';
import type { RecoveryScope } from './ProtectedRecoveryStore';
import { recoveryRequestSchema } from '@contracts/recovery.contract';
import type {
  RecoveryKind,
  RecoveryRequest,
  RecoveryResult,
} from '@contracts/recovery.contract';

type Connection = Pick<
  ConnectionService,
  'analysisContext' | 'isAnalysisCurrent' | 'getState'
>;
/** 저장 구현만 교체할 수 있으며 범위·판본 검사는 복구 서비스가 계속 소유합니다. */
export type RecoveryStore = Pick<
  ProtectedRecoveryStore,
  'list' | 'put' | 'forgetIdentity'
>;
/** 인증된 main 문맥의 비밀 없는 값만 저장 기준으로 복사합니다. */
function recoveryScope(context: AnalysisContext): RecoveryScope {
  const workspace = context.active.workspaces.find(
    (item: AnalysisContext['active']['workspaces'][number]): boolean =>
      item.id === context.selection.tenant,
  );
  const profile = workspace?.profiles.find(
    (item: NonNullable<typeof workspace>['profiles'][number]): boolean =>
      item.id === context.selection.profile,
  );
  if (!profile) throw new Error('scope_changed');
  return {
    serverUrl: context.active.serverUrl,
    userId: context.active.userId,
    tenant: context.selection.tenant,
    profileId: profile.id,
    policyRevision: context.active.policyRevision,
    ...(context.active.accessRevision
      ? { accessRevision: context.active.accessRevision }
      : {}),
    domain: profile.domain,
    viewpoint: profile.viewpoint,
  };
}
/** 안전한 오류만 반환하며 인증 토큰·로컬 경로를 반사하지 않습니다. */
function failure(code: string): RecoveryResult {
  return {
    ok: false,
    error: {
      code,
      message: `복구 자료를 열거나 보관할 수 없습니다 (${code}). 현재 연결과 보호 저장 상태를 확인해 주세요.`,
    },
  };
}
/** 서버에서 재확인한 범위에만 보호된 로컬 복구 자료를 공개합니다. */
export class RecoveryService {
  #forgottenConnections = new Set<string>();
  /** 로그아웃 삭제가 시작되면 같은 연결의 뒤늦은 저장을 즉시 차단합니다. */
  #current(context: AnalysisContext): boolean {
    return (
      !this.#forgottenConnections.has(context.active.connectionId) &&
      this.connection.isAnalysisCurrent(context)
    );
  }
  readonly connection: Connection;
  readonly store: RecoveryStore;
  constructor(connection: Connection, store: RecoveryStore) {
    this.connection = connection;
    this.store = store;
  }
  /** renderer가 서버/사용자 경로를 정하지 못하게 현재 문맥으로 한정합니다. */
  async execute(value: RecoveryRequest): Promise<RecoveryResult> {
    const parsed = recoveryRequestSchema.safeParse(value);
    if (!parsed.success) return failure('invalid_request');
    const request = parsed.data;
    const context = await this.connection.analysisContext(request.connectionId);
    if ('ok' in context) return context;
    const expected = request.expectedScope;
    if (
      expected.userId !== context.active.userId ||
      expected.tenant !== context.selection.tenant ||
      expected.profileId !== context.selection.profile ||
      !sameAccessRevision(expected, context.active)
    )
      return failure('scope_changed');
    if (request.operation === 'list')
      return this.readContext(context, request.kind);
    if (request.operation === 'put')
      return this.capture(
        context,
        request.kind,
        request.key,
        request.payload,
        request.expectedRevision,
      );
    return this.store.put(
      recoveryScope(context),
      request.kind,
      request.key,
      null,
      request.expectedRevision,
      (): boolean => this.#current(context),
    );
  }
  /** 실행 서비스가 이미 확인한 문맥으로 pending registry를 조회합니다. 실행은 하지 않습니다. */
  async readContext(
    context: AnalysisContext,
    kind: RecoveryKind,
  ): Promise<RecoveryResult> {
    if (!this.#current(context)) return failure('scope_changed');
    return this.store.list(recoveryScope(context), kind, (): boolean =>
      this.#current(context),
    );
  }
  /** POST/CLI 이전에 토큰 없는 식별자·CAS·영수증 조회 정보를 확정합니다. */
  async capture(
    context: AnalysisContext,
    kind: RecoveryKind,
    key: string,
    payload: string,
    expectedRevision: string | null,
  ): Promise<RecoveryResult> {
    if (!this.#current(context)) return failure('scope_changed');
    const parsed = recoveryRequestSchema.safeParse({
      operation: 'put',
      connectionId: context.active.connectionId,
      expectedScope: {
        userId: context.active.userId,
        tenant: context.selection.tenant,
        profileId: context.selection.profile,
        policyRevision: context.active.policyRevision,
        ...(context.active.accessRevision
          ? { accessRevision: context.active.accessRevision }
          : {}),
      },
      kind,
      key,
      payload,
      expectedRevision,
    });
    if (!parsed.success) return failure('invalid_request');
    // 서비스 문맥 전체를 실수로 직렬화하는 것을 차단합니다. 본문 문자열은 임의로 수정하지 않습니다.
    const data: unknown = JSON.parse(payload);
    if (
      data &&
      typeof data === 'object' &&
      Object.keys(data).some((name: string): boolean =>
        /^(token|authorization|password|credential|accessToken|context)$/i.test(
          name,
        ),
      )
    )
      return failure('recovery_secret_field');
    return this.store.put(
      recoveryScope(context),
      kind,
      key,
      payload,
      expectedRevision,
      (): boolean => this.#current(context),
    );
  }
  /** 조회로 확인한 journal만 원래 revision으로 명시 제거합니다. */
  async removeContext(
    context: AnalysisContext,
    kind: RecoveryKind,
    key: string,
    expectedRevision: string,
  ): Promise<RecoveryResult> {
    return this.store.put(
      recoveryScope(context),
      kind,
      key,
      null,
      expectedRevision,
      (): boolean => this.#current(context),
    );
  }
  /** 로그아웃 전 신원을 고정하고 네트워크 없이 복구 파일을 정리합니다. */
  async forgetLocal(context: AnalysisContext): Promise<RecoveryResult> {
    this.#forgottenConnections.add(context.active.connectionId);
    return this.store.forgetIdentity(recoveryScope(context), (): boolean => {
      const state = this.connection.getState();
      return state.ok && state.data.status === 'disconnected';
    });
  }
}

/** 로컬 정리 실패가 메모리 해제·자동 복원 차단을 되돌리지 않게 합니다. */
export async function logoutWithRecovery(
  connection: ConnectionService,
  recovery: RecoveryService,
): Promise<ConnectionResult> {
  const local = connection.localContext();
  const result = await connection.logout();
  if (!result.ok || !local) return result;
  let cleaned = false;
  try {
    cleaned = (await recovery.forgetLocal(local)).ok;
  } catch {
    /* 로그아웃은 이미 완료되었습니다. */
  }
  const state = connection.getState();
  if (state.ok && state.data.status !== 'disconnected')
    return {
      ok: false,
      error: {
        code: 'superseded',
        message: '새 계정 연결로 이전 로그아웃 응답을 버렸습니다.',
      },
    };
  return cleaned
    ? state
    : connection.setLogoutWarning(
        '로그아웃은 완료했습니다. 로컬 복구 자료 정리에 실패해 보호된 파일은 남아 있습니다.',
      );
}

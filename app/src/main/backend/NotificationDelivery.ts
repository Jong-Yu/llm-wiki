import { z } from 'zod';
import type { ConnectionService, AnalysisContext } from './ConnectionService';
import type {
  NotificationsBridge,
  NotificationItem,
  NotificationSession,
} from '@contracts/notifications.contract';
import type { ProcessRecovery } from './processRecovery';
import { readProcessJournal, writeProcessJournal } from './processRecovery';
import type { RecoveryEntry } from '@contracts/recovery.contract';

type Connection = Pick<
  ConnectionService,
  'getState' | 'analysisContext' | 'isAnalysisCurrent' | 'onScopeChanged'
>;
type Notifications = Pick<NotificationsBridge, 'list' | 'read'>;
export type NotificationMessage = { title: string; body: string };
export type NotificationPresenter = (
  message: NotificationMessage,
  open: () => void,
) => () => void;
const checkpoint = z.strictObject({ sequence: z.number().int().nonnegative() });

/** 서버 기록의 읽음 여부와 OS 표시 여부를 분리하고 기기별 표시 위치만 보관합니다. */
export class NotificationDelivery {
  readonly #connection: Connection;
  readonly #notifications: Notifications;
  readonly #recovery: ProcessRecovery;
  readonly #present: NotificationPresenter;
  readonly #open: (workflowId: string) => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending = false;
  #disposed = false;
  #close: (() => void) | null = null;

  constructor(
    connection: Connection,
    notifications: Notifications,
    recovery: ProcessRecovery,
    present: NotificationPresenter,
    open: (workflowId: string) => void,
  ) {
    this.#connection = connection;
    this.#notifications = notifications;
    this.#recovery = recovery;
    this.#present = present;
    this.#open = open;
    connection.onScopeChanged((): void => {
      this.#close?.();
      this.#close = null;
      void this.tick();
    });
  }

  /** 창을 숨겨도 수집하고 앱 종료 뒤에는 서버 알림을 다음 시작 때 조회합니다. */
  start(): void {
    if (this.#timer || this.#disposed) return;
    this.#timer = setInterval((): void => {
      void this.tick();
    }, 30_000);
    this.#timer.unref();
    void this.tick();
  }

  /** 권한·범위가 바뀐 늦은 응답이나 이전 계정의 OS 클릭을 무효로 만듭니다. */
  #current(context: AnalysisContext): boolean {
    return !this.#disposed && this.#connection.isAnalysisCurrent(context);
  }

  /** 토큰 없이 현재 사용자의 선택 범위를 공개 요청으로 구성합니다. */
  #session(context: AnalysisContext): NotificationSession {
    return {
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
    };
  }

  /** 한꺼번에 여러 알림이 쌓여도 OS 배너는 하나로 묶고 전체 목록은 서버에 남깁니다. */
  async tick(): Promise<void> {
    if (this.#pending || this.#disposed) return;
    this.#pending = true;
    try {
      const state = this.#connection.getState();
      if (
        !state.ok ||
        state.data.status !== 'connected' ||
        !state.data.selection
      )
        return;
      const context = await this.#connection.analysisContext(
        state.data.connectionId,
      );
      if ('ok' in context || !this.#current(context)) return;
      const entries = await readProcessJournal(
        this.#recovery,
        context,
        'notification-delivery',
      );
      const entry = entries.find(
        (item: RecoveryEntry): boolean => item.key === 'os-cursor',
      );
      const afterSequence = entry
        ? checkpoint.parse(JSON.parse(entry.payload)).sequence
        : 0;
      const session = this.#session(context);
      const result = await this.#notifications.list({
        ...session,
        filter: 'all',
        afterSequence,
        limit: 100,
      });
      if (
        !result.ok ||
        !this.#current(context) ||
        result.data.latest_sequence <= afterSequence
      )
        return;
      // OS 배너는 부가 안내다. 선기록으로 재시작 중복을 줄이고 서버의 읽음·승인은 변경하지 않는다.
      await writeProcessJournal(
        this.#recovery,
        context,
        'notification-delivery',
        'os-cursor',
        { sequence: result.data.latest_sequence },
        entry?.revision ?? null,
      );
      if (!this.#current(context)) return;
      const items = result.data.items.filter(
        (item: NotificationItem): boolean =>
          item.read_at === null && !item.blocked_reason,
      );
      const first = items[0];
      if (!first) return;
      const labels = {
        approval_required: '문자 확인이 필요합니다',
        completed: '처리가 완료되었습니다',
        failed: '처리 상태를 확인해 주세요',
        stopped: '처리가 중단되었습니다',
      };
      this.#close?.();
      this.#close = this.#present(
        {
          title:
            items.length > 1
              ? 'LLM Wiki에 새 알림이 있습니다'
              : labels[first.kind],
          body:
            items.length > 1
              ? `${first.title} 외 새 알림을 알림 화면에서 확인해 주세요.`
              : first.title,
        },
        (): void => {
          void this.#openCurrent(context, session, first.workflow_id);
        },
      );
    } catch {
      // 저장소·네트워크·OS 실패가 서버 알림과 개인 작업의 성공을 바꾸지 않는다.
    } finally {
      this.#pending = false;
    }
  }

  /** 클릭은 현재 권한으로 상세를 다시 조회한 뒤 화면만 열며 작업을 실행하지 않습니다. */
  async #openCurrent(
    context: AnalysisContext,
    session: NotificationSession,
    workflowId: string,
  ): Promise<void> {
    if (!this.#current(context) || !/^[0-9a-f]{32}$/.test(workflowId)) return;
    try {
      const detail = await this.#notifications.read({ ...session, workflowId });
      if (detail.ok && this.#current(context)) this.#open(workflowId);
    } catch {
      // 이미 로그아웃했거나 연결할 수 없으면 이전 사용자 화면을 열지 않는다.
    }
  }

  /** 실제 종료 시 타이머와 배너를 정리하고 늦은 클릭을 차단합니다. */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#close?.();
    this.#close = null;
  }
}

import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { NotificationDelivery } from '@main/backend/NotificationDelivery';
import type { NotificationMessage } from '@main/backend/NotificationDelivery';
import type {
  AnalysisContext,
  ConnectionService,
} from '@main/backend/ConnectionService';
import type { ProcessRecovery } from '@main/backend/processRecovery';
import type {
  RecoveryEntry,
  RecoveryKind,
  RecoveryResult,
} from '@contracts/recovery.contract';
import type {
  NotificationsBridge,
  NotificationItem,
  NotificationListRequest,
  NotificationListResult,
  NotificationDetailResult,
} from '@contracts/notifications.contract';
import type { ConnectionResult } from '@contracts/connection.contract';

/** 합성 서버 결과로 OS 표시가 읽음·승인·실행을 만들지 않는지 확인합니다. */
export async function verifyNotificationDelivery(): Promise<void> {
  const revision = 'a'.repeat(64),
    workflowId = '1'.repeat(32),
    notificationId = '2'.repeat(32);
  const context: AnalysisContext = {
    active: {
      status: 'connected',
      connectionId: 'session',
      serverUrl: 'https://example.test/api/v1/',
      userId: 'alice',
      policyRevision: revision,
      workspaces: [],
      selection: { tenant: 'team', profile: 'default' },
      checkedAt: '2026-11-24T00:00:00Z',
    },
    selection: { tenant: 'team', profile: 'default' },
    generation: 1,
    token: 'fixture-private-token',
  };
  const source = {
    source_id: '3'.repeat(32),
    source_version: '4'.repeat(32),
    source_sha256: revision,
    registration_revision: revision,
  };
  const access = {
    user_id: 'alice',
    tenant: 'team',
    profile_id: 'default',
    policy_revision: revision,
  };
  let current = true,
    sequence = 1,
    denied = false,
    reads = 0,
    shown = 0;
  const opened: string[] = [],
    clicks: (() => void)[] = [];
  const entries: RecoveryEntry[] = [];
  const connection: Pick<
    ConnectionService,
    'getState' | 'analysisContext' | 'isAnalysisCurrent' | 'onScopeChanged'
  > = {
    getState: (): ConnectionResult => ({ ok: true, data: context.active }),
    analysisContext: async (): Promise<AnalysisContext> => context,
    isAnalysisCurrent: (): boolean => current,
    onScopeChanged: (): void => {},
  };
  const recovery: ProcessRecovery = {
    readContext: async (): Promise<RecoveryResult> => ({
      ok: true,
      data: { entries, cleanupWarningCount: 0 },
    }),
    capture: async (
      _context: AnalysisContext,
      kind: RecoveryKind,
      key: string,
      payload: string,
      expectedRevision: string | null,
    ): Promise<RecoveryResult> => {
      assert.equal(kind, 'notification-delivery');
      assert.equal(expectedRevision, entries[0]?.revision ?? null);
      entries.splice(0, entries.length, {
        kind,
        key,
        payload,
        revision: String(sequence).padStart(64, '0'),
        savedAt: '2026-11-24T00:00:00Z',
      });
      assert.ok(!payload.includes(context.token));
      return { ok: true, data: { entries, cleanupWarningCount: 0 } };
    },
    execute: async (): Promise<RecoveryResult> => {
      throw new Error('OS delivery must not delete server data');
    },
  };
  const notifications: Pick<NotificationsBridge, 'list' | 'read'> = {
    list: async (
      request: NotificationListRequest,
    ): Promise<NotificationListResult> => {
      const item: NotificationItem = {
        notification_id: notificationId,
        workflow_id: workflowId,
        sequence,
        kind: 'approval_required',
        created_at: '2026-11-24T00:00:00Z',
        read_at: null,
        title: '검사 PDF',
        state: 'review',
        warning_count: 2,
        source_ref: source,
        conversion_ref: null,
      };
      return {
        ok: true,
        data: {
          items: (request.afterSequence ?? 0) < sequence ? [item] : [],
          latest_sequence: sequence,
          next_cursor: null,
          unread_count: 1,
          approval_count: 1,
          access,
        },
      };
    },
    read: async (): Promise<NotificationDetailResult> => {
      reads += 1;
      if (denied)
        return {
          ok: false,
          error: { code: 'access_denied', message: 'denied' },
        };
      return {
        ok: true,
        data: {
          access,
          conversion: null,
          events: [],
          workflow: {
            workflow_id: workflowId,
            revision,
            source_ref: source,
            conversion_ref: null,
            title: '검사 PDF',
            target_document: 'test.md',
            state: 'review',
            pages: [{ page: 1, state: 'pending' }],
            approval: null,
            execution: null,
            resume_request_id: '5'.repeat(32),
            created_at: '2026-11-24T00:00:00Z',
            updated_at: '2026-11-24T00:00:00Z',
          },
        },
      };
    },
  };
  /** OS 어댑터만 대체하고 표시·조회·복구 저장의 실제 제어 흐름을 사용합니다. */
  function delivery(fail: boolean = false): NotificationDelivery {
    return new NotificationDelivery(
      connection,
      notifications,
      recovery,
      (_message: NotificationMessage, open: () => void): (() => void) => {
        if (fail) throw new Error('OS notification denied');
        shown += 1;
        clicks.push(open);
        return (): void => {};
      },
      (id: string): void => {
        opened.push(id);
      },
    );
  }
  const first = delivery();
  await first.tick();
  await first.tick();
  assert.equal(shown, 1);
  assert.equal(reads, 0);
  clicks[0]?.();
  await setImmediate();
  assert.deepEqual(opened, [workflowId]);
  first.dispose();
  const restarted = delivery();
  await restarted.tick();
  assert.equal(shown, 1, 'restart must not repeat the delivered banner');
  sequence += 1;
  await restarted.tick();
  assert.equal(shown, 2);
  current = false;
  clicks[1]?.();
  await setImmediate();
  assert.equal(reads, 1, 'old scope must not query or navigate');
  current = true;
  denied = true;
  clicks[1]?.();
  await setImmediate();
  assert.equal(opened.length, 1, 'a denied lookup must not navigate');
  restarted.dispose();
  sequence += 1;
  const unavailable = delivery(true);
  await unavailable.tick();
  assert.equal(JSON.parse(entries[0]!.payload).sequence, sequence);
  unavailable.dispose();
}

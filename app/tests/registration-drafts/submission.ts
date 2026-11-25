import assert from 'node:assert/strict';
import {
  RegistrationContentSubmission,
  registrationSubmissionSnapshotSchema,
} from '@renderer/features/review-source-notifications/model/RegistrationContentSubmission';
import type { RegistrationSubmissionSnapshot } from '@renderer/features/review-source-notifications/model/RegistrationContentSubmission';
import type {
  NotificationDetailResult,
  NotificationCorrectRequest,
  NotificationDecideRequest,
  NotificationApproveRequest,
  NotificationContinueRequest,
  NotificationMutationResult,
  NotificationReadRequest,
  NotificationInspectionResult,
  NotificationContinueResult,
} from '@contracts/notifications.contract';

type Detail = Extract<NotificationDetailResult, { ok: true }>['data'];
type Options = ConstructorParameters<typeof RegistrationContentSubmission>[0];
type Mutation =
  | NotificationCorrectRequest
  | NotificationDecideRequest
  | NotificationApproveRequest
  | NotificationContinueRequest;
const revision = 'a'.repeat(64);
const workflowId = '1'.repeat(32);
const source = {
  source_id: '2'.repeat(32),
  source_version: '3'.repeat(32),
  source_sha256: revision,
  registration_revision: revision,
};
const access = {
  user_id: 'author',
  tenant: 'space',
  profile_id: 'default',
  policy_revision: revision,
};
const time = '2026-11-25T00:00:00Z';

/** 실제 수정/확인/등록 계약으로 응답 유실과 재인증 뒤 같은 요청 재개를 검증합니다. */
export async function verifySubmissionRecovery(): Promise<void> {
  for (const lost of ['correct', 'decide', 'approve', 'continue']) {
    const detail: Detail = {
      access,
      events: [],
      corrections: [],
      conversion: {
        revision,
        manifest: {
          id: workflowId,
          source_ref: source,
          method: 'ocr',
          complete: false,
          unread_ranges: ['page 1: low confidence'],
          warnings: [],
          units: [
            {
              unit_id: 'page_1',
              location: { kind: 'pages', start: 1, end: 1 },
            },
          ],
        },
        components: { page_1: 'x'.repeat(20 * 1024 * 1024) },
      },
      workflow: {
        workflow_id: workflowId,
        revision,
        source_ref: source,
        conversion_ref: {
          conversion_id: workflowId,
          conversion_revision: revision,
        },
        title: 'isolated',
        target_document: 'isolated.md',
        state: 'review',
        pages: [{ page: 1, state: 'pending' }],
        approval: null,
        execution: null,
        resume_request_id: '4'.repeat(32),
        created_at: time,
        updated_at: time,
      },
    };
    let connectionId = 'initial-session';
    let count = 0;
    const receipts = new Map<string, string>();
    const writes: Array<{ kind: string; request: Mutation }> = [];
    let snapshot: RegistrationSubmissionSnapshot | null = null;
    let published = 0;
    let firstLost = true;
    const check = (request: NotificationReadRequest): void => {
      assert.equal(request.connectionId, connectionId);
      assert.equal(request.workflowId, workflowId);
    };
    const begin = (kind: string, request: Mutation): boolean => {
      check(request);
      writes.push({ kind, request: structuredClone(request) });
      const {
        connectionId: _connection,
        expectedScope: _scope,
        ...body
      } = request;
      const saved = receipts.get(request.requestId);
      if (saved) {
        assert.equal(saved, JSON.stringify(body));
        return false;
      }
      assert.equal(request.expectedRevision, detail.workflow.revision);
      receipts.set(request.requestId, JSON.stringify(body));
      detail.workflow.revision = (++count).toString(16).padStart(64, '0');
      return true;
    };
    const finish = (kind: string): NotificationMutationResult => {
      if (lost === kind && firstLost) {
        firstLost = false;
        throw new Error('lost response after commit');
      }
      return {
        ok: true,
        data: {
          workflow: structuredClone(detail.workflow),
          replayed: false,
          access,
        },
      };
    };
    const api: Options['api'] = {
      inspect: async (
        request: NotificationReadRequest,
      ): Promise<NotificationInspectionResult> => {
        check(request);
        return {
          ok: true,
          data: {
            ready: true,
            blockers: [],
            deviceId: '5'.repeat(32),
            deviceName: 'isolated',
            checkedAt: time,
          },
        };
      },
      read: async (
        request: NotificationReadRequest,
      ): Promise<NotificationDetailResult> => {
        check(request);
        return { ok: true, data: structuredClone(detail) };
      },
      correct: async (
        request: NotificationCorrectRequest,
      ): Promise<NotificationMutationResult> => {
        if (begin('correct', request)) {
          const correction_ref = {
            correction_id: request.requestId,
            correction_revision: detail.workflow.revision,
          };
          detail.workflow.pages = [
            { page: 1, state: 'pending', correction_ref },
          ];
          detail.corrections = [
            {
              page: 1,
              correction_ref,
              content: request.content,
              method: request.method,
              warnings: request.warnings ?? [],
              created_at: time,
            },
          ];
        }
        return finish('correct');
      },
      decide: async (
        request: NotificationDecideRequest,
      ): Promise<NotificationMutationResult> => {
        if (begin('decide', request))
          detail.workflow.pages = detail.workflow.pages.map(
            (
              page: Detail['workflow']['pages'][number],
            ): Detail['workflow']['pages'][number] => ({
              ...page,
              state: 'usable',
            }),
          );
        return finish('decide');
      },
      approve: async (
        request: NotificationApproveRequest,
      ): Promise<NotificationMutationResult> => {
        if (begin('approve', request)) detail.workflow.state = 'approved';
        return finish('approve');
      },
      continue: async (
        request: NotificationContinueRequest,
      ): Promise<NotificationContinueResult> => {
        if (begin('continue', request)) detail.workflow.state = 'running';
        finish('continue');
        return {
          ok: true,
          data: {
            workflow: structuredClone(detail.workflow),
            jobId: '6'.repeat(32),
            started: true,
          },
        };
      },
    };
    const options: Options = {
      scope: {
        connectionId,
        userId: access.user_id,
        tenant: access.tenant,
        profileId: access.profile_id,
        policyRevision: revision,
      },
      detail: structuredClone(detail),
      drafts: [{ page: 1, content: 'edited', method: 'manual', warnings: [] }],
      targetDocument: 'isolated.md',
      api,
      isCurrent: (): boolean => true,
      onAccessLost: (): void => {},
      onDetail: (): void => {
        published += 1;
      },
      onPhase: (): void => {},
      persist: async (value: RegistrationSubmissionSnapshot): Promise<void> => {
        snapshot = structuredClone(value);
      },
    };
    const unsent = new RegistrationContentSubmission({
      ...options,
      persist: async (): Promise<void> => {
        throw new Error('local snapshot failed');
      },
    });
    await assert.rejects(unsent.submit(), /local snapshot failed/);
    assert.equal(unsent.canEditBeforeSending(), true);
    assert.equal(writes.length, 0);
    const conservative = RegistrationContentSubmission.restore(
      options,
      unsent.snapshot(),
    );
    assert.equal(conservative.canEditBeforeSending(), false);
    const first = new RegistrationContentSubmission(options);
    await assert.rejects(first.submit(), /lost response/);
    assert.equal(first.canEditBeforeSending(), false);
    assert.ok(snapshot);
    const saved = registrationSubmissionSnapshotSchema.parse(snapshot);
    assert.ok(JSON.stringify(saved).length < 20000);
    assert.deepEqual(saved.initialDetail.conversion?.components, {});
    assert.deepEqual(saved.detail.conversion?.components, {});
    assert.equal(saved.drafts[0]?.content, 'edited');
    assert.ok(saved.pending);
    const pendingId = saved.pending.request.requestId;
    const pendingRevision = saved.pending.request.expectedRevision;
    connectionId = 'reconnected-session';
    const restoredOptions = {
      ...options,
      scope: { ...options.scope, connectionId },
      detail: structuredClone(detail),
    };
    const beforeRestore = published;
    const restored = RegistrationContentSubmission.restore(
      restoredOptions,
      saved,
    );
    assert.equal(published, beforeRestore);
    assert.equal(restored.snapshot().pending?.request.requestId, pendingId);
    assert.equal(
      restored.snapshot().pending?.request.expectedRevision,
      pendingRevision,
    );
    assert.equal(await restored.submit(), '6'.repeat(32));
    assert.equal(
      new Set(
        writes
          .filter(
            (write: { kind: string; request: Mutation }): boolean =>
              write.kind === lost,
          )
          .map(
            (write: { kind: string; request: Mutation }): string =>
              write.request.requestId,
          ),
      ).size,
      1,
    );
    assert.equal(detail.corrections.length, 1);
    for (const changed of [
      {
        ...restoredOptions,
        detail: {
          ...restoredOptions.detail,
          workflow: {
            ...restoredOptions.detail.workflow,
            source_ref: { ...source, source_version: '9'.repeat(32) },
          },
        },
      },
      {
        ...restoredOptions,
        detail: {
          ...restoredOptions.detail,
          workflow: {
            ...restoredOptions.detail.workflow,
            conversion_ref: {
              conversion_id: '9'.repeat(32),
              conversion_revision: revision,
            },
          },
        },
      },
      {
        ...restoredOptions,
        scope: { ...restoredOptions.scope, userId: 'another-account' },
      },
    ])
      assert.throws(
        (): RegistrationContentSubmission =>
          RegistrationContentSubmission.restore(changed, saved),
        /현재 문서와 다릅니다/,
      );
  }
  console.log(
    'Submission restart: correction/decision/approval/continue response loss replays original IDs and basis with reauthenticated connection; foreign source/report/account rejected.',
  );
}

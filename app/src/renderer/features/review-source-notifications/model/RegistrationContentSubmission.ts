import { z } from 'zod';
import { sameAccessRevision } from '@contracts/connection.contract';
import {
  notificationCorrectSchema,
  notificationDecideSchema,
  notificationApproveSchema,
  notificationContinueSchema,
  notificationDetailDataSchema,
  notificationLocation,
  notificationLocationKey,
} from '@contracts/notifications.contract';
import type {
  NotificationApproveRequest,
  NotificationContinueRequest,
  NotificationCorrectRequest,
  NotificationDecideRequest,
  NotificationWorkflow,
  NotificationsBridge,
  NotificationLocation,
} from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import {
  notificationAccessLost,
  notificationRequestId,
  notificationSession,
  contentText,
} from './notificationView';
import type { NotificationDetail, ReviewPage } from './notificationView';

export type ContentDraft = NotificationLocation & {
  content: string;
  method: 'manual' | 'ocr' | 'blank';
  warnings: string[];
};
export type SubmissionPhase = 'saving' | 'confirming' | 'continuing';
type SubmissionApi = Pick<
  NotificationsBridge,
  'read' | 'correct' | 'decide' | 'approve' | 'inspect' | 'continue'
>;
type SubmissionOptions = {
  scope: SourceConversionScope;
  detail: NotificationDetail;
  drafts: ContentDraft[];
  targetDocument: string;
  api: SubmissionApi;
  isCurrent: () => boolean;
  onAccessLost: () => void;
  onDetail: (detail: NotificationDetail) => void;
  onPhase: (phase: SubmissionPhase) => void;
  persist?: (snapshot: RegistrationSubmissionSnapshot) => Promise<void>;
};
type PendingStep =
  | { kind: 'correct'; request: NotificationCorrectRequest }
  | { kind: 'decide'; request: NotificationDecideRequest }
  | { kind: 'approve'; request: NotificationApproveRequest }
  | { kind: 'continue'; request: NotificationContinueRequest };

const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('correct'), request: notificationCorrectSchema }),
  z.object({ kind: z.literal('decide'), request: notificationDecideSchema }),
  z.object({ kind: z.literal('approve'), request: notificationApproveSchema }),
  z.object({
    kind: z.literal('continue'),
    request: notificationContinueSchema,
  }),
]);
export const registrationSubmissionSnapshotSchema = z.object({
  version: z.literal(1),
  initialDetail: notificationDetailDataSchema,
  detail: notificationDetailDataSchema,
  drafts: z.array(
    z.object({
      page: notificationCorrectSchema.shape.page,
      unit_id: notificationCorrectSchema.shape.unit_id,
      whole_document: notificationCorrectSchema.shape.whole_document,
      content: notificationCorrectSchema.shape.content,
      method: notificationCorrectSchema.shape.method,
      warnings: notificationCorrectSchema.shape.warnings,
    }),
  ),
  targetDocument: z.string(),
  index: z.number().int().nonnegative(),
  pending: pendingSchema.nullable(),
  confirmCorrection: notificationCorrectSchema.nullable(),
  decided: z.boolean(),
  approved: z.boolean(),
  jobId: z.string().nullable(),
});
export type RegistrationSubmissionSnapshot = z.infer<
  typeof registrationSubmissionSnapshotSchema
>;

/** 변환 보고의 누락은 명시 입력으로 해소하며 원래 보고를 바꾸지 않습니다. */
export function canUseRegistrationContent(detail: NotificationDetail): boolean {
  return (
    !!detail.workflow.conversion_ref &&
    !!detail.conversion &&
    detail.workflow.pages.length > 0
  );
}

/** 불변 보고는 참조만 남기고 사용자가 제출할 문자는 drafts에 한 번만 보관합니다. */
function submissionMetadata(detail: NotificationDetail): NotificationDetail {
  return structuredClone({
    ...detail,
    conversion: detail.conversion
      ? { ...detail.conversion, components: {} }
      : null,
    corrections: detail.corrections.map(
      (
        correction: NotificationDetail['corrections'][number],
      ): NotificationDetail['corrections'][number] => ({
        ...correction,
        content: '',
      }),
    ),
  });
}

/** 한 번 선택한 내용과 요청을 고정하고 저장 확인을 받은 단계 다음부터만 이어갑니다. */
export class RegistrationContentSubmission {
  readonly #options: SubmissionOptions;
  readonly #drafts: ContentDraft[];
  #detail: NotificationDetail;
  #index = 0;
  #pending: PendingStep | null = null;
  #confirmCorrection: NotificationCorrectRequest | null = null;
  #decided = false;
  #approved = false;
  #busy = false;
  #serverMutationStarted = false;
  #jobId: string | null = null;

  constructor(options: SubmissionOptions) {
    this.#options = options;
    this.#detail = structuredClone(options.detail);
    this.#drafts = structuredClone(options.drafts);
    const workflow = this.#detail.workflow;
    if (workflow.blocked_reason)
      throw new Error(
        '원본이나 변환 내용이 바뀌었습니다. 최신 문서를 확인해 주세요.',
      );
    if (workflow.state === 'review') {
      if (!canUseRegistrationContent(this.#detail))
        throw new Error(
          '보관한 문자가 없는 페이지는 이 화면에서 등록을 계속할 수 없습니다. 문서의 문자 변환 상태를 확인해 주세요.',
        );
      const seen = new Set<string>();
      for (const draft of this.#drafts) {
        const key = notificationLocationKey(draft);
        if (seen.has(key))
          throw new Error('같은 위치의 입력이 중복되었습니다.');
        seen.add(key);
        const parsed = notificationCorrectSchema.safeParse({
          ...notificationSession(options.scope),
          workflowId: workflow.workflow_id,
          requestId: notificationRequestId(),
          expectedRevision: workflow.revision,
          ...draft,
        });
        if (!parsed.success)
          throw new Error(
            '등록할 내용을 입력하거나 실제로 빈 페이지인지 확인해 주세요.',
          );
      }
    } else {
      if (
        this.#drafts.length ||
        !['approved', 'claimed', 'failed', 'stopped'].includes(workflow.state)
      )
        throw new Error('현재 진행 상태에서는 내용을 새로 제출할 수 없습니다.');
      this.#decided = true;
      this.#approved = true;
    }
  }

  /** 종료 전에 고정 요청과 처리 위치를 보관해 같은 요청으로만 복원합니다. */
  snapshot(): RegistrationSubmissionSnapshot {
    return {
      version: 1,
      initialDetail: submissionMetadata(this.#options.detail),
      detail: submissionMetadata(this.#detail),
      drafts: structuredClone(this.#drafts),
      targetDocument: this.#options.targetDocument,
      index: this.#index,
      pending: this.#pending,
      confirmCorrection: this.#confirmCorrection,
      decided: this.#decided,
      approved: this.#approved,
      jobId: this.#jobId,
    };
  }

  /** 같은 실행에서 서버 변경 요청을 보내지 않았음이 확실할 때만 편집을 다시 허용합니다. */
  canEditBeforeSending(): boolean {
    return !this.#busy && !this.#serverMutationStarted;
  }

  /** 보호 저장소가 돌려준 상태도 다시 검증하고 원래 원본 기준으로 복원합니다. */
  static restore(
    options: SubmissionOptions,
    value: unknown,
  ): RegistrationContentSubmission {
    const saved = registrationSubmissionSnapshotSchema.parse(value);
    const current = options.detail.workflow;
    const original = saved.initialDetail.workflow;
    const currentSource = current.source_ref;
    const originalSource = original.source_ref;
    const access = saved.initialDetail.access;
    if (
      current.blocked_reason ||
      current.workflow_id !== original.workflow_id ||
      currentSource.source_id !== originalSource.source_id ||
      currentSource.source_version !== originalSource.source_version ||
      currentSource.source_sha256 !== originalSource.source_sha256 ||
      currentSource.registration_revision !==
        originalSource.registration_revision ||
      current.conversion_ref?.conversion_id !==
        original.conversion_ref?.conversion_id ||
      current.conversion_ref?.conversion_revision !==
        original.conversion_ref?.conversion_revision ||
      access.user_id !== options.scope.userId ||
      access.tenant !== options.scope.tenant ||
      access.profile_id !== options.scope.profileId ||
      !sameAccessRevision(
        {
          policyRevision: access.policy_revision,
          accessRevision: access.access_revision ?? undefined,
        },
        options.scope,
      ) ||
      (current.target_document &&
        current.target_document !== saved.targetDocument)
    )
      throw new Error(
        '저장한 제출의 원본·변환·접근 범위가 현재 문서와 다릅니다. 초안은 보존되어 있습니다.',
      );
    const session = notificationSession(options.scope);
    // 재인증으로 바뀐 연결 문맥만 결합하고 최초 요청 ID·본문·CAS 기준은 그대로 둡니다.
    const reconnect = <
      T extends
        | NotificationCorrectRequest
        | NotificationDecideRequest
        | NotificationApproveRequest
        | NotificationContinueRequest,
    >(
      request: T,
    ): T => {
      if (
        request.workflowId !== current.workflow_id ||
        request.expectedScope.userId !== session.expectedScope.userId ||
        request.expectedScope.tenant !== session.expectedScope.tenant ||
        request.expectedScope.profileId !== session.expectedScope.profileId ||
        !sameAccessRevision(request.expectedScope, session.expectedScope)
      )
        throw new Error('저장한 요청의 접근 범위가 현재 문서와 다릅니다.');
      return { ...request, ...session };
    };
    const submission = new RegistrationContentSubmission({
      ...options,
      detail: saved.initialDetail,
      drafts: saved.drafts.map(
        (
          draft: RegistrationSubmissionSnapshot['drafts'][number],
        ): ContentDraft => ({
          ...draft,
          warnings: draft.warnings ?? [],
        }),
      ),
      targetDocument: saved.targetDocument,
    });
    // 저장 직후 종료됐을 수 있으므로 복원만으로 서버 미전송을 추측하지 않습니다.
    submission.#serverMutationStarted = true;
    submission.#accept(saved.detail.workflow, false);
    // 화면은 현재 서버 본문을 유지하고 내부 요청 CAS만 저장 당시 위치로 복원합니다.
    submission.#detail = {
      ...saved.detail,
      conversion: options.detail.conversion,
      corrections: options.detail.corrections,
    };
    submission.#index = saved.index;
    switch (saved.pending?.kind) {
      case 'correct':
        submission.#pending = {
          kind: 'correct',
          request: reconnect(saved.pending.request),
        };
        break;
      case 'decide':
        submission.#pending = {
          kind: 'decide',
          request: reconnect(saved.pending.request),
        };
        break;
      case 'approve':
        submission.#pending = {
          kind: 'approve',
          request: reconnect(saved.pending.request),
        };
        break;
      case 'continue':
        submission.#pending = {
          kind: 'continue',
          request: reconnect(saved.pending.request),
        };
        break;
    }
    submission.#confirmCorrection = saved.confirmCorrection
      ? reconnect(saved.confirmCorrection)
      : null;
    submission.#decided = saved.decided;
    submission.#approved = saved.approved;
    submission.#jobId = saved.jobId;
    if (saved.index > saved.drafts.length)
      throw new Error('저장된 입력의 처리 위치를 확인하지 못했습니다.');
    return submission;
  }

  /** 저장 실패 시 다음 서버 변경을 시작하지 않습니다. */
  async #persist(): Promise<void> {
    this.#checkCurrent();
    await this.#options.persist?.(this.snapshot());
    this.#checkCurrent();
  }

  /** 늦게 도착한 응답이 다른 사용자·문서의 후속 저장을 시작하지 못하게 합니다. */
  #checkCurrent(): void {
    if (!this.#options.isCurrent())
      throw new Error('등록 화면의 접근 범위가 변경되었습니다.');
  }

  /** 서버 실패의 접근 거부와 저장 미확인을 구분하고 원래 요청은 그대로 보관합니다. */
  #data<T>(
    result:
      | { ok: true; data: T }
      | {
          ok: false;
          error: { code: string; message: string; status?: number };
        },
  ): T {
    this.#checkCurrent();
    if (!result.ok) {
      if (notificationAccessLost(result.error)) this.#options.onAccessLost();
      throw new Error(result.error.message);
    }
    return result.data;
  }

  /** 성공 응답의 원본·보고·목적지가 최초 선택과 같은지 재확인합니다. */
  #accept(workflow: NotificationWorkflow, publish: boolean = true): void {
    const fixed = this.#options.detail.workflow;
    if (
      workflow.workflow_id !== fixed.workflow_id ||
      JSON.stringify(workflow.source_ref) !==
        JSON.stringify(fixed.source_ref) ||
      JSON.stringify(workflow.conversion_ref) !==
        JSON.stringify(fixed.conversion_ref) ||
      workflow.blocked_reason ||
      (workflow.target_document &&
        workflow.target_document !== this.#options.targetDocument)
    )
      throw new Error(
        '등록할 원본이나 저장 대상이 변경되었습니다. 입력은 보존되어 있습니다.',
      );
    this.#detail = { ...this.#detail, workflow };
    if (publish) this.#options.onDetail(this.#detail);
  }

  /** 각 단계는 최초 ID·판본·본문을 재사용하므로 응답 유실 뒤 다른 쓰기로 바뀌지 않습니다. */
  #mutation(): { requestId: string; expectedRevision: string } {
    return {
      requestId: notificationRequestId(),
      expectedRevision: this.#detail.workflow.revision,
    };
  }

  /** 조회만으로는 호출하지 않으며 사용자의 단일 등록 계속 동작에서만 실행합니다. */
  async submit(): Promise<string | null> {
    if (this.#busy) return null;
    if (this.#jobId) return this.#jobId;
    this.#busy = true;
    const session = notificationSession(this.#options.scope);
    const workflowId = this.#detail.workflow.workflow_id;
    try {
      this.#checkCurrent();
      const ready = this.#data(
        await this.#options.api.inspect({ ...session, workflowId }),
      );
      if (!ready.ready)
        throw new Error(
          ready.blockers.join(' ') || 'AI 연결 상태를 확인해 주세요.',
        );
      while (this.#index < this.#drafts.length) {
        const draft = this.#drafts[this.#index];
        if (!draft) break;
        this.#options.onPhase('saving');
        if (!this.#confirmCorrection) {
          this.#pending ??= {
            kind: 'correct',
            request: { ...session, workflowId, ...this.#mutation(), ...draft },
          };
          if (this.#pending.kind !== 'correct')
            throw new Error('수정 저장 순서를 확인하지 못했습니다.');
          const request = this.#pending.request;
          await this.#persist();
          this.#serverMutationStarted = true;
          this.#accept(
            this.#data(await this.#options.api.correct(request)).workflow,
          );
          this.#confirmCorrection = request;
          this.#pending = null;
        }
        const confirmed = this.#data(
          await this.#options.api.read({ ...session, workflowId }),
        );
        if (
          confirmed.workflow.revision !== this.#detail.workflow.revision ||
          contentText(confirmed, draft) !== draft.content
        )
          throw new Error(
            '저장된 내용이 변경되었습니다. 입력을 보존했으니 최신 내용과 비교해 주세요.',
          );
        this.#accept(confirmed.workflow);
        this.#detail = confirmed;
        this.#options.onDetail(confirmed);
        this.#confirmCorrection = null;
        this.#index += 1;
        await this.#persist();
      }
      while (!this.#decided) {
        this.#options.onPhase('confirming');
        this.#pending ??= {
          kind: 'decide',
          request: {
            ...session,
            workflowId,
            ...this.#mutation(),
            decisions: this.#detail.workflow.pages
              .filter(
                (page: ReviewPage): boolean =>
                  page.state !== 'usable' &&
                  (!this.#detail.workflow.pages.some(
                    (entry: ReviewPage): boolean =>
                      !!entry.whole_document && !!entry.correction_ref,
                  ) ||
                    !!page.whole_document),
              )
              .slice(0, 100)
              .map(
                (
                  page: ReviewPage,
                ): NotificationDecideRequest['decisions'][number] => ({
                  ...notificationLocation(page),
                  state: 'usable',
                  ...(page.correction_ref
                    ? { correction_ref: page.correction_ref }
                    : {}),
                }),
              ),
          },
        };
        if (
          this.#pending.kind === 'decide' &&
          this.#pending.request.decisions.length === 0
        ) {
          this.#pending = null;
          this.#decided = true;
          await this.#persist();
          break;
        }
        if (this.#pending.kind !== 'decide')
          throw new Error('내용 확인 순서를 확인하지 못했습니다.');
        const request = this.#pending.request;
        await this.#persist();
        this.#serverMutationStarted = true;
        this.#accept(
          this.#data(await this.#options.api.decide(request)).workflow,
        );
        if (
          request.decisions.some(
            (
              selected: NotificationDecideRequest['decisions'][number],
            ): boolean => {
              const current = this.#detail.workflow.pages.find(
                (page: ReviewPage): boolean =>
                  notificationLocationKey(page) ===
                  notificationLocationKey(selected),
              );
              return (
                !current ||
                current.state !== 'usable' ||
                current.correction_ref?.correction_id !==
                  selected.correction_ref?.correction_id ||
                current.correction_ref?.correction_revision !==
                  selected.correction_ref?.correction_revision
              );
            },
          )
        )
          throw new Error('등록할 내용의 확인 결과가 변경되었습니다.');
        this.#pending = null;
        await this.#persist();
      }
      if (!this.#approved) {
        this.#options.onPhase('confirming');
        this.#pending ??= {
          kind: 'approve',
          request: {
            ...session,
            workflowId,
            ...this.#mutation(),
            targetDocument: this.#options.targetDocument,
            ...(this.#detail.workflow.corrections_revision
              ? {
                  correctionsRevision:
                    this.#detail.workflow.corrections_revision,
                }
              : {
                  correctionRefs: this.#detail.workflow.pages.flatMap(
                    (
                      page: ReviewPage,
                    ): NonNullable<
                      NotificationApproveRequest['correctionRefs']
                    > =>
                      page.correction_ref
                        ? [
                            {
                              ...notificationLocation(page),
                              correction_ref: page.correction_ref,
                            },
                          ]
                        : [],
                  ),
                }),
          },
        };
        if (this.#pending.kind !== 'approve')
          throw new Error('등록 내용 확정 순서를 확인하지 못했습니다.');
        await this.#persist();
        this.#serverMutationStarted = true;
        this.#accept(
          this.#data(await this.#options.api.approve(this.#pending.request))
            .workflow,
        );
        this.#pending = null;
        this.#approved = true;
        await this.#persist();
      }
      this.#options.onPhase('continuing');
      this.#pending ??= {
        kind: 'continue',
        request: { ...session, workflowId, ...this.#mutation() },
      };
      if (this.#pending.kind !== 'continue')
        throw new Error('등록 진행 순서를 확인하지 못했습니다.');
      await this.#persist();
      this.#serverMutationStarted = true;
      const continued = this.#data(
        await this.#options.api.continue(this.#pending.request),
      );
      this.#accept(continued.workflow);
      this.#jobId = continued.jobId;
      this.#pending = null;
      await this.#persist();
      return continued.jobId;
    } finally {
      this.#busy = false;
    }
  }
}

import type { AnalysisJob } from '@contracts/analysis.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import type { NotificationContinueResult } from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { notificationsApi } from '../api/notifications.api';
import { notificationRequestId, notificationSession } from './notificationView';

/** 검토한 등록의 재개 실패를 일반 분석 실행으로 우회하지 않도록 명시 결과로 돌려줍니다. */
function failed(code: string, message: string): NotificationContinueResult {
  return { ok: false, error: { code, message } };
}

/** 명시 재개에서만 호출하며 검토한 입력은 기존 journal·새 실행권 발급 경로로 이어갑니다. */
export async function continueReviewedRegistration(
  scope: SourceConversionScope,
  job: AnalysisJob,
  isCurrent: () => boolean,
): Promise<NotificationContinueResult | null> {
  const changed = (): NotificationContinueResult =>
    failed(
      'scope_changed',
      '문서 또는 작업 공간이 변경되었습니다. 현재 문서에서 다시 확인해 주세요.',
    );
  if (!isCurrent()) return changed();
  const reference = job.registration?.conversion_ref;
  if (!reference) return null;
  const session = notificationSession(scope);
  try {
    const result = await notificationsApi.read({
      ...session,
      workflowId: reference.conversion_id,
    });
    if (!isCurrent()) return changed();
    if (!result.ok) return result.error.code === 'not_found' ? null : result;
    const { workflow, access } = result.data;
    if (
      access.tenant !== scope.tenant ||
      access.user_id !== scope.userId ||
      access.profile_id !== scope.profileId ||
      !sameAccessRevision(scope, {
        policyRevision: access.policy_revision,
        ...(access.access_revision
          ? { accessRevision: access.access_revision }
          : {}),
      })
    )
      return changed();
    if (workflow.blocked_reason)
      return failed(
        workflow.blocked_reason,
        '원본이나 변환 내용이 변경되었습니다. 현재 문서의 내용을 확인해 주세요.',
      );
    if (
      workflow.workflow_id !== reference.conversion_id ||
      workflow.conversion_ref?.conversion_id !== reference.conversion_id ||
      workflow.conversion_ref.conversion_revision !==
        reference.conversion_revision ||
      workflow.source_ref.source_id !== job.source_ref.source_id ||
      workflow.source_ref.source_version !== job.source_ref.source_version ||
      workflow.source_ref.source_sha256 !== job.source_ref.source_sha256 ||
      workflow.source_ref.registration_revision !==
        job.source_ref.registration_revision
    )
      return failed(
        'registration_basis_changed',
        '등록할 원본과 변환 기록이 현재 작업과 일치하지 않습니다.',
      );
    if (!workflow.pages.length) return null;
    if (!workflow.approval)
      return failed(
        'content_review_required',
        '등록할 내용을 확인한 뒤 문서 등록을 계속해 주세요.',
      );
    if (
      workflow.execution?.job_id !== job.job_id ||
      workflow.resume_request_id !== job.request_id ||
      job.targets.length !== 1 ||
      workflow.target_document !== job.targets[0]?.document ||
      job.tenant !== scope.tenant ||
      job.user_id !== scope.userId ||
      job.actor.profile_id !== scope.profileId
    )
      return failed(
        'registration_job_changed',
        '내용을 확인한 등록 작업과 현재 문서의 진행 기록이 일치하지 않습니다.',
      );
    if (!isCurrent()) return changed();
    const continued = await notificationsApi.continue({
      ...session,
      workflowId: workflow.workflow_id,
      requestId: notificationRequestId(),
      expectedRevision: workflow.revision,
    });
    if (!isCurrent()) return changed();
    if (
      continued.ok &&
      (continued.data.jobId !== job.job_id ||
        continued.data.workflow.execution?.job_id !== job.job_id ||
        continued.data.workflow.workflow_id !== workflow.workflow_id)
    )
      return failed(
        'registration_job_changed',
        '문서 등록의 재개 결과를 확인하지 못했습니다. 저장 상태를 다시 확인해 주세요.',
      );
    return continued;
  } catch {
    return isCurrent()
      ? failed(
          'registration_resume_unconfirmed',
          '등록 재개 결과를 확인하지 못했습니다. 다시 시작하기 전에 저장 상태를 확인해 주세요.',
        )
      : changed();
  }
}

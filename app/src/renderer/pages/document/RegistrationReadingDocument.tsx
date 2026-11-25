import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import type { AnalysisDetail } from '@contracts/analysis.contract';
import type { DocumentContent } from '@contracts/documents.contract';
import { sameAccessRevision } from '@contracts/connection.contract';
import {
  buildAnalysisProgressView,
  documentTaskApi,
} from '@renderer/features/browse-document-tasks';
import {
  importScopeKey,
  useImportScope,
} from '@renderer/features/import-document-content';
import type { ImportScope } from '@renderer/features/import-document-content';
import { ManageDocumentContent } from '@renderer/features/manage-document-content';
import { useWorkspaceActivity } from '@renderer/shared/lib/workspaceActivity';
import { workflowReturnTo } from '@renderer/shared/lib/workflowNavigation';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './RegistrationReadingDocument.module.scss';

type ReadingProgress = { kind: 'task' | 'job'; id: string; path: string };
type ReadingStatus = 'working' | 'waiting' | 'paused' | 'complete' | 'unknown';
type RegistrationReadingDocumentProps = {
  path: string;
  progress: ReadingProgress;
};
type ScopedRegistrationReadingProps = RegistrationReadingDocumentProps & {
  scope: ImportScope;
};
type ReadingState = { loaded: boolean; notice: ReadingStatus | null };

/** 문서 진행에서 전달한 단일 작업 참조만 읽으며 일반 문서 진입에는 안내를 만들지 않습니다. */
export function registrationReadingReference(
  state: unknown,
): ReadingProgress | null {
  const path = workflowReturnTo(state);
  if (!path?.startsWith('/documents?')) return null;
  const query = new URLSearchParams(path.slice('/documents?'.length));
  const entries = [...query.entries()];
  if (entries.length !== 1) return null;
  const [key, id] = entries[0] ?? [];
  if (
    (key !== 'taskId' && key !== 'jobId') ||
    !id ||
    !/^[a-f0-9]{32}$/.test(id)
  )
    return null;
  return { kind: key === 'taskId' ? 'task' : 'job', id, path };
}

/** 현재 문서·원본 판본·접근 범위가 같은 서버 영수증만 읽기 안내의 근거로 씁니다. */
export function registrationReadingStatus(
  detail: AnalysisDetail,
  document: DocumentContent,
  scope: ImportScope,
): ReadingStatus | null {
  const { job } = detail;
  const source = document.metadata?.source;
  if (
    document.connectionId !== scope.connectionId ||
    document.access.userId !== scope.userId ||
    document.access.tenant !== scope.tenant ||
    document.access.profileId !== scope.profileId ||
    !sameAccessRevision(document.access, scope) ||
    job.user_id !== scope.userId ||
    job.tenant !== scope.tenant ||
    job.actor.profile_id !== scope.profileId ||
    !job.targets.some(
      (target: AnalysisDetail['job']['targets'][number]): boolean =>
        target.document === document.document,
    ) ||
    !job.outputs.includes('wiki') ||
    !job.outputs.includes('ontology') ||
    !source ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    source.id !== job.source_ref.source_id ||
    source.version !== job.source_ref.source_version
  )
    return null;
  const saved = (stage: 'prepare_wiki' | 'extract_ontology'): boolean =>
    detail.receipts.some(
      (receipt: AnalysisDetail['receipts'][number]): boolean =>
        receipt.state === 'complete' &&
        receipt.saved === true &&
        receipt.receipt?.document === document.document &&
        receipt.receipt.stage === stage &&
        receipt.current_output?.status === 'current' &&
        (!receipt.current_output.source_revision ||
          receipt.current_output.source_revision === document.revision),
    );
  if (!saved('prepare_wiki')) return null;
  if (detail.receiptErrors.length > 0) return 'unknown';
  if (
    saved('extract_ontology') &&
    buildAnalysisProgressView(detail).state === 'complete'
  )
    return 'complete';
  if (
    job.state === 'cancelled' ||
    ['blocked', 'failed', 'stopped'].includes(job.reported_status ?? '') ||
    ['failed', 'stopped'].includes(detail.local.status)
  )
    return 'paused';
  return detail.local.status === 'running' || job.lease_status === 'active'
    ? 'working'
    : 'waiting';
}

/** 조회만 수행하며 원본·작업 참조가 다른 기록은 현재 문서에 연결하지 않습니다. */
async function readRegistrationStatus(
  scope: ImportScope,
  path: string,
  progress: ReadingProgress,
): Promise<ReadingStatus | null> {
  const content = await documentTaskApi.readDocument({
    connectionId: scope.connectionId,
    document: path,
  });
  if (!content.ok || content.data.document !== path) return null;
  if (progress.kind === 'job') {
    const result = await documentTaskApi.readAnalysis({
      connectionId: scope.connectionId,
      jobId: progress.id,
    });
    return result.ok && result.data.job.job_id === progress.id
      ? registrationReadingStatus(result.data, content.data, scope)
      : null;
  }
  const result = await documentTaskApi.read({
    connectionId: scope.connectionId,
    expectedScope: {
      userId: scope.userId,
      tenant: scope.tenant,
      profileId: scope.profileId,
      policyRevision: scope.policyRevision,
      ...(scope.accessRevision ? { accessRevision: scope.accessRevision } : {}),
    },
    taskId: progress.id,
  });
  if (!result.ok) return null;
  const { task, analysis, errors } = result.data;
  if (
    !analysis ||
    task.taskId !== progress.id ||
    task.targetDocument !== path ||
    task.registration.jobId !== analysis.job.job_id ||
    task.item.sourceId !== analysis.job.source_ref.source_id ||
    task.item.sourceVersion !== analysis.job.source_ref.source_version ||
    task.item.sourceSha256 !== analysis.job.source_ref.source_sha256 ||
    errors.some(
      (error: (typeof errors)[number]): boolean => error.stage !== 'conversion',
    )
  )
    return null;
  return registrationReadingStatus(analysis, content.data, scope);
}

/** 첫 본문 표시 전에 안내 유무를 결정하고 표시한 자리는 완료 뒤에도 같은 높이로 유지합니다. */
function ScopedRegistrationReading({
  scope,
  path,
  progress,
}: ScopedRegistrationReadingProps): JSX.Element {
  const active = useWorkspaceActivity();
  const [state, setState] = useState<ReadingState>({
    loaded: false,
    notice: null,
  });
  const monitor =
    !state.loaded || (state.notice !== null && state.notice !== 'complete');
  useEffect((): (() => void) => {
    let current = true;
    let pending = false;
    const load = async (): Promise<void> => {
      if (!active || !monitor || pending) return;
      pending = true;
      let status: ReadingStatus | null = null;
      try {
        status = await readRegistrationStatus(scope, path, progress);
      } catch {
        /* 본문 읽기는 진행 조회 실패와 분리합니다. */
      }
      if (current)
        setState((previous: ReadingState): ReadingState => ({
          loaded: true,
          notice: previous.loaded
            ? previous.notice === null
              ? null
              : (status ?? 'unknown')
            : status !== null && status !== 'complete'
              ? status
              : null,
        }));
      pending = false;
    };
    void load();
    const timer =
      active && monitor
        ? window.setInterval((): void => {
            void load();
          }, 4000)
        : null;
    return (): void => {
      current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [active, monitor, path, progress, scope]);
  if (!state.loaded)
    return (
      <p className={styles.loading} role="status">
        문서를 준비하고 있습니다…
      </p>
    );
  const label =
    state.notice === 'complete'
      ? '등록 완료'
      : state.notice === 'paused'
        ? '본문 저장됨 · 온톨로지 구성 중단'
        : state.notice === 'unknown'
          ? '본문 저장됨 · 진행 상태 확인 필요'
          : state.notice === 'waiting'
            ? '본문 저장됨 · 온톨로지 구성 대기'
            : '본문 저장됨 · 온톨로지 구성 중';
  return (
    <>
      {state.notice !== null && (
        <div className={styles.notice} role="status" data-state={state.notice}>
          <Icon
            name={state.notice === 'complete' ? 'circle-check' : 'clock'}
            size={16}
          />
          <span>{label}</span>
          <Link to={progress.path}>진행 상세</Link>
        </div>
      )}
      <ManageDocumentContent path={path} />
    </>
  );
}

/** 계정·공간이 바뀌면 이전 등록 안내를 폐기하고 문서의 기존 읽기 권한 검사를 따릅니다. */
export function RegistrationReadingDocument(
  props: RegistrationReadingDocumentProps,
): JSX.Element {
  const scope = useImportScope();
  if (scope.state.status === 'loading')
    return (
      <p className={styles.loading} role="status">
        문서를 준비하고 있습니다…
      </p>
    );
  if (scope.state.status !== 'ready')
    return <ManageDocumentContent path={props.path} />;
  return (
    <ScopedRegistrationReading
      key={importScopeKey(scope.state.scope)}
      {...props}
      scope={scope.state.scope}
    />
  );
}

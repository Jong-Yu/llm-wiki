import { useMemo } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { ImportDocumentProgress } from '@renderer/features/import-document-content/ui/ImportDocumentProgress';
import { ImportProcessingSession } from '@renderer/features/import-document-content/model/ImportProcessingSession';
import type {
  ImportProcessingApi,
  ImportProcessingSnapshot,
} from '@renderer/features/import-document-content/model/importProcessing.types';
import type { ImportScope } from '@renderer/features/import-document-content/api/importRegistration.api';
import { jobFixture } from './jobFixture';
import { sourceItem, scope } from './libraryFixture';
import { applyPreviewAction } from './previewStore';
import type { PreviewTask } from './model';

const importScope: ImportScope = {
  ...scope,
  canRegister: true,
  canPrepare: true,
  canExtract: true,
};
const blocked = async (): Promise<never> => {
  throw new Error('시안에서 실제 실행은 지원하지 않습니다.');
};
const api: ImportProcessingApi = {
  conversionRead: blocked,
  conversionStart: blocked,
  register: blocked,
  inspectJob: blocked,
  executeJob: blocked,
};

/** 실제 진행 컴포넌트의 입력 상태만 합성하며 제품 실행기는 호출하지 않습니다. */
function baselineSession(task: PreviewTask): ImportProcessingSession {
  const registered = { item: sourceItem(task), cleanupWarningCount: 0 };
  const instance = new ImportProcessingSession(
    importScope,
    registered,
    task.savedWiki ?? '설계/아키텍처-검토.md',
    true,
    api,
  );
  const conversionPhase = task.phase === 'conversion';
  const detail = conversionPhase ? null : jobFixture(task);
  const snapshot: ImportProcessingSnapshot = {
    busy: false,
    phase:
      task.state === 'failed'
        ? 'conversion_failed'
        : task.state === 'running'
          ? conversionPhase
            ? 'converting'
            : 'running'
          : task.state === 'partial'
            ? 'stopped'
            : task.state === 'unconfirmed'
              ? 'planning_unconfirmed'
              : task.state === 'complete'
                ? 'complete'
                : task.state === 'cancelled'
                  ? 'stopped'
                  : 'ready',
    message:
      task.state === 'running'
        ? `${task.completedUnits ?? 0}/${task.totalUnits ?? '?'}쪽 문자 변환 중`
        : task.state === 'unconfirmed'
          ? '분석 접수 결과를 확인하지 못했습니다.'
          : '원본은 보관되어 있습니다.',
    error:
      task.state === 'failed'
        ? '원본은 보관됐지만 전체 본문 변환을 완료하지 못했습니다.'
        : task.state === 'partial'
          ? '관계 추출 실행이 중단됐습니다.'
          : null,
    conversion: conversionPhase
      ? {
          requestId: '9'.repeat(32),
          source: {
            sourceId: task.sourceId,
            sourceVersion: task.version,
            sourceSha256: 'e'.repeat(64),
            registrationRevision: 'e'.repeat(64),
          },
          state: task.state === 'running' ? 'running' : 'partial',
          format: 'pdf',
          progress: {
            stage: 'convert',
            completed: task.completedUnits ?? 0,
            total: task.totalUnits,
          },
          receiptState: task.state === 'running' ? 'pending' : 'saved',
          reference: null,
          message: '원본은 보관되어 있습니다.',
          diagnosticCodes: task.errorCode ? [task.errorCode] : [],
          cleanupWarning: false,
          report:
            task.state === 'running'
              ? null
              : {
                  method: 'ocr',
                  units: [],
                  complete: false,
                  unread_ranges: ['remaining source: worker_failed'],
                  warnings: [],
                  origin: 'client_reported',
                  coverage: 'reported_units_only',
                  original_coverage: 'not_verified',
                  semantic_validation: 'not_run',
                  diagnostics: [],
                  unit_methods: {},
                },
        }
      : null,
    detail,
    canRetryConversion: task.state === 'failed',
    canPrepare: false,
    canExecute: ['ready', 'partial', 'cancelled'].includes(task.state),
    canRefresh: true,
    scopeInvalid: false,
    document: task.savedWiki,
    cleanupWarningCount: 0,
  };
  instance.getSnapshot = (): ImportProcessingSnapshot => snapshot;
  instance.subscribe = (): (() => void) => (): void => {};
  instance.retryConversion = async (): Promise<void> => {
    applyPreviewAction(task.id, 'retry_conversion');
  };
  instance.execute = async (): Promise<void> => {
    applyPreviewAction(task.id, 'inspect_execution');
  };
  instance.refresh = async (): Promise<void> => {};
  return instance;
}

export function BaselineProgress({ task }: { task: PreviewTask }): JSX.Element {
  const navigate = useNavigate();
  const session = useMemo(
    (): ImportProcessingSession => baselineSession(task),
    [task],
  );
  return (
    <ImportDocumentProgress
      scope={importScope}
      registered={{ item: sourceItem(task), cleanupWarningCount: 0 }}
      targetDocument={task.savedWiki ?? '설계/아키텍처-검토.md'}
      session={session}
      onNewRegistration={(): void => {
        void navigate('/register?new=1');
      }}
    />
  );
}

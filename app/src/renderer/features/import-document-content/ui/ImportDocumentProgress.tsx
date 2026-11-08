import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import type { ImportScope } from '../api/importRegistration.api';
import type { CompletedImport } from '../model/ImportRegistrationSession';
import type { ImportDocumentValues } from '../model/importDocument.schema';
import type { ImportProcessingSession } from '../model/ImportProcessingSession';
import { importProcessingSession } from '../model/importProcessingSessions';
import styles from './ImportDocumentContent.module.scss';

type StepView = {
  label: string;
  state: 'done' | 'active' | 'failed' | 'waiting';
  note?: string | undefined;
};

const stepIcons: Record<StepView['state'], IconName> = {
  done: 'circle-check',
  active: 'loader-circle',
  failed: 'circle-alert',
  waiting: 'circle-help',
};
type ProgressAction = {
  id: string;
  available: boolean;
  label: string;
  variant: 'primary' | 'surface';
  run: () => Promise<void>;
};
const actionClasses = {
  primary: `${styles.button} ${styles.primary}`,
  surface: styles.button,
};
const conversionMethods: Record<string, string> = {
  verbatim: '원문 문자 보존',
  pdf_text: 'PDF 문자 읽기',
  ocr: '문자 인식',
  xlsx_values: '스프레드시트 값 읽기',
  docx_text: 'Word 문자 읽기',
};
type ConversionWarningsProps = {
  report: { unread_ranges: string[]; warnings: string[] };
};

/** 보관·대기·실패의 우선순위는 모든 처리 단계에서 같습니다. */
function stepState(
  done: boolean,
  waiting: boolean,
  failed: boolean,
): StepView['state'] {
  if (done) return 'done';
  if (waiting) return 'waiting';
  return failed ? 'failed' : 'active';
}

/** 최초 변환 기록과 현재 변환 보고의 미독·경고를 같은 형식으로 표시합니다. */
function ConversionWarnings({ report }: ConversionWarningsProps): JSX.Element {
  return (
    <>
      {report.unread_ranges.map((range: string, index: number): JSX.Element => (
        <p key={`${index}:${range}`} className={styles.error}>
          미독: {range}
        </p>
      ))}
      {report.warnings.map((warning: string, index: number): JSX.Element => (
        <p key={`${index}:${warning}`}>{warning}</p>
      ))}
    </>
  );
}

type ImportDocumentProgressProps = {
  scope: ImportScope;
  registered: CompletedImport;
  draft: ImportDocumentValues;
  onNewRegistration: () => void;
};

/** 원본 영수증·문자 변환·AI 저장 영수증을 구분하며 후속 단계만 다시 실행합니다. */
export function ImportDocumentProgress({
  scope,
  registered,
  draft,
  onNewRegistration,
}: ImportDocumentProgressProps): JSX.Element {
  const targetDocument = draft.targetDocument;
  const [session] = useState<ImportProcessingSession>(
    (): ImportProcessingSession =>
      importProcessingSession(scope, registered, draft),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const aiRequired = useAiConnection().status === 'required';
  const active =
    state.phase === 'converting' ||
    state.phase === 'running' ||
    state.phase === 'planning';
  useEffect((): (() => void) | undefined => {
    if (!active) return;
    const timer = setInterval((): void => {
      void session.refresh();
    }, 1500);
    return (): void => clearInterval(timer);
  }, [active, session]);

  if (state.scopeInvalid)
    return (
      <section className={styles.notice} role="alert">
        <h2>작업 범위가 변경되었습니다</h2>
        <p>{state.error ?? state.message}</p>
        <p>원본 보관 기록과 진행 중인 요청은 원래 범위에 보존했습니다.</p>
        <Button
          variant="surface"
          type="submit"
          className={styles.button}
          disabled={state.busy}
          onClick={(): void => {
            void session.revalidateScope();
          }}
        >
          원래 작업 범위 재확인
        </Button>
        <Link to="/settings">연결하기</Link>
      </section>
    );
  const conversion = state.conversion;
  const report = state.detail?.job.conversion;
  const savedWiki = state.document;
  const savedOntology =
    state.detail?.receipts.some(
      (
        receipt: NonNullable<typeof state.detail>['receipts'][number],
      ): boolean =>
        receipt.receipt?.stage === 'extract_ontology' &&
        receipt.receipt.document === targetDocument &&
        receipt.state === 'complete' &&
        receipt.saved === true &&
        receipt.current_output?.status === 'current',
    ) ?? false;
  const uncertain =
    state.phase === 'conversion_unconfirmed' ||
    state.phase === 'planning_unconfirmed';
  const progressMessage = (state.error ?? state.message).replaceAll(
    '서버 준비 조건: common_ruleset_required',
    '공통 분석 규약이 설정되지 않았습니다. 서버의 분석 설정을 확인해 주세요.',
  );
  const finished = state.phase === 'complete' && savedOntology;
  const partial = !finished && !!savedWiki && !active && state.phase !== 'idle';
  const plainText = ['md', 'txt'].includes(registered.item.format);
  const converted =
    plainText ||
    (conversion?.state === 'complete' && conversion.receiptState === 'saved');
  const failedStage =
    state.error !== null || state.phase === 'conversion_failed';
  const steps: StepView[] = [
    { label: '원본 보관', state: 'done' },
    {
      label: '문자 변환',
      state: stepState(converted, false, state.phase === 'conversion_failed'),
      note: plainText ? '원문 그대로 사용' : undefined,
    },
    {
      label: '문서 저장',
      state: stepState(!!savedWiki, !converted, failedStage),
    },
    {
      label: '관계 추출',
      state: stepState(
        savedOntology,
        !savedWiki,
        failedStage || state.canExecute || state.phase === 'partial',
      ),
      note: savedOntology ? '저장 완료 · 검토 전' : undefined,
    },
  ];
  const phaseTitles: Partial<Record<typeof state.phase, string>> = {
    conversion_failed: '본문을 변환하지 못했습니다',
    error: savedWiki
      ? '저장한 문서의 상태를 다시 확인해 주세요'
      : '문서를 만들지 못했습니다',
  };
  const title = finished
    ? '문서를 만들고 관계를 추출했습니다'
    : (phaseTitles[state.phase] ?? '문서를 만들고 관계를 추출하고 있습니다');
  const actions: ProgressAction[] = [
    {
      id: 'prepare',
      available: scope.canPrepare && state.canPrepare,
      label: conversion ? '본문 준비 이어가기' : 'Markdown 준비 시작',
      variant: 'primary',
      run: (): Promise<void> => session.begin(),
    },
    {
      id: 'retry-conversion',
      available: state.canRetryConversion,
      label: '본문 변환 다시 시도',
      variant: 'primary',
      run: (): Promise<void> => session.retryConversion(),
    },
    {
      id: 'execute',
      available: state.canExecute,
      label: '관계 추출 다시 실행',
      variant: 'primary',
      run: (): Promise<void> => session.execute(),
    },
    {
      id: 'refresh',
      available: state.canRefresh,
      label: '진행·저장 상태 확인',
      variant: 'surface',
      run: (): Promise<void> => session.refresh(),
    },
  ];
  return (
    <section className={styles.result} aria-label="등록 진행 결과">
      {aiRequired && (
        <ConnectionNotice
          kind="ai-required"
          action={
            <Link className={styles.button} to="/settings?section=ai">
              AI 연결하기
            </Link>
          }
        />
      )}
      <h2>{title}</h2>
      <p>“{registered.item.title}”</p>
      <ol className={styles.stepList} aria-label="등록 진행 단계">
        {steps.map((step: StepView): JSX.Element => (
          <li key={step.label} data-state={step.state}>
            <Icon name={stepIcons[step.state]} size={16} />
            <span>{step.label}</span>
            {step.note && <small>{step.note}</small>}
          </li>
        ))}
      </ol>
      <WorkspaceSection title={savedWiki ? '저장 결과' : '현재 작업'}>
        {finished && (
          <div className={styles.notice} role="status">
            <p>
              문서를 만들고 관계를 추출했습니다. 추출한 관계는 검토 전 상태이며,
              비교한 뒤 반영해야 관계가 새 버전으로 바뀝니다.
            </p>
          </div>
        )}
        {partial && !aiRequired && (
          <div className={`${styles.notice} ${styles.warning}`} role="status">
            <p>
              AI가 연결되어 있지 않거나 사용 한도가 없으면 관계 추출이 멈춥니다.
              연결한 뒤 문서에서 ‘관계 재추출’을 누르면 됩니다.
            </p>
            <Link to="/settings?section=ai">AI 연결하기</Link>
          </div>
        )}
        {(!finished || state.error) && (
          <div
            className={`${styles.notice} ${state.error ? styles.errorNotice : ''}`}
            role={state.error ? 'alert' : 'status'}
          >
            <p>{progressMessage}</p>
            {state.phase === 'conversion_failed' && (
              <p>
                보관한 원본에서 변환만 다시 시도합니다. 파일을 다시 등록하지
                않습니다.
              </p>
            )}
            {uncertain && (
              <p>새 요청을 만들지 않고 원래 요청의 저장 결과부터 확인합니다.</p>
            )}
            {conversion?.state === 'partial' && (
              <p>읽지 못한 부분을 확인하고 변환을 다시 시도해 주세요.</p>
            )}
          </div>
        )}
        {state.cleanupWarningCount > 0 && (
          <p className={`${styles.notice} ${styles.warning}`} role="status">
            저장은 완료됐지만 임시 파일 정리 경고가 {state.cleanupWarningCount}
            건 있습니다. 저장을 다시 실행하지 마세요.
          </p>
        )}
        {!scope.canPrepare && (
          <p className={styles.notice}>
            문서 쓰기 권한이 없어 원본 보관까지만 완료했습니다. Markdown 준비는
            허용된 권한에서 이어갈 수 있습니다.
          </p>
        )}
        <div className={styles.actions}>
          {actions
            .filter((action: ProgressAction): boolean => action.available)
            .map((action: ProgressAction): JSX.Element => (
              <Button
                key={action.id}
                variant={action.variant}
                type="submit"
                className={actionClasses[action.variant]}
                disabled={state.busy}
                onClick={(): void => {
                  void action.run();
                }}
              >
                {action.label}
              </Button>
            ))}
          {savedWiki && (
            <Link
              className={
                savedOntology
                  ? `${styles.button} ${styles.primary}`
                  : styles.button
              }
              to={`/document?path=${encodeURIComponent(savedWiki)}`}
            >
              문서 열기 <Icon name="arrow-right" />
            </Link>
          )}
        </div>
        <div className={styles.resultLinks}>
          {savedOntology && (
            <Link
              className={styles.button}
              to={
                savedWiki
                  ? `/ontology?${new URLSearchParams({ path: savedWiki })}`
                  : '/ontology'
              }
            >
              관계 확인
            </Link>
          )}
          <Link
            className={styles.button}
            to={`/source?${new URLSearchParams({ sourceId: registered.item.sourceId, version: registered.item.sourceVersion })}`}
          >
            등록 원본 열기
          </Link>
          {state.detail && (
            <Link
              className={styles.button}
              to={`/jobs?${new URLSearchParams({ jobId: state.detail.job.job_id })}`}
            >
              분석 작업 상세
            </Link>
          )}
          <Link className={styles.button} to="/documents">
            문서 목록
          </Link>
          <Button
            variant="surface"
            type="submit"
            className={styles.button}
            onClick={onNewRegistration}
            disabled={state.busy || active || uncertain}
          >
            다른 문서 등록
          </Button>
        </div>
      </WorkspaceSection>
      {(report || conversion?.report) && (
        <WorkspaceSection title="처리 기록">
          {report && (
            <details className={styles.report}>
              <summary>최초 Markdown 변환 기록</summary>
              <p>
                변환 방식: {conversionMethods[report.method] || report.method} ·
                작성 경로: {report.author === 'AI' ? 'AI' : '미확인'}
              </p>
              <p>
                {report.complete
                  ? '변환 보고에서 문자 읽기 완료'
                  : '미독 구간 포함'}{' '}
                · 의미 검증과 사람 검토는 별도입니다.
              </p>
              <ConversionWarnings report={report} />
              {report.first_markdown && (
                <p>최초 변환 본문이 보관되어 있습니다.</p>
              )}
            </details>
          )}
          {conversion?.report && (
            <details className={styles.report}>
              <summary>변환한 본문과 미독 구간 확인</summary>
              <p>
                변환 도구가 보고한 문자입니다. 원본 전체 포함과 의미 정확도는
                검증되지 않았습니다.
              </p>
              <ConversionWarnings report={conversion.report} />
              <pre>
                {conversion.report.units
                  .map(
                    (
                      unit: NonNullable<
                        typeof conversion.report
                      >['units'][number],
                    ): string => unit.content,
                  )
                  .join('\n\n')}
              </pre>
            </details>
          )}
        </WorkspaceSection>
      )}
    </section>
  );
}

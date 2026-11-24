import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import type { IconName } from '@renderer/shared/ui/Icon';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import { useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import {
  conversionNeedsTextReview,
  conversionNeedsPageApproval,
} from '@contracts/sourceConversion.contract';
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';
import type { ImportScope } from '../api/importRegistration.api';
import type { ImportRegisteredSource } from '../model/importProcessing.types';
import type { ImportProcessingSession } from '../model/ImportProcessingSession';
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
  pptx_text: 'PowerPoint 슬라이드 문자 읽기',
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

const conversionFailures: Record<string, string> = {
  legacy_ppt_requires_libreoffice_or_pptx:
    '구형 PPT 변환에는 이 PC의 LibreOffice가 필요합니다. PowerPoint에서 PPTX로 저장해 다시 등록할 수도 있습니다. 업로드한 원본은 보관되어 있습니다.',
  legacy_ppt_conversion_timeout:
    '구형 PPT 변환 시간이 초과되었습니다. PPTX로 저장해 다시 등록해 주세요.',
  legacy_ppt_conversion_failed:
    '구형 PPT를 변환하지 못했습니다. PowerPoint에서 파일을 열어 PPTX로 저장한 뒤 다시 등록해 주세요.',
  empty_conversion:
    '원본에서 읽을 수 있는 본문을 얻지 못했습니다. 원본 파일과 문자 인식 상태를 확인해 주세요.',
  worker_failed:
    '변환 프로그램이 중단되어 나머지 원본을 읽지 못했습니다. 이 기록에는 구체적인 중단 원인이 남아 있지 않습니다.',
  conversion_timeout: '변환 시간이 제한을 넘어 나머지 원본을 읽지 못했습니다.',
  conversion_idle_timeout:
    '변환이 2분 동안 진행되지 않아 중단됐습니다. 저장된 중간 결과는 보존됩니다.',
  conversion_checkpoint_read_failed:
    '변환 중간 결과 파일을 읽지 못해 중단됐습니다. 이미 확인한 결과는 보존됩니다.',
  conversion_cancelled: '변환을 취소해 나머지 원본을 읽지 않았습니다.',
  conversion_checkpoint_locked:
    '중간 결과 파일이 잠겨 변환을 이어가지 못했습니다.',
  conversion_checkpoint_write_failed:
    '변환 중간 결과를 저장하지 못해 중단됐습니다.',
  conversion_memory_failed: '변환에 필요한 메모리가 부족해 중단됐습니다.',
  conversion_resources_failed:
    '변환에 필요한 시스템 자원이 부족해 중단됐습니다.',
  conversion_worker_io_failed: '변환 중 파일을 읽거나 쓰지 못해 중단됐습니다.',
  conversion_worker_exception: '변환 프로그램 내부 오류로 중단됐습니다.',
  conversion_worker_crashed: '변환 프로그램이 비정상 종료됐습니다.',
  conversion_worker_terminated:
    '변환 프로그램이 외부 종료 신호를 받아 중단됐습니다.',
};

/** 알려진 미독 오류만 설명으로 바꾸고 원래 범위·코드는 접힌 기록에 보존합니다. */
function ConversionWarnings({ report }: ConversionWarningsProps): JSX.Element {
  const explained = report.unread_ranges.map(
    (range: string): { range: string; message: string | null } => {
      const code = /^(?:remaining|whole) source: ([a-zA-Z0-9_.-]+)$/.exec(
        range,
      )?.[1];
      const review =
        /^(page|frame) ([1-9][0-9]*): ocr_low_or_missing_confidence_text_retained_manual_review_required$/.exec(
          range,
        );
      return {
        range,
        message: review
          ? `${review[2]}${review[1] === 'page' ? '쪽' : '번째 프레임'}: 변환 문자를 보관했지만 인식 신뢰도가 낮아 원본 대조가 필요합니다.`
          : code
            ? (conversionFailures[code] ?? null)
            : null,
      };
    },
  );
  return (
    <>
      {explained.map(
        (
          { range, message }: { range: string; message: string | null },
          index: number,
        ): JSX.Element => (
          <p
            key={`${index}:${range}`}
            className={
              range.endsWith(
                'ocr_low_or_missing_confidence_text_retained_manual_review_required',
              )
                ? undefined
                : styles.error
            }
          >
            {message ?? `미독: ${range}`}
          </p>
        ),
      )}
      {explained.some(
        (item: { message: string | null }): boolean => item.message !== null,
      ) && (
        <details>
          <summary>변환 진단 기록</summary>
          {explained
            .filter(
              (item: { message: string | null }): boolean =>
                item.message !== null,
            )
            .map((item: { range: string }, index: number): JSX.Element => (
              <p key={index}>{item.range}</p>
            ))}
        </details>
      )}
      {report.warnings.length > 0 && (
        <details>
          <summary>변환 도구 기록</summary>
          {report.warnings.map(
            (warning: string, index: number): JSX.Element => (
              <p key={`${index}:${warning}`}>{warning}</p>
            ),
          )}
        </details>
      )}
    </>
  );
}

type ConversionTextReviewProps = {
  report: NonNullable<SourceConversionRun['report']>;
};
type TextReviewUnit = { id: string; label: string; content: string };

/** 저신뢰 구간의 저장된 문자만 원본 대조용으로 보여 주며 확인 완료로 바꾸지 않습니다. */
function ConversionTextReview({
  report,
}: ConversionTextReviewProps): JSX.Element {
  const scopes = new Set(
    report.unread_ranges.map(
      (range: string): string => range.split(':')[0] ?? '',
    ),
  );
  const units = report.units.flatMap(
    (unit: (typeof report.units)[number]): TextReviewUnit[] => {
      if (
        unit.location.kind !== 'pages' ||
        !unit.location.start ||
        unit.location.start !== unit.location.end
      )
        return [];
      const label = scopes.has(`page ${unit.location.start}`)
        ? `${unit.location.start}쪽`
        : scopes.has(`frame ${unit.location.start}`)
          ? `${unit.location.start}번째 프레임`
          : null;
      return label ? [{ id: unit.unit_id, label, content: unit.content }] : [];
    },
  );
  const pageUnits =
    [...scopes].every((scope: string): boolean => scope.startsWith('page ')) &&
    report.units.every(
      (unit: (typeof report.units)[number]): boolean =>
        unit.location.kind === 'pages' &&
        unit.location.start === unit.location.end,
    );
  return (
    <div className={styles.report}>
      <p>
        보관된 변환 문자 {report.units.length}
        {pageUnits ? '쪽' : '개 구간'} · 문자 확인 필요{' '}
        {report.unread_ranges.length}
        {pageUnits ? '쪽' : '개 구간'}
      </p>
      <p>
        아래 문자를 등록 원본과 대조해 주세요. 인식 신뢰도는 문자 정확도에 대한
        검증 결과가 아닙니다.
      </p>
      {units.map((unit: TextReviewUnit): JSX.Element => (
        <details key={unit.id}>
          <summary>{unit.label} 변환 문자</summary>
          <pre>{unit.content}</pre>
        </details>
      ))}
    </div>
  );
}

type ImportDocumentProgressProps = {
  scope: ImportScope;
  registered: ImportRegisteredSource;
  targetDocument: string;
  session: ImportProcessingSession;
  onNewRegistration: () => void;
};

/** 원본 영수증·문자 변환·AI 저장 영수증을 구분하며 후속 단계만 다시 실행합니다. */
export function ImportDocumentProgress({
  scope,
  registered,
  targetDocument,
  session,
  onNewRegistration,
}: ImportDocumentProgressProps): JSX.Element {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const aiRequired = useAiConnection().status === 'required';
  const active =
    state.phase === 'converting' ||
    state.phase === 'running' ||
    state.phase === 'planning';

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
  const needsTextReview = state.phase === 'conversion_review';
  const needsPageApproval =
    needsTextReview && conversionNeedsPageApproval(conversion?.report);
  const hasTextReview =
    state.phase !== 'conversion_failed' &&
    conversion?.receiptState === 'saved' &&
    conversionNeedsTextReview(conversion.report);
  const progressMessage = (state.error ?? state.message).replaceAll(
    '서버 준비 조건: common_ruleset_required',
    '공통 분석 규약이 설정되지 않았습니다. 서버의 분석 설정을 확인해 주세요.',
  );
  const finished = state.phase === 'complete' && savedOntology;
  const partial = !finished && !!savedWiki && !active && state.phase !== 'idle';
  const plainText = ['md', 'txt'].includes(registered.item.format);
  const converted =
    plainText ||
    (!!state.detail && hasTextReview) ||
    (conversion?.state === 'complete' && conversion.receiptState === 'saved');
  const failedStage =
    state.error !== null ||
    state.phase === 'conversion_failed' ||
    state.phase === 'stopped';
  const steps: StepView[] = [
    { label: '원본 보관', state: 'done' },
    {
      label: '문자 변환',
      state: stepState(
        converted,
        needsTextReview,
        state.phase === 'conversion_failed',
      ),
      note: hasTextReview
        ? converted
          ? '보관 문자 사용 · 원본 대조 필요'
          : '문자 확인 필요'
        : plainText
          ? '원문 그대로 사용'
          : undefined,
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
    conversion_review: '변환 문자를 확인해 주세요',
    conversion_failed: '본문을 변환하지 못했습니다',
    stopped: savedWiki
      ? '문서는 저장됐지만 관계 추출이 중단됐습니다'
      : '문서 분석이 중단됐습니다',
    partial: '문서는 저장됐지만 관계 추출이 남아 있습니다',
    ready: '분석 실행을 준비했습니다',
    conversion_unconfirmed: '본문 변환 결과를 확인해 주세요',
    planning_unconfirmed: '분석 접수 결과를 확인해 주세요',
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
      available: scope.canPrepare && state.canPrepare && !needsTextReview,
      label: conversion ? '본문 준비 이어가기' : 'Markdown 준비 시작',
      variant: 'primary',
      run: (): Promise<void> => session.begin(),
    },
    {
      id: 'retry-conversion',
      available: state.canRetryConversion,
      label: '본문 변환 다시 시도',
      variant: needsTextReview ? 'surface' : 'primary',
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
        {partial && (
          <p className={styles.notice}>
            저장된 문서는 보존되어 있습니다. 중단 원인을 확인한 뒤 남은 관계
            추출을 다시 실행할 수 있습니다.
          </p>
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
            {conversion?.state === 'partial' && !hasTextReview && (
              <p>읽지 못한 부분을 확인하고 변환을 다시 시도해 주세요.</p>
            )}
            {needsPageApproval && (
              <p>
                경고 쪽을 원본과 대조하고 문자 사용을 승인해 주세요. 모든 쪽
                확인과 최종 승인이 서버에 저장된 뒤 문서 저장과 관계 추출을
                이어갑니다. 원래 경고는 처리 결과에도 남습니다.
              </p>
            )}
          </div>
        )}
        {state.conversion?.historyWarning && (
          <p role="status">{state.conversion.historyWarning}</p>
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
          {needsPageApproval && (
            <Link
              className={`${styles.button} ${styles.primary}`}
              to={
                conversion?.reference
                  ? `/tasks?${new URLSearchParams({ workflowId: conversion.reference.conversionId })}`
                  : '/notifications'
              }
            >
              문자 검토와 승인
            </Link>
          )}
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
        {hasTextReview && conversion?.report && (
          <ConversionTextReview report={conversion.report} />
        )}
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

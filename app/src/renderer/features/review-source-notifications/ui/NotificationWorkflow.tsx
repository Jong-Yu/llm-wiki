import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, InputEvent, JSX, SubmitEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router';
import { isDocumentPath } from '@contracts/documents.contract';
import { notificationLocation } from '@contracts/notifications.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { useRouteTitle } from '@renderer/shared/lib/routeTitle';
import { conversionFailureExplanation } from '@renderer/shared/lib/sourceConversionFailure';
import { Button } from '@renderer/shared/ui/Button';
import { IconButton } from '@renderer/shared/ui/IconButton';
import { MetadataPopover } from '@renderer/shared/ui/MetadataPopover';
import {
  contentText,
  originalContentText,
  notificationSession,
} from '../model/notificationView';
import type { NotificationDetail } from '../model/notificationView';
import { registrationUnits } from '../model/registrationUnits';
import type { RegistrationUnit } from '../model/registrationUnits';
import { useNotificationWorkflow } from '../model/useNotificationWorkflow';
import { canUseRegistrationContent } from '../model/RegistrationContentSubmission';
import type { ContentDraft } from '../model/RegistrationContentSubmission';
import { OriginalPage } from './OriginalPage';
import { OriginalContent } from './OriginalContent';
import styles from './Notifications.module.scss';

export type NotificationWorkflowProps = {
  scope: SourceConversionScope & { canPrepare: boolean };
  workflowId: string;
  backPath?: string;
  initialTargetDocument?: string;
  onContinued?: (jobId: string) => void;
};
const contentSchema = z.object({
  contents: z.record(z.string(), z.string()),
  blanks: z.array(z.string()),
  target: z.string(),
});
type ContentValues = z.infer<typeof contentSchema>;
type ConversionUnit = NonNullable<
  NotificationDetail['conversion']
>['manifest']['units'][number];

/** 계정·원본이 바뀌는 즉시 이전 폼과 비동기 수명을 분리합니다. */
export function NotificationWorkflow(
  props: NotificationWorkflowProps,
): JSX.Element {
  const key = JSON.stringify([
    notificationSession(props.scope),
    props.workflowId,
  ]);
  return <NotificationWorkflowContent key={key} {...props} />;
}

/** 이미지 준비는 등록할 문자 저장과 독립적으로 표시합니다. */
function ignoreImageAvailability(_available: boolean): void {}

/** 원본과 등록할 내용을 나란히 보며 누락 입력·빈 페이지 확인과 일반 수정을 함께 처리합니다. */
function NotificationWorkflowContent({
  scope,
  workflowId,
  backPath = '/documents',
  initialTargetDocument,
  onContinued,
}: NotificationWorkflowProps): JSX.Element {
  const model = useNotificationWorkflow(scope, workflowId);
  const {
    detail,
    inspection,
    error,
    uncertain,
    phase,
    submitted,
    resuming,
    basis,
    draft,
    restoreDraft,
    scheduleDraft,
  } = model;
  const [selection, setSelection] = useState<string | null>(null);
  const [range, setRange] = useState<'review' | 'all'>('review');
  const [position, setPosition] = useState('');
  const [previewPage, setPreviewPage] = useState(1);
  const [inputError, setInputError] = useState<string | null>(null);
  const restoredOnce = useRef(false);
  const verifiedTarget =
    initialTargetDocument && isDocumentPath(initialTargetDocument)
      ? initialTargetDocument
      : null;
  const form = useForm<ContentValues>({
    resolver: zodResolver(contentSchema),
    defaultValues: { contents: {}, blanks: [], target: verifiedTarget ?? '' },
  });
  const contents = useWatch({ control: form.control, name: 'contents' });
  const blanks = useWatch({ control: form.control, name: 'blanks' });
  const target = useWatch({ control: form.control, name: 'target' });
  const units = useMemo(
    (): RegistrationUnit[] => (detail ? registrationUnits(detail) : []),
    [detail],
  );
  const wholeUnit = units.find(
    (unit: RegistrationUnit): boolean => !!unit.whole_document,
  );
  const pendingUnitKeys = units
    .filter(
      (unit: RegistrationUnit): boolean =>
        !unit.whole_document &&
        (Object.hasOwn(contents, unit.key) || blanks.includes(unit.key)),
    )
    .map((unit: RegistrationUnit): string => unit.key);
  const wholeCorrection = detail?.workflow.pages.some(
    (unit: NotificationDetail['workflow']['pages'][number]): boolean =>
      !!unit.whole_document && !!unit.correction_ref,
  );
  const mixedDrafts =
    !!wholeUnit &&
    (Object.hasOwn(contents, wholeUnit.key) || !!wholeCorrection) &&
    pendingUnitKeys.length > 0;
  const fixedMixedDrafts = mixedDrafts && (submitted || resuming);
  const dirty = !!basis;
  useRouteTitle(`workflow:${workflowId}`, detail?.workflow.title ?? null);

  useEffect((): (() => void) | undefined => {
    if (!draft.ready || restoredOnce.current) return;
    restoredOnce.current = true;
    const restored = draft.restored;
    if (!restored) return;
    let live = true;
    queueMicrotask((): void => {
      if (!live) return;
      form.reset({
        contents: restored.contents,
        blanks: restored.blankUnits,
        target: restored.targetDocument,
      });
      restoreDraft(restored);
    });
    return (): void => {
      live = false;
    };
  }, [draft.ready, draft.restored, form, restoreDraft]);

  useEffect((): (() => void) | undefined => {
    return scheduleDraft({ contents, blanks, target });
  }, [contents, blanks, target, scheduleDraft]);

  /** 빈 페이지는 명시 확인하며, 실제 누락 내용을 비운 채 등록하지 않습니다. */
  async function submit(values: ContentValues): Promise<void> {
    if (!detail) return;
    setInputError(null);
    if (mixedDrafts && !fixedMixedDrafts) return;
    const selectedDrafts: ContentDraft[] = [];
    for (const unit of units) {
      const content =
        values.contents[unit.key] ?? contentText(detail, unit) ?? '';
      const blank = values.blanks.includes(unit.key);
      if (blank)
        selectedDrafts.push({
          ...notificationLocation(unit),
          content: '',
          method: 'blank',
          warnings: [],
        });
      else if (
        Object.hasOwn(values.contents, unit.key) &&
        (unit.inputRequired ||
          content !== (basis?.contents[unit.key] ?? contentText(detail, unit)))
      )
        selectedDrafts.push({
          ...notificationLocation(unit),
          content,
          method: 'manual',
          warnings: [],
        });
      if (
        unit.needsReview &&
        (!content.trim() ||
          (unit.inputRequired && !Object.hasOwn(values.contents, unit.key))) &&
        !blank &&
        !resuming &&
        !submitted
      ) {
        setInputError(
          `${unit.label}의 내용을 입력하거나 실제로 빈 페이지인지 확인해 주세요.`,
        );
        setSelection(unit.key);
        return;
      }
    }
    const targetDocument =
      detail.workflow.target_document ?? verifiedTarget ?? values.target.trim();
    const jobId = await model.submit(
      selectedDrafts,
      targetDocument,
      values,
      (message: string): void => {
        setInputError(`${message} 입력을 수정하거나 다시 시도해 주세요.`);
      },
    );
    if (jobId) {
      try {
        // 이전 버전의 고정 제출에 포함되지 않은 구간 초안은 완료 뒤에도 지우지 않습니다.
        if (!fixedMixedDrafts) await model.clearDraft('registered');
      } catch {
        setInputError(
          '등록은 이어지고 있습니다. 이 기기의 초안 정리는 다시 확인해 주세요.',
        );
      }
      onContinued?.(jobId);
    }
  }

  const workflow = detail?.workflow;
  const visible =
    range === 'all'
      ? units
      : units.filter((unit: RegistrationUnit): boolean => unit.needsReview);
  const selected =
    units.find((unit: RegistrationUnit): boolean => unit.key === selection) ??
    visible[0] ??
    units[0];
  const wholePreview = !!selected?.whole_document && !!detail?.sourcePageCount;
  const referenceUnit = !!wholeUnit && !!selected && !selected.whole_document;
  const previewTotal = detail?.sourcePageCount ?? 0;
  const visualFormat = detail?.source_format;
  const visualPreview =
    !!visualFormat && !['pdf', 'md', 'txt'].includes(visualFormat);
  const selectedLocation = detail?.conversion?.manifest.units.find(
    (unit: ConversionUnit): boolean => unit.unit_id === selected?.unit_id,
  )?.location;
  const visualPage =
    selectedLocation?.kind === 'slides' &&
    selectedLocation.start === selectedLocation.end
      ? (selectedLocation.start ?? undefined)
      : undefined;
  const index = visible.findIndex(
    (unit: RegistrationUnit): boolean => unit.key === selected?.key,
  );
  const reviewing = workflow?.state === 'review' && !workflow.blocked_reason;
  const resumable =
    !!workflow &&
    !workflow.blocked_reason &&
    (['approved', 'failed', 'stopped'].includes(workflow.state) ||
      (workflow.state === 'claimed' &&
        workflow.execution?.device_id === inspection?.deviceId));
  const changed =
    !!basis && basis.revision !== workflow?.revision && !submitted && !resuming;
  const supported = !!detail && canUseRegistrationContent(detail);
  const writable =
    !!reviewing &&
    scope.canPrepare &&
    draft.ready &&
    !phase &&
    !submitted &&
    !resuming &&
    !uncertain &&
    !error &&
    !changed &&
    supported;
  const targetDocument =
    workflow?.target_document ?? verifiedTarget ?? target.trim();
  const lastFailure =
    workflow && ['failed', 'stopped'].includes(workflow.state)
      ? detail?.events.findLast(
          (event: NotificationDetail['events'][number]): boolean =>
            event.kind === 'failed' || event.kind === 'stopped',
        )
      : undefined;
  const conversionIssue = conversionFailureExplanation([
    ...(reviewing ? (detail?.conversion?.manifest.warnings ?? []) : []),
    ...(lastFailure?.details?.diagnostic_codes ?? []),
  ]);
  const missingContent = !!detail && units.length === 0;
  const contentIssue = conversionIssue
    ? `${conversionIssue.body} ${conversionIssue.next}`
    : missingContent
      ? '보관된 변환 내용이 없습니다. 이 기록에는 구체적인 원인이 남아 있지 않습니다. 원본과 실행 기록을 확인해 주세요.'
      : workflow?.state === 'failed'
        ? '문서 등록이 중단됐지만 이 기록에는 구체적인 실패 원인이 없습니다. 보관된 내용은 유지했습니다. 실행 기록을 확인해 주세요.'
        : workflow?.state === 'stopped'
          ? '문서 등록이 중단된 상태입니다. 보관된 내용을 확인하고 등록을 이어갈 수 있습니다.'
          : reviewing &&
              detail?.conversion?.manifest.warnings.includes(
                'picture_content_not_read',
              )
            ? '그림의 내용을 문자로 읽지 못했습니다. 변환된 문자는 아래에 표시했습니다. 원본과 대조해 누락된 내용을 보완해 주세요.'
            : reviewing && detail?.conversion?.manifest.complete === false
              ? '원본의 일부만 문자로 변환됐습니다. 보관된 내용을 원본과 대조해 누락된 부분을 보완해 주세요.'
              : null;
  const lastPosition = units.reduce(
    (last: number, unit: RegistrationUnit): number =>
      Math.max(last, unit.page ?? unit.position),
    0,
  );
  const canContinue =
    scope.canPrepare &&
    draft.ready &&
    !phase &&
    !uncertain &&
    !error &&
    !changed &&
    (!mixedDrafts || fixedMixedDrafts) &&
    isDocumentPath(targetDocument) &&
    !!inspection?.ready &&
    ((reviewing && supported) || (resumable && !missingContent));
  const status =
    inputError ??
    error ??
    (fixedMixedDrafts
      ? workflow?.state === 'complete'
        ? '문서 등록이 완료되었습니다. 이전에 제출하지 않은 개별 구간 초안은 이 기기에 보존되어 있습니다.'
        : '이전에 제출한 문서 전체 내용으로 등록을 이어갑니다. 개별 구간 초안은 제출 내용을 바꾸지 않으며 완료 뒤에도 이 기기에 보존합니다.'
      : mixedDrafts
        ? '문서 전체와 개별 구간의 초안이 함께 남아 있습니다. 전체 초안에 구간 수정을 반영한 뒤 각 구간의 초안을 취소해 주세요. 입력은 모두 보존했습니다.'
        : workflow?.blocked_reason
          ? '원본 또는 변환 내용이 바뀌었습니다. 입력은 보존되어 있습니다.'
          : changed
            ? '편집 중 다른 변경이 저장되었습니다. 초안을 보존했으니 최신 내용과 비교해 주세요.'
            : phase === 'saving'
              ? '수정한 내용을 저장하고 있습니다…'
              : phase === 'confirming'
                ? '등록할 내용을 확인하고 있습니다…'
                : phase === 'continuing'
                  ? '문서 등록을 이어가고 있습니다…'
                  : reviewing
                    ? (contentIssue ??
                      '원본과 등록할 내용을 대조하고 필요한 부분을 수정해 주세요.')
                    : workflow?.state === 'complete'
                      ? '문서 등록이 완료되었습니다.'
                      : (contentIssue ??
                        '완료되지 않은 작업부터 문서 등록을 이어갑니다.'));

  /** 위치 선택은 화면만 바꾸고 실행이나 저장을 시작하지 않습니다. */
  function select(unit: RegistrationUnit | undefined): void {
    if (unit) {
      setSelection(unit.key);
      setPosition('');
    }
  }

  /** 전체 입력을 시작하기 전에는 남아 있는 구간 초안도 원래 위치에 합쳐 보여줍니다. */
  function displayedContent(unit: RegistrationUnit): string {
    if (Object.hasOwn(contents, unit.key)) return contents[unit.key] ?? '';
    if (!detail) return '';
    const overrides = { ...contents };
    for (const key of blanks) overrides[key] = '';
    return (
      contentText(detail, unit, unit.whole_document ? overrides : undefined) ??
      ''
    );
  }

  /** 화면에 합친 구간 초안은 첫 전체 편집 때만 전체 초안으로 옮깁니다. */
  function changeContent(value: string): void {
    if (!selected || referenceUnit || !writable) return;
    model.beginEdit(selected);
    if (
      selected.whole_document &&
      !Object.hasOwn(contents, selected.key) &&
      !wholeCorrection
    ) {
      const nextContents = { ...contents, [selected.key]: value };
      for (const key of pendingUnitKeys) delete nextContents[key];
      form.setValue('contents', nextContents, { shouldDirty: true });
      form.setValue(
        'blanks',
        blanks.filter((key: string): boolean => !pendingUnitKeys.includes(key)),
        { shouldDirty: true },
      );
    } else {
      form.setValue(`contents.${selected.key}`, value, { shouldDirty: true });
    }
    setInputError(null);
  }

  /** 사용자가 전체 초안에 반영한 것을 확인한 뒤 해당 구간의 로컬 초안만 취소합니다. */
  function discardUnitDraft(): void {
    if (!selected || !referenceUnit || !mixedDrafts || !writable) return;
    model.beginEdit(selected);
    const nextContents = { ...contents };
    delete nextContents[selected.key];
    form.setValue('contents', nextContents, { shouldDirty: true });
    form.setValue(
      'blanks',
      blanks.filter((key: string): boolean => key !== selected.key),
      { shouldDirty: true },
    );
  }

  return (
    <section
      className={`${styles.page} ${styles.contentPage}`}
      aria-label="문서 내용 확인"
      aria-busy={!!phase}
      data-workflow-detail={workflowId}
    >
      <div className={styles.heading}>
        <div>
          <h1>{workflow?.title ?? '문서 내용 확인'}</h1>
        </div>
        <IconButton
          icon="refresh-cw"
          label={uncertain ? '저장 결과 확인' : '상태 다시 확인'}
          size="small"
          disabled={!!phase}
          onClick={(): void => {
            void model.load();
            void model.inspect();
            if (!draft.ready) draft.reload();
          }}
        />
      </div>
      <form
        className={styles.contentForm}
        onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
          void form.handleSubmit(submit)(event);
        }}
      >
        <div className={styles.contentToolbar}>
          <h2>내용 확인</h2>
          <nav className={styles.contentNavigation} aria-label="문서 내용 탐색">
            <IconButton
              icon="chevron-left"
              size="default"
              label="이전 확인 페이지"
              disabled={
                (wholePreview ? previewPage <= 1 : index <= 0) || !!phase
              }
              onClick={(): void => {
                if (wholePreview) setPreviewPage(previewPage - 1);
                else select(visible[index - 1]);
              }}
            />
            <MetadataPopover
              control
              label={
                wholePreview
                  ? `원본 ${previewPage} / ${previewTotal}페이지`
                  : (selected?.label ?? '불러오는 중')
              }
              popoverLabel="페이지 선택"
              disabled={!!phase || !selected}
            >
              {(close: () => void): JSX.Element => (
                <div className={styles.pagePicker}>
                  <div className={styles.pickerHeading}>
                    <strong>위치 선택</strong>
                    <IconButton
                      icon="x"
                      label="페이지 선택 닫기"
                      onClick={close}
                    />
                  </div>
                  <label>
                    {selected?.page || wholePreview
                      ? '페이지 번호'
                      : '내용 순서'}
                    <div className={styles.pickerJump}>
                      <input
                        type="number"
                        min={1}
                        max={wholePreview ? previewTotal : lastPosition}
                        aria-label="이동할 위치"
                        value={position}
                        placeholder={String(
                          wholePreview
                            ? previewPage
                            : (selected?.page ?? selected?.position ?? 1),
                        )}
                        onChange={(
                          event: ChangeEvent<HTMLInputElement>,
                        ): void => setPosition(event.target.value)}
                      />
                      <span>
                        / {wholePreview ? previewTotal : lastPosition}
                      </span>
                      <Button
                        size="small"
                        disabled={
                          !position ||
                          (wholePreview
                            ? !(
                                Number.isInteger(Number(position)) &&
                                Number(position) >= 1 &&
                                Number(position) <= previewTotal
                              )
                            : !units.some(
                                (unit: RegistrationUnit): boolean =>
                                  (unit.page ?? unit.position) ===
                                  Number(position),
                              ))
                        }
                        onClick={(): void => {
                          if (wholePreview) {
                            setPreviewPage(Number(position));
                            setPosition('');
                            close();
                            return;
                          }
                          const unit = units.find(
                            (entry: RegistrationUnit): boolean =>
                              (entry.page ?? entry.position) ===
                              Number(position),
                          );
                          if (unit) {
                            setRange('all');
                            select(unit);
                            close();
                          }
                        }}
                      >
                        이동
                      </Button>
                    </div>
                  </label>
                  {!wholePreview && units.length > 1 && (
                    <label>
                      탐색 범위
                      <select
                        aria-label="탐색 범위"
                        value={range}
                        onChange={(
                          event: ChangeEvent<HTMLSelectElement>,
                        ): void => {
                          setRange(
                            event.target.value === 'all' ? 'all' : 'review',
                          );
                          setSelection(null);
                        }}
                      >
                        <option value="review">확인 필요</option>
                        <option value="all">전체</option>
                      </select>
                    </label>
                  )}
                  <span>
                    {wholePreview ? previewTotal : visible.length}개{' '}
                    {range === 'review' ? '확인 대상' : '내용 구간'}
                  </span>
                </div>
              )}
            </MetadataPopover>
            <IconButton
              icon="chevron-right"
              size="default"
              label="다음 확인 페이지"
              disabled={
                (wholePreview
                  ? previewPage >= previewTotal
                  : index < 0 || index >= visible.length - 1) || !!phase
              }
              onClick={(): void => {
                if (wholePreview) setPreviewPage(previewPage + 1);
                else select(visible[index + 1]);
              }}
            />
          </nav>
        </div>
        <div
          className={styles.contentStatus}
          role="status"
          aria-live="polite"
          data-error={
            !!inputError || !!error || changed || !!workflow?.blocked_reason
          }
        >
          {detail
            ? status
            : (error ?? '원본과 보관한 내용을 불러오고 있습니다.')}
        </div>
        <div className={styles.contentComparison}>
          <section className={styles.contentPane} aria-label="원본">
            {visualPreview && visualFormat ? (
              <OriginalContent
                scope={scope}
                workflowId={workflowId}
                sourceFormat={visualFormat}
                page={visualPage}
                originalHref={
                  workflow
                    ? `/source?${new URLSearchParams({ sourceId: workflow.source_ref.source_id, version: workflow.source_ref.source_version })}`
                    : undefined
                }
                returnTo={`/documents?workflowId=${workflowId}`}
                onAvailable={ignoreImageAvailability}
                onAccessLost={model.invalidate}
              />
            ) : selected?.page || wholePreview ? (
              <OriginalPage
                key={`${selected?.key}:${wholePreview ? previewPage : selected?.page}`}
                scope={scope}
                workflowId={workflowId}
                page={wholePreview ? previewPage : (selected?.page ?? 1)}
                onAvailable={ignoreImageAvailability}
                onAccessLost={model.invalidate}
              />
            ) : (
              <>
                <div className={styles.paneHeading}>
                  <strong>
                    {selected?.whole_document ? '원본 문서' : '변환 당시 내용'}
                  </strong>
                  {workflow && (
                    <Link
                      to={`/source?${new URLSearchParams({ sourceId: workflow.source_ref.source_id, version: workflow.source_ref.source_version })}`}
                      state={{
                        workflowReturnTo: `/documents?workflowId=${workflowId}`,
                      }}
                    >
                      원본 열기
                    </Link>
                  )}
                </div>
                <pre className={styles.contentEditor}>
                  {selected && detail
                    ? (originalContentText(detail, selected) ??
                      '문자로 변환하지 못했습니다. 원본을 확인하고 등록할 내용을 입력해 주세요.')
                    : detail
                      ? '보관된 변환 내용이 없습니다. 원본 파일을 열어 확인할 수 있습니다.'
                      : '원본을 불러오고 있습니다…'}
                </pre>
              </>
            )}
          </section>
          <section className={styles.contentPane} aria-label="등록할 내용">
            <div className={styles.paneHeading}>
              <label htmlFor="registration-content">등록할 내용</label>
              {referenceUnit &&
                mixedDrafts &&
                pendingUnitKeys.includes(selected.key) && (
                  <IconButton
                    icon="rotate-ccw"
                    label="이 구간의 초안 취소"
                    disabled={!writable}
                    onClick={discardUnitDraft}
                  />
                )}
              <span className={styles.receipt}>
                {draft.status === '수정한 내용은 이 기기에 자동 저장됩니다.'
                  ? '자동 저장'
                  : draft.status}
              </span>
            </div>
            {detail && selected ? (
              <textarea
                id="registration-content"
                className={styles.contentEditor}
                value={displayedContent(selected)}
                readOnly={
                  !writable || referenceUnit || blanks.includes(selected.key)
                }
                aria-label={
                  selected ? `${selected.label} 등록할 내용` : '등록할 내용'
                }
                aria-describedby="registration-content-help"
                placeholder="변환된 문자가 없습니다. 원본을 보며 등록할 내용을 입력해 주세요."
                onChange={(): void => {}}
                onInput={(event: InputEvent<HTMLTextAreaElement>): void => {
                  changeContent(event.currentTarget.value);
                }}
              />
            ) : (
              <div className={styles.contentEditor} role="status">
                {detail
                  ? '표시할 변환 내용이 없습니다. 위의 원인과 다음 행동을 확인해 주세요.'
                  : error
                    ? '문서 접근 상태를 다시 확인해 주세요.'
                    : '등록할 내용을 불러오고 있습니다…'}
              </div>
            )}
          </section>
        </div>
        <div className={styles.contentOptions}>
          {selected?.canBeBlank && !referenceUnit && (
            <label>
              <input
                type="checkbox"
                checked={blanks.includes(selected.key)}
                disabled={!writable}
                onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                  model.beginEdit(selected);
                  form.setValue(
                    'blanks',
                    event.target.checked
                      ? [...blanks, selected.key]
                      : blanks.filter(
                          (key: string): boolean => key !== selected.key,
                        ),
                    { shouldDirty: true },
                  );
                }}
              />{' '}
              {selected.page
                ? '원본에서 빈 페이지입니다'
                : '내용이 없는 구간입니다'}
            </label>
          )}
          <span>
            {referenceUnit
              ? '구간별 내용은 참고용입니다. 수정은 문서 전체에서 이어가세요.'
              : '그림·도표가 있다면 필요한 내용을 글로 입력해 주세요.'}
          </span>
        </div>
        <div className={styles.contentFooter}>
          <div>
            <p id="registration-content-help">
              수정한 내용을 포함해 문서 전체를 등록합니다.
            </p>
            {(model.readinessError || (inspection && !inspection.ready)) && (
              <p role="alert" className={styles.contentError}>
                {model.readinessError ?? inspection?.blockers.join(' ')}{' '}
                <Link to="/settings">AI 연결 설정</Link>
              </p>
            )}
            {!workflow?.target_document && !verifiedTarget && reviewing && (
              <label className={styles.targetField}>
                문서 저장 이름
                <input
                  {...form.register('target')}
                  disabled={!writable}
                  placeholder="문서 이름.md"
                  onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                    model.beginEdit(selected);
                    form.setValue('target', event.target.value, {
                      shouldDirty: true,
                    });
                  }}
                />
              </label>
            )}
          </div>
          <div className={styles.actions}>
            {dirty && !submitted && !resuming && (
              <Button
                variant="surface"
                disabled={!!phase}
                onClick={(): void => {
                  void model
                    .clearDraft('discarded')
                    .then((): void => {
                      form.reset({ contents: {}, blanks: [], target });
                    })
                    .catch((cause: unknown): void =>
                      setInputError(
                        cause instanceof Error
                          ? cause.message
                          : '초안 취소를 확인하지 못했습니다.',
                      ),
                    );
                }}
              >
                수정 취소
              </Button>
            )}
            {(reviewing || resumable) && !missingContent ? (
              <Button type="submit" disabled={!canContinue}>
                {fixedMixedDrafts
                  ? '제출한 전체 내용으로 등록 계속'
                  : '이 내용으로 등록 계속'}
              </Button>
            ) : (
              missingContent && <Link to={backPath}>실행 상태 확인</Link>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

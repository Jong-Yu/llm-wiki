import type { JSX } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  ConversionSource,
  SourceConversionReference,
  SourceConversionRun,
} from '@contracts/sourceConversion.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { Button } from '@renderer/shared/ui/Button';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { TextField } from '@renderer/shared/ui/TextField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  conversionOptionsSchema,
  useSourceConversion,
} from '../model/useSourceConversion';
import type { ConversionOptions } from '../model/useSourceConversion';
import styles from './ConvertSource.module.scss';

export type ConvertSourceProps = {
  source: ConversionSource;
  scope: SourceConversionScope;
  allowed: boolean;
  onScopeInvalidated: () => void;
  onConverted?: (reference: SourceConversionReference) => void;
  onQuestion?: (reference: SourceConversionReference) => void;
};
/** 원문 위치를 형식에 맞게 표시하며 DOCX 구간을 물리 페이지라고 부르지 않습니다. */
function locationLabel(
  location: NonNullable<
    SourceConversionRun['report']
  >['units'][number]['location'],
): string {
  if (location.kind === 'table_cells')
    return `표 ${location.table} · 행 ${location.row} · 열 ${location.column}`;
  if (location.kind === 'whole') return '전체 원본 범위';
  if (location.kind === 'cells') return `${location.sheet} · ${location.cells}`;
  const label =
    location.kind === 'pages'
      ? '페이지/프레임'
      : location.kind === 'lines'
        ? '줄'
        : location.kind === 'paragraphs'
          ? '문단'
          : '본문 블록';
  return `${label} ${location.start}–${location.end}`;
}
/** 개인 PC 변환, 미독 결과와 서버 보고 저장을 각각 확인하는 작업 패널입니다. */
function ConversionPanel({
  source,
  scope,
  allowed,
  onScopeInvalidated,
  onConverted,
  onQuestion,
}: ConvertSourceProps): JSX.Element {
  const model = useSourceConversion({ source, scope, onScopeInvalidated });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ConversionOptions>({
    resolver: zodResolver(conversionOptionsSchema),
    defaultValues: { ocr: 'auto', ocrLanguage: 'kor+eng' },
  });
  const run = model.run;
  const active = run?.state === 'running' || run?.state === 'cancelling';
  const blocked =
    model.recovering ||
    model.busy ||
    active ||
    run?.receiptState === 'unconfirmed';
  return (
    <section className={styles.panel} aria-label="개인 PC 원본 변환">
      <header>
        <h2>원본 문자 변환</h2>
        <p>
          등록된 원본을 이 PC에서 변환하고 결과 보고를 저장합니다. 서버는 자동
          OCR을 실행하지 않습니다.
        </p>
      </header>
      <details>
        <summary>고정 원본 판본</summary>
        <dl>
          <dt>원본</dt>
          <dd>{source.sourceId}</dd>
          <dt>판본</dt>
          <dd>{source.sourceVersion}</dd>
          <dt>SHA-256</dt>
          <dd>{source.sourceSha256}</dd>
        </dl>
      </details>
      <form
        className={styles.form}
        onSubmit={handleSubmit((options: ConversionOptions): void => {
          void model.start(options);
        })}
      >
        <fieldset disabled={blocked || !allowed}>
          <SelectField label="OCR 사용" {...register('ocr')}>
            <option value="auto">문자가 없는 구간에 사용</option>
            <option value="never">OCR 사용하지 않음</option>
            <option value="always">항상 OCR 요청</option>
          </SelectField>
          <TextField
            label="OCR 언어"
            description="이 PC에 Tesseract와 해당 언어 데이터가 필요합니다. 한국어+영어: kor+eng"
            error={errors.ocrLanguage?.message}
            {...register('ocrLanguage')}
          />
        </fieldset>
        <div className={styles.actions}>
          <Button type="submit" disabled={blocked || !allowed}>
            이 PC에서 변환하고 보고 저장
          </Button>
          <Button
            variant="secondary"
            disabled={model.busy}
            onClick={(): void => {
              void model.refresh();
            }}
          >
            변환 상태 확인
          </Button>
          {active && (
            <Button
              variant="secondary"
              disabled={model.busy || run?.state === 'cancelling'}
              onClick={(): void => {
                void model.cancel();
              }}
            >
              변환 취소
            </Button>
          )}
        </div>
      </form>
      {!allowed && (
        <p>현재 관점에서 원본 변환 보고를 저장할 권한이 없습니다.</p>
      )}
      {model.recoveryNotice && (
        <StatusNotice tone="info">{model.recoveryNotice}</StatusNotice>
      )}
      {model.error && (
        <StatusNotice tone="error" title="변환 상태 안내">
          {model.error}
        </StatusNotice>
      )}
      {!run && (
        <p className={styles.note}>
          원본 보관 완료와 문자 변환 완료는 별도입니다. 이 화면을 열어도 변환은
          시작되지 않습니다.
        </p>
      )}
      {run && (
        <>
          <StatusNotice
            tone={
              run.state === 'failed'
                ? 'error'
                : run.state === 'complete'
                  ? 'success'
                  : 'info'
            }
            title={active ? '개인 PC 변환 진행' : '변환 결과'}
          >
            {run.message}
          </StatusNotice>
          {run.progress && (
            <p role="status">
              {run.progress.stage === 'download'
                ? '원본 다운로드'
                : run.progress.stage === 'convert'
                  ? '문자 변환'
                  : '보고 저장'}{' '}
              · {run.progress.completed}
              {run.progress.total != null ? ` / ${run.progress.total}` : ''}
            </p>
          )}
          <p>
            보고 저장:{' '}
            {run.receiptState === 'saved'
              ? '서버에서 확인됨'
              : run.receiptState === 'pending'
                ? '실행 중 · 아직 확인되지 않음'
                : run.receiptState === 'unconfirmed'
                  ? '결과 미확인 · 같은 보고 조회 필요'
                  : run.receiptState === 'rejected'
                    ? '서버 거부'
                    : '제출하지 않음'}
          </p>
          {run.cleanupWarning && (
            <StatusNotice tone="warning" title="임시 인증 파일 정리 안내">
              실행 결과와 별개로 이 PC의 임시 인증 파일을 정리하지 못했습니다.
              로컬 저장소를 확인해 주세요.
            </StatusNotice>
          )}
          {run.diagnosticCodes.length > 0 && (
            <details>
              <summary>변환 실행 정보·진단</summary>
              {run.diagnosticCodes.some((code: string): boolean =>
                /missing|unavailable|failed|timeout|unsafe/.test(code),
              ) && (
                <p>
                  필요한 변환 라이브러리, Tesseract 실행 파일·언어 데이터와
                  Python 실행 경로를 확인해 주세요.
                </p>
              )}
              <ul>
                {run.diagnosticCodes.map((code: string): JSX.Element => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
            </details>
          )}
          {run.report && (
            <>
              <p className={styles.note}>
                방법: {run.report.method ?? '변환 시작 전 실패'} · 개인 PC 보고
                · 보고된 구간만 포함 · 원본 전체 포함과 의미 정확도는 미검증
              </p>
              {run.report.unread_ranges.length > 0 && (
                <StatusNotice tone="warning" title="읽지 못한 구간">
                  <ul>
                    {run.report.unread_ranges.map(
                      (text: string, index: number): JSX.Element => (
                        <li key={index}>{text}</li>
                      ),
                    )}
                  </ul>
                </StatusNotice>
              )}
              {run.report.warnings.length > 0 && (
                <details open>
                  <summary>변환 한계·설치 안내</summary>
                  <ul>
                    {run.report.warnings.map(
                      (text: string, index: number): JSX.Element => (
                        <li key={index}>{text}</li>
                      ),
                    )}
                  </ul>
                </details>
              )}
              <section
                className={styles.units}
                aria-label="실제 변환 문자와 원본 위치"
              >
                {run.report.units.length === 0 && (
                  <p>변환된 문자가 없습니다.</p>
                )}
                {run.report.units.map(
                  (
                    unit: NonNullable<
                      SourceConversionRun['report']
                    >['units'][number],
                  ): JSX.Element => (
                    <details key={unit.unit_id}>
                      <summary>
                        {locationLabel(unit.location)} ·{' '}
                        {run.report?.unit_methods[unit.unit_id] ??
                          run.report?.method}{' '}
                        ·{' '}
                        {new Intl.NumberFormat('ko-KR').format(
                          unit.content.length,
                        )}
                        자
                      </summary>
                      <pre>
                        {unit.content || '(이 구간에서 추출된 문자가 없음)'}
                      </pre>
                    </details>
                  ),
                )}
              </section>
            </>
          )}
          <details>
            <summary>보고 참조·저장 확인</summary>
            <dl>
              <dt>요청</dt>
              <dd>{run.requestId}</dd>
              {run.reference && (
                <>
                  <dt>변환 보고</dt>
                  <dd>{run.reference.conversionId}</dd>
                  <dt>보고 판본</dt>
                  <dd>{run.reference.conversionRevision}</dd>
                </>
              )}
            </dl>
          </details>
          {onConverted && (
            <Button
              disabled={
                run.receiptState !== 'saved' ||
                !run.report?.complete ||
                !run.reference
              }
              onClick={(): void => {
                if (
                  run.reference &&
                  run.receiptState === 'saved' &&
                  run.report?.complete
                )
                  onConverted(run.reference);
              }}
            >
              이 변환 보고로 분석 범위 설정
            </Button>
          )}
          {onQuestion &&
            run.reference &&
            run.receiptState === 'saved' &&
            run.report?.complete &&
            run.state === 'complete' && (
              <Button
                onClick={(): void => {
                  if (run.reference) onQuestion(run.reference);
                }}
              >
                저장한 변환으로 질문
              </Button>
            )}
          {run.report && !run.report.complete && (
            <p className={styles.note}>
              미독 구간이 있는 보고는 보존되지만 완전한 분석 입력으로 인계할 수
              없습니다.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** 원본 또는 권한 범위가 달라지면 이전 실행 화면과 폼을 새 수명으로 분리합니다. */
export function ConvertSource(props: ConvertSourceProps): JSX.Element {
  const identity = JSON.stringify([
    props.source,
    props.scope.connectionId,
    props.scope.userId,
    props.scope.tenant,
    props.scope.profileId,
    props.scope.policyRevision,
  ]);
  return <ConversionPanel key={identity} {...props} />;
}

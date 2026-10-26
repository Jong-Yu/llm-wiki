import {
  WorkspaceLayout,
  WorkspacePane,
  WorkspaceToolbar,
} from '@renderer/shared/ui/WorkspaceLayout';
import { useEffect } from 'react';
import type { ChangeEvent, JSX, ReactNode } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { ControllerRenderProps } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router';
import type { SourceVersionScope } from '@contracts/sources.contract';
import type { AnalysisExecutionScope } from '@contracts/analysis.contract';
import type { DocumentListItem } from '@contracts/documents.contract';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  conversionFieldsSchema,
  conversionLocationKinds,
  conversionMethods,
  emptyConversion,
  emptyLocation,
  emptyOutput,
  emptyPlan,
  planFieldsSchema,
} from '../model/analysisPlan.schema';
import type {
  ConversionFields,
  LocationFields,
  PlanFields,
} from '../model/analysisPlan.schema';
import {
  conversionDrafts,
  planDrafts,
  planningKey,
  usePlanAnalysis,
  usePlanCatalog,
} from '../model/usePlanAnalysis';
import type { PlanAnalysisModel } from '../model/usePlanAnalysis';
import type {
  PlanRecord,
  PlanningSource,
  SourceReference,
} from '../api/analysisPlan.api';
import { handoffComplete } from '../api/analysisPlan.api';
import styles from './PlanAnalysis.module.scss';

export type PlanConversionSlotProps = {
  source: Extract<DocumentListItem, { kind: 'source' }>;
  scope: SourceVersionScope;
  canConvert: boolean;
  onScopeInvalidated: () => void;
  sourceRef: SourceReference;
  onReportSaved: (conversionId: string) => void;
};
export type PlanAnalysisProps = {
  sourceId?: string;
  sourceVersion?: string;
  document?: string;
  onRunJob?: (jobId: string, scope: AnalysisExecutionScope) => void;
  renderConversion?: (props: PlanConversionSlotProps) => ReactNode;
};
type LocationEditorProps = {
  value: LocationFields;
  onChange: (value: LocationFields) => void;
  kinds: LocationFields['kind'][];
  disabled: boolean;
  label: string;
};
type PlanEditorProps = {
  source: PlanningSource;
  model: PlanAnalysisModel;
  canWrite: boolean;
  wikiItems: Extract<DocumentListItem, { kind: 'wiki' }>[];
};
type ConversionEditorProps = {
  source: PlanningSource;
  model: PlanAnalysisModel;
  canWrite: boolean;
};
type LookupProps = {
  label: string;
  disabled: boolean;
  onRead: (id: string) => void;
};
const lookupSchema = z.object({
  id: z
    .string()
    .regex(/^[a-f0-9]{32}$/, '실제 32자리 기록 ID를 입력해 주세요.'),
});
type LookupValues = z.infer<typeof lookupSchema>;

/** 폼 오류에서 메시지만 읽고 DOM 참조나 내부 상태는 화면에 노출하지 않습니다. */
function errorMessages(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const messages: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'message' && typeof entry === 'string') messages.push(entry);
    else if (key !== 'ref' && key !== 'types')
      messages.push(...errorMessages(entry));
  }
  return [...new Set(messages)];
}

/** 출처가 실제 지원하는 위치 종류만 편집합니다. */
function LocationEditor({
  value,
  onChange,
  kinds,
  disabled,
  label,
}: LocationEditorProps): JSX.Element {
  return (
    <div className={styles.range}>
      <label>
        {label}
        <select
          value={value.kind}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            const kind = kinds.find(
              (item: LocationFields['kind']): boolean =>
                item === event.currentTarget.value,
            );
            if (kind) onChange({ ...value, kind });
          }}
        >
          {kinds.map((kind: LocationFields['kind']): JSX.Element => (
            <option key={kind} value={kind}>
              {kind === 'whole'
                ? '전체'
                : kind === 'lines'
                  ? '줄'
                  : kind === 'pages'
                    ? '페이지'
                    : kind === 'cells'
                      ? '시트·셀'
                      : kind === 'blocks'
                        ? '본문 블록'
                        : kind === 'paragraphs'
                          ? '문단'
                          : '표·행·열'}
            </option>
          ))}
        </select>
      </label>
      {['lines', 'pages', 'blocks', 'paragraphs'].includes(value.kind) && (
        <>
          <label>
            시작
            <input
              aria-label={`${label} 시작`}
              inputMode="numeric"
              value={value.start}
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                onChange({ ...value, start: event.currentTarget.value })
              }
            />
          </label>
          <label>
            끝
            <input
              aria-label={`${label} 끝`}
              inputMode="numeric"
              value={value.end}
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                onChange({ ...value, end: event.currentTarget.value })
              }
            />
          </label>
        </>
      )}
      {value.kind === 'table_cells' && (
        <>
          {(['table', 'row', 'column'] as const).map(
            (field: 'table' | 'row' | 'column'): JSX.Element => (
              <label key={field}>
                {field === 'table'
                  ? '표 번호'
                  : field === 'row'
                    ? '행 번호'
                    : '열 번호'}
                <input
                  aria-label={`${label} ${field}`}
                  inputMode="numeric"
                  value={value[field]}
                  disabled={disabled}
                  onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                    onChange({ ...value, [field]: event.currentTarget.value })
                  }
                />
              </label>
            ),
          )}
        </>
      )}
      {value.kind === 'cells' && (
        <>
          <label>
            시트
            <input
              aria-label={`${label} 시트`}
              value={value.sheet}
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                onChange({ ...value, sheet: event.currentTarget.value })
              }
            />
          </label>
          <label>
            셀 범위
            <input
              aria-label={`${label} 셀 범위`}
              value={value.cells}
              disabled={disabled}
              placeholder="A1:B2"
              onChange={(event: ChangeEvent<HTMLInputElement>): void =>
                onChange({ ...value, cells: event.currentTarget.value })
              }
            />
          </label>
        </>
      )}
    </div>
  );
}

/** 저장된 실제 ID 조회는 새 변환·계획 생성과 분리한 읽기 폼입니다. */
function RecordLookup({ label, disabled, onRead }: LookupProps): JSX.Element {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LookupValues>({
    resolver: zodResolver(lookupSchema),
    defaultValues: { id: '' },
  });
  /** 입력 검증 뒤 기존 기록의 GET만 호출합니다. */
  function read(values: LookupValues): void {
    onRead(values.id);
  }
  return (
    <form className={styles.lookup} onSubmit={handleSubmit(read)}>
      <label>
        {label} ID
        <input
          {...register('id')}
          disabled={disabled}
          aria-invalid={!!errors.id}
        />
      </label>
      <Button type="submit" variant="secondary" disabled={disabled}>
        {label} 조회
      </Button>
      {errors.id && <p role="alert">{errors.id.message}</p>}
    </form>
  );
}

/** 사용자가 외부에서 실제 얻은 문자·단위·경고만 변환 보고로 제출합니다. */
function ConversionEditor({
  source,
  model,
  canWrite,
}: ConversionEditorProps): JSX.Element {
  const format = source.item.kind === 'source' ? source.item.format : 'md';
  const key = planningKey(source);
  const {
    register,
    control,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<ConversionFields>({
    resolver: zodResolver(conversionFieldsSchema),
    defaultValues: conversionDrafts.get(key) ?? emptyConversion(format),
  });
  const units = useFieldArray({ control, name: 'units' });
  const disabled =
    !canWrite || model.busy || !!model.pending || !!model.plan || model.invalid;
  const kinds = conversionLocationKinds(format);
  const methods = conversionMethods(format);
  useEffect(
    (): (() => void) => (): void => {
      conversionDrafts.set(key, getValues());
    },
    [key, getValues],
  );
  /** 검증된 실제 단위 보고는 선택 원본 참조에 고정해 한 번만 기록합니다. */
  function submit(values: ConversionFields): void {
    conversionDrafts.set(key, values);
    model.createReport(values);
  }
  const messages = errorMessages(errors);
  return (
    <details className={styles.conversion}>
      <summary>외부 변환 보고 입력·조회</summary>
      <p>
        개인 PC의 도구·OCR·스프레드시트에서 실제 얻은 문자와 위치를 입력합니다.
        이 화면은 변환 도구를 실행하지 않으며 보고의 의미 정확도를 승인하지
        않습니다.
      </p>
      <RecordLookup
        label="변환 보고"
        disabled={disabled}
        onRead={model.readReport}
      />
      <form onSubmit={handleSubmit(submit)} aria-label="외부 변환 보고">
        <label>
          실제 변환 방법
          <select {...register('method')} disabled={disabled}>
            {methods.map((method: ConversionFields['method']): JSX.Element => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>
        {units.fields.map(
          (unit: (typeof units.fields)[number], index: number): JSX.Element => (
            <article key={unit.id} className={styles.unit}>
              <header>
                <h4>보고 단위 {index + 1}</h4>
                <Button
                  variant="secondary"
                  disabled={disabled || units.fields.length === 1}
                  onClick={(): void => units.remove(index)}
                >
                  보고 단위 제외
                </Button>
              </header>
              <label>
                단위 ID
                <input
                  {...register(`units.${index}.unitId`)}
                  disabled={disabled}
                />
              </label>
              <Controller
                control={control}
                name={`units.${index}.location`}
                render={({
                  field,
                }: {
                  field: ControllerRenderProps<
                    ConversionFields,
                    `units.${number}.location`
                  >;
                }): JSX.Element => (
                  <LocationEditor
                    value={field.value}
                    onChange={field.onChange}
                    kinds={kinds}
                    disabled={disabled}
                    label={`보고 단위 ${index + 1} 위치`}
                  />
                )}
              />
              <label>
                실제 변환 문자
                <textarea
                  {...register(`units.${index}.content`)}
                  disabled={disabled}
                  rows={6}
                />
              </label>
            </article>
          ),
        )}
        <Button
          variant="secondary"
          disabled={disabled || units.fields.length >= 1000}
          onClick={(): void =>
            units.append({
              unitId: '',
              location:
                emptyConversion(format).units[0]?.location ?? emptyLocation(),
              content: '',
            })
          }
        >
          보고 단위 추가
        </Button>
        <label className={styles.check}>
          <input
            type="checkbox"
            {...register('complete')}
            disabled={disabled}
          />
          보고한 범위에 미독 구간이 없습니다
        </label>
        <label>
          미독 범위 · 한 줄에 하나
          <textarea
            {...register('unreadRanges')}
            disabled={disabled}
            rows={3}
          />
        </label>
        <label>
          경고 · 한 줄에 하나
          <textarea {...register('warnings')} disabled={disabled} rows={3} />
        </label>
        {messages.length > 0 && (
          <StatusNotice tone="error" title="변환 보고 입력 확인">
            <ul>
              {messages.map((message: string): JSX.Element => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </StatusNotice>
        )}
        <Button type="submit" disabled={disabled}>
          실제 변환 보고 기록
        </Button>
      </form>
    </details>
  );
}

/** 범위를 선언한 뒤 산출물마다 그중 필요한 실제 구간과 목적을 선택합니다. */
function PlanEditor({
  source,
  model,
  canWrite,
  wikiItems,
}: PlanEditorProps): JSX.Element {
  const key = planningKey(source);
  const {
    register,
    control,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<PlanFields>({
    resolver: zodResolver(planFieldsSchema),
    defaultValues: planDrafts.get(key) ?? emptyPlan(),
  });
  const ranges = useFieldArray({ control, name: 'locations' });
  const outputs = useFieldArray({ control, name: 'outputs' });
  const contexts = useFieldArray({ control, name: 'contexts' });
  const currentRanges = useWatch({ control, name: 'locations' });
  const disabled =
    !canWrite || model.busy || !!model.pending || !!model.plan || model.invalid;
  const format = source.item.kind === 'source' ? source.item.format : 'md';
  const converted = !!model.conversion;
  const kinds: LocationFields['kind'][] =
    converted || format === 'md' || format === 'txt'
      ? conversionLocationKinds(format)
      : ['whole'];
  useEffect(
    (): (() => void) => (): void => {
      planDrafts.set(key, getValues());
    },
    [key, getValues],
  );
  /** 원래 고정 출처와 검증된 폼을 그대로 불변 계획 생성에 전달합니다. */
  function submit(values: PlanFields): void {
    planDrafts.set(key, values);
    model.createPlan(values);
  }
  const messages = errorMessages(errors);
  return (
    <form
      onSubmit={handleSubmit(submit)}
      className={styles.planForm}
      aria-label="분석 범위·산출물 계획"
    >
      <section>
        <h2>1. 분석할 범위</h2>
        <p>
          줄은 실제 UTF-8 본문에서 선택합니다. 전체는 원문 전체 또는 연결한 변환
          보고의 모든 단위를 뜻합니다.
        </p>
        {ranges.fields.map(
          (
            range: (typeof ranges.fields)[number],
            index: number,
          ): JSX.Element => (
            <article key={range.id} className={styles.unit}>
              <Controller
                control={control}
                name={`locations.${index}`}
                render={({
                  field,
                }: {
                  field: ControllerRenderProps<
                    PlanFields,
                    `locations.${number}`
                  >;
                }): JSX.Element => (
                  <LocationEditor
                    value={field.value}
                    onChange={field.onChange}
                    kinds={kinds}
                    disabled={disabled}
                    label={`분석 구간 ${index + 1}`}
                  />
                )}
              />
              <Button
                variant="secondary"
                disabled={disabled || ranges.fields.length === 1}
                onClick={(): void => ranges.remove(index)}
              >
                구간 제외
              </Button>
            </article>
          ),
        )}
        <Button
          variant="secondary"
          disabled={disabled || ranges.fields.length >= 100}
          onClick={(): void =>
            ranges.append({
              ...emptyLocation(),
              kind: kinds.includes('lines')
                ? 'lines'
                : kinds.includes('pages')
                  ? 'pages'
                  : kinds.includes('cells')
                    ? 'cells'
                    : 'whole',
            })
          }
        >
          분석 구간 추가
        </Button>
      </section>
      <section>
        <h2>2. 만들 문서</h2>
        <p>
          최대 8개 문서를 지정합니다. 산출물별 구간을 고르지 않으면 선언한 분석
          범위를 모두 사용합니다.
        </p>
        {outputs.fields.map(
          (
            output: (typeof outputs.fields)[number],
            index: number,
          ): JSX.Element => (
            <article key={output.id} className={styles.output}>
              <header>
                <h3>문서 {index + 1}</h3>
                <Button
                  variant="secondary"
                  disabled={disabled || outputs.fields.length === 1}
                  onClick={(): void => outputs.remove(index)}
                >
                  산출물 제외
                </Button>
              </header>
              <label>
                저장할 Wiki 경로
                <input
                  {...register(`outputs.${index}.document`)}
                  disabled={disabled}
                  placeholder="분석/문서.md"
                />
              </label>
              <label>
                문서 제목
                <input
                  {...register(`outputs.${index}.title`)}
                  disabled={disabled}
                />
              </label>
              <label>
                문서 목적
                <textarea
                  {...register(`outputs.${index}.purpose`)}
                  rows={2}
                  disabled={disabled}
                />
              </label>
              <fieldset disabled={disabled}>
                <legend>저장할 산출물</legend>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    value="wiki"
                    {...register(`outputs.${index}.outputs`)}
                  />
                  Wiki 본문
                </label>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    value="ontology"
                    {...register(`outputs.${index}.outputs`)}
                  />
                  기계 지식
                </label>
              </fieldset>
              <fieldset disabled={disabled}>
                <legend>이 문서에 사용할 구간 · 미선택 시 모두</legend>
                {currentRanges.map(
                  (range: LocationFields, rangeIndex: number): JSX.Element => (
                    <label key={rangeIndex} className={styles.check}>
                      <input
                        type="checkbox"
                        value={String(rangeIndex)}
                        {...register(`outputs.${index}.selectedRanges`)}
                      />
                      구간 {rangeIndex + 1}:{' '}
                      {range.kind === 'whole'
                        ? '전체'
                        : range.kind === 'cells'
                          ? `${range.sheet} ${range.cells}`
                          : `${range.start}–${range.end} ${range.kind === 'lines' ? '줄' : '페이지'}`}
                    </label>
                  ),
                )}
              </fieldset>
            </article>
          ),
        )}
        <Button
          variant="secondary"
          disabled={disabled || outputs.fields.length >= 8}
          onClick={(): void => outputs.append(emptyOutput())}
        >
          만들 문서 추가
        </Button>
      </section>
      <section>
        <h2>3. 함께 읽을 정의·예외</h2>
        <p>
          최대 7개 문서의 이유와 필수 여부를 지정합니다. 서버가 실제 문맥 판본을
          고정합니다.
        </p>
        {contexts.fields.map(
          (
            context: (typeof contexts.fields)[number],
            index: number,
          ): JSX.Element => (
            <article className={styles.unit} key={context.id}>
              <label>
                문맥 Wiki
                <select
                  {...register(`contexts.${index}.document`)}
                  disabled={disabled}
                >
                  <option value="">문서 선택</option>
                  {wikiItems.map(
                    (
                      item: Extract<DocumentListItem, { kind: 'wiki' }>,
                    ): JSX.Element => (
                      <option value={item.document} key={item.document}>
                        {item.document}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                함께 읽는 이유
                <input
                  {...register(`contexts.${index}.reason`)}
                  disabled={disabled}
                />
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  {...register(`contexts.${index}.required`)}
                  disabled={disabled}
                />
                필수 문맥
              </label>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={(): void => contexts.remove(index)}
              >
                문맥 제외
              </Button>
            </article>
          ),
        )}
        <Button
          variant="secondary"
          disabled={
            disabled || contexts.fields.length >= 7 || wikiItems.length === 0
          }
          onClick={(): void =>
            contexts.append({ document: '', required: true, reason: '' })
          }
        >
          문맥 문서 추가
        </Button>
      </section>
      {messages.length > 0 && (
        <StatusNotice tone="error" title="계획 입력 확인">
          <ul>
            {messages.map((message: string): JSX.Element => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </StatusNotice>
      )}
      <footer>
        <Button type="submit" disabled={disabled}>
          분석 계획 생성
        </Button>
        {model.plan && (
          <Button
            variant="secondary"
            disabled={model.busy || !!model.pending || model.invalid}
            onClick={model.newDraft}
          >
            이 입력으로 새 계획 작성
          </Button>
        )}
      </footer>
    </form>
  );
}

type SessionProps = Pick<PlanAnalysisProps, 'onRunJob' | 'renderConversion'> & {
  source: PlanningSource;
  canWrite: boolean;
  wikiItems: Extract<DocumentListItem, { kind: 'wiki' }>[];
};

/** 선택 출처의 고정 기준과 계획 상태를 중앙·오른쪽 독립 패널에 배치합니다. */
function PlanningSession({
  source,
  canWrite,
  wikiItems,
  onRunJob,
  renderConversion,
}: SessionProps): JSX.Element {
  const model = usePlanAnalysis(source, canWrite);
  const title =
    source.item.kind === 'wiki' ? source.item.document : source.item.title;
  if (model.invalid)
    return (
      <>
        <WorkspacePane name="content">
          <div className={styles.invalid}>
            <StatusNotice tone="warning" title="입력 범위 다시 확인">
              {model.message} 원래 범위의 초안·미확인 요청은 보존했습니다. 왼쪽
              위의 현재 연결 다시 확인을 선택해 주세요.
            </StatusNotice>
          </div>
        </WorkspacePane>
        <WorkspacePane name="inspector">
          <aside className={styles.inspector}>
            현재 연결을 다시 확인해 주세요.
          </aside>
        </WorkspacePane>
      </>
    );
  return (
    <>
      <WorkspacePane name="content">
        <section className={styles.editor} aria-label="분석 계획 편집">
          <header>
            <h1>분석 범위·산출물</h1>
            <p>{title}</p>
          </header>
          <div className={styles.scroll}>
            {!canWrite && (
              <StatusNotice title="계획 읽기 전용">
                현재 작업 공간에 원본·계획 쓰기 권한이 없습니다. 실제 ID의
                저장된 계획은 읽을 수 있습니다.
              </StatusNotice>
            )}
            {model.message && (
              <StatusNotice title="분석 계획 안내">
                {model.message}
              </StatusNotice>
            )}
            {model.pending && (
              <StatusNotice
                tone="warning"
                title={
                  model.pending.status === 'sending'
                    ? '요청을 확인하고 있습니다'
                    : '요청 결과 미확인·재전송 잠금'
                }
              >
                <p>
                  요청 {model.pending.requestId}. 같은 요청을 다시 보내지
                  않습니다.
                </p>
                {model.pending.recovery ? (
                  <Button
                    variant="secondary"
                    disabled={model.busy}
                    onClick={model.recover}
                  >
                    같은 요청의 저장 기록 확인
                  </Button>
                ) : (
                  <p>
                    읽기 복구 참조가 아직 없어 결과를 확정할 수 없습니다. 현재
                    요청 기록을 확인해 주세요.
                  </p>
                )}
              </StatusNotice>
            )}
            <RecordLookup
              label="분석 계획"
              disabled={model.busy || !!model.pending}
              onRead={model.readPlan}
            />
            {renderConversion &&
              source.sourceRef &&
              source.item.kind === 'source' &&
              !model.plan &&
              !model.pending &&
              !model.busy &&
              canWrite &&
              renderConversion({
                source: source.item,
                scope: source.scope,
                canConvert: canWrite,
                onScopeInvalidated: model.invalidate,
                sourceRef: source.sourceRef,
                onReportSaved: model.readReport,
              })}
            {source.sourceRef && (
              <ConversionEditor
                source={source}
                model={model}
                canWrite={canWrite}
              />
            )}
            <PlanEditor
              source={source}
              model={model}
              canWrite={canWrite}
              wikiItems={wikiItems}
            />
            {model.plan && (
              <section
                className={styles.stored}
                aria-label="저장된 계획·선택 문자"
              >
                <h2>고정 계획과 문서별 선택 문자</h2>
                <p>폼 초안과 별도로 서버가 보존한 실제 계획입니다.</p>
                <RecordDetails record={model.plan} />
                {Object.entries(model.plan.components).map(
                  ([name, text]: [string, string]): JSX.Element => (
                    <details key={name}>
                      <summary>{name}</summary>
                      <pre>{text}</pre>
                    </details>
                  ),
                )}
              </section>
            )}
          </div>
        </section>
      </WorkspacePane>
      <WorkspacePane name="inspector">
        <aside className={styles.inspector} aria-label="분석 계획 근거·인계">
          <h2>고정 입력 기준</h2>
          <dl>
            <dt>출처</dt>
            <dd>{title}</dd>
            <dt>작업 공간·관점</dt>
            <dd>
              {source.scope.tenant} / {source.scope.profileId}
            </dd>
            <dt>정책 판본</dt>
            <dd>{source.scope.policyRevision}</dd>
          </dl>
          <details>
            <summary>출처 판본 전체</summary>
            <pre>
              {JSON.stringify(source.sourceRef || source.wikiRef, null, 2)}
            </pre>
          </details>
          <details>
            <summary>실제 원문 보기</summary>
            {source.content === null ? (
              <p>바이너리 원본의 문자는 변환 보고를 연결해야 합니다.</p>
            ) : (
              <pre>{source.content || '빈 원문입니다.'}</pre>
            )}
          </details>
          {model.conversion && (
            <section>
              <h3>연결 변환 보고</h3>
              <RecordDetails record={model.conversion} />
              <p>
                {model.conversion.manifest.complete
                  ? '보고 단위: 완전 보고'
                  : '보고 단위: 불완전 보고'}
              </p>
              <p>원본 전체 충실성·의미 정확도: 미검증</p>
              <details>
                <summary>실제 단위별 변환 문자</summary>
                <pre>
                  {JSON.stringify(model.conversion.components, null, 2)}
                </pre>
              </details>
            </section>
          )}
          {model.plan && (
            <section>
              <h3>서버 계획</h3>
              <details>
                <summary>계획 ID·판본</summary>
                <dl>
                  <dt>계획 ID</dt>
                  <dd>{model.plan.manifest.id}</dd>
                  <dt>계획 판본</dt>
                  <dd>{model.plan.revision}</dd>
                </dl>
              </details>
              <dl>
                <dt>입력 준비</dt>
                <dd>
                  {model.plan.manifest.ready
                    ? '문자 입력 보유 · 현재 기준 검증 필요'
                    : '준비 미완료 · 변환 보고 필요'}
                </dd>
              </dl>
              <Button
                variant="secondary"
                disabled={model.busy || !!model.pending}
                onClick={model.validate}
              >
                현재 기준 서버 검증
              </Button>
              {model.validation && (
                <p>
                  현재 기준 검증:{' '}
                  {model.validation.ready ? '성공' : '준비 미완료'} · AI 실행
                  시작 안 함
                </p>
              )}
              <Button
                disabled={
                  !canWrite ||
                  model.busy ||
                  !!model.pending ||
                  !model.validation?.ready ||
                  !!model.handoff
                }
                onClick={model.handoffPlan}
              >
                검증한 계획을 작업으로 인계
              </Button>
            </section>
          )}
          {model.handoff && (
            <section aria-label="분석 계획 인계 결과">
              <h3>
                {handoffComplete(model.handoff, model.plan)
                  ? '문서별 작업 접수 완료'
                  : '일부 작업 접수 미확인'}
              </h3>
              <p>개인 AI 실행은 시작되지 않았습니다.</p>
              <p>
                인계는 문서별 선택 문자를 별도 원본으로 등록하고 기존 분석
                작업을 접수합니다. AI 작업에서 접수 상태를 확인해 주세요.
              </p>
              <Link to="/analysis">AI 작업 목록에서 확인</Link>
              <ul className={styles.handoffJobs}>
                {model.handoff.jobs.map(
                  (
                    job: NonNullable<
                      PlanAnalysisModel['handoff']
                    >['jobs'][number],
                    index: number,
                  ): JSX.Element => (
                    <li key={`${job.document}:${index}`}>
                      <strong>{job.document}</strong>
                      <span>
                        {job.state === 'complete'
                          ? '작업 접수 완료'
                          : job.state === 'not_received'
                            ? '접수 기록 미확인'
                            : job.state === 'pending_reconcile'
                              ? '접수 조정 대기'
                              : '현재 접수 상태 확인 필요'}
                      </span>
                      {job.job_id && job.state === 'complete' && onRunJob && (
                        <Button
                          variant="secondary"
                          disabled={model.busy || !!model.pending}
                          onClick={(): void => {
                            if (job.job_id) onRunJob(job.job_id, source.scope);
                          }}
                        >
                          이 작업 실행·재개 확인
                        </Button>
                      )}
                      {job.job_id && (
                        <details>
                          <summary>작업 번호 보기</summary>
                          <code>{job.job_id}</code>
                        </details>
                      )}
                    </li>
                  ),
                )}
              </ul>
              <details>
                <summary>전체 인계 영수증</summary>
                <pre>{JSON.stringify(model.handoff, null, 2)}</pre>
              </details>
            </section>
          )}
          {model.previousPlans.length > 0 && (
            <section>
              <h3>이전 계획·확인 기록 ID</h3>
              {model.previousPlans.map((plan: PlanRecord): JSX.Element => (
                <p key={plan.manifest.id}>{plan.manifest.id}</p>
              ))}
            </section>
          )}
        </aside>
      </WorkspacePane>
    </>
  );
}

type RecordDetailsProps = { record: PlanRecord };
/** 불변 공개 ID·판본과 원래 전체 manifest를 보존해 표시합니다. */
function RecordDetails({ record }: RecordDetailsProps): JSX.Element {
  return (
    <>
      <dl>
        <dt>기록 ID</dt>
        <dd>{record.manifest.id}</dd>
        <dt>기록 판본</dt>
        <dd>{record.revision}</dd>
      </dl>
      <details>
        <summary>당시 전체 입력·경고·근거</summary>
        <pre>{JSON.stringify(record.manifest, null, 2)}</pre>
      </details>
    </>
  );
}

/** 실제 자료 선택부터 범위·다중 산출물 계획과 명시 작업 인계까지 조합합니다. */
export function PlanAnalysis(props: PlanAnalysisProps): JSX.Element {
  const model = usePlanCatalog(props);
  const catalog = model.state.status === 'ready' ? model.state.catalog : null;
  const selected = model.source.status === 'ready' ? model.source.source : null;
  const wikiItems = model.items.filter(
    (
      item: DocumentListItem,
    ): item is Extract<DocumentListItem, { kind: 'wiki' }> =>
      item.kind === 'wiki',
  );
  return (
    <section
      className={styles.workspace}
      aria-label="분석 범위·산출물 작업 공간"
    >
      <WorkspaceToolbar className={styles.toolbar}>
        <h1>분석 범위·산출물</h1>
        <span>
          {catalog
            ? `${catalog.scope.tenant} / ${catalog.scope.profileId}`
            : '현재 연결 확인'}
        </span>
        <Button
          variant="secondary"
          disabled={model.state.status === 'loading'}
          onClick={model.refresh}
        >
          현재 연결 다시 확인
        </Button>
        <Link to="/analysis">AI 작업</Link>
      </WorkspaceToolbar>
      <WorkspaceLayout className={styles.layout}>
        <WorkspacePane name="index">
          <aside className={styles.materials} aria-label="분석할 실제 자료">
            <header>
              <h2>분석할 자료</h2>
              <p>등록 원본 또는 Wiki를 선택합니다.</p>
            </header>
            <div className={styles.scroll}>
              {model.state.status === 'loading' && (
                <StatusNotice title="자료 목록 조회 중">
                  현재 허용 범위를 확인합니다.
                </StatusNotice>
              )}
              {model.state.status === 'error' && (
                <StatusNotice tone="error" title="자료 목록 확인 안내">
                  {model.state.message}
                  <p>
                    <Link to="/setup/connection">서버 연결·작업 공간 선택</Link>
                  </p>
                </StatusNotice>
              )}
              {catalog && model.items.length === 0 && (
                <p>현재 페이지에 표시할 자료가 없습니다.</p>
              )}
              <ul>
                {model.items.map((item: DocumentListItem): JSX.Element => {
                  const key =
                    item.kind === 'wiki' ? item.document : item.sourceId;
                  const active =
                    selected &&
                    (selected.item.kind === 'wiki'
                      ? selected.item.document
                      : selected.item.sourceId) === key;
                  return (
                    <li key={`${item.kind}:${key}`}>
                      <button
                        type="button"
                        aria-pressed={!!active}
                        onClick={(): void => model.select(item)}
                      >
                        <strong>
                          {item.kind === 'wiki' ? item.document : item.title}
                        </strong>
                        <span>
                          {item.kind === 'wiki'
                            ? 'Wiki 본문'
                            : `등록 원본 · ${item.format}`}
                        </span>
                        {item.kind === 'source' && (
                          <small>{item.sizeBytes.toLocaleString()} B</small>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <footer>
              {catalog &&
                (!catalog.page.complete ||
                  catalog.page.truncated ||
                  catalog.page.skipped.length > 0 ||
                  catalog.page.requiresRefresh) && (
                  <StatusNotice tone="warning" title="자료 목록 조회 범위">
                    {catalog.page.nextCursor
                      ? '다음 자료가 있습니다. '
                      : '조회가 완전하지 않습니다. '}
                    {catalog.page.truncated && '조회 한도 도달. '}누락{' '}
                    {catalog.page.skipped.length}개.
                    {catalog.page.requiresRefresh &&
                      '목록이 바뀌어 재조회가 필요합니다.'}
                  </StatusNotice>
                )}
              <Button
                variant="secondary"
                disabled={
                  !catalog?.page.nextCursor || catalog.page.requiresRefresh
                }
                onClick={model.more}
              >
                자료 더 보기
              </Button>
            </footer>
          </aside>
        </WorkspacePane>
        {selected && catalog ? (
          <PlanningSession
            key={planningKey(selected)}
            source={selected}
            canWrite={catalog.canWrite}
            wikiItems={wikiItems}
            onRunJob={props.onRunJob}
            renderConversion={props.renderConversion}
          />
        ) : (
          <>
            <WorkspacePane name="content">
              <div className={styles.empty}>
                {model.source.status === 'loading' ? (
                  <StatusNotice title="실제 입력 기준 조회 중">
                    원문·지식 판본을 확인합니다.
                  </StatusNotice>
                ) : model.source.status === 'error' ? (
                  <StatusNotice tone="error" title="입력 기준 확인 안내">
                    {model.source.message}
                  </StatusNotice>
                ) : (
                  <>
                    <h2>분석할 자료를 선택해 주세요</h2>
                    <p>선택은 새 분석·변환·저장을 시작하지 않습니다.</p>
                  </>
                )}
              </div>
            </WorkspacePane>
            <WorkspacePane name="inspector">
              <aside className={styles.inspector}>
                분석할 자료를 선택하면 입력 근거를 확인할 수 있습니다.
              </aside>
            </WorkspacePane>
          </>
        )}
      </WorkspaceLayout>
    </section>
  );
}

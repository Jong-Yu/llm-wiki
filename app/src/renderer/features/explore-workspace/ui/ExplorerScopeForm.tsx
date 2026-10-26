import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DocumentListItem } from '@contracts/documents.contract';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import type { WorkspaceExplorerModel } from '../model/useWorkspaceExplorer';
import {
  explorerDefaults,
  explorerFormSchema,
} from '../model/explorerForm.schema';
import type {
  ExplorerMode,
  ExplorerValues,
} from '../model/explorerForm.schema';
import { statusLabel } from '../model/explorerPresentation';
import type {
  ExplorerCatalog,
  ClaimOption,
} from '../api/workspaceExplorer.api';
import styles from './WorkspaceExplorer.module.scss';

type ExplorerScopeFormProps = {
  formId: string;
  mode: ExplorerMode;
  catalog: ExplorerCatalog;
  model: WorkspaceExplorerModel;
  onSubmit: (values: ExplorerValues) => void;
  locked: boolean;
  onScopeChange: () => void;
  initialDocument?: string;
};

/** 문서·원본·주장 초안을 RHF로 관리하고 선택 항목을 조용히 제외하지 않습니다. */
export function ExplorerScopeForm({
  formId,
  mode,
  catalog,
  model,
  onSubmit,
  locked,
  onScopeChange,
  initialDocument,
}: ExplorerScopeFormProps): JSX.Element {
  const {
    register,
    control,
    handleSubmit,
    setError,
    clearErrors,
    getValues,
    formState: { errors },
  } = useForm<ExplorerValues, unknown>({
    resolver: zodResolver(explorerFormSchema),
    defaultValues: {
      ...explorerDefaults(),
      documents: initialDocument ? [initialDocument] : [],
    },
  });
  const documents = useWatch({ control, name: 'documents' });
  const operation = useWatch({ control, name: 'operation' });
  const selectedClaims = useWatch({ control, name: 'claims' });
  const wiki = catalog.items.filter(
    (item: DocumentListItem): boolean => item.kind === 'wiki',
  );
  const sources = catalog.items.filter(
    (item: DocumentListItem): boolean => item.kind === 'source',
  );
  const availableDocuments = new Set(
    wiki.flatMap((item: DocumentListItem): string[] =>
      item.kind === 'wiki' ? [item.document] : [],
    ),
  );
  const retained = documents.filter(
    (document: string): boolean => !availableDocuments.has(document),
  );

  /** 모드별 최소 입력과 전체 선택 상한을 명확히 확인합니다. */
  function submit(values: ExplorerValues): void {
    const needsDocument =
      mode !== 'questions' &&
      (mode !== 'knowledge' ||
        !['conceptFind', 'search'].includes(values.operation));
    if (
      mode === 'questions' &&
      values.documents.length === 0 &&
      values.requiredDocuments.length === 0 &&
      values.sourceIds.length === 0
    ) {
      setError('documents', {
        message: '위키·필수 문서 또는 고정 원본을 선택해 주세요.',
      });
      return;
    }
    if (needsDocument && values.documents.length === 0) {
      setError('documents', {
        message: '조회할 위키 문서를 먼저 선택해 주세요.',
      });
      return;
    }
    if (
      mode === 'knowledge' &&
      ['ontology', 'connections', 'impact'].includes(values.operation) &&
      values.documents.length !== 1
    ) {
      setError('documents', {
        message: '이 조회는 위키 문서 한 개를 선택해 주세요.',
      });
      return;
    }
    if (
      mode === 'knowledge' &&
      ['conceptFind', 'search'].includes(values.operation) &&
      !values.query.trim()
    ) {
      setError('query', { message: '찾을 단어를 입력해 주세요.' });
      return;
    }
    if (new Set([...values.documents, ...values.requiredDocuments]).size > 8) {
      setError('requiredDocuments', {
        message: '선택 문서와 필수 문서는 합쳐서 최대 8개입니다.',
      });
      return;
    }
    if (
      values.claims.some(
        (key: string): boolean =>
          !model.claims.some(
            (claim: ClaimOption): boolean => claim.key === key,
          ),
      )
    ) {
      setError('claims', {
        message:
          '선택 주장의 기준이 변경되었습니다. 현재 주장 목록에서 다시 확인해 주세요.',
      });
      return;
    }
    if (
      values.sourceIds.some(
        (id: string): boolean =>
          !sources.some(
            (item: DocumentListItem): boolean =>
              item.kind === 'source' && item.sourceId === id,
          ),
      )
    ) {
      setError('sourceIds', {
        message: '선택 원본의 현재 판본을 다시 확인해 주세요.',
      });
      return;
    }
    if (
      mode === 'questions' &&
      model.claims.some(
        (claim: ClaimOption): boolean =>
          selectedClaims.includes(claim.key) &&
          ![...values.documents, ...values.requiredDocuments].includes(
            claim.document,
          ),
      )
    ) {
      setError('claims', {
        message: '모든 선택 주장의 문서를 조회 범위에 포함해 주세요.',
      });
      return;
    }
    onSubmit(values);
  }
  return (
    <form
      id={formId}
      onSubmit={handleSubmit(submit)}
      onChange={(): void => {
        clearErrors();
        onScopeChange();
      }}
      noValidate
      className={styles.form}
    >
      <fieldset disabled={locked}>
        <legend>조회 범위</legend>
        {mode === 'knowledge' && (
          <>
            <SelectField {...register('operation')} label="조회 방식">
              <option value="conceptFind">개념·관계 찾기</option>
              <option value="search">원문 문자열 검색</option>
              <option value="ontology">문서의 기계 추출</option>
              <option value="context">선택 원문·전체 그래프</option>
              <option value="connections">문서 연결</option>
              <option value="impact">문서 변경 영향</option>
            </SelectField>
            {['conceptFind', 'search'].includes(operation) && (
              <TextField
                {...register('query')}
                label="찾을 단어"
                maxLength={200}
                error={errors.query?.message}
                placeholder="개념·문장에 포함된 단어"
              />
            )}
          </>
        )}
        <div className={styles.documentChoices}>
          <h3>위키 문서 · 최대 8개</h3>
          {wiki.length === 0 && (
            <p className={styles.caption}>
              현재까지 읽은 목록에 위키가 없습니다.
            </p>
          )}
          {wiki.map((item: DocumentListItem): JSX.Element | null =>
            item.kind === 'wiki' ? (
              <label key={item.document}>
                <input
                  type="checkbox"
                  {...register('documents')}
                  value={item.document}
                />
                <span>{item.document}</span>
              </label>
            ) : null,
          )}
          {retained.map((document: string): JSX.Element => (
            <label key={document}>
              <input
                type="checkbox"
                {...register('documents')}
                value={document}
              />
              <span>{document} · 이전 선택</span>
            </label>
          ))}
        </div>
        {errors.documents?.message && (
          <p role="alert" className={styles.error}>
            {errors.documents.message}
          </p>
        )}
        {mode === 'questions' && (
          <>
            <div className={styles.documentChoices}>
              <h3>정의·예외의 필수 문서</h3>
              {wiki.map((item: DocumentListItem): JSX.Element | null =>
                item.kind === 'wiki' ? (
                  <label key={item.document}>
                    <input
                      type="checkbox"
                      {...register('requiredDocuments')}
                      value={item.document}
                    />
                    <span>{item.document}</span>
                  </label>
                ) : null,
              )}
            </div>
            {errors.requiredDocuments?.message && (
              <p role="alert" className={styles.error}>
                {errors.requiredDocuments.message}
              </p>
            )}
            <div className={styles.documentChoices}>
              <h3>고정 원본 · 최대 4개</h3>
              {sources.map((item: DocumentListItem): JSX.Element | null =>
                item.kind === 'source' ? (
                  <label key={item.sourceId}>
                    <input
                      type="checkbox"
                      {...register('sourceIds')}
                      value={item.sourceId}
                    />
                    <span>
                      {item.title}
                      <small>{item.sourceVersion}</small>
                    </span>
                  </label>
                ) : null,
              )}
            </div>
            {errors.sourceIds?.message && (
              <p role="alert" className={styles.error}>
                {errors.sourceIds.message}
              </p>
            )}
            <Button
              variant="secondary"
              onClick={(): void => {
                void model.loadClaims([
                  ...new Set([
                    ...getValues('documents'),
                    ...getValues('requiredDocuments'),
                  ]),
                ]);
              }}
            >
              선택 문서의 현재 주장 확인
            </Button>
            {model.claims.length > 0 && (
              <div className={styles.documentChoices}>
                <h3>질문에 고정할 주장</h3>
                {model.claims.map((claim: ClaimOption): JSX.Element => (
                  <label key={claim.key}>
                    <input
                      type="checkbox"
                      {...register('claims')}
                      value={claim.key}
                    />
                    <span>
                      {claim.label}
                      <small>{claim.document} · 현재 판본 참조</small>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {selectedClaims
              .filter(
                (key: string): boolean =>
                  !model.claims.some(
                    (claim: ClaimOption): boolean => claim.key === key,
                  ),
              )
              .map((key: string): JSX.Element => (
                <label key={key} className={styles.check}>
                  <input type="checkbox" {...register('claims')} value={key} />
                  <span>
                    이전 기준의 선택 주장 · 선택을 해제하고 현재 주장을 다시
                    선택해 주세요.
                  </span>
                </label>
              ))}
            {errors.claims?.message && (
              <p role="alert" className={styles.error}>
                {errors.claims.message}
              </p>
            )}
          </>
        )}
        {mode === 'review' && (
          <div className={styles.documentChoices}>
            <h3>검토 상태</h3>
            {['unreviewed', 'defer', 'pending'].map(
              (state: string): JSX.Element => (
                <label key={state}>
                  <input
                    type="checkbox"
                    {...register('states')}
                    value={state}
                  />
                  <span>{statusLabel(state)}</span>
                </label>
              ),
            )}
            {errors.states?.message && (
              <p role="alert" className={styles.error}>
                {errors.states.message}
              </p>
            )}
          </div>
        )}
        {mode !== 'questions' && (
          <>
            {(mode === 'review' || mode === 'history') && (
              <TextField
                {...register('correspondenceIds')}
                label="명시할 문서 대응 번호"
                description="선택 사항 · 서버에서 받은 참조를 쉼표로 구분 · 최대 8개"
                error={errors.correspondenceIds?.message}
              />
            )}
            {mode === 'history' && (
              <TextField
                {...register('jobIds')}
                label="본인 작업 번호"
                description="선택 사항 · 쉼표로 구분 · 최대 8개"
                error={errors.jobIds?.message}
              />
            )}
            {(mode !== 'knowledge' ||
              !['ontology', 'context'].includes(operation)) && (
              <SelectField
                {...register('limit', { valueAsNumber: true })}
                label="조회 한도"
              >
                <option value={20}>20개</option>
                <option value={50}>50개</option>
                <option value={100}>100개</option>
              </SelectField>
            )}
          </>
        )}
        {mode === 'knowledge' && operation === 'conceptFind' && (
          <>
            <label className={styles.check}>
              <input type="checkbox" {...register('includeHistory')} />
              과거 판단도 찾기
            </label>
            <label className={styles.check}>
              <input type="checkbox" {...register('expansion')} />
              확인된 직접 연결까지 펼치기
            </label>
            <p className={styles.caption}>
              문서를 고르지 않은 개념 찾기는 제한된 발견 범위입니다. 원문 문자열
              검색은 체크한 문서와 관계없이 현재 허용 저장소를 대상으로 합니다.
            </p>
          </>
        )}
        {mode === 'knowledge' && operation === 'search' && (
          <p className={styles.caption}>
            원문 문자열 검색은 체크한 문서로 제한하지 않고 현재 허용 저장소에서
            한도 내 검색합니다.
          </p>
        )}
      </fieldset>
    </form>
  );
}

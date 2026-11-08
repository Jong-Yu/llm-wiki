import { Button } from '@renderer/shared/ui/Button';
import { useRef, useState, useSyncExternalStore } from 'react';
import type { SubmitEvent, JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import type { FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { Icon } from '@renderer/shared/ui/Icon';
import { ConnectionNotice } from '@renderer/shared/ui/PageNotice';
import { useAiConnection } from '@renderer/platform/aiConnection';
import {
  checkTargetExistence,
  findFreeTarget,
} from '../api/importRegistration.api';
import type { ImportScope } from '../api/importRegistration.api';
import type { ImportRegistrationSession } from '../model/ImportRegistrationSession';
import { importDocumentSchema } from '../model/importDocument.schema';
import type { ImportDocumentValues } from '../model/importDocument.schema';
import { importProcessingSession } from '../model/importProcessingSessions';
import {
  baseNameFromTitle,
  targetWithNumber,
  titleFromFilename,
} from '../model/importTargetName';
import styles from './ImportDocumentContent.module.scss';

type ImportDocumentFormProps = {
  session: ImportRegistrationSession;
  scope: ImportScope;
};

/** 제목·파일·본문 초안을 보존하고 등록 실패와 미확정 결과를 따로 표시합니다. */
export function ImportDocumentForm({
  session,
  scope,
}: ImportDocumentFormProps): JSX.Element {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const form = useForm<ImportDocumentValues>({
    resolver: zodResolver(importDocumentSchema),
    defaultValues: state.draft,
  });
  const kind = useWatch({ control: form.control, name: 'kind' });
  const content = useWatch({ control: form.control, name: 'content' });
  const title = useWatch({ control: form.control, name: 'title' });
  const locked = state.busy || state.requestId !== null || !scope.canRegister;
  const errors = form.formState.errors;
  const fileButton = useRef<HTMLButtonElement>(null);
  /** 같은 이름의 문서가 있을 때 사용자의 선택을 기다리는 등록 값입니다. */
  const [conflict, setConflict] = useState<{
    values: ImportDocumentValues;
    existing: string;
    numbered: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  /** 숨긴 파일 참조에 오류가 나면 실제 파일 선택 행동으로 초점을 보냅니다. */
  function focusMissingFile(errors: FieldErrors<ImportDocumentValues>): void {
    if (errors.fileId && kind === 'file') fileButton.current?.focus();
  }

  /** 입력 방식만 바꾸고 반대 탭의 본문과 선택 파일은 지우지 않습니다. */
  function selectKind(next: ImportDocumentValues['kind']): void {
    form.setValue('kind', next);
    form.clearErrors(['fileId', 'content']);
    session.updateDraft(form.getValues());
  }
  /** 네이티브 선택 결과만 입력에 반영하며 등록 이름이 바뀔 수 있어 겹침 알림은 닫습니다. */
  async function chooseFile(): Promise<void> {
    const selected = await session.chooseFile();
    if (!selected) return;
    setConflict(null);
    form.setValue('fileId', selected.fileId, { shouldValidate: true });
    session.updateDraft(form.getValues());
  }
  /** 제목과 저장 이름을 파일명(붙여넣기는 제목)에서 정하고, 같은 이름이 있으면 사용자에게 알립니다. */
  async function submit(values: ImportDocumentValues): Promise<void> {
    const documentTitle =
      values.kind === 'file' && state.file
        ? titleFromFilename(state.file.filename)
        : values.title.trim();
    const base = baseNameFromTitle(documentTitle);
    const resolved: ImportDocumentValues = {
      ...values,
      title: documentTitle,
      targetDocument: scope.canPrepare ? targetWithNumber(base, 1) : '',
    };
    if (!scope.canPrepare) {
      await register(resolved);
      return;
    }
    setChecking(true);
    const existence = await checkTargetExistence(
      scope,
      resolved.targetDocument,
    );
    if (existence === 'exists') {
      const numbered = await findFreeTarget(scope, base, targetWithNumber);
      setChecking(false);
      if (numbered) {
        setConflict({
          values: resolved,
          existing: resolved.targetDocument,
          numbered,
        });
        return;
      }
      form.setError('root', {
        message:
          '같은 이름의 문서가 있고 번호를 붙일 이름을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
      });
      return;
    }
    setChecking(false);
    await register(resolved);
  }
  /** 확정한 값으로 원본을 등록하고 이어서 변환·추출을 자동으로 시작합니다. */
  async function register(values: ImportDocumentValues): Promise<void> {
    setConflict(null);
    await session.submit(values);
    startPreparation();
  }
  /** 사용자가 요청한 등록의 완료 영수증에만 후속 변환을 연결합니다. */
  function startPreparation(): void {
    const snapshot = session.getSnapshot();
    if (snapshot.completed && scope.canPrepare)
      void importProcessingSession(
        scope,
        snapshot.completed,
        snapshot.draft,
      ).begin();
  }
  /** 같은 요청의 완료를 확인한 뒤에만 보존된 원래 옵션으로 준비합니다. */
  async function checkRegistration(): Promise<void> {
    await session.check();
    startPreparation();
  }
  // 등록 뒤 관계 추출이 자동 실행되므로 미리 알립니다. 문서 저장은 AI 없이 가능해 등록은 막지 않습니다.
  const aiRequired = useAiConnection().status === 'required';
  return (
    <form
      className={styles.form}
      onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
        void form.handleSubmit(submit, focusMissingFile)(event);
      }}
      onChange={(): void => {
        setConflict(null);
        session.updateDraft(form.getValues());
      }}
      noValidate
    >
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
      {!scope.canRegister && (
        <div className={styles.notice} role="status">
          이 작업 공간에는 원본 등록 권한이 없습니다. 입력을 제출할 수 없습니다.
        </div>
      )}
      {state.notice && (
        <p className={styles.notice} role="status">
          {state.notice}
        </p>
      )}
      {state.error && (
        <section
          className={`${styles.notice} ${styles.errorNotice}`}
          role="alert"
        >
          <h2>
            {state.requestId
              ? '등록 결과 확인이 필요합니다'
              : state.errorStage === 'file'
                ? '파일을 선택하지 못했습니다'
                : '원본을 저장하지 못했습니다'}
          </h2>
          <p>{state.error}</p>
          <p>선택한 파일과 입력한 제목·본문은 그대로 유지됩니다.</p>
          {state.requestId ? (
            <Button
              variant="surface"
              type="button"
              className={styles.button}
              disabled={state.busy}
              onClick={(): void => {
                void checkRegistration();
              }}
            >
              등록 결과 확인
            </Button>
          ) : (
            <Button
              variant="surface"
              type="submit"
              className={styles.button}
              disabled={locked}
            >
              다시 시도
            </Button>
          )}
          <Link to="/settings">연결하기</Link>
        </section>
      )}
      <fieldset className={styles.fields} disabled={locked}>
        <legend className={styles.srOnly}>문서 등록 입력</legend>
        <WorkspaceSection title="원본 입력">
          <div className={styles.tabs} role="group" aria-label="등록 방식">
            <button
              type="button"
              aria-pressed={kind === 'file'}
              onClick={(): void => selectKind('file')}
            >
              파일 업로드
            </button>
            <button
              type="button"
              aria-pressed={kind === 'text'}
              onClick={(): void => selectKind('text')}
            >
              텍스트 붙여넣기
            </button>
          </div>
          {kind === 'file' ? (
            <div className={styles.dropZone}>
              <Icon name="file-text" size={20} className={styles.uploadIcon} />
              <div className={styles.fileContent}>
                <h3>{state.file?.filename ?? '가져올 파일'}</h3>
                {state.file && (
                  <p>{(state.file.sizeBytes / 1024).toFixed(1)} KB</p>
                )}
                <small>
                  문서 제목과 저장 이름은 파일명으로 정합니다 · MD, TXT, PDF,
                  XLSX, DOCX, 이미지 · 최대 20 MiB
                </small>
              </div>
              <Button
                variant="surface"
                ref={fileButton}
                className={styles.button}
                type="button"
                aria-describedby={
                  errors.fileId ? 'import-file-error' : undefined
                }
                onClick={(): void => {
                  void chooseFile();
                }}
              >
                {state.file ? '파일 다시 선택' : '파일 선택'}
              </Button>
              <input type="hidden" {...form.register('fileId')} />
              {errors.fileId && (
                <p id="import-file-error" className={styles.error} role="alert">
                  {errors.fileId.message}
                </p>
              )}
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label htmlFor="import-title">문서 제목</label>
                <input
                  id="import-title"
                  placeholder="문서를 알아보기 쉬운 제목"
                  {...form.register('title')}
                  aria-invalid={!!errors.title}
                  aria-describedby={
                    errors.title ? 'import-title-error' : undefined
                  }
                />
                {errors.title && (
                  <small
                    className={styles.error}
                    id="import-title-error"
                    role="alert"
                  >
                    {errors.title.message}
                  </small>
                )}
              </div>
              <div className={styles.field}>
                <label htmlFor="import-content">본문</label>
                <textarea
                  id="import-content"
                  placeholder="문서 내용을 붙여넣으세요."
                  {...form.register('content')}
                  aria-invalid={!!errors.content}
                  aria-describedby={`import-content-hint${errors.content ? ' import-content-error' : ''}`}
                />
                <small id="import-content-hint">
                  {content.length.toLocaleString()}자
                </small>
                {errors.content && (
                  <p
                    id="import-content-error"
                    className={styles.error}
                    role="alert"
                  >
                    {errors.content.message}
                  </p>
                )}
              </div>
            </>
          )}
        </WorkspaceSection>
      </fieldset>
      {errors.root && (
        <p className={styles.error} role="alert">
          {errors.root.message}
        </p>
      )}
      {conflict && (
        <section className={`${styles.notice} ${styles.warning}`} role="alert">
          <h2>이름이 겹칩니다</h2>
          <p>
            ‘{conflict.existing.replace(/\.md$/, '')}’ 문서가 이미 있습니다.
            기존 문서는 덮어쓰지 않습니다.
          </p>
          <div className={styles.actions}>
            <Button
              variant="surface"
              type="button"
              className={styles.button}
              onClick={(): void => setConflict(null)}
            >
              취소
            </Button>
            <Button
              variant="primary"
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={locked}
              onClick={(): void => {
                void register({
                  ...conflict.values,
                  targetDocument: conflict.numbered,
                });
              }}
            >
              번호를 붙여 등록 ({conflict.numbered.replace(/\.md$/, '')})
            </Button>
          </div>
        </section>
      )}
      {state.busy && (
        <p role="status" className={styles.pending}>
          {state.requestId
            ? '원본 보관 결과를 확인하고 있습니다…'
            : '파일을 확인하고 있습니다…'}
        </p>
      )}
      <div className={styles.actions}>
        <span className={styles.caption}>원본은 그대로 보관됩니다.</span>
        <Button
          variant="primary"
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={
            locked ||
            checking ||
            !!conflict ||
            (kind === 'file' ? !state.file : !title.trim() || !content.trim())
          }
        >
          {state.busy || checking
            ? '등록 중…'
            : scope.canPrepare
              ? '등록하고 관계 추출'
              : '원본 보관'}
        </Button>
      </div>
    </form>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import type { JSX, SubmitEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  TemplateDetail,
  TemplateFile,
  TemplateMetadata,
  TemplateSession,
} from '@contracts/templates.contract';
import { templatesGateway } from '@renderer/platform/templates';
import { HeaderActions } from '@renderer/shared/lib/headerActions';
import { notifyReadChange } from '@renderer/shared/lib/readQueries';
import { Button } from '@renderer/shared/ui/Button';
import { Icon } from '@renderer/shared/ui/Icon';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { WorkspaceSection } from '@renderer/shared/ui/WorkspaceSection';
import { templateFormSchema, templateFormValues } from '../model/templateForm';
import type { TemplateFormValues } from '../model/templateForm';
import styles from './TemplateWorkspace.module.scss';

type TemplateEditorProps = {
  session: TemplateSession;
  initial?: TemplateMetadata;
  onSaved: (detail: TemplateDetail) => void;
  onCancel: () => void;
};

/** 편집 기준을 읽은 판본에 고정하고 충돌·실패에도 파일과 지침 초안을 보존합니다. */
export function TemplateEditor({
  session,
  initial,
  onSaved,
  onCancel,
}: TemplateEditorProps): JSX.Element {
  const uid = useId();
  const [basis, setBasis] = useState(initial);
  const [file, setFile] = useState<TemplateFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<TemplateMetadata | null>(null);
  const alive = useRef(true);
  const lock = useRef(false);
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const form = useForm<TemplateFormValues>({
    resolver: zodResolver(templateFormSchema),
    defaultValues: templateFormValues(initial),
  });
  const filename = useWatch({ control: form.control, name: 'filename' });
  const name = useWatch({ control: form.control, name: 'name' });
  useEffect((): (() => void) => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);

  /** 실제 선택한 바이트는 main에 남기고 공개 파일 정보만 폼에 반영합니다. */
  async function chooseFile(): Promise<void> {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await templatesGateway.chooseFile({
        ...session,
        ...(file ? { previousFileId: file.fileId } : {}),
      });
      if (!alive.current) return;
      if (!result.ok) {
        if (result.error.code !== 'cancelled') setError(result.error.message);
        return;
      }
      setFile(result.data);
      form.setValue('filename', result.data.filename, {
        shouldDirty: true,
        shouldValidate: true,
      });
    } catch (reason: unknown) {
      if (alive.current)
        setError(
          reason instanceof Error ? reason.message : '파일을 읽지 못했습니다.',
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  /** 같은 제출의 응답 유실은 같은 요청 번호로 재확인하며 저장 성공 때만 기준을 바꿉니다. */
  async function save(values: TemplateFormValues): Promise<void> {
    if (lock.current) return;
    const payload = {
      name: values.name,
      instructions: values.instructions,
      ...(basis
        ? { templateId: basis.id, expectedRevision: basis.revision }
        : {}),
      ...(file ? { fileId: file.fileId } : {}),
    };
    const signature = JSON.stringify(payload);
    if (attempt.current?.signature !== signature)
      attempt.current = {
        signature,
        id: crypto.randomUUID().replaceAll('-', ''),
      };
    lock.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const result = await templatesGateway.save({
        ...session,
        ...payload,
        requestId: attempt.current.id,
      });
      if (!alive.current) return;
      if (!result.ok) {
        setError(result.error.message);
        setConflict(
          result.error.code === 'conflict' || result.error.status === 409,
        );
        return;
      }
      setBasis(result.data.template);
      setFile(null);
      setLatest(null);
      attempt.current = null;
      form.reset(templateFormValues(result.data.template));
      notifyReadChange();
      onSaved(result.data);
    } catch (reason: unknown) {
      if (alive.current)
        setError(
          reason instanceof Error
            ? reason.message
            : '저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 저장해 확인해 주세요.',
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  /** 최신 내용은 비교용으로만 읽고 사용자의 명시 재반영 전에는 CAS 기준을 바꾸지 않습니다. */
  async function compareLatest(): Promise<void> {
    if (!basis || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await templatesGateway.read({
        ...session,
        templateId: basis.id,
      });
      if (!alive.current) return;
      if (result.ok) setLatest(result.data.template);
      else setError(result.error.message);
    } catch {
      if (alive.current)
        setError('최신 내용을 읽지 못했습니다. 초안은 유지됩니다.');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const nameField = (
    <div className={styles.field}>
      <label htmlFor={`${uid}-name`}>템플릿 이름</label>
      <input
        id={`${uid}-name`}
        {...form.register('name')}
        maxLength={200}
        aria-invalid={!!form.formState.errors.name}
        aria-describedby={
          form.formState.errors.name ? `${uid}-name-error` : undefined
        }
      />
      {form.formState.errors.name && (
        <small className={styles.error} id={`${uid}-name-error`}>
          {form.formState.errors.name.message}
        </small>
      )}
    </div>
  );
  const fields = (
    <>
      {basis && nameField}
      <div className={styles.dropZone}>
        <Icon name="file-text" size={20} />
        <div className={styles.fileContent}>
          <h3>{filename || '가져올 양식 파일'}</h3>
          <small>
            {filename
              ? `${((file?.sizeBytes ?? basis?.sizeBytes ?? 0) / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} KB`
              : '문서, 슬라이드, 시트, PDF, 이미지 등 · 최대 20 MiB'}
          </small>
        </div>
        <Button
          variant="surface"
          disabled={busy}
          onClick={(): void => {
            void chooseFile();
          }}
        >
          {filename ? '파일 다시 선택' : '파일 선택'}
        </Button>
        {form.formState.errors.filename && (
          <p className={styles.error} role="alert">
            {form.formState.errors.filename.message}
          </p>
        )}
      </div>
      {!basis && nameField}
      <div className={styles.field}>
        <label htmlFor={`${uid}-instructions`}>지침</label>
        <textarea
          id={`${uid}-instructions`}
          {...form.register('instructions')}
          maxLength={12000}
          aria-invalid={!!form.formState.errors.instructions}
          aria-describedby={`${uid}-instructions-hint`}
          placeholder={
            '각 화면에 목적과 예외 상태를 포함하세요.\n근거가 없는 내용은 임의로 확정하지 말고 질문하세요.'
          }
        />
        {form.formState.errors.instructions && (
          <small className={styles.error}>
            {form.formState.errors.instructions.message}
          </small>
        )}
        <small id={`${uid}-instructions-hint`}>
          AI 채팅에서 이 템플릿을 선택하면 함께 적용됩니다.
        </small>
      </div>
    </>
  );
  return (
    <section aria-label={basis ? '템플릿 편집' : '템플릿 등록'}>
      {basis && (
        <HeaderActions>
          <Button variant="surface" disabled={busy} onClick={onCancel}>
            취소
          </Button>
          <Button
            disabled={busy}
            onClick={(): void => {
              void form.handleSubmit(save)();
            }}
          >
            {busy ? '저장 중…' : '저장'}
          </Button>
        </HeaderActions>
      )}
      {error && (
        <StatusNotice
          tone="error"
          action={
            conflict && (
              <Button
                variant="surface"
                disabled={busy}
                onClick={(): void => {
                  void compareLatest();
                }}
              >
                최신 내용 비교
              </Button>
            )
          }
        >
          {error}
        </StatusNotice>
      )}
      {latest && (
        <StatusNotice
          tone="warning"
          title="다른 변경과 현재 초안을 비교해 주세요"
        >
          <dl>
            <dt>최신 이름</dt>
            <dd>{latest.name}</dd>
            <dt>최신 파일</dt>
            <dd>{latest.filename}</dd>
            <dt>최신 지침</dt>
            <dd className={styles.preservedText}>
              {latest.instructions || '지침 없음'}
            </dd>
          </dl>
          <p>
            현재 입력은 아래에 유지됩니다. 변경한 항목은 현재 입력으로, 수정하지
            않은 항목은 최신 내용으로 반영합니다. 양쪽에서 바뀐 항목은 위 최신
            내용과 비교해 입력을 조정해 주세요.
          </p>
          <Button
            variant="surface"
            disabled={busy || latest.archived}
            onClick={(): void => {
              const draft = form.getValues();
              const merged = {
                name: draft.name === basis?.name ? latest.name : draft.name,
                instructions:
                  draft.instructions === basis?.instructions
                    ? latest.instructions
                    : draft.instructions,
                filename: file ? file.filename : latest.filename,
              };
              form.reset(templateFormValues(latest));
              form.setValue('name', merged.name, { shouldDirty: true });
              form.setValue('instructions', merged.instructions, {
                shouldDirty: true,
              });
              form.setValue('filename', merged.filename, { shouldDirty: true });
              setBasis(latest);
              setLatest(null);
              setError('');
              setConflict(false);
              attempt.current = null;
            }}
          >
            내 변경을 최신 내용에 반영
          </Button>
        </StatusNotice>
      )}
      {basis && (
        <div className={styles.editToolbar}>
          <strong>수정 중</strong>
          {form.formState.isDirty && <span>미저장 초안</span>}
        </div>
      )}
      <form
        className={styles.form}
        noValidate
        onSubmit={(event: SubmitEvent<HTMLFormElement>): void => {
          event.preventDefault();
          if (!busy) void form.handleSubmit(save)();
        }}
      >
        <fieldset disabled={busy} className={styles.fields}>
          {basis ? (
            <div className={styles.editorFields}>{fields}</div>
          ) : (
            <WorkspaceSection title="템플릿 입력">{fields}</WorkspaceSection>
          )}
        </fieldset>
        {!basis && (
          <div className={styles.actions}>
            <span className={styles.caption}>
              양식 파일과 지침을 함께 저장합니다.
            </span>
            <Button type="submit" disabled={busy || !filename || !name.trim()}>
              {busy ? '등록 중…' : '템플릿 등록'}
            </Button>
          </div>
        )}
        {basis && (
          <p className={styles.footer}>
            저장하지 않은 초안은 앱을 닫으면 사라집니다.
          </p>
        )}
      </form>
    </section>
  );
}

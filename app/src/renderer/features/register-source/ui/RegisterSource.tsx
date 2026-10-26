import { useState } from 'react';
import type { JSX } from 'react';
import type {
  SourceExpectedScope,
  SourceRegistrationRequest,
} from '@contracts/sources.contract';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@renderer/shared/ui/Button';
import { Dialog } from '@renderer/shared/ui/Dialog';
import { TextField } from '@renderer/shared/ui/TextField';
import { TextareaField } from '@renderer/shared/ui/TextareaField';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { Tabs } from '@renderer/shared/ui/Tabs';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { useSourceRegistration } from '../model/useSourceRegistration';
import type { CompletedRegistration } from '../model/useSourceRegistration';
import {
  initialSourceRegistrationValues,
  sourceRegistrationFormSchema,
} from '../model/sourceRegistrationForm.schema';
import type { SourceRegistrationValues } from '../model/sourceRegistrationForm.schema';
import styles from './RegisterSource.module.scss';

export type RegisterSourceProps = {
  connectionId: string | null;
  tenant: string | null;
  allowed: boolean;
  onRegistered: (record: CompletedRegistration) => void;
  onScopeInvalidated: () => void;
  expectedScope?: SourceExpectedScope;
  versionTarget?: NonNullable<SourceRegistrationRequest['target']>;
  initialTitle?: string;
  openOnMount?: boolean;
  onClose?: () => void;
  controlledOpen?: boolean;
};

/** 원본 등록 입력과 검증을 RHF로 관리하며 실제 완료 후 같은 목록에서 미리보기를 엽니다. */
export function RegisterSource({
  connectionId,
  tenant,
  allowed,
  onRegistered,
  onScopeInvalidated,
  expectedScope,
  versionTarget,
  initialTitle = '',
  openOnMount = false,
  onClose,
  controlledOpen,
}: RegisterSourceProps): JSX.Element {
  const [open, setOpen] = useState(openOnMount);
  const {
    register,
    control,
    getValues,
    setValue,
    reset,
    handleSubmit,
    formState: { errors },
  } = useForm<SourceRegistrationValues, unknown>({
    resolver: zodResolver(sourceRegistrationFormSchema),
    defaultValues: {
      ...initialSourceRegistrationValues(),
      title: initialTitle,
    },
  });
  const kind = useWatch({ control, name: 'kind' });
  const model = useSourceRegistration({
    connectionId: connectionId || '',
    onRegistered: complete,
    onScopeInvalidated,
    expectedScope,
  });
  const busy = model.state.status === 'busy';
  const unconfirmed = model.state.status === 'unconfirmed';
  const locked = busy || unconfirmed;

  /** 완료 뒤에만 입력을 비우며 목록 갱신 실패가 등록 재전송을 일으키지 않게 합니다. */
  function complete(record: CompletedRegistration): void {
    setOpen(false);
    reset(initialSourceRegistrationValues());
    onRegistered(record);
    onClose?.();
  }
  /** 진행 중 닫기는 전송 취소로 오해하지 않도록 막고, 미확정 상태는 닫아도 보존합니다. */
  function changeOpen(value: boolean): void {
    if (!busy) {
      setOpen(value);
      if (!value) onClose?.();
    }
  }
  /** 파일은 main의 선택 창으로 받고 폼에는 불투명 참조만 보관합니다. */
  async function chooseFile(): Promise<void> {
    const chosen = await model.chooseFile();
    if (!chosen) return;
    setValue('fileId', chosen.fileId, { shouldValidate: true });
    if (!getValues('title').trim())
      setValue(
        'title',
        chosen.filename.replace(
          /\.(md|txt|pdf|xlsx|docx|png|jpe?g|gif|webp|bmp|tiff?)$/i,
          '',
        ),
        {
          shouldValidate: true,
        },
      );
  }
  /** 매 등록 의도에 한 요청 ID를 발급하고 미확정 동안 입력을 고정합니다. */
  function submit(values: SourceRegistrationValues): void {
    if (!connectionId) return;
    const base = {
      connectionId,
      requestId: crypto.randomUUID().replaceAll('-', ''),
      title: values.title,
      ...(versionTarget ? { target: versionTarget } : {}),
    };
    void model.submit(
      values.kind === 'file'
        ? { ...base, kind: 'file', fileId: values.fileId }
        : {
            ...base,
            kind: 'text',
            format: values.format,
            content: values.content,
          },
    );
  }
  return (
    <>
      {!openOnMount && (
        <Button
          onClick={(): void => setOpen(true)}
          disabled={!connectionId || !allowed}
          title={
            !allowed ? '이 작업 공간에 원본 등록 권한이 없습니다.' : undefined
          }
        >
          원본 등록
        </Button>
      )}
      <Dialog
        open={controlledOpen ?? open}
        onOpenChange={changeOpen}
        title={versionTarget ? '새 원본 올리기' : '원본 등록'}
        description={`${tenant || '현재 작업 공간'}에 원본을 보관합니다. 텍스트는 미리보고, PDF·XLSX는 고정 원본 정보와 변환 준비 상태를 확인할 수 있습니다.`}
        className={styles.dialog}
      >
        <form
          onSubmit={handleSubmit(submit)}
          onChange={model.clearError}
          noValidate
          className={styles.form}
          aria-busy={busy}
        >
          <fieldset disabled={locked} className={styles.fields}>
            <TextField
              {...register('title')}
              label="원본 제목"
              required
              error={errors.title?.message}
              maxLength={200}
            />
            <Tabs
              label="등록 방식"
              value={kind}
              onValueChange={(value: string): void => {
                if (value === 'file' || value === 'text')
                  setValue('kind', value);
              }}
              items={[
                {
                  id: 'file',
                  label: '파일 업로드',
                  content: (
                    <div className={styles.file}>
                      <p>
                        MD · TXT · PDF · XLSX · DOCX · PNG · JPEG · GIF · WebP ·
                        BMP · TIFF · 최대 20 MiB. Markdown과 텍스트는 UTF-8
                        파일을 사용합니다.
                      </p>
                      <Button
                        variant="secondary"
                        onClick={(): void => {
                          void chooseFile();
                        }}
                      >
                        파일 선택
                      </Button>
                      {model.file && (
                        <p>
                          {model.file.filename} ·{' '}
                          {model.file.format.toUpperCase()} ·{' '}
                          {new Intl.NumberFormat('ko-KR').format(
                            model.file.sizeBytes,
                          )}{' '}
                          B
                          {model.file.format !== 'md' &&
                            model.file.format !== 'txt' &&
                            ' · 원본 보관 가능, 문자·표 변환은 별도 준비가 필요합니다.'}
                        </p>
                      )}
                      {errors.fileId?.message && (
                        <p role="alert">{errors.fileId.message}</p>
                      )}
                    </div>
                  ),
                },
                {
                  id: 'text',
                  label: '직접 입력',
                  content: (
                    <div className={styles.fields}>
                      <SelectField {...register('format')} label="원본 형식">
                        <option value="md">Markdown (.md)</option>
                        <option value="txt">텍스트 (.txt)</option>
                      </SelectField>
                      <TextareaField
                        {...register('content')}
                        label="원본 내용"
                        rows={12}
                        error={errors.content?.message}
                        description="공백과 줄바꿈을 포함한 전체 내용을 보관합니다. 빈 원본도 등록할 수 있습니다."
                      />
                    </div>
                  ),
                },
              ]}
            />
          </fieldset>
          {model.state.status === 'busy' && (
            <StatusNotice
              title={
                model.state.requestId
                  ? '등록 상태를 확인하고 있습니다'
                  : '파일을 확인하고 있습니다'
              }
            >
              처리가 끝날 때까지 기다려 주세요.
            </StatusNotice>
          )}
          {model.state.status === 'error' && (
            <StatusNotice tone="error" title="원본 등록을 완료하지 못했습니다">
              <p>{model.state.error.message}</p>
              {model.state.error.traceId && (
                <p>문의 코드: {model.state.error.traceId}</p>
              )}
            </StatusNotice>
          )}
          {model.state.status === 'unconfirmed' && (
            <StatusNotice tone="warning" title="등록 결과 확인이 필요합니다">
              <p>{model.state.message}</p>
              <p>요청 번호: {model.state.requestId}</p>
              <Button
                variant="secondary"
                onClick={(): void => {
                  void model.check();
                }}
              >
                등록 상태 확인
              </Button>
            </StatusNotice>
          )}
          <p className={styles.note}>
            원본을 등록해도 분석은 시작되지 않습니다.
          </p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={(): void => changeOpen(false)}
            >
              닫기
            </Button>
            <Button type="submit" disabled={locked}>
              등록하고 미리보기
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

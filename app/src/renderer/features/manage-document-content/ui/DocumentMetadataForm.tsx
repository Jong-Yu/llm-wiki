import { useState } from 'react';
import type { JSX } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { ControllerRenderProps } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { DocumentContent } from '@contracts/documents.contract';
import { Field } from '@renderer/shared/ui/Field';
import type { FieldControlProps } from '@renderer/shared/ui/Field';
import { Icon } from '@renderer/shared/ui/Icon';
import { TextField } from '@renderer/shared/ui/TextField';
import {
  editableMetadataSchema,
  draftMetadataFields,
} from '../model/documentMetadata';
import type { EditableMetadata } from '../model/documentMetadata';
import { DocumentTagInput, parseTags } from './DocumentTagInput';
import chips from './DocumentChips.module.scss';
import styles from './ManageDocumentContent.module.scss';

type DocumentMetadataFormProps = {
  base: DocumentContent;
  content: string;
  disabled: boolean;
  values?: EditableMetadata;
  onChange: (fields: EditableMetadata) => void;
  /** 편집 화면은 접힌 한 줄로 시작하고, 충돌 재반영 화면은 펼쳐 둡니다. */
  collapsible?: boolean;
};

/** 제목·태그·설명만 편집하며 ID와 원본 버전은 읽기 전용으로 유지합니다. */
export function DocumentMetadataForm({
  base,
  content,
  disabled,
  onChange,
  values,
  collapsible = false,
}: DocumentMetadataFormProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const {
    register,
    getValues,
    control,
    formState: { errors },
  } = useForm<EditableMetadata>({
    resolver: zodResolver(editableMetadataSchema),
    defaultValues: values ?? draftMetadataFields(base, content),
    mode: 'onChange',
  });
  if (!base.documentId)
    return (
      <p className={styles.hint}>
        이 문서는 제목·태그·설명 편집을 지원하지 않습니다.
      </p>
    );
  const hasErrors = !!(errors.title || errors.tags || errors.description);
  // 접힌 상태에서도 검증 오류는 숨기지 않습니다.
  const expanded = !collapsible || open || hasErrors;
  return (
    <div onChange={(): void => onChange(getValues())}>
      {collapsible && (
        <button
          type="button"
          className={chips.chip}
          data-active={expanded}
          aria-expanded={expanded}
          onClick={(): void => setOpen(!open)}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
          문서 정보 (제목 · 태그 · 설명)
        </button>
      )}
      <fieldset
        hidden={!expanded}
        disabled={disabled}
        className={styles.metadataFields}
      >
        {!collapsible && <legend>문서 정보</legend>}
        <TextField
          label="제목"
          {...register('title')}
          error={errors.title?.message}
        />
        <Controller
          control={control}
          name="tags"
          render={({
            field,
          }: {
            field: ControllerRenderProps<EditableMetadata, 'tags'>;
          }): JSX.Element => (
            <Field label="태그" error={errors.tags?.message}>
              {(controlProps: FieldControlProps): JSX.Element => (
                <DocumentTagInput
                  id={controlProps.id}
                  value={parseTags(field.value)}
                  disabled={disabled}
                  invalid={controlProps['aria-invalid'] === true}
                  describedBy={controlProps['aria-describedby']}
                  onChange={(tags: string[]): void => {
                    const next = tags.join(', ');
                    field.onChange(next);
                    onChange({ ...getValues(), tags: next });
                  }}
                />
              )}
            </Field>
          )}
        />
        <TextField
          label="설명"
          {...register('description')}
          error={errors.description?.message}
        />
      </fieldset>
    </div>
  );
}

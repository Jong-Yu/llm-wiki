import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@renderer/shared/ui/Button';
import { TextField } from '@renderer/shared/ui/TextField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  permissionKeys,
  permissionLabels,
  permissionGroups,
  permissionDiff,
} from './model';
import type { Permission, Workspace } from './model';
import styles from './Proposal.module.scss';
const nameSchema = z.object({
  name: z.string().trim().normalize().min(1, '이름을 입력해 주세요.').max(80),
});
const creationSchema = nameSchema.extend({
  id: z
    .string()
    .regex(
      /^[a-z][a-z0-9_-]{0,63}$/,
      '영문 소문자로 시작하는 주소 이름을 입력해 주세요.',
    ),
});
export type Creation = z.infer<typeof creationSchema>;
type WorkspaceFormProps = {
  workspace?: Workspace;
  conflict: boolean;
  onSave: (name: string) => void;
  initialName?: string;
  onDraftChange?: (name: string) => void;
};
/** 일반 설정 편집은 목록과 분리된 한 폼에서 충돌과 초안을 다룹니다. */
export function WorkspaceForm({
  workspace,
  conflict,
  onSave,
  initialName,
  onDraftChange,
}: WorkspaceFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<z.infer<typeof nameSchema>>({
    resolver: zodResolver(nameSchema),
    defaultValues: { name: initialName ?? workspace?.name ?? '' },
  });
  const currentName = useWatch({ control, name: 'name' });
  useEffect(
    (): void => onDraftChange?.(currentName),
    [currentName, onDraftChange],
  );
  const [compare, setCompare] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  function submit(values: z.infer<typeof nameSchema>): void {
    if (conflict && !reviewed) {
      setCompare(values.name);
      return;
    }
    onSave(values.name);
  }
  return (
    <form className={styles.form} onSubmit={handleSubmit(submit)} noValidate>
      <TextField
        label="워크스페이스 이름"
        {...register('name')}
        error={errors.name?.message}
      />
      {compare !== null && (
        <StatusNotice tone="warning" title="다른 관리자가 이름을 변경했습니다">
          <div className={styles.compare}>
            <div>
              <span>내 초안</span>
              <strong>{compare}</strong>
            </div>
            <div>
              <span>최신 이름</span>
              <strong>{workspace?.name} 팀</strong>
            </div>
          </div>
          <Button
            variant="surface"
            onClick={(): void => {
              setReviewed(true);
              setCompare(null);
            }}
          >
            비교 후 다시 편집
          </Button>
        </StatusNotice>
      )}
      <Button type="submit" disabled={compare !== null}>
        변경 저장
      </Button>
    </form>
  );
}
type CreateFormProps = {
  existing: Workspace[];
  onCreate: (value: Creation) => void;
  initialDraft?: Creation;
  onDraftChange?: (value: Creation) => void;
};
/** 생성한 뒤 사용자 배정 페이지로 이동하므로 생성 폼에 사람 목록을 섞지 않습니다. */
export function CreateForm({
  existing,
  onCreate,
  initialDraft,
  onDraftChange,
}: CreateFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<Creation>({
    resolver: zodResolver(creationSchema),
    defaultValues: initialDraft ?? { name: '', id: '' },
  });
  const [draftName, draftId] = useWatch({ control, name: ['name', 'id'] });
  useEffect((): void => {
    onDraftChange?.({ name: draftName, id: draftId });
  }, [draftName, draftId, onDraftChange]);
  function submit(value: Creation): void {
    if (existing.some((w): boolean => w.id === value.id)) {
      setError('id', { message: '이미 사용 중인 주소 이름입니다.' });
      return;
    }
    onCreate(value);
  }
  return (
    <form className={styles.form} onSubmit={handleSubmit(submit)} noValidate>
      <TextField
        label="워크스페이스 이름"
        {...register('name')}
        placeholder="예: 제품 설계"
        error={errors.name?.message}
      />
      <TextField
        label="주소 이름"
        {...register('id')}
        placeholder="예: product-design"
        description="생성 후에는 바꿀 수 없습니다."
        error={errors.id?.message}
      />
      <p className={styles.note}>만든 뒤 함께 사용할 사용자를 배정합니다.</p>
      <Button type="submit">워크스페이스 생성</Button>
    </form>
  );
}
const permissionSchema = z.object({
  permissions: z
    .array(z.enum(permissionKeys))
    .refine(
      (values): boolean => values.length === 0 || values.includes('read'),
      '다른 행동을 허용하려면 자료 읽기도 필요합니다.',
    ),
});
type PermissionFormProps = {
  permissions: Permission[];
  onSave: (permissions: Permission[]) => void;
  submitLabel?: string;
  compare?: boolean;
  onDraftChange?: (permissions: Permission[]) => void;
  initialDraft?: Permission[];
};
/** 권한을 자료·검토·개인 작업으로 나누며 업무 역할을 관리 역할로 승격하지 않습니다. */
export function PermissionForm({
  permissions,
  onSave,
  submitLabel = '권한 저장',
  compare = true,
  onDraftChange,
  initialDraft,
}: PermissionFormProps): JSX.Element {
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<z.infer<typeof permissionSchema>>({
    resolver: zodResolver(permissionSchema),
    defaultValues: { permissions: initialDraft ?? permissions },
  });
  const current = useWatch({ control, name: 'permissions' });
  useEffect((): void => {
    onDraftChange?.(current);
  }, [current, onDraftChange]);
  const diff = permissionDiff(compare ? permissions : [], current);
  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit((value): void => onSave(value.permissions))}
    >
      {permissionGroups.map((group): JSX.Element => (
        <fieldset className={styles.permissionGroup} key={group.name}>
          <legend>{group.name}</legend>
          {group.values.map((permission: Permission): JSX.Element => (
            <label key={permission}>
              <input
                type="checkbox"
                value={permission}
                {...register('permissions')}
              />
              <span>{permissionLabels[permission]}</span>
            </label>
          ))}
        </fieldset>
      ))}
      {errors.permissions && <p role="alert">{errors.permissions.message}</p>}
      <div
        className={styles.permissionChanges}
        aria-label="권한 변경 내용"
        aria-live="polite"
      >
        {diff.added.length > 0 && (
          <p>
            <strong>추가</strong>{' '}
            {diff.added
              .map((p: Permission): string => permissionLabels[p])
              .join(' · ')}
          </p>
        )}
        {diff.removed.length > 0 && (
          <p>
            <strong>회수</strong>{' '}
            {diff.removed
              .map((p: Permission): string => permissionLabels[p])
              .join(' · ')}
          </p>
        )}
        {diff.added.length === 0 && diff.removed.length === 0 && (
          <p>변경 사항 없음</p>
        )}
      </div>
      <div className={styles.formActions}>
        <Button
          type="submit"
          disabled={
            compare && diff.added.length === 0 && diff.removed.length === 0
          }
        >
          {submitLabel}
        </Button>
        <span className={styles.note}>관리 콘솔 권한은 포함되지 않습니다.</span>
      </div>
    </form>
  );
}

import type { ChangeEvent, JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  ConnectionSnapshot,
  SelectWorkspaceRequest,
  WorkspaceMembership,
  WorkspaceProfile,
} from '@contracts/connection.contract';
import { Button } from '@renderer/shared/ui/Button';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { createWorkspaceSelectionSchema } from '../model/connectionForm.schema';
import type { WorkspaceSelectionValues } from '../model/connectionForm.schema';
import styles from './ConnectWorkspace.module.scss';

type Connected = Extract<ConnectionSnapshot, { status: 'connected' }>;
type WorkspaceSelectionFormProps = {
  connection: Connected;
  busy: boolean;
  onSelect: (request: SelectWorkspaceRequest) => Promise<void>;
};

/** 서버가 확인한 기존 선택을 복원하고, 없으면 첫 조회 가능 공간의 기본 관점을 사용합니다. */
function initialSelection(connection: Connected): WorkspaceSelectionValues {
  if (connection.selection) return connection.selection;
  const workspace = connection.workspaces.find(
    (candidate: WorkspaceMembership): boolean =>
      candidate.permissions.includes('read'),
  );
  if (!workspace) return { tenant: '', profile: '' };
  return { tenant: workspace.id, profile: workspace.defaultProfile };
}

/** 관점 이름과 맥락에서 중복된 표시를 제거합니다. */
function profileLabel(profile: WorkspaceProfile): string {
  if (profile.id === 'all') return '전체 관점';
  return [
    ...new Set([profile.id, profile.domain, profile.viewpoint].filter(Boolean)),
  ].join(' · ');
}

/** RHF가 선택 초안을 소유하며 공간 변경 시 해당 공간의 기본 관점으로 전환합니다. */
export function WorkspaceSelectionForm({
  connection,
  busy,
  onSelect,
}: WorkspaceSelectionFormProps): JSX.Element {
  const { workspaces } = connection;
  const {
    register,
    control,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<WorkspaceSelectionValues, unknown>({
    resolver: zodResolver(createWorkspaceSelectionSchema(workspaces)),
    defaultValues: initialSelection(connection),
  });
  const tenant = useWatch({ control, name: 'tenant' });
  const workspace = workspaces.find(
    (candidate: WorkspaceMembership): boolean => candidate.id === tenant,
  );

  /** 공간과 무관해진 이전 관점을 남기지 않고 기본 관점을 함께 갱신합니다. */
  function changeWorkspace(event: ChangeEvent<HTMLSelectElement>): void {
    const next = workspaces.find(
      (candidate: WorkspaceMembership): boolean =>
        candidate.id === event.target.value,
    );
    if (!next) return;
    setValue('profile', next.defaultProfile, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }

  /** 폼 검증 후에도 main에서 실제 서버 소속·권한을 다시 확인합니다. */
  function submitSelection(values: WorkspaceSelectionValues): void {
    void onSelect({ connectionId: connection.connectionId, ...values });
  }

  if (workspaces.length === 0) {
    return (
      <StatusNotice title="소속된 작업 공간이 없습니다">
        서버 운영자에게 작업 공간 배정을 요청해 주세요.
      </StatusNotice>
    );
  }
  if (
    !workspaces.some((candidate: WorkspaceMembership): boolean =>
      candidate.permissions.includes('read'),
    )
  ) {
    return (
      <StatusNotice tone="warning" title="자료 조회 권한이 없습니다">
        소속은 확인됐지만 자료를 읽을 수 있는 작업 공간이 없습니다. 서버
        운영자에게 권한을 확인해 주세요.
      </StatusNotice>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={handleSubmit(submitSelection)}
      noValidate
    >
      <p className={styles.note}>
        아래 선택은 현재 연결된 서버에 적용됩니다. 새 주소나 토큰은 서버 연결
        확인을 먼저 진행해 주세요.
      </p>
      <SelectField
        {...register('tenant', { onChange: changeWorkspace })}
        label="작업 공간"
        error={errors.tenant?.message}
        disabled={busy}
        required
      >
        {workspaces.map((candidate: WorkspaceMembership): JSX.Element => (
          <option
            key={candidate.id}
            value={candidate.id}
            disabled={!candidate.permissions.includes('read')}
          >
            {candidate.id}
            {candidate.permissions.includes('read') ? '' : ' · 조회 권한 없음'}
          </option>
        ))}
      </SelectField>
      <SelectField
        {...register('profile')}
        label="관점"
        error={errors.profile?.message}
        disabled={busy}
        required
      >
        {workspace?.profiles.map((profile: WorkspaceProfile): JSX.Element => (
          <option key={profile.id} value={profile.id}>
            {profileLabel(profile)}
          </option>
        ))}
      </SelectField>
      <div>
        <h3>허용된 행동</h3>
        <ul className={styles.permissions}>
          {workspace?.permissions.map((permission: string): JSX.Element => (
            <li key={permission}>
              {permission === 'read'
                ? '자료 조회'
                : permission === 'source_write'
                  ? '원본 등록'
                  : permission}
            </li>
          ))}
        </ul>
      </div>
      <Button type="submit" disabled={busy}>
        작업 공간 선택
      </Button>
    </form>
  );
}

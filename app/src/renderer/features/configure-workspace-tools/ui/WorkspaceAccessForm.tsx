import { Button } from '@renderer/shared/ui/Button';
import type { JSX } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type {
  SelectWorkspaceRequest,
  WorkspaceMembership,
} from '@contracts/connection.contract';
import { SelectField } from '@renderer/shared/ui/SelectField';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import {
  createToolsScopeSchema,
  initialToolsScope,
} from '../model/workspaceTools.schema';
import type {
  ConnectedTools,
  ToolsScopeValues,
} from '../model/workspaceTools.schema';
import styles from './WorkspaceTools.module.scss';

type WorkspaceAccessFormProps = {
  connection: ConnectedTools;
  busy: boolean;
  onSelect: (request: SelectWorkspaceRequest) => Promise<void>;
};

/** 허용된 작업 공간만 선택하고 서버 기본 범위는 내부 요청에 사용합니다. */
export function WorkspaceAccessForm({
  connection,
  busy,
  onSelect,
}: WorkspaceAccessFormProps): JSX.Element {
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<ToolsScopeValues>({
    resolver: zodResolver(createToolsScopeSchema(connection.workspaces)),
    defaultValues: initialToolsScope(connection),
  });
  const tenant = useWatch({ control, name: 'tenant' });
  const selectionApplied = connection.selection?.tenant === tenant;
  const readable = connection.workspaces.filter(
    (workspace: WorkspaceMembership): boolean =>
      workspace.permissions.includes('read'),
  );

  /** 기본 범위의 중립성과 허용 여부는 main에서 현재 연결 기준으로 재검증합니다. */
  function submit(values: ToolsScopeValues): void {
    const workspace = readable.find(
      (item: WorkspaceMembership): boolean => item.id === values.tenant,
    );
    if (!workspace) {
      setError('tenant', { message: '허용된 작업 공간을 선택해 주세요.' });
      return;
    }
    void onSelect({
      connectionId: connection.connectionId,
      tenant: workspace.id,
      profile: workspace.defaultProfile,
    });
  }

  if (readable.length === 0)
    return (
      <StatusNotice tone="warning" title="조회 가능한 작업 공간이 없습니다">
        서버 운영자에게 소속과 자료 조회 권한을 확인해 주세요.
      </StatusNotice>
    );
  return (
    <form
      className={styles.scopeForm}
      onSubmit={handleSubmit(submit)}
      noValidate
    >
      <div className={styles.scopeFields}>
        <SelectField
          {...register('tenant')}
          label="작업 공간"
          disabled={busy}
          error={errors.tenant?.message}
        >
          {readable.map((workspace: WorkspaceMembership): JSX.Element => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.displayName ?? '작업 공간'}
            </option>
          ))}
        </SelectField>
      </div>
      <div className={styles.actionRow}>
        <Button
          variant="surface"
          className={styles.button}
          type="submit"
          disabled={busy}
        >
          선택 적용
        </Button>
      </div>
      {!selectionApplied && (
        <p className={styles.note}>아직 적용하지 않은 선택입니다.</p>
      )}
    </form>
  );
}

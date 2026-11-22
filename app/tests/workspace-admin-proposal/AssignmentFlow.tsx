import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { JSX, Ref } from 'react';
import { Icon } from '@renderer/shared/ui/Icon';
import { Button } from '@renderer/shared/ui/Button';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import { Chip, EntityBrowser } from './controls';
import { PermissionForm } from './Forms';
import { emptySearch, personEntity, workspaceEntity } from './model';
import type {
  Data,
  Member,
  Permission,
  Person,
  SearchState,
  Workspace,
} from './model';
import styles from './Proposal.module.scss';
export type AssignmentTarget = { workspaceId: string; userId: string };
export type AssignmentAttempt = AssignmentTarget & {
  operation: 'put';
  operationId: string;
};
type Outcome = AssignmentTarget & {
  operationId?: string;
  status: 'success' | 'failed' | 'unknown' | 'unattempted';
  retryable: boolean;
  message?: string;
};
export type AssignmentDraft = {
  selected: string[];
  search: SearchState;
  step: 'pick' | 'permissions' | 'results';
  permissions: Permission[];
  outcomes: Outcome[];
};
export type AssignmentNavigation = { back: () => boolean };
type AssignmentFlowProps = {
  navigationRef: Ref<AssignmentNavigation>;
  initialDraft?: AssignmentDraft;
  onDraft: (draft: AssignmentDraft) => void;
  onReceipt: (operationId: string) => boolean;
  data: Data;
  user?: Person;
  workspace?: Workspace;
  partial: boolean;
  onAttempt: (target: AssignmentAttempt) => void;
  onPut: (
    target: AssignmentTarget,
    permissions: Permission[],
    operationId: string,
  ) => boolean;
  onDone: (count: number, workspaceId?: string) => void;
};
/** 사용자 또는 공간을 고정한 채 선택→권한→개별 배정 결과로 이어갑니다. */
export function AssignmentFlow({
  data,
  user,
  workspace,
  partial,
  onAttempt,
  onPut,
  onDone,
  initialDraft,
  onDraft,
  onReceipt,
  navigationRef,
}: AssignmentFlowProps): JSX.Element {
  const [selected, setSelected] = useState<string[]>(
    initialDraft?.selected ?? [],
  );
  const [search, setSearch] = useState<SearchState>(
    initialDraft?.search ?? emptySearch,
  );
  const [step, setStep] = useState<'pick' | 'permissions' | 'results'>(
    initialDraft?.step ?? 'pick',
  );
  const [permissions, setPermissions] = useState<Permission[]>(
    initialDraft?.permissions ?? ['read'],
  );
  const [outcomes, setOutcomes] = useState<Outcome[]>(
    initialDraft?.outcomes ?? [],
  );
  const [busy, setBusy] = useState(false);
  // 과업 내부의 선택·권한 단계는 상위 페이지 복귀보다 먼저 처리합니다.
  useImperativeHandle(
    navigationRef,
    (): AssignmentNavigation => ({
      back: (): boolean => {
        if (busy) return true;
        if (step !== 'permissions') return false;
        setStep('pick');
        return true;
      },
    }),
    [busy, step],
  );
  const live = useRef(true);
  useEffect((): (() => void) => {
    live.current = true;
    return (): void => {
      live.current = false;
    };
  }, []);
  useEffect(
    (): void => onDraft({ selected, search, step, permissions, outcomes }),
    [selected, search, step, permissions, outcomes, onDraft],
  );
  const available = user
    ? data.workspaces
        .filter(
          (w: Workspace): boolean =>
            !w.members.some((m: Member): boolean => m.userId === user.id),
        )
        .map((w: Workspace) => workspaceEntity(w, data))
    : data.people
        .filter(
          (p: Person): boolean =>
            !workspace?.members.some((m: Member): boolean => m.userId === p.id),
        )
        .map((p: Person) => personEntity(p, data));
  const targets: AssignmentTarget[] = selected.map(
    (id: string): AssignmentTarget => ({
      workspaceId: workspace?.id ?? id,
      userId: user?.id ?? id,
    }),
  );
  function name(target: AssignmentTarget): string {
    const entity = user
      ? data.workspaces.find(
          (w: Workspace): boolean => w.id === target.workspaceId,
        )
      : data.people.find((p: Person): boolean => p.id === target.userId);
    if (!entity) return user ? target.workspaceId : target.userId;
    const duplicate = user
      ? data.workspaces.some(
          (w: Workspace): boolean =>
            w.id !== entity.id && w.name === entity.name,
        )
      : data.people.some(
          (p: Person): boolean => p.id !== entity.id && p.name === entity.name,
        );
    return duplicate ? `${entity.name} · ${entity.id}` : entity.name;
  }

  async function run(
    rows: Outcome[],
    nextPermissions: Permission[],
    simulate: boolean,
  ): Promise<void> {
    setBusy(true);
    setStep('results');
    setPermissions(nextPermissions);
    setOutcomes(rows);
    const result = rows.map((row: Outcome): Outcome => ({ ...row }));
    let attempt = 0;
    for (let index = 0; index < result.length; index++) {
      const row = result[index];
      if (
        row.status === 'success' ||
        row.status === 'unknown' ||
        !row.retryable
      )
        continue;
      await new Promise<void>((resolve: () => void): number =>
        window.setTimeout(resolve, 80),
      );
      if (!live.current) return;
      const operationId = crypto.randomUUID();
      row.operationId = operationId;
      onAttempt({ ...row, operationId, operation: 'put' });
      if (simulate && attempt === 1) {
        result[index] = {
          ...row,
          status: 'failed',
          message: '일시 오류. 다시 시도할 수 있습니다.',
        };
      } else {
        const added = onPut(row, nextPermissions, operationId);
        if (!added)
          result[index] = {
            ...row,
            status: 'failed',
            retryable: false,
            message: '이미 소속된 사용자입니다. 기존 권한을 유지했습니다.',
          };
        else if (simulate && attempt === 2) {
          result[index] = {
            ...row,
            status: 'unknown',
            message: '응답을 받지 못했습니다. 먼저 결과를 확인하세요.',
          };
          setOutcomes([...result]);
          break;
        } else
          result[index] = {
            ...row,
            status: 'success',
            retryable: false,
            message: undefined,
          };
      }
      attempt++;
      setOutcomes([...result]);
    }
    setBusy(false);
  }
  function confirmUnknown(): void {
    setOutcomes((old: Outcome[]): Outcome[] =>
      old.map((row: Outcome): Outcome => {
        if (row.status !== 'unknown') return row;
        if (row.operationId && onReceipt(row.operationId))
          return {
            ...row,
            status: 'success',
            retryable: false,
            message: '배정 결과를 확인했습니다.',
          };
        return {
          ...row,
          message: '배정 결과를 아직 확인하지 못했습니다. 다시 확인하세요.',
        };
      }),
    );
  }
  const success = outcomes.filter(
    (row: Outcome): boolean => row.status === 'success',
  ).length;
  const unknown = outcomes.some(
    (row: Outcome): boolean => row.status === 'unknown',
  );
  const retryable = outcomes.some(
    (row: Outcome): boolean =>
      row.retryable &&
      (row.status === 'failed' || row.status === 'unattempted'),
  );
  return (
    <section
      className={step === 'permissions' ? styles.assignmentForm : undefined}
      aria-label={user ? '사용자 워크스페이스 배정' : '워크스페이스 멤버 배정'}
    >
      <div className={styles.taskContext}>
        <span>{user ? '배정할 사용자' : '대상 워크스페이스'}</span>
        <strong>{user?.name ?? workspace?.name}</strong>
        {user &&
          data.people.some(
            (p: Person): boolean => p.id !== user.id && p.name === user.name,
          ) && <small>{user.id}</small>}
      </div>
      {step === 'pick' ? (
        <>
          <EntityBrowser
            label={user ? '배정할 워크스페이스' : '추가할 사용자'}
            items={available}
            state={search}
            onState={setSearch}
            emptyLabel={
              user
                ? '새로 배정할 워크스페이스가 없습니다'
                : '추가할 사용자가 없습니다'
            }
            {...(user
              ? {
                  onOpen: (id: string): void => {
                    setSelected([id]);
                    setStep('permissions');
                  },
                }
              : { selected, onSelect: setSelected })}
          />
          {!user && (
            <div className={styles.formActions}>
              <Button
                disabled={selected.length === 0}
                onClick={(): void => setStep('permissions')}
              >
                권한 설정{selected.length > 0 ? ` · ${selected.length}명` : ''}
              </Button>
            </div>
          )}
        </>
      ) : step === 'permissions' ? (
        <>
          <div className={styles.selectionSummary}>
            <span>{user ? '워크스페이스' : '선택한 사용자'}</span>
            <div className={styles.chips}>
              {targets.map((target: AssignmentTarget): JSX.Element => (
                <Chip key={`${target.workspaceId}-${target.userId}`}>
                  {name(target)}
                </Chip>
              ))}
            </div>
          </div>
          <PermissionForm
            permissions={permissions}
            onDraftChange={setPermissions}
            compare={false}
            submitLabel={user ? '배정' : '선택한 사용자 배정'}
            onSave={(next: Permission[]): void => {
              void run(
                targets.map((target: AssignmentTarget): Outcome => ({
                  ...target,
                  status: 'unattempted',
                  retryable: true,
                })),
                next,
                partial,
              );
            }}
          />
        </>
      ) : (
        <>
          <div className={styles.resultHeading}>
            <h2>배정 결과</h2>
            <span role="status">
              {busy ? '배정 중…' : `${success} / ${outcomes.length} 완료`}
            </span>
          </div>
          <ul className={styles.assignmentResults} aria-label="개별 배정 결과">
            {outcomes.map((row: Outcome): JSX.Element => (
              <li key={`${row.workspaceId}-${row.userId}`}>
                <strong>{name(row)}</strong>
                <span data-status={row.status}>
                  <Icon
                    name={
                      row.status === 'success'
                        ? 'circle-check'
                        : row.status === 'failed'
                          ? 'circle-alert'
                          : row.status === 'unknown'
                            ? 'circle-help'
                            : 'clock'
                    }
                    size={16}
                  />
                  {row.status === 'success'
                    ? '배정 완료'
                    : row.status === 'failed'
                      ? '실패'
                      : row.status === 'unknown'
                        ? '결과 확인 필요'
                        : '미실행'}
                </span>
                {row.message && row.status !== 'success' && (
                  <p>{row.message}</p>
                )}
              </li>
            ))}
          </ul>
          {unknown && (
            <StatusNotice tone="warning" title="결과 확인이 먼저 필요합니다">
              응답이 없는 배정은 다시 보내지 않습니다.
            </StatusNotice>
          )}
          <div className={styles.formActions}>
            {unknown && (
              <Button disabled={busy} onClick={confirmUnknown}>
                결과 확인
              </Button>
            )}
            {retryable && (
              <Button
                disabled={busy || unknown}
                onClick={(): void => {
                  void run(outcomes, permissions, false);
                }}
              >
                미완료 다시 시도
              </Button>
            )}
            {success === outcomes.length && (
              <Button
                disabled={busy}
                onClick={(): void => onDone(success, outcomes[0]?.workspaceId)}
              >
                완료
              </Button>
            )}
            {success < outcomes.length && !busy && (
              <span className={styles.note}>
                미완료 결과는 이 작업에 보존됩니다.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

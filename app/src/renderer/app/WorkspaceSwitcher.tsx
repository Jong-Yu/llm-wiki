import { useEffect, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import type {
  ConnectionResult,
  WorkspaceMembership,
} from '@contracts/connection.contract';
import { connectionGateway } from '@renderer/platform/connection';
import { Icon } from '@renderer/shared/ui/Icon';
import styles from './WorkspaceSwitcher.module.scss';

type WorkspaceSwitcherProps = {
  connectionId: string;
  workspaces: readonly WorkspaceMembership[];
  currentId: string | null;
  onNavigate: () => void;
  /** 전환 시작·종료를 알려 본문에 진행 표시를 보이게 합니다. */
  onSwitchingChange: (switching: boolean) => void;
};

/** 보존된 화면에 내용이 있는 입력란이 있으면 작성 중인 초안으로 봅니다. */
function hasDraft(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLTextAreaElement>(
      '[data-workspace-route] textarea',
    ),
  ).some((field: HTMLTextAreaElement): boolean => field.value.trim() !== '');
}

/** 조회 가능한 작업 공간이 둘 이상일 때만 그 자리에서 목록을 열어 전환합니다. */
export function WorkspaceSwitcher({
  connectionId,
  workspaces,
  currentId,
  onNavigate,
  onSwitchingChange,
}: WorkspaceSwitcherProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const [switching, setSwitching] = useState<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);
  const [pendingDraft, setPendingDraft] = useState<WorkspaceMembership | null>(
    null,
  );
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef<boolean>(true);
  const current = workspaces.find(
    (item: WorkspaceMembership): boolean => item.id === currentId,
  );
  const name = current?.displayName || '이름 없는 작업 공간';
  const selectable = workspaces.length > 1;

  useEffect((): (() => void) => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  // 바깥을 누르면 목록을 닫습니다.
  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return (): void => document.removeEventListener('pointerdown', close);
  }, [open]);

  /** 접근 범위 확인은 main이 하며 실패하면 현재 작업 공간을 그대로 둡니다. */
  const choose = async (workspace: WorkspaceMembership): Promise<void> => {
    setPendingDraft(null);
    if (workspace.id === currentId) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    onSwitchingChange(true);
    setFailed(false);
    setOpen(false);
    let result: ConnectionResult | null = null;
    try {
      result = await connectionGateway.selectWorkspace({
        connectionId,
        tenant: workspace.id,
        profile: workspace.defaultProfile,
      });
    } catch {
      result = null;
    }
    onSwitchingChange(false);
    if (!alive.current) return;
    setSwitching(false);
    if (result?.ok) onNavigate();
    else setFailed(true);
  };

  /** 작성 중인 초안이 있으면 전환 전에 한 번 확인합니다. */
  const request = (workspace: WorkspaceMembership): void => {
    if (workspace.id !== currentId && hasDraft()) {
      setPendingDraft(workspace);
      setOpen(false);
      return;
    }
    void choose(workspace);
  };

  if (!selectable)
    return (
      <div
        className={styles.single}
        role="group"
        title={name}
        aria-label={`작업 공간 ${name}`}
      >
        <Icon name="folder-open" />
        <span className={styles.text}>{name}</span>
      </div>
    );
  return (
    <div
      className={styles.switcher}
      ref={root}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`작업 공간 ${name} · 바꾸기`}
        title={name}
        disabled={switching}
        data-failed={failed}
        onClick={(): void => setOpen(!open)}
      >
        <Icon name="folder-open" />
        <span className={styles.text}>{switching ? '전환 중…' : name}</span>
        <Icon name="chevron-down" className={styles.arrow} />
      </button>
      {open && (
        <ul className={styles.list} role="listbox" aria-label="작업 공간">
          {workspaces.map((item: WorkspaceMembership): JSX.Element => (
            <li key={item.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={item.id === currentId}
                className={styles.option}
                onClick={(): void => request(item)}
              >
                <span className={styles.check}>
                  {item.id === currentId && <Icon name="check" />}
                </span>
                <span className={styles.text}>
                  {item.displayName || '이름 없는 작업 공간'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {pendingDraft && (
        <div
          className={styles.confirm}
          role="alertdialog"
          aria-label="작업 공간 전환 확인"
        >
          <p>작성 중인 초안은 이 작업 공간으로 옮겨지지 않습니다.</p>
          <div className={styles.confirmActions}>
            <button type="button" onClick={(): void => setPendingDraft(null)}>
              취소
            </button>
            <button
              type="button"
              onClick={(): void => void choose(pendingDraft)}
            >
              전환
            </button>
          </div>
        </div>
      )}
      {failed && (
        <p className={styles.error} role="alert">
          작업 공간을 바꾸지 못했습니다. 현재 작업 공간은 그대로입니다.
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { TemplateSession } from '@contracts/templates.contract';
import { connectionGateway } from '@renderer/platform/connection';

export type TemplateAccess = { session: TemplateSession; canWrite: boolean };
export type TemplateAccessState = {
  access: TemplateAccess | null;
  error: string;
};

/** 현재 연결의 읽기·원본 등록 권한을 고정하고 다른 범위의 초안은 다시 사용하지 않습니다. */
export function useTemplateAccess(): TemplateAccessState {
  const [state, setState] = useState<TemplateAccessState>({
    access: null,
    error: '',
  });
  useEffect((): (() => void) => {
    let active = true;
    let serial = 0;
    const refresh = async (): Promise<void> => {
      const request = ++serial;
      try {
        const result = await connectionGateway.getState();
        if (!active || request !== serial) return;
        if (!result.ok) throw new Error(result.error.message);
        const current = result.data;
        if (current.status !== 'connected' || !current.selection)
          throw new Error('서버와 작업 공간을 연결해 주세요.');
        const selection = current.selection;
        const workspace = current.workspaces.find(
          (item: (typeof current.workspaces)[number]): boolean =>
            item.id === selection.tenant,
        );
        if (
          !workspace?.permissions.includes('read') ||
          !workspace.profiles.some(
            (item: (typeof workspace.profiles)[number]): boolean =>
              item.id === selection.profile,
          )
        )
          throw new Error('현재 작업 공간의 템플릿을 읽을 권한이 없습니다.');
        const access: TemplateAccess = {
          session: {
            connectionId: current.connectionId,
            expectedScope: {
              userId: current.userId,
              tenant: selection.tenant,
              profileId: selection.profile,
              policyRevision: current.policyRevision,
              ...(current.accessRevision
                ? { accessRevision: current.accessRevision }
                : {}),
            },
          },
          canWrite: workspace.permissions.includes('source_write'),
        };
        setState((previous: TemplateAccessState): TemplateAccessState =>
          JSON.stringify(previous.access) === JSON.stringify(access)
            ? previous
            : { access, error: '' },
        );
      } catch (error: unknown) {
        if (active && request === serial)
          setState({
            access: null,
            error:
              error instanceof Error
                ? error.message
                : '현재 연결을 확인하지 못했습니다.',
          });
      }
    };
    const changed = (): void => {
      setState({ access: null, error: '' });
      void refresh();
    };
    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('wiki-connection-changed', changed);
    return (): void => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('wiki-connection-changed', changed);
    };
  }, []);
  return state;
}

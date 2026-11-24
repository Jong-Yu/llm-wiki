import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router';

type PreviewActivityState = { label: string; pending: boolean };

/** 시안의 현재 단계를 읽으며 실제 작업 원장이나 실행 상태를 바꾸지 않습니다. */
export function PreviewActivity(): JSX.Element {
  const [state, setState] = useState<PreviewActivityState>({
    label: '문자 사용 승인 대기',
    pending: true,
  });
  useEffect((): (() => void) => {
    /** 공개된 시안 표시값만 받아 이벤트의 임의 자료를 실행하지 않습니다. */
    const update = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const value: unknown = event.detail;
      if (
        typeof value !== 'object' ||
        value === null ||
        !('label' in value) ||
        typeof value.label !== 'string' ||
        !('pending' in value) ||
        typeof value.pending !== 'boolean'
      )
        return;
      setState({ label: value.label, pending: value.pending });
    };
    window.addEventListener('notification-preview-phase', update);
    return (): void =>
      window.removeEventListener('notification-preview-phase', update);
  }, []);
  return (
    <Link
      to="/tasks?taskId=000000000000000000000000000000c9"
      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
    >
      작업 · {state.pending ? '승인 대기 1' : state.label} ›
    </Link>
  );
}

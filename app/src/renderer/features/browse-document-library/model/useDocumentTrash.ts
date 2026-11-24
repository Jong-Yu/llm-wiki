import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  invalidatesReadScope,
  ReadQueryError,
  useReadQueries,
} from '@renderer/shared/lib/readQueries';
import {
  changeDocumentTrash,
  readDocumentTrash,
} from '../api/documentTrash.api';
import type { TrashPage, TrashTarget } from '../api/documentTrash.api';
import type { LibraryScope } from './documentLibrary.types';

export type DocumentTrashModel = {
  open: boolean;
  setOpen: (open: boolean) => void;
  page: TrashPage | null;
  loading: boolean;
  error: string;
  message: string;
  pending: { target: TrashTarget; restore: boolean } | null;
  busy: boolean;
  choose: (target: TrashTarget, restore?: boolean) => void;
  cancel: () => void;
  confirm: () => Promise<void>;
  refresh: () => void;
};

/** 휴지통 조회와 명시 변경을 관리하고 연결 변경 이후의 늦은 결과는 버립니다. */
export function useDocumentTrash(
  scope: LibraryScope | null,
  onChanged: () => void,
): DocumentTrashModel {
  const { cache, snapshot } = useReadQueries();
  const scopeKey = JSON.stringify([scope, cache.identity, snapshot.generation]);
  const current = useRef(scopeKey);
  const mounted = useRef(true);
  const running = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    scopeKey: string;
    text: string;
  } | null>(null);
  const busy = busyScope === scopeKey;
  const [pending, setPending] = useState<{
    target: TrashTarget;
    restore: boolean;
    scopeKey: string;
  } | null>(null);
  useEffect((): (() => void) => {
    current.current = scopeKey;
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, [scopeKey]);
  const query = useQuery({
    queryKey: cache.key('document-trash', scopeKey),
    enabled: open && scope !== null && !snapshot.failure,
    queryFn: async (): Promise<TrashPage> => {
      if (!scope) throw new Error('작업 공간을 선택해 주세요.');
      return readDocumentTrash(scope);
    },
  });
  const shownPending =
    pending?.scopeKey === scopeKey && !snapshot.failure ? pending : null;
  /** 기존 확인 대상의 기준을 바꾸지 않고 한 번만 처리합니다. */
  async function confirm(): Promise<void> {
    if (!scope || !shownPending || running.current === scopeKey) return;
    running.current = scopeKey;
    setBusyScope(scopeKey);
    setFeedback(null);
    const startedScope = scopeKey;
    try {
      const warnings = await changeDocumentTrash(
        scope,
        shownPending.target,
        shownPending.restore,
      );
      if (!mounted.current || current.current !== startedScope) return;
      setPending(null);
      setFeedback({
        scopeKey,
        text: `${shownPending.restore ? '복원했습니다.' : '휴지통으로 이동했습니다.'}${warnings ? ' 처리는 완료됐지만 임시 파일 정리 문제가 있습니다.' : ''}`,
      });
      // 기존 읽기 무효화 경로를 사용하며 다른 화면의 편집 초안은 유지합니다.
      cache.invalidate();
      onChanged();
      if (open) void query.refetch();
    } catch (error) {
      if (!mounted.current || current.current !== startedScope) return;
      if (
        error instanceof ReadQueryError &&
        invalidatesReadScope(error.failure)
      )
        cache.deny(error.failure);
      const code = error instanceof ReadQueryError ? error.failure.code : '';
      setFeedback({
        scopeKey,
        text:
          code === 'conflict'
            ? '다른 변경이 있습니다. 목록을 새로 고친 뒤 삭제 또는 복원을 다시 선택해 주세요.'
            : code === 'outcome_unknown'
              ? '처리 결과를 확인하지 못했습니다. 다시 실행하기 전에 목록과 휴지통을 새로 고쳐 확인해 주세요.'
              : error instanceof Error
                ? error.message
                : '처리하지 못했습니다. 목록을 다시 확인해 주세요.',
      });
      setPending(null);
    } finally {
      if (running.current === startedScope) running.current = null;
      if (mounted.current)
        setBusyScope((value: string | null): string | null =>
          value === startedScope ? null : value,
        );
    }
  }
  return {
    open,
    setOpen,
    page: snapshot.failure ? null : (query.data ?? null),
    loading: query.isFetching,
    error:
      snapshot.failure?.message ??
      (query.error instanceof Error ? query.error.message : ''),
    message:
      snapshot.failure || feedback?.scopeKey !== scopeKey ? '' : feedback.text,
    pending: shownPending,
    busy,
    choose: (target: TrashTarget, restore: boolean = false): void => {
      if (scope && !busy && !snapshot.failure) {
        setFeedback(null);
        setPending({ target, restore, scopeKey });
      }
    },
    cancel: (): void => {
      if (running.current !== scopeKey) setPending(null);
    },
    confirm,
    refresh: (): void => {
      void query.refetch();
      onChanged();
    },
  };
}

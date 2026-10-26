import { useEffect, useRef, useState } from 'react';
import type {
  SourceVersionScope,
  SourceVersions,
  SourceVersionsResult,
} from '@contracts/sources.contract';
import {
  loadSourceVersions,
  downloadOriginal,
} from '../api/sourceVersions.api';
import type { SourcePreviewRequest } from '@contracts/documents.contract';
import type { SourceCatalogOutcome } from '../api/sourceVersions.api';

type SourceVersionError = Extract<SourceVersionsResult, { ok: false }>['error'];
export type SourceVersionsState =
  | { status: 'loading' }
  | { status: 'error'; error: SourceVersionError }
  | { status: 'ready'; catalog: SourceVersions; canWrite: boolean };
export type UseSourceVersionsInput = {
  sourceId: string;
  scope: SourceVersionScope;
  onScopeInvalidated: () => void;
};
export type SourceVersionsModel = {
  state: SourceVersionsState;
  reload: () => void;
  download: (reference: SourcePreviewRequest) => Promise<void>;
  downloadMessage: string | null;
};

/** 연결/권한 오류와 카탈로그 읽기 실패를 구분합니다. */
function invalidatesScope(error: SourceVersionError): boolean {
  return (
    error.status === 401 ||
    error.status === 403 ||
    [
      'scope_changed',
      'subject_changed',
      'connection_changed',
      'access_changed',
    ].includes(error.code)
  );
}

/** 판본 조회의 수명만 관리하고 새 판본 등록 폼과 원문 미리보기는 부모가 조립합니다. */
export function useSourceVersions({
  sourceId,
  scope,
  onScopeInvalidated,
}: UseSourceVersionsInput): SourceVersionsModel {
  const [state, setState] = useState<SourceVersionsState>({
    status: 'loading',
  });
  const mounted = useRef(false);
  const generation = useRef(0);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);

  /** 원래 선택의 전체 카탈로그만 반영하고 이전 응답을 새 자료에 사용하지 않습니다. */
  function applyCatalog(result: SourceCatalogOutcome, request: number): void {
    if (!mounted.current || generation.current !== request) return;
    if (result.ok)
      setState({
        status: 'ready',
        catalog: result.data,
        canWrite: result.canWrite,
      });
    else {
      setState({ status: 'error', error: result.error });
      if (invalidatesScope(result.error)) onScopeInvalidated();
    }
  }
  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    void loadSourceVersions(sourceId, scope).then(
      (result: SourceCatalogOutcome): void => {
        if (!mounted.current || generation.current !== request) return;
        if (result.ok)
          setState({
            status: 'ready',
            catalog: result.data,
            canWrite: result.canWrite,
          });
        else {
          setState({ status: 'error', error: result.error });
          if (invalidatesScope(result.error)) onScopeInvalidated();
        }
      },
    );
    return (): void => {
      mounted.current = false;
      generation.current += 1;
    };
  }, [sourceId, scope, onScopeInvalidated]);

  /** 카탈로그 조회는 원본을 다시 저장하지 않고 현재 CAS 기준을 읽습니다. */
  function reload(): void {
    const request = ++generation.current;
    setState({ status: 'loading' });
    void loadSourceVersions(sourceId, scope).then(
      (result: SourceCatalogOutcome): void => applyCatalog(result, request),
    );
  }
  /** 현재 선택의 원본을 저장하며 취소·실패·성공을 구분합니다. */
  async function download(reference: SourcePreviewRequest): Promise<void> {
    setDownloadMessage('원본 파일을 확인하고 있습니다.');
    const result = await downloadOriginal(reference);
    if (!mounted.current) return;
    setDownloadMessage(
      result.ok
        ? result.data.saved
          ? '원본 파일을 저장했습니다.'
          : '파일 저장을 취소했습니다.'
        : result.error.message,
    );
    if (!result.ok && invalidatesScope(result.error)) onScopeInvalidated();
  }
  return { state, reload, download, downloadMessage };
}

import { useEffect, useRef, useState } from 'react';
import type {
  DocumentListItem,
  SourcePreviewResult,
} from '@contracts/documents.contract';
import {
  downloadLibrarySource,
  queryLibrarySourcePreview,
} from '../api/documentLibrary.queries';
import type { LibraryScope } from './documentLibrary.types';

type SourceItem = Extract<DocumentListItem, { kind: 'source' }>;
type PreviewState = {
  item: SourceItem;
  scope: LibraryScope;
  result: SourcePreviewResult | null;
  downloading: boolean;
  downloadMessage: string;
  downloadFailed: boolean;
} | null;
type LibrarySourcePreviewModel = {
  state: PreviewState;
  open: (item: SourceItem, scope: LibraryScope) => void;
  close: () => void;
  download: () => Promise<void>;
};

/** 선택을 닫거나 바꾸면 늦게 완료된 원본 응답이 다시 열리지 않게 합니다. */
export function useLibrarySourcePreview(): LibrarySourcePreviewModel {
  const [state, setState] = useState<PreviewState>(null);
  const generation = useRef(0);
  const downloading = useRef(false);
  useEffect(
    (): (() => void) => (): void => {
      generation.current += 1;
    },
    [],
  );
  return {
    state,
    open: (item: SourceItem, scope: LibraryScope): void => {
      const request = ++generation.current;
      downloading.current = false;
      setState({
        item,
        scope,
        result: null,
        downloading: false,
        downloadMessage: '',
        downloadFailed: false,
      });
      void queryLibrarySourcePreview(item, scope).then(
        (result: SourcePreviewResult): void => {
          if (generation.current === request)
            setState((current: PreviewState): PreviewState =>
              current ? { ...current, result } : null,
            );
        },
      );
    },
    close: (): void => {
      generation.current += 1;
      downloading.current = false;
      setState(null);
    },
    download: async (): Promise<void> => {
      if (!state || downloading.current) return;
      const request = generation.current;
      downloading.current = true;
      setState((current: PreviewState): PreviewState =>
        current
          ? {
              ...current,
              downloading: true,
              downloadMessage: '',
              downloadFailed: false,
            }
          : null,
      );
      const result = await downloadLibrarySource(state.item, state.scope);
      if (generation.current !== request) return;
      downloading.current = false;
      setState((current: PreviewState): PreviewState =>
        current
          ? {
              ...current,
              downloading: false,
              downloadFailed: !result.ok,
              downloadMessage: result.ok
                ? result.data.saved
                  ? '원본 내려받기를 시작했습니다.'
                  : '내려받기를 취소했습니다.'
                : result.error.message,
            }
          : null,
      );
    },
  };
}

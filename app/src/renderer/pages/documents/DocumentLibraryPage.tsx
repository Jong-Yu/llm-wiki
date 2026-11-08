import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { DocumentLibrary } from '@renderer/features/browse-document-library';
import { sourceAnalysisStarter } from './sourceAnalysisStarter';

/** 문서 목록의 업무 흐름과 신규 상세·온톨로지 진입을 페이지에서 연결합니다. */
export function DocumentLibraryPage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <DocumentLibrary
      analysisStarter={sourceAnalysisStarter}
      onOpenDocument={(document: string): void => {
        void navigate(
          `/document?${new URLSearchParams({ path: document }).toString()}`,
        );
      }}
      onOpenOntology={(document: string): void => {
        void navigate(
          `/ontology?${new URLSearchParams({ path: document }).toString()}`,
        );
      }}
      onOpenSource={(sourceId: string, version: string): void => {
        void navigate(`/source?${new URLSearchParams({ sourceId, version })}`);
      }}
    />
  );
}

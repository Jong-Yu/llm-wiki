import { useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import type { Location } from 'react-router';
import {
  WorkspaceActivity,
  useWorkspaceActivity,
} from '@renderer/shared/lib/workspaceActivity';
import { OntologyExplorer } from './OntologyExplorer';
import { OntologyMapWorkspace } from './OntologyMapWorkspace';
import { createOntologyQueryClient } from '../api/ontologyExploration.queries';

type RetainedOntology = {
  location: Location;
  legacyLocation: Location | null;
  visitedSearch: boolean;
};

/** 전역 검색 지도와 기존 문서별 작업의 주소·초안을 별도 보관합니다. */
export function OntologyExplorationWorkspace(): JSX.Element {
  const [client] = useState(createOntologyQueryClient);
  useEffect((): (() => void) => {
    const clear = (): void => client.clear();
    window.addEventListener('wiki-connection-changed', clear);
    const changed = (): void => {
      void client.invalidateQueries();
    };
    window.addEventListener('wiki-data-changed', changed);
    return (): void => {
      window.removeEventListener('wiki-connection-changed', clear);
      window.removeEventListener('wiki-data-changed', changed);
      client.clear();
    };
  }, [client]);
  const location = useLocation();
  const active = useWorkspaceActivity();
  const search = new URLSearchParams(location.search);
  const legacy = Boolean(
    search.get('path') ||
    search.get('document') ||
    search.get('mode') ||
    ['reviews', 'cleanup', 'relation-new'].includes(search.get('view') ?? ''),
  );
  const [stored, setStored] = useState<RetainedOntology>(
    (): RetainedOntology => ({
      location,
      legacyLocation: legacy ? location : null,
      visitedSearch: !legacy,
    }),
  );
  if (stored.location !== location)
    setStored({
      location,
      legacyLocation: legacy ? location : stored.legacyLocation,
      visitedSearch: stored.visitedSearch || !legacy,
    });
  return (
    <QueryClientProvider client={client}>
      {stored.visitedSearch && (
        <div hidden={legacy} style={{ height: '100%', minHeight: 0 }}>
          <WorkspaceActivity active={active && !legacy}>
            <OntologyExplorer active={active && !legacy} />
          </WorkspaceActivity>
        </div>
      )}
      {stored.legacyLocation && (
        <div hidden={!legacy} style={{ height: '100%', minHeight: 0 }}>
          <WorkspaceActivity active={active && legacy}>
            <Routes location={stored.legacyLocation}>
              <Route path="*" element={<OntologyMapWorkspace />} />
            </Routes>
          </WorkspaceActivity>
        </div>
      )}
    </QueryClientProvider>
  );
}

import type { JSX } from 'react';
import { OntologyExplorationWorkspace } from '@renderer/features/explore-ontology-map';

/** 현재 앱 연결 범위의 개념 탐색 화면을 신규 라우트에 제공합니다. */
export function OntologyMapPage(): JSX.Element {
  return <OntologyExplorationWorkspace />;
}

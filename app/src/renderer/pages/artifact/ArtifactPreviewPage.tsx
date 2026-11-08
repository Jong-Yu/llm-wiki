import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { DocumentArtifactWorkspace } from '@renderer/features/create-document-artifact';

/** 채팅에서 전달한 실제 저장 결과와 선택적 생성·편집 참조를 기능 입력으로 조립합니다. */
export function ArtifactPreviewPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const artifactId = params.get('artifactId');
  const questionRunId = params.get('questionRunId');
  const draftId = params.get('draftId');
  return (
    <DocumentArtifactWorkspace
      key={`${artifactId}:${questionRunId}:${draftId}`}
      artifactId={artifactId}
      questionRunId={questionRunId}
      draftId={draftId}
      editing={params.get('mode') === 'edit'}
      onEditingChange={(editing: boolean): void => {
        const next = new URLSearchParams(params);
        if (editing) next.set('mode', 'edit');
        else next.delete('mode');
        setParams(next);
      }}
    />
  );
}

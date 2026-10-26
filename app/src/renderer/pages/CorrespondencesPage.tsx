import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { isDocumentPath } from '@contracts/documents.contract';
import { ManageCorrespondences } from '@renderer/features/manage-correspondences';

/** 유효한 문서 참조만 검색 초안으로 전달하며 조회나 변경을 자동 실행하지 않습니다. */
export function CorrespondencesPage(): JSX.Element {
  const [parameters] = useSearchParams();
  const document = parameters.get('document');
  return (
    <ManageCorrespondences
      initialDocument={
        document && isDocumentPath(document) ? document : undefined
      }
    />
  );
}

export default CorrespondencesPage;

import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { ManageDocumentContent } from '@renderer/features/manage-document-content';

/** 신규 상세 경로의 문서 참조를 읽고 기능에 전달합니다. 인증 선택은 기존 앱 연결을 따릅니다. */
export function DocumentDetailPage(): JSX.Element {
  const [parameters] = useSearchParams();
  const path = parameters.get('path') ?? '';
  return <ManageDocumentContent key={path} path={path} />;
}

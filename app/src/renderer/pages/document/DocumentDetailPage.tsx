import type { JSX } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { ManageDocumentContent } from '@renderer/features/manage-document-content';
import {
  RegistrationReadingDocument,
  registrationReadingReference,
} from './RegistrationReadingDocument';

/** 신규 상세 경로의 문서 참조를 읽고 기능에 전달합니다. 인증 선택은 기존 앱 연결을 따릅니다. */
export function DocumentDetailPage(): JSX.Element {
  const [parameters] = useSearchParams();
  const location = useLocation();
  const path = parameters.get('path') ?? '';
  const progress = registrationReadingReference(location.state);
  if (progress)
    return (
      <RegistrationReadingDocument
        key={`${path}:${progress.path}`}
        path={path}
        progress={progress}
      />
    );
  return <ManageDocumentContent key={path} path={path} />;
}

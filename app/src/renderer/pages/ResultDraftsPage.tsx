import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { ManageResultDrafts } from '@renderer/features/manage-result-drafts';
import { PageNavigation } from '@renderer/shared/ui/PageNavigation';

/** 저장 결과의 참조를 명시 초안 생성 화면에 인계하고 자동 쓰기를 하지 않습니다. */
export function ResultDraftsPage(): JSX.Element {
  const [params] = useSearchParams();
  const id = params.get('savedResultId');
  return (
    <ManageResultDrafts
      savedResultId={id && /^[a-f0-9]{32}$/.test(id) ? id : undefined}
      navigation={
        <PageNavigation
          links={[
            { to: '/saved-results', label: '저장 결과' },
            { to: '/documents', label: 'Wiki 문서' },
            { to: '/conversations', label: '질문·대화' },
          ]}
        />
      }
    />
  );
}

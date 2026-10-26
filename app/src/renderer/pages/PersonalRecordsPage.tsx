import { PageNavigation } from '@renderer/shared/ui/PageNavigation';
import type { JSX } from 'react';
import { useSearchParams } from 'react-router';
import { isDocumentPath } from '@contracts/documents.contract';
import { RunQuestion } from '@renderer/features/run-question';
import { questionSourceSchema } from '@renderer/features/manage-personal-records';
import type { PersonalQuestionContext } from '@renderer/features/manage-personal-records';
import { ManagePersonalRecords } from '@renderer/features/manage-personal-records';
import type { PersonalMode } from '@renderer/features/manage-personal-records';

type PersonalRecordsPageProps = { mode: PersonalMode };
/** 개인 대화·결과 초안·비교의 실제 저장 화면을 경로별로 조립합니다. */
export function PersonalRecordsPage({
  mode,
}: PersonalRecordsPageProps): JSX.Element {
  const [params] = useSearchParams();
  const requestedDocument = params.get('document');
  const initialDocument =
    requestedDocument && isDocumentPath(requestedDocument)
      ? requestedDocument
      : undefined;
  const source = questionSourceSchema.safeParse({
    source_id: params.get('sourceId'),
    source_version: params.get('sourceVersion'),
    source_sha256: params.get('sourceSha256'),
    ...(params.has('conversionId')
      ? {
          conversion_ref: {
            conversion_id: params.get('conversionId'),
            conversion_revision: params.get('conversionRevision'),
          },
        }
      : {}),
  });
  return (
    <ManagePersonalRecords
      key={mode}
      mode={mode}
      initialDocument={initialDocument}
      initialSource={source.success ? source.data : undefined}
      renderQuestion={(context: PersonalQuestionContext): JSX.Element => (
        <RunQuestion
          key={JSON.stringify([
            context.session,
            context.question.questionTurnId,
          ])}
          session={context.session}
          question={context.question}
          canWrite={context.canWrite}
          onChanged={context.onChanged}
        />
      )}
      navigation={
        <PageNavigation
          links={[
            { to: '/analysis', label: 'AI 작업 목록' },
            { to: '/result-drafts', label: '편집 초안·Wiki 반영' },
            ...(mode !== 'conversations'
              ? [{ to: '/conversations', label: '질문·대화' }]
              : [{ to: '/questions', label: '질문 근거 준비' }]),
            ...(mode !== 'savedResults'
              ? [{ to: '/saved-results', label: '결과물' }]
              : [{ to: '/comparisons', label: '변경 비교' }]),
          ]}
        />
      }
    />
  );
}

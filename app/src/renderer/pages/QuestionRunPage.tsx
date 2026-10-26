import type { JSX } from 'react';
import { useParams } from 'react-router';
import { QuestionRunHistory } from '@renderer/features/run-question';

/** 현재 선택 범위와 질문 실행 경로를 전용 기능에 전달합니다. */
export function QuestionRunPage(): JSX.Element {
  const { tenant, questionRunId } = useParams();
  return (
    <QuestionRunHistory
      key={tenant}
      tenant={tenant}
      initialRunId={questionRunId}
    />
  );
}

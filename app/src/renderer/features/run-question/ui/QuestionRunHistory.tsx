import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { QuestionSession } from '@contracts/questionRuns.contract';
import { loadQuestionScope } from '../api/questionRuns.api';
import { RunQuestion } from './RunQuestion';

type QuestionRunHistoryProps = {
  tenant: string | undefined;
  initialRunId: string | undefined;
};
export type QuestionPageScope = { session: QuestionSession; canWrite: boolean };
/** 현재 연결 범위를 확인한 후 질문 이력을 표시하며 조회만으로 실행하지 않습니다. */
export function QuestionRunHistory({
  tenant,
  initialRunId,
}: QuestionRunHistoryProps): JSX.Element {
  const [scope, setScope] = useState<QuestionPageScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) => {
    let active = true;
    /** 늦게 도착한 이전 연결의 범위를 새 페이지에 표시하지 않습니다. */
    async function load(): Promise<void> {
      const result = await loadQuestionScope(tenant);
      if (!active) return;
      if (result.ok) {
        setScope(result.data);
        setError(null);
      } else setError(result.error.message);
    }
    void load();
    return (): void => {
      active = false;
    };
  }, [tenant]);
  if (error) return <p role="alert">{error}</p>;
  if (!scope || scope.session.expectedScope.tenant !== tenant)
    return <p role="status">질문 실행 목록을 준비합니다.</p>;
  return (
    <RunQuestion
      key={JSON.stringify(scope.session)}
      session={scope.session}
      canWrite={scope.canWrite}
      initialRunId={initialRunId}
    />
  );
}

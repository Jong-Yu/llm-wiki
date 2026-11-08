import { useEffect, useState } from 'react';
import type { AnalysisProposalsBridge } from '@contracts/analysisProposals.contract';
import type { ProposalExecutionBridge } from '@contracts/proposalExecution.contract';
import { loadProposalScope } from '../api/analysisProposal.api';
import type { ProposalScope } from '../api/analysisProposal.api';
import { ProposalSession } from './ProposalSession';

type SessionEntry = { session: ProposalSession; ready: Promise<void> };
type CurrentSession = { key: string; session: ProposalSession };
type ProposalSessionModel = {
  current: CurrentSession | null;
  error: string | null;
  retry: () => void;
  refreshScope: () => void;
};
const sessions = new Map<string, SessionEntry>();

/** 계정·권한·문서가 같은 세션의 초안과 복구 준비를 하나의 항목으로 보관합니다. */
function sessionEntry(
  key: string,
  scope: ProposalScope,
  gateway: AnalysisProposalsBridge,
  executionGateway: ProposalExecutionBridge | undefined,
  document: string,
  proposalId: string,
): SessionEntry {
  const existing = sessions.get(key);
  if (existing) return existing;
  const session = new ProposalSession(scope, gateway, executionGateway);
  const ready = (async (): Promise<void> => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([document, proposalId])),
    );
    const recoveryKey = [...new Uint8Array(digest)]
      .map((value: number): string => value.toString(16).padStart(2, '0'))
      .join('');
    await session.initializeRecovery(recoveryKey);
  })();
  const entry = { session, ready };
  sessions.set(key, entry);
  return entry;
}

/** 현재 허용 범위를 확인하고 복구가 끝난 세션만 열며 늦은 응답은 버립니다. */
export function useProposalSession(
  gateway: AnalysisProposalsBridge,
  executionGateway: ProposalExecutionBridge | undefined,
  initialDocument: string,
  initialProposalId: string,
): ProposalSessionModel {
  const [refresh, setRefresh] = useState(0);
  const [current, setCurrent] = useState<CurrentSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect((): (() => void) => {
    let alive = true;
    void loadProposalScope()
      .then(async (scope: ProposalScope): Promise<void> => {
        if (!alive) return;
        const key = JSON.stringify([
          scope.connectionId,
          scope.userId,
          scope.tenant,
          scope.profileId,
          scope.accessRevision ?? scope.policyRevision,
          initialDocument,
          initialProposalId,
        ]);
        const { session, ready } = sessionEntry(
          key,
          scope,
          gateway,
          executionGateway,
          initialDocument,
          initialProposalId,
        );
        await ready;
        if (!alive) return;
        setCurrent({ key, session });
        if (
          initialProposalId &&
          !session.snapshot().record &&
          !session.snapshot().busy
        )
          void session.run({
            ...session.requestFields(),
            operation: 'read',
            input: { proposal_id: initialProposalId },
          });
      })
      .catch((reason: unknown): void => {
        if (alive)
          setError(
            reason instanceof Error
              ? reason.message
              : '연결 범위를 확인할 수 없습니다.',
          );
      });
    return (): void => {
      alive = false;
    };
  }, [gateway, executionGateway, initialDocument, initialProposalId, refresh]);
  return {
    current,
    error,
    retry: (): void => setRefresh(refresh + 1),
    refreshScope: (): void => {
      setCurrent(null);
      setError(null);
      setRefresh(refresh + 1);
    },
  };
}

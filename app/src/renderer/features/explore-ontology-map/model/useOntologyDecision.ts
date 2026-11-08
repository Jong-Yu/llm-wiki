import { useEffect, useRef, useState } from 'react';
import type { WorkspaceRequest } from '@contracts/workspace.contract';
import { invalidatesScope, saveOntologyDecision } from '../api/ontologyMap.api';
import type {
  CorrectionBasis,
  CorrectionReceipt,
  OntologyFailure,
} from './ontologyMap.types';

export type DecisionCommand = Extract<
  WorkspaceRequest,
  {
    operation:
      | 'review'
      | 'policy'
      | 'reviewUndo'
      | 'policyUndo'
      | 'relationCreate'
      | 'relationUndo';
  }
>;
type DecisionState =
  | { phase: 'idle' | 'saving' }
  | { phase: 'error'; error: OntologyFailure }
  | { phase: 'saved'; receipt: CorrectionReceipt };
export type OntologyDecisionModel = {
  state: DecisionState;
  blocked: boolean;
  submit: (command: DecisionCommand) => Promise<void>;
  reconcile: (requestId: string) => Promise<void>;
  requestId: string | null;
};

/** 명시 저장의 수명을 고정하고 충돌·응답 유실 뒤 이전 초안의 재전송을 막습니다. */
export function useOntologyDecision(
  basis: CorrectionBasis,
  onSaved: (receipt: CorrectionReceipt) => void,
  onInvalidate: () => void,
): OntologyDecisionModel {
  const [state, setState] = useState<DecisionState>({ phase: 'idle' });
  const mounted = useRef(true);
  const busy = useRef(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  const blocked =
    state.phase === 'saving' ||
    state.phase === 'saved' ||
    (state.phase === 'error' &&
      (state.error.code === 'outcome_unknown' ||
        state.error.code === 'conflict' ||
        state.error.status === 409 ||
        state.error.retry === 'reconcile'));
  /** 전송 중 중복 클릭도 같은 이벤트를 두 번 만들지 않습니다. */
  async function submit(command: DecisionCommand): Promise<void> {
    if (blocked || busy.current) return;
    setRequestId(
      'request_id' in command.input ? command.input.request_id : null,
    );
    busy.current = true;
    setState({ phase: 'saving' });
    const result = await saveOntologyDecision(basis, command);
    busy.current = false;
    if (!mounted.current) return;
    if (!result.ok) {
      if (invalidatesScope(result.error)) {
        onInvalidate();
        return;
      }
      setState({ phase: 'error', error: result.error });
    } else {
      setState({ phase: 'saved', receipt: result.data });
      onSaved(result.data);
    }
  }
  /** 요청 ID의 저장 영수증만 조회하며 쓰기를 자동으로 반복하지 않습니다. */
  async function reconcile(requestId: string): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    const {
      permissions: _permissions,
      connectionId,
      ...expectedScope
    } = basis.scope;
    const result = await saveOntologyDecision(basis, {
      connectionId,
      expectedScope,
      operation: 'relationRequest',
      input: { document: basis.assertion.document, request_id: requestId },
    });
    busy.current = false;
    if (!mounted.current) return;
    if (result.ok) {
      setState({ phase: 'saved', receipt: result.data });
      onSaved(result.data);
    } else if (invalidatesScope(result.error)) onInvalidate();
    else
      setState({
        phase: 'error',
        error: {
          ...result.error,
          code: 'outcome_unknown',
          message:
            result.error.status === 404
              ? '이 요청의 저장 기록이 없습니다. 현재 문서·관계와 초안을 대조한 뒤 새 요청을 시작해 주세요.'
              : result.error.message,
        },
      });
  }
  return { state, blocked, submit, reconcile, requestId };
}

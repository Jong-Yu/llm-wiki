import { useEffect, useRef, useState } from 'react';
import type {
  SourceFile,
  SourceRegistrationRequest,
  SourceRegistrationRecord,
  SourceRegistrationResult,
  SourceExpectedScope,
} from '@contracts/sources.contract';
import {
  chooseSourceFile,
  registerSource,
  checkSourceReceipt,
} from '../api/sourceRegistration.api';

type RegistrationError = Extract<
  SourceRegistrationResult,
  { ok: false }
>['error'];
export type CompletedRegistration = Extract<
  SourceRegistrationRecord,
  { state: 'complete' }
>;
type RegistrationState =
  | { status: 'idle' }
  | { status: 'busy'; requestId: string | null }
  | { status: 'error'; error: RegistrationError }
  | { status: 'unconfirmed'; requestId: string; message: string };
type SourceRegistrationInput = {
  connectionId: string;
  onRegistered: (record: CompletedRegistration) => void;
  onScopeInvalidated: () => void;
  expectedScope?: SourceExpectedScope;
};
export type SourceRegistrationModel = {
  state: RegistrationState;
  file: SourceFile | null;
  chooseFile: () => Promise<SourceFile | null>;
  submit: (request: SourceRegistrationRequest) => Promise<void>;
  check: () => Promise<void>;
  clearError: () => void;
};

/** 입력은 폼이 소유하며 이 hook은 한 등록 요청의 진행/미확정/영수증 수명만 관리합니다. */
export function useSourceRegistration({
  connectionId,
  onRegistered,
  onScopeInvalidated,
  expectedScope,
}: SourceRegistrationInput): SourceRegistrationModel {
  const [state, setState] = useState<RegistrationState>({ status: 'idle' });
  const [file, setFile] = useState<SourceFile | null>(null);
  const mounted = useRef(false);
  const locked = useRef(false);
  const requestId = useRef<string | null>(null);
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  /** 완료된 영수증만 목록에 반영하고 조정 대기는 초안과 요청 ID를 보존합니다. */
  function apply(result: SourceRegistrationResult, id: string): void {
    if (!mounted.current) return;
    if (result.ok) {
      if (result.data.state === 'complete') {
        requestId.current = null;
        setState({ status: 'idle' });
        setFile(null);
        onRegistered(result.data);
      } else
        setState({
          status: 'unconfirmed',
          requestId: id,
          message:
            '원본 등록 확인이 진행 중입니다. 같은 요청의 상태를 다시 확인해 주세요.',
        });
    } else if (
      result.error.code === 'registration_unresolved' &&
      result.error.requestId
    ) {
      requestId.current = result.error.requestId;
      setState({
        status: 'unconfirmed',
        requestId: result.error.requestId,
        message: result.error.message,
      });
    } else if (result.error.code === 'outcome_unknown')
      setState({
        status: 'unconfirmed',
        requestId: id,
        message: result.error.message,
      });
    else {
      requestId.current = null;
      setState({ status: 'error', error: result.error });
      if (
        result.error.status === 401 ||
        result.error.status === 403 ||
        ['scope_changed', 'connection_changed', 'subject_changed'].includes(
          result.error.code,
        )
      )
        onScopeInvalidated();
    }
  }

  /** 파일을 바꿔도 텍스트/제목 초안은 폼에서 보존합니다. */
  async function chooseFile(): Promise<SourceFile | null> {
    if (locked.current || requestId.current) return null;
    locked.current = true;
    setState({ status: 'busy', requestId: null });
    const result = await chooseSourceFile({ connectionId });
    locked.current = false;
    if (!mounted.current) return null;
    if (!result.ok) {
      setState({ status: 'error', error: result.error });
      if (
        result.error.status === 401 ||
        result.error.status === 403 ||
        ['scope_changed', 'connection_changed', 'subject_changed'].includes(
          result.error.code,
        )
      )
        onScopeInvalidated();
      return null;
    }
    setState({ status: 'idle' });
    if (result.data) setFile(result.data);
    return result.data;
  }

  /** 한 번 제출한 요청은 완료/확정 실패 전까지 새 요청으로 교체하지 않습니다. */
  async function submit(request: SourceRegistrationRequest): Promise<void> {
    if (locked.current || requestId.current) return;
    locked.current = true;
    requestId.current = request.requestId;
    setState({ status: 'busy', requestId: request.requestId });
    const result = await registerSource({ ...request, expectedScope });
    locked.current = false;
    apply(result, request.requestId);
  }

  /** 응답 유실·조정 대기는 원본을 다시 보내지 않고 GET 영수증으로 확인합니다. */
  async function check(): Promise<void> {
    const id = requestId.current;
    if (!id || locked.current) return;
    locked.current = true;
    setState({ status: 'busy', requestId: id });
    const result = await checkSourceReceipt({ connectionId, requestId: id });
    locked.current = false;
    apply(result, id);
  }
  /** 입력을 고칠 때 이전 확정 실패만 지우고 진행/미확정 요청은 유지합니다. */
  function clearError(): void {
    if (state.status === 'error') setState({ status: 'idle' });
  }
  return { state, file, chooseFile, submit, check, clearError };
}

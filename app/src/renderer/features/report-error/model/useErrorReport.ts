import { useEffect, useRef, useState } from 'react';
import { submitErrorReport } from '@renderer/platform/voc';

type ReportState = 'idle' | 'sending' | 'sent' | 'failed';
type ErrorReportModel = {
  content: string;
  state: ReportState;
  error: string | null;
  changeContent: (value: string) => void;
  submit: () => Promise<void>;
};

/** 보고 초안과 전송 상태를 보관하며 저장 확인 뒤에만 입력을 비웁니다. */
export function useErrorReport(connectionId: string): ErrorReportModel {
  const [content, setContent] = useState('');
  const [state, setState] = useState<ReportState>('idle');
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const active = useRef(false);
  useEffect((): (() => void) => {
    active.current = true;
    return (): void => {
      // 계정 전환으로 내려간 화면에는 이전 전송 결과를 반영하지 않습니다.
      active.current = false;
    };
  }, []);

  /** 새 입력은 이전 완료·실패 표시를 해제하며 전송 중 내용은 고정합니다. */
  const changeContent = (value: string): void => {
    if (sending.current) return;
    setContent(value);
    setState('idle');
    setError(null);
  };

  /** 연속 제출을 막고 서버가 확인한 성공과 전송 실패를 구별합니다. */
  const submit = async (): Promise<void> => {
    if (sending.current) return;
    if (!content.trim()) {
      setError('오류 내용을 입력해 주세요.');
      return;
    }
    sending.current = true;
    setState('sending');
    setError(null);
    try {
      const result = await submitErrorReport({ connectionId, content });
      if (!active.current) return;
      if (result.ok) {
        setContent('');
        setState('sent');
      } else {
        setError(result.error.message);
        setState('failed');
      }
    } catch {
      if (!active.current) return;
      setError('보고 전송을 확인하지 못했습니다. 연결 상태를 확인해 주세요.');
      setState('failed');
    } finally {
      sending.current = false;
    }
  };
  return { content, state, error, changeContent, submit };
}

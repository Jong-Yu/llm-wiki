import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RegistrationDraft,
  RegistrationDraftGetRequest,
} from '@contracts/registrationDrafts.contract';
import { registrationDraftGetSchema } from '@contracts/registrationDrafts.contract';
import {
  registrationDraftsApi,
  hasRegistrationDraftBridge,
} from '../api/notifications.api';
import { RegistrationDraftController } from './RegistrationDraftController';

type DraftModel = {
  restored: RegistrationDraft | null;
  ready: boolean;
  status: string;
  pending: boolean;
  reload: () => void;
  save: (draft: RegistrationDraft) => Promise<void>;
  clear: (reason: 'registered' | 'discarded') => Promise<void>;
};

/** 같은 원본과 보고의 보호 초안을 복원하며 범위가 바뀐 응답은 화면에 남기지 않습니다. */
export function useRegistrationDraft(
  identity: RegistrationDraftGetRequest | null,
): DraftModel {
  const identityKey = identity ? JSON.stringify(identity) : null;
  const controller = useRef<RegistrationDraftController | null>(null);
  const generation = useRef(0);
  const writes = useRef({ generation: 0, count: 0 });
  const [restored, setRestored] = useState<RegistrationDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('초안을 확인하고 있습니다.');
  const [pending, setPending] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  /** 첫 읽기 실패는 기존 초안을 덮지 않고 같은 범위에서 다시 조회합니다. */
  const reload = useCallback((): void => {
    setReadAttempt((attempt: number): number => attempt + 1);
  }, []);
  useEffect((): (() => void) => {
    const current = ++generation.current;
    controller.current = null;
    queueMicrotask((): void => {
      if (generation.current !== current) return;
      setReady(false);
      setRestored(null);
      setStatus('초안을 확인하고 있습니다.');
      if (identityKey) {
        if (!hasRegistrationDraftBridge()) {
          setReady(true);
          setStatus('현재 앱은 종료 후 초안 복원을 지원하지 않습니다.');
        } else {
          const instance = new RegistrationDraftController(
            registrationDraftGetSchema.parse(JSON.parse(identityKey)),
            registrationDraftsApi,
          );
          controller.current = instance;
          void instance
            .read()
            .then((draft: RegistrationDraft | null): void => {
              if (generation.current !== current) return;
              setRestored(draft);
              setReady(true);
              setStatus(
                draft
                  ? '저장한 초안을 복원했습니다.'
                  : '수정한 내용은 이 기기에 자동 저장됩니다.',
              );
            })
            .catch((cause: unknown): void => {
              if (generation.current === current)
                setStatus(
                  cause instanceof Error
                    ? cause.message
                    : '초안을 복원하지 못했습니다.',
                );
            });
        }
      }
    });
    return (): void => {
      generation.current += 1;
    };
  }, [identityKey, readAttempt]);

  /** 서버 변경 전의 고정 제출도 같은 직렬 저장 경로로 디스크에 확정합니다. */
  const save = useCallback(async (draft: RegistrationDraft): Promise<void> => {
    const instance = controller.current;
    if (!instance) return;
    const current = generation.current;
    if (writes.current.generation !== current)
      writes.current = { generation: current, count: 0 };
    writes.current.count += 1;
    setPending(true);
    setStatus('초안 저장 중…');
    try {
      const warnings = await instance.save(draft);
      if (generation.current === current)
        setStatus(
          warnings
            ? '초안은 저장했지만 보호 기록 정리 상태를 확인해 주세요.'
            : '이 기기에 초안 저장됨',
        );
    } catch (cause: unknown) {
      if (generation.current === current)
        setStatus('초안을 저장하지 못했습니다. 입력은 화면에 남아 있습니다.');
      throw cause;
    } finally {
      if (writes.current.generation === current) writes.current.count -= 1;
      if (generation.current === current) setPending(writes.current.count > 0);
    }
  }, []);

  /** 완료 영수증 확인 또는 사용자의 수정 취소 뒤에만 로컬 초안을 정리합니다. */
  const clear = useCallback(
    async (reason: 'registered' | 'discarded'): Promise<void> => {
      const current = generation.current;
      const warnings = await controller.current?.clear(reason);
      if (generation.current !== current) return;
      setStatus(
        warnings
          ? '초안 정리는 완료했지만 보호 기록 정리 상태를 확인해 주세요.'
          : reason === 'registered'
            ? '등록 내용 저장됨'
            : '수정을 취소했습니다.',
      );
    },
    [],
  );
  return { restored, ready, status, pending, reload, save, clear };
}

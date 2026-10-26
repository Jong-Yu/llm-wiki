import { createRecoverySlot } from '@renderer/platform/recovery';
import { sourceConversionRunSchema } from '@contracts/sourceConversion.contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversionSource,
  SourceConversionReadRequest,
  SourceConversionRun,
  SourceConversionResult,
} from '@contracts/sourceConversion.contract';
import type { SourceConversionScope } from '@contracts/sourceConversion.contract';
import { z } from 'zod';
import {
  startSourceConversion,
  readSourceConversion,
  cancelSourceConversion,
} from '../api/sourceConversion.api';

export const conversionOptionsSchema = z.object({
  ocr: z.enum(['auto', 'never', 'always']),
  ocrLanguage: z
    .string()
    .regex(
      /^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/,
      '언어 코드를 +로 연결해 주세요. 예: kor+eng',
    )
    .max(100),
});
export type ConversionOptions = z.infer<typeof conversionOptionsSchema>;
type Options = {
  source: ConversionSource;
  scope: SourceConversionScope;
  onScopeInvalidated: () => void;
};
type Model = {
  run: SourceConversionRun | null;
  recoveryNotice: string;
  recovering: boolean;
  busy: boolean;
  error: string | null;
  start: (options: ConversionOptions) => Promise<void>;
  refresh: () => Promise<void>;
  cancel: () => Promise<void>;
};
/** 원본·권한 변경 뒤 도착한 응답을 버리며 조회와 실행을 분리합니다. */
export function useSourceConversion({
  source,
  scope,
  onScopeInvalidated,
}: Options): Model {
  const request = useMemo(
    (): SourceConversionReadRequest => ({
      sourceId: source.sourceId,
      sourceVersion: source.sourceVersion,
      sourceSha256: source.sourceSha256,
      registrationRevision: source.registrationRevision,
      connectionId: scope.connectionId,
      expectedScope: {
        userId: scope.userId,
        tenant: scope.tenant,
        profileId: scope.profileId,
        policyRevision: scope.policyRevision,
      },
    }),
    [
      source.sourceId,
      source.sourceVersion,
      source.sourceSha256,
      source.registrationRevision,
      scope.connectionId,
      scope.userId,
      scope.tenant,
      scope.profileId,
      scope.policyRevision,
    ],
  );
  const recovery = useMemo(
    (): ReturnType<typeof createRecoverySlot<SourceConversionRun>> =>
      createRecoverySlot(
        { connectionId: request.connectionId, ...request.expectedScope },
        'source-conversions',
        `${source.sourceId}:${source.sourceVersion}`,
        (value: unknown): SourceConversionRun => {
          const parsed = sourceConversionRunSchema.parse(value);
          if (
            parsed.source.sourceId !== request.sourceId ||
            parsed.source.sourceVersion !== request.sourceVersion ||
            parsed.source.sourceSha256 !== request.sourceSha256 ||
            parsed.source.registrationRevision !== request.registrationRevision
          )
            throw new Error('변환 복구 자료의 원본 기준이 다릅니다.');
          return parsed;
        },
      ),
    [request, source.sourceId, source.sourceVersion],
  );
  const recovered = useRef<SourceConversionRun | null>(null);
  const hydrated = useRef(false);
  const lastSaved = useRef('');
  const [recoveredKey, setRecoveredKey] = useState('');
  const [deniedKey, setDeniedKey] = useState<string | null>(null);
  const recoveryScope = JSON.stringify(request);
  const recovering =
    recoveredKey !== recoveryScope || deniedKey === recoveryScope;
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [run, setRun] = useState<SourceConversionRun | null>(null);
  const [runScope, setRunScope] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const invalidated = useRef(onScopeInvalidated);
  useEffect((): void => {
    invalidated.current = onScopeInvalidated;
  }, [onScopeInvalidated]);
  /** 일치하는 수명에서만 결과를 표시하고 권한 오류는 상위 선택을 무효화합니다. */
  const apply = useCallback(
    (result: SourceConversionResult, expected: number): void => {
      if (generation.current !== expected) return;
      if (result.ok) {
        setDeniedKey(null);
        setRunScope(recoveryScope);
        if (result.data) {
          setRun(result.data);
          const snapshot = JSON.stringify(result.data);
          if (hydrated.current && lastSaved.current !== snapshot) {
            lastSaved.current = snapshot;
            void recovery.save(result.data).then(
              (): void => {
                if (generation.current === expected)
                  setRecoveryNotice('변환 보고의 종료 후 보호 복구 저장 완료');
              },
              (reason: unknown): void => {
                if (generation.current === expected)
                  setRecoveryNotice(
                    reason instanceof Error
                      ? reason.message
                      : '변환 복구 저장 실패',
                  );
              },
            );
          }
        } else if (recovered.current) {
          setRun({
            ...recovered.current,
            state: 'report_unconfirmed',
            receiptState: 'unconfirmed',
            reference: null,
            message:
              '종료 전 로컬 보고를 복원했습니다. 서버 저장 여부를 확인하기 전에는 계획·질문에 전달하지 않습니다.',
          });
          setRecoveryNotice(
            '보관된 로컬 보고 · 서버 최신 저장 기록은 아직 확인되지 않았습니다.',
          );
        } else setRun(null);
        setError(null);
      } else {
        setError(result.error.message);
        if (
          result.error.status === 401 ||
          result.error.status === 403 ||
          ['scope_changed', 'connection_changed', 'access_changed'].includes(
            result.error.code,
          )
        ) {
          // 접근 거부는 본문을 숨기되 원래 범위의 보호 복구 사본을 삭제하지 않습니다.
          setDeniedKey(recoveryScope);
          invalidated.current();
        }
      }
    },
    [recovery, recoveryScope],
  );
  /** 한 번에 한 조회/명령만 보내고 현재 결과는 오류 때도 보존합니다. */
  const refresh = useCallback(async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const current = generation.current;
    try {
      if (!hydrated.current) {
        try {
          const restored = await recovery.load();
          if (generation.current !== current) return;
          recovered.current = restored;
        } catch (reason: unknown) {
          if (generation.current === current)
            setRecoveryNotice(
              reason instanceof Error ? reason.message : '변환 복구 조회 실패',
            );
        }
        if (generation.current !== current) return;
        hydrated.current = true;
      }
      apply(await readSourceConversion(request), current);
    } finally {
      if (current === generation.current) {
        // 초기 GET과 결과 적용이 끝난 뒤에만 내부 잠금과 화면 잠금을 함께 해제합니다.
        pending.current = false;
        setBusy(false);
        if (hydrated.current) setRecoveredKey(recoveryScope);
      }
    }
  }, [request, apply, recovery, recoveryScope]);
  useEffect((): (() => void) => {
    generation.current += 1;
    pending.current = false;
    hydrated.current = false;
    recovered.current = null;
    lastSaved.current = '';
    void refresh();
    return (): void => {
      generation.current += 1;
      pending.current = false;
    };
  }, [refresh]);
  const visibleRun = recovering || runScope !== recoveryScope ? null : run;
  const active =
    visibleRun?.state === 'running' ||
    visibleRun?.state === 'cancelling' ||
    visibleRun?.receiptState === 'pending';
  useEffect((): (() => void) | undefined => {
    if (!active) return;
    const timer = setInterval((): void => {
      void refresh();
    }, 1000);
    return (): void => clearInterval(timer);
  }, [active, refresh]);
  /** 실행 버튼만 새 요청을 생성하며 폴링/화면 진입에서는 호출하지 않습니다. */
  const start = async (options: ConversionOptions): Promise<void> => {
    if (pending.current || recovering) return;
    pending.current = true;
    setBusy(true);
    const current = generation.current;
    try {
      apply(await startSourceConversion({ ...request, ...options }), current);
    } finally {
      if (current === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  /** 화면을 닫는 동작과 로컬 실행 취소를 구별합니다. */
  const cancel = async (): Promise<void> => {
    if (!visibleRun || pending.current || recovering) return;
    pending.current = true;
    setBusy(true);
    const current = generation.current;
    try {
      apply(
        await cancelSourceConversion({
          ...request,
          requestId: visibleRun.requestId,
        }),
        current,
      );
    } finally {
      if (current === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return {
    run: visibleRun,
    busy,
    error,
    start,
    refresh,
    cancel,
    recoveryNotice,
    recovering,
  };
}

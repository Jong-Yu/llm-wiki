import { z } from 'zod';
import { createRecoverySlot } from '@renderer/platform/recovery';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  QuestionSession,
  QuestionDetail,
  QuestionError,
  QuestionPage,
  QuestionDetailResult,
  QuestionPageResult,
} from '@contracts/questionRuns.contract';
import { questionRunsApi, requestQuestion } from '../api/questionRuns.api';
import type { StoredQuestion } from './questionRun';
import { hasUnconfirmedQuestionAnswer } from './questionRun';

// 화면을 닫아도 미확인 접수 요청을 같은 범위의 새 요청으로 덮어쓰지 않습니다.
const pendingQuestions = new Map<string, string>();
const selectedQuestions = new Map<string, string>();
const notifiedQuestionAnswers = new Set<string>();

const recoverySchema = z.strictObject({
  pendingCreation: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
  selectedRun: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
  conversationRevision: z.string().nullable(),
});
type QuestionRecovery = z.infer<typeof recoverySchema>;

type QuestionModel = {
  recoveryNotice: string;
  recovering: boolean;
  detail: QuestionDetail | null;
  page: QuestionPage | null;
  busy: boolean;
  error: QuestionError | null;
  pendingCreation: string | null;
  invalidScope: boolean;
  refresh: () => Promise<void>;
  select: (id: string) => Promise<void>;
  loadMore: () => Promise<void>;
  createAndStart: () => Promise<void>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  confirmCreation: () => Promise<void>;
};
/** 질문 실행별 상태를 보관하며 조회/재방문에서 AI를 자동 실행하지 않습니다. */
export function useQuestionRun(
  session: QuestionSession,
  question: StoredQuestion | undefined,
  initialRunId: string | undefined,
  onChanged: (() => void) | undefined,
): QuestionModel {
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [recoveredKey, setRecoveredKey] = useState('');
  const mounted = useRef(true);
  const recoveryKey = question
    ? `question-${question.conversationId}-${question.questionTurnId}`
    : `run-${initialRunId || 'workspace'}`;
  const recoveryScope = JSON.stringify([session, recoveryKey]);
  const recovering = recoveredKey !== recoveryScope;
  const recovery = useMemo(
    (): ReturnType<typeof createRecoverySlot<QuestionRecovery>> =>
      createRecoverySlot(
        { connectionId: session.connectionId, ...session.expectedScope },
        'question-runs',
        recoveryKey,
        (value: unknown): QuestionRecovery => recoverySchema.parse(value),
      ),
    [session, recoveryKey],
  );
  const recoveryValue = useRef<QuestionRecovery>({
    pendingCreation: null,
    selectedRun: initialRunId ?? null,
    conversationRevision: question?.conversationRevision ?? null,
  });
  /** 복구 실패는 생성 결과와 별도로 표시하며 요청을 재전송하지 않습니다. */
  function preserveRecovery(): void {
    void recovery.save(recoveryValue.current).catch((reason: unknown): void => {
      if (mounted.current)
        setRecoveryNotice(
          reason instanceof Error ? reason.message : '질문 복구 저장 실패',
        );
    });
  }
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [page, setPage] = useState<QuestionPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<QuestionError | null>(null);
  const creationKey = JSON.stringify([
    session,
    question?.conversationId,
    question?.questionTurnId,
  ]);
  const [rememberedRun] = useState<string | undefined>((): string | undefined =>
    selectedQuestions.get(creationKey),
  );
  const requestedRunId = initialRunId ?? rememberedRun;
  const [pendingCreation, setPendingCreationState] = useState<string | null>(
    (): string | null => pendingQuestions.get(creationKey) ?? null,
  );
  /** 접수 결과 미확인을 화면 수명과 분리해 같은 request ID로 복구합니다. */
  function setPendingCreation(value: string | null): void {
    if (value) pendingQuestions.set(creationKey, value);
    else pendingQuestions.delete(creationKey);
    setPendingCreationState(value);
    recoveryValue.current = {
      ...recoveryValue.current,
      pendingCreation: value,
    };
    preserveRecovery();
  }
  const [invalidScope, setInvalidScope] = useState(false);
  const inFlight = useRef(false);
  const reads = useRef(0);
  const activeId = useRef(requestedRunId);
  const changeCallback = useRef(onChanged);

  // 부모는 연결·관점별로 key를 나누며 이전 비동기 결과는 새 범위에 표시하지 않습니다.
  const scopeKey = JSON.stringify(session);
  const scope = useRef(scopeKey);
  useEffect((): void => {
    scope.current = scopeKey;
    changeCallback.current = onChanged;
  }, [scopeKey, onChanged]);

  /** 권한 회수 시 이전 본문을 숨기고 통신 실패 시 진행 상태를 보존합니다. */
  const accept = useCallback(
    (result: QuestionDetailResult, expectedScope: string): void => {
      if (!mounted.current || scope.current !== expectedScope) return;
      if (!result.ok) {
        setError(result.error);
        if (
          [
            'scope_changed',
            'connection_changed',
            'forbidden',
            'unauthorized',
            'access_changed',
            'superseded',
          ].includes(result.error.code)
        ) {
          setInvalidScope(true);
          setDetail(null);
          setPage(null);
        }
        return;
      }
      setDetail(result.data);
      setError(null);
      const noticeKey = `${expectedScope}:${result.data.id}`;
      if (
        result.data.answers.length &&
        !notifiedQuestionAnswers.has(noticeKey)
      ) {
        notifiedQuestionAnswers.add(noticeKey);
        changeCallback.current?.();
      }
    },
    [],
  );

  /** 마지막으로 선택한 실행만 표시하며 늦은 상세 응답으로 선택을 되돌리지 않습니다. */
  const select = useCallback(
    async (id: string): Promise<void> => {
      activeId.current = id;
      selectedQuestions.set(creationKey, id);
      recoveryValue.current = { ...recoveryValue.current, selectedRun: id };
      void recovery
        .save(recoveryValue.current)
        .catch((reason: unknown): void => {
          if (mounted.current)
            setRecoveryNotice(
              reason instanceof Error ? reason.message : '질문 복구 저장 실패',
            );
        });
      const serial = ++reads.current;
      const result = await requestQuestion((): Promise<QuestionDetailResult> =>
        questionRunsApi.read({ ...session, questionRunId: id }),
      );
      if (serial === reads.current) accept(result, scopeKey);
    },
    [accept, creationKey, scopeKey, session, recovery],
  );

  /** 목록의 부분 조회 상태를 보존하며 다음 페이지는 명시 동작으로 추가합니다. */
  const loadPage = useCallback(
    async (cursor: string | null): Promise<void> => {
      const result = await requestQuestion(
        (): ReturnType<typeof questionRunsApi.list> =>
          questionRunsApi.list({ ...session, cursor }),
      );
      if (!mounted.current || scope.current !== scopeKey) return;
      if (!result.ok) {
        accept(result, scopeKey);
        return;
      }
      setPage((previous: QuestionPage | null): QuestionPage => ({
        ...result.data,
        items:
          cursor && previous
            ? [...previous.items, ...result.data.items]
            : result.data.items,
      }));
    },
    [accept, scopeKey, session],
  );

  useEffect((): (() => void) => {
    mounted.current = true;
    void requestQuestion((): Promise<QuestionPageResult> =>
      questionRunsApi.list({ ...session, cursor: null }),
    ).then((result: QuestionPageResult): void => {
      if (!mounted.current || scope.current !== scopeKey) return;
      if (result.ok) setPage(result.data);
      else accept(result, scopeKey);
    });
    if (requestedRunId) {
      const serial = ++reads.current;
      void requestQuestion((): Promise<QuestionDetailResult> =>
        questionRunsApi.read({ ...session, questionRunId: requestedRunId }),
      ).then((result: QuestionDetailResult): void => {
        if (serial === reads.current) accept(result, scopeKey);
      });
    }
    return (): void => {
      mounted.current = false;
      reads.current += 1;
    };
  }, [requestedRunId, session, scopeKey, accept]);

  const refresh = useCallback(async (): Promise<void> => {
    if (activeId.current) await select(activeId.current);
    else await loadPage(null);
  }, [loadPage, select]);
  useEffect((): (() => void) => {
    let valid = true;
    void recovery
      .load()
      .then(async (value: QuestionRecovery | null): Promise<void> => {
        if (!valid) return;
        if (value) {
          recoveryValue.current = value;
          setPendingCreationState(value.pendingCreation);
          if (value.pendingCreation)
            pendingQuestions.set(creationKey, value.pendingCreation);
          setRecoveryNotice(
            '종료 전 요청을 복원했습니다. 접수 영수증과 서버 기록만 다시 조회합니다.',
          );
          if (
            value.conversationRevision &&
            question?.conversationRevision &&
            value.conversationRevision !== question.conversationRevision
          )
            setRecoveryNotice(
              '질문 기준 revision이 변경되었습니다. 기존 요청은 영수증으로 확인하세요.',
            );
          if (value.selectedRun && !initialRunId)
            await select(value.selectedRun);
        }
      })
      .catch((reason: unknown): void => {
        if (valid)
          setRecoveryNotice(
            reason instanceof Error ? reason.message : '질문 복구 조회 실패',
          );
      })
      .finally((): void => {
        if (valid) setRecoveredKey(recoveryScope);
      });
    return (): void => {
      valid = false;
      reads.current += 1;
    };
  }, [
    recovery,
    recoveryScope,
    creationKey,
    question?.conversationRevision,
    initialRunId,
    select,
  ]);
  useEffect((): (() => void) | undefined => {
    if (!detail || invalidScope) return;
    const shouldPoll =
      detail.local.status === 'running' ||
      detail.local.status === 'stopping' ||
      (detail.status === 'running' && detail.leaseStatus === 'active');
    if (!shouldPoll) return;
    const timer = setTimeout((): void => {
      if (!inFlight.current) void refresh();
    }, 1000);
    return (): void => clearTimeout(timer);
  }, [detail, invalidScope, refresh]);

  /** 연속 클릭을 즉시 잠그며 결과 미확인 때 자동 재시도하지 않습니다. */
  async function mutate(
    operation: () => Promise<QuestionDetailResult>,
  ): Promise<QuestionDetailResult | null> {
    if (inFlight.current || invalidScope || recovering) return null;
    inFlight.current = true;
    setBusy(true);
    reads.current += 1;
    const result = await requestQuestion(operation);
    accept(result, scopeKey);
    inFlight.current = false;
    if (mounted.current && scope.current === scopeKey) setBusy(false);
    return result;
  }
  /** 같은 저장 질문을 접수하고 이번 명시 동작에서만 실행을 시작합니다. */
  async function createAndStart(): Promise<void> {
    if (
      !question ||
      pendingCreation ||
      inFlight.current ||
      (detail && hasUnconfirmedQuestionAnswer(detail))
    )
      return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    setPendingCreation(requestId);
    try {
      await recovery.save(recoveryValue.current);
    } catch (reason: unknown) {
      setPendingCreation(null);
      setRecoveryNotice(
        reason instanceof Error
          ? reason.message
          : '복구 저장 실패로 질문을 접수하지 않았습니다.',
      );
      return;
    }
    const created = await mutate((): Promise<QuestionDetailResult> =>
      questionRunsApi.create({ ...session, ...question, requestId }),
    );
    if (!created?.ok) {
      if (
        created &&
        created.error.status &&
        created.error.status >= 400 &&
        created.error.status < 500 &&
        created.error.code !== 'invalid_response'
      )
        setPendingCreation(null);
      return;
    }
    setPendingCreation(null);
    activeId.current = created.data.id;
    selectedQuestions.set(creationKey, created.data.id);
    recoveryValue.current = {
      ...recoveryValue.current,
      selectedRun: created.data.id,
    };
    preserveRecovery();
    await mutate((): Promise<QuestionDetailResult> =>
      questionRunsApi.start({
        ...session,
        questionRunId: created.data.id,
        expectedStateRevision: created.data.stateRevision,
        reclaim: false,
      }),
    );
    void loadPage(null);
  }
  /** 접수 응답 유실은 동일 요청 ID의 조회로 확인하며 AI를 자동 재실행하지 않습니다. */
  async function confirmCreation(): Promise<void> {
    if (!pendingCreation) return;
    const result = await mutate((): Promise<QuestionDetailResult> =>
      questionRunsApi.creationReceipt({
        ...session,
        requestId: pendingCreation,
      }),
    );
    if (result?.ok) {
      setPendingCreation(null);
      activeId.current = result.data.id;
      selectedQuestions.set(creationKey, result.data.id);
      recoveryValue.current = {
        ...recoveryValue.current,
        selectedRun: result.data.id,
      };
      preserveRecovery();
    }
  }
  /** 재개를 화면의 상태 판본과 만료된 사용권에 명시적으로 연결합니다. */
  async function start(): Promise<void> {
    if (!detail) return;
    await mutate((): Promise<QuestionDetailResult> =>
      questionRunsApi.start({
        ...session,
        questionRunId: detail.id,
        expectedStateRevision: detail.stateRevision,
        reclaim:
          detail.status === 'running' && detail.leaseStatus === 'expired',
      }),
    );
  }
  /** 취소 충돌을 표시하며 서버 성공과 로컬 중단을 구분합니다. */
  async function cancel(): Promise<void> {
    if (!detail) return;
    await mutate((): Promise<QuestionDetailResult> =>
      questionRunsApi.cancel({
        ...session,
        questionRunId: detail.id,
        expectedStateRevision: detail.stateRevision,
        requestId: crypto.randomUUID().replaceAll('-', ''),
      }),
    );
  }
  /** 페이지를 여는 동작만으로 새 질문을 만들지 않습니다. */
  async function loadMore(): Promise<void> {
    if (page?.nextCursor) await loadPage(page.nextCursor);
  }
  /** 선택 변경 중에는 이전 실행 버튼을 노출하지 않습니다. */
  async function choose(id: string): Promise<void> {
    if (inFlight.current) return;
    setDetail(null);
    await select(id);
  }
  return {
    recoveryNotice,
    recovering,
    detail,
    page,
    busy,
    error,
    pendingCreation,
    invalidScope,
    refresh,
    select: choose,
    loadMore,
    createAndStart,
    start,
    cancel,
    confirmCreation,
  };
}

import { useEffect, useRef, useState } from 'react';
import {
  conversionBody,
  conversionMatches,
  createAnalysisPlan,
  createConversion,
  handoffAnalysisPlan,
  handoffComplete,
  loadPlanCatalog,
  planBody,
  planMatchesSource,
  readAnalysisPlan,
  readAnalysisPlanReceipt,
  readConversion,
  selectPlanningSource,
  validateAnalysisPlan,
} from '../api/analysisPlan.api';
import type {
  Catalog,
  CreateConversionBody,
  CreatePlanBody,
  PlanError,
  PlanHandoff,
  PlanningSource,
  PlanRecord,
  PlanRecovery,
  PlanResult,
  PlanScope,
  PlanValidation,
} from '../api/analysisPlan.api';
import type {
  ConversionFields,
  LocationFields,
  PlanFields,
} from './analysisPlan.schema';
import type { DocumentListItem } from '@contracts/documents.contract';

type CatalogState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: Catalog };
type SourceState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; source: PlanningSource }
  | { status: 'error'; message: string };
export type PlanCatalogModel = {
  state: CatalogState;
  source: SourceState;
  items: DocumentListItem[];
  refresh: () => void;
  more: () => void;
  select: (item: DocumentListItem) => void;
};
type InitialSelection = {
  sourceId?: string;
  sourceVersion?: string;
  document?: string;
};

/** 실제 목록·선택 수명을 분리하고 새 범위로 넘어갈 때 이전 본문을 숨깁니다. */
export function usePlanCatalog(
  initialSelection: InitialSelection,
): PlanCatalogModel {
  const initial = useRef(initialSelection);
  const [state, setState] = useState<CatalogState>({ status: 'loading' });
  const [source, setSource] = useState<SourceState>({ status: 'idle' });
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const mounted = useRef(false);
  /** 현재 목록에서 찾은 실제 항목으로만 출처 기준을 조회합니다. */
  async function choose(
    scope: PlanScope,
    item: DocumentListItem,
  ): Promise<void> {
    const request = ++selectionGeneration.current;
    setSource({ status: 'loading' });
    const result = await selectPlanningSource(scope, item);
    if (!mounted.current || request !== selectionGeneration.current) return;
    setSource(
      result.ok
        ? { status: 'ready', source: result.data }
        : { status: 'error', message: result.error.message },
    );
  }
  /** cursor가 없는 재조회만 입력 범위를 다시 확인하며 초기 query도 실제 목록과 대조합니다. */
  async function load(
    cursor: string | null,
    expected?: Catalog,
  ): Promise<void> {
    const request = ++generation.current;
    if (!cursor) {
      selectionGeneration.current += 1;
      setSource({ status: 'idle' });
      setState({ status: 'loading' });
      setItems([]);
    }
    const result = await loadPlanCatalog(cursor, expected?.scope);
    if (!mounted.current || request !== generation.current) return;
    if (!result.ok) {
      setState({ status: 'error', message: result.error.message });
      return;
    }
    const nextItems = cursor
      ? [...items, ...result.data.page.items]
      : result.data.page.items;
    setItems(nextItems);
    setState({ status: 'ready', catalog: result.data });
    if (!cursor) {
      const selection = initial.current;
      const selected = nextItems.find((item: DocumentListItem): boolean =>
        item.kind === 'source'
          ? item.sourceId === selection.sourceId
          : item.document === selection.document,
      );
      if (
        selected?.kind === 'source' &&
        selection.sourceVersion &&
        selected.sourceVersion !== selection.sourceVersion
      ) {
        setSource({
          status: 'error',
          message:
            '이동할 때 선택한 원본 판본과 현재 판본이 다릅니다. 왼쪽에서 현재 원본을 명시 선택해 주세요.',
        });
      } else if (selected) void choose(result.data.scope, selected);
    }
  }
  useEffect((): (() => void) => {
    mounted.current = true;
    const request = ++generation.current;
    void loadPlanCatalog(null).then((result: PlanResult<Catalog>): void => {
      if (!mounted.current || request !== generation.current) return;
      if (!result.ok) {
        setState({ status: 'error', message: result.error.message });
        return;
      }
      setItems(result.data.page.items);
      setState({ status: 'ready', catalog: result.data });
      const selection = initial.current;
      const selected = result.data.page.items.find(
        (item: DocumentListItem): boolean =>
          item.kind === 'source'
            ? item.sourceId === selection.sourceId
            : item.document === selection.document,
      );
      if (!selected) return;
      if (
        selected.kind === 'source' &&
        selection.sourceVersion &&
        selected.sourceVersion !== selection.sourceVersion
      ) {
        setSource({
          status: 'error',
          message:
            '이동할 때 선택한 원본 판본과 현재 판본이 다릅니다. 왼쪽에서 현재 원본을 명시 선택해 주세요.',
        });
        return;
      }
      const selectedRequest = ++selectionGeneration.current;
      setSource({ status: 'loading' });
      void selectPlanningSource(result.data.scope, selected).then(
        (value: PlanResult<PlanningSource>): void => {
          if (
            !mounted.current ||
            selectedRequest !== selectionGeneration.current
          )
            return;
          setSource(
            value.ok
              ? { status: 'ready', source: value.data }
              : { status: 'error', message: value.error.message },
          );
        },
      );
    });
    return (): void => {
      mounted.current = false;
      generation.current += 1;
      selectionGeneration.current += 1;
    };
  }, []);
  /** 현재 연결의 첫 자료 페이지를 다시 확인합니다. */
  function refresh(): void {
    void load(null);
  }
  /** 다음 cursor가 실제 있을 때만 추가 자료를 읽습니다. */
  function more(): void {
    if (
      state.status === 'ready' &&
      state.catalog.page.nextCursor &&
      !state.catalog.page.requiresRefresh
    )
      void load(state.catalog.page.nextCursor, state.catalog);
  }
  /** 선택은 분석·등록을 시작하지 않는 읽기 동작입니다. */
  function select(item: DocumentListItem): void {
    if (state.status === 'ready') void choose(state.catalog.scope, item);
  }
  return { state, source, items, refresh, more, select };
}

type PendingPlanOperation = {
  kind: 'conversion' | 'plan' | 'handoff';
  requestId: string;
  body: CreatePlanBody | CreateConversionBody | null;
  recovery: PlanRecovery | null;
  status: 'sending' | 'unknown' | 'pending';
};
export type PlanningSession = {
  conversion: PlanRecord | null;
  plan: PlanRecord | null;
  validation: PlanValidation | null;
  handoff: PlanHandoff | null;
  pending: PendingPlanOperation | null;
  previousPlans: PlanRecord[];
  message: string;
  invalid: boolean;
  busy: boolean;
};
export type PlanAnalysisModel = PlanningSession & {
  createPlan: (fields: PlanFields) => void;
  createReport: (fields: ConversionFields) => void;
  readPlan: (id: string) => void;
  readReport: (id: string) => void;
  validate: () => void;
  handoffPlan: () => void;
  recover: () => void;
  newDraft: () => void;
  invalidate: () => void;
};
const sessions = new Map<string, PlanningSession>();
const sourceRequests = new Map<
  string,
  { pending: PendingPlanOperation; plan: PlanRecord | null }
>();
export const planDrafts = new Map<string, PlanFields>();
export const conversionDrafts = new Map<string, ConversionFields>();

/** 출처 판본과 scope를 바꿔 저장 기준을 교체하지 않고 각각의 초안을 분리합니다. */
export function planningKey(source: PlanningSource): string {
  return JSON.stringify([source.scope, source.sourceRef, source.wikiRef]);
}

/** 같은 출처의 미확인 요청은 관점·정책·현재 판본 변경으로 잠금을 우회하지 않습니다. */
function sourceRequestKey(source: PlanningSource): string {
  return JSON.stringify([
    source.scope.connectionId,
    source.scope.userId,
    source.scope.tenant,
    source.item.kind,
    source.item.kind === 'source' ? source.item.sourceId : source.item.document,
  ]);
}
/** 미확인 결과는 재열기 후에도 잠긴 상태로 보존합니다. */
function initialSession(key: string, source: PlanningSource): PlanningSession {
  const saved = sessions.get(key);
  const pending = sourceRequests.get(sourceRequestKey(source));
  if (saved)
    return {
      ...saved,
      busy: false,
      ...(pending ? { pending: pending.pending, plan: pending.plan } : {}),
    };
  return {
    conversion: null,
    plan: pending?.plan ?? null,
    validation: null,
    handoff: null,
    pending: pending?.pending ?? null,
    previousPlans: [],
    message: '',
    invalid: false,
    busy: false,
  };
}

/** 고정 계획의 생성·검증·인계와 GET 수신 확인을 서로 다른 명시 동작으로 유지합니다. */
export function usePlanAnalysis(
  source: PlanningSource,
  canWrite: boolean,
): PlanAnalysisModel {
  const key = planningKey(source);
  const [state, setState] = useState<PlanningSession>((): PlanningSession =>
    initialSession(key, source),
  );
  const stateRef = useRef(state);
  const mounted = useRef(false);
  const busy = useRef(false);
  useEffect((): (() => void) => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  /** unmount 뒤 완료도 원래 세션에만 남겨 다시 POST하는 경로를 열지 않습니다. */
  function update(patch: Partial<PlanningSession>): void {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    sessions.set(key, next);
    if (next.pending)
      sourceRequests.set(sourceRequestKey(source), {
        pending: next.pending,
        plan: next.plan,
      });
    else sourceRequests.delete(sourceRequestKey(source));
    if (mounted.current) setState(next);
  }
  /** 권한·정책 변경 후에는 초안을 남기고 예전 출처와 저장 동작을 숨깁니다. */
  function failed(error: PlanError): void {
    update({
      message: error.message,
      invalid:
        error.code === 'scope_changed' ||
        error.status === 401 ||
        error.status === 403,
    });
  }
  /** 확인되지 않은 전송은 GET 복구 참조만 보존하고 자동 재전송하지 않습니다. */
  function mutationFailed(
    error: PlanError,
    pending: PendingPlanOperation,
  ): void {
    const unknown =
      pending.kind === 'handoff' ||
      error.code === 'outcome_unknown' ||
      error.code === 'scope_changed' ||
      (error.status !== undefined && error.status >= 500);
    update({
      pending: unknown
        ? {
            ...pending,
            status: 'unknown',
            recovery: error.recovery ?? pending.recovery,
          }
        : null,
      busy: false,
      message: error.message,
      invalid:
        error.code === 'scope_changed' ||
        error.status === 401 ||
        error.status === 403,
    });
  }
  /** 현재 세션과 실제 원래 요청의 공개 기록인지 확인합니다. */
  function validRecord(
    record: PlanRecord,
    kind: 'plans' | 'conversions',
    requestId?: string,
  ): boolean {
    return (
      record.manifest.kind === kind &&
      record.manifest.tenant === source.scope.tenant &&
      record.manifest.user_id === source.scope.userId &&
      (requestId === undefined || record.manifest.request_id === requestId)
    );
  }
  /** 새 쓰기는 같은 세션의 미확인 전송·기존 계획과 겹치지 않습니다. */
  function writable(): boolean {
    return (
      canWrite &&
      !busy.current &&
      !stateRef.current.invalid &&
      !stateRef.current.pending
    );
  }
  /** 실제 출처 형식과 보고·선택 단위의 호환을 먼저 확인합니다. */
  function compatible(fields: PlanFields): boolean {
    const converted = stateRef.current.conversion;
    const binary =
      source.item.kind === 'source' &&
      source.item.format !== 'md' &&
      source.item.format !== 'txt';
    if (
      fields.locations.some((range: LocationFields): boolean =>
        ['pages', 'cells', 'blocks', 'paragraphs', 'table_cells'].includes(
          range.kind,
        ),
      ) &&
      (!converted || !conversionMatches(converted, source))
    ) {
      update({
        message:
          '변환 원본의 위치 범위는 같은 원본 판본의 실제 변환 보고를 먼저 연결해야 합니다.',
      });
      return false;
    }
    if (binary && !converted) {
      update({
        message:
          '바이너리 원본의 변환 보고가 없어 서버가 준비 미완료 계획으로 보존합니다. 인계 전에는 변환 보고를 연결한 새 계획이 필요합니다.',
      });
    }
    return true;
  }
  /** 하나의 명시 요청으로 현재 입력을 불변 계획에 고정합니다. */
  async function savePlan(fields: PlanFields): Promise<void> {
    if (!writable() || stateRef.current.plan || !compatible(fields)) return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const body = planBody(
      source,
      fields,
      stateRef.current.conversion,
      requestId,
    );
    const pending: PendingPlanOperation = {
      kind: 'plan',
      requestId,
      body,
      recovery: null,
      status: 'sending',
    };
    busy.current = true;
    update({ busy: true, pending, message: '', validation: null });
    const result = await createAnalysisPlan(source.scope, body);
    busy.current = false;
    if (!result.ok) {
      mutationFailed(result.error, pending);
      return;
    }
    if (!validRecord(result.data, 'plans', requestId)) {
      mutationFailed(
        {
          code: 'outcome_unknown',
          message:
            '계획 응답이 원래 요청의 공개 기록과 일치하지 않습니다. 재전송하지 마세요.',
        },
        pending,
      );
      return;
    }
    update({
      busy: false,
      plan: result.data,
      pending: null,
      message:
        '계획을 보존했습니다. 현재 기준 검증과 작업 인계는 별도 동작입니다.',
    });
  }
  /** 원본 문자와 위치를 실제 외부 변환 보고로만 제출합니다. */
  async function saveReport(fields: ConversionFields): Promise<void> {
    if (!writable() || !source.sourceRef || stateRef.current.plan) return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const body = conversionBody(source.sourceRef, fields, requestId);
    const pending: PendingPlanOperation = {
      kind: 'conversion',
      requestId,
      body,
      recovery: null,
      status: 'sending',
    };
    busy.current = true;
    update({ busy: true, pending, message: '' });
    const result = await createConversion(source.scope, body);
    busy.current = false;
    if (!result.ok) {
      mutationFailed(result.error, pending);
      return;
    }
    if (
      !validRecord(result.data, 'conversions', requestId) ||
      !conversionMatches(result.data, source)
    ) {
      mutationFailed(
        {
          code: 'outcome_unknown',
          message:
            '변환 응답이 선택 원본·동일 요청과 일치하지 않습니다. 재전송하지 마세요.',
        },
        pending,
      );
      return;
    }
    update({
      busy: false,
      conversion: result.data,
      pending: null,
      message:
        '변환 보고를 보존했습니다. 보고된 문자의 의미 정확도·원본 전체 충실성 검증은 수행하지 않았습니다.',
    });
  }
  /** 실제 식별자로 저장된 계획·변환을 읽고 현재 원본 기준을 바꾸지 않습니다. */
  async function lookup(
    kind: 'plan' | 'conversion',
    id: string,
  ): Promise<void> {
    if (
      busy.current ||
      stateRef.current.pending ||
      (kind === 'conversion' && stateRef.current.plan)
    )
      return;
    busy.current = true;
    update({ busy: true, message: '' });
    const result =
      kind === 'plan'
        ? await readAnalysisPlan(source.scope, id)
        : await readConversion(source.scope, id);
    busy.current = false;
    update({ busy: false });
    if (!result.ok) {
      failed(result.error);
      return;
    }
    if (
      !validRecord(result.data, kind === 'plan' ? 'plans' : 'conversions') ||
      (kind === 'plan' && !planMatchesSource(result.data, source)) ||
      (kind === 'conversion' && !conversionMatches(result.data, source))
    ) {
      update({
        message:
          '조회 기록이 현재 선택 원본의 같은 판본 또는 소유 범위와 일치하지 않아 연결하지 않았습니다.',
      });
      return;
    }
    if (kind === 'plan')
      update({
        plan: result.data,
        validation: null,
        handoff: null,
        message:
          '저장된 계획의 당시 입력을 읽었습니다. 현재 기준은 별도 검증해야 합니다.',
      });
    else
      update({
        conversion: result.data,
        message: '동일 원본 판본의 실제 변환 보고를 연결했습니다.',
      });
  }
  /** 서버 검증이 성공해도 새 작업이나 개인 AI 실행을 시작하지 않습니다. */
  async function check(): Promise<void> {
    const plan = stateRef.current.plan;
    if (
      !plan ||
      busy.current ||
      stateRef.current.pending ||
      stateRef.current.invalid
    )
      return;
    busy.current = true;
    update({ busy: true, validation: null, message: '' });
    const result = await validateAnalysisPlan(source.scope, plan);
    busy.current = false;
    update({ busy: false });
    if (!result.ok) {
      failed(result.error);
      return;
    }
    if (
      result.data.plan_id !== plan.manifest.id ||
      result.data.plan_revision !== plan.revision
    ) {
      update({
        message:
          '검증 결과가 현재 고정 계획과 일치하지 않아 인계를 허용하지 않았습니다.',
      });
      return;
    }
    update({
      validation: result.data,
      message:
        '서버가 현재 원본·문맥·관점 기준을 검증했습니다. AI 실행은 시작되지 않았습니다.',
    });
  }
  /** 검증한 계획을 기존 작업으로 인계하며 같은 요청을 두 번 보내지 않습니다. */
  async function transfer(): Promise<void> {
    const plan = stateRef.current.plan;
    if (
      !writable() ||
      !plan ||
      !stateRef.current.validation?.ready ||
      stateRef.current.handoff
    )
      return;
    const requestId = crypto.randomUUID().replaceAll('-', '');
    const pending: PendingPlanOperation = {
      kind: 'handoff',
      requestId,
      body: null,
      recovery: {
        operation: 'analysisPlanReceipt',
        input: { plan_id: plan.manifest.id, request_id: requestId },
      },
      status: 'sending',
    };
    busy.current = true;
    update({ busy: true, pending, message: '' });
    const result = await handoffAnalysisPlan(source.scope, plan, requestId);
    busy.current = false;
    if (!result.ok) {
      mutationFailed(result.error, pending);
      return;
    }
    if (
      result.data.handoff_id !== requestId ||
      result.data.plan_id !== plan.manifest.id ||
      result.data.plan_revision !== plan.revision
    ) {
      mutationFailed(
        {
          code: 'outcome_unknown',
          message:
            '인계 결과가 원래 요청과 일치하지 않아 성공을 확정하지 못했습니다.',
        },
        pending,
      );
      return;
    }
    update({
      busy: false,
      handoff: result.data,
      pending: handoffComplete(result.data, plan)
        ? null
        : { ...pending, status: 'pending' },
      message: handoffComplete(result.data, plan)
        ? '문서별 분석 작업을 접수했습니다. 개인 AI 실행은 시작되지 않았습니다.'
        : '인계 중 일부만 확인되었습니다. 같은 요청 영수증을 조회하며 인계를 다시 실행하지 않습니다.',
    });
  }
  /** main이 보존한 고정 GET 참조만 조회하며 POST를 재실행하지 않습니다. */
  async function reconcile(): Promise<void> {
    const pending = stateRef.current.pending;
    if (busy.current || !pending?.recovery) return;
    const recovery = pending.recovery;
    busy.current = true;
    update({ busy: true, message: '' });
    if (recovery.operation === 'analysisPlanReceipt') {
      const result = await readAnalysisPlanReceipt(
        source.scope,
        recovery.input.plan_id,
        recovery.input.request_id,
      );
      busy.current = false;
      update({ busy: false });
      if (!result.ok) {
        failed(result.error);
        return;
      }
      if (
        result.data.handoff_id !== pending.requestId ||
        result.data.plan_id !== recovery.input.plan_id ||
        result.data.plan_revision !== stateRef.current.plan?.revision
      ) {
        update({
          message:
            '원래 인계와 영수증이 일치하지 않아 미확인 잠금을 유지합니다.',
        });
        return;
      }
      const complete = handoffComplete(result.data, stateRef.current.plan);
      update({
        handoff: result.data,
        pending: complete ? null : { ...pending, status: 'pending' },
        message: complete
          ? '동일 인계 요청의 접수 영수증을 확인했습니다. 개인 AI 실행은 시작되지 않았습니다.'
          : '같은 요청의 일부 작업이 아직 확인되지 않았습니다. 재전송 없이 확인 상태를 유지합니다.',
      });
      return;
    }
    const result: PlanResult<PlanRecord> =
      recovery.operation === 'conversion'
        ? await readConversion(source.scope, recovery.input.conversion_id)
        : await readAnalysisPlan(source.scope, recovery.input.plan_id);
    busy.current = false;
    update({ busy: false });
    if (!result.ok) {
      failed(result.error);
      return;
    }
    const kind = pending.kind === 'conversion' ? 'conversions' : 'plans';
    const originalRef = pending.body?.source_ref;
    const originalSource = originalRef
      ? { ...source, sourceRef: originalRef }
      : source;
    if (
      !validRecord(result.data, kind, pending.requestId) ||
      (kind === 'conversions' &&
        !conversionMatches(result.data, originalSource)) ||
      (kind === 'plans' && !planMatchesSource(result.data, source))
    ) {
      update({
        message:
          'GET 기록과 원래 요청이 일치하지 않아 미확인 잠금을 유지합니다.',
      });
      return;
    }
    if (kind === 'conversions' && !conversionMatches(result.data, source)) {
      update({
        pending: null,
        previousPlans: [...stateRef.current.previousPlans, result.data],
        message: `원래 변환 요청의 저장 기록 ${result.data.manifest.id}를 확인했습니다. 현재 원본 판본이 달라 새 계획에는 연결하지 않았습니다.`,
      });
      return;
    }
    update({
      pending: null,
      ...(kind === 'conversions'
        ? { conversion: result.data }
        : { plan: result.data }),
      message:
        '원래 요청의 실제 공개 기록을 GET으로 확인했습니다. 재전송하지 않았습니다.',
    });
  }
  /** 기존 기록은 서버와 이전 계획 목록에 남기고 명시적으로 새 초안을 엽니다. */
  function newDraft(): void {
    if (busy.current || stateRef.current.pending || stateRef.current.invalid)
      return;
    const plan = stateRef.current.plan;
    update({
      plan: null,
      validation: null,
      handoff: null,
      previousPlans: plan
        ? [...stateRef.current.previousPlans, plan]
        : stateRef.current.previousPlans,
      message: '이전 계획을 보존하고 새 계획 초안을 열었습니다.',
    });
  }
  /** 폼 검증 뒤에만 계획 생성을 실행합니다. */
  function createPlan(fields: PlanFields): void {
    void savePlan(fields);
  }
  /** 폼 검증 뒤에만 외부 변환 보고를 기록합니다. */
  function createReport(fields: ConversionFields): void {
    void saveReport(fields);
  }
  /** 저장된 실제 계획 ID를 조회합니다. */
  function readPlan(id: string): void {
    void lookup('plan', id);
  }
  /** 저장된 실제 변환 ID를 조회합니다. */
  function readReport(id: string): void {
    void lookup('conversion', id);
  }
  /** 현재 고정 계획의 검증만 요청합니다. */
  function validate(): void {
    void check();
  }
  /** 별도 사용자 동작에서 작업 인계를 요청합니다. */
  function handoffPlan(): void {
    void transfer();
  }
  /** 동일 요청의 GET 조회만 실행합니다. */
  function recover(): void {
    void reconcile();
  }
  /** 변환 도중 접근 범위가 바뀌면 기존 초안을 보존하고 쓰기를 잠급니다. */
  function invalidate(): void {
    failed({
      code: 'scope_changed',
      message:
        '변환 도중 연결·관점이 변경되었습니다. 현재 연결에서 원본을 다시 선택해 주세요.',
    });
  }
  return {
    ...state,
    invalidate,
    createPlan,
    createReport,
    readPlan,
    readReport,
    validate,
    handoffPlan,
    recover,
    newDraft,
  };
}

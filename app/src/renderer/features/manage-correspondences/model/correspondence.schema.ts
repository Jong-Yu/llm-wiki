import { z } from 'zod';
import { isDocumentPath } from '@contracts/documents.contract';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import type {
  WorkspaceRequest,
  WorkspaceResult,
  WorkspaceScope,
} from '@contracts/workspace.contract';

const text = z
  .string()
  .min(1, '내용을 입력해 주세요.')
  .max(2000)
  .refine((value: string): boolean => value.trim().length > 0);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-f0-9]{32}$/);
export const anchorSchema = z
  .object({
    document: z
      .string()
      .refine(isDocumentPath, '위키 문서 경로를 확인해 주세요.'),
    source_revision: revision,
    quote: z.string().min(1).max(1000),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
    occurrence: z.number().int().min(0).optional(),
  })
  .catchall(z.json());
const constraints = z
  .object({
    status: z.enum(['unknown', 'none', 'specified']),
    items: z.array(text).max(50),
  })
  .catchall(z.json());
export const valueSchema = z
  .object({
    condition: anchorSchema,
    concept: anchorSchema,
    statement: text,
    direction: z.enum(['condition_to_concept', 'equivalent_definition']),
    qualifiers: z
      .object({
        quantity: z
          .object({
            status: z.enum(['unknown', 'not_applicable', 'specified']),
            expression: text,
          })
          .catchall(z.json()),
        conditions: constraints,
        exceptions: constraints,
      })
      .catchall(z.json()),
    business_scope: z
      .object({
        axes: z
          .array(
            z
              .object({
                name: text,
                status: z.enum(['unknown', 'unrestricted', 'specified']),
                value: z.string().nullable(),
                source: z.string().nullable(),
              })
              .catchall(z.json()),
          )
          .min(1)
          .max(50),
        validity: z
          .object({
            status: z.enum(['unknown', 'unrestricted', 'specified']),
            source: z.string().nullable(),
          })
          .catchall(z.json()),
      })
      .catchall(z.json()),
    basis: z
      .object({
        kind: z.enum(['candidate', 'source', 'expert']),
        reason: text,
        link_evidence: z.array(anchorSchema).max(50),
      })
      .catchall(z.json()),
    references: z.array(knowledgeValueSchema).max(50),
    questions: z.array(text).max(50),
    related_to: z.array(knowledgeValueSchema).max(50),
  })
  .catchall(z.json());
export type CorrespondenceValue = z.infer<typeof valueSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
const judgmentSchema = z
  .object({
    value: valueSchema.nullable(),
    decision: z.string(),
    applicability: z.string(),
    event_id: id,
    judgment_id: id.nullable(),
    lane: z.enum(['source', 'expert']),
    reasons: z.array(z.string()),
    conflict_refs: z.array(z.string()),
  })
  .catchall(z.json());
export type Judgment = z.infer<typeof judgmentSchema>;
const completeness = {
  complete: z.boolean(),
  truncated: z.boolean(),
  skipped: z.array(knowledgeValueSchema),
};
export const summarySchema = z
  .object({
    correspondence_id: id,
    correspondence_revision: revision,
    documents: z.object({ condition: z.string(), concept: z.string() }),
    source_proposal: judgmentSchema,
    policies: z.array(judgmentSchema),
    complete: z.boolean(),
    dependencies: knowledgeValueSchema,
  })
  .catchall(z.json());
export const findSchema = z
  .object({ ...completeness, results: z.array(summarySchema) })
  .catchall(z.json());
export const detailSchema = summarySchema.extend({
  ...completeness,
  state_revision: revision.optional(),
  history: z.array(knowledgeValueSchema),
});
export const preparedSchema = z
  .object({
    ...completeness,
    correspondence_id: id,
    correspondence_revision: revision.nullable(),
    state_revision: revision,
    draft: valueSchema.optional(),
    prepared_change: knowledgeValueSchema.optional(),
  })
  .catchall(z.json());
export const receiptSchema = summarySchema.extend({
  event_id: id,
  changed: z.literal(true),
  sequence: z.number().int().min(1),
  cleanup_failures: z.array(z.json()),
});
export type Detail = z.infer<typeof detailSchema>;
export type Found = z.infer<typeof findSchema>;
export type Scope = WorkspaceScope & {
  connectionId: string;
  permissions: string[];
};
export type Failure = Extract<WorkspaceResult, { ok: false }>['error'];
export type Outcome<T> = { ok: true; data: T } | { ok: false; error: Failure };
export type Command = Extract<
  WorkspaceRequest,
  {
    operation:
      | 'correspondencePropose'
      | 'correspondenceReview'
      | 'correspondenceReviewUndo'
      | 'correspondencePolicy'
      | 'correspondencePolicyUndo';
  }
>;
export type Intent =
  | { kind: 'propose'; value: CorrespondenceValue; reason: string }
  | {
      kind: 'review' | 'review_undo' | 'policy' | 'policy_undo';
      correspondenceId: string;
      baseRevision: string;
      baseDependencies: KnowledgeValue;
      change: KnowledgeValue;
    };
export type Prepared = {
  command: Command;
  response: z.infer<typeof preparedSchema>;
  intent: Intent;
};
export const searchSchema = z.object({
  documents: z
    .string()
    .min(1)
    .refine((input: string): boolean => {
      const paths = documentPaths(input);
      return (
        paths.length >= 1 &&
        paths.length <= 8 &&
        new Set(paths).size === paths.length &&
        paths.every(isDocumentPath)
      );
    }, '중복 없이 위키 문서 경로를 1~8개 입력해 주세요.'),
  text: z.string().max(2000),
  context: z
    .string()
    .max(8000)
    .refine((value: string): boolean => {
      const rows = value
        .split('\n')
        .filter((line: string): boolean => line.trim().length > 0);
      const keys = rows.map((line: string): string =>
        line.split('=')[0].trim(),
      );
      return (
        rows.length <= 50 &&
        new Set(keys).size === keys.length &&
        rows.every(
          (line: string): boolean =>
            line.indexOf('=') > 0 &&
            line.slice(line.indexOf('=') + 1).trim().length > 0,
        )
      );
    }, '업무 범위를 이름=값으로 한 줄씩 입력해 주세요.'),
  asOf: z
    .string()
    .refine(
      (value: string): boolean =>
        !value ||
        (/([+-]\d{2}:\d{2}|Z)$/.test(value) &&
          Number.isFinite(Date.parse(value))),
      '시간대가 포함된 시각을 입력해 주세요.',
    ),
});
export type SearchValues = z.infer<typeof searchSchema>;
export type QueryContext = {
  application_context: KnowledgeValue;
  as_of: string | null;
};
/** 조회용 업무 축은 접속 관점에서 추측하지 않고 사용자가 명시한 값만 사용합니다. */
export function queryContext(values: SearchValues): QueryContext {
  return {
    application_context: Object.fromEntries(
      values.context
        .split('\n')
        .filter((line: string): boolean => line.trim().length > 0)
        .map((line: string): [string, string] => [
          line.slice(0, line.indexOf('=')).trim(),
          line.slice(line.indexOf('=') + 1).trim(),
        ]),
    ),
    as_of: values.asOf || null,
  };
}
export const actionSchema = z.object({
  reason: z.string().trim().min(1, '판단 이유를 입력해 주세요.').max(1000),
  decision: z.enum(['accepted', 'deferred']),
});
export type ActionValues = z.infer<typeof actionSchema>;

/** 사용자가 명시한 문서 범위만 검색하며 이름으로 다른 문서를 추측하지 않습니다. */
export function documentPaths(value: string): string[] {
  return value
    .split('\n')
    .map((path: string): string => path.trim())
    .filter(Boolean);
}

/** 키 순서 차이 없이 서버 원형과 변경 전 기준을 비교합니다. */
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item: unknown): string => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a]: [string, unknown], [b]: [string, unknown]): number =>
        a.localeCompare(b),
      )
      .map(
        ([key, item]: [string, unknown]): string =>
          `${JSON.stringify(key)}:${canonical(item)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** 변경 전 실제 의존 자료의 판본을 준비 결과의 합집합에서도 유지해야 합니다. */
export function dependenciesUnchanged(
  before: KnowledgeValue,
  after: unknown,
): boolean {
  const parsed = knowledgeValueSchema.safeParse(after);
  if (!parsed.success) return false;
  for (const kind of ['documents', 'correspondences']) {
    const oldRows = before[kind];
    const newRows = parsed.data[kind];
    if (!Array.isArray(oldRows) || !Array.isArray(newRows)) return false;
    for (const old of oldRows) {
      if (!old || typeof old !== 'object' || Array.isArray(old)) return false;
      const key = kind === 'documents' ? 'document' : 'correspondence_id';
      const current = newRows.find(
        (row: unknown): boolean =>
          !!row &&
          typeof row === 'object' &&
          key in row &&
          Reflect.get(row, key) === old[key],
      );
      if (!current || typeof current !== 'object' || Array.isArray(current))
        return false;
      for (const field of [
        'source_revision',
        'history_revision',
        'graph_revision',
        'review_revision',
        'state_revision',
        'correspondence_revision',
        'dependencies_digest',
        'status',
      ]) {
        if (field in old && canonical(old[field]) !== canonical(current[field]))
          return false;
      }
    }
  }
  return true;
}

/** 준비 기준·작성자·변경 내용을 모두 맞춘 이력만 미확인 저장의 완료 근거로 사용합니다. */
export function confirmedEvent(
  detail: Detail,
  pending: Prepared,
  userId: string,
): string | null {
  const operation = pending.intent.kind;
  const input = pending.command.input;
  const event = detail.history.find((row: KnowledgeValue): boolean => {
    const actor = knowledgeValueSchema.safeParse(row.actor);
    if (
      row.base_state_revision !== input.expected_state_revision ||
      row.action !== operation ||
      row.reason !== input.reason ||
      !actor.success ||
      actor.data.user_id !== userId
    )
      return false;
    if (pending.intent.kind === 'propose') {
      const after = knowledgeValueSchema.safeParse(row.after);
      return (
        after.success &&
        canonical(after.data.value) === canonical(pending.intent.value)
      );
    }
    return true;
  });
  return event && typeof event.id === 'string' ? event.id : null;
}
/** 새 초안은 미확인을 보존하고 근거·범위를 임의로 확정하지 않습니다. */
export function emptyValue(): CorrespondenceValue {
  const anchor: Anchor = {
    document: '',
    source_revision: '',
    quote: '',
    start_line: 1,
    end_line: 1,
  };
  return {
    condition: { ...anchor },
    concept: { ...anchor },
    statement: '',
    direction: 'condition_to_concept',
    qualifiers: {
      quantity: { status: 'unknown', expression: '미확인' },
      conditions: { status: 'unknown', items: [] },
      exceptions: { status: 'unknown', items: [] },
    },
    business_scope: {
      axes: [{ name: '', status: 'unknown', value: null, source: null }],
      validity: { status: 'unknown', source: null },
    },
    basis: { kind: 'candidate', reason: '', link_evidence: [] },
    references: [],
    questions: [],
    related_to: [],
  };
}
/** 서버 상태값을 판단과 현재 적용 가능성으로 나누어 표시합니다. */
export function stateLabel(value: string): string {
  const labels: Record<string, string> = {
    'decision is not accepted/active':
      '아직 수용되거나 활성화된 판단이 아닙니다.',
    'a required dependency is confirmed missing':
      '필요한 의존 자료가 없습니다.',
    'a required source, graph, or event is confirmed missing':
      '필요한 원문·그래프·판단 기록이 없습니다.',
    'actual dependency state changed since the judgment':
      '판단 이후 근거 자료가 바뀌어 재검토가 필요합니다.',
    'expert policy exact domain/viewpoint differs':
      '전문가 판단의 업무 영역·관점이 현재 선택과 다릅니다.',
    'meaning, conditions, exceptions, or confirmation questions remain unresolved':
      '의미·조건·예외 또는 확인할 질문이 아직 해결되지 않았습니다.',
    'required application axis is not known':
      '필요한 업무 적용 범위가 확인되지 않았습니다.',
    'application axis differs from this judgment':
      '조회한 업무 범위가 이 판단의 적용 범위와 다릅니다.',
    'validity is unknown': '적용 기간이 확인되지 않았습니다.',
    'evaluation time is outside the specified interval':
      '조회 시각이 지정된 적용 기간 밖입니다.',
    'a referenced judgment is no longer applicable':
      '참조한 판단을 더 이상 적용할 수 없습니다.',
    'referenced graph expert policy is no longer current':
      '참조한 그래프의 전문가 판단이 더 이상 현재 판단이 아닙니다.',
    'referenced graph expert policy exact scope differs':
      '참조한 그래프의 전문가 판단 범위가 다릅니다.',
    'referenced policy exact scope differs':
      '참조한 업무 판단의 적용 범위가 다릅니다.',
    'referenced correspondence is missing': '참조한 대응을 찾을 수 없습니다.',
    'referenced judgment is not applicable in the requested scope/time':
      '참조한 판단을 조회 범위·시각에 적용할 수 없습니다.',
    'explicitly superseded in this exact selected scope':
      '현재 선택 범위에서 다른 판단으로 명시 대체되었습니다.',
    'independent active expert judgments disagree in an identical scope':
      '같은 적용 범위의 활성 전문가 판단들이 상충합니다.',
    unknown: '미확인',
    not_applicable: '해당 없음',
    specified: '명시됨',
    none: '명시적으로 없음',
    unrestricted: '명시적으로 제한 없음',
    condition_to_concept: '조건 → 개념 · 단방향',
    equivalent_definition: '양방향 정의 (동치)',
    unreviewed: '미검토',
    accepted: '수용',
    rejected: '거절',
    deferred: '보류',
    active: '활성',
    inactive: '비활성',
    applicable: '현재 적용 가능',
    needs_review: '재검토 필요',
    unavailable: '확인 불가',
    unknown_scope: '적용 범위 미확인',
    other_scope: '다른 적용 범위',
    out_of_period: '기간 밖',
    conflicting: '판단 충돌',
    source: '원문 근거',
    expert: '전문가 판단',
    candidate: '연결 후보',
    propose: '제안',
    review: '검토',
    policy: '업무 판단',
    review_undo: '검토 되돌림',
    policy_undo: '업무 판단 되돌림',
  };
  return labels[value] || value;
}

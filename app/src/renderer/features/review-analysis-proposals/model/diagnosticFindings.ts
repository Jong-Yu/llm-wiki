import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { currentProposalSource } from './analysisProposal.schema';
import type { ProposalRecord } from './analysisProposal.schema';

const textSchema = z.string().min(1).max(2000);
const rangeSchema = z.strictObject({
  start_line: z.number().int().min(1),
  end_line: z.number().int().min(1),
});
const findingSchema = z.strictObject({
  rule_id: z.string().regex(/^R-S(0[1-9]|10)$/),
  verdict: z.enum([
    'supported',
    'contradicted',
    'unsupported',
    'condition_loss',
    'ambiguous',
    'omission',
    'schema_limit',
    'not_run',
    'undetermined',
  ]),
  source: rangeSchema.extend({ quote: z.string().min(1).max(4000) }).nullable(),
  target: z
    .strictObject({
      collection: z.enum([
        'entities',
        'relations',
        'attributes',
        'relation_candidates',
      ]),
      index: z.number().int().min(0),
    })
    .nullable(),
  reason: textSchema,
  recommendation: textSchema.nullable(),
  question: textSchema.nullable(),
});
const fields = {
  reviewer_kind: z.enum([
    'ai_self_check',
    'separate_ai',
    'human_reported',
    'not_reported',
  ]),
  warnings: z.array(textSchema).max(100),
  omissions: z.array(textSchema).max(100),
  unread_ranges: z.array(textSchema).max(100),
  reviewed_ranges: z.array(rangeSchema).max(100),
  findings: z.array(findingSchema).max(100),
};
const reportSchema = z.discriminatedUnion('schema_version', [
  z.strictObject({ schema_version: z.literal(1), ...fields }),
  z.strictObject({
    schema_version: z.literal(2),
    ...fields,
    rule_results: z
      .array(
        z.strictObject({
          rule_id: z.string().regex(/^R-S(0[1-9]|10)$/),
          status: z.enum([
            'pass',
            'fail',
            'not_run',
            'not_applicable',
            'error',
          ]),
          reason: textSchema,
          finding_indices: z.array(z.number().int().min(0)).max(100),
        }),
      )
      .length(10),
    semantic_check: knowledgeValueSchema.nullable(),
  }),
]);
export type DiagnosticFinding = z.infer<typeof findingSchema>;
export type DiagnosticFindingReport = z.infer<typeof reportSchema>;
export type DiagnosticFindingView = {
  finding: DiagnosticFinding;
  sourceText: string | null;
  target: KnowledgeValue | null;
};
export type DiagnosticFindingsResult =
  | { ok: false; message: string }
  | {
      ok: true;
      report: DiagnosticFindingReport;
      findings: DiagnosticFindingView[];
      sourceRevision: string;
    };

/** 서버의 splitlines와 같은 줄 경계를 유지하며 CRLF·빈 줄을 바꾸지 않습니다. */
function sourceLines(content: string): string[] {
  const separators = new Set([
    '\r',
    '\n',
    '\v',
    '\f',
    '\u001c',
    '\u001d',
    '\u001e',
    '\u0085',
    '\u2028',
    '\u2029',
  ]);
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index++) {
    if (!separators.has(content[index])) continue;
    if (content[index] === '\r' && content[index + 1] === '\n') index++;
    lines.push(content.slice(start, index + 1));
    start = index + 1;
  }
  if (start < content.length) lines.push(content.slice(start));
  return lines;
}
/** 유효하지 않은 연결은 추측으로 보완하지 않고 원본 보고 확인을 안내합니다. */
function unavailable(): DiagnosticFindingsResult {
  return {
    ok: false,
    message:
      '진단의 형식·원문 범위·후보 대상을 확인하지 못했습니다. 원본 보고를 확인해 주세요.',
  };
}
/** 검증된 보고를 같은 후보의 원문·배열 위치와 다시 대조해 읽기 전용으로 표시합니다. */
export function readDiagnosticFindings(
  value: unknown,
  record: ProposalRecord,
): DiagnosticFindingsResult {
  const parsed = reportSchema.safeParse(value);
  const source = currentProposalSource(record);
  if (
    !parsed.success ||
    typeof source?.content !== 'string' ||
    typeof source.revision !== 'string'
  )
    return unavailable();
  const report = parsed.data;
  const lines = sourceLines(source.content);
  const validRange = (range: z.infer<typeof rangeSchema>): boolean =>
    range.start_line <= range.end_line && range.end_line <= lines.length;
  if (
    report.reviewed_ranges.some(
      (range: z.infer<typeof rangeSchema>): boolean => !validRange(range),
    )
  )
    return unavailable();
  if (
    report.reviewer_kind === 'not_reported' &&
    (report.findings.length > 0 || report.reviewed_ranges.length > 0)
  )
    return unavailable();
  if (
    report.schema_version === 2 &&
    (new Set(
      report.rule_results.map(
        (
          rule: Extract<
            DiagnosticFindingReport,
            { schema_version: 2 }
          >['rule_results'][number],
        ): string => rule.rule_id,
      ),
    ).size !== 10 ||
      report.rule_results.some(
        (
          rule: Extract<
            DiagnosticFindingReport,
            { schema_version: 2 }
          >['rule_results'][number],
        ): boolean =>
          rule.finding_indices.some(
            (index: number): boolean =>
              report.findings[index]?.rule_id !== rule.rule_id,
          ),
      ))
  )
    return unavailable();
  const findings: DiagnosticFindingView[] = [];
  for (const finding of report.findings) {
    let sourceText: string | null = null;
    if (finding.source) {
      const range = finding.source;
      if (!validRange(range)) return unavailable();
      const selected = lines.slice(range.start_line - 1, range.end_line);
      sourceText = selected.join('');
      const at = sourceText.indexOf(range.quote);
      const firstEnd = selected[0].length;
      const lastStart =
        sourceText.length - selected[selected.length - 1].length;
      if (at < 0 || at >= firstEnd || at + range.quote.length - 1 < lastStart)
        return unavailable();
    } else if (
      !['ambiguous', 'not_run', 'undetermined'].includes(finding.verdict)
    ) {
      return unavailable();
    }
    let target: KnowledgeValue | null = null;
    if (finding.target) {
      const items = record.submission?.[finding.target.collection];
      if (!Array.isArray(items)) return unavailable();
      const selected = knowledgeValueSchema.safeParse(
        items[finding.target.index],
      );
      if (!selected.success) return unavailable();
      target = selected.data;
    }
    findings.push({ finding, sourceText, target });
  }
  return { ok: true, report, findings, sourceRevision: source.revision };
}

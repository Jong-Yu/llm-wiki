import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import {
  candidateRefSchema,
  currentProposalSource,
} from './analysisProposal.schema';
import type { ProposalRecord } from './analysisProposal.schema';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rules = z.object({
  ruleset_id: z.string(),
  ruleset_version: z.string(),
  ruleset_revision: hash,
});
const refSchema = z.object({
  proposal_id: id,
  input_revision: hash,
  proposal_state_revision: hash,
  execution_id: id,
  execution_revision: hash,
  job_id: id,
  run_id: id,
  bundle_id: id,
  bundle_revision: hash,
  request_id: id,
  payload_hash: hash,
  submission_sha256: hash,
  source_revision: hash,
  ruleset_ref: rules,
  result_receipt_revision: hash,
  diagnostic_report_hash: hash.nullable(),
  human_approval: z.literal(false),
  origin: z.literal('client_reported'),
});
const linkSchema = z.object({
  request_id: id,
  execution_id: id,
  candidate_ref: candidateRefSchema,
  result_ref: refSchema,
  currentness: z.string(),
  candidate_current: z.boolean(),
  basis_current: z.boolean(),
  execution_current: z.boolean(),
  run_current: z.boolean(),
  job_cancelled: z.boolean(),
});
const reportSchema = z.object({
  proposal_id: id,
  request_id: id,
  execution_id: id,
  candidate_ref: candidateRefSchema,
  result_ref: refSchema,
  linked: z.literal(true),
  state: z.literal('complete'),
  state_revision: hash,
  saved: z.literal(false),
  canonical_changed: z.literal(false),
  report_revision: hash,
  report: knowledgeValueSchema,
});
export type VerifiedReports = {
  reports: KnowledgeValue[];
  unavailable: string[];
  stale: number;
};
/** JSON 객체 키를 정렬해 서버의 정규 제출 hash와 대조합니다. */
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item: unknown): string => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a]: [string, unknown], [b]: [string, unknown]): number =>
        a < b ? -1 : a > b ? 1 : 0,
      )
      .map(
        ([key, item]: [string, unknown]): string =>
          `${JSON.stringify(key)}:${canonical(item)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
/** WebCrypto는 브라우저에서도 같은 제출을 재구성하며 서버 토큰을 요구하지 않습니다. */
export async function proposalJsonHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${canonical(value)}\n`),
  );
  return [...new Uint8Array(digest)]
    .map((item: number): string => item.toString(16).padStart(2, '0'))
    .join('');
}
/** 후보·실행·결과·제출·규약 참조가 모두 맞는 보고만 현재 검사로 선택합니다. */
export async function verifiedProposalReports(
  record: ProposalRecord,
): Promise<VerifiedReports> {
  const result: VerifiedReports = { reports: [], unavailable: [], stale: 0 };
  const links = z.array(linkSchema).safeParse(record.result_links);
  const reports = z.array(reportSchema).safeParse(record.current_reports);
  if (
    !links.success ||
    !reports.success ||
    !record.submission ||
    !record.candidate_ref
  )
    return {
      ...result,
      unavailable: ['정확한 실행·결과·후보 참조가 있는 검사 보고가 없습니다.'],
    };
  const submissionHash = await proposalJsonHash(record.submission);
  const source = currentProposalSource(record);
  const expectedRules = rules.safeParse(record.basis.ruleset_ref);
  result.stale = links.data.filter(
    (link: z.infer<typeof linkSchema>): boolean =>
      link.currentness !== 'current',
  ).length;
  for (const [index, report] of reports.data.entries()) {
    const ref = report.result_ref;
    const link = links.data.find(
      (item: z.infer<typeof linkSchema>): boolean =>
        item.request_id === report.request_id,
    );
    const basis = knowledgeValueSchema.safeParse(
      report.report.validation_report,
    );
    const reportBasis = knowledgeValueSchema.safeParse(
      basis.success ? basis.data.basis : null,
    );
    const sameBasis =
      reportBasis.success &&
      [
        'job_id',
        'run_id',
        'bundle_id',
        'bundle_revision',
        'source_revision',
        'submission_sha256',
      ].every(
        (key: string): boolean =>
          reportBasis.data[key] === Reflect.get(ref, key),
      );
    if (
      !link ||
      link.currentness !== 'current' ||
      !link.candidate_current ||
      !link.basis_current ||
      !link.execution_current ||
      !link.run_current ||
      link.job_cancelled ||
      record.basis_status !== 'current' ||
      report.proposal_id !== record.proposal_id ||
      ref.proposal_id !== record.proposal_id ||
      ref.input_revision !== record.input_revision ||
      report.state_revision !== record.state_revision ||
      report.execution_id !== record.active_execution_id ||
      ref.execution_id !== report.execution_id ||
      report.candidate_ref.candidate_id !== record.candidate_ref.candidate_id ||
      report.candidate_ref.candidate_revision !==
        record.candidate_ref.candidate_revision ||
      canonical(link.result_ref) !== canonical(ref) ||
      canonical(link.candidate_ref) !== canonical(report.candidate_ref) ||
      ref.submission_sha256 !== submissionHash ||
      ref.source_revision !== source?.revision ||
      !expectedRules.success ||
      canonical(expectedRules.data) !== canonical(ref.ruleset_ref) ||
      !sameBasis
    ) {
      result.unavailable.push(
        `보고 ${index + 1}: 후보·입력·실행 참조가 다르거나 현재성을 확인하지 못했습니다. ${[
          !sameBasis ? '검사 입력 불일치' : '',
          ref.submission_sha256 !== submissionHash ? '제출 내용 불일치' : '',
          ref.source_revision !== source?.revision ? '원문 버전 불일치' : '',
          !expectedRules.success ||
          canonical(expectedRules.data) !== canonical(ref.ruleset_ref)
            ? '규약 불일치'
            : '',
          report.state_revision !== record.state_revision
            ? '상태 버전 불일치'
            : '',
          report.execution_id !== record.active_execution_id
            ? '다른 실행의 보고'
            : '',
        ]
          .filter(Boolean)
          .join(' · ')}`,
      );
      continue;
    }
    const diagnostics = knowledgeValueSchema.safeParse(
      report.report.diagnostics,
    );
    if (diagnostics.success && diagnostics.data.report) {
      const actualHash = await proposalJsonHash(diagnostics.data.report);
      if (
        actualHash !== ref.diagnostic_report_hash ||
        diagnostics.data.report_hash !== actualHash
      ) {
        result.unavailable.push(
          `보고 ${index + 1}: 의미 검사 보고가 기록된 내용과 다릅니다.`,
        );
        continue;
      }
    }
    result.reports.push({
      ...report.report,
      reference: {
        ...ref,
        candidate_ref: report.candidate_ref,
        report_revision: report.report_revision,
        link_request_id: report.request_id,
      },
    });
  }
  if (!result.reports.length && !result.unavailable.length)
    result.unavailable.push(
      '현재 후보에 연결된 검사 보고가 없습니다. 이전 보고는 현재 통과 근거로 사용하지 않습니다.',
    );
  return result;
}

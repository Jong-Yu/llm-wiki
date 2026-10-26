import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import {
  proposalContextSchema,
  resolutionBindingSchema,
} from '@contracts/analysisProposals.contract';
import { isDocumentPath } from '@contracts/documents.contract';

const id = z.string().regex(/^[a-f0-9]{32}$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const json = z.json();
export const candidateRefSchema = z.object({
  candidate_id: id,
  candidate_revision: revision,
});
export const proposalClaimSchema = z
  .object({
    claim_id: revision,
    collection: z.enum(['relations', 'attributes', 'relation_candidates']),
    value: knowledgeValueSchema,
    decision: z.string(),
  })
  .catchall(json);
export const proposalSchema = z
  .object({
    proposal_id: id,
    state_revision: revision,
    input_revision: revision,
    basis_status: z.enum(['current', 'changed_or_unavailable']),
    basis: z
      .object({
        target_document: z.string(),
        documents: z.array(knowledgeValueSchema),
        previous: z
          .object({
            status: z.string(),
            graph: knowledgeValueSchema.nullable(),
            claims: z.array(proposalClaimSchema),
            source: knowledgeValueSchema.nullable(),
            source_restoration: z.string(),
          })
          .catchall(json),
      })
      .catchall(json),
    candidate_ref: candidateRefSchema.nullable(),
    submission: knowledgeValueSchema.nullable(),
    preview_claims: z.array(proposalClaimSchema),
    missing_claims: z.array(proposalClaimSchema),
    decisions: z.array(knowledgeValueSchema),
    events: z.array(knowledgeValueSchema),
    applications: z.record(z.string(), knowledgeValueSchema),
    submission_schema: knowledgeValueSchema,
    rules_components: z.record(z.string(), z.string()),
    human_approval: z.literal(false),
    semantic_validation: z.string(),
  })
  .catchall(json);
export const proposalValidationSchema = z
  .object({
    proposal_id: id,
    state_revision: revision,
    candidate_ref: candidateRefSchema,
    automatic: z.string(),
    semantic: z.string(),
    human_approval: z.literal(false),
  })
  .catchall(json);
export type ProposalRecord = z.infer<typeof proposalSchema>;
export type ProposalClaim = z.infer<typeof proposalClaimSchema>;
export type ProposalValidation = z.infer<typeof proposalValidationSchema>;

/** 텍스트 JSON은 유효한 객체만 받으며 의미·인용 검사는 서버가 수행합니다. */
export function parseObject(text: string): KnowledgeValue | null {
  try {
    const parsed = knowledgeValueSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** 빈 배열·정확한 공개 스키마를 별도로 검사합니다. */
export function parseContexts(
  text: string,
): z.infer<typeof proposalContextSchema>[] | null {
  try {
    const parsed = z
      .array(proposalContextSchema)
      .max(7)
      .safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** 새 claim의 대응을 ID 유사성으로 추정하지 않고 명시한 관계만 받습니다. */
export function parseBindings(
  text: string,
): z.infer<typeof resolutionBindingSchema>[] | null {
  try {
    const parsed = z
      .array(resolutionBindingSchema)
      .max(100)
      .safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
/** 여러 ID 입력을 줄·쉼표·공백 경계로 읽습니다. */
export function splitIds(value: string): string[] {
  return value.trim() ? value.trim().split(/[\s,]+/) : [];
}

export const prepareFieldsSchema = z.object({
  document: z
    .string()
    .refine(isDocumentPath, '실제 Wiki 경로를 입력해 주세요.'),
  contexts: z
    .string()
    .refine(
      (value: string): boolean => parseContexts(value) !== null,
      '맥락 문서 배열을 확인해 주세요.',
    ),
});
export type PrepareFields = z.infer<typeof prepareFieldsSchema>;
export const submitFieldsSchema = z.object({
  whole: z
    .string()
    .refine(
      (value: string): boolean => parseObject(value) !== null,
      '전체 추출 JSON 객체가 필요합니다.',
    ),
  resolves: z
    .string()
    .refine(
      (value: string): boolean =>
        z.array(id).max(100).safeParse(splitIds(value)).success,
      '재추출 decision ID를 확인해 주세요.',
    ),
  bindings: z
    .string()
    .refine(
      (value: string): boolean => parseBindings(value) !== null,
      '명시 대응 배열을 확인해 주세요.',
    ),
});
export type SubmitFields = z.infer<typeof submitFieldsSchema>;
export const decisionFieldsSchema = z
  .object({
    action: z.enum(['exclude', 'keep', 'reextract']),
    reason: z.string().trim().min(1).max(1000),
    evidence: z.string().max(65536),
    replacement: z.string(),
    checkedWhole: z.boolean(),
  })
  .superRefine(
    (
      value: {
        action: string;
        reason: string;
        evidence: string;
        replacement: string;
        checkedWhole: boolean;
      },
      context: z.RefinementCtx,
    ): void => {
      if (value.action === 'exclude' && !value.checkedWhole)
        context.addIssue({
          code: 'custom',
          path: ['checkedWhole'],
          message:
            '현재 전체 원문을 확인해야 이번 비교에서 제외할 수 있습니다.',
        });
      if (value.action === 'keep') {
        const replacement = parseObject(value.replacement);
        if (
          !value.evidence ||
          !replacement ||
          replacement.evidence !== value.evidence
        )
          context.addIssue({
            code: 'custom',
            path: ['replacement'],
            message:
              '현재 원문의 정확한 인용과 같은 evidence를 가진 전체 복구 항목을 입력해 주세요.',
          });
      }
    },
  );
export type DecisionFields = z.infer<typeof decisionFieldsSchema>;
export const completionFieldsSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  reviewed: z.array(revision).max(100),
  confirmed: z
    .boolean()
    .refine((value: boolean): boolean => value, '완료 범위를 확인해 주세요.'),
});
export type CompletionFields = z.infer<typeof completionFieldsSchema>;

/** 서버의 현재 검사판본이 화면에 표시한 후보와 모두 같아야 적용 버튼을 엽니다. */
export function canApplyProposal(
  record: ProposalRecord | null,
  validation: ProposalValidation | null,
): boolean {
  return (
    !!record &&
    !!validation &&
    record.basis_status === 'current' &&
    validation.automatic === 'passed' &&
    validation.proposal_id === record.proposal_id &&
    validation.state_revision === record.state_revision &&
    validation.candidate_ref.candidate_id ===
      record.candidate_ref?.candidate_id &&
    validation.candidate_ref.candidate_revision ===
      record.candidate_ref?.candidate_revision
  );
}
/** 실제 저장 함수의 영수증이 없는 pending/false 응답을 완료로 해석하지 않습니다. */
export function confirmedApplication(receipt: KnowledgeValue | null): boolean {
  return z
    .object({
      saved: z.literal(true),
      receipt: z.object({
        source_revision: revision,
        graph_revision: revision,
        candidate_ref: candidateRefSchema,
        human_approval: z.literal(false),
        cleanup_failures: z.array(z.json()),
      }),
    })
    .safeParse(receipt).success;
}
/** 고정 현재 원문은 target 문서의 실제 캡처에서만 꺼냅니다. */
export function currentProposalSource(
  record: ProposalRecord,
): KnowledgeValue | null {
  const target = record.basis.documents.find(
    (item: KnowledgeValue): boolean =>
      item.document === record.basis.target_document,
  );
  const parsed = knowledgeValueSchema.safeParse(target?.source);
  return parsed.success ? parsed.data : null;
}

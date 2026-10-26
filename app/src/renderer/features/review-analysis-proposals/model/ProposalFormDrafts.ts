import { z } from 'zod';
import type {
  PrepareFields,
  SubmitFields,
  DecisionFields,
  CompletionFields,
} from './analysisProposal.schema';

export const proposalFormsSchema = z.object({
  prepare: z.record(
    z.string(),
    z.object({ document: z.string(), contexts: z.string() }),
  ),
  submit: z.record(
    z.string(),
    z.object({ whole: z.string(), resolves: z.string(), bindings: z.string() }),
  ),
  decision: z.record(
    z.string(),
    z.object({
      action: z.enum(['exclude', 'keep', 'reextract']),
      reason: z.string(),
      evidence: z.string(),
      replacement: z.string(),
      checkedWhole: z.boolean(),
    }),
  ),
  completion: z.record(
    z.string(),
    z.object({
      reason: z.string(),
      reviewed: z.array(z.string()),
      confirmed: z.boolean(),
    }),
  ),
});
export type ProposalForms = z.infer<typeof proposalFormsSchema>;
/** 한 인증 범위의 입력만 소유하고 변경 즉시 보호 복구에 전달합니다. */
export class ProposalFormDrafts {
  prepare = new Map<string, PrepareFields>();
  submit = new Map<string, SubmitFields>();
  decision = new Map<string, DecisionFields>();
  completion = new Map<string, CompletionFields>();
  changed: () => void = (): void => {};
  /** 전체 원문·입력은 자르지 않고 보존하며 저장 한도 오류는 호출자에게 반환합니다. */
  snapshot(): ProposalForms {
    return {
      prepare: Object.fromEntries(this.prepare),
      submit: Object.fromEntries(this.submit),
      decision: Object.fromEntries(this.decision),
      completion: Object.fromEntries(this.completion),
    };
  }
  /** 복원은 입력만 되살리며 과거 확인 체크를 새 승인으로 이식하지 않습니다. */
  restore(value: ProposalForms): void {
    this.prepare = new Map(Object.entries(value.prepare));
    this.submit = new Map(Object.entries(value.submit));
    this.decision = new Map(
      Object.entries(value.decision).map(
        ([key, item]: [string, DecisionFields]): [string, DecisionFields] => [
          key,
          { ...item, checkedWhole: false },
        ],
      ),
    );
    this.completion = new Map(
      Object.entries(value.completion).map(
        ([key, item]: [string, CompletionFields]): [
          string,
          CompletionFields,
        ] => [key, { ...item, confirmed: false }],
      ),
    );
  }
}

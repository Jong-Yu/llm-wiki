import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import styles from './ReviewAnalysisProposals.module.scss';
import type { ProposalRecord } from '../model/analysisProposal.schema';
import { verifiedProposalReports } from '../model/proposalReports';
import type { VerifiedReports } from '../model/proposalReports';
import { DiagnosticFindings } from './DiagnosticFindings';

const rowSchema = z
  .object({
    rule_id: z.string(),
    status: z.enum(['pass', 'fail', 'not_run', 'not_applicable', 'error']),
    checker: z.string().optional(),
    reason: z.string().optional(),
  })
  .catchall(z.json());
const labels = {
  pass: '통과',
  fail: '실패',
  not_run: '미실행',
  not_applicable: '해당 없음',
  error: '검사 오류',
};
type ProposalDiagnosticsProps = {
  report: KnowledgeValue | null;
  record?: ProposalRecord | null;
  onEditCandidate?: () => void;
  editingDisabled?: boolean;
};
type RuleReportProps = { title: string; report: KnowledgeValue };
/** 서버 판정만 번역하고 알 수 없는 상태는 확인이 필요함을 표시합니다. */
function checkLabel(value: unknown): string {
  if (typeof value !== 'string') return '개별 보고 확인';
  return (
    (
      {
        pass: '통과',
        passed: '통과',
        fail: '실패',
        not_run: '미실행',
        client_reported: '제출된 보고',
      } as Record<string, string>
    )[value] ?? '상태 확인 필요'
  );
}
type LinkedReportProps = {
  report: KnowledgeValue;
  record: ProposalRecord;
  onEditCandidate?: () => void;
  editingDisabled: boolean;
};

/** 실제 JSON 객체인 진단 묶음만 반환하고 필드 부재를 통과로 추정하지 않습니다. */
function reportObject(value: unknown): KnowledgeValue | null {
  const parsed = knowledgeValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
/** 규칙별 검사 상태와 실제 이유를 표시합니다. */
function RuleReport({ title, report }: RuleReportProps): JSX.Element {
  const parsed = z.array(rowSchema).safeParse(report.rule_results);
  return (
    <details
      className={styles.ruleReport}
      open={
        !parsed.success ||
        parsed.data.some(
          (row: z.infer<typeof rowSchema>): boolean =>
            row.status !== 'pass' && row.status !== 'not_applicable',
        )
      }
    >
      <summary>
        {title}
        {parsed.success ? ` · ${parsed.data.length}개 규칙` : ''}
      </summary>
      {parsed.success ? (
        <ul>
          {parsed.data.map(
            (row: z.infer<typeof rowSchema>, index: number): JSX.Element => (
              <li key={row.rule_id}>
                <strong>
                  검사 {index + 1} · {labels[row.status]}
                </strong>
                <p>{row.reason || '검사 이유가 제공되지 않았습니다.'}</p>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p>
          이 응답에는 규칙별 판정이 없습니다. 미실행을 통과로 표시하지 않습니다.
        </p>
      )}
    </details>
  );
}
/** 명시적으로 전달된 보고만 표시하며 문서 이름으로 다른 분석 작업의 진단을 연결하지 않습니다. */
function LinkedReport({
  report,
  record,
  onEditCandidate,
  editingDisabled,
}: LinkedReportProps): JSX.Element {
  const automatic = reportObject(report?.validation_report) ?? report;
  const diagnostics = reportObject(report?.diagnostics);
  const original = reportObject(diagnostics?.report);
  const normalizedSemantic = reportObject(diagnostics?.semantic);
  const semantic = original ?? normalizedSemantic;
  const kind = semantic?.reviewer_kind;
  const kindLabel =
    kind === 'ai_self_check'
      ? 'AI 자기보고'
      : kind === 'separate_ai'
        ? '별도 AI 의미 검사 · 자기보고'
        : kind === 'human_reported'
          ? '사람 제출 의미 보고 · 승인과 별도'
          : '제출된 의미 보고 · 검사자 확인 필요';
  return (
    <section className={styles.diagnostics}>
      {automatic ? (
        <>
          <p>
            자동 검사: {checkLabel(automatic.automatic)} · 의미 검사:{' '}
            {checkLabel(automatic.semantic)}
          </p>
        </>
      ) : (
        <p>서버 검증 전입니다. 별도 의미 검사는 미실행입니다.</p>
      )}
      {original ? (
        <DiagnosticFindings
          report={original}
          record={record}
          onEditCandidate={onEditCandidate}
          editingDisabled={editingDisabled}
        />
      ) : (
        <p>원본 진단 보고가 없어 근거·후보 대상을 연결하지 않습니다.</p>
      )}
      {automatic && (
        <RuleReport title="자동 구조·인용 검사" report={automatic} />
      )}
      {semantic && <RuleReport title={kindLabel} report={semantic} />}
    </section>
  );
}

/** 후보를 바꾼 첫 렌더부터 이전 보고를 숨기며 정확한 서버 참조만 현재 결과로 공개합니다. */
export function ProposalDiagnostics({
  report,
  record = null,
  onEditCandidate,
  editingDisabled = true,
}: ProposalDiagnosticsProps): JSX.Element {
  const [checked, setChecked] = useState<{
    record: ProposalRecord;
    result: VerifiedReports;
  } | null>(null);
  useEffect((): (() => void) => {
    let alive = true;
    if (record)
      void verifiedProposalReports(record)
        .then((result: VerifiedReports): void => {
          if (alive) setChecked({ record, result });
        })
        .catch((): void => {
          if (alive)
            setChecked({
              record,
              result: {
                reports: [],
                stale: 0,
                unavailable: ['검사 참조 확인에 실패했습니다.'],
              },
            });
        });
    return (): void => {
      alive = false;
    };
  }, [record]);
  const result = checked?.record === record ? checked?.result : null;
  const valid =
    record &&
    report &&
    report.proposal_id === record.proposal_id &&
    report.state_revision === record.state_revision;
  return (
    <section className={styles.diagnostics}>
      <h3>후보 검사</h3>
      <p>
        현재 후보의 서버 구조·인용 검증:{' '}
        {valid && typeof report.automatic === 'string'
          ? checkLabel(report.automatic)
          : '현재 기준으로 검증 전'}
      </p>
      {!result && (
        <p>
          {record
            ? '정확한 후보·실행·보고 참조 확인 중'
            : '실행·결과·후보 참조가 있는 검사 보고가 없습니다.'}
        </p>
      )}
      {!!result?.stale && (
        <p>
          이전 후보·입력·실행의 보고 {result.stale}건을 현재 검사에서
          제외했습니다.
        </p>
      )}
      {result?.unavailable.map((message: string): JSX.Element => (
        <p key={message}>{message}</p>
      ))}
      {record &&
        result?.reports.map(
          (value: KnowledgeValue, index: number): JSX.Element => (
            <LinkedReport
              key={index}
              report={value}
              record={record}
              onEditCandidate={onEditCandidate}
              editingDisabled={editingDisabled}
            />
          ),
        )}
      <p>검사 통과와 제출된 의미 보고는 사람 승인이 아닙니다.</p>
    </section>
  );
}

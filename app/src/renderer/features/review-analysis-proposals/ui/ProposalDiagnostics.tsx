import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { z } from 'zod';
import { knowledgeValueSchema } from '@contracts/knowledge.contract';
import type { KnowledgeValue } from '@contracts/knowledge.contract';
import styles from './ReviewAnalysisProposals.module.scss';
import type { ProposalRecord } from '../model/analysisProposal.schema';
import { verifiedProposalReports } from '../model/proposalReports';
import type { VerifiedReports } from '../model/proposalReports';

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
};
type RuleReportProps = { title: string; report: KnowledgeValue };

/** 실제 JSON 객체인 진단 묶음만 반환하고 필드 부재를 통과로 추정하지 않습니다. */
function reportObject(value: unknown): KnowledgeValue | null {
  const parsed = knowledgeValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
/** 규칙의 다섯 상태와 검사자·이유를 원래 구분대로 표시합니다. */
function RuleReport({ title, report }: RuleReportProps): JSX.Element {
  const parsed = z.array(rowSchema).safeParse(report.rule_results);
  return (
    <section>
      <h4>{title}</h4>
      {parsed.success ? (
        <ul>
          {parsed.data.map((row: z.infer<typeof rowSchema>): JSX.Element => (
            <li key={row.rule_id}>
              <strong>
                {row.rule_id} · {labels[row.status]}
              </strong>
              <p>
                {row.checker} {row.reason}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          이 응답에는 규칙별 판정이 없습니다. 미실행을 통과로 표시하지 않습니다.
        </p>
      )}
      <details>
        <summary>검사 입력·버전·출처·전체 보고</summary>
        <pre>{JSON.stringify(report, null, 2)}</pre>
      </details>
    </section>
  );
}
/** 명시적으로 전달된 보고만 표시하며 문서 이름으로 다른 분석 작업의 진단을 연결하지 않습니다. */
function LinkedReport({ report }: { report: KnowledgeValue }): JSX.Element {
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
      <h3>검사 결과</h3>
      <p>
        자동 구조·인용 검사와 AI 자기보고·별도 의미 검사·사람 검토를 구분합니다.
      </p>
      {automatic ? (
        <>
          <p>
            자동 검사:{' '}
            {typeof automatic.automatic === 'string'
              ? automatic.automatic
              : '개별 보고 확인'}{' '}
            · 의미 검사:{' '}
            {typeof automatic.semantic === 'string'
              ? automatic.semantic
              : '개별 보고 확인'}
          </p>
          <RuleReport title="자동 구조·인용 검사" report={automatic} />
        </>
      ) : (
        <p>서버 검증 전입니다. 별도 의미 검사는 미실행입니다.</p>
      )}
      {semantic && <RuleReport title={kindLabel} report={semantic} />}
      {diagnostics && (
        <details>
          <summary>진단 원본·검증된 의미 보고</summary>
          <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
        </details>
      )}
      <details>
        <summary>정확한 실행·결과·후보·제출 참조</summary>
        <pre>{JSON.stringify(report.reference, null, 2)}</pre>
      </details>
      <p>추출안의 client_reported 결과와 형식 통과는 사람 승인이 아닙니다.</p>
    </section>
  );
}

/** 후보를 바꾼 첫 렌더부터 이전 보고를 숨기며 정확한 서버 참조만 현재 결과로 공개합니다. */
export function ProposalDiagnostics({
  report,
  record = null,
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
      <h3>후보 검사 근거</h3>
      <p>
        현재 후보의 서버 구조·인용 검증:{' '}
        {valid && typeof report.automatic === 'string'
          ? report.automatic
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
      {result?.reports.map(
        (value: KnowledgeValue, index: number): JSX.Element => (
          <LinkedReport key={index} report={value} />
        ),
      )}
      {record?.result_links && (
        <details>
          <summary>보고 연결·누락·오래된 기준</summary>
          <pre>{JSON.stringify(record.result_links, null, 2)}</pre>
        </details>
      )}
      <p>검사 통과와 client_reported 보고는 사람 승인이 아닙니다.</p>
    </section>
  );
}

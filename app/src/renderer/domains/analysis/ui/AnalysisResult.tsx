import type { JSX } from 'react';
import type {
  AnalysisDetail,
  AnalysisJob,
  AnalysisReceipt,
  AnalysisDiagnostics,
  AnalysisDiagnosticReport,
  AnalysisDiagnosticFinding,
} from '@contracts/analysis.contract';
import { analysisDiagnosticReportSchema } from '@contracts/analysis.contract';
import { StatusNotice } from '@renderer/shared/ui/StatusNotice';
import styles from './AnalysisResult.module.scss';

type StoredResultProps = { result: AnalysisReceipt };
type DiagnosticReportProps = {
  diagnostics: AnalysisDiagnostics | null;
  draft: boolean;
};
type DiagnosticFindingProps = {
  finding: AnalysisDiagnosticFinding;
  index: number;
};
type DiagnosticMessagesProps = { title: string; items: string[] };
type AnalysisResultProps = {
  detail: AnalysisDetail;
  source: {
    sourceVersion: string;
    sourceSha256: string;
    scope: { profileId: string };
  };
};

/** 서버가 확인한 저장 상태를 사용자 안내로 바꿉니다. CLI 종료 상태로 성공을 결정하지 않습니다. */
export function resultTitle(job: AnalysisJob): string {
  switch (job.result_summary.status) {
    case 'draft':
      return '초안·진단 보존됨 · 자료 저장 전';
    case 'complete':
      return '서버 저장 완료';
    case 'partial':
      return '일부 결과만 저장됨';
    case 'pending_reconcile':
      return '저장 결과 확인 필요';
    case 'rejected':
      return '결과 제출이 거절됨';
    case 'not_started':
      if (job.state === 'cancelled') return '분석 취소됨';
      if (job.reported_status === 'failed') return '분석 실행 실패';
      if (job.reported_status === 'blocked') return '분석 진행 불가';
      return job.lease_status === 'active'
        ? '분석 진행 중'
        : '저장된 결과 없음';
  }
}

/** 그래프와 위키 결과는 각자의 저장 영수증을 따로 표시합니다. */
function stageTitle(stage: 'prepare_wiki' | 'extract_ontology'): string {
  return stage === 'prepare_wiki' ? '위키 본문' : '그래프';
}

const reviewerLabels: Record<
  AnalysisDiagnosticReport['reviewer_kind'],
  string
> = {
  ai_self_check: 'AI 자기점검으로 보고됨',
  separate_ai: '별도 AI 점검으로 보고됨',
  human_reported: '사람 검토라고 보고됨',
  not_reported: '검토자 보고 없음',
};
const verdictLabels: Record<AnalysisDiagnosticFinding['verdict'], string> = {
  supported: '지지 의견',
  contradicted: '모순 의견',
  unsupported: '근거 부족 의견',
  condition_loss: '조건 손실 의견',
  ambiguous: '모호함',
  omission: '누락 의견',
  schema_limit: '표현 한계 의견',
  not_run: '점검 미실행',
  undetermined: '판단 미정',
};
const collectionLabels: Record<
  NonNullable<AnalysisDiagnosticFinding['target']>['collection'],
  string
> = {
  entities: '개체',
  relations: '관계',
  attributes: '속성',
  relation_candidates: '관계 후보',
};

/** 보고된 경고·누락·미독을 기본 화면에 표시하고 빈 배열을 통과 판정으로 바꾸지 않습니다. */
function DiagnosticMessages({
  title,
  items,
}: DiagnosticMessagesProps): JSX.Element {
  return (
    <section className={styles.diagnosticMessages}>
      <h5>
        {title} <span>{items.length}건</span>
      </h5>
      {items.length > 0 ? (
        <ul>
          {items.map((item: string, index: number): JSX.Element => (
            <li key={`${index}:${item}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className={styles.caption}>보고된 항목 없음</p>
      )}
    </section>
  );
}

/** 실제 보고된 인용·줄·초안 배열 대상과 의미 의견을 각각 표시합니다. */
function DiagnosticFinding({
  finding,
  index,
}: DiagnosticFindingProps): JSX.Element {
  return (
    <article className={styles.finding}>
      <header>
        <h5>
          의견 {index + 1} · {finding.rule_id}
        </h5>
        <span>{verdictLabels[finding.verdict]}</span>
      </header>
      <dl>
        <dt>판정 원형</dt>
        <dd>{finding.verdict}</dd>
        <dt>원문 위치</dt>
        <dd>
          {finding.source
            ? `${finding.source.start_line}–${finding.source.end_line}행 · 보고 당시 고정 입력`
            : '인용·줄 위치 보고 없음'}
        </dd>
        <dt>초안 대상</dt>
        <dd>
          {finding.target
            ? `${collectionLabels[finding.target.collection]} · ${finding.target.index + 1}번째 항목 (배열 인덱스 ${finding.target.index})`
            : '지정된 초안 대상 없음'}
        </dd>
      </dl>
      {finding.source && (
        <blockquote className={styles.diagnosticQuote}>
          {finding.source.quote}
        </blockquote>
      )}
      <dl>
        <dt>발견 이유</dt>
        <dd>{finding.reason}</dd>
        <dt>권고</dt>
        <dd>
          {finding.recommendation === null
            ? '보고되지 않음'
            : finding.recommendation}
        </dd>
        <dt>미해결 질문</dt>
        <dd>
          {finding.question === null ? '보고되지 않음' : finding.question}
        </dd>
      </dl>
      <p className={styles.caption}>
        초안 배열의 위치를 가리키는 보고입니다. 저장된 주장 검토·승인 상태를
        변경하지 않습니다.
      </p>
    </article>
  );
}

/** 진단 보존과 자료 저장·서버의 구조 검사·의미 의견·사람 승인을 구분합니다. */
function DiagnosticReport({
  diagnostics,
  draft,
}: DiagnosticReportProps): JSX.Element {
  if (!diagnostics)
    return (
      <section className={styles.diagnostics} aria-label="진단 보고">
        <h4>진단 보고 없음</h4>
        <p className={styles.caption}>
          이 제출에는 진단 보고가 없습니다. 의미 정확도 검증 통과를 뜻하지
          않습니다.
        </p>
      </section>
    );
  const parsed = analysisDiagnosticReportSchema.safeParse(diagnostics.report);
  const report = parsed.success ? parsed.data : null;
  return (
    <section className={styles.diagnostics} aria-label="진단 보고">
      <header>
        <h4>{draft ? '미저장 초안의 진단 보고' : '제출 당시 진단 보고'}</h4>
        <span>클라이언트 보고</span>
      </header>
      <p className={styles.caption}>
        서버가 의미 정확도나 실제 사람의 승인을 인증한 보고가 아닙니다.{' '}
        {report ? reviewerLabels[report.reviewer_kind] : '보고 형식 확인 불가'}.
      </p>
      <p className={styles.caption}>
        {diagnostics.validation === 'structure_and_source_checked'
          ? '서버 확인 범위: 진단 형식·고정 원문의 인용 위치·초안 대상 참조. 의미 판정은 보고된 의견입니다.'
          : '서버의 진단 형식·원문 인용·초안 대상 검사를 확인하지 못했습니다.'}
      </p>
      {!report ? (
        <StatusNotice
          tone="warning"
          title="구조화할 수 없는 진단 원형을 보존했습니다"
        >
          서버가 미검사 상태로 반환한 보고입니다. 아래 전체 원형에서 확인할 수
          있습니다.
        </StatusNotice>
      ) : (
        <>
          <div className={styles.diagnosticSummary}>
            <DiagnosticMessages title="경고" items={report.warnings} />
            <DiagnosticMessages title="누락" items={report.omissions} />
            <DiagnosticMessages
              title="미독 범위"
              items={report.unread_ranges}
            />
          </div>
          {(report.reviewer_kind === 'not_reported' ||
            (report.findings.length === 0 &&
              report.reviewed_ranges.length === 0)) && (
            <StatusNotice title="의미 점검 결과 미보고">
              빈 보고나 보고된 항목이 없다는 사실은 의미 정확도 검증 통과가
              아닙니다.
            </StatusNotice>
          )}
          <p className={styles.caption}>
            보고된 검토 범위:{' '}
            {report.reviewed_ranges.length > 0
              ? report.reviewed_ranges
                  .map(
                    (
                      range: AnalysisDiagnosticReport['reviewed_ranges'][number],
                    ): string => `${range.start_line}–${range.end_line}행`,
                  )
                  .join(', ')
              : '없음'}
          </p>
          <details className={styles.findings}>
            <summary>항목별 의미 의견 {report.findings.length}건</summary>
            {report.findings.length > 0 ? (
              report.findings.map(
                (
                  finding: AnalysisDiagnosticFinding,
                  index: number,
                ): JSX.Element => (
                  <DiagnosticFinding
                    key={`${finding.rule_id}:${index}`}
                    finding={finding}
                    index={index}
                  />
                ),
              )
            ) : (
              <p className={styles.caption}>보고된 항목별 의견이 없습니다.</p>
            )}
          </details>
        </>
      )}
      <details className={styles.diagnosticOriginal}>
        <summary>전체 고정 기준·진단 보고 원형</summary>
        <pre>{JSON.stringify(diagnostics, null, 2)}</pre>
      </details>
    </section>
  );
}

/** 당시 영수증과 현재 저장소 조회를 나란히 보존하며 예전 판본을 최신값으로 바꾸지 않습니다. */
function StoredResult({ result }: StoredResultProps): JSX.Element {
  const receipt = result.receipt;
  const current = result.current_output;
  const saved =
    result.saved === true
      ? '저장 확인'
      : result.saved === false
        ? '저장되지 않음'
        : '저장 여부 미확인';
  return (
    <article className={styles.receipt}>
      <header>
        <strong>
          {receipt
            ? stageTitle(receipt.stage)
            : result.state === 'draft'
              ? '보존된 초안'
              : '결과 제출'}
        </strong>
        <span>{saved}</span>
      </header>
      {result.state === 'draft' && (
        <StatusNotice title="초안·진단만 보존됨 · 자료 저장 전">
          원시 초안과 전달된 진단을 보존한 기록입니다. 위키 본문·그래프의 저장
          완료 영수증과 구분합니다.
        </StatusNotice>
      )}
      {receipt ? (
        <>
          <p className={styles.document}>{receipt.document}</p>
          <p className={styles.caption}>AI 추출 결과 · 미검토</p>
          <p className={styles.caption}>
            결과 생성 관점: {receipt.actor.profile_id} · 작업 공간:{' '}
            {receipt.actor.tenant}
          </p>
          <details>
            <summary>저장 당시 판본·실행 정보</summary>
            <dl>
              <dt>본문 판본</dt>
              <dd>{receipt.source_revision}</dd>
              <dt>그래프 판본</dt>
              <dd>{receipt.graph_revision ?? '해당 없음'}</dd>
              <dt>검토 상태 판본</dt>
              <dd>{receipt.state_revision ?? '해당 없음'}</dd>
              <dt>수정 전 보존 판본</dt>
              <dd>{receipt.history_revision ?? '해당 없음'}</dd>
              <dt>고정 입력</dt>
              <dd>
                {receipt.bundle_id} / {receipt.bundle_revision}
              </dd>
              <dt>생성 관점의 영역</dt>
              <dd>{receipt.actor.domain ?? '지정 없음'}</dd>
              <dt>생성 관점</dt>
              <dd>{receipt.actor.viewpoint ?? '지정 없음'}</dd>
              <dt>권한 정책 판본</dt>
              <dd>{receipt.actor.policy_revision}</dd>
              {receipt.execution ? (
                <>
                  <dt>실행 정보 출처</dt>
                  <dd>클라이언트 보고</dd>
                  <dt>실행 도구</dt>
                  <dd>
                    {receipt.execution.provider} ·{' '}
                    {receipt.execution.cli_version}
                  </dd>
                  <dt>요청 모델</dt>
                  <dd>{receipt.execution.requested_model ?? '도구 기본값'}</dd>
                  <dt>보고된 모델</dt>
                  <dd>{receipt.execution.reported_model ?? '보고되지 않음'}</dd>
                </>
              ) : null}
            </dl>
          </details>
        </>
      ) : (
        <p>서버에서 확인 가능한 저장 영수증이 없습니다.</p>
      )}
      <section className={styles.current} aria-label="현재 저장 상태">
        <strong>현재 저장 상태</strong>
        <p>
          {result.saved === false
            ? '이 제출은 위키 본문·그래프에 저장되지 않았습니다.'
            : current?.status === 'current'
              ? '저장 당시 결과와 일치'
              : current?.status === 'changed'
                ? '저장 후 변경됨'
                : '현재 상태 확인 불가'}
        </p>
        {current?.state_changed === true ? (
          <p>저장 이후 검토 상태가 변경되었습니다.</p>
        ) : null}
        {current?.status === 'changed' ? (
          <details>
            <summary>현재 판본</summary>
            <dl>
              <dt>본문</dt>
              <dd>{current.source_revision ?? '확인 불가'}</dd>
              <dt>그래프</dt>
              <dd>{current.graph_revision ?? '확인 불가'}</dd>
              <dt>검토 상태</dt>
              <dd>{current.state_revision ?? '확인 불가'}</dd>
            </dl>
          </details>
        ) : null}
      </section>
      {result.state === 'pending_reconcile' ? (
        <StatusNotice tone="warning" title="영수증 연결 확인 필요">
          저장을 반복하지 말고 현재 결과를 다시 조회해 주세요.
        </StatusNotice>
      ) : null}
      {result.validation_report ? (
        <p className={styles.caption}>
          지정된 자동 검사:{' '}
          {result.validation_report.automatic === 'passed'
            ? '통과'
            : '통과 확인 안 됨'}{' '}
          · 의미 검증:{' '}
          {result.validation_report.semantic.status === 'not_run'
            ? '미실행'
            : result.validation_report.semantic.status}
        </p>
      ) : null}
      <DiagnosticReport
        diagnostics={result.diagnostics}
        draft={result.state === 'draft' && result.saved === false}
      />
      {result.cleanup_failures.length > 0 ? (
        <StatusNotice tone="warning" title="저장 후 임시 파일 정리 안내">
          정리 문제가 {result.cleanup_failures.length}건 있습니다. 저장 여부는
          위 영수증을 기준으로 확인합니다.
        </StatusNotice>
      ) : null}
      <small className={styles.identifier}>
        제출 번호: {result.request_id}
      </small>
    </article>
  );
}

/** 로컬 실행 상태와 서버 저장 상태를 구분하고 부분 성공·조회 실패를 함께 보여줍니다. */
export function AnalysisResult({
  detail,
  source,
}: AnalysisResultProps): JSX.Element {
  const job = detail.job;
  const summary = job.result_summary;
  const tone =
    summary.status === 'complete'
      ? 'success'
      : summary.status === 'not_started'
        ? 'info'
        : 'warning';
  const sameVersion =
    job.source_ref.source_version === source.sourceVersion &&
    job.source_ref.source_sha256 === source.sourceSha256;
  return (
    <section className={styles.results} aria-label="분석 결과">
      <StatusNotice tone={tone} title={resultTitle(job)}>
        서버 확인 {summary.saved_count} / {summary.required_count}개 저장
        {job.state === 'cancelled' ? (
          <p>작업이 취소되었습니다. 이미 저장된 결과는 보존됩니다.</p>
        ) : null}
      </StatusNotice>
      <p className={styles.caption}>
        {detail.local.message ||
          '이 컴퓨터에서 실행 중인 작업이 없습니다. 서버 저장 결과를 조회했습니다.'}
      </p>
      <p className={styles.caption}>
        진단 의견은 클라이언트 보고 · 서버의 의미 정확도 인증·사람 승인 없음
      </p>
      {!sameVersion ? (
        <StatusNotice tone="warning" title="다른 원본 판본의 작업">
          선택한 원본 판본과 이 작업의 입력 판본이 다릅니다. 당시 저장 결과를
          표시합니다.
        </StatusNotice>
      ) : null}
      {job.basis_status !== 'current' ? (
        <StatusNotice tone="warning" title="분석 기준 변경">
          입력 기준이 변경되었거나 확인되지 않습니다. 기존 결과를 최신 기준의
          분석으로 해석하지 마세요.
        </StatusNotice>
      ) : null}
      <details>
        <summary>작업·입력 기준</summary>
        <dl>
          <dt>작업 번호</dt>
          <dd>{job.job_id}</dd>
          <dt>작업 접수 관점</dt>
          <dd>{job.actor.profile_id}</dd>
          <dt>접수 관점의 영역</dt>
          <dd>{job.actor.domain ?? '지정 없음'}</dd>
          <dt>접수 관점</dt>
          <dd>{job.actor.viewpoint ?? '지정 없음'}</dd>
          <dt>현재 조회 관점</dt>
          <dd>{source.scope.profileId}</dd>
          <dt>요청 시각</dt>
          <dd>{job.created_at}</dd>
          <dt>원본 판본</dt>
          <dd>{job.source_ref.source_version}</dd>
          <dt>원본 SHA-256</dt>
          <dd>{job.source_ref.source_sha256}</dd>
          <dt>대상 문서</dt>
          <dd>
            {job.targets
              .map(
                (target: AnalysisJob['targets'][number]): string =>
                  target.document,
              )
              .join(', ')}
          </dd>
          <dt>작업 판본</dt>
          <dd>{job.job_revision}</dd>
          <dt>사용권 상태</dt>
          <dd>
            {job.lease_status === 'active'
              ? '실행 중'
              : job.lease_status === 'expired'
                ? '만료됨'
                : '실행 전'}
          </dd>
        </dl>
      </details>
      {detail.receiptErrors.length > 0 ? (
        <StatusNotice tone="warning" title="일부 영수증을 읽지 못했습니다">
          현재 결과 새로고침으로 다시 확인해 주세요. 저장을 다시 실행하지
          않습니다.
        </StatusNotice>
      ) : null}
      {detail.receipts.map((result: AnalysisReceipt): JSX.Element => (
        <StoredResult key={result.request_id} result={result} />
      ))}
      {summary.status === 'pending_reconcile' &&
      detail.receipts.length === 0 ? (
        <p>
          영수증과 저장소의 상태를 대조해야 합니다. 같은 분석을 새로 실행하기
          전에 서버 상태를 확인해 주세요.
        </p>
      ) : null}
    </section>
  );
}

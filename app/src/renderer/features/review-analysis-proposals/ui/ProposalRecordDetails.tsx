import type { JSX } from 'react';
import type {
  KnowledgeJson,
  KnowledgeValue,
} from '@contracts/knowledge.contract';
import { formatTimestamp } from '@renderer/shared/lib/formatTimestamp';
import type {
  ProposalRecord,
  ProposalClaim,
} from '../model/analysisProposal.schema';
import {
  ProposalGraphDetails,
  ProposalClaimDetails,
} from './ProposalGraphDetails';
import { ProposalValue } from './ProposalValue';

type ProposalRecordDetailsProps = { record: ProposalRecord };
type ProposalActivityProps = {
  items: KnowledgeValue[];
  record: ProposalRecord;
};
const activityLabels: Record<string, string> = {
  prepared: '원문 준비',
  candidate_submitted: '후보 제출',
  candidate_linked: '후보 연결',
  missing_decision: '사라진 관계 판단',
  comparison_completed: '선택 범위 검토 완료',
  applied: '반영',
  keep: '복구 초안',
  exclude: '이번 비교에서 제외',
  reextract: '재추출 요청',
  accept: '확인',
  reject: '기각',
  defer: '보류',
  edit: '정정',
};

/** 기록의 업무상 이유·인용·시각·실제 검토 대상을 참조값 대신 표시합니다. */
export function ProposalActivity({
  items,
  record,
}: ProposalActivityProps): JSX.Element {
  return (
    <ol>
      {items.map((item: KnowledgeValue, index: number): JSX.Element => {
        const action =
          typeof item.action === 'string'
            ? item.action
            : typeof item.kind === 'string'
              ? item.kind
              : '';
        const old = item.old_claim;
        const oldValue =
          old !== null && typeof old === 'object' && !Array.isArray(old)
            ? old.value
            : null;
        const reviewed = Array.isArray(item.reviewed_claim_ids)
          ? item.reviewed_claim_ids
          : [];
        const timestamp =
          typeof item.recorded_at === 'string'
            ? item.recorded_at
            : typeof item.timestamp === 'string'
              ? item.timestamp
              : null;
        return (
          <li key={index}>
            <strong>
              {activityLabels[action] ?? '처리 기록'} {index + 1}
            </strong>
            {timestamp && <p>{formatTimestamp(timestamp)}</p>}
            {oldValue &&
              typeof oldValue === 'object' &&
              !Array.isArray(oldValue) && (
                <ProposalClaimDetails
                  value={oldValue}
                  graph={record.basis.previous.graph}
                />
              )}
            {typeof item.reason === 'string' && <p>이유: {item.reason}</p>}
            {typeof item.evidence === 'string' && item.evidence && (
              <blockquote>{item.evidence}</blockquote>
            )}
            {typeof item.checked_whole === 'boolean' && (
              <p>
                현재 전체 원문:{' '}
                {item.checked_whole ? '확인함' : '확인 기록 없음'}
              </p>
            )}
            {reviewed.length > 0 && (
              <>
                <p>검토한 관계 · {reviewed.length}개</p>
                <ul>
                  {reviewed.map(
                    (id: KnowledgeJson, selected: number): JSX.Element => {
                      const claim = record.preview_claims.find(
                        (value: ProposalClaim): boolean =>
                          value.claim_id === id,
                      );
                      return (
                        <li key={selected}>
                          {claim ? (
                            <ProposalClaimDetails
                              value={claim.value}
                              graph={record.submission}
                            />
                          ) : (
                            '당시 선택한 관계 · 현재 후보에서 확인할 수 없음'
                          )}
                        </li>
                      );
                    },
                  )}
                </ul>
              </>
            )}
            {item.coverage === 'explicit_missing_and_selected_claims_only' && (
              <p>사라진 관계 처리와 선택한 주장에 한정한 완료 기록입니다.</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 보존된 추출 결과의 전체 업무 내용과 원문·판단을 구조화해서 제공합니다. */
export function ProposalRecordDetails({
  record,
}: ProposalRecordDetailsProps): JSX.Element {
  return (
    <>
      <p>문서: {record.basis.target_document}</p>
      <p>
        {record.basis_status === 'current'
          ? '조회 당시에는 입력 기준과 자료가 같았습니다.'
          : '조회 당시 입력이 바뀌었거나 현재성을 확인할 수 없었습니다.'}
      </p>
      <ProposalGraphDetails graph={record.submission} />
      <details>
        <summary>당시 원문과 맥락</summary>
        {record.basis.documents.map(
          (item: KnowledgeValue, index: number): JSX.Element => {
            const source = item.source;
            const content =
              source !== null &&
              typeof source === 'object' &&
              !Array.isArray(source)
                ? source.content
                : null;
            return (
              <section key={index}>
                <h4>
                  {typeof item.document === 'string'
                    ? item.document
                    : '맥락 문서'}
                </h4>
                {typeof item.reason === 'string' && (
                  <p>
                    {['native_wiki_target', 'proposal_input'].includes(
                      item.reason,
                    )
                      ? '분석 대상 문서'
                      : item.reason}
                  </p>
                )}
                {typeof item.required === 'boolean' && (
                  <p>{item.required ? '필수 근거 문서' : '보조 맥락 문서'}</p>
                )}
                {typeof content === 'string' ? (
                  <pre>{content}</pre>
                ) : (
                  <p>당시 원문을 확보하지 못했습니다.</p>
                )}
              </section>
            );
          },
        )}
      </details>
      <details>
        <summary>이전 추출과 검토</summary>
        {record.basis.previous.source &&
          typeof record.basis.previous.source.content === 'string' && (
            <pre>{record.basis.previous.source.content}</pre>
          )}
        <ProposalGraphDetails graph={record.basis.previous.graph} />
        {record.basis.previous.claims.map(
          (claim: ProposalClaim): JSX.Element => (
            <section key={claim.claim_id}>
              <p>검토: {activityLabels[claim.decision] ?? '미검토'}</p>
              <ProposalClaimDetails
                value={claim.value}
                graph={record.basis.previous.graph}
              />
            </section>
          ),
        )}
      </details>
      {record.decisions.length > 0 && (
        <details>
          <summary>사라진 관계 판단</summary>
          <ProposalActivity items={record.decisions} record={record} />
        </details>
      )}
      {record.events.length > 0 && (
        <details>
          <summary>처리·완료 기록</summary>
          <ProposalActivity items={record.events} record={record} />
        </details>
      )}
      {Array.isArray(record.warnings) && (
        <ProposalValue value={record.warnings} />
      )}
    </>
  );
}

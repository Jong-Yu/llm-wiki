import { documentDisplayName } from '@renderer/domains/documents';
import { relationPredicateLabel } from '@renderer/shared/lib/relationPredicateLabels';
import type { KnowledgeJson } from '@contracts/knowledge.contract';
import type {
  ReviewQueueResponse,
  ReviewQueueResponseItem,
} from './reviewQueue.schema';
import type {
  ReviewQueueItem,
  ReviewQueuePage,
  ReviewQueueState,
} from './reviewQueue.types';

/** 응답에 명시된 이름만 사용하고 개체 참조 문자열을 이름으로 추정하지 않습니다. */
function explicitLabel(value: KnowledgeJson | undefined): string {
  if (typeof value === 'string')
    return /[\s\u0080-\uffff]/.test(value) ? value : '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const label = value.label ?? value.name;
  return typeof label === 'string' ? label : '';
}

/** 추출 상태를 사용자가 다음 행동을 판단할 수 있는 안내로 바꿉니다. */
function graphStatusLabel(status: string): string {
  switch (status) {
    case 'stale':
      return '원문 변경으로 재확인 필요';
    case 'missing':
      return '저장된 추출 결과 없음';
    case 'ready':
      return '추출 결과 확인 가능';
    case 'invalid':
    case 'corrupt':
      return '저장된 추출 결과 확인 필요';
    default:
      return '추출 상태 확인 필요';
  }
}

/** 저장된 인용 객체는 실제 quote와 전체파일 기준 줄 위치만 읽기 쉽게 표시합니다. */
function displayEvidence(
  value: KnowledgeJson | undefined,
): ReviewQueueItem['evidence'] {
  if (typeof value === 'string')
    return value ? { quote: value, location: null } : undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.quote !== 'string'
  )
    return undefined;
  const start = value.start_line;
  const end = value.end_line;
  const lines =
    typeof start === 'number' &&
    Number.isInteger(start) &&
    start > 0 &&
    typeof end === 'number' &&
    Number.isInteger(end) &&
    end >= start
      ? `원문 ${start === end ? `${start}줄` : `${start}–${end}줄`}`
      : null;
  return value.quote ? { quote: value.quote, location: lines } : undefined;
}

/** 서버가 판별한 종류와 근거를 기존 문서 검토·재추출 주소에 연결합니다. */
function presentItem(item: ReviewQueueResponseItem): ReviewQueueItem {
  const base = {
    key: item.key,
    kind: item.kind,
    status: item.status,
    reference: item.ref.reference,
    statusLabel:
      item.status === 'unreviewed'
        ? '검토 대기'
        : item.status === 'defer'
          ? '보류'
          : '다시 검토',
  };
  if (item.kind === 'correspondence_judgment')
    return {
      ...base,
      title: '문서 대응 판단',
      detail:
        '문서 대응 메뉴가 숨겨져 있습니다. 이 항목은 검토 대상 건수에 포함됩니다.',
      document: null,
      href: null,
      actionLabel: null,
    };
  const document = item.ref.reference;
  const path = encodeURIComponent(document);
  if (item.kind === 'document_graph') {
    const stale = item.graph_status === 'stale';
    return {
      ...base,
      document,
      statusLabel: stale ? '추출 기준 변경' : '추출 상태 확인',
      title: stale ? '원문 변경 후 관계 재확인' : '관계 추출 상태 확인',
      detail: `${graphStatusLabel(item.graph_status)}. 저장된 본문과 기존 추출 결과를 확인한 뒤 재추출을 준비할 수 있습니다.`,
      href: `/document?path=${path}`,
      actionLabel: '재추출 확인',
    };
  }
  if (item.kind === 'pending_document_event')
    return {
      ...base,
      document,
      statusLabel: '이전 기준 판단',
      title: '이전 기준의 검토 기록',
      detail: '현재 기준에 적용되지 않은 검토 기록입니다.',
      href: `/ontology?path=${path}&view=reviews`,
      actionLabel: '과거 검토 기록',
    };
  const value = item.claim.reviewed_value;
  const collectionLabel =
    item.claim.collection === 'relation_candidates'
      ? '연결 후보'
      : item.claim.collection === 'attributes'
        ? '속성'
        : '원문 주장';
  const predicate = value.predicate ?? value.property;
  const subject =
    typeof value.subject_label === 'string'
      ? value.subject_label
      : explicitLabel(value.subject);
  const object =
    typeof value.object_label === 'string'
      ? value.object_label
      : explicitLabel(value.object);
  const namedTitle = [
    subject || collectionLabel,
    typeof predicate === 'string' ? relationPredicateLabel(predicate) : '',
    object,
  ]
    .filter(Boolean)
    .join(' · ');
  const evidenceValue = value.evidence ?? item.claim.value.evidence;
  const evidence = displayEvidence(evidenceValue);
  return {
    ...base,
    document,
    claimId: item.claim.claim_id,
    title: namedTitle,
    excerpt: !subject && !object ? evidence?.quote : undefined,
    evidence,
    detail: [
      ...(item.status === 'defer'
        ? ['보류된 판단의 원문과 현재 값을 확인해 주세요.']
        : []),
      ...(!evidence
        ? ['이 목록에 직접 인용이 없습니다. 상세에서 원문을 확인해 주세요.']
        : []),
    ].join('\n'),
    href: `/ontology?path=${path}&document=${path}&view=detail&claim=${encodeURIComponent(item.claim.claim_id)}`,
    actionLabel: '주장 검토',
  };
}

/** 다음 페이지와 실제 자료 누락을 구분하고 대응 항목도 건수에서 보존합니다. */
export function presentReviewQueue(
  value: ReviewQueueResponse,
  scopeKey: string,
): ReviewQueuePage {
  const items = value.items.map(presentItem);
  const messages: string[] = [];
  if (!value.scope_complete)
    messages.push(
      '일부 자료를 확인하지 못했습니다. 조회된 항목만으로 전체 검토 대상이 없다고 판단할 수 없습니다.',
    );
  if (value.truncated)
    messages.push(
      '조회 한도에 도달했습니다. 일부 검토 대상은 이 목록에 포함되지 않았습니다.',
    );
  return {
    scopeKey,
    items,
    nextCursor: value.next_cursor,
    totalItems: value.total_items,
    snapshotRevision: value.snapshot_revision,
    scopeComplete: value.scope_complete,
    complete: value.complete,
    truncated: value.truncated,
    skipped: value.skipped,
    requiresRefresh: value.requires_refresh,
    messages,
    hiddenCorrespondenceCount: items.filter(
      (entry: ReviewQueueItem): boolean =>
        entry.kind === 'correspondence_judgment',
    ).length,
  };
}

/** 서버 항목의 종류를 주장·과거 판단·추출 상태·문서 대응으로 구별합니다. */
export function reviewQueueKindLabel(kind: string): string {
  switch (kind) {
    case 'document_claim':
      return '문서 주장';
    case 'pending_document_event':
      return '이전 검토';
    case 'document_graph':
      return '추출 상태';
    case 'correspondence_judgment':
      return '문서 간 대응';
    default:
      return '검토 대상';
  }
}

/** 조회하지 못한 원인을 표시하며 누락을 검토할 항목 없음으로 해석하지 않습니다. */
export function reviewQueueSkippedReason(code: string): string {
  if (code.endsWith('limit')) return '조회 한도에 도달했습니다';
  switch (code) {
    case 'not_found':
      return '대상을 찾을 수 없습니다';
    case 'permission_denied':
      return '대상을 읽을 수 없습니다';
    case 'missing_dependency':
      return '관련 문서나 판단을 확인하지 못했습니다';
    case 'review_corrupt':
    case 'ontology_corrupt':
    case 'correspondence_corrupt':
    case 'invalid_stored_input':
      return '보관된 자료를 확인해야 합니다';
    case 'document_too_large':
      return '문서가 조회 가능한 크기를 넘었습니다';
    case 'invalid_utf8':
      return '문서의 문자 형식을 읽을 수 없습니다';
    default:
      return '이번 조회에서 확인하지 못했습니다';
  }
}

export type ReviewGroup = { name: string; items: ReviewQueueItem[] };
type ReviewQueueSummary = {
  groups: ReviewGroup[];
  counts: Record<ReviewQueueState, number>;
};

/** 서버 순서를 유지하며 문서별 묶음과 상태별 건수를 한 번에 집계합니다. */
export function summarizeReviewQueue(
  items: readonly ReviewQueueItem[],
): ReviewQueueSummary {
  const groups = new Map<string, ReviewGroup>();
  const counts: Record<ReviewQueueState, number> = {
    unreviewed: 0,
    defer: 0,
    pending: 0,
  };
  for (const item of items) {
    const name = item.document
      ? documentDisplayName(item.document)
      : '문서 간 대응';
    const group = groups.get(name);
    if (group) group.items.push(item);
    else groups.set(name, { name, items: [item] });
    counts[item.status]++;
  }
  return { groups: [...groups.values()], counts };
}

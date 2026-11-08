import type { KnowledgeValue } from '@contracts/knowledge.contract';
import { documentDisplayName } from '@renderer/domains/documents';
import { isPublicWebUrl } from '@contracts/webEvidence.contract';

type CitationFact = { label: string; text: string };
const decisions: Record<string, string> = {
  unreviewed: '미검토',
  accept: '원문 대조 확인',
  edit: '원문 근거 정정',
  reject: '거절',
  defer: '보류',
  undo: '원문 검토 되돌림',
  policy: '업무 판단',
  policy_undo: '전문가 판단 되돌림',
  relation_create: '새 관계 추가',
  relation_undo: '관계 추가 되돌림',
};

/** 보관된 판단의 이유·범위만 읽기용 속성으로 옮기며 내부 참조는 표시하지 않습니다. */
export function citationFacts(value: KnowledgeValue): CitationFact[] {
  const facts: CitationFact[] = [];
  const action = citationText(value, 'action');
  const decision = citationText(value, 'review_decision');
  if (action)
    facts.push({ label: '검토 내용', text: decisions[action] || '검토 기록' });
  if (decision)
    facts.push({
      label: '인용 당시 원문 검토',
      text: decisions[decision] || '상태 확인 필요',
    });
  const reason = citationText(value, 'reason');
  if (reason) facts.push({ label: '판단 이유', text: reason });
  if (citationText(value, 'policy_status') === 'active')
    facts.push({ label: '인용 당시 판단 상태', text: '적용 중' });
  const actor = value.actor;
  if (actor && typeof actor === 'object' && !Array.isArray(actor)) {
    const name = citationText(actor, 'display_name');
    if (name) facts.push({ label: '작성자', text: name });
  }
  const scope = value.policy_scope;
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    const domain = citationText(scope, 'domain');
    const viewpoint = citationText(scope, 'viewpoint');
    if (domain || scope.domain === null)
      facts.push({ label: '업무 영역', text: domain || '전체 영역' });
    if (viewpoint || scope.viewpoint === null)
      facts.push({ label: '관점', text: viewpoint || '전체 관점' });
  }
  if (citationText(value, 'layer') === 'reported_conversion')
    facts.push({
      label: '원문 확인 범위',
      text: '이 PC에서 변환한 문자에 근거합니다. 원본 전체의 포함 여부와 의미 정확도는 검증되지 않았습니다.',
    });
  return facts;
}
/** JSON 인용의 값만 표시하며 없는 문서나 위치를 만들어 넣지 않습니다. */
export function citationText(value: KnowledgeValue, key: string): string {
  const item = value[key];
  return typeof item === 'string' || typeof item === 'number'
    ? String(item)
    : '';
}
/** 근거 칩에 쓰는 짧은 줄 범위입니다. 없는 위치는 만들지 않습니다. */
function citationLines(value: KnowledgeValue): string {
  const start = citationText(value, 'start_line');
  const end = citationText(value, 'end_line');
  if (start && end) return start === end ? `${start}줄` : `${start}–${end}줄`;
  return start ? `${start}줄부터` : end ? `${end}줄까지` : '';
}
/** 근거 칩 이름: 문서 이름과 줄 범위. */
export function citationChip(value: KnowledgeValue): string {
  if (citationText(value, 'kind') === 'web')
    return `웹 · ${citationText(value, 'title') || '외부 웹 자료'}`;
  const document = citationText(value, 'document');
  const name = document ? documentDisplayName(document) : '근거 자료';
  const lines = citationLines(value);
  return lines ? `${name} · ${lines}` : name;
}
/** 기계 주장·전문가 Action log·문서 인용을 같은 종류로 표시하지 않습니다. */
export function citationKind(value: KnowledgeValue): string {
  const kind = citationText(value, 'kind');
  return kind === 'policy'
    ? '전문가 판단 · Action log'
    : kind === 'review'
      ? '검토 이력'
      : kind === 'claim'
        ? '온톨로지 주장'
        : kind === 'source'
          ? '보관 원본'
          : kind === 'web'
            ? '외부 웹 자료 · 미검토'
            : kind === 'document'
              ? '문서 인용'
              : '저장된 근거';
}

/** 외부 링크는 공개 웹 주소만 표시하며 자격 증명·내부 호스트·파일 실행 주소를 제외합니다. */
export function citationWebUrl(value: KnowledgeValue): string | null {
  if (citationText(value, 'kind') !== 'web') return null;
  try {
    const url = citationText(value, 'url');
    return isPublicWebUrl(url) ? new URL(url).href : null;
  } catch {
    return null;
  }
}

/** 답변 당시 보관된 웹 조회 상태만 읽으며 이전 답변의 웹 결과를 대신 쓰지 않습니다. */
export function webBasisSummary(
  basis: KnowledgeValue | undefined,
): string | null {
  const web = basis?.web;
  if (!web || typeof web !== 'object' || Array.isArray(web)) return null;
  const count = Array.isArray(web.sources) ? web.sources.length : 0;
  switch (web.status) {
    case 'complete':
      return `외부 웹 자료 ${count}개 확인`;
    case 'partial':
      return `외부 웹 자료 ${count}개 확인 · 일부 자료만 확인`;
    case 'empty':
      return '외부 웹 검색 · 읽을 수 있는 자료 없음';
    case 'unavailable':
      return '외부 웹 검색 · 조회하지 못함';
    default:
      return '외부 웹 검색 · 상태 확인 필요';
  }
}

/** 제공된 확인 시각만 사용자 환경의 날짜·시각으로 표시합니다. */
export function citationRetrievedAt(value: KnowledgeValue): string {
  const text = citationText(value, 'retrieved_at');
  const date = new Date(text);
  if (!text || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

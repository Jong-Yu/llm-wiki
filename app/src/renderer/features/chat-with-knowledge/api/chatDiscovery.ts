/** 질문에서 문서 검색어를 만들고, 검색 결과를 관련도 순으로 정렬하는 순수 함수입니다. */

const MAX_TERMS = 8;
const MAX_PHRASE_LENGTH = 40;
const MAX_TERM_LENGTH = 200;
const MAX_MERGED_TERMS = 12;
export const MAX_DOCUMENTS = 8;
/** 연결을 따라갈 상위 문서 수와, 그 연결 문서에 남겨 두는 자리 수입니다. */
export const LINK_SEEDS = 3;
const LINK_RESERVE = 3;

// 긴 조사부터 비교해야 '에서부터'가 '에서'보다 먼저 제거됩니다.
const PARTICLES = [
  '으로부터',
  '에서부터',
  '으로서',
  '으로써',
  '에게서',
  '입니다',
  '까지',
  '부터',
  '에서',
  '에게',
  '으로',
  '처럼',
  '보다',
  '이나',
  '하고',
  '이랑',
  '이다',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '도',
  '만',
  '과',
  '와',
  '로',
  '나',
];

// 질문의 형식을 이루는 말로, 문서의 내용을 가리키지 않습니다.
const STOPWORDS = new Set([
  '알려줘',
  '알려주세요',
  '알려줄래',
  '보여줘',
  '찾아줘',
  '정리해',
  '정리해줘',
  '뭐야',
  '뭔가요',
  '무엇',
  '어떤',
  '어떻게',
  '있어',
  '있나요',
  '있는지',
  '해줘',
  '주세요',
  '대해',
  '대한',
  '관련',
  '그리고',
  '이번',
]);

/** 끝의 조사 하나를 떼되, 남는 말이 두 글자 미만이면 원래 말을 유지합니다. */
export function stripParticle(word: string): string {
  for (const particle of PARTICLES)
    if (word.endsWith(particle) && word.length - particle.length >= 2)
      return word.slice(0, -particle.length);
  return word;
}

/**
 * 짧은 질문은 전체 문장도 검색어로 쓰고, 이어서 조사를 뗀 단어를 등장 순서대로 최대 8개 고릅니다.
 * 한국어는 두 글자 명사가 많아 길이로 거르지 않습니다.
 * 부분 문자열 검색이므로 조사를 뗀 단어는 조사가 붙은 본문도 함께 찾습니다.
 */
export function discoveryTerms(question: string): string[] {
  const phrase = question.trim().slice(0, MAX_TERM_LENGTH);
  if (!phrase) return [];
  const terms: string[] = [];
  if (phrase.length <= MAX_PHRASE_LENGTH) terms.push(phrase);
  const words = question.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const stems = new Set<string>();
  for (const word of words) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    const stem = stripParticle(word).slice(0, MAX_TERM_LENGTH);
    if (stem.length >= 2 && !STOPWORDS.has(stem) && stem !== phrase)
      stems.add(stem);
  }
  for (const stem of stems) {
    if (terms.length >= MAX_TERMS) break;
    terms.push(stem);
  }
  return terms;
}

/**
 * AI가 풀어 준 검색어를 먼저, 조사를 뗀 질문 단어를 뒤에 합쳐 중복 없이 최대 12개만 씁니다.
 * 검색어마다 위키 전체를 한 번 읽으므로 합계에 상한을 둡니다. AI 결과가 없으면 질문 단어만 남습니다.
 */
export function mergeTerms(expanded: string[], local: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const term of [...expanded, ...local]) {
    const value = term.trim().slice(0, MAX_TERM_LENGTH);
    const key = value.normalize('NFC').toLowerCase();
    if (value.length < 2 || seen.has(key)) continue;
    seen.add(key);
    merged.push(value);
    if (merged.length >= MAX_MERGED_TERMS) break;
  }
  return merged;
}

/**
 * 적은 문서에서만 나타난 검색어일수록 높은 점수를 줘서, 흔한 단어가 많이 걸린 문서보다
 * 구체적인 단어가 걸린 문서를 앞에 둡니다. 동점은 경로 순서를 유지합니다.
 */
export function rankDocuments(hits: Map<string, string[]>): string[] {
  const scores = new Map<string, number>();
  for (const documents of hits.values()) {
    const unique = new Set(documents);
    const weight = 1 / Math.log(2 + unique.size);
    for (const document of unique)
      scores.set(document, (scores.get(document) ?? 0) + weight);
  }
  return [...scores.entries()]
    .sort(
      (left: [string, number], right: [string, number]): number =>
        right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map((entry: [string, number]): string => entry[0]);
}

/** 문서 하나의 명시 링크에서, 실제로 읽을 수 있는 반대편 문서만 꺼냅니다. */
export function linkedDocuments(
  focus: string,
  links: {
    source_document: string;
    target_document: string;
    target_status: string;
  }[],
): string[] {
  const found: string[] = [];
  for (const link of links) {
    if (link.target_status !== 'resolved') continue;
    const other =
      link.source_document === focus
        ? link.target_document
        : link.source_document;
    if (other !== focus && !found.includes(other)) found.push(other);
  }
  return found;
}

/**
 * 검색 순위 상위 문서를 우선하되, 연결된 문서에 최대 3자리를 남겨 합쳐 8개를 만듭니다.
 * 연결 문서는 상위 문서별로 돌아가며 한 개씩 고르고, 자리가 남으면 검색 순위로 채웁니다.
 * added는 연결 덕분에 새로 들어온 문서 수입니다.
 */
export function composeDocuments(
  ranked: string[],
  linkedBySeed: string[][],
): { documents: string[]; added: number } {
  const plain = ranked.slice(0, MAX_DOCUMENTS);
  const interleaved: string[] = [];
  for (let round = 0; ; round += 1) {
    let any = false;
    for (const list of linkedBySeed) {
      const document = list[round];
      if (document === undefined) continue;
      any = true;
      if (!interleaved.includes(document)) interleaved.push(document);
    }
    if (!any) break;
  }
  const reserve = Math.min(
    LINK_RESERVE,
    interleaved.filter((value: string): boolean => !plain.includes(value))
      .length,
  );
  const documents = ranked.slice(0, MAX_DOCUMENTS - reserve);
  for (const document of interleaved) {
    if (documents.length >= MAX_DOCUMENTS) break;
    if (!documents.includes(document)) documents.push(document);
  }
  for (const document of ranked) {
    if (documents.length >= MAX_DOCUMENTS) break;
    if (!documents.includes(document)) documents.push(document);
  }
  return {
    documents,
    added: documents.filter((value: string): boolean => !plain.includes(value))
      .length,
  };
}

/** 검색어 생성에는 자료 전체가 아니라 앞부분 발췌만 보냅니다. 총 길이는 호출 한도(2000자) 안입니다. */
export function searchBrief(question: string, material: string): string {
  const body = material.trim();
  if (!body) return question.slice(0, 2000);
  const head = question.slice(0, 500);
  return `${head}\n\n[붙여넣은 자료 발췌]\n${body.slice(0, 2000 - head.length - 20)}`;
}

export type DocumentEvidenceLocation = {
  document: string;
  revision: string;
  startLine: number | null;
  endLine: number | null;
  quote: string | null;
  occurrence: number | null;
};
export type DocumentEvidenceMatch =
  | { status: 'matched'; startLine: number; endLine: number }
  | { status: 'changed' | 'unavailable' };
type EvidenceDocument = {
  document: string;
  revision: string;
  content: string;
  body?: string;
  bodyStartLine?: number;
};
type DocumentEvidenceLink = {
  to: string;
  state?: {
    documentEvidence?: DocumentEvidenceLocation;
    ontologyReturnTo?: string;
  };
};

/** 표시용 근거 값에서 위치·인용만 읽으며 실행할 데이터로 해석하지 않습니다. */
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function line(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
function parameterLine(value: string | null): number | null {
  return value && /^[1-9]\d*$/.test(value) ? line(Number(value)) : null;
}

/** 근거 읽기에서 돌아갈 수 있는 앱 안의 온톨로지 주소만 허용합니다. */
function ontologyReturnLocation(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\/ontology(?:\?[^#\\]*)?$/.test(value))
    return null;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return null;
  }
  return value;
}

/** 문서의 뒤로가기는 검증된 근거 탐색 위치가 있으면 그곳으로 복귀합니다. */
export function documentEvidenceReturnTo(state: unknown): string | null {
  return ontologyReturnLocation(record(state)?.ontologyReturnTo);
}

/** 긴 인용은 주소에 복사하지 않고 같은 앱의 탐색 상태에 보존합니다. */
export function documentEvidenceLink(
  document: string,
  revision: string,
  evidence: unknown,
  returnTo?: string,
): DocumentEvidenceLink {
  const parameters = new URLSearchParams({ path: document });
  const ontologyReturnTo = ontologyReturnLocation(returnTo);
  const returnState = ontologyReturnTo ? { ontologyReturnTo } : {};
  const value = record(evidence);
  const quote =
    typeof evidence === 'string'
      ? evidence
      : typeof value?.quote === 'string'
        ? value.quote
        : null;
  const startLine = line(value?.start_line);
  const endLine = line(value?.end_line) ?? startLine;
  if (!/^[a-f0-9]{64}$/.test(revision) || (!startLine && !quote))
    return {
      to: `/document?${parameters}`,
      ...(ontologyReturnTo ? { state: returnState } : {}),
    };
  const occurrence =
    typeof value?.occurrence === 'number' &&
    Number.isSafeInteger(value.occurrence) &&
    value.occurrence >= 0
      ? value.occurrence
      : null;
  parameters.set('evidence', '1');
  parameters.set('sourceRevision', revision);
  if (startLine) parameters.set('startLine', String(startLine));
  if (endLine) parameters.set('endLine', String(endLine));
  return {
    to: `/document?${parameters}`,
    state: {
      ...returnState,
      documentEvidence: {
        document,
        revision,
        startLine,
        endLine,
        quote,
        occurrence,
      },
    },
  };
}

/** 주소와 탐색 이력이 같은 문서·판본을 가리킬 때만 인용을 채택합니다. */
export function readDocumentEvidence(
  parameters: URLSearchParams,
  state: unknown,
  document: string,
): DocumentEvidenceLocation | null {
  const revision = parameters.get('sourceRevision') ?? '';
  if (parameters.get('evidence') !== '1' || !/^[a-f0-9]{64}$/.test(revision))
    return null;
  const startLine = parameterLine(parameters.get('startLine'));
  const endLine = parameterLine(parameters.get('endLine')) ?? startLine;
  const stored = record(record(state)?.documentEvidence);
  const matches =
    stored?.document === document &&
    stored.revision === revision &&
    stored.startLine === startLine &&
    stored.endLine === endLine;
  return {
    document,
    revision,
    startLine,
    endLine,
    quote: matches && typeof stored.quote === 'string' ? stored.quote : null,
    occurrence:
      matches &&
      typeof stored.occurrence === 'number' &&
      Number.isSafeInteger(stored.occurrence) &&
      stored.occurrence >= 0
        ? stored.occurrence
        : null,
  };
}

/** 전체 파일의 행 좌표를 보존하며 현재 읽는 본문에 존재하는 인용만 대조합니다. */
export function matchDocumentEvidence(
  current: EvidenceDocument,
  location: DocumentEvidenceLocation,
): DocumentEvidenceMatch {
  if (
    current.document !== location.document ||
    current.revision !== location.revision
  )
    return { status: 'changed' };
  const lines = current.content.split(/\r\n|\r|\n/);
  const bodyStart = documentBodyStartLine(current);
  let startLine = location.startLine;
  let endLine = location.endLine;
  if (!startLine || !endLine) {
    if (!location.quote) return { status: 'unavailable' };
    const offsets: number[] = [];
    let offset = current.content.indexOf(location.quote);
    while (offset !== -1) {
      offsets.push(offset);
      offset = current.content.indexOf(location.quote, offset + 1);
    }
    const occurrence = location.occurrence ?? (offsets.length === 1 ? 0 : -1);
    const found = offsets[occurrence];
    if (found === undefined) return { status: 'unavailable' };
    startLine = current.content.slice(0, found).split(/\r\n|\r|\n/).length;
    endLine = startLine + location.quote.split(/\r\n|\r|\n/).length - 1;
  }
  if (startLine < bodyStart || endLine < startLine || endLine > lines.length)
    return { status: 'unavailable' };
  if (location.quote) {
    const requested = lines.slice(startLine - 1, endLine).join('\n');
    const normalized = location.quote.replace(/\r\n|\r/g, '\n');
    if (!requested.includes(normalized)) return { status: 'unavailable' };
  }
  return { status: 'matched', startLine, endLine };
}

/** 본문 분리 이전의 행 번호를 계산하며 위치를 확인할 수 없으면 일치시키지 않습니다. */
export function documentBodyStartLine(current: EvidenceDocument): number {
  if (current.body === undefined) return 1;
  return (
    current.bodyStartLine ??
    (current.content.endsWith(current.body)
      ? current.content
          .slice(0, current.content.length - current.body.length)
          .split(/\r\n|\r|\n/).length
      : Infinity)
  );
}

export type ComparedLine = { text: string; ending: string; number: number };
export type ComparisonRow = {
  kind: 'equal' | 'change';
  before?: ComparedLine;
  after?: ComparedLine;
};
export type LineComparison = {
  rows: ComparisonRow[];
  changes: { start: number; end: number }[];
  added: number;
  removed: number;
  coarse: boolean;
};

/** 개행을 각 줄에 붙여 보존하며 빈 파일에 가상의 빈 줄을 만들지 않습니다. */
export function splitExactLines(value: string): ComparedLine[] {
  const lines: ComparedLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) && match[0].length > 0)
    lines.push({
      text: match[1] ?? '',
      ending: match[2] ?? '',
      number: lines.length + 1,
    });
  return lines;
}

/** 동일 줄의 전체 문자열을 키로 사용해 공백·개행 종류도 비교합니다. */
function lineKey(line: ComparedLine): string {
  return line.text + line.ending;
}

/** 유일한 공통 줄의 증가 부분수열을 기준점으로 삼아 큰 문서도 선형 메모리로 나눕니다. */
function anchors(
  before: ComparedLine[],
  after: ComparedLine[],
): [number, number][] {
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  for (let i = 0; i < before.length; i++) {
    const key = lineKey(before[i]!);
    left.set(key, left.has(key) ? -1 : i);
  }
  for (let i = 0; i < after.length; i++) {
    const key = lineKey(after[i]!);
    right.set(key, right.has(key) ? -1 : i);
  }
  const pairs: [number, number][] = [];
  for (const [key, index] of left) {
    const other = right.get(key);
    if (index >= 0 && other !== undefined && other >= 0)
      pairs.push([index, other]);
  }
  const tails: number[] = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]!]![1] < pairs[i]![1]) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const result: [number, number][] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!)
    result.push(pairs[i]!);
  return result.reverse();
}

/** 계산 한도에서는 범위 전체를 변경으로 표시하며 차이나 원문을 생략하지 않습니다. */
export function compareLines(left: string, right: string): LineComparison {
  const before = splitExactLines(left),
    after = splitExactLines(right);
  const rows: ComparisonRow[] = [];
  let budget = 250_000;
  let coarse = false;
  /** 한 변경 구간의 삭제/추가를 나란히 배치합니다. */
  function changed(a: ComparedLine[], b: ComparedLine[]): void {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      rows.push({ kind: 'change', before: a[i], after: b[i] });
  }
  /** 반복 줄은 제한된 LCS로 대조하고 공통 시작/끝은 항상 분리합니다. */
  function gap(a: ComparedLine[], b: ComparedLine[]): void {
    let start = 0;
    while (
      start < Math.min(a.length, b.length) &&
      lineKey(a[start]!) === lineKey(b[start]!)
    ) {
      rows.push({ kind: 'equal', before: a[start], after: b[start] });
      start++;
    }
    let ae = a.length,
      be = b.length;
    while (
      ae > start &&
      be > start &&
      lineKey(a[ae - 1]!) === lineKey(b[be - 1]!)
    ) {
      ae--;
      be--;
    }
    const n = ae - start,
      m = be - start;
    if (!n || !m) changed(a.slice(start, ae), b.slice(start, be));
    else if ((n + 1) * (m + 1) > budget) {
      coarse = true;
      changed(a.slice(start, ae), b.slice(start, be));
    } else {
      budget -= (n + 1) * (m + 1);
      const table = new Uint32Array((n + 1) * (m + 1));
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          table[i * (m + 1) + j] =
            lineKey(a[start + i]!) === lineKey(b[start + j]!)
              ? 1 + table[(i + 1) * (m + 1) + j + 1]!
              : Math.max(
                  table[(i + 1) * (m + 1) + j]!,
                  table[i * (m + 1) + j + 1]!,
                );
      let i = 0,
        j = 0;
      let removed: ComparedLine[] = [],
        added: ComparedLine[] = [];
      while (i < n || j < m) {
        if (
          i < n &&
          j < m &&
          lineKey(a[start + i]!) === lineKey(b[start + j]!)
        ) {
          changed(removed, added);
          removed = [];
          added = [];
          rows.push({
            kind: 'equal',
            before: a[start + i++],
            after: b[start + j++],
          });
        } else if (
          i < n &&
          (j === m ||
            table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!)
        )
          removed.push(a[start + i++]!);
        else added.push(b[start + j++]!);
      }
      changed(removed, added);
    }
    for (let i = ae, j = be; i < a.length; i++, j++)
      rows.push({ kind: 'equal', before: a[i], after: b[j] });
  }
  let ai = 0,
    bi = 0;
  for (const [a, b] of anchors(before, after)) {
    gap(before.slice(ai, a), after.slice(bi, b));
    rows.push({ kind: 'equal', before: before[a], after: after[b] });
    ai = a + 1;
    bi = b + 1;
  }
  gap(before.slice(ai), after.slice(bi));
  const changes: LineComparison['changes'] = [];
  let added = 0,
    removed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.kind === 'equal') continue;
    if (row.before) removed++;
    if (row.after) added++;
    const last = changes.at(-1);
    if (last && last.end === i) last.end++;
    else changes.push({ start: i, end: i + 1 });
  }
  return { rows, changes, added, removed, coarse };
}

/** 유니코드 문자를 자르지 않고 한 줄의 공통 접두·접미 사이 변경을 강조합니다. */
export function inlineChange(
  value: string,
  other: string,
): [string, string, string] {
  const a = Array.from(value),
    b = Array.from(other);
  let start = 0,
    end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (
    end < Math.min(a.length, b.length) - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    a.slice(0, start).join(''),
    a.slice(start, a.length - end).join(''),
    end ? a.slice(-end).join('') : '',
  ];
}

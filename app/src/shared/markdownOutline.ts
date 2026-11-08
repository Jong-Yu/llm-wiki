import type { Token } from 'markdown-it';

/** Markdown을 Excel·PowerPoint로 옮기기 위한 중간 구조입니다. */
export type OutlineBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'item'; level: number; ordered: boolean; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string };

/** 줄 안의 서식을 벗기고 읽는 글자만 남깁니다. 연결은 주소를 괄호로 덧붙입니다. */
function plainText(children: Token[] | null): string {
  let text = '';
  let href: string | null = null;
  for (const token of children ?? []) {
    switch (token.type) {
      case 'softbreak':
      case 'hardbreak':
        text += ' ';
        break;
      case 'link_open': {
        const value = token.attrGet('href');
        href =
          typeof value === 'string' && /^(https?:|mailto:)/i.test(value)
            ? value
            : null;
        break;
      }
      case 'link_close':
        if (href) text += ` (${href})`;
        href = null;
        break;
      case 'text':
      case 'code_inline':
      case 'image':
        text += token.content;
        break;
      default:
        break;
    }
  }
  return text.trim();
}

function closeIndex(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    depth += tokens[index]?.nesting ?? 0;
    if (depth === 0) return index;
  }
  return tokens.length - 1;
}

function tableRows(tokens: Token[]): string[][] {
  const rows: string[][] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.type !== 'tr_open') continue;
    const end = closeIndex(tokens, index);
    const cells: string[] = [];
    for (let cell = index + 1; cell < end; cell += 1) {
      const token = tokens[cell];
      if (token?.type !== 'th_open' && token?.type !== 'td_open') continue;
      cells.push(plainText(tokens[cell + 1]?.children ?? null));
      cell = closeIndex(tokens, cell);
    }
    rows.push(cells);
    index = end;
  }
  return rows;
}

/** Markdown 토큰을 제목·문단·목록·표·코드·인용의 평평한 목록으로 바꿉니다. */
export function outline(tokens: Token[], level: number = 0): OutlineBlock[] {
  const output: OutlineBlock[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    const end = token.nesting === 1 ? closeIndex(tokens, index) : index;
    const inner = tokens.slice(index + 1, end);
    switch (token.type) {
      case 'heading_open':
        output.push({
          kind: 'heading',
          level: Number(token.tag.slice(1)),
          text: plainText(inner[0]?.children ?? null),
        });
        break;
      case 'paragraph_open': {
        const text = plainText(inner[0]?.children ?? null);
        // 목록 항목 안의 문단은 목록 블록으로 이미 표현합니다.
        if (text) output.push({ kind: 'paragraph', text });
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open';
        for (let item = 0; item < inner.length; item += 1) {
          if (inner[item]?.type !== 'list_item_open') continue;
          const itemEnd = closeIndex(inner, item);
          const parts = outline(inner.slice(item + 1, itemEnd), level + 1);
          const first = parts[0];
          if (first?.kind === 'paragraph')
            output.push({ kind: 'item', level, ordered, text: first.text });
          output.push(
            ...(first?.kind === 'paragraph' ? parts.slice(1) : parts).map(
              (value: OutlineBlock): OutlineBlock =>
                value.kind === 'paragraph'
                  ? {
                      kind: 'item',
                      level: level + 1,
                      ordered: false,
                      text: value.text,
                    }
                  : value,
            ),
          );
          item = itemEnd;
        }
        break;
      }
      case 'blockquote_open':
        for (const part of outline(inner, level)) {
          if (part.kind === 'paragraph')
            output.push({ kind: 'quote', text: part.text });
          else output.push(part);
        }
        break;
      case 'table_open':
        output.push({ kind: 'table', rows: tableRows(inner) });
        break;
      case 'fence':
      case 'code_block':
        output.push({ kind: 'code', text: token.content.replace(/\n$/, '') });
        break;
      default:
        break;
    }
    index = end + 1;
  }
  return output;
}

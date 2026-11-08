import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import {
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { ILevelsOptions, ParagraphChild } from 'docx';

/** 변환 실행 실패입니다. 본문·경로·도구 오류 원문은 담지 않습니다. */
export class ConversionFailed extends Error {}

const PDF_STYLE = `<style>
body{font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans CJK KR",sans-serif;font-size:11pt;line-height:1.6;color:#111}
table{border-collapse:collapse}th,td{border:1px solid #888;padding:4px 8px}
pre,code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10pt}
pre{white-space:pre-wrap;background:#f4f4f4;padding:8px}
blockquote{margin:0 0 0 0;padding-left:12px;border-left:3px solid #bbb;color:#444}
</style>`;
const DOCUMENT_FONT = 'Malgun Gothic';
const MONO_FONT = 'Courier New';
const INDENT = 720;
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

/**
 * 원본 HTML 조각은 해석하지 않고 글자로 둡니다. 그림은 외부 파일을 읽지 않도록 대체 글자만 남깁니다.
 * 표·취소선은 markdown-it 기본 규칙을 씁니다.
 */
function createParser(): InstanceType<typeof MarkdownIt> {
  const parser = new MarkdownIt({ html: false, linkify: false });
  parser.renderer.rules.image = (tokens: Token[], index: number): string =>
    parser.utils.escapeHtml(tokens[index]?.content ?? '');
  return parser;
}

/** Markdown을 토큰으로 해석합니다. 원본 HTML은 해석하지 않고 글자로 남습니다. */
export function parseMarkdown(content: string): Token[] {
  return createParser().parse(content, {});
}

/** Markdown을 독립 HTML 문서 문자열로 바꿉니다. 스크립트·외부 요청을 허용하지 않습니다. */
export function markdownToHtml(content: string, title: string): string {
  const parser = createParser();
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${parser.utils.escapeHtml(
    title,
  )}</title>${PDF_STYLE}</head><body>${parser.render(content)}</body></html>`;
}

/** Markdown을 독립 HTML 한 파일로 저장하고 경로를 돌려줍니다. */
export async function markdownToHtmlFile(
  content: string,
  title: string,
  directory: string,
): Promise<string> {
  const output = join(directory, 'out.html');
  await writeFile(output, markdownToHtml(content, title), 'utf8');
  return output;
}

type Marks = { bold: boolean; italics: boolean; strike: boolean };
type ListContext = {
  ordered: boolean;
  level: number;
  instance: number;
  /** 항목의 첫 문단만 글머리표·번호를 받습니다. */
  markerUsed: boolean;
};
type Context = { list: ListContext | null; quote: boolean };
type Block = Paragraph | Table;

/** 열린 토큰과 짝이 되는 닫는 토큰의 위치를 찾습니다. */
function closeIndex(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    depth += tokens[index]?.nesting ?? 0;
    if (depth === 0) return index;
  }
  return tokens.length - 1;
}

/** 허용한 주소 형식만 연결로 만들고 나머지는 글자로 둡니다. */
function safeLink(href: string | number | null): string | null {
  if (typeof href !== 'string' || !href) return null;
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

/** 줄 안의 강조·코드·연결을 글자 조각으로 바꿉니다. */
function inlineRuns(
  children: Token[] | null,
  mono: boolean = false,
): ParagraphChild[] {
  const runs: ParagraphChild[] = [];
  const marks: Marks = { bold: false, italics: false, strike: false };
  let link: { href: string; runs: TextRun[] } | null = null;
  const push = (run: TextRun): void => {
    if (link) link.runs.push(run);
    else runs.push(run);
  };
  const text = (value: string, extra: { code?: boolean } = {}): TextRun =>
    new TextRun({
      text: value,
      bold: marks.bold,
      italics: marks.italics,
      strike: marks.strike,
      ...(extra.code || mono ? { font: MONO_FONT } : {}),
      ...(link ? { style: 'Hyperlink' } : {}),
    });
  for (const token of children ?? []) {
    switch (token.type) {
      case 'text':
        push(text(token.content));
        break;
      case 'code_inline':
        push(text(token.content, { code: true }));
        break;
      case 'softbreak':
        push(text(' '));
        break;
      case 'hardbreak':
        push(new TextRun({ break: 1 }));
        break;
      case 'image':
        push(text(token.content));
        break;
      case 'strong_open':
        marks.bold = true;
        break;
      case 'strong_close':
        marks.bold = false;
        break;
      case 'em_open':
        marks.italics = true;
        break;
      case 'em_close':
        marks.italics = false;
        break;
      case 's_open':
        marks.strike = true;
        break;
      case 's_close':
        marks.strike = false;
        break;
      case 'link_open': {
        const href = safeLink(token.attrGet('href'));
        link = href ? { href, runs: [] } : null;
        break;
      }
      case 'link_close':
        if (link) {
          runs.push(
            new ExternalHyperlink({ link: link.href, children: link.runs }),
          );
          link = null;
        }
        break;
      default:
        if (token.content) push(text(token.content));
    }
  }
  return runs;
}

/** 목록·인용 안의 문단은 들여쓰기로 위치를 맞춥니다. */
function indentFor(context: Context): number {
  const list = context.list ? (context.list.level + 1) * INDENT : 0;
  return list + (context.quote ? INDENT : 0);
}

function table(tokens: Token[]): Table {
  const rows: TableRow[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.type !== 'tr_open') continue;
    const end = closeIndex(tokens, index);
    const cells: TableCell[] = [];
    for (let cell = index + 1; cell < end; cell += 1) {
      const token = tokens[cell];
      if (token?.type !== 'th_open' && token?.type !== 'td_open') continue;
      const header = token.type === 'th_open';
      const inline = tokens[cell + 1];
      const runs = inlineRuns(inline?.children ?? null);
      cells.push(
        new TableCell({
          children: [
            new Paragraph({
              children: header
                ? [
                    new TextRun({
                      text: inline?.content ?? '',
                      bold: true,
                    }),
                  ]
                : runs,
            }),
          ],
          shading: header ? { fill: 'EEEEEE' } : undefined,
        }),
      );
      cell = closeIndex(tokens, cell);
    }
    rows.push(new TableRow({ children: cells, tableHeader: false }));
    index = end;
  }
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

/** 같은 수준의 블록들을 문단·표 목록으로 바꿉니다. */
function blocks(
  tokens: Token[],
  context: Context,
  numbering: { next: () => number },
): Block[] {
  const output: Block[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token) break;
    const end = token.nesting === 1 ? closeIndex(tokens, index) : index;
    const inner = tokens.slice(index + 1, end);
    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1)) - 1;
        output.push(
          new Paragraph({
            heading: HEADINGS[Math.min(Math.max(level, 0), 5)],
            children: inlineRuns(inner[0]?.children ?? null),
          }),
        );
        break;
      }
      case 'paragraph_open': {
        const list = context.list;
        const marker = list && !list.markerUsed;
        if (list) list.markerUsed = true;
        output.push(
          new Paragraph({
            children: inlineRuns(inner[0]?.children ?? null),
            ...(marker && list
              ? {
                  numbering: {
                    reference: list.ordered ? 'ordered' : 'bullets',
                    level: Math.min(list.level, 5),
                    ...(list.ordered ? { instance: list.instance } : {}),
                  },
                }
              : { indent: { left: indentFor(context) } }),
            ...(context.quote
              ? {
                  border: {
                    left: {
                      style: BorderStyle.SINGLE,
                      size: 12,
                      color: 'BBBBBB',
                      space: 8,
                    },
                  },
                }
              : {}),
          }),
        );
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open';
        const level = context.list ? context.list.level + 1 : 0;
        const instance = ordered ? numbering.next() : 0;
        for (let item = 0; item < inner.length; item += 1) {
          if (inner[item]?.type !== 'list_item_open') continue;
          const itemEnd = closeIndex(inner, item);
          output.push(
            ...blocks(
              inner.slice(item + 1, itemEnd),
              {
                ...context,
                list: { ordered, level, instance, markerUsed: false },
              },
              numbering,
            ),
          );
          item = itemEnd;
        }
        break;
      }
      case 'blockquote_open':
        output.push(...blocks(inner, { ...context, quote: true }, numbering));
        break;
      case 'table_open':
        output.push(table(inner));
        break;
      case 'hr':
        output.push(
          new Paragraph({
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                color: '999999',
                space: 1,
              },
            },
          }),
        );
        break;
      case 'fence':
      case 'code_block': {
        const lines = token.content.replace(/\n$/, '').split('\n');
        for (const line of lines)
          output.push(
            new Paragraph({
              indent: { left: indentFor(context) },
              shading: { fill: 'F4F4F4' },
              children: [new TextRun({ text: line, font: MONO_FONT })],
            }),
          );
        break;
      }
      default:
        break;
    }
    index = end + 1;
  }
  return output;
}

/** Markdown을 Word 문서(.docx) 바이트로 만듭니다. 외부 파일·네트워크를 쓰지 않습니다. */
export async function markdownToDocx(
  content: string,
  title: string,
): Promise<Uint8Array> {
  try {
    let instance = 0;
    const children = blocks(
      createParser().parse(content, {}),
      { list: null, quote: false },
      { next: (): number => (instance += 1) },
    );
    const levels = (
      format: (typeof LevelFormat)[keyof typeof LevelFormat],
      text: (level: number) => string,
    ): ILevelsOptions[] =>
      Array.from(
        { length: 6 },
        (_: unknown, level: number): ILevelsOptions => ({
          level,
          format,
          text: text(level),
          style: {
            paragraph: { indent: { left: (level + 1) * INDENT, hanging: 360 } },
          },
        }),
      );
    const bullets = levels(LevelFormat.BULLET, (): string => '•');
    const ordered = levels(
      LevelFormat.DECIMAL,
      (level: number): string => `%${level + 1}.`,
    );
    const document = new Document({
      title,
      subject: title,
      styles: {
        default: { document: { run: { font: DOCUMENT_FONT, size: 22 } } },
      },
      numbering: {
        config: [
          { reference: 'bullets', levels: bullets },
          { reference: 'ordered', levels: ordered },
        ],
      },
      sections: [
        { children: children.length ? children : [new Paragraph('')] },
      ],
    });
    return new Uint8Array(await Packer.toBuffer(document));
  } catch {
    throw new ConversionFailed();
  }
}

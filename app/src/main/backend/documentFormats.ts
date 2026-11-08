import PptxGenJS from 'pptxgenjs';
import writeXlsxFile from 'write-excel-file/node';
import { outline } from '../../shared/markdownOutline';
import { slidesFrom, displayWidth } from '../../shared/slideOutline';
export { slidesFrom, lineCount } from '../../shared/slideOutline';
import type { OutlineBlock } from '../../shared/markdownOutline';
export { outline } from '../../shared/markdownOutline';
export type { OutlineBlock } from '../../shared/markdownOutline';
import { ConversionFailed, parseMarkdown } from './DocumentConverter';

const FONT = 'Malgun Gothic';
const MONO = 'Courier New';

// ---------------------------------------------------------------- Excel

type XlsxCell = {
  value: string | number;
  fontWeight?: 'bold';
  backgroundColor?: string;
  wrap?: boolean;
};

/** 앞자리 0이 없는 일반 숫자만 숫자 셀로 두어 식별번호·전화번호가 바뀌지 않게 합니다. */
export function cellValue(text: string): string | number {
  if (/^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/.test(text)) return Number(text);
  return text;
}

/** 시트 이름은 31자 이하이며 `\ / ? * [ ] :`를 쓰지 않고 서로 달라야 합니다. */
export function sheetName(
  raw: string,
  fallback: string,
  used: Set<string>,
): string {
  const base =
    raw
      .replace(/[\\/?*[\]:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 31) || fallback;
  let name = base;
  for (let count = 2; used.has(name.toLowerCase()); count += 1) {
    const suffix = ` (${count})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

function table(rows: string[][]): {
  data: (XlsxCell | null)[][];
  widths: { width: number }[];
} {
  const columns = Math.max(
    0,
    ...rows.map((row: string[]): number => row.length),
  );
  const data = rows.map(
    (row: string[], rowIndex: number): (XlsxCell | null)[] =>
      Array.from(
        { length: columns },
        (_: unknown, column: number): XlsxCell => {
          const text = row[column] ?? '';
          return rowIndex === 0
            ? {
                value: text,
                fontWeight: 'bold',
                backgroundColor: '#EEEEEE',
                wrap: true,
              }
            : { value: cellValue(text), wrap: true };
        },
      ),
  );
  const widths = Array.from(
    { length: columns },
    (_: unknown, column: number): { width: number } => ({
      width: Math.min(
        60,
        Math.max(
          8,
          ...rows.map(
            (row: string[]): number => displayWidth(row[column] ?? '') + 2,
          ),
        ),
      ),
    }),
  );
  return { data, widths };
}

/**
 * Markdown의 표마다 시트 하나를 만들고, 표가 아닌 내용은 첫 시트 "본문"에 줄 단위로 둡니다.
 * 표 시트의 이름은 바로 앞 제목을 씁니다. 수식은 만들지 않으며 글자 셀은 수식으로 해석되지 않습니다.
 */
export async function markdownToXlsx(
  content: string,
  title: string,
): Promise<Uint8Array> {
  try {
    const blocks = outline(parseMarkdown(content));
    const used = new Set<string>();
    const body: (XlsxCell | null)[][] = [];
    const tables: { name: string; rows: string[][] }[] = [];
    let heading = '';
    for (const block of blocks) {
      switch (block.kind) {
        case 'heading':
          heading = block.text;
          body.push([{ value: block.text, fontWeight: 'bold', wrap: true }]);
          break;
        case 'paragraph':
        case 'quote':
          body.push([{ value: block.text, wrap: true }]);
          break;
        case 'item':
          body.push([
            {
              value: `${'  '.repeat(block.level)}${block.ordered ? '-' : '•'} ${block.text}`,
              wrap: true,
            },
          ]);
          break;
        case 'code':
          body.push(
            ...block.text
              .split('\n')
              .map((line: string): XlsxCell[] => [{ value: line }]),
          );
          break;
        case 'table':
          if (block.rows.length)
            tables.push({ name: heading, rows: block.rows });
          break;
      }
    }
    const sheets: {
      data: (XlsxCell | null)[][];
      sheet: string;
      columns?: { width: number }[];
    }[] = [];
    // 표가 있으면 표 시트를 앞에 두고 제목·설명이 담긴 "본문"을 뒤에 둡니다.
    const bodySheet = body.length
      ? {
          data: body,
          sheet: sheetName('본문', '본문', used),
          columns: [{ width: 100 }],
        }
      : null;
    tables.forEach(
      (value: { name: string; rows: string[][] }, index: number): void => {
        const built = table(value.rows);
        sheets.push({
          data: built.data,
          sheet: sheetName(value.name, `표 ${index + 1}`, used),
          columns: built.widths,
        });
      },
    );
    if (bodySheet) sheets.push(bodySheet);
    if (!sheets.length)
      sheets.push({
        data: [[{ value: title }]],
        sheet: sheetName('본문', '본문', used),
      });
    return new Uint8Array(
      await writeXlsxFile(sheets, { fontFamily: FONT }).toBuffer(),
    );
  } catch {
    throw new ConversionFailed();
  }
}

// ----------------------------------------------------------- PowerPoint

type TextRun = { text: string; options: Record<string, unknown> };

function runs(blocks: OutlineBlock[]): TextRun[] {
  const output: TextRun[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        output.push({
          text: block.text,
          options: {
            bold: true,
            fontSize: 18,
            breakLine: true,
            fontFace: FONT,
          },
        });
        break;
      case 'item':
        output.push({
          text: block.text,
          options: {
            bullet: block.ordered ? { type: 'number' } : true,
            indentLevel: Math.min(block.level, 4),
            fontSize: 16,
            breakLine: true,
            fontFace: FONT,
          },
        });
        break;
      case 'quote':
        output.push({
          text: block.text,
          options: {
            italic: true,
            fontSize: 16,
            breakLine: true,
            fontFace: FONT,
          },
        });
        break;
      case 'code':
        for (const line of block.text.split('\n'))
          output.push({
            text: line,
            options: { fontSize: 12, breakLine: true, fontFace: MONO },
          });
        break;
      case 'paragraph':
        output.push({
          text: block.text,
          options: { fontSize: 16, breakLine: true, fontFace: FONT },
        });
        break;
      case 'table':
        break;
    }
  }
  return output;
}

/** Markdown을 16:9 PowerPoint(.pptx)로 만듭니다. 그림·애니메이션·외부 파일은 쓰지 않습니다. */
export async function markdownToPptx(
  content: string,
  title: string,
): Promise<Uint8Array> {
  try {
    const deck = slidesFrom(outline(parseMarkdown(content)), title);
    const presentation = new PptxGenJS();
    presentation.layout = 'LAYOUT_16x9';
    presentation.title = deck.title;
    presentation.subject = title;
    const cover = presentation.addSlide();
    cover.addText(deck.title, {
      x: 0.7,
      y: 1.7,
      w: 8.6,
      h: 1.3,
      fontSize: 36,
      bold: true,
      fontFace: FONT,
      valign: 'middle',
    });
    if (deck.subtitle)
      cover.addText(deck.subtitle, {
        x: 0.7,
        y: 3.1,
        w: 8.6,
        h: 1,
        fontSize: 18,
        color: '555555',
        fontFace: FONT,
        valign: 'top',
      });
    for (const value of deck.slides) {
      const slide = presentation.addSlide();
      slide.addText(value.title, {
        x: 0.5,
        y: 0.3,
        w: 9,
        h: 0.8,
        fontSize: 26,
        bold: true,
        fontFace: FONT,
        valign: 'middle',
      });
      const grid = value.blocks.find(
        (block: OutlineBlock): boolean => block.kind === 'table',
      );
      if (grid?.kind === 'table') {
        slide.addTable(
          grid.rows.map(
            (
              row: string[],
              rowIndex: number,
            ): { text: string; options: Record<string, unknown> }[] =>
              row.map(
                (
                  cell: string,
                ): { text: string; options: Record<string, unknown> } => ({
                  text: cell,
                  options: {
                    bold: rowIndex === 0,
                    fill: rowIndex === 0 ? { color: 'EEEEEE' } : undefined,
                    fontFace: FONT,
                    fontSize: 13,
                  },
                }),
              ),
          ),
          {
            x: 0.5,
            y: 1.3,
            w: 9,
            border: { type: 'solid', color: '999999', pt: 1 },
            autoPage: false,
          },
        );
      } else if (value.blocks.length) {
        slide.addText(runs(value.blocks), {
          x: 0.6,
          y: 1.3,
          w: 8.8,
          h: 3.9,
          valign: 'top',
          color: '222222',
          paraSpaceAfter: 6,
        });
      }
    }
    const data = await presentation.write({ outputType: 'nodebuffer' });
    return new Uint8Array(data as Buffer);
  } catch {
    throw new ConversionFailed();
  }
}

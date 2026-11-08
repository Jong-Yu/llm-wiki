import type { OutlineBlock } from './markdownOutline';

/** 한글·전각 글자는 두 칸으로 세어 열 너비를 정합니다. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[ᄀ-ᇿ㄰-㆏가-힯　-鿿＀-￯]/.test(char) ? 2 : 1;
  return width;
}

type Slide = { title: string; blocks: OutlineBlock[] };

const MAX_LINES = 11;
const MAX_TABLE_ROWS = 8;

/** 한 줄에 들어가는 글자 수를 약 60으로 보고 차지하는 줄 수를 어림합니다. */
export function lineCount(block: OutlineBlock): number {
  switch (block.kind) {
    case 'heading':
      return 1;
    case 'code':
      return block.text.split('\n').length;
    case 'table':
      return block.rows.length;
    default:
      return Math.max(1, Math.ceil(displayWidth(block.text) / 90));
  }
}

/**
 * 제목(H1)은 표지, H2는 슬라이드, H3 이하는 슬라이드 안의 굵은 줄입니다.
 * 내용이 많으면 같은 제목에 "(계속)"을 붙여 슬라이드를 나누고, 표는 8행씩 따로 둡니다.
 */
export function slidesFrom(
  blocks: OutlineBlock[],
  fallbackTitle: string,
): { title: string; subtitle: string; slides: Slide[] } {
  let title = fallbackTitle;
  let index = 0;
  const first = blocks[0];
  if (first?.kind === 'heading' && first.level === 1) {
    title = first.text || fallbackTitle;
    index = 1;
  }
  const sections: Slide[] = [];
  let current: Slide | null = null;
  const cover: OutlineBlock[] = [];
  for (; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) break;
    if (block.kind === 'heading' && block.level <= 2) {
      current = { title: block.text, blocks: [] };
      sections.push(current);
    } else if (current) current.blocks.push(block);
    else cover.push(block);
  }
  const subtitle = cover.find(
    (value: OutlineBlock): boolean => value.kind === 'paragraph',
  );
  const rest = cover.filter(
    (value: OutlineBlock): boolean => value !== subtitle,
  );
  if (rest.length) sections.unshift({ title: '개요', blocks: rest });
  const slides: Slide[] = [];
  for (const section of sections) {
    let page: OutlineBlock[] = [];
    let lines = 0;
    let part = 0;
    const flush = (): void => {
      if (!page.length) return;
      slides.push({
        title: part ? `${section.title} (계속)` : section.title,
        blocks: page,
      });
      part += 1;
      page = [];
      lines = 0;
    };
    if (!section.blocks.length) {
      slides.push({ title: section.title, blocks: [] });
      continue;
    }
    for (const block of section.blocks) {
      if (block.kind === 'table') {
        flush();
        const [header, ...body] = block.rows;
        for (
          let start = 0;
          start < Math.max(1, body.length);
          start += MAX_TABLE_ROWS
        ) {
          page = [
            {
              kind: 'table',
              rows: [
                header ?? [],
                ...body.slice(start, start + MAX_TABLE_ROWS),
              ],
            },
          ];
          flush();
        }
        continue;
      }
      const size = lineCount(block);
      if (lines + size > MAX_LINES) flush();
      page.push(block);
      lines += size;
    }
    flush();
  }
  return {
    title,
    subtitle: subtitle && subtitle.kind === 'paragraph' ? subtitle.text : '',
    slides,
  };
}

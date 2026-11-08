/** 답변 본문(Markdown)에서 파일 카드에 보일 이름과 구성 요약을 뽑는 순수 함수입니다. */
import type { ExportFormat } from '@contracts/fileExports.contract';

import MarkdownIt, { type Token } from 'markdown-it';
import { slidesFrom } from '../../../../shared/slideOutline';
import { outline } from '../../../../shared/markdownOutline';
import type { OutlineBlock } from '../../../../shared/markdownOutline';

const parser = new MarkdownIt({ html: false, linkify: false });
/** 파일 추천에 쓰는 표 수는 내보내기와 같은 Markdown 표 구문에서 읽는다. */
export function countTables(content: string): number {
  return parser
    .parse(content, {})
    .filter((token: Token): boolean => token.type === 'table_open').length;
}
/** 첫 번째 `# 제목`입니다. 없으면 null입니다. */
function firstHeading(markdown: string): string | null {
  const found = /^#\s+(.+?)\s*#*\s*$/m.exec(markdown);
  return found?.[1]?.trim() || null;
}

/** 파일 이름으로 쓸 수 없는 문자를 빼고 길이를 줄입니다. */
export function answerFileTitle(markdown: string, fallback: string): string {
  const cleaned = Array.from(firstHeading(markdown) ?? fallback)
    .filter((character: string): boolean => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127 && !'\\/:*?"<>|'.includes(character);
    })
    .join('')
    .trim()
    .slice(0, 60);
  return cleaned || 'AI 답변';
}

/** "표 1개 · 슬라이드 5장"처럼 형식에 맞는 구성 요약입니다. 근거 문서 수는 호출자가 덧붙입니다. */
export function fileComposition(
  format: ExportFormat,
  markdown: string,
): string {
  const blocks = outline(parser.parse(markdown, {}));
  const tables = blocks.filter(
    (block: OutlineBlock): boolean =>
      block.kind === 'table' && block.rows.length > 0,
  ).length;
  if (format === 'xlsx') {
    const body = blocks.some(
      (block: OutlineBlock): boolean => block.kind !== 'table',
    );
    const sheets = Math.max(1, tables + Number(body));
    return tables ? `시트 ${sheets}개 · 표 ${tables}개` : '본문 시트 1개';
  }
  if (format === 'pptx') {
    const slides = 1 + slidesFrom(blocks, '').slides.length;
    return `슬라이드 ${slides}장`;
  }
  const sections = markdown.match(/^#{1,3}\s+/gm)?.length ?? 0;
  const parts = [
    sections > 0 ? `제목 ${sections}개` : '',
    tables > 0 ? `표 ${tables}개` : '',
  ].filter(Boolean);
  return parts.length
    ? parts.join(' · ')
    : `${markdown.length.toLocaleString()}자`;
}

/** 파일 답변에서 채팅에 먼저 보일 요약 문장입니다. 제목·표·목록이 아닌 첫 문단이며 없으면 빈 문자열입니다. */
export function leadSentence(markdown: string): string {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text || /^(#|\||[-*+]\s|\d+\.\s|```|>)/.test(text)) continue;
    return text;
  }
  return '';
}

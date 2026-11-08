/** 말로 한 형식 요청을 AI가 답변 첫 줄에 표시하게 하고, 앱이 그 표시를 읽어 파일 카드로 바꾸는 순수 함수입니다. */
import type { ExportFormat } from '@contracts/fileExports.contract';

/** 질문 맨 뒤(첨부 앞)에 붙는 안내입니다. 양식을 직접 고른 질문에는 붙이지 않습니다. */
export const OUTPUT_INTENT_MARKER =
  '\n\n[출력 형식 안내 — 사용자가 Word·문서, PDF, Excel·표·스프레드시트, PowerPoint·슬라이드·발표자료, Markdown 중 하나로 만들어 달라고 말했다면 답변의 첫 줄에 `[[파일: docx]]`처럼 형식만 쓰고(docx, pdf, xlsx, pptx, md 중 하나) 둘째 줄부터 그 형식에 맞게 Markdown으로 작성하되, # 제목 바로 다음 문단에 답을 한두 문장으로 요약하세요. Excel은 Markdown 표 중심으로, PowerPoint는 # 표지 하나와 ## 슬라이드 제목으로 쓰세요. 그런 요청이 없으면 첫 줄 표시를 쓰지 마세요. 답변은 질문에 먼저 직접 답하고, 근거·검토 상태·승인 같은 내부 용어는 꼭 필요할 때만 한 줄로 덧붙이세요. 위키에서 확인되지 않은 점은 마지막에 한 문장으로 따로 쓰세요. 이미지·그림·사진 파일을 만들어 달라는 요청은 만들 수 없으니, 만들 수 없다고 먼저 밝히고 대신 가능한 형식(문서·표·슬라이드) 또는 글로 설명하는 방법을 제안하세요.]';

const DIRECTIVE_FORMATS: readonly ExportFormat[] = [
  'docx',
  'pdf',
  'xlsx',
  'pptx',
  'md',
];
const DIRECTIVE_PATTERN = /^\s*\[\[파일:\s*([a-z]{2,5})\s*\]\][ \t]*\r?\n?/;

/** 답변 첫 줄의 형식 표시를 떼어 낸 본문과 요청된 형식입니다. 표시가 없거나 알 수 없는 형식이면 format은 null입니다. */
export function splitOutputDirective(content: string): {
  format: ExportFormat | null;
  body: string;
} {
  const found = DIRECTIVE_PATTERN.exec(content);
  if (found) {
    const requested = DIRECTIVE_FORMATS.find(
      (item: ExportFormat): boolean => item === found[1],
    );
    return { format: requested ?? null, body: content.slice(found[0].length) };
  }
  // 글자가 흘러나오는 중이라 표시가 아직 끝나지 않았으면 본문으로 보이지 않게 비웁니다.
  const head = content.trimStart();
  const opening = '[[파일:';
  const unfinished =
    head.length > 0 &&
    head.length <= 24 &&
    !head.includes('\n') &&
    !head.includes(']]') &&
    (opening.startsWith(head) || head.startsWith(opening));
  return { format: null, body: unfinished ? '' : content };
}

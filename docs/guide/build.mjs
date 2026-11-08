import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
const MarkdownIt = require('markdown-it');
const directory = new URL('./', import.meta.url);
const read = (path) => readFile(new URL(path, directory), 'utf8');

// 좌표 원장을 화면 가이드에서 바로 읽을 수 있는 오프라인 자료로 합칩니다.
const aliases = {
  '답변 내려받기': '내려받기',
  '근거 칩': '근거',
  '답변 근거': '인용과 원문',
  '검토 이유': '이유',
  '판단 저장': '저장',
  'AI 실행 탭': 'AI 실행',
  '버전 1개 현재': '버전',
  'Markdown 본문': '본문',
};
const descriptions = {
  'login.png': '로그인 탭에서 계정 이름과 예시 서버 주소를 입력한 상태입니다.',
  'ai-settings.png': '개인 AI 연결을 시작하는 설정 화면입니다. 아직 로그인과 실제 응답을 확인하지 않은 상태입니다.',
  'import.png': '텍스트 붙여넣기로 자료를 입력한 상태입니다. 등록하기 전 화면입니다.',
  'document.png': '예시 문서의 본문을 연 상태입니다. 이 예시는 원본 연결과 추출된 관계가 없는 문서입니다.',
  'edit.png': '문서의 본문을 편집 중인 화면입니다. 변경한 초안을 저장하기 전 상태입니다.',
  'sessions.png': '아직 실행한 AI 작업이 없는 새 계정의 화면입니다. 실행 후에는 이곳에서 작업과 결과를 확인합니다.',
  'chat.png': '질문 입력과 답변 내려받기 위치를 보여 줍니다. 화면의 답변은 모의 예시입니다.',
  'evidence.png': '모의 답변의 근거 칩을 눌러 인용과 원문 위치를 펼친 상태입니다.',
  'ontology.png': '검색한 개념을 선택해 관계와 원문 설명을 펼친 연습용 예시입니다.',
  'review.png': '원문 관계를 읽고 승인을 선택해 이유를 작성한 상태입니다. 실제 판단 저장은 하지 않았습니다.',
};
const screens = {};
for (const file of ['assets/images-start.json', 'assets/images-knowledge.json']) {
  const manifest = JSON.parse(await read(file));
  for (const image of manifest.images) {
    screens[`assets/${image.file}`] = {
      width: image.width,
      height: image.height,
      label: image.mockAiResponse ? '실제 앱 화면 · 모의 AI 답변' : '실제 앱 화면 · 연습용 자료',
      description: descriptions[image.file] ?? image.description,
      hotspots: image.highlights.map((point) => ({
        label: aliases[point.label] ?? point.label,
        rect: point.rect,
      })),
      source: image.fixture,
    };
  }
}
await writeFile(new URL('screens.js', directory), `window.LLM_WIKI_SCREENS = ${JSON.stringify(screens, null, 2)};\n`);

// 상세 문서는 Markdown만 편집하고 같은 제목 링크로 읽을 수 있는 HTML을 생성합니다.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const diagram = `data:image/svg+xml;base64,${Buffer.from(await read('assets/knowledge-cycle.svg')).toString('base64')}`;
const renderImage = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
  if (tokens[index].attrGet('src') === 'guide/assets/knowledge-cycle.svg') {
    tokens[index].attrSet('src', diagram);
  }
  return renderImage(tokens, index, options, environment, renderer);
};
const seen = new Map();
markdown.renderer.rules.heading_open = (tokens, index, options, environment, renderer) => {
  const title = tokens[index + 1].content.toLowerCase();
  const base = title.replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-');
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  tokens[index].attrSet('id', count ? `${base}-${count}` : base);
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const link = tokens[index];
  const href = link.attrGet('href');
  if (href === 'USER_GUIDE.md' || href === 'INTRODUCTION.md') {
    link.attrSet('href', href === 'USER_GUIDE.md' ? '#llm-wiki-사용자-가이드' : '#llm-wiki-이해하기');
    return renderer.renderToken(tokens, index, options);
  }
  if (href && /^https:\/\//i.test(href)) {
    link.attrSet('target', '_blank');
    link.attrSet('rel', 'noopener noreferrer');
  }
  if (href && !href.startsWith('#') && !/^[a-z][a-z\d+.-]*:/i.test(href)) {
    link.attrSet('href', href.startsWith('guide/') ? href.slice(6) : `../${href}`);
  }
  return renderer.renderToken(tokens, index, options);
};
// 저장소 개발 문서 링크는 배포 앱의 사용자 안내와 분리합니다.
const source = (await read('../USER_GUIDE.md')).replace(/\n## 추가 안내[\s\S]*$/, '');
const body = `${markdown.render(await read('../INTRODUCTION.md'))}<hr>${markdown.render(source)}`;
const reference = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM Wiki 소개와 사용자 가이드</title>
<style>
*{box-sizing:border-box}html{scroll-padding-top:80px}body{margin:0;background:#f5f8f7;color:#182b34;font:16px/1.85 -apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif}header{position:sticky;top:0;padding:14px 24px;background:#fffffff5;border-bottom:1px solid #dce4e4;z-index:1}header a{font-weight:600}main{max-width:1050px;margin:24px auto;padding:24px 38px 60px;background:white;border:1px solid #dce4e4;border-radius:10px}a{color:#205b4e;text-underline-offset:3px}h1{font-size:32px;letter-spacing:-.04em}h2{margin-top:48px;padding-top:18px;border-top:1px solid #dce4e4;font-size:25px}h3{margin-top:28px;font-size:19px}p,li,td{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;font-size:14px;margin:20px 0}td,th{padding:10px 12px;border:1px solid #dce4e4;text-align:left;vertical-align:top}th{background:#edf4ef}pre{overflow:auto;padding:18px;background:#f1f5f3;border-radius:6px;font-size:14px}img{max-width:100%}:focus-visible{outline:3px solid #2863ac;outline-offset:4px}@media(max-width:650px){main{margin:0;padding:16px;border:0;border-radius:0}h1{font-size:26px}h2{font-size:22px}table{font-size:12px}td,th{padding:7px}header{padding:12px 16px}}
</style></head><body><header><a href="index.html">← 화면 가이드로 돌아가기</a> · <a href="#llm-wiki-이해하기">LLM Wiki 이해하기</a> · <a href="#llm-wiki-사용자-가이드">상세 사용법</a></header><main>${body}</main></body></html>\n`;
await writeFile(new URL('reference.html', directory), reference);
console.log(`화면 ${Object.keys(screens).length}개와 상세 안내를 생성했습니다.`);

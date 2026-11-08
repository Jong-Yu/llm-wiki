import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Plugin, ViteDevServer } from 'vite';

const root = resolve(import.meta.dirname, '../../docs/guide');
const pages = ['index.html', 'reference.html'];
const execute = promisify(execFile);
const guideNavigation = `
document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest('a');
  const href = anchor?.getAttribute('href');
  if (!href || href.startsWith('#')) return;
  const target = new URL(href, location.href);
  const fragment = target.hash;
  target.hash = '';
  const page = ['index.html', 'reference.html'].find((name) =>
    target.href === new URL(name, location.href).href.split('#')[0]);
  if (!page) return;
  event.preventDefault();
  const active = document.querySelector('.nav-step[aria-current="step"]');
  const position = Array.from(document.querySelectorAll('.nav-step')).indexOf(active);
  const scene = window.LLM_WIKI_GUIDE?.steps[position]?.id;
  parent.postMessage({kind:'wiki-user-guide-navigation',page,fragment,scene}, '*');
});`;

/** 문서의 편집 원본에서 브라우저용 설명과 화면 좌표를 갱신합니다. */
async function prepareGuide(): Promise<void> {
  await execute(process.execPath, [resolve(root, 'build.mjs')]);
}

/** 가이드는 자신의 고정 스크립트만 실행하며 네트워크·업무 폼을 열지 않습니다. */
function secureGuideHtml(content: Buffer): Buffer {
  const html = content.toString('utf8');
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match: RegExpExecArray): string =>
      `'sha256-${createHash('sha256')
        .update(match[1] ?? '')
        .digest('base64')}'`,
  );
  const policy = [
    "default-src 'none'",
    `script-src ${hashes.length ? hashes.join(' ') : "'none'"}`,
    "style-src 'self' 'unsafe-inline'",
    'img-src data:',
    "font-src 'self'",
    "connect-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return Buffer.from(
    html.replace(
      /<head>/i,
      `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`,
    ),
  );
}

/** 허용 목록에 있는 가이드 파일만 읽고 HTML에는 독립된 실행 정책을 붙입니다. */
async function guideAsset(name: string): Promise<Buffer> {
  let content = await readFile(resolve(root, name), 'utf8');
  if (name === 'index.html') {
    // opaque 프레임에서는 file 하위 자원을 읽을 수 없어 고정 자료를 한 문서에 묶습니다.
    const images: Record<string, string> = {};
    for (const file of await readdir(resolve(root, 'assets'))) {
      if (file.endsWith('.png'))
        images[`assets/${file}`] =
          `data:image/png;base64,${(await readFile(resolve(root, 'assets', file))).toString('base64')}`;
    }
    for (const file of ['steps.js', 'screens.js']) {
      const script = await readFile(resolve(root, file), 'utf8');
      content = content.replace(
        `<script src="${file}"></script>`,
        `<script>${script}</script>`,
      );
    }
    content = content.replace(
      '<script>',
      `<script>window.LLM_WIKI_IMAGES=${JSON.stringify(images)};</script><script>`,
    );
  }
  content = content.replace(
    '</body>',
    `<script>${guideNavigation}</script></body>`,
  );
  return secureGuideHtml(Buffer.from(content));
}

/** 개발과 패키지 빌드에 같은 가이드 원본을 연결합니다. */
export function userGuideAssets(): Plugin {
  return {
    name: 'wiki-user-guide',
    async buildStart(): Promise<void> {
      await prepareGuide();
    },
    async configureServer(server: ViteDevServer): Promise<void> {
      await prepareGuide();
      server.watcher.add(root);
      server.middlewares.use('/user-guide', (request, response, next): void => {
        const name = (request.url ?? '').split('?')[0]?.replace(/^\//, '');
        void (async (): Promise<void> => {
          if (!name || !pages.includes(name)) {
            next();
            return;
          }
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader(
            'Content-Type',
            name.endsWith('.html')
              ? 'text/html; charset=utf-8'
              : name.endsWith('.js')
                ? 'text/javascript; charset=utf-8'
                : 'image/png',
          );
          response.end(await guideAsset(name));
        })().catch(next);
      });
    },
    async generateBundle(): Promise<void> {
      for (const file of pages) {
        this.emitFile({
          type: 'asset',
          fileName: `user-guide/${file}`,
          source: await guideAsset(file),
        });
      }
    },
  };
}

import { fileURLToPath, pathToFileURL } from 'node:url';

/** 제품 파일 하나 또는 고정된 로컬 개발 서버만 창의 문서로 허용합니다. */
export function getRendererLocation(): string {
  if (__WIKI_DEV__) {
    const url = process.env.ELECTRON_RENDERER_URL;
    if (url !== 'http://127.0.0.1:5173') {
      throw new Error('허용되지 않은 개발 화면 주소입니다.');
    }
    return `${url}/`;
  }
  return pathToFileURL(
    fileURLToPath(new URL('../renderer/index.html', import.meta.url)),
  ).href;
}

/** 문서 주소는 정확히 대조하고 앱 내부 hash 경로만 허용합니다. */
export function isRendererLocation(url: string, expected: string): boolean {
  try {
    const location = new URL(url);
    location.hash = '';
    return location.href === expected;
  } catch {
    return false;
  }
}

/** 하위 프레임은 앱에 포함한 두 가이드 문서만 탐색할 수 있습니다. */
export function isUserGuideLocation(url: string, renderer: string): boolean {
  try {
    const location = new URL(url);
    location.hash = '';
    return ['index.html', 'reference.html'].some(
      (page: string): boolean =>
        location.href === new URL(`user-guide/${page}`, renderer).href,
    );
  } catch {
    return false;
  }
}

/** 앱 본문과 가이드 하위 프레임의 허용 문서를 서로 섞지 않습니다. */
export function isWindowFrameLocation(
  url: string,
  renderer: string,
  mainFrame: boolean,
): boolean {
  return mainFrame
    ? isRendererLocation(url, renderer)
    : isUserGuideLocation(url, renderer);
}

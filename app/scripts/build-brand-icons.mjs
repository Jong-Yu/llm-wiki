import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// 한 원본의 모양·주황 점은 유지하며 밝음/어두움용 중립색만 바꿉니다.
if (process.platform !== 'darwin') {
  throw new Error('PNG·ICO·ICNS 동시 생성에는 macOS의 iconutil이 필요합니다.');
}
const brandRoot = fileURLToPath(new URL('../design/brand/', import.meta.url));
const svg = await readFile(join(brandRoot, 'llm-wiki-mark.svg'), 'utf8');
const temporary = await mkdtemp(join(tmpdir(), 'wiki-brand-icons-'));
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const sizes = [...icoSizes, 512, 1024];
const frames = new Map();
const darkFrames = new Map();
let browser;

/** 크기별 PNG를 하나의 Windows ICO에 넣습니다. */
function createIco(images) {
  const header = Buffer.alloc(6 + 16 * icoSizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = header.length;
  for (const [index, size] of icoSizes.entries()) {
    const entry = 6 + index * 16;
    const png = images.get(size);
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = header[entry];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  return Buffer.concat([header, ...icoSizes.map((size) => images.get(size))]);
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const { darkSvg, faviconSvg } = await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = doc.documentElement;
    const dark = root.getAttribute('data-dark-color');
    if (
      doc.querySelector('parsererror') ||
      !/^#[0-9a-f]{6}$/i.test(dark ?? '')
    ) {
      throw new Error('브랜드 SVG 또는 어두운 테마 색이 올바르지 않습니다.');
    }
    const serializer = new XMLSerializer();
    const darkRoot = root.cloneNode(true);
    darkRoot.setAttribute('color', dark);
    const style = doc.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `@media (prefers-color-scheme: dark) { :root { color: ${dark}; } }`;
    root.prepend(style);
    return {
      darkSvg: serializer.serializeToString(darkRoot),
      faviconSvg: serializer.serializeToString(root),
    };
  }, svg);
  for (const [source, images] of [
    [svg, frames],
    [darkSvg, darkFrames],
  ]) {
    for (const size of sizes) {
      const png = await page.evaluate(
        async ({ source, dimension }) => {
          const image = new Image();
          image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = dimension;
          canvas.height = dimension;
          canvas.getContext('2d').drawImage(image, 0, 0, dimension, dimension);
          return canvas.toDataURL('image/png').split(',')[1];
        },
        { source, dimension: size },
      );
      images.set(size, Buffer.from(png, 'base64'));
    }
  }
  await browser.close();
  browser = undefined;

  const iconset = join(temporary, 'llm-wiki.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(
      join(iconset, `icon_${size}x${size}.png`),
      frames.get(size),
    );
    await writeFile(
      join(iconset, `icon_${size}x${size}@2x.png`),
      frames.get(size * 2),
    );
  }
  const icnsPath = join(temporary, 'llm-wiki-icon.icns');
  await promisify(execFile)('/usr/bin/iconutil', [
    '-c',
    'icns',
    iconset,
    '-o',
    icnsPath,
  ]);

  // 모든 형식 생성 성공 뒤에만 기존 개발 자산을 교체합니다.
  const outputs = new Map([
    ['llm-wiki-icon.svg', faviconSvg],
    ['llm-wiki-icon-dark.svg', darkSvg],
    ['llm-wiki-icon.png', frames.get(1024)],
    ['llm-wiki-icon-dark.png', darkFrames.get(1024)],
    ['llm-wiki-icon.ico', createIco(frames)],
    ['llm-wiki-icon-dark.ico', createIco(darkFrames)],
    ['llm-wiki-icon.icns', await readFile(icnsPath)],
  ]);
  for (const [name, bytes] of outputs) {
    await writeFile(join(brandRoot, name), bytes);
  }
  console.log(
    `투명 브랜드 원본에서 밝음/어두움 SVG·PNG·ICO(${icoSizes.join('/')}px)와 기본 ICNS 생성 완료`,
  );
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}

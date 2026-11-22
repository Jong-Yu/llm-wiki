import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

/** 사용자 폴더와 분리된 실제 파일시스템에서만 정리를 검증합니다. */
export async function fixture(run) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'wiki-release-test-')),
  );
  const app = join(root, 'app');
  await mkdir(app);
  try {
    await run({ root, app, release: join(app, 'release') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 불투명한 설치 파일과 실제 체크섬 규약을 사용한 합성 배포물을 만듭니다. */
export async function releaseFiles(
  root,
  version,
  { mac = true, win = true, runtime = true } = {},
) {
  await mkdir(root, { recursive: true });
  for (const [enabled, metadata, extensions] of [
    [mac, 'latest-mac.yml', ['zip', 'dmg']],
    [win, 'latest.yml', ['exe']],
  ]) {
    if (!enabled) continue;
    const files = [];
    for (const extension of extensions) {
      const name = `Example-${version}.${extension}`;
      const body = Buffer.from(`${version}:${extension}`);
      await writeFile(join(root, name), body);
      await writeFile(join(root, `${name}.blockmap`), 'blockmap');
      files.push({
        url: name,
        size: body.length,
        sha512: createHash('sha512').update(body).digest('base64'),
      });
    }
    await writeFile(join(root, metadata), yaml.dump({ version, files }));
  }
  if (runtime) {
    const name = `llm-wiki-personal-runtime-${version}.zip`;
    const body = Buffer.from(`runtime:${version}`);
    await writeFile(join(root, name), body);
    await writeFile(
      join(root, `${name}.sha256`),
      `${createHash('sha256').update(body).digest('hex')}  ${name}\n`,
    );
  }
}

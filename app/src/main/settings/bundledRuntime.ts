import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeSettings } from '@contracts/runtime.contract';

export type BundledRuntimePaths = Pick<
  RuntimeSettings,
  'root' | 'python' | 'tesseract' | 'tessdata'
>;

interface BundleLocation {
  packaged: boolean;
  platform: NodeJS.Platform;
  architecture: string;
  resourcesPath: string;
}

/** 지원하는 설치 패키지의 실제 파일만 기본 경로로 사용하며 준비 여부는 별도 진단합니다. */
export async function discoverBundledRuntime(
  location: BundleLocation,
): Promise<BundledRuntimePaths | null> {
  if (
    !location.packaged ||
    location.platform !== 'win32' ||
    location.architecture !== 'x64'
  )
    return null;
  const root = join(location.resourcesPath, 'personal-runtime');
  const paths: BundledRuntimePaths = {
    root,
    python: join(root, 'python/python.exe'),
    tesseract: join(root, 'ocr/tesseract.exe'),
    tessdata: join(root, 'ocr/tessdata'),
  };
  try {
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
    for (const path of [
      paths.python,
      paths.tesseract,
      join(paths.tessdata, 'kor.traineddata'),
      join(paths.tessdata, 'eng.traineddata'),
      join(root, 'core/paths.py'),
      join(root, 'tools/runtime_doctor.py'),
      join(root, 'tools/source_conversion_cli.py'),
      join(root, '.agent/ontology_semantics.md'),
      join(root, 'requirements.lock'),
    ]) {
      const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || file.size === 0)
        return null;
    }
    return paths;
  } catch {
    // 누락되거나 읽을 수 없는 번들은 외부 실행 환경 선택·진단 경로를 유지합니다.
    return null;
  }
}

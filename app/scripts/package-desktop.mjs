import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build, Platform, Arch } from 'electron-builder';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';

const appRoot = resolve(import.meta.dirname, '..');
const projectRoot = dirname(appRoot);
const options = process.argv.slice(2);
let windows = process.platform === 'win32';
let directoryOnly = false;
let publish = 'never';
let output = 'release';
for (let index = 0; index < options.length; index += 1) {
  const option = options[index];
  if (option === '--win') windows = true;
  else if (option === '--dir') directoryOnly = true;
  else if (option === '--publish') publish = 'always';
  else if (option === '--output-dir' && options[index + 1]) {
    output = options[++index];
  } else throw new Error(`Unknown packaging option: ${option}`);
}
const config = JSON.parse(
  await readFile(join(appRoot, 'config/electron-builder.json'), 'utf8'),
);
config.directories.output = output;
let staging;
try {
  if (windows) {
    // 빌드마다 새 폴더를 만들어 이전 설치 파일이나 사용자의 실행 환경을 덮어쓰지 않습니다.
    await mkdir(join(appRoot, 'release'), { recursive: true });
    staging = await mkdtemp(join(appRoot, 'release/.windows-runtime-'));
    const runtime = join(staging, 'personal-runtime');
    const sevenZipBase = await getPath7za();
    const candidates = process.env.WIKI_BUILD_7ZIP
      ? [process.env.WIKI_BUILD_7ZIP]
      : [
          join(
            dirname(sevenZipBase),
            process.platform === 'win32' ? '7zz.exe' : '7zz',
          ),
          join(
            dirname(sevenZipBase),
            process.platform === 'win32' ? '7z.exe' : '7z',
          ),
          sevenZipBase,
        ];
    const sevenZip = candidates.find((candidate) => {
      const formats = spawnSync(candidate, ['i'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return formats.status === 0 && /\bNsis\b/i.test(formats.stdout);
    });
    if (!sevenZip)
      throw new Error('NSIS-capable 7-Zip required; set WIKI_BUILD_7ZIP');
    let python = process.env.WIKI_BUILD_PYTHON;
    let pythonArguments = [];
    if (!python) {
      const local = join(
        projectRoot,
        process.platform === 'win32'
          ? '.venv/Scripts/python.exe'
          : '.venv/bin/python',
      );
      try {
        await access(local);
        python = local;
      } catch {
        python = process.platform === 'win32' ? 'py' : 'python3';
        if (process.platform === 'win32') pythonArguments = ['-3'];
      }
    }
    const prepared = spawnSync(
      python,
      [
        ...pythonArguments,
        join(appRoot, 'scripts/prepare-windows-runtime.py'),
        '--output-dir',
        runtime,
        '--seven-zip',
        sevenZip,
      ],
      { cwd: projectRoot, stdio: 'inherit', windowsHide: true },
    );
    if (prepared.error) throw prepared.error;
    if (prepared.status !== 0)
      throw new Error('Windows runtime preparation failed');
    // 실행 파일과 Python 모듈은 asar 바깥에 배치합니다.
    config.win.extraResources = [{ from: runtime, to: 'personal-runtime' }];
  }
  await build({
    projectDir: appRoot,
    config,
    publish,
    ...(windows
      ? {
          targets: Platform.WINDOWS.createTarget(
            directoryOnly ? 'dir' : undefined,
            Arch.x64,
          ),
        }
      : { dir: directoryOnly }),
  });
} finally {
  // 이번 실행에서 만든 임시 소스만 정리하고 이전 배포물은 보존합니다.
  if (staging) await rm(staging, { recursive: true, force: true });
}

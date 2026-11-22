import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  build,
  Packager,
  CancellationToken,
  Platform,
  Arch,
} from 'app-builder-lib';
import { getPath7za } from 'app-builder-lib/out/toolsets/7zip.js';

const appRoot = resolve(import.meta.dirname, '..');
const projectRoot = dirname(appRoot);
const options = process.argv.slice(2);
let selectedPlatform;
let directoryOnly = false;
let portable = false;
let publish = 'never';
let output;
let cache = join(projectRoot, '.local/build-cache/windows-runtime');
let work = tmpdir();
for (let index = 0; index < options.length; index += 1) {
  const option = options[index];
  if (option === '--win' || option === '--mac') {
    const platform = option.slice(2);
    if (selectedPlatform && selectedPlatform !== platform)
      throw new Error('Choose one desktop packaging platform: --win or --mac');
    selectedPlatform = platform;
  } else if (option === '--dir') directoryOnly = true;
  else if (option === '--portable') portable = true;
  else if (option === '--publish') publish = 'always';
  else if (
    option === '--output-dir' ||
    option === '--cache-dir' ||
    option === '--work-dir'
  ) {
    const value = options[++index];
    if (!value || value.startsWith('--'))
      throw new Error(`Missing packaging option value: ${option}`);
    if (option === '--output-dir') output = value;
    else if (option === '--cache-dir') cache = resolve(appRoot, value);
    else work = resolve(appRoot, value);
  } else throw new Error(`Unknown packaging option: ${option}`);
}
if (portable && (directoryOnly || publish !== 'never'))
  throw new Error('Portable ZIP packaging cannot use --dir or --publish');
const windows =
  selectedPlatform === 'win' ||
  (!selectedPlatform && process.platform === 'win32');
const mac =
  selectedPlatform === 'mac' ||
  (!selectedPlatform && process.platform === 'darwin');
const config = JSON.parse(
  await readFile(join(appRoot, 'config/electron-builder.json'), 'utf8'),
);
if (portable) {
  const { version } = JSON.parse(
    await readFile(join(appRoot, 'package.json'), 'utf8'),
  );
  const platform = windows ? 'windows' : mac ? 'mac' : process.platform;
  const architecture = windows ? 'x64' : mac ? 'arm64' : process.arch;
  output ??= join(
    'release',
    'portable',
    version,
    `${platform}-${architecture}`,
  );
  // 이미 생성한 포터블 배포물이나 다른 작업의 출력은 덮어쓰지 않습니다.
  await access(resolve(appRoot, output))
    .then(() => {
      throw new Error(`Portable output already exists: ${output}`);
    })
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  const key = windows ? 'win' : mac ? 'mac' : 'linux';
  config[key] = {
    ...config[key],
    artifactName: `LLM-Wiki-\${version}-${platform}-\${arch}-portable.\${ext}`,
    // Mac 포터블의 내부 무결성을 유지하며 Developer ID·공증은 사용하지 않습니다.
    ...(mac ? { identity: '-', notarize: false } : {}),
  };
  // 포터블은 설치용 최신 버전 정보·자동 설치 경로를 함께 만들지 않습니다.
  config.publish = null;
  config.extraMetadata = {
    ...config.extraMetadata,
    llmWikiDistribution: 'portable',
  };
}
config.directories.output = output ?? 'release';
let staging;
const failures = [];
const cancellation = new CancellationToken();
let interrupted;
let preparation;
let termination = Promise.resolve();
let escalation;

/** 중단 요청 뒤 일부 파일만 만든 빌더가 성공으로 반환해도 완료로 처리하지 않습니다. */
function checkInterrupted(cause) {
  if (!interrupted) return;
  const error = new Error(`Desktop packaging cancelled (${interrupted})`, {
    cause,
  });
  error.code = 'DESKTOP_PACKAGING_CANCELLED';
  throw error;
}

/** 자신이 시작한 준비 프로세스 트리만 중단하고 정리는 자식 종료 뒤에 수행합니다. */
function interrupt(signal) {
  if (interrupted) return;
  interrupted = signal;
  try {
    if (!cancellation.cancelled) cancellation.cancel();
  } catch (error) {
    failures.push(error);
  }
  const child = preparation;
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    let killer;
    try {
      killer = spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
    } catch (error) {
      failures.push(error);
      return;
    }
    termination = new Promise((done) => {
      let error;
      killer.once('error', (failure) => {
        error = failure;
      });
      killer.once('close', (code) => {
        if (error) failures.push(error);
        else if (code !== 0 && child.exitCode === null && !child.signalCode)
          failures.push(
            new Error('Could not stop owned Windows preparation tree'),
          );
        done();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') failures.push(error);
  }
  escalation = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') failures.push(error);
    }
  }, 1500);
  escalation.unref();
}

const onSigint = () => interrupt('SIGINT');
const onSigterm = () => interrupt('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

/** Python·하위 7-Zip의 처리를 기다리는 동안에도 중단 요청을 받을 수 있게 합니다. */
async function prepareRuntime(python, args) {
  checkInterrupted();
  const child = spawn(python, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  preparation = child;
  await new Promise((done, reject) => {
    let error;
    child.once('error', (failure) => {
      error = failure;
    });
    child.once('close', (code, signal) => {
      clearTimeout(escalation);
      preparation = undefined;
      if (error) reject(error);
      else if (code !== 0)
        reject(
          new Error(`Windows runtime preparation failed (${signal ?? code})`),
        );
      else done();
    });
  });
  checkInterrupted();
}

try {
  checkInterrupted();
  if (windows) {
    // 실행기 준비는 배포 폴더 밖의 전용 임시 공간에서 끝내고 정규 경로만 Python에 전달합니다.
    const temporaryRoot = await realpath(work);
    checkInterrupted();
    staging = await mkdtemp(join(temporaryRoot, 'llm-wiki-windows-runtime-'));
    checkInterrupted();
    const runtime = join(staging, 'personal-runtime');
    const sevenZipBase = await getPath7za();
    checkInterrupted();
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
    await prepareRuntime(python, [
      ...pythonArguments,
      join(appRoot, 'scripts/prepare-windows-runtime.py'),
      '--output-dir',
      runtime,
      '--cache-dir',
      cache,
      '--seven-zip',
      sevenZip,
    ]);
    // 실행 파일과 Python 모듈은 asar 바깥에 배치합니다.
    config.win.extraResources = [{ from: runtime, to: 'personal-runtime' }];
  }
  checkInterrupted();
  const buildOptions = {
    projectDir: appRoot,
    config,
    publish,
    ...(windows
      ? {
          targets: Platform.WINDOWS.createTarget(
            portable ? 'zip' : directoryOnly ? 'dir' : undefined,
            Arch.x64,
          ),
        }
      : selectedPlatform === 'mac' || (portable && mac)
        ? {
            targets: Platform.MAC.createTarget(
              portable ? 'zip' : directoryOnly ? 'dir' : undefined,
              Arch.arm64,
            ),
          }
        : {
            targets: Platform.current().createTarget(
              portable ? 'zip' : directoryOnly ? 'dir' : undefined,
            ),
          }),
  };
  await build(buildOptions, new Packager(buildOptions, cancellation));
  checkInterrupted();
} catch (error) {
  if (interrupted && error?.code !== 'DESKTOP_PACKAGING_CANCELLED') {
    try {
      checkInterrupted(error);
    } catch (cancelled) {
      failures.push(cancelled);
    }
  } else failures.push(error);
} finally {
  await termination;
  clearTimeout(escalation);
  // 이번 실행에서 만든 임시 소스만 정리하고 이전 배포물은 보존합니다.
  if (staging) {
    try {
      await rm(staging, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (cleanupError) {
      // 정리 실패가 앞선 포장 실패의 원인을 숨기지 않도록 함께 보고합니다.
      failures.push(cleanupError);
    }
  }
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
}
// 마지막 정리 중 도착한 중단도 정상 완료로 바꾸지 않습니다.
if (
  interrupted &&
  !failures.some((error) => error?.code === 'DESKTOP_PACKAGING_CANCELLED')
) {
  try {
    checkInterrupted();
  } catch (cancelled) {
    failures.unshift(cancelled);
  }
}
if (failures.length > 1)
  throw new AggregateError(
    failures,
    'Desktop packaging failed with additional cleanup or cancellation errors',
  );
if (failures.length === 1) {
  if (failures[0]?.code === 'DESKTOP_PACKAGING_CANCELLED') {
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143;
    console.error(failures[0]);
  } else throw failures[0];
}

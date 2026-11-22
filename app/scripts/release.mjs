// 사용: npm run release -- [patch|minor|major|x.y.z] [--mac] [--win] [--dry-run]
// package.json 버전과 배포 설정의 태그 접두어로 GitHub Release에 설치 파일과 latest*.yml을 올립니다.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  build,
  Packager,
  CancellationToken,
  Platform,
  Arch,
} from 'app-builder-lib';
import { githubTagPrefix } from 'builder-util-runtime';
import { createReleaseWorkspace } from './release-workspace.mjs';

const appRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// 플랫폼을 지정하지 않으면 현재 OS만 빌드합니다.
const targets = ['mac', 'win'].filter((name) => args.includes(`--${name}`));
if (targets.length === 0) {
  targets.push(process.platform === 'win32' ? 'win' : 'mac');
}
const bump = args.find((arg) => !arg.startsWith('--'));
const cancellation = new CancellationToken();
const requestAbort = new AbortController();
let interrupted;
let cancelChild;

/** 취소가 부분 빌드 성공처럼 다음 공개 단계로 넘어가지 않게 합니다. */
function assertContinuing() {
  if (interrupted) throw new Error(`릴리스를 취소했습니다 (${interrupted}).`);
}

/** 소유한 자식 종료까지 기다려 임시 경로에 늦은 쓰기가 남지 않게 합니다. */
async function run(command, commandArgs, options = {}) {
  assertContinuing();
  const child = spawn(command, commandArgs, {
    cwd: appRoot,
    detached: process.platform !== 'win32',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  let stdout = '';
  let stderr = '';
  let spawnError;
  let cancelledTree = Promise.resolve();
  child.stdout?.setEncoding('utf8').on('data', (data) => {
    stdout += data;
  });
  child.stderr?.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  child.once('error', (error) => {
    spawnError = error;
  });
  cancelChild = (signal) => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      cancelledTree = new Promise((done) => {
        const stop = spawn(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true },
        );
        stop.once('error', done);
        stop.once('close', done);
      });
    } else {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') spawnError = error;
      }
    }
  };
  const status = await new Promise((done) => child.once('close', done));
  await cancelledTree;
  cancelChild = null;
  assertContinuing();
  if (spawnError) throw spawnError;
  const result = { status, stdout, stderr };
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${commandArgs.join(' ')} 실패`);
  }
  return result;
}

const readVersion = async () =>
  JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version;

// 배포물과 소스가 어긋나지 않도록 커밋되지 않은 변경이 있으면 중단합니다.
const dirty = (
  await run('git', ['status', '--porcelain'], {
    capture: true,
  })
).stdout.trim();
if (dirty && !dryRun) {
  throw new Error('커밋되지 않은 변경이 있습니다. 커밋한 뒤 다시 실행하세요.');
}
const config = JSON.parse(
  await readFile(join(appRoot, 'config/electron-builder.json'), 'utf8'),
);
const repository = config.publish;
if (
  repository?.provider !== 'github' ||
  typeof repository.owner !== 'string' ||
  !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner) ||
  typeof repository.repo !== 'string' ||
  !/^[A-Za-z0-9_.-]{1,100}$/.test(repository.repo) ||
  ['.', '..'].includes(repository.repo)
) {
  throw new Error('electron-builder 설정의 GitHub owner/repo를 확인하세요.');
}
const releaseRepository = `${repository.owner}/${repository.repo}`;
let workspace;
let token;
let version;
let tag;
let failure;
/** 중단 신호는 소유한 요청/프로세스만 취소하고 finally의 정리를 기다립니다. */
function interrupt(signal) {
  if (interrupted) return;
  interrupted = signal;
  cancellation.cancel();
  requestAbort.abort();
  cancelChild?.(signal);
}
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
try {
  workspace = await createReleaseWorkspace(appRoot);
  assertContinuing();
  // 토큰 우선순위: GH_TOKEN 환경변수 → 저장소 루트의 .github_token(gitignore) → gh 로그인.
  async function loadToken() {
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
    try {
      const text = (
        await readFile(join(appRoot, '../.github_token'), 'utf8')
      ).trim();
      if (text) return text;
    } catch {
      /* 파일이 없으면 gh 로그인을 사용합니다. */
    }
    return (
      await run('gh', ['auth', 'token'], { capture: true })
    ).stdout.trim();
  }
  token = await loadToken();
  if (!token)
    throw new Error('GitHub 토큰이 없습니다. 루트 .github_token을 확인하세요.');
  // 업로드 전에 토큰이 저장소에 쓸 수 있는지 읽기 전용 API로 확인합니다(토큰은 출력하지 않습니다).
  const access = await fetch(
    `https://api.github.com/repos/${releaseRepository}`,
    {
      signal: requestAbort.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!access.ok)
    throw new Error(`GitHub 토큰 확인 실패 (HTTP ${access.status})`);
  if (!(await access.json()).permissions?.push) {
    throw new Error(
      `토큰에 ${releaseRepository} 저장소 쓰기(Contents) 권한이 없습니다.`,
    );
  }
  console.log('GitHub 토큰 확인 완료 (쓰기 권한 있음)');
  process.env.GH_TOKEN = token;
  if (bump) {
    await run('npm', ['version', bump, '--no-git-tag-version']);
  }
  version = await readVersion();
  tag = `${githubTagPrefix(repository)}${version}`;

  if (
    (
      await run('gh', ['release', 'view', tag, '--repo', releaseRepository], {
        capture: true,
        allowFailure: true,
      })
    ).status === 0
  ) {
    throw new Error(
      `${tag} 릴리스가 이미 있습니다. 버전을 올려 다시 실행하세요.`,
    );
  }
  await workspace.assertDestination(version);
  workspace.state.version = version;
  workspace.state.tag = tag;
  workspace.state.targets = targets;
  console.log(`릴리스 ${tag}${dryRun ? ' (dry-run: 업로드 안 함)' : ''}`);

  await run('npm', ['run', 'build']);

  const runtimeOutput = workspace.output;
  config.directories = { ...config.directories, output: workspace.output };
  const runtimeArchive = join(
    runtimeOutput,
    `llm-wiki-personal-runtime-${version}.zip`,
  );
  if (targets.includes('mac')) {
    await run('npm', [
      'run',
      'package:runtime',
      '--',
      '--output-dir',
      runtimeOutput,
    ]);
  }

  // 여러 플랫폼의 publisher가 같은 초안에 업로드하고 모두 성공한 뒤에만 공개합니다.
  if (!dryRun) {
    await run('gh', [
      'release',
      'create',
      tag,
      '--repo',
      releaseRepository,
      '--draft',
      '--title',
      version,
    ]);
    process.env.EP_DRAFT = 'true';
  }

  if (process.env.CSC_NAME) {
    config.mac = {
      ...config.mac,
      identity: process.env.CSC_NAME,
      hardenedRuntime: true,
      notarize: true,
    };
  }
  const publish = dryRun ? 'never' : 'always';

  // 같은 태그의 Release에 플랫폼별 산출물과 latest*.yml을 차례로 추가합니다.
  if (targets.includes('mac')) {
    assertContinuing();
    const options = {
      projectDir: appRoot,
      config,
      targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
      publish,
    };
    await build(options, new Packager(options, cancellation));
    assertContinuing();
  }
  if (targets.includes('win')) {
    await run('node', [
      'scripts/package-desktop.mjs',
      '--win',
      '--output-dir',
      workspace.output,
      '--cache-dir',
      workspace.cache,
      '--work-dir',
      workspace.temporary,
      ...(dryRun ? [] : ['--publish']),
    ]);
  }
  await workspace.prepare(version, targets.includes('mac'), targets);
  assertContinuing();
  if (!dryRun) {
    if (targets.includes('mac')) {
      await run('gh', [
        'release',
        'upload',
        tag,
        runtimeArchive,
        `${runtimeArchive}.sha256`,
        '--repo',
        releaseRepository,
      ]);
    }
    await workspace.assertUnchanged();
    assertContinuing();
    workspace.state.publicationAttempted = true;
    await run('gh', [
      'release',
      'edit',
      tag,
      '--repo',
      releaseRepository,
      '--draft=false',
      '--latest',
    ]);
    workspace.state.published = true;
    await workspace.install();
  } else {
    await workspace.preview();
  }
} catch (error) {
  failure = error;
} finally {
  try {
    const message = failure ? String(failure.message ?? failure) : null;
    if (workspace) {
      if (
        failure &&
        workspace.state.publicationAttempted &&
        !workspace.state.published
      )
        workspace.state.published = null;
      await workspace.close(
        message && token ? message.replaceAll(token, '[redacted]') : message,
      );
    }
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError(
          [failure, cleanupError],
          '릴리스 실행과 임시 자료 정리에 실패했습니다.',
        )
      : cleanupError;
  }
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
if (failure) {
  if (workspace?.state.published)
    throw new Error(
      `GitHub 공개는 완료됐지만 로컬 정리에 실패했습니다. 기록: ${workspace.recordDirectory}`,
      { cause: failure },
    );
  throw failure;
}
console.log(
  `${tag} 완료 (${targets.join(', ')}) · ${dryRun ? workspace.state.preview : join(appRoot, 'release', version)}`,
);

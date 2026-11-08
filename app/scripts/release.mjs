// 사용: npm run release -- [patch|minor|major|x.y.z] [--mac] [--win] [--dry-run]
// package.json 버전과 배포 설정의 태그 접두어로 GitHub Release에 설치 파일과 latest*.yml을 올립니다.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, Platform, Arch } from 'electron-builder';
import { githubTagPrefix } from 'builder-util-runtime';

const appRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
// 플랫폼을 지정하지 않으면 현재 OS만 빌드합니다.
const targets = ['mac', 'win'].filter((name) => args.includes(`--${name}`));
if (targets.length === 0) {
  targets.push(process.platform === 'win32' ? 'win' : 'mac');
}
const bump = args.find((arg) => !arg.startsWith('--'));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: appRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${commandArgs.join(' ')} 실패`);
  }
  return result;
}

const readVersion = async () =>
  JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version;

// 배포물과 소스가 어긋나지 않도록 커밋되지 않은 변경이 있으면 중단합니다.
const dirty = run('git', ['status', '--porcelain'], {
  capture: true,
}).stdout.trim();
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
  return run('gh', ['auth', 'token'], { capture: true }).stdout.trim();
}
const token = await loadToken();
if (!token)
  throw new Error('GitHub 토큰이 없습니다. 루트 .github_token을 확인하세요.');
// 업로드 전에 토큰이 저장소에 쓸 수 있는지 읽기 전용 API로 확인합니다(토큰은 출력하지 않습니다).
const access = await fetch(
  `https://api.github.com/repos/${releaseRepository}`,
  {
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
  run('npm', ['version', bump, '--no-git-tag-version']);
}
const version = await readVersion();
const tag = `${githubTagPrefix(repository)}${version}`;

if (
  run('gh', ['release', 'view', tag, '--repo', releaseRepository], {
    capture: true,
    allowFailure: true,
  }).status === 0
) {
  throw new Error(
    `${tag} 릴리스가 이미 있습니다. 버전을 올려 다시 실행하세요.`,
  );
}
console.log(`릴리스 ${tag}${dryRun ? ' (dry-run: 업로드 안 함)' : ''}`);

run('npm', ['run', 'build']);

const runtimeOutput = resolve(appRoot, config.directories?.output ?? 'release');
const runtimeArchive = join(
  runtimeOutput,
  `llm-wiki-personal-runtime-${version}.zip`,
);
if (targets.includes('mac')) {
  run('npm', ['run', 'package:runtime', '--', '--output-dir', runtimeOutput]);
}

// 여러 플랫폼의 publisher가 같은 초안에 업로드하고 모두 성공한 뒤에만 공개합니다.
if (!dryRun) {
  run('gh', [
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
  await build({
    projectDir: appRoot,
    config,
    targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
    publish,
  });
}
if (targets.includes('win')) {
  run('node', [
    'scripts/package-desktop.mjs',
    '--win',
    ...(dryRun ? [] : ['--publish']),
  ]);
}
if (!dryRun) {
  if (targets.includes('mac')) {
    run('gh', [
      'release',
      'upload',
      tag,
      runtimeArchive,
      `${runtimeArchive}.sha256`,
      '--repo',
      releaseRepository,
    ]);
  }
  run('gh', [
    'release',
    'edit',
    tag,
    '--repo',
    releaseRepository,
    '--draft=false',
    '--latest',
  ]);
}
console.log(`${tag} 완료 (${targets.join(', ')})`);

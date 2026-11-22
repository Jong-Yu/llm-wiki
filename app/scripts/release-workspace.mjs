import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import semver from 'semver';
import yaml from 'js-yaml';

/** 태그와 폴더에 쓰는 엄격한 SemVer를 build metadata까지 보존합니다. */
function versionName(value) {
  const parsed = semver.parse(value);
  if (!parsed) return false;
  const build = parsed.build.length ? `+${parsed.build.join('.')}` : '';
  return `${parsed.version}${build}` === value;
}

/** 없는 경로만 정상적인 빈 결과로 구별합니다. */
async function inspect(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** 출력·기록의 부모 폴더가 다른 위치를 가리키는 링크이면 중단합니다. */
async function plainDirectory(parent, name) {
  const path = join(parent, name);
  await mkdir(path, { recursive: false }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`실제 폴더가 필요합니다: ${path}`);
  return path;
}

/** 메타정보의 파일명을 출력 폴더 내부 한 파일로 제한합니다. */
function localName(value) {
  if (typeof value !== 'string') throw new Error('배포 파일명이 없습니다.');
  const name = decodeURIComponent(value);
  if (!name || name === '.' || name === '..' || /[\\/:]/.test(name))
    throw new Error(`배포 파일 경로가 올바르지 않습니다: ${value}`);
  return name;
}

/** 링크나 폴더를 배포 파일로 복사하지 않습니다. */
async function regularFile(root, name) {
  const path = join(root, localName(name));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`일반 배포 파일이 필요합니다: ${name}`);
  return readFile(path);
}

/** 실제 업데이트 메타정보가 참조한 파일과 그 부속 파일만 수집합니다. */
export async function collectReleaseFiles(
  root,
  version,
  requireRuntime = false,
  targets = [],
) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = new Set();
  let metadata = 0;
  const platformMetadata = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    let data;
    try {
      data = yaml.load(await readFile(join(root, entry.name), 'utf8'));
    } catch {
      continue;
    }
    if (data?.version !== version || !Array.isArray(data.files)) continue;
    if (data.files.length === 0)
      throw new Error('업데이트 파일 목록이 비었습니다.');
    metadata += 1;
    if (entry.name.endsWith('-mac.yml')) platformMetadata.add('mac');
    else if (entry.name.endsWith('.yml')) platformMetadata.add('win');
    files.add(entry.name);
    for (const file of data.files) {
      const name = localName(file.url);
      const body = await regularFile(root, name);
      if (
        body.length !== file.size ||
        createHash('sha512').update(body).digest('base64') !== file.sha512
      )
        throw new Error(`업데이트 메타정보와 파일이 다릅니다: ${name}`);
      files.add(name);
      if (await inspect(join(root, `${name}.blockmap`))) {
        await regularFile(root, `${name}.blockmap`);
        files.add(`${name}.blockmap`);
      }
    }
  }
  if (metadata === 0)
    throw new Error('해당 버전의 업데이트 메타정보가 없습니다.');
  for (const target of targets)
    if (!platformMetadata.has(target))
      throw new Error(
        `선택한 플랫폼의 업데이트 메타정보가 없습니다: ${target}`,
      );
  const runtime = `llm-wiki-personal-runtime-${version}.zip`;
  if (requireRuntime || (await inspect(join(root, runtime)))) {
    const body = await regularFile(root, runtime);
    const checksum = (await regularFile(root, `${runtime}.sha256`))
      .toString('utf8')
      .trim();
    if (
      checksum !==
      `${createHash('sha256').update(body).digest('hex')}  ${runtime}`
    )
      throw new Error('개인 실행기 체크섬이 일치하지 않습니다.');
    files.add(runtime);
    files.add(`${runtime}.sha256`);
  }
  return [...files].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** 이전 폴더가 검증 가능한 배포 파일만 담은 버전 폴더인지 확인합니다. */
async function isPreviousRelease(root, name) {
  if (!versionName(name)) return false;
  const info = await inspect(join(root, name));
  if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  try {
    const files = await collectReleaseFiles(join(root, name), name);
    const entries = await readdir(join(root, name));
    return (
      entries.length === files.length &&
      entries.every((file) => files.includes(file))
    );
  } catch {
    return false;
  }
}

/** Finder가 새로 만드는 폴더 표시 캐시는 다른 패키징 출력으로 보지 않습니다. */
async function releaseEntries(root) {
  const entries = await readdir(root);
  const finder = await inspect(join(root, '.DS_Store'));
  return finder?.isFile() && !finder.isSymbolicLink()
    ? entries.filter((name) => name !== '.DS_Store')
    : entries;
}

/** 한 실행의 임시 작업·진단·출력 교체를 묶고 다른 실행의 자료는 건드리지 않습니다. */
export async function createReleaseWorkspace(appRoot) {
  const releaseRoot = await plainDirectory(appRoot, 'release');
  const localRoot = await plainDirectory(dirname(appRoot), '.local');
  const recordsRoot = await plainDirectory(localRoot, 'releases');
  const lockPath = join(recordsRoot, 'release.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(`다른 릴리스가 실행 중입니다: ${lockPath}`);
    throw error;
  }
  let temporary;
  let pending;
  let recordDirectory;
  let closed = false;
  const state = {
    published: false,
    installed: false,
    removed: [],
    retained: [],
  };
  const lockIdentity = await lock.stat();
  try {
    const runs = await plainDirectory(recordsRoot, 'runs');
    recordDirectory = await plainDirectory(
      runs,
      `${Date.now()}-${randomUUID()}`,
    );
    temporary = await realpath(
      await mkdtemp(join(tmpdir(), 'llm-wiki-release-')),
    );
    const output = await plainDirectory(temporary, 'output');
    const cache = await plainDirectory(temporary, 'cache');
    const initialEntries = new Map();
    for (const name of await releaseEntries(releaseRoot)) {
      const info = await lstat(join(releaseRoot, name));
      initialEntries.set(name, { ino: info.ino, dev: info.dev });
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, recordDirectory }));

    /** 기존 같은 버전의 로컬 파일도 덮어쓰지 않습니다. */
    async function assertDestination(version) {
      if (!versionName(version) || basename(version) !== version)
        throw new Error('배포 버전이 올바르지 않습니다.');
      if (await inspect(join(releaseRoot, version)))
        throw new Error(`이미 로컬 배포 폴더가 있습니다: ${version}`);
    }

    /** 다른 패키징/사용자가 새로 만든 출력은 옮기거나 삭제하지 않습니다. */
    async function assertUnchanged() {
      const entries = (await releaseEntries(releaseRoot)).filter(
        (name) => !pending || name !== basename(pending),
      );
      if (entries.length !== initialEntries.size)
        throw new Error(
          '릴리스 출력에 다른 작업의 변경이 있습니다. 기존 자료를 보존했습니다.',
        );
      for (const name of entries) {
        const before = initialEntries.get(name);
        const now = await lstat(join(releaseRoot, name));
        if (!before || before.ino !== now.ino || before.dev !== now.dev)
          throw new Error(
            '릴리스 출력에 다른 작업의 변경이 있습니다. 기존 자료를 보존했습니다.',
          );
      }
    }

    return {
      output,
      cache,
      temporary,
      recordDirectory,
      state,
      assertDestination,
      assertUnchanged,
      /** 공개 전에 완성된 파일을 같은 파일시스템의 전용 폴더로 준비합니다. */
      async prepare(version, requireRuntime, targets = []) {
        await assertDestination(version);
        await assertUnchanged();
        const files = await collectReleaseFiles(
          output,
          version,
          requireRuntime,
          targets,
        );
        pending = await mkdtemp(join(releaseRoot, '.publish-'));
        for (const name of files)
          await copyFile(
            join(output, name),
            join(pending, name),
            constants.COPYFILE_EXCL,
          );
        state.version = version;
        state.files = files;
      },
      /** dry-run 산출물은 검토 위치에 보존하고 현재 배포 폴더는 바꾸지 않습니다. */
      async preview() {
        if (!pending) throw new Error('준비한 배포 파일이 없습니다.');
        state.preview = join(recordDirectory, 'preview');
        await rename(pending, state.preview);
        pending = null;
      },
      /** 성공한 배포만 공개 폴더로 바꾸며 이전 파일은 그 뒤에 정리합니다. */
      async install() {
        if (!pending) throw new Error('준비한 배포 파일이 없습니다.');
        await assertDestination(state.version);
        await assertUnchanged();
        await rename(pending, join(releaseRoot, state.version));
        pending = null;
        state.installed = true;
        for (const entry of initialEntries.keys()) {
          if (await isPreviousRelease(releaseRoot, entry)) {
            await rm(join(releaseRoot, entry), { recursive: true });
            state.removed.push(entry);
          } else {
            // 알 수 없는 기존 기록·사용자 파일은 삭제하지 않고 별도로 보존합니다.
            const retained = await plainDirectory(recordDirectory, 'retained');
            await rename(join(releaseRoot, entry), join(retained, entry));
            state.retained.push({ name: entry, path: join(retained, entry) });
          }
        }
        const finder = await inspect(join(releaseRoot, '.DS_Store'));
        if (finder?.isFile() && !finder.isSymbolicLink())
          await unlink(join(releaseRoot, '.DS_Store'));
        const remaining = await releaseEntries(releaseRoot);
        if (remaining.length !== 1 || remaining[0] !== state.version)
          throw new Error('공개 후 다른 작업이 만든 출력은 보존했습니다.');
      },
      /** 성공·실패 모두 작업물/캐시는 없애고 작은 진단과 실제 상태를 남깁니다. */
      async close(error = null) {
        if (closed) return;
        closed = true;
        const failures = [];
        const attempt = async (action) => {
          try {
            await action();
          } catch (failure) {
            failures.push(failure);
          }
        };
        await attempt(async () => {
          for (const entry of await readdir(output)) {
            if (!/^builder.*\.(?:ya?ml|json|log)$/.test(entry)) continue;
            if (!(await lstat(join(output, entry))).isFile()) continue;
            const diagnostics = await plainDirectory(
              recordDirectory,
              'diagnostics',
            );
            await copyFile(
              join(output, entry),
              join(diagnostics, entry),
              constants.COPYFILE_EXCL,
            );
          }
        });
        if (pending)
          await attempt(() =>
            rm(pending, { recursive: true, force: true, maxRetries: 3 }),
          );
        await attempt(() =>
          rm(temporary, { recursive: true, force: true, maxRetries: 3 }),
        );
        await attempt(async () => {
          const current = await inspect(lockPath);
          if (
            current &&
            (current.ino !== lockIdentity.ino ||
              current.dev !== lockIdentity.dev)
          )
            throw new Error('다른 실행의 릴리스 잠금을 보존했습니다.');
          if (current) await unlink(lockPath);
        });
        await attempt(() => lock.close());
        await attempt(() =>
          writeFile(
            join(recordDirectory, 'RUN.json'),
            JSON.stringify(
              {
                ...state,
                error,
                cleanupErrors: failures.map((failure) => failure.message),
              },
              null,
              2,
            ),
          ),
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            `릴리스 상태는 보존했지만 임시 자료 정리에 실패했습니다: ${recordDirectory}`,
          );
      },
    };
  } catch (error) {
    const failures = [error];
    for (const action of [
      async () => {
        if (temporary)
          await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
      },
      async () => {
        const current = await inspect(lockPath);
        if (
          current &&
          current.ino === lockIdentity.ino &&
          current.dev === lockIdentity.dev
        )
          await unlink(lockPath);
      },
      () => lock.close(),
    ]) {
      try {
        await action();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        '릴리스 작업 준비와 정리에 실패했습니다.',
      );
    throw error;
  }
}

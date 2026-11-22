import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { fixture, releaseFiles } from './fixtures.mjs';
import {
  collectReleaseFiles,
  createReleaseWorkspace,
} from '../../scripts/release-workspace.mjs';

await test('successful promotion leaves only its version, removes older verified releases and retains unknown records', async () => {
  await fixture(async ({ app, release }) => {
    await releaseFiles(join(release, '0.1.0'), '0.1.0');
    await mkdir(join(release, 'verification'));
    await writeFile(join(release, 'verification/proof.json'), 'existing proof');
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '0.2.0');
    await writeFile(join(work.output, 'builder-debug.yml'), 'invalid: [');
    await mkdir(join(work.output, 'mac-arm64'));
    await writeFile(join(work.cache, 'download.zip'), 'temporary cache');
    const files = await collectReleaseFiles(work.output, '0.2.0', true, [
      'mac',
      'win',
    ]);
    assert.equal(files.length, 10);
    await work.prepare('0.2.0', true, ['mac', 'win']);
    work.state.published = true;
    await work.install();
    await work.close();
    assert.deepEqual(await readdir(release), ['0.2.0']);
    assert.deepEqual((await readdir(join(release, '0.2.0'))).sort(), files);
    assert.equal(
      await readFile(
        join(work.recordDirectory, 'retained/verification/proof.json'),
        'utf8',
      ),
      'existing proof',
    );
    assert.equal(
      await readFile(
        join(work.recordDirectory, 'diagnostics/builder-debug.yml'),
        'utf8',
      ),
      'invalid: [',
    );
    await assert.rejects(
      readFile(join(app, '../.local/releases/release.lock')),
      { code: 'ENOENT' },
    );
    await assert.rejects(readdir(work.temporary), { code: 'ENOENT' });
    assert.deepEqual(work.state.removed, ['0.1.0']);
  });
});

await test('publication failure after preparing artifacts removes pending/temp/cache while previous output remains intact', async () => {
  await fixture(async ({ app, release }) => {
    await releaseFiles(join(release, '1.0.0'), '1.0.0');
    const previous = await readFile(join(release, '1.0.0/Example-1.0.0.exe'));
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '1.1.0');
    await writeFile(join(work.cache, 'cached'), 'temporary');
    await work.prepare('1.1.0', true);
    await work.close('publication failed');
    assert.deepEqual(await readdir(release), ['1.0.0']);
    assert.deepEqual(
      await readFile(join(release, '1.0.0/Example-1.0.0.exe')),
      previous,
    );
    await assert.rejects(readdir(work.temporary), { code: 'ENOENT' });
    const record = JSON.parse(
      await readFile(join(work.recordDirectory, 'RUN.json'), 'utf8'),
    );
    assert.equal(record.error, 'publication failed');
    assert.equal(record.installed, false);
  });
});

await test('dry-run saves a reviewable preview outside release without pruning the current version', async () => {
  await fixture(async ({ app, release }) => {
    await releaseFiles(join(release, '0.1.0'), '0.1.0');
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '0.2.0');
    await work.prepare('0.2.0', true);
    await work.preview();
    await work.close();
    assert.deepEqual(await readdir(release), ['0.1.0']);
    assert.equal((await readdir(work.state.preview)).length, 10);
    await assert.rejects(readdir(work.temporary), { code: 'ENOENT' });
  });
});

await test('tampered old version with additional user notes is retained in full, never deleted as a release', async () => {
  await fixture(async ({ app, release }) => {
    await releaseFiles(join(release, '1.0.0'), '1.0.0');
    await writeFile(join(release, '1.0.0/notes.txt'), 'user content');
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '1.1.0');
    await work.prepare('1.1.0', true);
    await work.install();
    await work.close();
    assert.deepEqual(await readdir(release), ['1.1.0']);
    assert.equal(
      await readFile(
        join(work.recordDirectory, 'retained/1.0.0/notes.txt'),
        'utf8',
      ),
      'user content',
    );
    assert.deepEqual(work.state.removed, []);
  });
});

await test('an existing or concurrently created destination is never overwritten', async () => {
  await fixture(async ({ app, release }) => {
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '2.0.0');
    await work.prepare('2.0.0', true);
    await mkdir(join(release, '2.0.0'));
    await writeFile(join(release, '2.0.0/user.txt'), 'concurrent file');
    await assert.rejects(work.install(), /이미 로컬 배포/);
    await work.close('destination conflict');
    assert.equal(
      await readFile(join(release, '2.0.0/user.txt'), 'utf8'),
      'concurrent file',
    );
    assert.deepEqual(await readdir(release), ['2.0.0']);
  });
});

await test('checksum mismatches and missing selected-platform metadata block preparation', async () => {
  await fixture(async ({ app, release }) => {
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '2.0.0', { win: false });
    await assert.rejects(work.prepare('2.0.0', true, ['mac', 'win']), /플랫폼/);
    await writeFile(join(work.output, 'Example-2.0.0.zip'), 'changed bytes');
    await assert.rejects(
      work.prepare('2.0.0', true),
      /메타정보와 파일이 다릅니다/,
    );
    await work.close('invalid artifact');
    assert.deepEqual(await readdir(release), []);
  });
});

await test('runtime checksum errors and path traversal cannot enter the final release', async () => {
  await fixture(async ({ app, root }) => {
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '2.0.0');
    await writeFile(
      join(work.output, 'llm-wiki-personal-runtime-2.0.0.zip.sha256'),
      'bad checksum',
    );
    await assert.rejects(work.prepare('2.0.0', true), /체크섬/);
    await writeFile(join(root, 'outside.txt'), 'outside');
    await writeFile(
      join(work.output, 'latest.yml'),
      yaml.dump({ version: '2.0.0', files: [{ url: '../outside.txt' }] }),
    );
    await assert.rejects(work.prepare('2.0.0', false), /경로/);
    await work.close('invalid paths');
    assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'outside');
  });
});

await test('a symlink artifact is rejected and its external target is preserved', async () => {
  await fixture(async ({ app, root }) => {
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '2.0.0');
    const source = join(work.output, 'Example-2.0.0.zip');
    const outside = join(root, 'outside.zip');
    await writeFile(outside, await readFile(source));
    await unlink(source);
    await symlink(outside, source);
    await assert.rejects(work.prepare('2.0.0', true), /일반 배포 파일/);
    await work.close('symlink rejected');
    assert.equal(await readFile(outside, 'utf8'), '2.0.0:zip');
  });
});

await test('concurrent release attempts are locked out and normal cleanup releases the lock', async () => {
  await fixture(async ({ app }) => {
    const work = await createReleaseWorkspace(app);
    await assert.rejects(createReleaseWorkspace(app), /다른 릴리스/);
    await work.close();
    const next = await createReleaseWorkspace(app);
    await next.close();
  });
});

await test('a replaced lock is preserved while owned temporary data is still cleaned', async () => {
  await fixture(async ({ app, root }) => {
    const work = await createReleaseWorkspace(app);
    const lock = join(root, '.local/releases/release.lock');
    await unlink(lock);
    await writeFile(lock, 'other owner');
    await assert.rejects(work.close(), AggregateError);
    assert.equal(await readFile(lock, 'utf8'), 'other owner');
    await assert.rejects(readdir(work.temporary), { code: 'ENOENT' });
    const record = JSON.parse(
      await readFile(join(work.recordDirectory, 'RUN.json'), 'utf8'),
    );
    assert.equal(record.cleanupErrors.length, 1);
  });
});

await test('setup failure removes its lock and preserves unrelated local records', async () => {
  await fixture(async ({ app, root }) => {
    await mkdir(join(root, '.local/releases'), { recursive: true });
    await writeFile(join(root, '.local/releases/runs'), 'existing record');
    await assert.rejects(createReleaseWorkspace(app), /실제 폴더/);
    await assert.rejects(readFile(join(root, '.local/releases/release.lock')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(root, '.local/releases/runs'), 'utf8'),
      'existing record',
    );
  });
});

await test('a linked release root is refused without touching the target', async () => {
  await fixture(async ({ app, root }) => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    await symlink(outside, join(app, 'release'), 'dir');
    await assert.rejects(createReleaseWorkspace(app), /실제 폴더/);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
  });
});

await test('new output from a separate packager blocks preparation and is preserved', async () => {
  await fixture(async ({ app, release }) => {
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '2.0.0');
    await writeFile(join(release, 'other-package.exe'), 'other run');
    await assert.rejects(work.prepare('2.0.0', true), /다른 작업의 변경/);
    await work.close('concurrent output');
    assert.equal(
      await readFile(join(release, 'other-package.exe'), 'utf8'),
      'other run',
    );
  });
});

await test('output added after preparation is never archived or deleted by installation', async () => {
  await fixture(async ({ app, release }) => {
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '2.0.0');
    await work.prepare('2.0.0', true);
    await writeFile(join(release, 'other-record.json'), 'new record');
    await assert.rejects(work.assertUnchanged(), /다른 작업의 변경/);
    await assert.rejects(work.install(), /다른 작업의 변경/);
    await work.close('concurrent output');
    assert.deepEqual(await readdir(release), ['other-record.json']);
    assert.equal(
      await readFile(join(release, 'other-record.json'), 'utf8'),
      'new record',
    );
  });
});

await test('Finder metadata created during packaging is cleaned without a false concurrent-output conflict', async () => {
  await fixture(async ({ app, release }) => {
    const work = await createReleaseWorkspace(app);
    await releaseFiles(work.output, '2.0.0');
    await writeFile(join(release, '.DS_Store'), 'finder cache');
    await work.prepare('2.0.0', true);
    await work.install();
    await work.close();
    assert.deepEqual(await readdir(release), ['2.0.0']);
  });
});

await test('strict prerelease versions with build metadata retain their complete folder name', async () => {
  await fixture(async ({ app, release }) => {
    const version = '3.2.1-rc.1+commit.9';
    const work = await createReleaseWorkspace(app);
    await assert.rejects(work.assertDestination('../3.2.1'), /버전/);
    await assert.rejects(work.assertDestination('v3.2.1'), /버전/);
    await releaseFiles(work.output, version);
    await work.prepare(version, true);
    await work.install();
    await work.close();
    assert.deepEqual(await readdir(release), [version]);
  });
});

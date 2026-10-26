import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { rolldown } from 'rolldown';
const root = resolve(import.meta.dirname, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'ui11-runtime-'));
const bundle = await rolldown({
  input: {
    service: join(root, 'src/main/settings/RuntimeSettingsService.ts'),
    ai: join(root, 'src/main/backend/personalAi.ts'),
    contract: join(root, 'src/shared/contracts/runtime.contract.ts'),
  },
  platform: 'node',
  resolve: { alias: { '@contracts': join(root, 'src/shared/contracts') } },
});
await bundle.write({
  dir: temporary,
  entryFileNames: '[name].mjs',
  format: 'esm',
});
await bundle.close();
const { RuntimeSettingsService } = await import(
  pathToFileURL(join(temporary, 'service.mjs')).href
);
const { personalAi, claudeExecutable } = await import(
  pathToFileURL(join(temporary, 'ai.mjs')).href
);
const { runtimeRequestSchema } = await import(
  pathToFileURL(join(temporary, 'contract.mjs')).href
);
await test('개인 실행 환경', async (t) => {
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });
  await t.test(
    '선택 경로는 다음 시작에만 적용하고 충돌·손상 파일을 보존한다',
    async () => {
      const environmentBefore = { ...process.env };
      const directory = join(temporary, 'settings');
      let chosen = null;
      try {
        delete process.env.WIKI_AI_PROVIDER;
        const first = new RuntimeSettingsService(
          directory,
          resolve(root, '..'),
          async () => chosen,
        );
        process.env.WIKI_QUESTION_CODEX_CLI = '/explicit/question-cli';
        process.env.WIKI_PROPOSAL_CODEX_CLI = '/explicit/proposal-cli';
        await first.initialize();
        assert.equal(
          process.env.WIKI_QUESTION_CODEX_CLI,
          '/explicit/question-cli',
        );
        assert.equal(
          process.env.WIKI_PROPOSAL_CODEX_CLI,
          '/explicit/proposal-cli',
        );
        const initial = first.snapshot();
        assert.equal(initial.activeProvider, 'codex');
        await first.save();
        const stale = new RuntimeSettingsService(
          directory,
          '',
          async () => null,
        );
        await stale.initialize();
        chosen = '/usr/bin/true';
        await first.choose('codex');
        chosen = '/personal/claude';
        await first.choose('claude');
        first.selectProvider('claude');
        assert.equal(first.snapshot().saved, false);
        await first.save();
        assert.equal(first.snapshot().restartRequired, true);
        assert.equal(
          process.env.WIKI_ANALYSIS_CODEX_CLI,
          initial.settings.codex,
        );
        assert.equal(process.env.WIKI_AI_PROVIDER, 'codex');
        assert.equal(first.snapshot().activeProvider, 'codex');
        const bytes = await readFile(join(directory, 'runtime.json'));
        await assert.rejects(stale.save());
        assert.deepEqual(
          await readFile(join(directory, 'runtime.json')),
          bytes,
        );
        const restarted = new RuntimeSettingsService(
          directory,
          '',
          async () => null,
        );
        await restarted.initialize();
        assert.equal(restarted.snapshot().settings.codex, '/usr/bin/true');
        assert.equal(restarted.snapshot().settings.provider, 'claude');
        assert.equal(restarted.snapshot().activeProvider, 'claude');
        assert.equal(process.env.WIKI_AI_PROVIDER, 'claude');
        assert.deepEqual(await personalAi('analysis'), {
          provider: 'claude',
          cli: '/personal/claude',
        });
        assert.deepEqual(await personalAi('question'), {
          provider: 'claude',
          cli: '/personal/claude',
        });
        assert.deepEqual(await personalAi('proposal'), {
          provider: 'claude',
          cli: '/personal/claude',
        });
        assert.equal(process.env.WIKI_ANALYSIS_CODEX_CLI, '/usr/bin/true');
        assert.equal(process.env.WIKI_QUESTION_CODEX_CLI, '/usr/bin/true');
        assert.equal(process.env.WIKI_PROPOSAL_CODEX_CLI, '/usr/bin/true');
        assert.equal(restarted.snapshot().restartRequired, false);
        await writeFile(join(directory, 'runtime.json'), 'corrupt');
        const broken = new RuntimeSettingsService(
          directory,
          '',
          async () => null,
        );
        await broken.initialize();
        assert.match(broken.snapshot().issue, /보존/);
        await assert.rejects(broken.save());
        assert.equal(
          await readFile(join(directory, 'runtime.json'), 'utf8'),
          'corrupt',
        );
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in environmentBefore)) delete process.env[key];
        Object.assign(process.env, environmentBefore);
      }
    },
  );
  await t.test(
    '기존 v1은 Codex로 읽고 저장 전 바이트를 보존하며 v2로 명시 저장한다',
    async () => {
      const before = { ...process.env };
      const directory = join(temporary, 'legacy');
      const settings = {
        root: resolve(root, '..'),
        python: resolve(root, '../.venv/bin/python'),
        codex: '/legacy/codex',
        tesseract: '',
        tessdata: '',
      };
      const bytes = JSON.stringify({ version: 1, settings });
      await mkdir(directory);
      await writeFile(join(directory, 'runtime.json'), bytes);
      try {
        process.env.WIKI_AI_PROVIDER = 'claude';
        const service = new RuntimeSettingsService(
          directory,
          '',
          async () => null,
        );
        await service.initialize();
        assert.equal(service.snapshot().settings.provider, 'codex');
        assert.ok(service.snapshot().settings.claude);
        assert.equal(
          await readFile(join(directory, 'runtime.json'), 'utf8'),
          bytes,
        );
        assert.deepEqual(await personalAi('question'), {
          provider: 'codex',
          cli: '/legacy/codex',
        });
        await service.save();
        assert.equal(
          JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'))
            .version,
          2,
        );
        process.env.WIKI_QUESTION_CODEX_CLI = '/question/codex';
        process.env.WIKI_PROPOSAL_CODEX_CLI = '/proposal/codex';
        assert.deepEqual(await personalAi('question'), {
          provider: 'codex',
          cli: '/question/codex',
        });
        assert.deepEqual(await personalAi('proposal'), {
          provider: 'codex',
          cli: '/proposal/codex',
        });
        process.env.WIKI_AI_PROVIDER = 'unknown';
        await assert.rejects(personalAi('analysis'));
        assert.equal(
          runtimeRequestSchema.safeParse({
            operation: 'select-provider',
            provider: 'unknown',
          }).success,
          false,
        );
        assert.equal(
          runtimeRequestSchema.safeParse({
            operation: 'select-provider',
            provider: 'claude',
            command: 'shell command',
          }).success,
          false,
        );
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in before)) delete process.env[key];
        Object.assign(process.env, before);
      }
    },
  );
  await t.test(
    'Claude 진단은 선택한 경로와 제공자를 전달하고 로그인 실패를 구별한다',
    async () => {
      const before = { ...process.env };
      const python = join(temporary, 'diagnostic-python');
      await writeFile(
        python,
        `#!${process.execPath}\nconst args = process.argv;\nif (args.includes('tools.runtime_doctor')) {\n  const selected = args[args.indexOf('--ai-provider') + 1] === 'claude' && args[args.indexOf('--ai-cli') + 1] === '/selected/claude';\n  process.stdout.write(JSON.stringify({python_supported: selected, dependencies: [], ai: {status: 'error', login: 'not_logged_in'}}));\n} else process.stdout.write(JSON.stringify({diagnostics:{tesseract:{available:false}}}));\n`,
        { mode: 0o700 },
      );
      try {
        process.env.WIKI_AI_PROVIDER = 'codex';
        let chosen = python;
        const service = new RuntimeSettingsService(
          join(temporary, 'diagnosis'),
          resolve(root, '..'),
          async () => chosen,
        );
        await service.choose('python');
        chosen = '/selected/claude';
        await service.choose('claude');
        service.selectProvider('claude');
        const result = await service.diagnose();
        assert.equal(result.checks[0].status, 'ok');
        assert.equal(result.checks[2].name, 'Claude Code CLI·로그인');
        assert.equal(result.checks[2].status, 'error');
        assert.match(result.checks[2].detail, /Claude Code/);
        assert.doesNotMatch(result.checks[2].detail, /Codex/);
        assert.equal(process.env.WIKI_AI_PROVIDER, 'codex');
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in before)) delete process.env[key];
        Object.assign(process.env, before);
      }
    },
  );
  await t.test('실행 실패는 원시 오류·비밀 없이 진단으로 남는다', async () => {
    const service = new RuntimeSettingsService(
      join(temporary, 'failure'),
      '',
      async () => '/nonexistent/python',
    );
    await service.choose('python');
    const result = await service.diagnose();
    assert.equal(result.checks[0].status, 'error');
    assert.doesNotMatch(
      JSON.stringify(result.checks),
      /ENOENT|nonexistent|token|Bearer/,
    );
  });
  await t.test(
    '최소 GUI PATH에서도 사용자 native Claude를 찾고 명시 경로를 유지한다',
    async () => {
      const before = { ...process.env };
      const nativeHome = join(temporary, 'native-home');
      const native = join(nativeHome, '.local/bin/claude');
      await mkdir(join(nativeHome, '.local/bin'), { recursive: true });
      await writeFile(native, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      try {
        process.env.PATH = '/usr/bin:/bin';
        process.env.WIKI_AI_PROVIDER = 'claude';
        assert.equal(await claudeExecutable('claude', nativeHome), native);
        process.env.WIKI_CLAUDE_CLI = '/explicit/claude';
        assert.deepEqual(await personalAi('question'), {
          provider: 'claude',
          cli: '/explicit/claude',
        });
        assert.equal(
          await claudeExecutable('claude', join(temporary, 'missing-home')),
          'claude',
        );
      } finally {
        for (const key of Object.keys(process.env))
          if (!(key in before)) delete process.env[key];
        Object.assign(process.env, before);
      }
    },
  );
});

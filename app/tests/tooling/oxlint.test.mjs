import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const appRoot = resolve(import.meta.dirname, '../..');
const cases = [
  [
    'deprecated 함수 거부',
    'src/renderer/app/probe.ts',
    '/** @deprecated Use current instead. */\ndeclare function legacy(): void;\nlegacy();',
    'typescript/no-deprecated',
  ],
  [
    'deprecated 속성 거부',
    'src/renderer/app/probe.ts',
    'declare const api: {\n/** @deprecated Use current instead. */\nlegacy: string;\n};\nexport const value = api.legacy;',
    'typescript/no-deprecated',
  ],
  [
    'React deprecated 제출 타입 거부',
    'src/renderer/app/probe.ts',
    "import type { FormEvent } from 'react';\nexport type Submission = FormEvent<HTMLFormElement>;",
    'typescript/no-deprecated',
  ],
  [
    'React 대체 제출 타입 허용',
    'src/renderer/app/probe.ts',
    "import type { SubmitEvent } from 'react';\nexport type Submission = SubmitEvent<HTMLFormElement>;",
    null,
  ],
  [
    '명시적 any 금지',
    'src/renderer/app/probe.ts',
    'export function probe(value: any): unknown { return value; }',
    'typescript/no-explicit-any',
  ],
  [
    '문맥으로 추론되는 매개변수도 타입 필수',
    'src/renderer/app/probe.ts',
    'export const values = [1].map((value): number => value);',
    'wiki/explicit-parameter-types',
  ],
  [
    '함수 반환 타입 필수',
    'src/renderer/app/probe.ts',
    'export function probe(value: number) { return value; }',
    'typescript/explicit-function-return-type',
  ],
  [
    '명시한 매개변수와 반환 타입 허용',
    'src/renderer/app/probe.ts',
    'export const values = [1].map((value: number): number => value);',
    null,
  ],
  [
    '절대경로 우회',
    'src/renderer/pages/probe.ts',
    "import '/src/main/index';",
    'import/no-absolute-path',
  ],
  [
    'renderer Node',
    'src/renderer/pages/probe.ts',
    "import 'node:fs';",
    'no-restricted-imports',
  ],
  [
    'renderer main 상대경로',
    'src/renderer/pages/probe.ts',
    "import '../../main/index';",
    'wiki/import-boundaries',
  ],
  [
    'renderer main alias',
    'src/renderer/pages/probe.ts',
    "import '@main/index';",
    'wiki/import-boundaries',
  ],
  [
    '정규화 우회',
    'src/renderer/pages/probe.ts',
    "import '../../shared/../main/index';",
    'wiki/import-boundaries',
  ],
  [
    'preload main',
    'src/preload/probe.ts',
    "import '../main/index';",
    'wiki/import-boundaries',
  ],
  [
    'page platform',
    'src/renderer/pages/probe.ts',
    "export * from '@renderer/platform/appInfo';",
    'wiki/import-boundaries',
  ],
  [
    '다른 feature',
    'src/renderer/features/first/probe.ts',
    "import '../second/index';",
    'wiki/import-boundaries',
  ],
  [
    '다른 domain',
    'src/renderer/domains/first/probe.ts',
    "import '@renderer/domains/second/index';",
    'wiki/import-boundaries',
  ],
  [
    '동적 import',
    'src/renderer/pages/probe.ts',
    "void import('@main/index');",
    'wiki/import-boundaries',
  ],
  [
    '타입 import',
    'src/renderer/pages/probe.ts',
    "export type Main = import('@main/index');",
    'wiki/import-boundaries',
  ],
  [
    'import equals',
    'src/preload/probe.ts',
    "import main = require('../main/index'); export { main };",
    'wiki/import-boundaries',
  ],
  [
    'contract React',
    'src/shared/contracts/probe.ts',
    "import 'react';",
    'no-restricted-imports',
  ],
  [
    '직접 bridge 접근',
    'src/renderer/pages/probe.ts',
    'window.wiki.app.getInfo();',
    'no-restricted-properties',
  ],
  [
    '조건부 Hook',
    'src/renderer/app/probe.tsx',
    "import { useState } from 'react'; export function Probe({ enabled }: { enabled: boolean }) { if (enabled) useState(0); return null; }",
    'react-hooks/rules-of-hooks',
  ],
  [
    'alias 순환',
    'src/renderer/app/a.ts',
    "export { value } from '@renderer/app/b';",
    'import/no-cycle',
  ],
  [
    '허용된 feature/domain',
    'src/renderer/features/first/probe.ts',
    "export { value } from '@renderer/domains/second/index';",
    null,
  ],
  [
    '허용된 platform/contract',
    'src/renderer/platform/probe.ts',
    "export { value } from '@contracts/index';",
    null,
  ],
];

// 실제 Oxlint CLI와 별도 임시 프로젝트로 설정/규칙의 누락과 경로 우회를 검증합니다.
void test('Oxc 전환 후 경계·Hooks·순환 검사', async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), 'wiki-oxlint-'));
  try {
    await mkdir(join(fixture, 'config/typescript'), { recursive: true });
    for (const path of [
      'import-boundaries.mjs',
      'typescript/tsconfig.base.json',
      'typescript/tsconfig.tools.json',
    ]) {
      await cp(join(appRoot, 'config', path), join(fixture, 'config', path));
    }
    await writeFile(join(fixture, 'package.json'), '{"type":"module"}');
    // 실제 설치된 타입과 동일한 설정으로 deprecated 심볼까지 검증합니다.
    await symlink(join(appRoot, 'node_modules'), join(fixture, 'node_modules'));
    await writeFile(
      join(fixture, 'tsconfig.json'),
      JSON.stringify({
        extends: './config/typescript/tsconfig.tools.json',
        compilerOptions: { types: [] },
        include: ['src/**/*.ts', 'src/**/*.tsx'],
      }),
    );
    // 같은 설정값을 JSON으로 고정해 임시 프로젝트의 패키지 설치를 생략합니다.
    const config = await import('../../config/oxlint.config.ts');
    await writeFile(
      join(fixture, 'config/oxlint.json'),
      JSON.stringify(config.default),
    );

    for (const [name, entry, code, rule] of cases) {
      await context.test(name, async () => {
        await rm(join(fixture, 'src'), { recursive: true, force: true });
        const files = {
          'src/main/index.ts': 'export const value = 1;',
          'src/renderer/platform/appInfo.ts': 'export const value = 1;',
          'src/renderer/domains/second/index.ts': 'export const value = 1;',
          'src/renderer/features/second/index.ts': 'export const value = 1;',
          'src/shared/contracts/index.ts': 'export const value = 1;',
          'src/renderer/app/b.ts': "export { value } from '@renderer/app/a';",
          [entry]: code,
        };
        for (const [path, content] of Object.entries(files)) {
          await mkdir(dirname(join(fixture, path)), { recursive: true });
          await writeFile(join(fixture, path), content);
        }
        const result = spawnSync(
          process.execPath,
          [
            join(appRoot, 'node_modules/oxlint/bin/oxlint'),
            '--config',
            'config/oxlint.json',
            '--tsconfig',
            'config/typescript/tsconfig.tools.json',
            '--format',
            'json',
            '--deny-warnings',
            entry,
          ],
          { cwd: fixture, encoding: 'utf8' },
        );
        assert.ifError(result.error);
        const output = result.stdout + result.stderr;
        if (rule) {
          assert.equal(result.status, 1, output);
          const diagnostics = JSON.parse(result.stdout).diagnostics;
          assert.ok(
            diagnostics.some((diagnostic) => {
              const code = diagnostic.code.replace(
                /^([^()]+)\(([^()]+)\)$/,
                '$1/$2',
              );
              return (
                diagnostic.severity === 'error' &&
                (code === rule || code.endsWith(`/${rule}`))
              );
            }),
            output,
          );
        } else {
          assert.equal(result.status, 0, output);
        }
      });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

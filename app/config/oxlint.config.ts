import { builtinModules } from 'node:module';
import { defineConfig } from 'oxlint';

const nodeImports = [...new Set([...builtinModules, 'electron'])];
const pureImports = [...nodeImports, 'react', 'react-dom', 'jotai'];

/** 일반 규칙은 Oxlint 내장 구현으로, 앱 폴더 경계만 로컬 규칙으로 검사합니다. */
export default defineConfig({
  plugins: ['typescript', 'import', 'react', 'oxc'],
  jsPlugins: ['./import-boundaries.mjs'],
  categories: { correctness: 'error' },
  env: { es2024: true, node: true },
  options: { typeAware: true },
  ignorePatterns: ['**/src/renderer/shared/theme/tokens.ts'],
  rules: {
    'import/no-cycle': 'error',
    'import/no-absolute-path': 'error',
    'typescript/consistent-type-imports': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-deprecated': 'error',
    'wiki/import-boundaries': 'error',
  },
  overrides: [
    {
      files: ['**/src/**/*.{ts,tsx}'],
      rules: {
        'typescript/explicit-function-return-type': [
          'error',
          {
            allowExpressions: false,
            allowTypedFunctionExpressions: false,
            allowHigherOrderFunctions: false,
            allowDirectConstAssertionInArrowFunctions: false,
          },
        ],
        'wiki/explicit-parameter-types': 'error',
      },
    },
    {
      files: [
        '**/src/renderer/**/*.{ts,tsx}',
        '**/src/shared/contracts/**/*.ts',
        '**/src/shared/createWikiBridge.ts',
        '**/src/web-test/client.ts',
        '**/src/web-test/browserFiles.ts',
      ],
      env: { browser: true, node: false },
      rules: {
        'no-restricted-imports': [
          'error',
          { paths: nodeImports, patterns: ['node:*'] },
        ],
        'no-restricted-globals': [
          'error',
          'process',
          'Buffer',
          'require',
          '__dirname',
          '__filename',
        ],
      },
    },
    {
      files: ['**/src/renderer/**/*.{ts,tsx}'],
      rules: {
        'react/rules-of-hooks': 'error',
        'react/exhaustive-deps': 'error',
      },
    },
    {
      files: ['**/src/renderer/**/*.{ts,tsx}'],
      excludeFiles: ['**/src/renderer/platform/**'],
      rules: {
        'no-restricted-properties': [
          'error',
          {
            object: 'window',
            property: 'wiki',
            message: 'bridge 접근은 platform이 담당합니다.',
          },
        ],
      },
    },
    {
      files: [
        '**/src/shared/contracts/**/*.ts',
        '**/src/renderer/domains/*/model/**/*.ts',
      ],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: pureImports,
            patterns: [
              'node:*',
              'react/*',
              'react-dom/*',
              'jotai/*',
              '@tanstack/*',
            ],
          },
        ],
      },
    },
  ],
});

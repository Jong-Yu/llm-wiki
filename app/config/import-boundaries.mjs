import { dirname, relative, resolve, sep } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const aliases = {
  '@contracts': 'src/shared/contracts',
  '@renderer': 'src/renderer',
  '@main': 'src/main',
};
const forbidden = {
  main: ['preload', 'renderer'],
  preload: ['main', 'renderer'],
  'shared/contracts': ['main', 'preload', 'renderer'],
  renderer: ['main', 'preload'],
  'renderer/shared': [
    'renderer/app',
    'renderer/pages',
    'renderer/features',
    'renderer/domains',
    'renderer/platform',
    'shared/contracts',
  ],
  'renderer/pages': ['renderer/app', 'renderer/platform'],
  'renderer/features': ['renderer/app', 'renderer/pages'],
  'renderer/domains': [
    'renderer/app',
    'renderer/pages',
    'renderer/features',
    'renderer/platform',
  ],
  'renderer/platform': [
    'renderer/app',
    'renderer/pages',
    'renderer/features',
    'renderer/domains',
  ],
};

function within(path, directory) {
  return path === directory || path.startsWith(`${directory}/`);
}

function sourcePath(path) {
  return relative(resolve(appRoot, 'src'), path).split(sep).join('/');
}

/** alias와 상대경로를 정규화한 뒤 동일한 경계로 검사합니다. */
function resolveImport(importer, specifier) {
  if (specifier.startsWith('.')) return resolve(dirname(importer), specifier);
  for (const [alias, target] of Object.entries(aliases)) {
    if (within(specifier, alias))
      return resolve(appRoot, target, specifier.slice(alias.length + 1));
  }
  return null;
}

function crossesBoundary(from, to) {
  for (const [target, blocked] of Object.entries(forbidden)) {
    if (
      within(from, target) &&
      blocked.some((directory) => within(to, directory))
    )
      return true;
  }
  const source = from.split('/');
  const destination = to.split('/');
  return (
    source[0] === 'renderer' &&
    destination[0] === 'renderer' &&
    ['features', 'domains'].includes(source[1]) &&
    source[1] === destination[1] &&
    source[2] !== destination[2]
  );
}

export default {
  meta: { name: 'wiki' },
  rules: {
    'explicit-parameter-types': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          missing: '함수·콜백 매개변수의 타입을 명시해 주세요.',
        },
      },
      /** 기본값·나머지 인자도 선언 위치의 타입 표기를 확인합니다. */
      create(context) {
        /** 문맥상 추론되는 이벤트·배열 콜백에도 같은 표기 규칙을 적용합니다. */
        const check = (node) => {
          for (const parameter of node.params) {
            const binding =
              parameter.type === 'AssignmentPattern'
                ? parameter.left
                : parameter;
            if (!binding.typeAnnotation) {
              context.report({ node: parameter, messageId: 'missing' });
            }
          }
        };
        return {
          FunctionDeclaration: check,
          FunctionExpression: check,
          ArrowFunctionExpression: check,
        };
      },
    },
    'import-boundaries': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          boundary: '허용되지 않은 참조 방향입니다: {{from}} → {{to}}',
        },
      },
      create(context) {
        const importer = context.filename;
        const from = sourcePath(importer);
        if (from.startsWith('../')) return {};

        const check = (node) => {
          if (!node || typeof node.value !== 'string') return;
          const resolved = resolveImport(importer, node.value);
          if (resolved && crossesBoundary(from, sourcePath(resolved))) {
            context.report({
              node,
              messageId: 'boundary',
              data: { from, to: sourcePath(resolved) },
            });
          }
        };
        return {
          ImportDeclaration: (node) => check(node.source),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source),
          TSImportType: (node) => check(node.source),
          TSExternalModuleReference: (node) => check(node.expression),
          CallExpression: (node) => {
            if (
              node.callee.type === 'Identifier' &&
              node.callee.name === 'require'
            )
              check(node.arguments[0]);
          },
        };
      },
    },
  },
};

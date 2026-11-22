import { resolve } from 'node:path';

// 제품 파일은 수정하지 않고 이 시안의 번들에서만 메뉴·위치 경로를 추가합니다.
export function templateNavigationPreview(app) {
  const shell = resolve(app, 'src/renderer/app/AppShell.tsx');
  const navigation = resolve(app, 'src/renderer/app/workspaceNavigation.ts');
  const composer = resolve(
    app,
    'src/renderer/features/chat-with-knowledge/ui/ChatComposer.tsx',
  );
  const menu = resolve(
    app,
    'src/renderer/features/chat-with-knowledge/ui/ComposerMenu.tsx',
  );
  const catalog = resolve(app, 'tests/template-ui-proposal/templateCatalog.ts');
  const theme = resolve(app, 'src/renderer/shared/theme/useThemePreference.ts');
  function replaceOnce(source, anchor, replacement) {
    if (source.split(anchor).length !== 2)
      throw new Error(
        '템플릿 시안의 메뉴 삽입 위치가 달라졌습니다. 제품 소스를 확인하세요.',
      );
    return source.replace(anchor, replacement);
  }
  return {
    name: 'template-navigation-preview',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        source.endsWith('/answerTemplates') &&
        importer?.startsWith(
          resolve(app, 'src/renderer/features/chat-with-knowledge'),
        )
      )
        return catalog;
      return null;
    },
    transform(source, id) {
      const file = id.split('?')[0];
      if (file === theme) {
        return {
          code: replaceOnce(
            source,
            'let current: ThemePreference | null = null;',
            "let current: ThemePreference | null = 'cream';",
          ),
          map: null,
        };
      }
      if (file === composer) {
        return {
          code: replaceOnce(
            source,
            'type="submit"\n              className={styles.send}',
            'type="button"\n              onClick={(): void => { if (canSend && !readInFlight.current) onSend(); }}\n              className={styles.send}',
          ),
          map: null,
        };
      }
      if (file === menu) {
        const candidates =
          "const templates: readonly Choice[] = [\n  { id: '', name: '기본 답변', description: 'AI가 알아서 씁니다' },\n  ...ANSWER_TEMPLATES,\n];";
        let result = replaceOnce(source, candidates, '');
        result = replaceOnce(
          result,
          '}: ComposerMenuProps): JSX.Element {',
          `}: ComposerMenuProps): JSX.Element {\n${candidates}`,
        );
        return { code: result, map: null };
      }
      if (file === shell) {
        let result = replaceOnce(
          source,
          "  {\n    path: '/ontology',",
          "  { path: '/templates', label: '템플릿', icon: 'file-text', routes: ['/templates'] },\n  {\n    path: '/ontology',",
        );
        result = replaceOnce(
          result,
          'const pageTitles: Readonly<Record<string, string>> = {',
          "const pageTitles: Readonly<Record<string, string>> = {\n  '/templates': '템플릿',",
        );
        return { code: result, map: null };
      }
      if (file === navigation) {
        let result = replaceOnce(
          source,
          "    case '/chat':\n    case '/artifact':",
          "    case '/templates':\n    case '/chat':\n    case '/artifact':",
        );
        result = replaceOnce(
          result,
          "    case '/chat':\n      return [{ label: 'AI 채팅' }];",
          "    case '/templates':\n      return titleOf('template-preview') && titleOf('template-preview') !== '템플릿' ? [{ label: '템플릿', to: '/templates?view=list' }, { label: titleOf('template-preview') ?? '템플릿 상세' }] : [{ label: '템플릿' }];\n    case '/chat':\n      return [{ label: 'AI 채팅' }];",
        );
        result = replaceOnce(
          result,
          "  if (pathname === '/artifact' || pathname === '/chat') return '/chat';",
          "  if (pathname === '/templates') return '/templates';\n  if (pathname === '/artifact' || pathname === '/chat') return '/chat';",
        );
        return { code: result, map: null };
      }
      return null;
    },
  };
}

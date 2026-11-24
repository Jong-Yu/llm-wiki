import { resolve } from 'node:path';

// 실제 컴포넌트는 유지하고 이 번들의 탐색·표시만 조건부 변경합니다.
export function workflowPreview(app) {
  const root = resolve(app, 'tests/document-workflow-proposal');
  const shell = resolve(app, 'src/renderer/app/AppShell.tsx');
  const nav = resolve(app, 'src/renderer/app/workspaceNavigation.ts');
  const header = resolve(
    app,
    'src/renderer/features/browse-ai-sessions/ui/AiSessionHeader.tsx',
  );
  const library = resolve(
    app,
    'src/renderer/features/browse-document-library/ui/DocumentLibrary.tsx',
  );
  function once(code, anchor, next) {
    if (code.split(anchor).length !== 2)
      throw new Error(`시안 anchor가 달라졌습니다: ${anchor.slice(0, 90)}`);
    return code.replace(anchor, next);
  }
  return {
    name: 'document-workflow-preview',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        importer?.split('?')[0] === library &&
        (source === '../model/useDocumentLibrary' ||
          source === '../model/useSourceAnalysis')
      )
        return resolve(root, 'libraryFixture.ts');
      return null;
    },
    transform(code, id) {
      const file = id.split('?')[0];
      if (file === shell) {
        code = `import { proposed } from '${root}/previewStore';\n${code}`;
        code = once(
          code,
          "path: '/sessions',",
          "path: proposed ? '/tasks' : '/sessions',",
        );
        code = once(
          code,
          "label: 'AI 세션',",
          "label: proposed ? '작업' : 'AI 세션',",
        );
        code = once(
          code,
          "routes: ['/sessions', '/sessions/history'],",
          "routes: ['/sessions', '/sessions/history', '/tasks'],",
        );
        code = once(
          code,
          "  '/sessions': 'AI 세션',",
          "  '/tasks': '작업',\n  '/sessions': 'AI 세션',",
        );
        code = once(
          code,
          '  const goBack = (): void => {',
          `  const goBack = (): void => {\n    const previewReturn: unknown = location.state?.workflowReturnTo;\n    if (proposed && typeof previewReturn === 'string' && /^\\/(tasks|documents|source)(\\?|$)/.test(previewReturn)) { void navigate(-1); return; }`,
        );
        code = once(
          code,
          '  const canGoUp = breadcrumb.length > 1;',
          "  const canGoUp = breadcrumb.length > 1 || (proposed && typeof location.state?.workflowReturnTo === 'string');",
        );
        return { code, map: null };
      }
      if (file === header) {
        code = `import { proposed } from '${root}/previewStore';\nimport { PreviewActivity } from '${root}/PreviewActivity';\n${code}`;
        code = once(
          code,
          '      <Link\n        to="/sessions"',
          '      {proposed ? <PreviewActivity /> : <Link\n        to="/sessions"',
        );
        code = once(
          code,
          '      </Link>\n      {connectionId',
          '      </Link>}\n      {connectionId',
        );
        return { code, map: null };
      }
      if (file === nav) {
        code = once(
          code,
          "    case '/jobs':\n      return `job:${query.get('jobId') ?? ''}`;",
          "    case '/tasks':\n      return `task:${query.get('task') ?? ''}`;\n    case '/jobs':\n      return `job:${query.get('jobId') ?? ''}`;",
        );
        code = once(
          code,
          "  if (pathname === '/jobs' || pathname === '/sessions/history')",
          "  if (pathname === '/tasks') return '/tasks';\n  if (pathname === '/jobs' || pathname === '/sessions/history')",
        );
        code = once(
          code,
          "    case '/jobs':\n      return [{ label: 'AI 세션', to: '/sessions' }, { label: '분석 작업' }];",
          "    case '/tasks':\n      return query.get('task') ? [{ label: '작업', to: '/tasks' }, { label: titleOf(`task:${query.get('task')}`) ?? '문서 처리' }] : [{ label: '작업' }];\n    case '/jobs':\n      return [{ label: 'AI 세션', to: '/sessions' }, { label: '분석 작업' }];",
        );
        return { code, map: null };
      }
      if (file === library) {
        code = `import { proposed, sourceTaskLabel, sourceTask } from '${root}/previewStore';\n${code}`;
        code = once(
          code,
          'sourceAnalysisLabels[analysis.viewOf(item).kind]',
          '(proposed ? sourceTaskLabel(item.sourceId) : sourceAnalysisLabels[analysis.viewOf(item).kind])',
        );
        code = once(
          code,
          '                                    진행·오류 보기',
          "                                    {proposed ? '작업 보기' : '진행·오류 보기'}",
        );
        code = once(
          code,
          '                                    to={view.progressPath}',
          "                                    to={view.progressPath}\n                                    state={proposed ? { workflowReturnTo: '/documents' } : undefined}",
        );
        code = once(
          code,
          '                          {row.extractionMessage &&',
          "                          {proposed && item.kind === 'source' && sourceTask(item.sourceId)?.previousSuccess && <p className={styles.rowHint}>이전 성공 결과 보존 · 최신 시도 확인 필요</p>}\n                          {row.extractionMessage &&",
        );
        return { code, map: null };
      }
      return null;
    },
  };
}

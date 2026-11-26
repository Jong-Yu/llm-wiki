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
          "path: '/tasks',",
          "path: proposed ? '/tasks' : '/sessions',",
        );
        code = once(
          code,
          "label: '작업',",
          "label: proposed ? '작업' : 'AI 세션',",
        );
        code = once(
          code,
          '  const goBack = (): void => {',
          `  const goBack = (): void => {\n    const previewReturn: unknown = location.state?.workflowReturnTo;\n    if (proposed && typeof previewReturn === 'string' && /^\\/(tasks|documents|source)(\\?|$)/.test(previewReturn)) { void navigate(-1); return; }`,
        );
        return { code, map: null };
      }
      if (file === header) {
        code = `import { proposed } from '${root}/previewStore';\nimport { PreviewActivity } from '${root}/PreviewActivity';\n${code}`;
        code = once(
          code,
          '      {activity ?? (',
          '      {proposed ? <PreviewActivity /> : (',
        );
        return { code, map: null };
      }
      if (file === nav) {
        // 제품의 taskId를 시안의 고정 task 식별자에만 맞춥니다.
        code = once(
          code,
          "return `task:${query.get('taskId') ?? 'list'}`;",
          "return `task:${query.get('task') ?? ''}`;",
        );
        code = once(
          code,
          "return query.get('taskId')",
          "return query.get('task')",
        );
        code = once(
          code,
          "titleOf(`task:${query.get('taskId') ?? ''}`)",
          "titleOf(`task:${query.get('task') ?? ''}`)",
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
          '                                      작업 보기',
          "                                    {proposed ? '작업 보기' : '진행·오류 보기'}",
        );
        code = once(
          code,
          "state={{ workflowReturnTo: '/documents' }}",
          "state={proposed ? { workflowReturnTo: '/documents' } : undefined}",
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

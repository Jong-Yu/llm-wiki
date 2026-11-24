import { resolve } from 'node:path';

/** 제품 파일을 바꾸지 않고 단일 시안 번들에만 알림 탐색과 같은 제목을 추가합니다. */
export function notificationPreview(app) {
  const root = resolve(app, 'tests/notification-approval-proposal');
  const shell = resolve(app, 'src/renderer/app/AppShell.tsx');
  const fixture = resolve(app, 'tests/document-tasks/fixtures.ts');
  function once(code, anchor, next) {
    if (code.split(anchor).length !== 2)
      throw new Error(`시안 anchor가 달라졌습니다: ${anchor.slice(0, 80)}`);
    return code.replace(anchor, next);
  }
  return {
    name: 'notification-approval-preview',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (file === shell) {
        code = `import { PreviewActivity } from '${root}/PreviewActivity';\n${code}`;
        code = once(
          code,
          `  {\n    path: '/notifications',\n    label: '알림',\n    icon: 'bell',\n    routes: ['/notifications'],\n  },`,
          `  ...(new URLSearchParams(location.search).get('mode') === 'before' ? [] : [{ path: '/notifications', label: '알림', icon: 'bell' as const, routes: ['/notifications'] }]),`,
        );
        code = once(
          code,
          'activity={<DocumentTaskActivity />}',
          `activity={new URLSearchParams(window.location.search).get('mode') === 'before' ? <DocumentTaskActivity /> : <PreviewActivity />}`,
        );
      } else if (file === fixture) {
        code = once(
          code,
          "export const longTitle =\n  '문서 처리 실패 후에도 원본과 이전 성공 결과가 보존되는지 확인하는 아주 긴 문서 제목 '\n    .repeat(3)\n    .trim();",
          "export const longTitle = '시스템 아키텍처 가이드';",
        );
        const syntheticText = [
          '기록의 보관과 작업 처리',
          '작업 기록은 서버에 보관하고 같은 계정에서 조회한다. 사용자 PC는 문서를 처리하고 결과를 서버로 전달한다.',
          '자료가 보관되어도 다음 단계의 승인이 필요할 수 있다. 알림을 읽는 행동과 작업을 승인하는 행동을 구별한다.',
          '1. 실행 기기의 역할',
          '① 변환된 문자를 원본과 대조한다.\n② 사용할 문자를 승인한다.\n③ 준비된 한 기기에서 다음 단계를 진행한다.',
          '보관 위치 | 기록\n서버 | 알림 · 확인 내역 · 승인\n사용자 PC | 현재 실행 상태',
        ].join('\n\n');
        code = once(
          code,
          'content: `검증용 ${index + 1}쪽 변환 문자입니다.\\n사용자 원문을 포함하지 않는 합성 자료입니다.`,',
          `content: ${JSON.stringify(syntheticText)},`,
        );
      } else return null;
      return { code, map: null };
    },
  };
}

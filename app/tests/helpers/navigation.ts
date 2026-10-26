import type { Page } from '@playwright/test';

/** 시안의 주요 메뉴에서 실제 화면 내부 링크를 거쳐 세부 기능으로 이동합니다. */
export async function openAppPage(page: Page, name: string): Promise<void> {
  const paths: Record<string, readonly string[]> = {
    '문서 목록': ['위키 문서'],
    'AI 작업 목록': ['AI 작업', 'AI 작업 목록'],
    질문·대화: ['AI 작업'],
    '질문 근거 준비': ['AI 작업', '질문 근거 준비'],
    결과물: ['AI 작업', '결과물'],
    '변경 비교': ['위키 문서', '변경 비교'],
    '조건·개념 대응': ['지식 탐색', '조건·개념 대응'],
    '분석 범위·산출물': ['AI 작업', 'AI 작업 목록', '분석 범위·산출물'],
    '앱 정보': ['작업 공간', '앱 정보'],
  };
  for (const label of paths[name] || [name]) {
    const container = ['AI 작업', '지식 탐색', '위키 문서', '검토함'].includes(
      label,
    )
      ? page.getByRole('navigation', { name: '앱 탐색', exact: true })
      : ['변경 이력', '작업 공간'].includes(label)
        ? page.getByRole('navigation', { name: '작업 공간 메뉴', exact: true })
        : page.locator('#main-content');
    await container.getByRole('link', { name: label, exact: true }).click();
  }
}

import {
  artifactTitleKey,
  documentTitleKey,
  sourceTitleKey,
} from '@renderer/shared/lib/routeTitle';

/** 실제 업무 화면만 보존하며 대상이 다른 문서의 초안을 같은 인스턴스에 섞지 않습니다. */
export function workspacePageKey(pathname: string, search: string): string {
  const query = new URLSearchParams(search);
  switch (pathname) {
    case '/document':
      return `document:${query.get('path') ?? ''}`;
    case '/source':
      return `source:${query.get('sourceId') ?? ''}:${query.get('version') ?? ''}`;
    case '/analysis-proposals':
      return `proposal:${query.get('document') ?? ''}:${query.get('proposalId') ?? ''}`;
    case '/jobs':
      return `job:${query.get('jobId') ?? ''}`;
    case '/documents':
    case '/register':
    case '/ontology':
    case '/review':
    case '/chat':
    case '/artifact':
    case '/settings':
    case '/guide':
    case '/sessions':
    case '/sessions/history':
      return pathname;
    default:
      return 'not-found';
  }
}

/** 직접 주소 진입에서는 대상의 상위 화면을 명시적으로 선택합니다. */
export function workspaceParentLocation(
  pathname: string,
  search: string,
): string {
  const query = new URLSearchParams(search);
  const document = query.get('path') ?? query.get('document');
  if (pathname === '/ontology')
    return document
      ? `/ontology?path=${encodeURIComponent(document)}`
      : '/ontology';
  if (pathname === '/analysis-proposals' && document)
    return `/document?path=${encodeURIComponent(document)}`;
  if (
    pathname === '/document' &&
    document &&
    (query.has('mode') || query.has('tab'))
  )
    return `/document?path=${encodeURIComponent(document)}`;
  if (pathname === '/jobs' || pathname === '/sessions/history')
    return '/sessions';
  if (pathname === '/artifact' || pathname === '/chat') return '/chat';
  return '/documents';
}

/** 화면이 알려 준 제목을 키로 조회합니다. 없으면 undefined입니다. */
export type RouteTitleLookup = (key: string) => string | undefined;

export type WorkspaceCrumb = { label: string; to?: string };

/** 문서 경로에서 폴더와 확장자를 뺀 표시 이름을 만듭니다. */
function documentLabel(path: string | null): string {
  const name = (path ?? '').split('/').filter(Boolean).pop() ?? '';
  return name.replace(/\.md$/i, '') || '문서';
}

/** 모든 화면의 위치 경로를 만듭니다. 맨 위 메뉴 화면은 자기 이름 한 단계이고, 마지막 단계가 현재 화면입니다. */
export function workspaceBreadcrumb(
  pathname: string,
  search: string,
  titleOf: RouteTitleLookup = (): undefined => undefined,
): readonly WorkspaceCrumb[] {
  const query = new URLSearchParams(search);
  const documents: WorkspaceCrumb = { label: '문서', to: '/documents' };
  switch (pathname) {
    case '/register':
      return [documents, { label: '문서 등록' }];
    case '/document':
      return [
        documents,
        {
          label:
            titleOf(documentTitleKey(query.get('path') ?? '')) ??
            documentLabel(query.get('path')),
        },
      ];
    case '/source':
      return [
        documents,
        {
          label:
            titleOf(sourceTitleKey(query.get('sourceId') ?? '')) ??
            '등록 원본 상세',
        },
      ];
    case '/analysis-proposals': {
      const document = query.get('document');
      return [
        documents,
        {
          label:
            titleOf(documentTitleKey(document ?? '')) ??
            documentLabel(document),
          to: document
            ? `/document?path=${encodeURIComponent(document)}`
            : undefined,
        },
        { label: '관계 추출 결과 비교' },
      ];
    }
    case '/jobs':
      return [{ label: 'AI 세션', to: '/sessions' }, { label: '분석 작업' }];
    case '/artifact':
      return [
        { label: 'AI 채팅', to: '/chat' },
        {
          label:
            titleOf(artifactTitleKey(query.get('artifactId') ?? '')) ??
            '산출물',
        },
      ];
    case '/documents':
      return [{ label: '문서' }];
    case '/ontology':
      return [{ label: '온톨로지' }];
    case '/review':
      return [{ label: '검토함' }];
    case '/chat':
      return [{ label: 'AI 채팅' }];
    case '/sessions':
      return [{ label: 'AI 세션' }];
    case '/sessions/history':
      return [{ label: 'AI 세션', to: '/sessions' }, { label: '지난 기록' }];
    case '/settings':
      return [{ label: '설정' }];
    case '/guide':
      return [{ label: '사용자 가이드' }];
    default:
      return [];
  }
}

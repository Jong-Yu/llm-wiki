export const permissionKeys = [
  'read',
  'source_write',
  'write',
  'ontology_write',
  'ontology_review',
  'ontology_policy',
  'conversation_write',
  'result_write',
  'comparison_write',
] as const;
export type Permission = (typeof permissionKeys)[number];
export const permissionLabels: Record<Permission, string> = {
  read: '자료 읽기',
  source_write: '원본 등록',
  write: '위키 편집',
  ontology_write: '관계 추출·수정',
  ontology_review: '원문 주장 검토',
  ontology_policy: '전문가 판단',
  conversation_write: '대화 기록',
  result_write: '결과물 저장',
  comparison_write: '지식 대조',
};
export const permissionGroups = [
  { name: '자료', values: ['read', 'source_write', 'write'] },
  {
    name: '지식 검토',
    values: ['ontology_write', 'ontology_review', 'ontology_policy'],
  },
  {
    name: '개인 작업',
    values: ['conversation_write', 'result_write', 'comparison_write'],
  },
] satisfies { name: string; values: Permission[] }[];
export type Person = { id: string; name: string };
export type Member = { userId: string; permissions: Permission[] };
export type Workspace = {
  id: string;
  name: string;
  members: Member[];
};
export type AdminEvent = {
  id: string;
  workspaceId: string;
  userId: string | null;
  action: 'added' | 'changed' | 'removed' | 'created';
  beforePermissions?: Permission[];
  afterPermissions?: Permission[];
  before: string;
  after: string;
  at: string;
};
export type Data = {
  people: Person[];
  workspaces: Workspace[];
  events: AdminEvent[];
};
export type Entity = {
  id: string;
  name: string;
  secondary: string;
  kind: 'person' | 'workspace';
  chips: string[];
  meta?: string;
};
export type SearchState = { query: string; page: number; focusId?: string };
export const emptySearch: SearchState = { query: '', page: 0 };
/** 운영 인원 한도와 무관한 합성 검색 자료입니다. */
export function makeData(stress: boolean): Data {
  const people: Person[] = [
    { id: 'minseo', name: '김민서' },
    { id: 'jiho', name: '박지호' },
    { id: 'harin', name: '이하린' },
    { id: 'minseo-research', name: '김민서' },
  ];
  const family = ['정', '최', '윤', '강', '한', '오'];
  const given = ['지우', '도윤', '서연', '하준', '지안', '서준'];
  for (let i = 0; i < (stress ? 236 : 8); i++)
    people.push({
      id: `person-${i}`,
      name: `${family[i % family.length]}${given[Math.floor(i / family.length) % given.length]}`,
    });
  const workspaces: Workspace[] = [
    {
      id: 'sdv-platform',
      name: 'SDV 플랫폼',
      members: people.slice(0, stress ? 84 : 7).map((p, i): Member => ({
        userId: p.id,
        permissions:
          i === 0
            ? [...permissionKeys]
            : i % 2 === 0
              ? ['read']
              : ['read', 'source_write', 'write'],
      })),
    },
    {
      id: 'research',
      name: '기술 리서치',
      members: [
        { userId: 'minseo', permissions: ['read', 'write'] },
        { userId: 'harin', permissions: ['read'] },
        { userId: 'minseo-research', permissions: ['read', 'ontology_review'] },
      ],
    },
    {
      id: 'vehicle',
      name: '차량 소프트웨어',
      members: [{ userId: 'jiho', permissions: ['read', 'write'] }],
    },
    {
      id: 'quality',
      name: '품질 검증',
      members: [
        { userId: 'minseo', permissions: ['read'] },
        { userId: 'harin', permissions: ['read'] },
      ],
    },
    {
      id: 'operations',
      name: '운영 지식',
      members: [{ userId: 'jiho', permissions: ['read'] }],
    },
    {
      id: 'archive-research',
      name: '기술 리서치',
      members: [{ userId: 'minseo-research', permissions: ['read'] }],
    },
  ];
  if (stress)
    for (let i = 0; i < 54; i++)
      workspaces.push({
        id: `project-${i}`,
        name: `${['서비스', '제품', '플랫폼'][i % 3]} 연구 ${i + 1}`,
        members: [
          { userId: people[i % people.length].id, permissions: ['read'] },
        ],
      });
  return {
    people,
    workspaces,
    events: [
      {
        id: 'e1',
        workspaceId: 'sdv-platform',
        userId: 'harin',
        action: 'added',
        beforePermissions: [],
        afterPermissions: ['read'],
        before: '소속 없음',
        after: '읽기',
        at: '2026-11-16T00:20:00Z',
      },
      {
        id: 'e2',
        workspaceId: 'sdv-platform',
        userId: 'jiho',
        action: 'changed',
        beforePermissions: ['read'],
        afterPermissions: ['read', 'source_write', 'write'],
        before: '읽기',
        after: '읽기 · 원본 등록 · 위키 편집',
        at: '2026-11-15T05:05:00Z',
      },
      {
        id: 'e3',
        workspaceId: 'research',
        userId: null,
        action: 'changed',
        before: '기술 검토',
        after: '기술 리서치',
        at: '2026-11-15T01:00:00Z',
      },
    ],
  };
}
/** 권한 세부 목록은 편집 화면에서만 펼칩니다. */
export function permissionSummary(permissions: Permission[]): string {
  if (permissions.length === 0) return '권한 없음';
  if (permissions.length === 9) return '모든 업무 권한';
  if (permissions.length === 1) return '읽기';
  if (
    permissions.includes('ontology_review') ||
    permissions.includes('ontology_policy')
  )
    return '검토 포함';
  return '작성·편집';
}
export function personEntity(person: Person, data: Data): Entity {
  const duplicate = data.people.some(
    (p): boolean => p.id !== person.id && p.name === person.name,
  );
  const spaces = data.workspaces.filter((w): boolean =>
    w.members.some((m): boolean => m.userId === person.id),
  );
  return {
    id: person.id,
    name: person.name,
    secondary: duplicate ? person.id : '',
    kind: 'person',
    meta: spaces.length === 0 ? '배정 대기' : '소속 있음',
    chips: spaces
      .slice(0, 2)
      .map((w): string => w.name)
      .concat(spaces.length > 2 ? [`+${spaces.length - 2}`] : []),
  };
}
export function workspaceEntity(workspace: Workspace, data: Data): Entity {
  const duplicate = data.workspaces.some(
    (w): boolean => w.id !== workspace.id && w.name === workspace.name,
  );
  const latest = data.events.find(
    (event): boolean => event.workspaceId === workspace.id,
  );
  return {
    id: workspace.id,
    name: workspace.name,
    secondary: [duplicate ? workspace.id : ''].filter(Boolean).join(' · '),
    kind: 'workspace',
    meta: latest ? timeLabel(latest.at) : '—',
    chips: [`${workspace.members.length}명`],
  };
}
export function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** 요약 배지가 아닌 실제 권한 배열로 추가·회수 차이를 계산합니다. */
export function permissionDiff(
  before: Permission[],
  after: Permission[],
): { added: Permission[]; removed: Permission[] } {
  return {
    added: after.filter((p: Permission): boolean => !before.includes(p)),
    removed: before.filter((p: Permission): boolean => !after.includes(p)),
  };
}

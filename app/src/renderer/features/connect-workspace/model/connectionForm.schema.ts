import { z } from 'zod';
import type { WorkspaceMembership } from '@contracts/connection.contract';

/** main과 같은 주소 범위를 입력 단계에서도 안내합니다. 최종 검사는 main이 담당합니다. */
function isAllowedServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** 화면의 입력 검증과 폼 값 타입을 하나의 스키마에서 정의합니다. */
export const serverConnectionSchema = z.object({
  remember: z.boolean(),
  serverUrl: z
    .string()
    .trim()
    .min(1, '서버 주소를 입력해 주세요.')
    .max(2048, '서버 주소가 너무 깁니다.')
    .refine(
      isAllowedServerUrl,
      'HTTPS 주소를 입력해 주세요. HTTP는 같은 PC의 로컬 서버만 사용할 수 있습니다. 주소에 인증 정보·쿼리·해시를 포함할 수 없습니다.',
    ),
  token: z
    .string()
    .trim()
    .min(1, '개인 토큰을 입력해 주세요.')
    .max(4096, '개인 토큰이 너무 깁니다.')
    .regex(/^[\x21-\x7e]+$/, '개인 토큰의 형식을 확인해 주세요.'),
});

export type ServerConnectionValues = z.infer<typeof serverConnectionSchema>;

/** 작업 공간과 관점의 필수 입력 타입을 정의합니다. */
const workspaceSelectionSchema = z.object({
  tenant: z.string().min(1, '작업 공간을 선택해 주세요.'),
  profile: z.string().min(1, '관점을 선택해 주세요.'),
});

export type WorkspaceSelectionValues = z.infer<typeof workspaceSelectionSchema>;

/** 현재 서버가 허용한 공간·관점으로 폼 검증 범위를 제한합니다. */
export function createWorkspaceSelectionSchema(
  workspaces: readonly WorkspaceMembership[],
): typeof workspaceSelectionSchema {
  return workspaceSelectionSchema
    .refine(
      (values: WorkspaceSelectionValues): boolean =>
        workspaces.some(
          (workspace: WorkspaceMembership): boolean =>
            workspace.id === values.tenant &&
            workspace.permissions.includes('read'),
        ),
      { path: ['tenant'], error: '조회 가능한 작업 공간을 선택해 주세요.' },
    )
    .refine(
      (values: WorkspaceSelectionValues): boolean => {
        const workspace = workspaces.find(
          (candidate: WorkspaceMembership): boolean =>
            candidate.id === values.tenant,
        );
        if (!workspace) return false;
        return workspace.profiles.some(
          (profile: WorkspaceMembership['profiles'][number]): boolean =>
            profile.id === values.profile,
        );
      },
      { path: ['profile'], error: '선택한 작업 공간의 관점을 선택해 주세요.' },
    );
}

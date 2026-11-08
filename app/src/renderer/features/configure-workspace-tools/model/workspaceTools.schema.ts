import { z } from 'zod';
import type {
  ConnectionSnapshot,
  WorkspaceMembership,
} from '@contracts/connection.contract';

/** 주소에 비밀을 넣지 않으며 최종 주소·전송 검사는 main이 수행합니다. */
function isServerAddress(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export const toolsConnectionSchema = z.object({
  serverUrl: z
    .string()
    .trim()
    .min(1, '서버 주소를 입력해 주세요.')
    .max(2048)
    .refine(
      isServerAddress,
      'https://로 시작하는 서버 주소를 확인해 주세요. 이 PC의 서버는 http://localhost:포트 형식도 사용할 수 있습니다.',
    ),
  name: z
    .string()
    .trim()
    .min(1, '이름을 입력해 주세요.')
    .max(160)
    .refine(
      (name: string): boolean =>
        Array.from(name).every(
          (character: string): boolean =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      '이름을 확인해 주세요.',
    ),
});
export type ToolsConnectionValues = z.infer<typeof toolsConnectionSchema>;
export type ConnectedTools = Extract<
  ConnectionSnapshot,
  { status: 'connected' }
>;

const toolsScopeSchema = z.object({
  tenant: z.string().min(1, '작업 공간을 선택해 주세요.'),
});
export type ToolsScopeValues = z.infer<typeof toolsScopeSchema>;

/** 초기 범위는 기존 선택을 우선하며 실제 적용은 사용자 제출 또는 재인증 뒤에만 합니다. */
export function initialToolsScope(
  connection: ConnectedTools,
): ToolsScopeValues {
  if (connection.selection) return { tenant: connection.selection.tenant };
  const first = connection.workspaces.find(
    (workspace: WorkspaceMembership): boolean =>
      workspace.permissions.includes('read'),
  );
  return { tenant: first?.id ?? '' };
}

/** 현재 허용 목록에 없는 범위를 폼에서 거부하되 서버 인가를 대신하지 않습니다. */
export function createToolsScopeSchema(
  workspaces: WorkspaceMembership[],
): typeof toolsScopeSchema {
  return toolsScopeSchema.refine(
    (values: ToolsScopeValues): boolean =>
      workspaces.some(
        (workspace: WorkspaceMembership): boolean =>
          workspace.id === values.tenant &&
          workspace.permissions.includes('read'),
      ),
    { path: ['tenant'], error: '허용된 작업 공간을 선택해 주세요.' },
  );
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ConnectionService } from '@main/backend/ConnectionService';
import { WorkspaceApiService } from '@main/backend/WorkspaceApiService';
import { parseWorkspaceRequest } from '@contracts/workspace.contract';
import type { WorkspaceResult } from '@contracts/workspace.contract';
import type { LibraryScope } from '@renderer/features/browse-document-library/model/documentLibrary.types';
import type { DocumentListItem } from '@contracts/documents.contract';
import { assignTestWorkspace } from '../poc-ui/assignment';

export type Fixture = {
  scope: LibraryScope;
  alternateScope: LibraryScope;
  items: DocumentListItem[];
  execute: (request: unknown) => Promise<WorkspaceResult>;
  list: () => Promise<DocumentListItem[]>;
};

/** 새 임시 서버에만 가입·자료를 만들고 실제 main 서비스의 쓰기 경로를 노출합니다. */
export async function createFixture(
  root: string,
  project: string,
  serverUrl: string,
): Promise<Fixture> {
  const connection = new ConnectionService();
  const signup = await connection.authenticate({
    name: '휴지통 격리 검증',
    serverUrl,
    mode: 'signup',
  });
  assert(signup.ok && signup.data.status === 'connected');
  await assignTestWorkspace(project, join(root, 'fixture'), signup.data.userId);
  const refreshed = await connection.refreshAccess();
  assert(refreshed.ok && refreshed.data.status === 'connected');
  const local = connection.localContext();
  assert(local);
  const scope: LibraryScope = {
    connectionId: local.active.connectionId,
    userId: local.active.userId,
    tenant: local.selection.tenant,
    profileId: local.selection.profile,
    policyRevision: local.active.policyRevision,
    accessRevision: local.active.accessRevision,
    domain: null,
    viewpoint: null,
  };
  const api = new WorkspaceApiService(connection);
  const alternate = new ConnectionService();
  const login = await alternate.authenticate({
    name: '휴지통 격리 검증',
    serverUrl,
    mode: 'login',
  });
  assert(login.ok && login.data.status === 'connected');
  const alternateScope: LibraryScope = {
    ...scope,
    connectionId: login.data.connectionId,
  };
  const alternateApi = new WorkspaceApiService(alternate);
  const saved = await api.execute({
    connectionId: scope.connectionId,
    expectedScope: scope,
    operation: 'saveDocument',
    input: {
      document: 'trash-verification.md',
      content: '# 삭제 복원 검증 문서\n보존할 원문입니다.\n',
      expected_revision: null,
    },
  });
  assert(saved.ok, saved.ok ? '' : JSON.stringify(saved.error));
  const registered = await fetch(
    `${local.active.serverUrl}tenants/${scope.tenant}/sources`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${local.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request_id: randomUUID().replaceAll('-', ''),
        title: '등록 원본 검증 자료',
        format: 'txt',
        content: '보존할 원본입니다.',
      }),
    },
  );
  assert.equal(registered.status, 201);
  const list = async (): Promise<DocumentListItem[]> => {
    const value = await connection.listDocuments({
      connectionId: scope.connectionId,
      limit: 20,
      cursor: null,
    });
    assert(value.ok, value.ok ? '' : JSON.stringify(value.error));
    return value.data.items;
  };
  const items = await list();
  assert.equal(items.length, 2);
  return {
    scope,
    alternateScope,
    items,
    list,
    execute: async (request: unknown): Promise<WorkspaceResult> => {
      const parsed = parseWorkspaceRequest(request);
      return (
        parsed.connectionId === alternateScope.connectionId ? alternateApi : api
      ).execute(parsed);
    },
  };
}

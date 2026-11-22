import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { TemplateService } from '../../src/main/backend/TemplateService';
import { ConnectionService } from '../../src/main/backend/ConnectionService';
import type { AnalysisContext } from '../../src/main/backend/ConnectionService';
import type { TemplateSession } from '../../src/shared/contracts/templates.contract';
import { assignTestWorkspace } from '../poc-ui/assignment';

/** 저장 대화상자만 격리 경로로 대체하고 네트워크·파일 저장은 실제 경로를 실행합니다. */
declare global {
  var __wikiTemplateSaveDialog: () => Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
  var __wikiTemplateOpenDialog: () => Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
}

/** 실제 임시 서버와 제품 main 서비스의 파일·판본·범위 계약을 확인합니다. */
async function run(): Promise<void> {
  const api = process.env.WIKI_TEMPLATE_TEST_API;
  const directory = process.env.WIKI_TEMPLATE_TEST_ROOT;
  const project = process.env.WIKI_TEMPLATE_TEST_PROJECT;
  assert(api && directory && project, 'isolated test environment required');
  const authenticated = new ConnectionService();
  const signup = await authenticated.authenticate({
    mode: 'signup',
    name: '템플릿 서비스 검사',
    serverUrl: api,
  });
  assert(signup.ok && signup.data.status === 'connected');
  assert.equal(signup.data.selection, null);
  assert.deepEqual(signup.data.workspaces, []);
  assert.equal(authenticated.localContext(), null);
  await assignTestWorkspace(
    project,
    join(directory, 'server'),
    signup.data.userId,
  );
  const assigned = await authenticated.refreshAccess();
  assert(assigned.ok && assigned.data.status === 'connected');
  const context = authenticated.localContext();
  assert(context);
  const workspace = context.active.workspaces.find(
    (item): boolean => item.id === context.selection.tenant,
  );
  assert(workspace);
  const request: TemplateSession = {
    connectionId: context.active.connectionId,
    expectedScope: {
      userId: context.active.userId,
      tenant: workspace.id,
      profileId: workspace.defaultProfile,
      policyRevision: context.active.policyRevision,
      ...(context.active.accessRevision
        ? { accessRevision: context.active.accessRevision }
        : {}),
    },
  };
  let current = true;
  const listeners: Array<() => void> = [];
  const connection: Pick<
    ConnectionService,
    | 'analysisContext'
    | 'isAnalysisCurrent'
    | 'onScopeChanged'
    | 'analysisAccessFailure'
  > = {
    analysisContext: async (): Promise<AnalysisContext> => context,
    isAnalysisCurrent: (): boolean => current,
    onScopeChanged: (listener: () => void): (() => void) => {
      listeners.push(listener);
      return (): void => {};
    },
    analysisAccessFailure: (): void => {},
  };
  const service = new TemplateService(connection);
  let destination = join(directory, 'result.txt');
  globalThis.__wikiTemplateSaveDialog = async (): Promise<{
    canceled: boolean;
    filePath: string;
  }> => ({ canceled: false, filePath: destination });
  globalThis.__wikiTemplateOpenDialog = async (): Promise<{
    canceled: boolean;
    filePaths: string[];
  }> => ({ canceled: true, filePaths: [] });
  const empty = await service.list(request);
  assert(empty.ok && empty.data.items.length === 0);
  const original = new TextEncoder().encode('Title: {{title}}');
  const file = await service.selectBytes(request, '회사 양식.txt', original);
  assert(file.ok);
  const created = await service.save({
    ...request,
    requestId: randomUUID().replaceAll('-', ''),
    name: '회사 양식',
    instructions: '근거에 맞게 작성하세요.',
    fileId: file.data.fileId,
  });
  assert(created.ok, JSON.stringify(created));
  const first = created.data.template;
  assert(created.data.generation.supported);
  const listed = await service.list(request);
  assert(
    listed.ok &&
      listed.data.items.length === 1 &&
      listed.data.items[0]?.id === first.id,
  );
  const second = await service.save({
    ...request,
    templateId: first.id,
    expectedRevision: first.revision,
    requestId: randomUUID().replaceAll('-', ''),
    name: first.name,
    instructions: '수정된 지침',
  });
  assert(second.ok, JSON.stringify(second));
  assert.notEqual(second.data.template.revision, first.revision);
  const old = await service.read({
    ...request,
    templateId: first.id,
    revision: first.revision,
  });
  assert(old.ok && old.data.template.instructions === first.instructions);
  const stale = await service.save({
    ...request,
    templateId: first.id,
    expectedRevision: first.revision,
    requestId: randomUUID().replaceAll('-', ''),
    name: first.name,
    instructions: '경쟁 변경',
  });
  assert(!stale.ok && stale.error.code === 'conflict');
  const field = created.data.generation.fields[0];
  assert(field);
  const content =
    '작성했습니다.\n\n```wiki-template-result\n' +
    JSON.stringify({
      version: 1,
      replacements: [{ id: field.id, text: 'Title: 프로젝트 결과' }],
    }) +
    '\n```';
  const prepared = await service.prepareResult({
    ...request,
    templateId: first.id,
    revision: first.revision,
    content,
  });
  assert(prepared.ok, JSON.stringify(prepared));
  assert.equal(prepared.data.filename, '회사 양식-결과.txt');
  const downloaded = await service.downloadResult({
    ...request,
    resultId: prepared.data.resultId,
  });
  assert(downloaded.ok && downloaded.data.started, JSON.stringify(downloaded));
  assert.equal(await readFile(destination, 'utf8'), 'Title: 프로젝트 결과');
  const overwritten = await service.downloadResult({
    ...request,
    resultId: prepared.data.resultId,
  });
  assert(!overwritten.ok && overwritten.error.code === 'file_save_failed');
  assert.equal(await readFile(destination, 'utf8'), 'Title: 프로젝트 결과');
  destination = join(directory, 'original.txt');
  const originalDownload = await service.downloadOriginal({
    ...request,
    templateId: first.id,
    revision: first.revision,
  });
  assert(originalDownload.ok && originalDownload.data.started);
  assert.deepEqual(new Uint8Array(await readFile(destination)), original);
  const archived = await service.archive({
    ...request,
    templateId: first.id,
    expectedRevision: second.data.template.revision,
    requestId: randomUUID().replaceAll('-', ''),
  });
  assert(
    archived.ok && archived.data.template.archived,
    JSON.stringify(archived),
  );
  const hidden = await service.list(request);
  assert(hidden.ok && hidden.data.items.length === 0);
  const archivedResult = await service.prepareResult({
    ...request,
    templateId: first.id,
    revision: first.revision,
    content,
  });
  assert(
    archivedResult.ok,
    'past request must still render from original revision',
  );

  // 성공한 파일 선택을 해제하지 않으면 아홉 번째 등록에서 새 파일을 고를 수 없습니다.
  for (let index = 0; index < 9; index++) {
    const picked = await service.selectBytes(
      request,
      `form-${index}.txt`,
      original,
    );
    assert(picked.ok, `selection ${index}: ${JSON.stringify(picked)}`);
    const saved = await service.save({
      ...request,
      requestId: randomUUID().replaceAll('-', ''),
      name: `양식 ${index}`,
      instructions: '',
      fileId: picked.data.fileId,
    });
    assert(saved.ok, JSON.stringify(saved));
  }
  const mismatch = await service.list({
    ...request,
    expectedScope: { ...request.expectedScope, tenant: 'another' },
  });
  assert(!mismatch.ok && mismatch.error.code === 'scope_changed');
  const permissions = workspace.permissions;
  workspace.permissions = ['read'];
  const denied = await service.selectBytes(request, 'denied.txt', original);
  assert(!denied.ok && denied.error.code === 'forbidden');
  workspace.permissions = permissions;

  const realFetch = globalThis.fetch;
  // 서버가 공개한 뒤 응답만 손상/유실되어도 같은 요청과 선택 파일로 한 번만 등록됩니다.
  const receiptSchema = z.object({
    data: z.looseObject({
      template: z.looseObject({ id: z.string(), revision: z.string() }),
    }),
    meta: z.unknown(),
  });
  for (const failure of ['json', 'detail', 'disconnect']) {
    const before = await service.list(request);
    assert(before.ok);
    const selected = await service.selectBytes(
      request,
      `${failure}.txt`,
      original,
    );
    assert(selected.ok);
    const saveRequest = {
      ...request,
      requestId: randomUUID().replaceAll('-', ''),
      name: `응답 유실 ${failure}`,
      instructions: '같은 요청으로 저장 결과를 확인합니다.',
      fileId: selected.data.fileId,
    };
    const committed: Array<{ id: string; revision: string }> = [];
    try {
      globalThis.fetch = async (
        input: string | URL | Request,
        options?: RequestInit,
      ): Promise<Response> => {
        const response = await realFetch(input, options);
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (options?.method !== 'POST' || !url.endsWith('/templates'))
          return response;
        assert.equal(response.status, 201);
        const receipt = receiptSchema.parse(await response.json());
        committed.push(receipt.data.template);
        if (failure === 'disconnect')
          throw new Error('isolated response loss after commit');
        const body =
          failure === 'json'
            ? '{incomplete'
            : JSON.stringify({
                ...receipt,
                data: {
                  ...receipt.data,
                  template: { ...receipt.data.template, instructions: 42 },
                },
              });
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      };
      const unknown = await service.save(saveRequest);
      assert(
        !unknown.ok && unknown.error.code === 'outcome_unknown',
        JSON.stringify(unknown),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    const [receipt] = committed;
    assert(receipt);
    const retried = await service.save(saveRequest);
    assert(retried.ok, JSON.stringify(retried));
    assert.equal(retried.data.template.id, receipt.id);
    assert.equal(retried.data.template.revision, receipt.revision);
    const after = await service.list(request);
    assert(after.ok);
    assert.equal(after.data.items.length, before.data.items.length + 1);
    assert.equal(
      after.data.items.filter((item): boolean => item.id === receipt.id).length,
      1,
    );
  }
  try {
    globalThis.fetch = async (
      input: string | URL | Request,
      options?: RequestInit,
    ): Promise<Response> => {
      const response = await realFetch(input, options);
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/render')) {
        const headers = new Headers(response.headers);
        headers.set('X-Content-SHA256', '0'.repeat(64));
        return new Response(await response.arrayBuffer(), {
          status: response.status,
          headers,
        });
      }
      return response;
    };
    const tampered = await service.prepareResult({
      ...request,
      templateId: first.id,
      revision: first.revision,
      content,
    });
    assert(
      !tampered.ok && tampered.error.code === 'file_integrity',
      JSON.stringify(tampered),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  destination = join(directory, 'revoked.txt');
  globalThis.__wikiTemplateSaveDialog = async (): Promise<{
    canceled: boolean;
    filePath: string;
  }> => {
    current = false;
    return { canceled: false, filePath: destination };
  };
  const revoked = await service.downloadResult({
    ...request,
    resultId: prepared.data.resultId,
  });
  assert(!revoked.ok && revoked.error.code === 'scope_changed');
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  for (const listener of listeners) listener();
  current = true;
  const expired = await service.downloadResult({
    ...request,
    resultId: prepared.data.resultId,
  });
  assert(!expired.ok && expired.error.code === 'result_expired');
  process.stdout.write(
    'TemplateService: real HTTP registration/version/CAS/archive/render/download, response-loss idempotency, file preservation, scope and integrity checks passed.\n',
  );
}

await run();

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import {
  apiFailure,
  readApiJsonBody,
  readScopedApiJson,
  matchesExpectedScope,
} from '@main/backend/readApi';
import { readWorkspaceJsonBody } from '@main/backend/WorkspaceApiService';
import { writeSourceApi } from '@main/backend/writeSourceApi';
import { observePersonalProcess } from '@main/backend/personalProcess';

const revision = 'a'.repeat(64);
const access = {
  user_id: 'tester',
  tenant: 'fixture',
  profile_id: 'selected profile',
  policy_revision: revision,
  access_revision: null,
};
const schema = z.object({
  data: z.looseObject({
    access: z.object({
      user_id: z.string(),
      tenant: z.string(),
      profile_id: z.string(),
      policy_revision: z.string(),
      access_revision: z.string().nullish(),
    }),
  }),
});
let current = true;
let invalidated = 0;
let releaseLate: (() => void) | undefined;
let lateStarted: (() => void) | undefined;
const received: Array<{
  method: string;
  profile: string | null;
  body: unknown;
}> = [];
const server = createServer((request, response): void => {
  let body = '';
  request.on('data', (chunk: Buffer): void => {
    body += chunk.toString('utf8');
  });
  request.on('end', (): void => {
    const url = new URL(request.url ?? '', 'http://fixture');
    received.push({
      method: request.method ?? '',
      profile: url.searchParams.get('profile'),
      body: body ? JSON.parse(body) : null,
    });
    const send = (): void => {
      response.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/malformed')) {
        response.end('{');
        return;
      }
      if (url.pathname.endsWith('/denied')) {
        response.statusCode = 403;
        response.end(JSON.stringify({ error: { code: 'forbidden' } }));
      } else {
        const scope = { ...access };
        if (url.pathname.endsWith('/wrong-user')) scope.user_id = 'another';
        if (url.pathname.endsWith('/wrong-profile'))
          scope.profile_id = 'another';
        if (url.pathname.endsWith('/wrong-policy'))
          scope.policy_revision = 'b'.repeat(64);
        response.end(
          JSON.stringify({
            data: {
              access: url.pathname.endsWith('/invalid') ? {} : scope,
              marker: 'preserved',
            },
          }),
        );
      }
    };
    if (url.pathname.endsWith('/late')) {
      releaseLate = send;
      lateStarted?.();
    } else send();
  });
});
await new Promise<void>((resolve): void => {
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server address');
const selection = { tenant: 'fixture', profile: access.profile_id };
const context: AnalysisContext = {
  active: {
    status: 'connected',
    connectionId: 'fixture',
    serverUrl: `http://127.0.0.1:${address.port}/api/v1/`,
    userId: 'tester',
    policyRevision: revision,
    workspaces: [],
    selection,
    checkedAt: new Date().toISOString(),
  },
  token: 'isolated-token',
  generation: 1,
  selection,
};
const connection = {
  isAnalysisCurrent: (): boolean => current,
  analysisAccessFailure: (): void => {
    invalidated += 1;
  },
};
const controllers = new Set<AbortController>();
const options = {
  schema,
  changed: (): ReturnType<typeof apiFailure> =>
    apiFailure('scope_changed', 'changed'),
  invalidMessage: 'invalid',
};
try {
  for (const profile of ['get-query', 'query', undefined] as const) {
    for (const body of [undefined, { input: 'keep', profile: 'untrusted' }]) {
      const result = await readScopedApiJson(
        connection,
        controllers,
        context,
        'ok?limit=20',
        { ...options, profile, body },
      );
      assert.deepEqual(result, {
        ok: true,
        value: { access, marker: 'preserved' },
      });
      assert.deepEqual(received.at(-1), {
        method: body ? 'POST' : 'GET',
        profile:
          profile === 'query' || (profile && !body) ? selection.profile : null,
        body: body
          ? { ...body, ...(profile ? { profile: selection.profile } : {}) }
          : null,
      });
      assert.equal(controllers.size, 0);
    }
  }
  for (const path of [
    'wrong-user',
    'wrong-profile',
    'wrong-policy',
    'invalid',
    'denied',
  ]) {
    const result = await readScopedApiJson(
      connection,
      controllers,
      context,
      path,
      { ...options, profile: 'query' },
    );
    assert.equal(result.ok, false, path);
    assert.equal(controllers.size, 0);
  }
  assert.equal(
    invalidated,
    1,
    'only HTTP access failures invalidate this service connection',
  );
  const before = received.length;
  current = false;
  assert.equal(
    (await readScopedApiJson(connection, controllers, context, 'ok', options))
      .ok,
    false,
  );
  assert.equal(received.length, before);
  current = true;
  const started = new Promise<void>((resolve): void => {
    lateStarted = resolve;
  });
  const pending = readScopedApiJson(
    connection,
    controllers,
    context,
    'late',
    options,
  );
  await started;
  current = false;
  releaseLate?.();
  assert.deepEqual(await pending, options.changed());
  assert.equal(controllers.size, 0);
  const unconfirmed = await writeSourceApi(
    `${context.active.serverUrl}malformed`,
    context.token,
    '{}',
    new AbortController(),
  );
  assert.equal(unconfirmed.ok, false);
  if (!unconfirmed.ok) assert.equal(unconfirmed.error.code, 'outcome_unknown');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject): void => {
    server.close((error?: Error): void => (error ? reject(error) : resolve()));
  });
}

const scope = {
  userId: 'tester',
  tenant: 'fixture',
  profileId: selection.profile,
  policyRevision: revision,
};
assert.equal(matchesExpectedScope(scope, context), true);
for (const key of ['userId', 'tenant', 'profileId', 'policyRevision'] as const)
  assert.equal(
    matchesExpectedScope({ ...scope, [key]: 'different' }, context),
    false,
  );
assert.equal(
  matchesExpectedScope(
    { ...scope, policyRevision: 'old', accessRevision: revision },
    {
      ...context,
      active: { ...context.active, accessRevision: revision },
    },
  ),
  true,
);
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const utf8 = Buffer.from('{"text":"한글 😀"}');
const split = new ReadableStream<Uint8Array>({
  start(controller): void {
    controller.enqueue(utf8.subarray(0, 11));
    controller.enqueue(utf8.subarray(11));
    controller.close();
  },
});
assert.deepEqual(
  await readApiJsonBody(new Response(split, { headers: jsonHeaders })),
  { text: '한글 😀' },
);
for (const body of ['{', Buffer.from([0xff])])
  await assert.rejects(
    readApiJsonBody(new Response(body, { headers: jsonHeaders })),
    /invalid_response/u,
  );
await assert.rejects(
  readApiJsonBody(new Response(null, { headers: jsonHeaders })),
  /invalid_response/u,
);
let cancelledBody = false;
await assert.rejects(
  readApiJsonBody(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelledBody = true;
        },
      }),
      { headers: { 'Content-Type': 'text/plain' } },
    ),
  ),
  /invalid_response/u,
);
assert.equal(cancelledBody, true);
const largeBody = JSON.stringify({ text: 'x'.repeat(1024 * 1024) });
await assert.rejects(
  readApiJsonBody(new Response(largeBody, { headers: jsonHeaders })),
  /response_too_large/u,
);
assert.equal(
  typeof (await readWorkspaceJsonBody(
    new Response(largeBody, { headers: jsonHeaders }),
  )),
  'object',
);
const broken = new ReadableStream<Uint8Array>({
  start(controller): void {
    controller.error(new Error('stream_interrupted'));
  },
});
await assert.rejects(
  readApiJsonBody(new Response(broken, { headers: jsonHeaders })),
  /stream_interrupted/u,
);
const cleanupFailure = new ReadableStream<Uint8Array>({
  start(controller): void {
    controller.enqueue(new Uint8Array(20));
  },
  cancel(): void {
    throw new Error('cancel_failed');
  },
});
await assert.rejects(
  readApiJsonBody(new Response(cleanupFailure, { headers: jsonHeaders }), 10),
  /response_too_large/u,
);

const events: unknown[] = [];
const lifecycle: string[] = [];
const child = spawn(process.execPath, [
  '-e',
  `
const valid = Buffer.from(JSON.stringify({text:'한글 😀'})+'\\n');
process.stdout.write(valid.subarray(0,12));
setTimeout(() => {
 process.stdout.write(valid.subarray(12));
 process.stdout.write('invalid\\n'+'x'.repeat(1024*1024+1));
 setTimeout(() => process.stdout.write('remainder\\n{"after":true}\\n{"unfinished":true}'),10);
},10);
process.stderr.write('private stderr');
`,
]);
await observePersonalProcess(child, {
  onEvent: (value: unknown): void => {
    events.push(value);
  },
  onClose: (code: number | null, stderr: string): void => {
    assert.equal(code, 0);
    assert.equal(stderr, 'private stderr');
    lifecycle.push('close');
  },
  cleanup: async (): Promise<void> => {
    lifecycle.push('cleanup');
  },
  onCleanupError: (): void => {
    lifecycle.push('warning');
  },
  onFinished: (): void => {
    lifecycle.push('finished');
  },
});
assert.deepEqual(events, [{ text: '한글 😀' }, { after: true }]);
assert.deepEqual(lifecycle, ['close', 'cleanup', 'finished']);
const failures: string[] = [];
await observePersonalProcess(spawn('/nonexistent-wiki-test-executable'), {
  onError: (): void => {
    failures.push('error');
  },
  onClose: (): void => {
    failures.push('close');
  },
  cleanup: async (): Promise<void> => {
    failures.push('cleanup');
    throw new Error('cleanup fixture');
  },
  onCleanupError: (): void => {
    failures.push('warning');
  },
  onFinished: (): void => {
    failures.push('finished');
  },
});
assert.deepEqual(failures, [
  'error',
  'close',
  'cleanup',
  'warning',
  'finished',
]);
const synchronous: string[] = [];
await observePersonalProcess(spawn(process.execPath, ['-e', '']), {
  onClose: (): void => {
    synchronous.push('close');
  },
  cleanup: (): Promise<void> => {
    synchronous.push('cleanup');
    throw new Error('synchronous cleanup fixture');
  },
  onCleanupError: (): void => {
    synchronous.push('warning');
  },
  onFinished: (): void => {
    synchronous.push('finished');
  },
});
assert.deepEqual(synchronous, ['close', 'cleanup', 'warning', 'finished']);
console.log(
  'PASS execution boundaries: scoped HTTP/profile/stale responses, UTF-8 JSONL limits, spawn failure and cleanup order',
);

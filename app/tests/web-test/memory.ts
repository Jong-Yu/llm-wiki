import assert from 'node:assert/strict';
import type { RecoveryScope } from '../../src/main/backend/ProtectedRecoveryStore';
import type {
  RecoveryEntry,
  RecoveryResult,
} from '../../src/shared/contracts/recovery.contract';
import { WebMemoryRecoveryStore } from '../../src/web-test/servicesMemory';

/** 성공 결과에서만 entry를 반환해 실패를 빈 목록으로 해석하지 않습니다. */
function entries(result: RecoveryResult): RecoveryEntry[] {
  assert(result.ok);
  return result.data.entries;
}

/** 복구 판본이 필요한 단계는 entry가 실제로 존재해야 통과합니다. */
function first(result: RecoveryResult): RecoveryEntry {
  const entry = entries(result)[0];
  assert(entry);
  return entry;
}

/** 실패 코드까지 확인하여 단순 실패와 범위·판본 거부를 구분합니다. */
function fails(result: RecoveryResult, code: string): void {
  assert(!result.ok);
  assert.equal(result.error.code, code);
}

/** 메모리 시험에서도 사용자·관점·CAS·한도·반환 복사본 경계를 유지합니다. */
export async function verifyMemory(): Promise<number> {
  const store = new WebMemoryRecoveryStore();
  const scope: RecoveryScope = {
    serverUrl: 'https://memory.invalid/api/v1/',
    userId: 'user-one',
    tenant: 'workspace-one',
    profileId: 'default',
    policyRevision: 'a'.repeat(64),
    accessRevision: 'access-one',
    domain: null,
    viewpoint: null,
  };
  const otherUser = { ...scope, userId: 'user-two' };
  const otherProfile = { ...scope, profileId: 'engineering' };
  const current = (): boolean => true;
  let checks = 0;
  assert.deepEqual(
    entries(await store.list(scope, 'result-drafts', current)),
    [],
  );
  checks++;
  const initial = first(
    await store.put(
      scope,
      'result-drafts',
      'draft',
      '{"body":"first"}',
      null,
      current,
    ),
  );
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  checks++;
  fails(
    await store.put(
      scope,
      'result-drafts',
      'draft',
      '{"body":"stale"}',
      null,
      current,
    ),
    'recovery_conflict',
  );
  assert.equal(
    first(await store.list(scope, 'result-drafts', current)).payload,
    '{"body":"first"}',
  );
  checks++;
  const updated = first(
    await store.put(
      scope,
      'result-drafts',
      'draft',
      '{"body":"next"}',
      initial.revision,
      current,
    ),
  );
  assert.notEqual(updated.revision, initial.revision);
  checks++;
  const additional = await store.put(
    scope,
    'result-drafts',
    'second',
    '{}',
    null,
    current,
  );
  assert.equal(entries(additional).length, 1);
  assert.equal(first(additional).key, 'second');
  checks++;
  const changedResult = entries(
    await store.list(scope, 'result-drafts', current),
  );
  const mutable = changedResult[0];
  assert(mutable);
  mutable.payload = '{"body":"tampered"}';
  changedResult.length = 0;
  assert.equal(
    first(await store.list(scope, 'result-drafts', current)).payload,
    '{"body":"next"}',
  );
  checks++;
  assert.deepEqual(
    entries(await store.list(otherUser, 'result-drafts', current)),
    [],
  );
  assert.deepEqual(
    entries(await store.list(otherProfile, 'result-drafts', current)),
    [],
  );
  assert.deepEqual(
    entries(
      await store.list(
        { ...scope, accessRevision: 'access-two' },
        'result-drafts',
        current,
      ),
    ),
    [],
  );
  assert.deepEqual(
    entries(await store.list(scope, 'question-runs', current)),
    [],
  );
  checks += 4;
  fails(
    await store.list(scope, 'result-drafts', (): boolean => false),
    'scope_changed',
  );
  checks++;
  let currentCalls = 0;
  fails(
    await store.put(
      scope,
      'result-drafts',
      'not-committed',
      '{}',
      null,
      (): boolean => ++currentCalls < 2,
    ),
    'scope_changed',
  );
  assert.equal(
    entries(await store.list(scope, 'result-drafts', current)).length,
    2,
  );
  checks++;
  fails(
    await store.put(
      scope,
      'result-drafts',
      'draft',
      null,
      initial.revision,
      current,
    ),
    'recovery_conflict',
  );
  checks++;
  assert.deepEqual(
    entries(
      await store.put(
        scope,
        'result-drafts',
        'draft',
        null,
        updated.revision,
        current,
      ),
    ),
    [],
  );
  assert.equal(
    first(await store.list(scope, 'result-drafts', current)).key,
    'second',
  );
  checks++;
  first(
    await store.put(
      otherUser,
      'result-drafts',
      'different-user',
      '{}',
      null,
      current,
    ),
  );
  first(
    await store.put(
      otherProfile,
      'result-drafts',
      'different-profile',
      '{}',
      null,
      current,
    ),
  );
  fails(
    await store.forgetIdentity(scope, (): boolean => false),
    'scope_changed',
  );
  assert.equal(
    entries(await store.list(scope, 'result-drafts', current)).length,
    1,
  );
  checks++;
  assert.deepEqual(entries(await store.forgetIdentity(scope, current)), []);
  assert.equal(
    entries(await store.list(scope, 'result-drafts', current)).length,
    0,
  );
  assert.equal(
    entries(await store.list(otherProfile, 'result-drafts', current)).length,
    0,
  );
  assert.equal(
    entries(await store.list(otherUser, 'result-drafts', current)).length,
    1,
  );
  checks++;
  store.clear();
  assert.equal(
    entries(await store.list(otherUser, 'result-drafts', current)).length,
    0,
  );
  checks++;

  const bounded = new WebMemoryRecoveryStore();
  for (let index = 0; index < 128; index++)
    first(
      await bounded.put(
        scope,
        'result-drafts',
        `item-${index}`,
        '{}',
        null,
        current,
      ),
    );
  fails(
    await bounded.put(scope, 'result-drafts', 'overflow', '{}', null, current),
    'recovery_too_large',
  );
  assert.equal(
    entries(await bounded.list(scope, 'result-drafts', current)).length,
    128,
  );
  checks++;
  bounded.clear();
  fails(
    await bounded.put(
      scope,
      'result-drafts',
      'invalid-json',
      'not JSON',
      null,
      current,
    ),
    'invalid_request',
  );
  fails(
    await bounded.put(
      scope,
      'result-drafts',
      'too-long',
      JSON.stringify('x'.repeat(8 * 1024 * 1024)),
      null,
      current,
    ),
    'invalid_request',
  );
  checks += 2;
  const largerBytes = JSON.stringify('가'.repeat(3 * 1024 * 1024));
  for (let index = 0; index < 3; index++)
    first(
      await bounded.put(
        scope,
        'result-drafts',
        `large-${index}`,
        largerBytes,
        null,
        current,
      ),
    );
  fails(
    await bounded.put(
      scope,
      'result-drafts',
      'over-bytes',
      largerBytes,
      null,
      current,
    ),
    'recovery_too_large',
  );
  assert.equal(
    entries(await bounded.list(scope, 'result-drafts', current)).length,
    3,
  );
  checks++;
  bounded.clear();
  return checks;
}

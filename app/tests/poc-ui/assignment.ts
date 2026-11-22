import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** 실행기가 만든 임시 서버에만 ID로 시험 소속을 부여하며 토큰은 전달하지 않습니다. */
export async function assignTestWorkspace(
  projectRoot: string,
  serverRoot: string,
  userId: string,
): Promise<void> {
  const directory = await realpath(serverRoot);
  assert.match(
    basename(dirname(directory)),
    /^wiki-(ui-poc|web-verify|template-service|chat-e2e)-/,
  );
  assert(['server', 'fixture'].includes(basename(directory)));
  await execute(
    join(projectRoot, '.venv/bin/python'),
    [
      '-c',
      `import sys
from pathlib import Path
from core.modules.access.policy import AccessPolicy
from core.tests.poc_access.fixtures import grant_test_membership_for_user
root = Path(sys.argv[1])
policy = AccessPolicy(root / '.local/tenancy/access.json', root / 'data')
grant_test_membership_for_user(policy, sys.argv[2])`,
      directory,
      userId,
    ],
    { cwd: projectRoot, env: { ...process.env, PYTHONPATH: projectRoot } },
  );
}

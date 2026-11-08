import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { researchPublicWeb } from '@main/backend/webResearch';
import { runPersonalCommand } from '@main/backend/personalProcess';
import type { QuestionRuntime } from '@main/backend/QuestionRunService';
import { isPublicWebUrl } from '@contracts/webEvidence.contract';
import { questionWebSearchSchema } from '@contracts/questionRuns.contract';

const root = process.env.WIKI_RUNTIME_TEST_ROOT!;
const project = join(root, 'web-client');
await mkdir(join(project, 'tools'), { recursive: true });
await writeFile(join(project, 'tools/__init__.py'), '');
// 실제 개인 하위 프로세스 경계를 통과시키되 네트워크·모델 호출 없이 결과/손상/중단을 재현합니다.
await writeFile(
  join(project, 'tools/web_search_cli.py'),
  `
import argparse, hashlib, json, os, time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--query-file'); args, _=p.parse_known_args()
query=Path(args.query_file).read_text(encoding='utf-8')
if query=='waiting': time.sleep(30)
content='공개 문서에서 실제 읽은 한글과 이모지 😀입니다.'
if query=='unicode-limit': content='😀'*12000
source={'url':'https://docs.python.org/3/library/asyncio-task.html','title':'Python 공개 문서','content':content,'content_sha256':hashlib.sha256(content.encode()).hexdigest(),'retrieved_at':'2026-11-05T00:00:00Z'}
if query=='unicode-limit': source['title']='😀'*300
if query=='corrupt': source['content_sha256']='0'*64
if query=='private': source['url']='http://127.0.0.1/private'
web={'query':'different' if query=='mismatch' else query,'status':'complete','sources':[source,source] if query=='duplicate' else [source],'warnings':[]}
raw=json.dumps({'protocol':'web-search-cli-v1','ok':True,'web':web},ensure_ascii=False).encode()
os.write(1, raw[:73]); os.write(1,raw[73:]); os.write(1,b'\\n')
`,
);
const runtime: QuestionRuntime = {
  projectRoot: project,
  python: process.env.WIKI_RUNTIME_PYTHON!,
  privateRoot: join(root, 'web-private'),
  sessionRoot: join(root, 'web-sessions'),
  ai: { provider: 'codex', cli: 'unused', model: 'default' },
};
const result = await researchPublicWeb(
  runtime,
  'public topic',
  new AbortController().signal,
);
assert.equal(result.web.status, 'complete');
assert.match(result.web.sources[0]?.content ?? '', /한글과 이모지 😀/u);
const unicode = await researchPublicWeb(
  runtime,
  'unicode-limit',
  new AbortController().signal,
);
assert.equal(unicode.web.status, 'complete');
assert.equal(Array.from(unicode.web.sources[0]?.content ?? '').length, 12000);
for (const query of ['corrupt', 'private', 'mismatch', 'duplicate']) {
  const rejected = await researchPublicWeb(
    runtime,
    query,
    new AbortController().signal,
  );
  assert.equal(rejected.web.status, 'unavailable', query);
  assert.deepEqual(rejected.web.sources, []);
}
const abort = new AbortController();
const interrupted = researchPublicWeb(runtime, 'waiting', abort.signal);
const timer = setTimeout((): void => abort.abort(), 200);
try {
  await assert.rejects(interrupted, /scope_changed/u);
} finally {
  clearTimeout(timer);
}
assert.deepEqual(await readdir(runtime.privateRoot), []);
await writeFile(
  join(project, 'tools/once.py'),
  `
import os, sys, time
mode=sys.argv[1]
if mode=='unicode':
 raw='한글 😀'.encode(); os.write(1,raw[:2]); os.write(1,raw[2:])
elif mode=='large': os.write(1,b'x'*1024); time.sleep(30)
elif mode=='slow': time.sleep(30)
elif mode=='exit': sys.exit(3)
`,
);
const unicodeOutput = await runPersonalCommand(
  runtime,
  ['-B', '-m', 'tools.once', 'unicode'],
  { maxBytes: 100, timeoutMs: 2000 },
);
assert.equal(unicodeOutput.output, '한글 😀');
assert.equal(unicodeOutput.exitCode, 0);
const largeOutput = await runPersonalCommand(
  runtime,
  ['-B', '-m', 'tools.once', 'large'],
  { maxBytes: 32, timeoutMs: 5000 },
);
assert.equal(largeOutput.tooLarge, true);
assert.equal(largeOutput.output, '');
const expiredOutput = await runPersonalCommand(
  runtime,
  ['-B', '-m', 'tools.once', 'slow'],
  { maxBytes: 100, timeoutMs: 50 },
);
assert.equal(expiredOutput.timedOut, true);
const failedOutput = await runPersonalCommand(
  runtime,
  ['-B', '-m', 'tools.once', 'exit'],
  { maxBytes: 100, timeoutMs: 2000 },
);
assert.equal(failedOutput.exitCode, 3);
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(
  runPersonalCommand(runtime, ['-B', '-m', 'tools.once', 'slow'], {
    maxBytes: 100,
    timeoutMs: 2000,
    signal: cancelled.signal,
  }),
  /aborted/u,
);
for (const url of [
  'file:///etc/passwd',
  'https://user:password@python.org/',
  'http://127.1/',
  'https://2130706433/',
  'https://[::1]/',
  'https://a.local/',
  'https://a.lan/',
  'https://python.org:444/',
  'javascript:alert(1)',
])
  assert.equal(isPublicWebUrl(url), false, url);
assert.equal(isPublicWebUrl('https://docs.python.org/3/'), true);
const searchRequest = {
  connectionId: 'fixture',
  expectedScope: {
    userId: 'tester',
    tenant: 'fixture',
    profileId: 'default',
    policyRevision: 'a'.repeat(64),
  },
  query: 'public',
};
assert.equal(questionWebSearchSchema.safeParse(searchRequest).success, true);
assert.equal(
  questionWebSearchSchema.safeParse({ ...searchRequest, question: 'private' })
    .success,
  false,
);
console.log(
  'PASS web research: real child boundary, Unicode, tampering, public URLs, cancellation and private cleanup',
);

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { SourcePageOcrService } from '@main/backend/SourcePageOcrService';

/** 실제 보호 실행 디렉터리·Python 자식에 격리 CLI를 넣어 한 쪽 결과와 취소를 검증합니다. */
export async function verifyPageOcr(
  context: AnalysisContext,
  root: string,
  python: string,
): Promise<void> {
  const project = join(root, 'page-ocr-runtime');
  const privateRoot = join(root, 'page-ocr-private');
  await mkdir(join(project, 'tools'), { recursive: true });
  await writeFile(
    join(project, 'tools/source_conversion_cli.py'),
    `
import json, pathlib, sys, time
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
assert '--submit' not in sys.argv
assert args['--ocr'] == 'always' and args['--ocr-language'] == 'kor+eng'
assert args['--page'] == '2'
mode = pathlib.Path('mode').read_text()
work = pathlib.Path(args['--work-dir'])
work.joinpath('original').write_text('synthetic preserved original')
assert pathlib.Path(args['--token-file']).read_text()
pathlib.Path('started').write_text('ready')
if mode == 'wait':
    while not pathlib.Path(args['--cancel-file']).exists():
        time.sleep(.01)
    raise SystemExit(130)
source = {key: args['--' + key.replace('_', '-')] for key in
    ('source_id', 'source_version', 'source_sha256', 'registration_revision')}
page = 3 if mode == 'wrong-page' else 2
if mode == 'wrong-source': source['source_sha256'] = '0' * 64
content = '' if mode == 'empty' else '새로 읽은 문자'
conversion = dict(method='ocr', units=[dict(unit_id='page-' + str(page),
    location=dict(kind='pages', start=page, end=page), content=content)],
    complete=False, unread_ranges=['pages 1-1: not_selected_for_page_ocr',
    'page 2: ocr_low_or_missing_confidence_text_retained_manual_review_required'],
    warnings=['original warning retained'], origin='client_reported',
    coverage='reported_units_only', original_coverage='not_verified', semantic_validation='not_run',
    unit_methods={'page-' + str(page): 'ocr'})
value = dict(schema_version=1, type='result', request_id=args['--request-id'], source_ref=source,
    state='partial', format='pdf', conversion=conversion,
    receipt=dict(state='saved' if mode == 'submitted' else 'not_submitted'))
if mode == 'wrong-request': value['request_id'] = '0' * 32
print(json.dumps(value, ensure_ascii=False), flush=True)
if mode == 'duplicate': print(json.dumps(value), flush=True)
if mode == 'invalid': print('private raw failure must never be shown', flush=True)
if mode == 'exit-error': raise SystemExit(1)
`,
  );
  let current = true;
  let scopeChanged: () => void = (): void => {};
  const service = new SourcePageOcrService(
    {
      isAnalysisCurrent: (): boolean => current,
      onScopeChanged: (callback: () => void): void => {
        scopeChanged = callback;
      },
    },
    { projectRoot: project, python, workRoot: privateRoot },
  );
  const source = {
    source_id: 'a'.repeat(32),
    source_version: 'b'.repeat(32),
    source_sha256: 'c'.repeat(64),
    registration_revision: 'd'.repeat(64),
  };
  const requestId = 'e'.repeat(32);
  const mode = async (value: string): Promise<void> => {
    await writeFile(join(project, 'mode'), value);
    await writeFile(join(project, 'started'), 'pending');
  };
  const started = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readFile(join(project, 'started'), 'utf8')) === 'ready')
        return;
      await delay(10);
    }
    throw new Error('Synthetic page OCR did not start');
  };
  await mode('success');
  const success = await service.run(context, source, 2, requestId);
  assert.equal(success.ok, true);
  assert.equal(success.data.content, '새로 읽은 문자');
  assert.equal(success.data.page, 2);
  assert.ok(
    success.data.warnings.some((warning: string): boolean =>
      warning.includes('low_or_missing'),
    ),
  );
  assert.ok(
    !success.data.warnings.some((warning: string): boolean =>
      warning.includes('not_selected'),
    ),
  );

  for (const value of [
    'wrong-page',
    'wrong-source',
    'wrong-request',
    'empty',
    'submitted',
    'duplicate',
    'invalid',
    'exit-error',
  ]) {
    await mode(value);
    const result = await service.run(context, source, 2, requestId);
    assert.equal(result.ok, false, value);
    assert.ok(!JSON.stringify(result).includes('private raw'));
  }

  await mode('wait');
  const abort = new AbortController();
  const cancelled = service.run(context, source, 2, requestId, abort.signal);
  await started();
  const busy = await service.run(context, source, 2, requestId);
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.error.code, 'page_ocr_busy');
  abort.abort();
  const cancellation = await cancelled;
  assert.equal(cancellation.ok, false);
  if (!cancellation.ok)
    assert.equal(cancellation.error.code, 'page_ocr_cancelled');

  await mode('wait');
  const changed = service.run(context, source, 2, requestId);
  await started();
  current = false;
  scopeChanged();
  const stale = await changed;
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, 'scope_changed');
  await service.stop();
  current = true;

  await mode('wait');
  const stopped = service.run(context, source, 2, requestId);
  await started();
  await service.stop();
  assert.equal((await stopped).ok, false);
  for (const name of await readdir(privateRoot)) {
    await assert.rejects(stat(join(privateRoot, name, 'auth')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(privateRoot, name, 'work/original'), 'utf8'),
      'synthetic preserved original',
    );
  }
  await mode('success');
  assert.equal((await service.run(context, source, 0, requestId)).ok, false);
  assert.equal(await readFile(join(project, 'started'), 'utf8'), 'pending');
}

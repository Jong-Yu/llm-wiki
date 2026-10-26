import { test, expect } from '@playwright/test';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { processRecoveryFixture } from '../helpers/processRecoveryFixture';
import { SourceConversionService } from '@main/backend/SourceConversionService';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import type {
  SourceConversionReadRequest,
  SourceConversionRun,
} from '@contracts/sourceConversion.contract';
import {
  conversionCliEventSchema,
  conversionId,
} from '@main/backend/sourceConversionProtocol';
import {
  sourceFileFormat,
  sourceMediaType,
  sourceSignatureMatches,
  sourceText,
} from '@main/backend/sourceOriginal';

const source = {
  sourceId: 'a'.repeat(32),
  sourceVersion: 'b'.repeat(32),
  sourceSha256: 'c'.repeat(64),
  registrationRevision: 'd'.repeat(64),
};
const scope = {
  userId: 'fixture-user',
  tenant: 'alpha',
  profileId: 'all',
  policyRevision: 'e'.repeat(64),
};
const request: SourceConversionReadRequest = {
  ...source,
  connectionId: 'test-connection',
  expectedScope: scope,
};
const report = {
  method: 'docx_text',
  complete: true,
  unread_ranges: [],
  warnings: [],
  origin: 'client_reported',
  coverage: 'reported_units_only',
  original_coverage: 'not_verified',
  semantic_validation: 'not_run',
  units: [
    {
      unit_id: 'block-1',
      location: { kind: 'blocks', start: 1, end: 1 },
      content: '실제 fixture 문자 🌱\r\n',
    },
  ],
};

/** 변환 파일/프로세스 경로가 공개 결과에서 제거되고 판본 검사가 남는지 확인합니다. */
test('변환 계약은 경로·비밀을 제거하고 문자/위치·완전성을 검사한다', (): void => {
  const event = conversionCliEventSchema.parse({
    schema_version: 1,
    type: 'result',
    request_id: 'f'.repeat(32),
    source_ref: {
      source_id: source.sourceId,
      source_version: source.sourceVersion,
      source_sha256: source.sourceSha256,
      registration_revision: source.registrationRevision,
    },
    state: 'complete',
    format: 'docx',
    conversion: report,
    receipt: { state: 'saved' },
    original_file: '/private/original',
    token: 'fixture-secret',
  });
  expect(JSON.stringify(event)).not.toContain('/private/original');
  expect(JSON.stringify(event)).not.toContain('fixture-secret');
  expect(
    conversionCliEventSchema.safeParse({
      ...event,
      conversion: { ...report, unread_ranges: ['missing page'] },
    }).success,
  ).toBe(false);
  expect(sourceFileFormat('사진.JPEG')).toBe('jpeg');
  expect(sourceFileFormat('원본.DOCX')).toBe('docx');
  expect(sourceFileFormat('active.svg')).toBeNull();
  expect(sourceMediaType('tif')).toBe('image/tiff');
  expect(
    sourceSignatureMatches(
      'png',
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ),
  ).toBe(true);
  expect(sourceSignatureMatches('jpeg', Uint8Array.from([255, 216, 255]))).toBe(
    true,
  );
  expect(sourceSignatureMatches('png', Buffer.from('not png'))).toBe(false);
  expect(sourceText(Buffer.from('\ufefffirst\r\n🌱'))).toBe(
    '\ufefffirst\r\n🌱',
  );
});

/** 합성 Python 실행기는 실제 자식 프로세스/취소/JSONL 수명만 검증하며 문자 정확도 시험은 아닙니다. */
test('개인 변환 프로세스 진행·취소·미설치·응답 유실 GET 복구·범위 분리', async (): Promise<void> => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ui5-conversion-service-')),
  );
  let missingReceipt = true;
  let gets = 0;
  const server = createServer(async (req, res): Promise<void> => {
    gets += 1;
    if (req.method !== 'GET')
      throw new Error('A receipt check must never POST');
    if (missingReceipt) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'unavailable' },
          meta: { trace_id: 'a'.repeat(32) },
        }),
      );
      return;
    }
    const saved = z
      .object({
        request_id: z.string(),
        conversion: z.object({
          complete: z.boolean(),
          unread_ranges: z.array(z.string()),
        }),
      })
      .parse(JSON.parse(await readFile(join(root, 'reported.json'), 'utf8')));
    const data = {
      manifest: {
        ...report,
        ...saved.conversion,
        kind: 'conversions',
        id: conversionId(scope.tenant, scope.userId, saved.request_id),
        request_id: saved.request_id,
        user_id: scope.userId,
        tenant: scope.tenant,
        source_ref: {
          source_id: source.sourceId,
          source_version: source.sourceVersion,
          source_sha256: source.sourceSha256,
          registration_revision: source.registrationRevision,
        },
        units: report.units.map(
          (unit): { unit_id: string; location: typeof unit.location } => ({
            unit_id: unit.unit_id,
            location: unit.location,
          }),
        ),
      },
      revision: 'f'.repeat(64),
      components: { 'block-1': report.units[0].content },
      access: {
        user_id: scope.userId,
        tenant: scope.tenant,
        profile_id: scope.profileId,
        policy_revision: scope.policyRevision,
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture port');
  const context: AnalysisContext = {
    active: {
      status: 'connected',
      connectionId: request.connectionId,
      serverUrl: `http://127.0.0.1:${address.port}/api/v1/`,
      userId: scope.userId,
      policyRevision: scope.policyRevision,
      workspaces: [
        {
          id: scope.tenant,
          permissions: ['read', 'source_write'],
          defaultProfile: scope.profileId,
          profiles: [{ id: scope.profileId, domain: null, viewpoint: null }],
        },
      ],
      selection: { tenant: scope.tenant, profile: scope.profileId },
      checkedAt: 'fixture',
    },
    token: randomBytes(32).toString('hex'),
    generation: 1,
    selection: { tenant: scope.tenant, profile: scope.profileId },
  };
  let current = true;
  let stopScope = (): void => {};
  const connection = {
    analysisContext: async (): Promise<AnalysisContext> => context,
    isAnalysisCurrent: (): boolean => current,
    onScopeChanged: (callback: () => void): void => {
      stopScope = callback;
    },
    analysisAccessFailure: (): void => {},
  };
  const recovery = processRecoveryFixture(connection, join(root, 'recovery'));
  const service = new SourceConversionService(
    connection,
    {
      workRoot: join(root, 'work'),
      projectRoot: root,
      python: resolve('../.venv/bin/python'),
    },
    recovery,
  );
  try {
    expect(await service.read(request)).toEqual({ ok: true, data: null });
    const unavailable = await service.start({
      ...request,
      ocr: 'auto',
      ocrLanguage: 'eng',
    });
    expect(unavailable.ok).toBe(false);
    await mkdir(join(root, 'tools'));
    await writeFile(
      join(root, 'tools/source_conversion_cli.py'),
      `import json,sys,pathlib,time\na=dict(zip(sys.argv[1::2],sys.argv[2::2]))\nr=${JSON.stringify(report).replaceAll('true', 'True')}\nref={k:a['--'+k.replace('_','-')] for k in ['source_id','source_version','source_sha256','registration_revision']}\nprint(json.dumps({'schema_version':1,'type':'progress','stage':'convert','completed':0}),flush=True)\nstate='complete'\nreceipt='saved'\nif a['--ocr']=='always':\n while not pathlib.Path(a['--cancel-file']).exists():time.sleep(.02)\n state='cancelled';receipt='not_submitted';r['complete']=False;r['unread_ranges']=['remaining source: conversion_cancelled']\nelse:\n if a['--ocr']=='never':r['complete']=False;r['unread_ranges']=['block 2: fixture unread'];state='partial'\n print(json.dumps({'schema_version':1,'type':'progress','stage':'submit','completed':1}),flush=True)\npathlib.Path(__file__).parent.parent.joinpath('reported.json').write_text(json.dumps({'request_id':a['--request-id'],'conversion':r}))\nprint(json.dumps({'schema_version':1,'type':'result','request_id':a['--request-id'],'source_ref':ref,'state':state,'format':'docx','conversion':r,'receipt':{'state':receipt},'original_file':'/main/only/original'}),flush=True)\n`,
    );
    const started = await service.start({
      ...request,
      ocr: 'auto',
      ocrLanguage: 'eng',
    });
    expect(started.ok && started.data?.state).toBe('running');
    let run: SourceConversionRun | null = null;
    await expect
      .poll(async (): Promise<string | undefined> => {
        const value = await service.read(request);
        if (value.ok) run = value.data;
        return value.ok ? value.data?.state : value.error.code;
      })
      .toBe('report_unconfirmed');
    const duplicate = await service.start({
      ...request,
      ocr: 'auto',
      ocrLanguage: 'eng',
    });
    expect(duplicate.ok).toBe(false);
    missingReceipt = false;
    await expect
      .poll(async (): Promise<string | undefined> => {
        const value = await service.read(request);
        if (value.ok) run = value.data;
        return value.ok ? value.data?.receiptState : value.error.code;
      })
      .toBe('saved');
    const completed = await service.read(request);
    expect(completed.ok && completed.data?.report?.units[0]?.content).toBe(
      report.units[0].content,
    );
    expect(JSON.stringify(completed)).not.toContain(context.token);
    expect(JSON.stringify(completed)).not.toContain(root);
    expect(gets).toBeGreaterThan(0);
    const reopened = new SourceConversionService(
      connection,
      { workRoot: join(root, 'restart-must-not-run'), projectRoot: '/missing' },
      recovery,
    );
    const restored = await reopened.read(request);
    expect(restored.ok && restored.data?.receiptState).toBe('saved');
    expect(restored.ok && restored.data?.requestId).toBe(
      completed.ok && completed.data?.requestId,
    );
    expect(restored.ok && restored.data?.report?.units[0]?.content).toBe(
      report.units[0].content,
    );
    expect(
      JSON.stringify(
        await recovery.readContext(context, 'pending-source-conversion'),
      ),
    ).not.toContain(context.token);
    const partial = await service.start({
      ...request,
      ocr: 'never',
      ocrLanguage: 'eng',
    });
    expect(partial.ok).toBe(true);
    await expect
      .poll(async (): Promise<string | undefined> => {
        const value = await service.read(request);
        return value.ok ? value.data?.state : value.error.code;
      })
      .toBe('partial');
    const cancelRun = await service.start({
      ...request,
      ocr: 'always',
      ocrLanguage: 'eng',
    });
    if (!cancelRun.ok || !cancelRun.data)
      throw new Error('Expected cancellable run');
    await service.cancel({ ...request, requestId: cancelRun.data.requestId });
    await expect
      .poll(async (): Promise<string | undefined> => {
        const value = await service.read(request);
        return value.ok ? value.data?.state : value.error.code;
      })
      .toBe('cancelled');
    const changed = await service.read({
      ...request,
      expectedScope: { ...scope, tenant: 'beta' },
    });
    expect(changed.ok).toBe(false);
    current = false;
    stopScope();
    await service.stop();
    for (const directory of await readdir(join(root, 'work')))
      expect(
        (await readdir(join(root, 'work', directory))).some(
          (name: string): boolean => name === 'auth',
        ),
      ).toBe(false);
    expect(run).not.toBeNull();
  } finally {
    await service.stop();
    await new Promise<void>((done): void => {
      server.close((): void => done());
    });
    await rm(root, { recursive: true });
  }
});

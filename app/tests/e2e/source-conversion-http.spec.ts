import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { SourceRegistrationService } from '@main/backend/SourceRegistrationService';
import type { RegistrationSession } from '@main/backend/SourceRegistrationService';
import { SourceConversionService } from '@main/backend/SourceConversionService';
import type { AnalysisContext } from '@main/backend/ConnectionService';
import { parseAccessContext } from '@contracts/connection.contract';
import type { SourceRegistrationRecord } from '@contracts/sources.contract';
type SourceItem = NonNullable<SourceRegistrationRecord['item']>;
import type { SourceConversionRun } from '@contracts/sourceConversion.contract';

/** 새 형식도 실제 파일 snapshot/hash·등록 영수증·Python 변환과 HTTP 보고를 통과시킵니다. */
test('실제 API 등록 회귀·DOCX 변환/표 위치·이미지 OCR 미설치·기준 충돌 보존', async (): Promise<void> => {
  test.setTimeout(60_000);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'ui5-source-http-')),
  );
  const tokens = {
    alice: randomBytes(32).toString('hex'),
    bob: randomBytes(32).toString('hex'),
    none: randomBytes(32).toString('hex'),
    documents: true,
    registration: true,
  };
  const server = spawn(
    resolve('../.venv/bin/python'),
    ['-B', resolve('tests/fixtures/connection_server.py')],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lines = createInterface({ input: server.stdout });
  let conversion: SourceConversionService | null = null;
  try {
    const ready = once(lines, 'line');
    server.stdin.end(JSON.stringify(tokens) + '\n');
    const output: unknown[] = await ready;
    const details = z
      .object({ port: z.number() })
      .parse(JSON.parse(z.string().parse(output[0])));
    const base = `http://127.0.0.1:${details.port}`;
    await expect
      .poll(async (): Promise<number> => {
        try {
          return (await fetch(`${base}/fixture-stats`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    const context = parseAccessContext(
      await (
        await fetch(`${base}/api/v1/access-context`, {
          headers: { Authorization: `Bearer ${tokens.alice}` },
        })
      ).json(),
    );
    const session: RegistrationSession = {
      connectionId: 'ui5-http',
      serverUrl: `${base}/api/v1/`,
      userId: context.userId,
      policyRevision: context.policyRevision,
      workspaces: context.workspaces,
      selection: { tenant: 'alpha', profile: 'all' },
      token: tokens.alice,
      generation: 1,
    };
    let chosenPath = '';
    const registration = new SourceRegistrationService(
      (): RegistrationSession => session,
      (): void => {},
      async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: false,
        filePaths: [chosenPath],
      }),
    );
    const expectedScope = {
      userId: session.userId,
      tenant: 'alpha',
      profileId: 'all',
      policyRevision: session.policyRevision,
    };
    /** 파일 선택 뒤 원본 바이트가 변해도 main의 선택 snapshot을 등록합니다. */
    async function registerFile(
      name: string,
      lost: boolean = false,
    ): Promise<SourceItem> {
      chosenPath = join(root, name);
      const chosen = await registration.chooseFile({
        connectionId: session.connectionId,
      });
      if (!chosen.ok || !chosen.data) throw new Error('Expected chosen file');
      const selectedBytes = await readFile(chosenPath);
      if (name.endsWith('.md'))
        await writeFile(chosenPath, 'changed after native selection');
      await fetch(
        `${base}/fixture-registration-mode/${lost ? 'lost' : 'normal'}`,
        { method: 'POST' },
      );
      const requestId = randomUUID().replaceAll('-', '');
      const request = {
        kind: 'file',
        connectionId: session.connectionId,
        expectedScope,
        requestId,
        title: name,
        fileId: chosen.data.fileId,
      };
      let result = await registration.register({ ...request, kind: 'file' });
      if (lost) {
        expect(result.ok).toBe(false);
        result = await registration.receipt({
          connectionId: session.connectionId,
          requestId,
        });
      }
      if (!result.ok || result.data.state !== 'complete')
        throw new Error(JSON.stringify(result));
      expect(result.data.item.sourceSha256).toBe(
        createHash('sha256').update(selectedBytes).digest('hex'),
      );
      const before = z
        .object({ registrations: z.number() })
        .parse(
          await (await fetch(`${base}/fixture-stats`)).json(),
        ).registrations;
      expect(
        (await registration.register({ ...request, kind: 'file' })).ok,
      ).toBe(true);
      expect(
        z
          .object({ registrations: z.number() })
          .parse(await (await fetch(`${base}/fixture-stats`)).json())
          .registrations,
      ).toBe(before);
      return result.data.item;
    }
    await writeFile(join(root, '기존.md'), '\ufeff# UTF-8 원본\r\n변환 🌱\r\n');
    await registerFile('기존.md', true);
    await writeFile(join(root, '기존.txt'), 'plain UTF-8 source\r\n');
    await registerFile('기존.txt');
    const generator = spawn(
      resolve('../.venv/bin/python'),
      [
        '-B',
        '-c',
        'from docx import Document\nfrom PIL import Image\nfrom openpyxl import Workbook\nfrom pypdf import PdfWriter\nfrom pathlib import Path\nimport sys\np=Path(sys.argv[1]);d=Document();d.add_paragraph("DOCX actual paragraph");t=d.add_table(rows=1,cols=2);t.cell(0,0).text="Cell A";t.cell(0,1).text="Cell B";d.save(p/"fixture.docx");Image.new("RGB",(40,40),"white").save(p/"fixture.png");w=Workbook();w.active["A1"]="Actual cell";w.save(p/"fixture.xlsx");pdf=PdfWriter();pdf.add_blank_page(width=72,height=72);pdf.write(p/"fixture.pdf")',
        root,
      ],
      { stdio: 'ignore' },
    );
    expect((await once(generator, 'exit'))[0]).toBe(0);
    const docx = await registerFile('fixture.docx');
    const image = await registerFile('fixture.png');
    const xlsx = await registerFile('fixture.xlsx');
    await registerFile('fixture.pdf');
    const analysisContext: AnalysisContext = {
      active: {
        status: 'connected',
        connectionId: session.connectionId,
        serverUrl: session.serverUrl,
        userId: session.userId,
        policyRevision: session.policyRevision,
        workspaces: session.workspaces,
        selection: session.selection,
        checkedAt: 'fixture',
      },
      token: session.token,
      selection: session.selection,
      generation: 1,
    };
    conversion = new SourceConversionService(
      {
        analysisContext: async (): Promise<AnalysisContext> => analysisContext,
        isAnalysisCurrent: (): boolean => true,
        onScopeChanged: (): void => {},
        analysisAccessFailure: (): void => {},
      },
      {
        workRoot: join(root, 'conversions'),
        projectRoot: resolve('..'),
        python: resolve('../.venv/bin/python'),
      },
    );
    /** 실제 subprocess가 고정 원본을 내려받고 끝난 보고를 반환할 때까지 조회합니다. */
    async function convert(
      item: SourceItem,
      sourceSha256: string = item.sourceSha256,
    ): Promise<SourceConversionRun> {
      if (!conversion) throw new Error('Missing service');
      const request = {
        connectionId: session.connectionId,
        expectedScope,
        sourceId: item.sourceId,
        sourceVersion: item.sourceVersion,
        sourceSha256,
        registrationRevision: item.registrationRevision,
      };
      const started = await conversion.start({
        ...request,
        ocr: 'auto',
        ocrLanguage: 'eng',
      });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      await expect
        .poll(
          async (): Promise<boolean> => {
            if (!conversion) return false;
            const result = await conversion.read(request);
            return (
              result.ok &&
              result.data !== null &&
              !['running', 'cancelling'].includes(result.data.state) &&
              result.data.receiptState !== 'pending'
            );
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const result = await conversion.read(request);
      if (!result.ok || !result.data) throw new Error('Missing result');
      return result.data;
    }
    const converted = await convert(docx);
    expect(converted.state, JSON.stringify(converted)).toBe('complete');
    expect(converted.receiptState).toBe('saved');
    expect(
      converted.report?.units.some(
        (unit): boolean =>
          unit.location.kind === 'paragraphs' &&
          unit.content.includes('DOCX actual paragraph'),
      ),
    ).toBe(true);
    expect(
      converted.report?.units.some(
        (unit): boolean =>
          unit.location.kind === 'table_cells' && unit.content === 'Cell B',
      ),
    ).toBe(true);
    const original = new Uint8Array(
      await (
        await fetch(
          `${base}/api/v1/tenants/alpha/sources/${docx.sourceId}/versions/${docx.sourceVersion}/file`,
          { headers: { Authorization: `Bearer ${tokens.alice}` } },
        )
      ).arrayBuffer(),
    );
    expect(createHash('sha256').update(original).digest('hex')).toBe(
      docx.sourceSha256,
    );
    const cells = await convert(xlsx);
    expect(cells.receiptState).toBe('saved');
    expect(
      cells.report?.units.some(
        (unit): boolean =>
          unit.location.kind === 'cells' &&
          unit.location.cells === 'A1' &&
          unit.content === 'Actual cell',
      ),
    ).toBe(true);
    const noOcr = await convert(image);
    // OCR 미설치는 미독으로 표시하고 설치된 환경에서는 실제 결과를 확인합니다.
    expect(noOcr.report?.semantic_validation).toBe('not_run');
    expect(noOcr.diagnosticCodes).not.toContain('invalid_converter_output');
    if (noOcr.state === 'failed')
      expect(noOcr.report?.unread_ranges.length).toBeGreaterThan(0);
    const stale = await convert(docx, '0'.repeat(64));
    expect(stale.state).toBe('failed');
    expect(stale.report).toBeNull();
    expect(stale.diagnosticCodes).toContain('source_basis_changed');
    expect(JSON.stringify(stale)).not.toContain(tokens.alice);
  } finally {
    await conversion?.stop();
    lines.close();
    server.kill('SIGTERM');
    await once(server, 'exit');
    await rm(root, { recursive: true });
  }
});

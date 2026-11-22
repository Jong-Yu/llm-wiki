import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { OpenDialogReturnValue, SaveDialogReturnValue } from 'electron';
import PptxGenJS from 'pptxgenjs';
import { test, expect } from './fixtures';
import { answered, ask, composer, conversation } from './chat';

/** 파일 선택 대화상자만 격리 파일로 대체하며 읽기·업로드·저장은 실제 서비스를 사용합니다. */
async function selectFile(
  application: ElectronApplication,
  filePath: string,
): Promise<void> {
  await application.evaluate(({ dialog }, path: string): void => {
    dialog.showOpenDialog = async (): Promise<OpenDialogReturnValue> => ({
      canceled: false,
      filePaths: [path],
    });
  }, filePath);
}

/** 실제 저장 서비스가 새 임시 경로에 파일을 쓰도록 선택 결과만 고정합니다. */
async function saveTo(
  application: ElectronApplication,
  filePath: string,
): Promise<void> {
  await application.evaluate(({ dialog }, path: string): void => {
    dialog.showSaveDialog = async (): Promise<SaveDialogReturnValue> => ({
      canceled: false,
      filePath: path,
    });
  }, filePath);
}

/** 메뉴 선택은 같은 이름의 위치 경로와 구별합니다. */
async function templatesMenu(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '기본 메뉴' })
    .getByRole('link', { name: '템플릿', exact: true })
    .click();
}

/** 승인된 등록 폼을 통해 실제 파일·이름·지침을 저장합니다. */
async function register(
  page: Page,
  application: ElectronApplication,
  filePath: string,
  name: string,
  instructions: string,
): Promise<void> {
  await templatesMenu(page);
  await page
    .getByRole('button', { name: '템플릿 등록', exact: true })
    .first()
    .click();
  await selectFile(application, filePath);
  await page.getByRole('button', { name: '파일 선택', exact: true }).click();
  await page
    .getByRole('textbox', { name: '템플릿 이름', exact: true })
    .fill(name);
  await page
    .getByRole('textbox', { name: '지침', exact: true })
    .fill(instructions);
  await page.getByRole('button', { name: '템플릿 등록', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '편집', exact: true }),
  ).toBeVisible();
}

/** 텍스트·서식·도형이 있는 PowerPoint를 만들어 변환이 아닌 원본 부분 수정을 검사합니다. */
async function presentation(path: string): Promise<void> {
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'template-e2e';
  const slide = deck.addSlide();
  slide.background = { color: 'F5F0E6' };
  slide.addText('{{화면 이름}}', {
    x: 0.6,
    y: 0.5,
    w: 10,
    h: 1.2,
    fontSize: 20,
    bold: true,
    color: 'B9431C',
  });
  slide.addText('회사 양식 고정 문구', {
    x: 0.6,
    y: 2.2,
    w: 10,
    h: 0.8,
    fontSize: 14,
    color: '222222',
  });
  slide.addShape(deck.ShapeType.rect, {
    x: 11,
    y: 0.5,
    w: 1,
    h: 1,
    fill: { color: 'F4B183' },
  });
  await deck.writeFile({ fileName: path });
}

/** ZIP의 대상 텍스트 외 파일은 원본 바이트가 유지되는지 실제 결과와 대조합니다. */
function inspectPresentation(
  original: string,
  result: string,
): { text: string; changed: string[] } {
  const output = execFileSync(
    '../.venv/bin/python',
    [
      '-c',
      'import sys,json,zipfile,xml.etree.ElementTree as E\na=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2]);assert set(a.namelist())==set(b.namelist());changed=[p for p in a.namelist() if a.read(p)!=b.read(p)];root=E.fromstring(b.read("ppt/slides/slide1.xml"));print(json.dumps({"changed":changed,"text":"\\n".join(n.text or "" for n in root.iter() if n.tag.endswith("}t"))},ensure_ascii=False))',
      original,
      result,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(output) as { text: string; changed: string[] };
}

/** 화면에서 선택한 판본이 실제 사용자 질문과 서버 실행 기록까지 전달됐는지 검사합니다. */
function inspectStoredTemplateReference(root: string): unknown {
  const output = execFileSync(
    '../.venv/bin/python',
    [
      '-c',
      [
        'import json,sys',
        'from pathlib import Path',
        'root=Path(sys.argv[1])',
        'questions=[e for p in root.glob("**/_personal/*/conversations/*.json") for e in json.loads(p.read_text())["events"] if e.get("role")=="user" and "#템플릿" in e.get("content","")]',
        'runs=[json.loads(p.read_text())["data"] for p in root.glob("**/_personal/*/question-runs/*.json")]',
        'refs=[q.get("template_ref") for q in questions]',
        'valid=bool(refs) and all(isinstance(r,dict) and set(r)=={"id","revision"} and len(r["id"])==32 and len(r["revision"])==64 for r in refs)',
        'print(json.dumps({"question_reference_valid":valid,"run_reference_matches":valid and any(r.get("template_ref")==refs[0] for r in runs)}))',
      ].join('\n'),
      root,
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(output);
}

/** 실제 Electron의 최소 크기 제약을 시험에서만 낮춰 승인된 좁은 폭을 확인합니다. */
async function screenSize(
  application: ElectronApplication,
  width: number,
): Promise<void> {
  await application.evaluate(({ BrowserWindow }, value: number): void => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setMinimumSize(320, 400);
    window?.setContentSize(value, 900);
  }, width);
}

/** 실패 시 비밀 없이 실제 실행 오류 코드만 남깁니다. */
async function templateAnswer(page: Page): Promise<Locator> {
  try {
    return await answered(page);
  } catch (error: unknown) {
    const diagnostic = await page.evaluate(async (): Promise<unknown> => {
      const bridge = window.wiki;
      if (!bridge) return { code: 'bridge_missing' };
      const state = await bridge.connection.getState();
      if (
        !state.ok ||
        state.data.status !== 'connected' ||
        !state.data.selection
      )
        return { code: 'connection_missing' };
      const current = state.data;
      const selection = current.selection;
      if (!selection) return null;
      const session = {
        connectionId: current.connectionId,
        expectedScope: {
          userId: current.userId,
          tenant: selection.tenant,
          profileId: selection.profile,
          policyRevision: current.policyRevision,
          ...(current.accessRevision
            ? { accessRevision: current.accessRevision }
            : {}),
        },
      };
      const page = await bridge.questionRuns.list({ ...session, cursor: null });
      if (!page.ok) return { error: page.error };
      const id = page.data.items[0]?.id;
      if (!id) return { code: 'run_missing' };
      const run = await bridge.questionRuns.read({
        ...session,
        questionRunId: id,
      });
      return run.ok
        ? {
            status: run.data.status,
            progress: run.data.progress,
            localStatus: run.data.local.status,
            localPhase: run.data.local.phase,
            errorCode: run.data.local.errorCode,
            receipts: run.data.receipts,
          }
        : { error: run.error };
    });
    console.log('template-run-diagnostic', JSON.stringify(diagnostic));
    throw error;
  }
}

test.describe('등록 템플릿과 실제 산출물', (): void => {
  test('등록·재조회·편집·채팅 생성·고정판 파일 내려받기', async ({
    launch,
    openChat,
    seedWiki,
    app,
    workRoot,
    shot,
    aiCalls,
  }): Promise<void> => {
    const page = await launch();
    await openChat(page);
    await seedWiki();
    const source = join(workRoot, '회사_화면설계서.pptx');
    const output = join(workRoot, '화면설계서-결과.pptx');
    await presentation(source);
    await register(
      page,
      app(),
      source,
      '회사 화면설계서',
      '권한과 예외 상태를 포함하세요.',
    );
    await page.reload();
    await expect(
      page.getByRole('button', { name: '편집', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: '템플릿 이름' }),
    ).toHaveValue('회사 화면설계서');
    await expect(
      page.getByRole('button', { name: '파일 다시 선택' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '템플릿 정보', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('textbox', { name: '지침', exact: true })
      .fill('검토자는 잠긴 문서를 수정할 수 없습니다.');
    for (const width of [1440, 736, 320]) {
      await screenSize(app(), width);
      await expect(
        page.getByRole('textbox', { name: '지침', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          (): boolean =>
            document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      await shot(page, `템플릿-편집-${width}`);
    }
    await screenSize(app(), 1440);
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('article', { name: '지침' })).toContainText(
      '검토자는 잠긴 문서를 수정할 수 없습니다.',
    );
    await templatesMenu(page);
    const list = page.getByRole('list', { name: '템플릿 목록' });
    await expect(
      list.getByText('회사_화면설계서.pptx', { exact: true }),
    ).toHaveCount(1);
    await expect(list).not.toContainText(/지침\s*\d+개|작성 룰/);
    await shot(page, '템플릿-목록');
    await page
      .getByRole('button', { name: '회사 화면설계서', exact: true })
      .click();
    await page.getByRole('button', { name: 'AI 채팅에서 사용' }).click();
    await expect(composer(page)).toBeEnabled();
    await ask(page, '센서 경고 화면을 이 양식으로 작성해 주세요. #템플릿');
    const answer = await templateAnswer(page);
    expect(inspectStoredTemplateReference(join(workRoot, 'server'))).toEqual({
      question_reference_valid: true,
      run_reference_matches: true,
    });
    await expect(
      answer.getByRole('button', {
        name: '회사_화면설계서-결과.pptx',
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    await saveTo(app(), output);
    await answer.getByRole('button', { name: '내려받기', exact: true }).click();
    await expect
      .poll(
        async (): Promise<number> =>
          (await readFile(output).catch((): Buffer => Buffer.alloc(0))).length,
      )
      .toBeGreaterThan(0);
    const rendered = inspectPresentation(source, output);
    expect(rendered.text).toContain(
      '템플릿 검증 산출물: 검토자는 잠긴 문서를 수정할 수 없습니다.',
    );
    expect(rendered.text).toContain('회사 양식 고정 문구');
    expect(rendered.changed).toEqual(['ppt/slides/slide1.xml']);
    await shot(page, '템플릿-산출물');
    expect(
      (await aiCalls()).some((call): boolean => call.scenario === '템플릿'),
    ).toBe(true);

    await templatesMenu(page);
    await page
      .getByRole('button', { name: '회사 화면설계서', exact: true })
      .click();
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await page
      .getByRole('textbox', { name: '지침', exact: true })
      .fill('최신 지침으로 변경했습니다.');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('article', { name: '지침' })).toContainText(
      '최신 지침으로 변경했습니다.',
    );
    await page
      .getByRole('navigation', { name: '기본 메뉴' })
      .getByRole('link', { name: 'AI 채팅', exact: true })
      .click();
    await conversation(page)
      .getByText('이 요청에 적용한 템플릿·지침', { exact: true })
      .click();
    const snapshot = conversation(page)
      .locator('details')
      .filter({ hasText: '이 요청에 적용한 템플릿·지침' });
    await expect(snapshot).toContainText(
      '검토자는 잠긴 문서를 수정할 수 없습니다.',
    );
    await expect(snapshot).not.toContainText('최신 지침으로 변경했습니다.');
    await page.reload();
    await expect(
      conversation(page).getByRole('button', {
        name: '회사_화면설계서-결과.pptx',
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    const restoredOutput = join(workRoot, '다시-연-산출물.pptx');
    await saveTo(app(), restoredOutput);
    await conversation(page)
      .getByRole('button', { name: '내려받기', exact: true })
      .click();
    await expect
      .poll(
        async (): Promise<number> =>
          (await readFile(restoredOutput).catch((): Buffer => Buffer.alloc(0)))
            .length,
      )
      .toBeGreaterThan(0);
    expect(await readFile(restoredOutput)).toEqual(await readFile(output));
  });

  test('모호한 요청은 질문, 잘못된 작성 영역은 생성 실패로 표시', async ({
    launch,
    openChat,
    app,
    workRoot,
  }): Promise<void> => {
    const page = await launch();
    await openChat(page);
    const source = join(workRoot, '권한설계.txt');
    await writeFile(source, '잠금 문서의 편집 권한: {{권한}}');
    await register(
      page,
      app(),
      source,
      '권한 설계',
      '잠금 정책 충돌은 먼저 질문하세요.',
    );
    await page.getByRole('button', { name: 'AI 채팅에서 사용' }).click();
    await ask(page, '잠금 정책을 확인해 주세요. #템플릿질문');
    let answer = await templateAnswer(page);
    await expect(answer).toContainText('검토자 예외를 이번 설계에 적용할까요?');
    await expect(
      answer.getByRole('button', { name: '내려받기', exact: true }),
    ).toHaveCount(0);
    await ask(page, '검토자 예외를 적용하지 마세요. #템플릿오류');
    answer = await templateAnswer(page);
    await expect(
      answer.getByRole('button', { name: '파일 다시 만들기' }),
    ).toBeVisible({ timeout: 30000 });
    await expect(
      answer.getByRole('button', { name: '내려받기', exact: true }),
    ).toHaveCount(0);
    await expect(
      answer.getByText('이 요청에 적용한 템플릿·지침', { exact: true }),
    ).toBeVisible();
  });

  test('충돌 시 초안 유지·최신 변경 반영·파일 교체·메뉴 왕복', async ({
    launch,
    openChat,
    app,
    workRoot,
  }): Promise<void> => {
    const page = await launch();
    await openChat(page);
    const source = join(workRoot, '첫양식.txt');
    const replacement = join(workRoot, '교체양식.txt');
    await writeFile(source, '제목: {{제목}}');
    await writeFile(replacement, '이름: {{이름}}\n내용: {{내용}}');
    await register(page, app(), source, '충돌 검증 양식', '최초 지침');
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await page
      .getByRole('textbox', { name: '템플릿 이름', exact: true })
      .fill('내가 수정한 양식 이름');
    await page.evaluate(async (): Promise<void> => {
      const bridge = window.wiki;
      if (!bridge) throw new Error('bridge_missing');
      const result = await bridge.connection.getState();
      if (
        !result.ok ||
        result.data.status !== 'connected' ||
        !result.data.selection
      )
        throw new Error('connection_missing');
      const state = result.data;
      const selection = state.selection;
      if (!selection) throw new Error('selection_missing');
      const session = {
        connectionId: state.connectionId,
        expectedScope: {
          userId: state.userId,
          tenant: selection.tenant,
          profileId: selection.profile,
          policyRevision: state.policyRevision,
          ...(state.accessRevision
            ? { accessRevision: state.accessRevision }
            : {}),
        },
      };
      const templateId = new URLSearchParams(location.hash.split('?')[1]).get(
        'templateId',
      );
      if (!templateId) throw new Error('template_missing');
      const detail = await bridge.templates.read({ ...session, templateId });
      if (!detail.ok) throw new Error(detail.error.code);
      const changed = await bridge.templates.save({
        ...session,
        templateId,
        expectedRevision: detail.data.template.revision,
        requestId: crypto.randomUUID().replaceAll('-', ''),
        name: detail.data.template.name,
        instructions: '다른 편집에서 갱신한 지침',
      });
      if (!changed.ok) throw new Error(changed.error.code);
    });
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '최신 내용 비교' }),
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: '템플릿 이름', exact: true }),
    ).toHaveValue('내가 수정한 양식 이름');
    await page.getByRole('button', { name: '최신 내용 비교' }).click();
    await page
      .getByRole('button', { name: '내 변경을 최신 내용에 반영' })
      .click();
    await expect(
      page.getByRole('textbox', { name: '지침', exact: true }),
    ).toHaveValue('다른 편집에서 갱신한 지침');
    await expect(
      page.getByRole('textbox', { name: '템플릿 이름', exact: true }),
    ).toHaveValue('내가 수정한 양식 이름');
    await selectFile(app(), replacement);
    await page.getByRole('button', { name: '파일 다시 선택' }).click();
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('article', { name: '지침' })).toContainText(
      '다른 편집에서 갱신한 지침',
    );
    await page
      .getByRole('button', { name: '템플릿 정보', exact: true })
      .click();
    await expect(
      page.getByRole('group', { name: '템플릿 정보' }),
    ).toContainText('교체양식.txt');
    const target = join(workRoot, '교체한-원본.txt');
    await saveTo(app(), target);
    await page.getByRole('button', { name: '원본 내려받기' }).click();
    await expect
      .poll(async (): Promise<string> =>
        readFile(target, 'utf8').catch((): string => ''),
      )
      .toBe('이름: {{이름}}\n내용: {{내용}}');
    await page
      .getByRole('button', { name: '템플릿 정보', exact: true })
      .click();
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await page
      .getByRole('textbox', { name: '템플릿 이름', exact: true })
      .fill('메뉴 왕복 중 보존할 초안');
    await page
      .getByRole('navigation', { name: '기본 메뉴' })
      .getByRole('link', { name: 'AI 채팅', exact: true })
      .click();
    await templatesMenu(page);
    await page
      .getByRole('button', { name: '내가 수정한 양식 이름', exact: true })
      .click();
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: '템플릿 이름', exact: true }),
    ).toHaveValue('메뉴 왕복 중 보존할 초안');
  });

  test('기타 파일도 등록·원본 보존하고 지원되지 않는 생성은 차단', async ({
    launch,
    openChat,
    app,
    workRoot,
    shot,
  }): Promise<void> => {
    const page = await launch();
    await openChat(page);
    const source = join(workRoot, '기존회사양식.hwp');
    const bytes = Buffer.from('registered-opaque-template-file');
    await writeFile(source, bytes);
    await register(
      page,
      app(),
      source,
      '기존 회사 양식',
      '회사 양식을 유지하세요.',
    );
    await expect(
      page.getByRole('button', { name: 'AI 채팅에서 사용' }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /지원/ })
        .last(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '템플릿 정보', exact: true })
      .click();
    const target = join(workRoot, '보존된-원본.hwp');
    await saveTo(app(), target);
    await page.getByRole('button', { name: '원본 내려받기' }).click();
    await expect
      .poll(
        async (): Promise<number> =>
          (await readFile(target).catch((): Buffer => Buffer.alloc(0))).length,
      )
      .toBe(bytes.length);
    expect(await readFile(target)).toEqual(bytes);
    await page
      .getByRole('button', { name: '템플릿 정보', exact: true })
      .click();
    await shot(page, '미지원-형식-안내');
    await page.getByRole('button', { name: '더보기', exact: true }).click();
    await page.getByRole('button', { name: '템플릿 보관' }).click();
    await page.getByRole('button', { name: '보관', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '기존 회사 양식', exact: true }),
    ).toHaveCount(0);
  });
});

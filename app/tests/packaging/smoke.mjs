import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

// 설치 산출물의 실제 진단·설정 복원과 선택한 이전 버전에서의 교체를 검사합니다.
const binary = process.env.WIKI_PACKAGE_EXECUTABLE;
if (!binary) throw new Error('WIKI_PACKAGE_EXECUTABLE is required');
const previousBinary = process.env.WIKI_PACKAGE_PREVIOUS_EXECUTABLE;
const root = resolve(process.env.WIKI_PACKAGE_RUNTIME_ROOT || '..');
const selections = {
  root,
  python:
    process.env.WIKI_PACKAGE_PYTHON ||
    join(
      root,
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    ),
  codex:
    process.env.WIKI_PACKAGE_CODEX ||
    (process.platform === 'darwin'
      ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
      : ''),
  tesseract:
    process.env.WIKI_PACKAGE_TESSERACT ||
    (process.platform === 'darwin' ? '/opt/homebrew/bin/tesseract' : ''),
  tessdata:
    process.env.WIKI_PACKAGE_TESSDATA ||
    (process.platform === 'darwin' ? '/opt/homebrew/share/tessdata' : ''),
};
if (Object.values(selections).some((value) => !value)) {
  throw new Error(
    'Set WIKI_PACKAGE_CODEX, WIKI_PACKAGE_TESSERACT and WIKI_PACKAGE_TESSDATA for this platform',
  );
}
const temporary = await mkdtemp(join(tmpdir(), 'ui11-package-smoke-'));
const output = resolve(
  process.env.WIKI_PACKAGE_VERIFICATION_DIR || 'release/verification',
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !key.startsWith('WIKI_'),
  ),
);
environment.PATH =
  process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    : '/usr/bin:/bin';
let application;
try {
  application = await electron.launch({
    executablePath: previousBinary || binary,
    args: [`--user-data-dir=${temporary}`],
    env: environment,
  });
  let page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.wiki));
  for (const [kind, value] of Object.entries(selections)) {
    // 네이티브 대화상자의 사용자 선택만 제공하고 저장·진단은 실제 앱 경로로 수행합니다.
    await application.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, value);
    const choice = await page.evaluate(
      (selectedKind) =>
        window.wiki.runtime.execute({
          operation: 'choose',
          kind: selectedKind,
        }),
      kind,
    );
    assert.equal(choice.ok, true);
  }
  const report = await page.evaluate(() =>
    window.wiki.runtime.execute({ operation: 'diagnose' }),
  );
  assert.equal(report.ok, true);
  assert.equal(
    report.data.checks.find((entry) => entry.name === 'Python 3.12 이상')
      .status,
    'ok',
  );
  assert.equal(
    report.data.checks.find((entry) => entry.name === 'Tesseract OCR').status,
    'ok',
  );
  assert.equal(
    (
      await page.evaluate(() =>
        window.wiki.runtime.execute({ operation: 'save' }),
      )
    ).ok,
    true,
  );
  await application.close();
  application = null;
  application = await electron.launch({
    executablePath: binary,
    args: [`--user-data-dir=${temporary}`],
    env: environment,
  });
  page = await application.firstWindow();
  const restored = await page.evaluate(() =>
    window.wiki.runtime.execute({ operation: 'read' }),
  );
  assert.equal(restored.ok, true);
  for (const [key, value] of Object.entries(selections))
    assert.equal(restored.data.settings[key], value);
  assert.equal(restored.data.settings.provider, 'codex');
  assert.equal(typeof restored.data.settings.claude, 'string');
  const restartedReport = await page.evaluate(() =>
    window.wiki.runtime.execute({ operation: 'diagnose' }),
  );
  assert.equal(restartedReport.ok, true);
  for (const name of ['Python 3.12 이상', 'Tesseract OCR']) {
    assert.equal(
      restartedReport.data.checks.find((entry) => entry.name === name).status,
      'ok',
    );
  }
  const platform = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    configuredPath: process.env.PATH,
    python: process.env.WIKI_PYTHON,
    analysisCli: process.env.WIKI_ANALYSIS_CODEX_CLI,
    questionCli: process.env.WIKI_QUESTION_CODEX_CLI,
    proposalCli: process.env.WIKI_PROPOSAL_CODEX_CLI,
  }));
  assert.equal(platform.packaged, true);
  assert.equal(platform.python, selections.python);
  assert.equal(platform.analysisCli, selections.codex);
  assert.equal(platform.questionCli, selections.codex);
  assert.equal(platform.proposalCli, selections.codex);
  assert.ok(
    platform.configuredPath
      .split(delimiter)
      .includes(dirname(selections.tesseract)),
  );
  await page.evaluate(() => {
    window.location.hash = '/setup/runtime';
  });
  await page
    .getByRole('heading', { name: '개인 실행 환경', exact: true })
    .waitFor();
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, 'packaged-runtime.png') });
  await writeFile(
    join(output, 'packaged-runtime.json'),
    JSON.stringify(
      {
        packaged: true,
        minimalGuiPath: true,
        checks: restartedReport.data.checks,
        settingsRestored: true,
        applicationReplacement: Boolean(previousBinary),
        platform: process.platform,
        signing: 'unsigned',
        actualInstallerOrGatekeeperApproval: false,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({
      packaged: true,
      diagnosis: restartedReport.data.checks,
      separateRestart: true,
      applicationReplacement: Boolean(previousBinary),
    }) + '\n',
  );
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}

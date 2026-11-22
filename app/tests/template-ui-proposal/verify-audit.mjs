import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const output = 'test-results/template-audit-20261115';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const results = [];
const errors = [];
try {
  for (const width of [1440, 1024]) {
    for (const [stage, file] of [
      ['before', 'before-preview.html'],
      ['previous', 'previous-preview.html'],
      ['after', 'inline-preview.html'],
    ]) {
      const page = await browser.newPage({
        viewport: { width: width + 32, height: 940 },
      });
      page.on('pageerror', (error) =>
        errors.push({ stage, width, message: error.message }),
      );
      await page.goto(pathToFileURL(resolve(output, file)).href);
      const frame = page.frameLocator('iframe');
      const shell = frame.locator('.wiki-theme');
      await expect(frame.getByRole('table')).toBeVisible();
      await shell.evaluate(async (node) => {
        node.ownerDocument.defaultView.scrollTo(0, 0);
        await new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
      });
      const list = await shell.evaluate((node) => {
        const doc = node.ownerDocument;
        const content = node.querySelector('[data-workspace-container]');
        const sidebar = node.querySelector('[aria-label="작업 공간 메뉴"]');
        const header = node
          .querySelector('[aria-label="현재 위치"]')
          .closest('header');
        const table = node.querySelector('table');
        const search = node.querySelector('form[role="search"] input');
        const select = node.querySelector('select');
        const library = search?.closest('[aria-label="템플릿 등록 및 관리"]');
        const finder = search?.closest('[aria-label="템플릿 찾기"]');
        return {
          width: node.getBoundingClientRect().width,
          theme: node.dataset.wikiTheme,
          sidebarWidth: sidebar.getBoundingClientRect().width,
          topbarHeight: header.getBoundingClientRect().height,
          background: getComputedStyle(content).backgroundColor,
          border: getComputedStyle(content).borderColor,
          radius: getComputedStyle(content).borderRadius,
          gutter: library ? getComputedStyle(library).paddingLeft : null,
          fontSize: getComputedStyle(table).fontSize,
          searchHeight:
            search?.closest('label').getBoundingClientRect().height ?? null,
          selectHeight: select?.getBoundingClientRect().height ?? null,
          toolbarHeight:
            finder?.firstElementChild.getBoundingClientRect().height ?? null,
          selectOffset:
            search && select
              ? select.getBoundingClientRect().top -
                search.closest('label').getBoundingClientRect().top
              : null,
          tableOffset: finder
            ? table.getBoundingClientRect().top -
              finder.getBoundingClientRect().top
            : null,
          headerDisplay: getComputedStyle(table.tHead).display,
          rowDisplay: getComputedStyle(table.tBodies[0].rows[0]).display,
          pagination: Boolean(
            node.querySelector('[aria-label="템플릿 페이지"]'),
          ),
          introductoryText: doc.body.textContent.includes(
            '양식 파일과 작성 룰을 함께 보관합니다.',
          ),
        };
      });
      assert.equal(list.width, width);
      await shell.screenshot({ path: `${output}/${stage}-list-${width}.png` });
      await frame
        .getByRole('button', { name: '템플릿 등록', exact: true })
        .click();
      const name = frame.getByRole('textbox', {
        name: '템플릿 이름',
        exact: true,
      });
      await expect(name).toBeVisible();
      const form = await name.evaluate((input) => {
        const doc = input.ownerDocument;
        const label = input.labels[0];
        const textarea = doc.querySelector(
          '[aria-label="템플릿 등록 및 관리"] textarea',
        );
        const form = input.closest('form');
        const submit = [...doc.querySelectorAll('button')].find((button) =>
          ['저장', '템플릿 등록'].includes(button.textContent.trim()),
        );
        return {
          labelWeight: getComputedStyle(label).fontWeight,
          labelSize: getComputedStyle(label).fontSize,
          inputHeight: input.getBoundingClientRect().height,
          inputPadding: getComputedStyle(input).padding,
          textareaSize: getComputedStyle(textarea).fontSize,
          textareaLineHeight: getComputedStyle(textarea).lineHeight,
          textareaMinHeight: getComputedStyle(textarea).minHeight,
          textareaPadding: getComputedStyle(textarea).padding,
          textareaRadius: getComputedStyle(textarea).borderRadius,
          formWidth: form.getBoundingClientRect().width,
          submitInForm: form.contains(submit),
          submitDisabled: submit.disabled,
          sampleButton: doc.body.textContent.includes('예시 양식 사용'),
        };
      });
      await shell.evaluate(async (node) => {
        node.ownerDocument.defaultView.scrollTo(0, 0);
        await new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
      });
      await shell.screenshot({
        path: `${output}/${stage}-register-${width}.png`,
      });
      results.push({ stage, viewport: width, list, form });
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  const references = JSON.parse(
    await readFile(`${output}/metrics-reference.json`, 'utf8'),
  );
  const fields = {
    theme: 'theme',
    sidebarWidth: 'sidebarWidth',
    topbarHeight: 'topbarHeight',
    background: 'workareaBackground',
    border: 'workareaBorder',
    radius: 'workareaRadius',
    gutter: 'gutter',
    fontSize: 'fontSize',
    searchHeight: 'searchHeight',
    selectHeight: 'selectHeight',
    toolbarHeight: 'toolbarHeight',
    selectOffset: 'selectOffset',
    tableOffset: 'tableOffset',
    headerDisplay: 'tableHeaderDisplay',
    rowDisplay: 'rowDisplay',
  };
  const formFields = {
    labelWeight: 'labelFontWeight',
    labelSize: 'labelFontSize',
    inputHeight: 'inputHeight',
    inputPadding: 'inputPadding',
    textareaSize: 'textareaFontSize',
    textareaLineHeight: 'textareaLineHeight',
    textareaMinHeight: 'textareaMinHeight',
    textareaPadding: 'textareaPadding',
    textareaRadius: 'textareaBorderRadius',
    formWidth: 'formWidth',
  };
  let matched = 0;
  for (const reference of references.results) {
    const proposal = results.find(
      (result) =>
        result.stage === 'after' && result.viewport === reference.width,
    );
    assert.ok(proposal);
    for (const [field, key] of Object.entries(fields)) {
      assert.equal(
        proposal.list[field],
        reference.metrics[key],
        `${reference.width}: list ${field}`,
      );
      matched++;
    }
    for (const [field, key] of Object.entries(formFields)) {
      assert.equal(
        proposal.form[field],
        reference.registration[key],
        `${reference.width}: form ${field}`,
      );
      matched++;
    }
  }
  await writeFile(
    `${output}/metrics-proposals.json`,
    JSON.stringify({ results, errors }, null, 2),
  );
  const comparison = {
    passed: true,
    matched,
    propertiesPerViewport: 25,
    viewports: [1440, 1024],
    errors,
  };
  await writeFile(
    `${output}/comparison.json`,
    JSON.stringify(comparison, null, 2),
  );
  console.log(JSON.stringify(comparison));
} finally {
  await browser.close();
}

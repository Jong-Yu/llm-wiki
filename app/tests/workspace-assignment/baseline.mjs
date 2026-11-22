import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const dir =
  '/Users/jong-yu/Projects/LLM Wiki/app/test-results/workspace-assignment';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto('file:///private/tmp/wiki-assignment-baseline.html');
await page.getByRole('textbox', { name: '계정 이름', exact: true }).waitFor();
await page.screenshot({ path: dir + '/baseline-1280.png' });
await page.setViewportSize({ width: 320, height: 736 });
await page.screenshot({ path: dir + '/baseline-320.png' });
await browser.close();

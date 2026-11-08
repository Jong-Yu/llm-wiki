import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import axe from 'axe-core';
import { z } from 'zod';

type AuditOptions = {
  textSpacing?: boolean;
  zoom?: boolean;
};

const issueSchema = z.object({
  id: z.string(),
  impact: z.string().nullable(),
  help: z.string(),
  helpUrl: z.string(),
  nodes: z.array(
    z.object({
      target: z.array(z.unknown()),
      html: z.string(),
      failureSummary: z.string().optional(),
    }),
  ),
});
const reportSchema = z.object({
  violations: z.array(issueSchema),
  incomplete: z.array(issueSchema),
  passes: z.number(),
});
const layoutSchema = z.object({
  viewportWidth: z.number(),
  viewportOverflow: z.number(),
  pageOverflow: z.number(),
  hiddenFocus: z.boolean(),
  clippedControls: z.array(z.object({ text: z.string(), tag: z.string() })),
});

/** 격리된 실제 렌더 화면의 재배치와 초점을 검사합니다. 말줄임 후보는 별도 검토합니다. */
async function layout(
  window: BrowserWindow,
): Promise<z.infer<typeof layoutSchema>> {
  return layoutSchema.parse(
    await window.webContents.executeJavaScript(`(() => {
      const shown = e => e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !e.closest('[hidden],[inert]');
      const active = document.querySelector('[data-workspace-route][data-active="true"]') ?? document.body;
      const focus = document.activeElement;
      return {
        viewportWidth: innerWidth,
        viewportOverflow: Math.max(0, document.documentElement.scrollWidth-innerWidth),
        pageOverflow: Math.max(0, active.scrollWidth-active.clientWidth),
        hiddenFocus: focus !== document.body && focus !== document.documentElement && !shown(focus),
        clippedControls: [...document.querySelectorAll('button,a,select,input,textarea,summary')]
          .filter(e=>shown(e) && e.getBoundingClientRect().width > 1)
          .filter(e=>!(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement) && !(e instanceof HTMLSelectElement))
          .filter(e=>getComputedStyle(e).overflow === 'hidden' && (e.scrollWidth>e.clientWidth+2 || e.scrollHeight>e.clientHeight+2))
          .map(e=>({text:(e.getAttribute('aria-label')??e.textContent??'').trim().slice(0,160),tag:e.tagName}))
      };
    })()`),
  );
}

/** ResizeObserver와 React의 배치 반영 뒤 실제 화면을 검사합니다. */
async function settle(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))',
  );
}

/** 기존 격리 UI 시험에 WCAG A/AA 자동 검사·간격/확대 검사를 선택적으로 더합니다. */
export async function auditAccessibility(
  window: BrowserWindow,
  label: string,
  options: AuditOptions = {},
): Promise<void> {
  if (process.env.WIKI_A11Y !== '1') return;
  const address = new URL(window.webContents.getURL());
  assert.ok(address.protocol === 'file:' || address.hostname === '127.0.0.1');
  const directory = resolve(process.env.WIKI_A11Y_REPORT_DIR ?? '');
  assert.ok(directory.startsWith('/private/tmp/wiki-a11y-'));
  const name = label.replace(/[^a-zA-Z0-9_-]/g, '-');
  await mkdir(directory, { recursive: true });
  await settle(window);
  await window.webContents.executeJavaScript(axe.source);
  const result = reportSchema.parse(
    await window.webContents.executeJavaScript(`axe.run(document, {
      runOnly: {type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']},
      resultTypes:['violations','incomplete']
    }).then(r=>({violations:r.violations,incomplete:r.incomplete,passes:r.passes.length}))`),
  );
  const baseline = await layout(window);
  const checks: Record<string, z.infer<typeof layoutSchema>> = { baseline };
  if (options.textSpacing) {
    // Electron의 user-origin insertCSS 제거 후 남는 스타일을 피하고 시험 소유 노드만 복원합니다.
    const styleId = `wiki-a11y-spacing-${name}`;
    await window.webContents.executeJavaScript(
      `(() => { const style=document.createElement('style'); style.id=${JSON.stringify(styleId)}; style.textContent='*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}'; document.head.append(style); })()`,
    );
    try {
      await settle(window);
      checks.spacing = await layout(window);
      await writeFile(
        join(directory, `${name}-spacing.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
    } finally {
      await window.webContents.executeJavaScript(
        `document.getElementById(${JSON.stringify(styleId)})?.remove()`,
      );
      await settle(window);
    }
  }
  if (options.zoom) {
    const original = window.webContents.getZoomFactor();
    try {
      window.webContents.setZoomFactor(2);
      await settle(window);
      checks.zoom = await layout(window);
      await writeFile(
        join(directory, `${name}-zoom.png`),
        (await window.webContents.capturePage()).toPNG(),
      );
    } finally {
      window.webContents.setZoomFactor(original);
      await settle(window);
    }
  }
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify(
      { label, axeVersion: axe.version, ...result, checks },
      null,
      2,
    ),
  );
  console.log(
    `A11Y ${label}: ${result.violations.length} violations, ${result.incomplete.length} manual checks`,
  );
  if (process.env.WIKI_A11Y_REPORT_ONLY === '1') return;
  assert.equal(
    result.violations.length,
    0,
    `${label}: ${result.violations.map((issue): string => issue.id).join(', ')}`,
  );
  for (const [mode, check] of Object.entries(checks)) {
    assert.ok(
      check.viewportOverflow <= 1 && check.pageOverflow <= 1,
      `${label}/${mode}: page overflow`,
    );
    assert.equal(
      check.hiddenFocus,
      false,
      `${label}/${mode}: focus is in hidden content`,
    );
  }
}

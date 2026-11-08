import assert from 'node:assert/strict';
import { readCodexAccount } from '@main/backend/AccountUsageService';
const cli = process.env.WIKI_RUNTIME_CODEX;
if (!cli) throw new Error('WIKI_RUNTIME_CODEX is required');
const result = await readCodexAccount(cli);
assert.equal(result.provider, 'codex');
for (const window of result.windows) {
  assert.ok(Number.isFinite(window.usedPercent));
  assert.ok(window.remainingPercent >= 0 && window.remainingPercent <= 100);
}
console.log(
  JSON.stringify({
    provider: result.provider,
    status: result.status,
    windowCount: result.windows.length,
    accountIdentified: !!result.accountLabel,
    checkedAt: result.checkedAt,
  }),
);

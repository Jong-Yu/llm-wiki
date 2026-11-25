import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCheck } from '../testRuntime.mjs';

await runNodeCheck({
  appRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  suite: 'ai-sessions',
  temporaryPrefix: 'wiki-session-check-',
  failureMessage: 'AI session checks failed',
});

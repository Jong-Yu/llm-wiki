import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCheck } from '../testRuntime.mjs';

await runNodeCheck({
  appRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  suite: 'document-task-views',
  temporaryPrefix: 'wiki-document-task-check-',
  failureMessage: 'Document task presentation checks failed',
});

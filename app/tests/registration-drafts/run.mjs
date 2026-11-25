import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCheck } from '../testRuntime.mjs';

await runNodeCheck({
  appRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  suite: 'registration-drafts',
  temporaryPrefix: 'wiki-registration-draft-build-',
  failureMessage: 'Registration draft recovery checks failed',
});

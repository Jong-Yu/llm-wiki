import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNodeCheck } from '../testRuntime.mjs';

await runNodeCheck({
  appRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  suite: 'source-visual-previews',
  temporaryPrefix: 'wiki-source-preview-build-',
  failureMessage: 'Local original preview checks failed',
});

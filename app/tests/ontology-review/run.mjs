import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOntologyCheck } from '../testRuntime.mjs';

await runOntologyCheck({
  appRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  kind: 'review',
  failureMessage: 'Relation review checks failed',
});

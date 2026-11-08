import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
async function actualModule(path) {
  const markdown = path.endsWith('DocumentMarkdown.tsx');
  const temporary = markdown
    ? await mkdtemp(resolve(tmpdir(), 'wiki-document-evidence-'))
    : null;
  const entry = temporary
    ? resolve(temporary, 'entry.mjs')
    : resolve(root, path);
  if (temporary)
    await writeFile(
      entry,
      `import { createElement } from ${JSON.stringify(resolve(root, 'node_modules/react/index.js'))};
    import { renderToStaticMarkup } from ${JSON.stringify(resolve(root, 'node_modules/react-dom/server.node.js'))};
    import { DocumentMarkdown } from ${JSON.stringify(resolve(root, path))};
    export function renderDocument(props) { return renderToStaticMarkup(createElement(DocumentMarkdown, props)); }`,
    );
  try {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      root,
      plugins: [react()],
      resolve: { alias: { '@renderer': resolve(root, 'src/renderer') } },
      ssr: { noExternal: true },
      build: {
        write: false,
        ssr: entry,
        rolldownOptions: { output: { format: 'es' } },
      },
    });
    const output = Array.isArray(result) ? result[0].output : result.output;
    const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
    assert.ok(chunk);
    if (temporary) {
      const compiled = resolve(temporary, 'compiled.mjs');
      await writeFile(compiled, chunk.code);
      return await import(pathToFileURL(compiled).href);
    }
    return import(
      `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
    );
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
const {
  documentEvidenceLink,
  documentEvidenceReturnTo,
  readDocumentEvidence,
  matchDocumentEvidence,
} = await actualModule('src/renderer/shared/lib/documentEvidence.ts');
const { renderDocument } = await actualModule(
  'src/renderer/features/manage-document-content/ui/DocumentMarkdown.tsx',
);
const revision = 'a'.repeat(64);
const body =
  '# Heading\n\nfirst paragraph\n\n```json\n{"title":"Energy"}\n{"value":3}\n```\n';
const content = '---\ntitle: Energy\n---\n' + body;
const current = {
  document: 'sample.md',
  revision,
  content,
  body,
  bodyStartLine: 4,
};

await test('근거 문서는 원래 온톨로지 주소로 복귀하며 외부·다른 화면·조작된 주소는 받지 않는다', () => {
  const returnTo =
    '/ontology?path=sample.md&document=sample.md&view=relation&claim=example';
  const target = documentEvidenceLink(
    'sample.md',
    revision,
    { quote: 'first paragraph', start_line: 6 },
    returnTo,
  );
  assert.equal(documentEvidenceReturnTo(target.state), returnTo);
  const withoutPosition = documentEvidenceLink(
    'sample.md',
    '',
    null,
    '/ontology',
  );
  assert.equal(documentEvidenceReturnTo(withoutPosition.state), '/ontology');
  assert.equal(
    documentEvidenceReturnTo(
      documentEvidenceLink('sample.md', revision, null).state,
    ),
    null,
  );
  for (const unsafe of [
    'https://example.com/ontology',
    '//example.com/ontology',
    '/documents',
    '/ontology/other',
    '/ontology#other',
    '/ontology?x=one\ntwo',
    '/ontology\\other',
    'javascript:alert(1)',
  ]) {
    assert.equal(documentEvidenceReturnTo({ ontologyReturnTo: unsafe }), null);
    assert.equal(
      documentEvidenceReturnTo(
        documentEvidenceLink(
          'sample.md',
          revision,
          { quote: 'first paragraph' },
          unsafe,
        ).state,
      ),
      null,
    );
  }
});

await test('근거 링크는 전체 인용을 탐색 이력에 보존하고 원본 파일 행과 판본을 대조한다', () => {
  const evidence = {
    quote: 'first paragraph',
    start_line: 6,
    end_line: 6,
    occurrence: 0,
  };
  const target = documentEvidenceLink('sample.md', revision, evidence);
  assert.ok(!target.to.includes('first+paragraph'));
  const location = readDocumentEvidence(
    new URLSearchParams(target.to.split('?')[1]),
    target.state,
    'sample.md',
  );
  assert.equal(location.quote, evidence.quote);
  assert.deepEqual(matchDocumentEvidence(current, location), {
    status: 'matched',
    startLine: 6,
    endLine: 6,
  });
  assert.deepEqual(
    matchDocumentEvidence({ ...current, revision: 'b'.repeat(64) }, location),
    { status: 'changed' },
  );
  assert.deepEqual(
    matchDocumentEvidence(current, {
      ...location,
      quote: 'different paragraph',
    }),
    { status: 'unavailable' },
  );
  assert.deepEqual(
    matchDocumentEvidence(current, {
      ...location,
      startLine: 2,
      endLine: 2,
      quote: 'title: Energy',
    }),
    { status: 'unavailable' },
  );
});

await test('반복 인용은 출현 순서를 확인하며 다른 문서의 탐색 이력은 채택하지 않는다', () => {
  const target = documentEvidenceLink('sample.md', revision, {
    quote: 'same',
    occurrence: 1,
  });
  const location = readDocumentEvidence(
    new URLSearchParams(target.to.split('?')[1]),
    target.state,
    'sample.md',
  );
  const repeated = {
    document: 'sample.md',
    revision,
    content: 'same\nelse\nsame',
  };
  assert.deepEqual(matchDocumentEvidence(repeated, location), {
    status: 'matched',
    startLine: 3,
    endLine: 3,
  });
  assert.deepEqual(
    matchDocumentEvidence(repeated, { ...location, occurrence: null }),
    { status: 'unavailable' },
  );
  const foreign = readDocumentEvidence(
    new URLSearchParams(target.to.split('?')[1]),
    target.state,
    'other.md',
  );
  assert.equal(foreign.quote, null);
  assert.equal(
    readDocumentEvidence(
      new URLSearchParams('evidence=1&sourceRevision=bad'),
      target.state,
      'sample.md',
    ),
    null,
  );
});

await test('본문의 행 번호는 분리된 메타정보를 포함하며 긴 코드 원문도 행별 이동 위치를 가진다', () => {
  const html = renderDocument({
    content: body,
    bodyStartLine: 4,
    evidence: { status: 'matched', startLine: 9, endLine: 9 },
  });
  assert.match(
    html,
    /<p data-source-start-line="6" data-source-end-line="6">first paragraph<\/p>/,
  );
  assert.match(
    html,
    /<span data-source-start-line="9" data-source-end-line="9">\{&quot;title&quot;:&quot;Energy&quot;\}/,
  );
  assert.match(
    html,
    /<span data-source-start-line="10" data-source-end-line="10">\{&quot;value&quot;:3\}/,
  );
  assert.ok(html.includes('first paragraph'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
async function actualModule(file) {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    root,
    plugins: [react()],
    resolve: {
      alias: {
        '@contracts': resolve(root, 'src/shared/contracts'),
        '@renderer': resolve(root, 'src/renderer'),
      },
    },
    ssr: { noExternal: true },
    build: {
      write: false,
      ssr: fileURLToPath(new URL(file, import.meta.url)),
      rolldownOptions: { output: { format: 'es' } },
    },
  });
  const output = Array.isArray(result) ? result[0].output : result.output;
  const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
  assert.ok(chunk);
  return import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
  );
}
const { sourceAnchorLabel, sourceAnchorValue } =
  await actualModule('./sourceAnchors.ts');
const { buildOntologyGraph } = await actualModule('./buildOntologyGraph.ts');
const {
  ontologyEndpointLabel,
  ontologyProvenanceValue,
  ontologyQualifierSummary,
  ontologyTermLabel,
} = await actualModule('./ontologyLabels.ts');
const { OntologyValue } = await actualModule('../ui/OntologyValue.tsx');
const { OntologyConceptMeaning } = await actualModule(
  '../ui/OntologyConceptMeaning.tsx',
);
const metadata = {
  original_record_id: 'B07',
  original_sha256: 'a'.repeat(64),
  original_json_schema_id: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
  metadata_role: 'Repeated original namespace identifiers only.',
};
const anchor = {
  kind: 'source_anchor',
  document: 'a.md',
  source_revision: 'b'.repeat(64),
  quote: JSON.stringify(metadata, null, 2),
  start_line: 19,
  end_line: 25,
  occurrence: 0,
};

await test('같은 관계의 범위와 관점 차이를 표시하고 원문 값은 보존한다', () => {
  const first = {
    qualifiers: { scope: 'household electricity' },
    context: { viewpoints: ['developer'] },
  };
  const second = {
    qualifiers: {
      scope: 'commercial electricity',
      condition: { region: 'KR' },
    },
  };
  const before = JSON.stringify([first, second]);
  assert.match(ontologyQualifierSummary(first), /household electricity/);
  assert.match(ontologyQualifierSummary(second), /commercial electricity/);
  assert.match(ontologyQualifierSummary(second), /region: KR/);
  assert.match(ontologyQualifierSummary(first), /개발 관점/);
  assert.equal(ontologyTermLabel('asserted'), '원문에서 서술');
  assert.equal(ontologyTermLabel('positive'), '긍정');
  assert.equal(
    ontologyTermLabel('external_domain_value'),
    'external_domain_value',
  );
  assert.equal(JSON.stringify([first, second]), before);
});

await test('메타데이터 인용은 짧은 근거 이름으로 표시하고 전체 값과 참조는 보존한다', () => {
  const before = JSON.stringify(anchor);
  assert.equal(sourceAnchorLabel(anchor), '원문 메타데이터 · 19–25행');
  assert.equal(ontologyEndpointLabel(anchor, []), sourceAnchorLabel(anchor));
  assert.deepEqual(sourceAnchorValue(anchor), metadata);
  const graph = buildOntologyGraph([
    {
      document: 'a.md',
      claims: [],
      effectiveGraph: {
        entities: [{ id: 'doc', label: '원본 문서', type: 'document' }],
        relations: [
          { subject: 'doc', predicate: 'has_source_metadata', object: anchor },
        ],
        attributes: [],
        relation_candidates: [],
      },
    },
  ]);
  assert.equal(graph.concepts[1].entity.label, sourceAnchorLabel(anchor));
  assert.deepEqual(graph.concepts[1].entity.anchor, anchor);
  assert.equal(graph.assertions[0].value.predicate, 'has_source_metadata');
  assert.equal(graph.assertions[0].label, '원문 메타데이터');
  assert.equal(JSON.stringify(anchor), before);
});

await test('JSON 조각·일반 인용을 버리거나 이름으로 대체 저장하지 않는다', () => {
  const fragment = {
    ...anchor,
    quote: '"/definitions/energyMeasure": {',
    start_line: 1141,
    end_line: 1143,
  };
  assert.equal(sourceAnchorValue(fragment), fragment.quote);
  assert.equal(sourceAnchorLabel(fragment), '원문 근거 · 1141–1143행');
  assert.equal(
    sourceAnchorLabel({ kind: 'source_anchor', quote: '일반 원문' }),
    '원문 근거',
  );
});

await test('구조화된 값은 항목별로 읽고 해시·URL·문구를 빠짐없이 확인할 수 있다', () => {
  const html = renderToStaticMarkup(
    createElement(OntologyValue, { value: metadata }),
  );
  assert.match(html, /<dt>원본 기록<\/dt>/);
  assert.match(html, /<dt>원본 SHA-256<\/dt>/);
  assert.ok(html.includes(metadata.original_sha256));
  assert.ok(html.includes(metadata.original_json_schema_id));
  assert.ok(html.includes(metadata.metadata_role));
  assert.ok(!html.includes('&quot;original_record_id&quot;'));
  const text = JSON.stringify(metadata);
  const textHtml = renderToStaticMarkup(
    createElement(OntologyValue, { value: text }),
  );
  assert.match(textHtml, /JSON 형식의 텍스트/);
  assert.match(textHtml, /<dt>원본 기록<\/dt>/);
  assert.ok(textHtml.includes(metadata.original_sha256));
});

await test('깊은 업무 속성도 원시 객체 대신 항목으로 읽고 원문 식별값을 보존한다', () => {
  let value = { namespace: '장비 분류', value: '실제 원문 식별값' };
  for (let depth = 0; depth < 9; depth += 1) value = { nested: value };
  const before = JSON.stringify(value);
  const html = renderToStaticMarkup(createElement(OntologyValue, { value }));
  assert.ok(html.includes('실제 원문 식별값'));
  assert.ok(html.includes('<dt>이름 공간</dt>'));
  assert.ok(!html.includes('<pre'));
  assert.ok(!html.includes('&quot;nested&quot;'));
  assert.equal(JSON.stringify(value), before);
});

await test('추가 조회 없이 읽는 개념에도 인용·위치·맥락·실제 식별값이 남는다', () => {
  const entity = {
    id: 'INTERNAL_ENTITY_ID',
    label: 'CO2 Measure',
    type: 'concept',
    evidence: {
      quote: '원문에 기록된 CO2 측정 정의',
      start_line: 1169,
      end_line: 1171,
      occurrence: 0,
    },
    context: { domain: '측정 업무', viewpoints: ['developer'] },
    identifiers: [
      {
        namespace: '원문 스키마',
        value: 'CO2-01',
        evidence: {
          quote: '식별값 CO2-01의 원문 근거',
          start_line: 1172,
          end_line: 1172,
        },
      },
    ],
  };
  const before = JSON.stringify(entity);
  const html = renderToStaticMarkup(
    createElement(OntologyConceptMeaning, { entity }),
  );
  for (const value of [
    '원문에 기록된 CO2 측정 정의',
    '1169',
    '1171',
    '측정 업무',
    '개발',
    '원문 스키마',
    'CO2-01',
    '식별값 CO2-01의 원문 근거',
  ])
    assert.ok(html.includes(value));
  assert.ok(!html.includes('INTERNAL_ENTITY_ID'));
  assert.ok(!html.includes('<pre'));
  const withPassage = renderToStaticMarkup(
    createElement(OntologyConceptMeaning, {
      entity,
      passage: { quote: '앞뒤 원문 문맥', start_line: 1168, end_line: 1173 },
    }),
  );
  assert.equal(withPassage.split('원문에 기록된 CO2 측정 정의').length - 1, 1);
  assert.ok(withPassage.includes('앞뒤 원문 문맥'));
  assert.equal(JSON.stringify(entity), before);
});

await test('출처·귀속·귀속 근거는 보존하고 관리 이벤트 참조는 표시하지 않는다', () => {
  const provenance = {
    source_entity: 'doc_id',
    attributed_to: 'person_id',
    basis: { quote: '홍길동은 측정값을 확인했다.' },
    event_id: 'INTERNAL_EVENT_ID',
  };
  const before = JSON.stringify(provenance);
  const entities = [
    { id: 'doc_id', label: '측정 규약', type: 'document' },
    { id: 'person_id', label: '홍길동', type: 'person' },
  ];
  const value = ontologyProvenanceValue(provenance, entities);
  assert.deepEqual(value, {
    source_entity: '측정 규약',
    attributed_to: '홍길동',
    basis: provenance.basis,
  });
  const html = renderToStaticMarkup(createElement(OntologyValue, { value }));
  for (const text of ['측정 규약', '홍길동', '홍길동은 측정값을 확인했다.'])
    assert.ok(html.includes(text));
  for (const text of ['doc_id', 'person_id', 'INTERNAL_EVENT_ID'])
    assert.ok(!html.includes(text));
  assert.equal(JSON.stringify(provenance), before);
});

await test('완전한 JSON인 인용·문자열 근거도 문구와 공백을 그대로 읽는다', () => {
  const quote = ' {\n  "sensor": "<CO2>",\n  "value": [1, 2]\n} \n';
  const escaped = quote
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  for (const value of [
    { evidence: { quote, start_line: 12, end_line: 15 } },
    { evidence: quote },
    { provenance: { basis: quote } },
  ]) {
    const before = JSON.stringify(value);
    const html = renderToStaticMarkup(createElement(OntologyValue, { value }));
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes('JSON 형식의 텍스트'));
    assert.ok(!html.includes('<dt>sensor</dt>'));
    assert.ok(!html.includes('&quot;evidence&quot;'));
    assert.ok(!html.includes('<pre'));
    assert.equal(JSON.stringify(value), before);
  }
  const businessValue = renderToStaticMarkup(
    createElement(OntologyValue, { value: { value: quote } }),
  );
  assert.ok(businessValue.includes('JSON 형식의 텍스트'));
  assert.ok(businessValue.includes('<dt>sensor</dt>'));
});

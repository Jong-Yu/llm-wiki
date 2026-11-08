import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const result = await build({
  configFile: false,
  logLevel: 'silent',
  root,
  resolve: {
    alias: {
      '@contracts': resolve(root, 'src/shared/contracts'),
      '@renderer': resolve(root, 'src/renderer'),
    },
  },
  ssr: { noExternal: true },
  build: {
    write: false,
    ssr: fileURLToPath(new URL('./useOntologyExploration.ts', import.meta.url)),
    rolldownOptions: { output: { format: 'es' } },
  },
});
const output = Array.isArray(result) ? result[0].output : result.output;
const chunk = output.find((item) => item.type === 'chunk' && item.isEntry);
assert.ok(chunk);
const {
  graphFromSeeds,
  explorationLabel,
  explorationSeedFromPage,
  explorationSeedIsStale,
  explorationEndpointKey,
  resolveExplorationAnchor,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
);

function concept(document, id, revision = 'a') {
  return {
    document,
    entity_id: id,
    name: '동명',
    type: '개념',
    attribute_count: 2,
    ref: { state_revision: revision },
  };
}
function seed(concept, concepts, edges, total) {
  return {
    concept,
    concepts,
    edges,
    total,
    cursor: null,
    incomplete: false,
    stale: false,
  };
}
function edge(document, id, a, b) {
  return {
    key: id,
    document,
    subject: { document, entity_id: a },
    object: { document, entity_id: b },
    label: '사용',
    collection: 'relations',
    origin: 'machine',
    polarity: 'positive',
    modality: 'asserted',
    conditional: false,
  };
}

await test('이웃에 다시 나온 시작점의 전체 건수와 문서별 동명 식별자를 보존한다', () => {
  const a = concept('a.md', 'same');
  const b = concept('a.md', 'b');
  const c = concept('c.md', 'same');
  const shared = edge('a.md', 'ab', 'same', 'b');
  const graph = graphFromSeeds([
    seed(a, [a, b], [shared], 135),
    seed(b, [b, a], [shared], 1),
    seed(c, [c], [], 0),
  ]);
  assert.equal(graph.assertions.length, 1);
  assert.equal(graph.concepts.length, 3);
  assert.equal(
    graph.concepts.find((row) => row.key === JSON.stringify(['a.md', 'same']))
      .relationCount,
    135,
  );
  assert.equal(
    graph.concepts.find((row) => row.key === JSON.stringify(['c.md', 'same']))
      .relationCount,
    0,
  );
});

await test('지도 이름과 검색 미리보기에서 부정·가능·조건을 생략하지 않는다', () => {
  assert.equal(
    explorationLabel({
      label: '사용',
      polarity: 'negative',
      modality: 'possible',
      conditional: true,
    }),
    '사용 · 부정 · 가능 · 조건 있음',
  );
  assert.equal(
    explorationLabel({
      label: '사용',
      polarity: 'positive',
      modality: 'asserted',
      conditional: false,
    }),
    '사용',
  );
  assert.match(
    explorationLabel({
      label: '사용',
      polarity: 'unknown_polarity',
      modality: null,
      conditional: false,
    }),
    /unknown_polarity/,
  );
});

function neighborPage(selected, indexRevision) {
  return {
    document: { document: selected.document },
    entity_id: selected.entity_id,
    concepts: [selected],
    edges: [],
    next_cursor: null,
    total: 0,
    coverage: { complete: true, skipped: [], truncated: false },
    index_revision: indexRevision,
  };
}

function anchor(document, id, occurrence = 0) {
  return {
    document,
    anchor_id: id,
    source_revision: 'source-revision',
    start_line: 61,
    end_line: 62,
    occurrence,
    ref: { state_revision: 'a', source_revision: 'source-revision' },
  };
}

function anchorEdge(selected, target, id = 'anchor-edge') {
  return {
    ...edge(selected.document, id, selected.entity_id, ''),
    object: { document: target.document, anchor_id: target.anchor_id },
    claim_id: 'claim',
    ref: { state_revision: 'a', source_revision: 'source-revision' },
    collection_index: 0,
  };
}

await test('원문 위치는 개념 ID와 구분해 그리며 여러 주제가 읽은 같은 위치만 합친다', () => {
  const selected = concept('a.md', 'a');
  const target = anchor('a.md', 'same');
  const repeated = anchor('a.md', 'same-quote-second-occurrence', 1);
  const entityWithSameId = concept('a.md', 'same');
  const first = anchorEdge(selected, target);
  const second = anchorEdge(selected, repeated, 'second');
  const graph = graphFromSeeds([
    {
      ...seed(selected, [selected, entityWithSameId], [first, second], 2),
      anchors: [target, repeated],
    },
    {
      ...seed(entityWithSameId, [entityWithSameId, selected], [first], 1),
      anchors: [target],
    },
  ]);
  assert.equal(graph.concepts.length, 4);
  assert.equal(graph.assertions.length, 2);
  assert.equal(graph.concepts.filter((item) => item.sourceAnchor).length, 2);
  assert.notEqual(
    explorationEndpointKey(target),
    explorationEndpointKey(entityWithSameId),
  );
  const node = graph.concepts.find(
    (item) => item.key === explorationEndpointKey(target),
  );
  assert.match(node.entity.label, /원문 근거.*61–62행/);
  assert.equal(node.entity.anchor, undefined);
  assert.equal(node.sourceAnchor.quote, undefined);
  assert.equal(graph.assertions[0].object, node.key);
  assert.equal(graph.assertions[0].subject, JSON.stringify(['a.md', 'a']));
});

await test('원문 끝점은 페이지별로 누적하고 처음부터 새로 읽으면 이전 위치를 남기지 않는다', () => {
  const selected = concept('a.md', 'a');
  const first = anchor('a.md', 'first');
  const second = anchor('a.md', 'second', 1);
  const firstPage = {
    ...neighborPage(selected, 'index'),
    anchors: [first],
    edges: [anchorEdge(selected, first)],
    next_cursor: 'next',
    total: 2,
  };
  const initial = explorationSeedFromPage(selected, firstPage, null, 'global');
  const following = explorationSeedFromPage(
    selected,
    {
      ...firstPage,
      anchors: [first, second],
      edges: [anchorEdge(selected, second, 'second-edge')],
      next_cursor: null,
    },
    initial,
    'global',
  );
  assert.equal(following.anchors.length, 2);
  assert.equal(following.concepts.length, 1);
  assert.equal(following.edges.length, 2);
  assert.equal(graphFromSeeds([following]).concepts.length, 3);
  const refreshed = explorationSeedFromPage(
    selected,
    {
      ...firstPage,
      anchors: [second],
      edges: [anchorEdge(selected, second, 'fresh-edge')],
      next_cursor: null,
    },
    null,
    'new-global',
  );
  assert.deepEqual(refreshed.anchors, [second]);
  assert.equal(graphFromSeeds([]).concepts.length, 0);
});

function fullAnchorGraph(selected, summary) {
  const full = {
    key: 'full-canonical-anchor-key',
    document: summary.document,
    entity: {
      id: 'full-anchor',
      label: '원문 근거',
      type: '원문 근거',
      anchor: {
        kind: 'source_anchor',
        document: summary.document,
        source_revision: summary.source_revision,
        start_line: summary.start_line,
        end_line: summary.end_line,
        occurrence: summary.occurrence,
        quote: 'The complete original quotation, with condition and exception.',
      },
    },
  };
  const assertion = {
    key: 'full-claim',
    document: summary.document,
    subject: JSON.stringify([selected.document, selected.entity_id]),
    object: full.key,
    claim: { claim_id: 'claim' },
    knowledge: { stateRevision: 'a', sourceRevision: summary.source_revision },
  };
  return { concepts: [full], assertions: [assertion] };
}

await test('앵커 상세는 같은 판본의 관계 끝점에서 전체 인용을 찾으며 다른 위치·판본을 거부한다', () => {
  const selected = concept('a.md', 'a');
  const summary = anchor('a.md', 'source-anchor');
  const projected = anchorEdge(selected, summary);
  const graph = fullAnchorGraph(selected, summary);
  const resolved = resolveExplorationAnchor(summary, [projected], graph);
  assert.equal(resolved, graph.concepts[0]);
  assert.equal(
    resolved.entity.anchor.quote,
    'The complete original quotation, with condition and exception.',
  );
  for (const mismatch of [
    { document: 'other.md' },
    { source_revision: 'other-source' },
    { start_line: 60 },
    { end_line: 63 },
    { occurrence: 1 },
    { ref: { ...summary.ref, state_revision: 'other-state' } },
  ])
    assert.equal(
      resolveExplorationAnchor({ ...summary, ...mismatch }, [projected], graph),
      undefined,
    );
  assert.equal(
    resolveExplorationAnchor(summary, [projected], {
      ...graph,
      assertions: [
        {
          ...graph.assertions[0],
          knowledge: {
            ...graph.assertions[0].knowledge,
            stateRevision: 'old-state',
          },
        },
      ],
    }),
    undefined,
  );
  assert.equal(resolveExplorationAnchor(summary, [], graph), undefined);
});

await test('같은 요약 ID가 서로 다른 전체 근거에 대응하면 임의로 첫 원문을 선택하지 않는다', () => {
  const selected = concept('a.md', 'a');
  const summary = anchor('a.md', 'source-anchor');
  const projected = anchorEdge(selected, summary);
  const graph = fullAnchorGraph(selected, summary);
  const original = graph.concepts[0];
  const other = {
    ...original,
    key: 'other-full-anchor',
    entity: {
      ...original.entity,
      anchor: {
        ...original.entity.anchor,
        quote: 'Different actual quotation.',
      },
    },
  };
  assert.equal(
    resolveExplorationAnchor(summary, [projected], {
      concepts: [original, other],
      assertions: [
        graph.assertions[0],
        { ...graph.assertions[0], object: other.key },
      ],
    }),
    undefined,
  );
});

await test('같은 검색 색인에서 서로 다른 문서 이웃을 읽고 검색으로 왕복해도 새로 읽기를 요구하지 않는다', () => {
  const a = concept('a.md', 'a');
  const b = concept('b.md', 'b');
  const first = explorationSeedFromPage(
    a,
    neighborPage(a, 'document-a-index'),
    null,
    'global-index',
  );
  const second = explorationSeedFromPage(
    b,
    neighborPage(b, 'document-b-index'),
    null,
    'global-index',
  );
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.indexRevision, 'global-index');
  assert.equal(second.indexRevision, 'global-index');
  // 첫 검색·다른 문서 추가·원문 복귀 후 같은 검색 재실행은 같은 전체 기준을 관측합니다.
  for (const readAgain of ['global-index', 'global-index', 'global-index']) {
    assert.equal(explorationSeedIsStale(first, readAgain), false);
    assert.equal(explorationSeedIsStale(second, readAgain), false);
  }
});

await test('실제 전체 색인 변경과 판본 오류는 안내하고 명시 갱신한 시작점에는 새 검색 기준을 쓴다', () => {
  const selected = concept('a.md', 'a');
  const original = explorationSeedFromPage(
    selected,
    neighborPage(selected, 'document-index'),
    null,
    'global-before',
  );
  assert.ok(original);
  assert.equal(explorationSeedIsStale(original, 'global-after'), true);
  const refreshed = explorationSeedFromPage(
    selected,
    neighborPage(selected, 'document-index'),
    null,
    'global-after',
  );
  assert.ok(refreshed);
  assert.equal(explorationSeedIsStale(refreshed, 'global-after'), false);
  assert.equal(
    explorationSeedIsStale({ ...refreshed, stale: true }, 'global-after'),
    true,
  );
});

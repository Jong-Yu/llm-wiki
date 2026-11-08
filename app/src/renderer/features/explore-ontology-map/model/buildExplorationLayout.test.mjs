import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// 런타임 의존성이 없는 실제 배치 함수를 변환해 제품의 alias/브라우저 환경 없이 검사합니다.
const source = await readFile(
  new URL('./buildExplorationLayout.ts', import.meta.url),
  'utf8',
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;
const { buildExplorationLayout } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);

function concept(document, id, label = id) {
  return {
    key: JSON.stringify([document, id]),
    document,
    entity: { id, label, type: 'concept' },
  };
}
function edge(key, from, to, label = '연결') {
  return {
    key,
    document: from.document,
    subject: from.key,
    object: to.key,
    label,
    origin: 'machine',
    collection: 'relations',
  };
}

await test('여러 문서의 동명 시작점을 합치지 않고 연결된 공유 개체는 한 번만 그린다', () => {
  const a = concept('a.md', 'same', '동명');
  const b = concept('b.md', 'same', '동명');
  const c = concept('a.md', 'shared');
  const graph = {
    concepts: [a, b, c, c],
    assertions: [edge('ac', a, c), edge('bc', b, c)],
  };
  const layout = buildExplorationLayout(graph, a, [a.key, b.key], 1, new Set());
  assert.equal(layout.nodes.length, 3);
  assert.equal(new Set(layout.nodes.map((node) => node.key)).size, 3);
  assert.equal(layout.nodes.filter((node) => node.topic).length, 2);
  assert.deepEqual(layout.edges.map((item) => item.key).sort(), ['ac', 'bc']);
});

await test('순환·역방향·같은 열·자기 연결·평행 관계를 누락하지 않는다', () => {
  const a = concept('a.md', 'a');
  const b = concept('a.md', 'b');
  const c = concept('a.md', 'c');
  const assertions = [
    edge('ab', a, b),
    edge('ac', a, c),
    edge('bc', b, c),
    edge('ba', b, a),
    edge('aa', a, a),
    edge('ab2', a, b),
  ];
  const layout = buildExplorationLayout(
    { concepts: [a, b, c], assertions },
    a,
    [a.key],
    1,
    new Set(),
  );
  assert.equal(layout.edges.length, assertions.length);
  assert.equal(
    new Set(layout.edges.map((item) => item.path)).size,
    assertions.length,
  );
  assert.ok(layout.edges.every((item) => !item.path.includes('NaN')));
});

await test('표시 범위는 읽은 그래프에만 적용하고 속성·미확인 끝점은 선으로 만들지 않는다', () => {
  const a = concept('a.md', 'a');
  const b = concept('a.md', 'b');
  const c = concept('a.md', 'c');
  const unknown = concept('a.md', 'missing');
  const graph = {
    concepts: [a, b, c],
    assertions: [
      edge('ab', a, b, '첫 연결'),
      edge('bc', b, c, '둘째 연결'),
      edge('missing', a, unknown),
      { ...edge('attribute', a, c), collection: 'attributes' },
    ],
  };
  const direct = buildExplorationLayout(graph, a, [a.key], 1, new Set());
  assert.deepEqual(
    direct.edges.map((item) => item.key),
    ['ab'],
  );
  assert.equal(direct.unresolvedCount, 1);
  const extended = buildExplorationLayout(graph, a, [a.key], 2, new Set());
  assert.deepEqual(
    extended.edges.map((item) => item.key),
    ['ab', 'bc'],
  );
  const filtered = buildExplorationLayout(
    graph,
    a,
    [a.key],
    2,
    new Set(['첫 연결']),
  );
  assert.deepEqual(
    filtered.edges.map((item) => item.key),
    ['ab'],
  );
  assert.deepEqual(filtered.relationCounts, extended.relationCounts);
});

await test('관련 시작점은 현재 초점의 좌우 방향으로 놓고 무관한 시작점은 별도 행에 유지한다', () => {
  const a = concept('a.md', 'a');
  const b = concept('a.md', 'b');
  const c = concept('a.md', 'c');
  const separate = concept('separate.md', 'b');
  const layout = buildExplorationLayout(
    {
      concepts: [a, b, c, separate],
      assertions: [edge('ab', a, b), edge('bc', b, c)],
    },
    b,
    [a.key, b.key, c.key, separate.key],
    1,
    new Set(),
  );
  const byKey = new Map(layout.nodes.map((node) => [node.key, node]));
  assert.equal(byKey.get(b.key).column, 0);
  assert.ok(byKey.get(a.key).column < byKey.get(b.key).column);
  assert.ok(byKey.get(c.key).column > byKey.get(b.key).column);
  assert.equal(byKey.get(separate.key).column, 0);
  assert.ok(
    byKey.get(separate.key).y >
      Math.max(
        ...[a, b, c].map(
          (item) => byKey.get(item.key).y + byKey.get(item.key).height,
        ),
      ),
  );
  assert.equal(layout.nodes.length, 4);
  assert.equal(new Set(layout.nodes.map((node) => node.key)).size, 4);
  assert.deepEqual(
    layout.edges.map((item) => item.key),
    ['ab', 'bc'],
  );
});

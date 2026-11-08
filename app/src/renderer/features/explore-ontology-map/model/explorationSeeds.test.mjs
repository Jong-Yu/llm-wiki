import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const built = await build({
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
    ssr: fileURLToPath(new URL('./explorationSeeds.ts', import.meta.url)),
    rolldownOptions: { output: { format: 'es' } },
  },
});
const chunk = (Array.isArray(built) ? built[0].output : built.output).find(
  (item) => item.type === 'chunk' && item.isEntry,
);
assert.ok(chunk);
const { applyExplorationSeed, explorationTopicKey } = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
);
function seed(document, id, revision = 'v1', neighbors = []) {
  const concept = {
    document,
    entity_id: id,
    ref: { state_revision: revision },
  };
  return {
    concept,
    concepts: [concept, ...neighbors],
    edges: [{ key: `${document}:${id}` }],
  };
}
const key = (row) =>
  JSON.stringify([row.concept.document, row.concept.entity_id]);

await test('더블클릭 이동은 한 주제의 중심만 바꾸며 다른 문서 주제를 보존한다', () => {
  const a = seed('one.md', 'a');
  const other = seed('two.md', 'same');
  const b = seed('one.md', 'b');
  const result = applyExplorationSeed([a, other], b, key(a));
  assert.deepEqual(result.map(key), [key(b), key(other)]);
  assert.equal(result[1], other);
  assert.deepEqual(a.edges, [{ key: 'one.md:a' }]);
});
await test('명시적 지도 추가만 주제를 늘리고 같은 개체는 중복 추가하지 않는다', () => {
  const a = seed('one.md', 'a');
  const b = seed('one.md', 'b');
  const added = applyExplorationSeed([a], b);
  assert.equal(added.length, 2);
  assert.equal(applyExplorationSeed(added, b).length, 2);
  assert.equal(applyExplorationSeed(added, seed('two.md', 'b')).length, 3);
});
await test('삭제한 이동 출발점은 늦은 결과로 되살리지 않고 다른 판본을 섞지 않는다', () => {
  const other = seed('two.md', 'other');
  const a = seed('one.md', 'a');
  const b = seed('one.md', 'b', 'v2');
  const unchanged = [other];
  assert.equal(applyExplorationSeed(unchanged, b, key(a)), unchanged);
  assert.deepEqual(applyExplorationSeed([a, other], b, key(a)).map(key), [
    key(b),
    key(other),
  ]);
  assert.deepEqual(applyExplorationSeed([a, other], b).map(key), [
    key(other),
    key(b),
  ]);
});

await test('무관한 전역 초점 대신 대상 이웃을 실제로 읽은 주제를 선택한다', () => {
  const target = seed('one.md', 'neighbor');
  const connected = seed('one.md', 'topic', 'v1', [target.concept]);
  const unrelated = seed('two.md', 'focus');
  assert.equal(
    explorationTopicKey([unrelated, connected], key(target), key(unrelated)),
    key(connected),
  );
});

await test('여러 주제가 같은 이웃을 읽었으면 실제로 읽는 선호 주제를 유지한다', () => {
  const target = seed('one.md', 'neighbor');
  const first = seed('one.md', 'first', 'v1', [target.concept]);
  const preferred = seed('one.md', 'preferred', 'v1', [target.concept]);
  assert.equal(
    explorationTopicKey([first, preferred], key(target), key(preferred)),
    key(preferred),
  );
  assert.equal(
    explorationTopicKey([first, preferred], key(target), null),
    key(first),
  );
});

await test('대상이 명시 시작점이면 이웃을 포함한 선호 주제보다 그 시작점이 우선한다', () => {
  const target = seed('one.md', 'target');
  const preferred = seed('one.md', 'preferred', 'v1', [target.concept]);
  assert.equal(
    explorationTopicKey([preferred, target], key(target), key(preferred)),
    key(target),
  );
});

await test('동명 다른 문서와 아직 읽지 않은 개체는 이동 주제로 추측하지 않는다', () => {
  const loaded = seed('one.md', 'same');
  const topic = seed('one.md', 'topic', 'v1', [loaded.concept]);
  assert.equal(
    explorationTopicKey([topic], key(seed('two.md', 'same')), key(topic)),
    null,
  );
  assert.equal(
    explorationTopicKey([topic], key(seed('one.md', 'missing')), key(topic)),
    null,
  );
});

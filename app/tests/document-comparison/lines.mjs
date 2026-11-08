import assert from 'node:assert/strict';
import {
  compareLines,
  inlineChange,
} from '../../src/renderer/shared/lib/lineComparison.ts';
const cases = [
  ['', ''],
  ['', '추가\n'],
  ['삭제\n', ''],
  ['a\na\nb\n', 'a\nb\na\n'],
  [' a \n\t\n', 'a\n \n'],
  ['a\r\nb\r\n', 'a\nb\n'],
  ['a\n', 'a'],
  ['한글👩‍💻 첫 문장\n', '한글👩‍💻 둘째 문장\n'],
  ['\n', ''],
  ['x\r', 'x\n'],
  ['한'.repeat(100000), '한'.repeat(99999) + '글'],
  [
    Array.from({ length: 10000 }, (_, i) => `${i}\n`).join(''),
    Array.from(
      { length: 10000 },
      (_, i) => `${i === 5000 ? '수정' : i}\n`,
    ).join(''),
  ],
  ['반복\n'.repeat(1000) + '끝', '새 반복\n'.repeat(1000) + '끝'],
];
let seed = 17;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed;
}
const alphabet = ['a', 'b', ' ', '\t', '한', '😀', '\r', '\n'];
for (let n = 0; n < 300; n++)
  cases.push(
    [0, 1].map(() =>
      Array.from(
        { length: random() % 80 },
        () => alphabet[random() % alphabet.length],
      ).join(''),
    ),
  );
for (const [left, right] of cases) {
  const result = compareLines(left, right);
  assert.equal(
    result.rows
      .map((row) => (row.before ? row.before.text + row.before.ending : ''))
      .join(''),
    left,
  );
  assert.equal(
    result.rows
      .map((row) => (row.after ? row.after.text + row.after.ending : ''))
      .join(''),
    right,
  );
  assert.equal(result.changes.length === 0, left === right);
  for (const row of result.rows)
    if (row.kind === 'equal')
      assert.equal(
        row.before.text + row.before.ending,
        row.after.text + row.after.ending,
      );
}
assert.deepEqual(inlineChange('한😀글', '한😎글'), ['한', '😀', '글']);
assert.equal(compareLines(cases[11][0], cases[11][1]).changes.length, 1);
assert.ok(compareLines(cases[12][0], cases[12][1]).coarse);
console.log(
  `PASS ${cases.length} exact reconstruction cases, Unicode inline span, localized 10,000-line change, bounded fallback`,
);

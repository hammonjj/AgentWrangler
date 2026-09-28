'use strict';
const assert = require('node:assert/strict');
const { length, contains, overlaps, merge } = require('../src/range');

const cases = [
  () => assert.equal(length({ start: 1, end: 1 }), 1),
  () => assert.equal(length({ start: 3, end: 7 }), 5),
  () => assert.equal(contains({ start: 1, end: 5 }, 1), true),
  () => assert.equal(contains({ start: 1, end: 5 }, 6), false),
  () => assert.equal(overlaps({ start: 1, end: 3 }, { start: 3, end: 5 }), true),
  () => assert.equal(overlaps({ start: 1, end: 2 }, { start: 4, end: 5 }), false),
  () => assert.deepEqual(merge([{ start: 1, end: 10 }, { start: 2, end: 3 }]), [{ start: 1, end: 10 }]),
  () => assert.deepEqual(merge([{ start: 5, end: 6 }, { start: 1, end: 2 }]), [{ start: 1, end: 2 }, { start: 5, end: 6 }]),
];

let failed = 0;
cases.forEach((run, i) => {
  try {
    run();
  } catch (e) {
    failed++;
    console.log(`case ${i + 1} failed: ${String(e.message).split('\n')[0]}`);
  }
});
if (failed > 0) {
  console.log(`${failed} of ${cases.length} cases failed`);
  process.exit(1);
}
console.log('ok');

'use strict';
const assert = require('node:assert/strict');
const { LruCache } = require('../src/cache');

const cases = [
  () => {
    const c = new LruCache(2);
    c.set('a', 1);
    c.set('b', 2);
    assert.equal(c.size, 2);
    assert.equal(c.get('a'), 1);
  },
  () => {
    const c = new LruCache(2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    assert.equal(c.get('b'), undefined, 'b was least recently used');
    assert.equal(c.get('a'), 1);
  },
  () => {
    const c = new LruCache(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 10);
    c.set('c', 3);
    assert.equal(c.get('b'), undefined, 'rewriting a made b the oldest');
    assert.equal(c.get('a'), 10);
  },
  () => {
    const c = new LruCache(1);
    c.set('a', 1);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('missing'), undefined);
  },
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

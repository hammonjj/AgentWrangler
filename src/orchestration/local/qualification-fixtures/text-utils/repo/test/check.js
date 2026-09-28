'use strict';
const assert = require('node:assert/strict');
const { capitalize, slugify, truncate, wordCount } = require('../src/text');

const cases = [
  () => assert.equal(capitalize('hello'), 'Hello'),
  () => assert.equal(capitalize(''), ''),
  () => assert.equal(slugify('  Hello, World!  '), 'hello-world'),
  () => assert.equal(slugify('a--b'), 'a-b'),
  () => assert.equal(truncate('abc', 3), 'abc'),
  () => assert.equal(truncate('abcdef', 4), 'abc…'),
  () => assert.equal(wordCount(''), 0),
  () => assert.equal(wordCount('  two   words '), 2),
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

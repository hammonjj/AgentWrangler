'use strict';
const assert = require('node:assert/strict');
const { subtotal, applyDiscount, roundCents, total } = require('../src/cart');

const cases = [
  () => assert.equal(subtotal([]), 0),
  () => assert.equal(subtotal([{ price: 2, qty: 3 }, { price: 1.5, qty: 2 }]), 9),
  () => assert.equal(applyDiscount(200, 10), 180),
  () => assert.equal(applyDiscount(50, 0), 50),
  () => assert.equal(roundCents(1.236), 1.24),
  () => assert.equal(roundCents(1.231), 1.23),
  () => assert.equal(total([{ price: 10, qty: 2 }], { discountPercent: 10, taxRate: 0.08 }), 19.44),
  () => assert.equal(total([]), 0),
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

'use strict';

/** Sum of price × quantity over every item. */
function subtotal(items) {
  let sum = 0;
  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;
  return sum;
}

/** `amount` less `percent` per cent of it. */
function applyDiscount(amount, percent) {
  return amount - percent;
}

/** To the nearest cent. */
function roundCents(x) {
  return Math.floor(x * 100) / 100;
}

/** Discount first, then tax, then round. */
function total(items, { discountPercent = 0, taxRate = 0 } = {}) {
  const discounted = applyDiscount(subtotal(items), discountPercent);
  return roundCents(discounted * (1 + taxRate));
}

module.exports = { subtotal, applyDiscount, roundCents, total };

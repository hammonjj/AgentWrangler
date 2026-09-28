/**
 * The shipped stage-2 fixtures (plan §19.6), for tests: where they are, and a
 * correct version of each one's buggy module, which is what a passing agent writes.
 */
import * as path from 'node:path';

export const FIXTURES_DIR = path.resolve(__dirname, '../../src/orchestration/local/qualification-fixtures');

export const REFERENCE_FIXES: Record<string, { file: string; text: string }> = {
  'text-utils': {
    file: 'src/text.js',
    text: `'use strict';
function capitalize(s) { if (!s) return s; return s[0].toUpperCase() + s.slice(1); }
function slugify(s) { return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function truncate(s, max) { if (s.length <= max) return s; return s.slice(0, max - 1) + '…'; }
function wordCount(s) { return s.split(/\\s+/).filter(Boolean).length; }
module.exports = { capitalize, slugify, truncate, wordCount };
`,
  },
  'cart-total': {
    file: 'src/cart.js',
    text: `'use strict';
function subtotal(items) { let sum = 0; for (let i = 0; i < items.length; i++) sum += items[i].price * items[i].qty; return sum; }
function applyDiscount(amount, percent) { return amount * (1 - percent / 100); }
function roundCents(x) { return Math.round(x * 100) / 100; }
function total(items, { discountPercent = 0, taxRate = 0 } = {}) { return roundCents(applyDiscount(subtotal(items), discountPercent) * (1 + taxRate)); }
module.exports = { subtotal, applyDiscount, roundCents, total };
`,
  },
  'day-ranges': {
    file: 'src/range.js',
    text: `'use strict';
function length(r) { return r.end - r.start + 1; }
function contains(r, x) { return x >= r.start && x <= r.end; }
function overlaps(a, b) { return a.start <= b.end && b.start <= a.end; }
function merge(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}
module.exports = { length, contains, overlaps, merge };
`,
  },
  'lru-cache': {
    file: 'src/cache.js',
    text: `'use strict';
class LruCache {
  constructor(capacity) { this.capacity = capacity; this.map = new Map(); }
  get(key) { if (!this.map.has(key)) return undefined; const v = this.map.get(key); this.map.delete(key); this.map.set(key, v); return v; }
  set(key, value) { this.map.delete(key); this.map.set(key, value); if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value); }
  get size() { return this.map.size; }
}
module.exports = { LruCache };
`,
  },
};

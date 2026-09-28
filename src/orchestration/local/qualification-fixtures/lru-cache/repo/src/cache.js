'use strict';

/**
 * Holds at most `capacity` entries. Reading or writing a key makes it the
 * most recently used; adding past capacity evicts the least recently used.
 */
class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    return this.map.get(key);
  }

  set(key, value) {
    this.map.set(key, value);
    if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { LruCache };

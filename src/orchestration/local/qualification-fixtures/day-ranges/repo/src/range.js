'use strict';

// A range is { start, end } in whole days, and both ends are included.

/** How many days the range covers. */
function length(r) {
  return r.end - r.start;
}

/** Whether day `x` is in the range. */
function contains(r, x) {
  return x > r.start && x <= r.end;
}

/** Whether the two ranges share at least one day. */
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** The ranges sorted by start, with overlapping ones merged. The input is not changed. */
function merge(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = r.end;
    else out.push({ ...r });
  }
  return out;
}

module.exports = { length, contains, overlaps, merge };

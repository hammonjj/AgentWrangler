/**
 * What a raw SDK message looks like on the wire from host to core.
 *
 * Unchanged, except for one thing: large base64 image data is dropped. The
 * core only counts images (the pane shows "1 image", never the pixels), and a
 * multi-megabyte line is a multi-second `JSON.parse` on Electron's main thread
 * (spike S3: 2-3 s for 16 MiB). This is the "not inlining large images" choice
 * the playbook left to Stage 3 (§9.7). The transcript keeps the real image.
 *
 * Pure.
 */

/** Base64 image data longer than this is replaced on the wire. */
export const MAX_INLINE_IMAGE_CHARS = 32 * 1024;

/**
 * A copy of `msg` with oversized base64 image data replaced by `""` and an
 * `omittedBytes` count. Returns `msg` itself (no copy) when nothing needed dropping.
 */
export function slimForWire(msg: unknown): unknown {
  return slim(msg, 0);
}

function slim(value: unknown, depth: number): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = slim(v, depth + 1);
      if (s !== v) changed = true;
      return s;
    });
    return changed ? out : value;
  }
  const obj = value as Record<string, unknown>;
  const source = obj.source as { type?: unknown; data?: unknown } | undefined;
  if (
    obj.type === 'image' &&
    source &&
    typeof source === 'object' &&
    source.type === 'base64' &&
    typeof source.data === 'string' &&
    source.data.length > MAX_INLINE_IMAGE_CHARS
  ) {
    return { ...obj, source: { ...source, data: '', omittedBytes: source.data.length } };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const s = slim(v, depth + 1);
    if (s !== v) changed = true;
    out[k] = s;
  }
  return changed ? out : value;
}

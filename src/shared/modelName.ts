/**
 * Display names for Claude model ids.
 *
 * Transcripts carry the wire id (`claude-opus-5`, `claude-haiku-4-5-20251001`,
 * and on Bedrock/Vertex a prefixed form), which is far too long for a table
 * column. The column shows "Opus 5"; the cell's tooltip keeps the raw id, so
 * nothing is lost when the shortening guesses wrong.
 *
 * Imported by the webview — no `vscode`, Node or DOM here.
 */

/** Model families we know how to shorten. Anything else falls through unchanged. */
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'mythos'] as const;

/**
 * Strip everything around the part that names the model: the provider prefix
 * (`us.anthropic.`, `anthropic/`), the `claude-` marker, a training date, a
 * Bedrock `-v1:0`, a context-window suffix like `[1m]`, and `-latest`.
 *
 * Returns undefined for ids that name no model at all: Claude Code stamps
 * `<synthetic>` on messages it generated itself (interrupts, local errors), and
 * showing that as this session's model would be a lie.
 */
export function normalizeModelId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  let s = id.trim().toLowerCase();
  if (s.length === 0 || s.startsWith('<')) return undefined;

  const at = s.indexOf('claude-');
  if (at >= 0) s = s.slice(at + 'claude-'.length);

  s = s
    .replace(/\[[^\]]*\]/g, '') // [1m] — a context window, not a model
    .replace(/-v\d+(?::\d+)?$/, '') // Bedrock revision
    .replace(/:\d+$/, '')
    .replace(/-\d{6,8}$/, '') // training date
    .replace(/-(latest|preview|v\d+)$/, '')
    .replace(/-+$/, '');

  return s.length === 0 ? undefined : s;
}

/** A filesystem path: POSIX absolute or `~/`, a Windows drive (`C:\` or `C:/`), or a UNC share. */
const LOCAL_PATH = /^(?:\/|~[\\/]|[a-z]:[\\/]|\\\\)/i;

/**
 * The model's own name from a local filesystem path, with an optional
 * `local:` prefix: `/Users/x/Models/Qwen3.5-4B-MLX-4bit` → `Qwen3.5-4B-MLX-4bit`.
 *
 * Only the last path segment is kept, and its case and variant/quantization
 * are left alone. Anything that is not a path (hosted ids like `gpt-4o`,
 * `anthropic/claude-sonnet-5`, `org/model` repo ids, URLs) returns undefined so
 * the caller's normal rules apply. Two models in different directories share a
 * label; the full path stays in the tooltip, which is what tells them apart.
 */
export function localModelName(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  let s = id.trim();
  if (s.toLowerCase().startsWith('local:')) s = s.slice('local:'.length).trim();
  if (!LOCAL_PATH.test(s)) return undefined;
  const segments = s.split(/[\\/]+/).filter((p) => p.length > 0);
  const last = segments.at(-1);
  // A bare `/` or `C:\` names nothing; leave it to show as itself.
  return last === undefined || /^[a-z]:$/i.test(last) ? undefined : last;
}

/**
 * "Opus 5", "Fable 5.1", "Haiku 4.5" — family first, version after, however the
 * id happened to order them (`claude-3-5-sonnet` and `claude-sonnet-5` both
 * occur). An id we don't recognise is returned trimmed rather than dropped: a
 * new model should show up as itself, not as a blank cell.
 */
export function modelLabel(id: string | undefined): string | undefined {
  const local = localModelName(id);
  if (local !== undefined) return local;
  const cleaned = normalizeModelId(id);
  if (cleaned === undefined) return undefined;

  const parts = cleaned.split(/[-.]/).filter((p) => p.length > 0);
  const family = parts.find((p) => (FAMILIES as readonly string[]).includes(p));
  if (family === undefined) return cleaned;

  const version = parts.filter((p) => /^\d+$/.test(p)).join('.');
  const name = family[0].toUpperCase() + family.slice(1);
  return version.length > 0 ? `${name} ${version}` : name;
}

/**
 * How one row of the model dropdown is labelled.
 *
 * The CLI names its default row "Default (recommended)", which spends a
 * parenthesis on advice and never says *which* model default currently means —
 * the one thing the row is asked. It does report the id the alias resolves to,
 * so the parenthetical becomes that: "Default (Sonnet 4.5)".
 *
 * Only a "(recommended)" tail is rewritten. Every other row already names its
 * model, and appending the resolved id there would read "Opus (Opus 4.5)".
 */
export function modelChoiceLabel(displayName: string, resolved?: string): string {
  const label = displayName.trim();
  const m = /^(.*?)\s*\(\s*recommended\s*\)$/i.exec(label);
  if (!m) return label;
  const base = m[1].trim() || label;
  const name = modelLabel(resolved);
  return name === undefined ? base : `${base} (${name})`;
}

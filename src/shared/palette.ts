/**
 * The quick-pick list's rows and filtering: what the in-page modal
 * (`modalModel.ts`) draws for `pick`. Named for the palette window that
 * first drew it, which went with Electron (#142).
 *
 * Rows are answered by index, never by value: see `shellProtocol.ts`.
 */

/** One row, flattened to the three strings the list draws. */
export interface PaletteRow {
  label: string;
  description?: string;
  detail?: string;
}

/**
 * VSCode renders `$(bell)` as a codicon; nothing else has that font, so the
 * source would show through as literal text. Stripped rather than mapped: the
 * icons in the session picker duplicate a status the row already spells out in
 * its description, so nothing is lost by dropping them.
 */
export function stripCodicons(label: string): string {
  return label.replace(/\$\([a-z0-9-]+\)/gi, '').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a row matches what has been typed.
 *
 * Subsequence, not substring: "bsf" finds "BulkSource-frontend", which is the
 * behaviour a palette is judged on and the one VSCode's has. Case-insensitive,
 * and the haystack widens to the description and detail only when the caller
 * said it should — a folder picker matching on its own path is useful, a
 * session picker matching on the word "waiting" is noise.
 */
export function paletteMatches(
  row: PaletteRow,
  query: string,
  opts: { matchOnDescription?: boolean; matchOnDetail?: boolean } = {},
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    stripCodicons(row.label),
    opts.matchOnDescription ? row.description ?? '' : '',
    opts.matchOnDetail ? row.detail ?? '' : '',
  ]
    .join(' ')
    .toLowerCase();

  let at = 0;
  for (const ch of needle) {
    if (ch === ' ') continue;
    at = haystack.indexOf(ch, at);
    if (at === -1) return false;
    at++;
  }
  return true;
}

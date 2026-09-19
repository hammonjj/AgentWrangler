/**
 * The palette's wire protocol — the app's replacement for `showQuickPick` and
 * `showInputBox`.
 *
 * Two shapes in one window because they are one interaction with a list that
 * may be empty: a filter field with rows under it, or a field on its own. The
 * host asks for one, the window answers once, and it closes.
 *
 * **Rows are answered by index, never by value.** Every caller of `pick` reads
 * fields off the object it passed in — `key` on a session row, `dir` and
 * `browse` on a folder row — and those never cross the wire. The window is
 * given labels to draw and returns which one was chosen; the host maps that
 * back to the original object. Sending the objects instead would mean either
 * shipping session keys into a renderer that has no business with them, or
 * reconstructing them from a label, which two sessions can share.
 */

/** One row, flattened to the three strings the window draws. */
export interface PaletteRow {
  label: string;
  description?: string;
  detail?: string;
}

/** What the host asks the window to put up. */
export type PaletteRequest =
  | {
      kind: 'pick';
      placeholder?: string;
      rows: PaletteRow[];
      /** Whether typing also filters on `description` / `detail`, as VSCode's does. */
      matchOnDescription?: boolean;
      matchOnDetail?: boolean;
    }
  | {
      kind: 'input';
      title?: string;
      prompt?: string;
      value?: string;
      placeholder?: string;
      /** Whether the host wants to be asked to check each keystroke. */
      validates?: boolean;
    };

export type HostToPalette =
  | { type: 'show'; request: PaletteRequest }
  /** The answer to a `validate`, or a clear when `message` is absent. */
  | { type: 'validation'; message?: string };

export type PaletteToHost =
  /** Rendered and ready; the host replies with `show`. */
  | { type: 'ready' }
  /** A row was chosen, by its index in the `rows` that were sent. */
  | { type: 'picked'; index: number }
  | { type: 'submitted'; value: string }
  /** Escape, or the window closed. The host resolves this as `undefined`. */
  | { type: 'cancelled' }
  /** Only sent when the request set `validates`. */
  | { type: 'validate'; value: string };

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

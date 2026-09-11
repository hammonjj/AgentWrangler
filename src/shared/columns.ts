/**
 * The dashboard's column set: which columns exist, how wide they start, and the
 * shape of the user's saved choices.
 *
 * Three columns are not in here because they are not the user's to configure:
 * the status dot, the Agent column (the session itself, and the elastic one
 * that absorbs every width change), and the trailing action buttons.
 *
 * Imported by both the webview and the extension host — no `vscode`, Node or
 * DOM here. The host owns persistence (`core/columnPrefs`), the webview owns
 * dragging and the picker menu.
 */

export type ColumnId = 'proj' | 'worktree' | 'branch' | 'model' | 'pr' | 'eta' | 'age';

export interface ColumnDef {
  id: ColumnId;
  /** Header text, and the label in the picker menu. */
  label: string;
  /** Header tooltip. */
  title?: string;
  /** Width in px until the user drags it. */
  defaultWidth: number;
  /** Never drag narrower than this: below it the header text is unreadable. */
  minWidth: number;
  /**
   * Folded away automatically in a narrow dock, where the row's second line
   * carries the same facts inline. The user's own choice still applies — this
   * only ever hides more, never less.
   */
  foldsWhenNarrow?: boolean;
}

export const COLUMNS: readonly ColumnDef[] = [
  { id: 'proj', label: 'Project', defaultWidth: 150, minWidth: 56, foldsWhenNarrow: true },
  {
    id: 'worktree',
    label: 'Worktree',
    title: 'The linked git worktree the session is working in. Blank in a main checkout.',
    defaultWidth: 130,
    minWidth: 56,
    foldsWhenNarrow: true,
  },
  { id: 'branch', label: 'Branch', defaultWidth: 120, minWidth: 56, foldsWhenNarrow: true },
  {
    id: 'model',
    label: 'Model',
    title: 'The model that wrote the most recent reply in this session.',
    defaultWidth: 86,
    minWidth: 48,
    foldsWhenNarrow: true,
  },
  { id: 'pr', label: 'PR', defaultWidth: 56, minWidth: 40, foldsWhenNarrow: true },
  {
    id: 'eta',
    label: 'ETA',
    title:
      'Estimated completion: when most of your past turns of this length were done. Not a prediction of this one.',
    defaultWidth: 52,
    minWidth: 40,
  },
  { id: 'age', label: 'Age', defaultWidth: 48, minWidth: 36 },
];

/** Below this webview width the folding columns give way to the row's second line. */
export const NARROW_PX = 720;

/** The Agent column never drags below this; it is the one that has to stay readable. */
export const MIN_AGENT_WIDTH = 110;

/** Nothing useful is that wide, and a stored 1e9 would push every other column off-screen. */
export const MAX_COLUMN_WIDTH = 800;

/** What the user changed: which columns they hid, and any widths they dragged. */
export interface ColumnPrefs {
  hidden?: ColumnId[];
  widths?: Partial<Record<ColumnId, number>>;
}

const BY_ID = new Map<ColumnId, ColumnDef>(COLUMNS.map((c) => [c.id, c]));

export function columnDef(id: ColumnId): ColumnDef | undefined {
  return BY_ID.get(id);
}

export function isColumnId(v: unknown): v is ColumnId {
  return typeof v === 'string' && BY_ID.has(v as ColumnId);
}

export function isHidden(prefs: ColumnPrefs | undefined, id: ColumnId): boolean {
  return prefs?.hidden?.includes(id) === true;
}

/** Stored width for a column, clamped to what the column can actually take. */
export function columnWidth(prefs: ColumnPrefs | undefined, def: ColumnDef): number {
  const saved = prefs?.widths?.[def.id];
  if (typeof saved !== 'number' || !Number.isFinite(saved)) return def.defaultWidth;
  return Math.min(MAX_COLUMN_WIDTH, Math.max(def.minWidth, Math.round(saved)));
}

/** Columns to render, in table order: the user's choice, minus what a narrow dock folds away. */
export function visibleColumns(prefs: ColumnPrefs | undefined, narrow: boolean): ColumnDef[] {
  return COLUMNS.filter((c) => !isHidden(prefs, c.id) && !(narrow && c.foldsWhenNarrow));
}

export function withHidden(prefs: ColumnPrefs, id: ColumnId, hidden: boolean): ColumnPrefs {
  const set = new Set(prefs.hidden ?? []);
  if (hidden) set.add(id);
  else set.delete(id);
  return { ...prefs, hidden: [...set] };
}

export function withWidths(prefs: ColumnPrefs, widths: Partial<Record<ColumnId, number>>): ColumnPrefs {
  return { ...prefs, widths: { ...prefs.widths, ...widths } };
}

/** Drop every saved width, keeping the hidden set. */
export function withDefaultWidths(prefs: ColumnPrefs): ColumnPrefs {
  return { ...prefs, widths: {} };
}

export interface ResizeBounds {
  /** Width of the column being dragged, when the drag started. */
  startWidth: number;
  /** That column's floor. */
  minWidth: number;
  /**
   * Pixels the elastic Agent column can still give up — its current width minus
   * `MIN_AGENT_WIDTH`, never below 0. It is the only column that moves in
   * sympathy, so it is the only limit on growing this one.
   */
  slack: number;
}

/**
 * The width a drag lands on. A drag resizes exactly ONE column: the handle sits
 * on the column's left edge, so dragging left grows it and dragging right
 * shrinks it, and the elastic Agent column takes the difference. Every other
 * column keeps the width it had.
 *
 * `delta` is pointer travel in px, positive rightwards, so the new width is
 * `startWidth - delta` — clamped by this column's floor, the global ceiling,
 * and how much the Agent column has left to give.
 *
 * Pure, because the arithmetic is the only part of resizing worth testing — the
 * rest is pointer events.
 */
export function clampResizeWidth(delta: number, b: ResizeBounds): number {
  // Never wider than the global cap or than Agent has left to give — with no
  // slack the column can only shrink. The column's own floor wins if the two
  // ever conflict, since a table too cramped to hold it is already broken.
  const widest = Math.max(b.minWidth, Math.min(MAX_COLUMN_WIDTH, b.startWidth + Math.max(0, b.slack)));
  return Math.round(Math.min(widest, Math.max(b.minWidth, b.startWidth - delta)));
}

/**
 * Coerce whatever came out of storage (or in from the webview) into prefs the
 * table can render. Both are foreign input: globalState survives downgrades and
 * hand edits, and a stored width of `null` or a column id that no longer exists
 * must not take the dashboard down with it.
 */
export function sanitizeColumnPrefs(raw: unknown): ColumnPrefs {
  // Always the same shape, junk in or not: the service compares serialized
  // prefs to decide whether anything changed, and `{}` vs `{hidden:[]}` would
  // read as a change on every startup.
  const obj: { hidden?: unknown; widths?: unknown } =
    typeof raw === 'object' && raw !== null ? (raw as { hidden?: unknown; widths?: unknown }) : {};

  const hidden = Array.isArray(obj.hidden) ? [...new Set(obj.hidden.filter(isColumnId))] : [];

  const widths: Partial<Record<ColumnId, number>> = {};
  if (typeof obj.widths === 'object' && obj.widths !== null) {
    for (const [k, v] of Object.entries(obj.widths as Record<string, unknown>)) {
      if (!isColumnId(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
      const def = BY_ID.get(k)!;
      widths[k] = Math.min(MAX_COLUMN_WIDTH, Math.max(def.minWidth, Math.round(v)));
    }
  }
  return { hidden, widths };
}

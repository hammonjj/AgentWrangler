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

export type ColumnId = 'proj' | 'branch' | 'model' | 'pr' | 'eta' | 'age';

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
  /** Width of the column right of the divider, when the drag started. */
  startWidth: number;
  /** Width of the column left of it, when the drag started. */
  startPrevWidth: number;
  minWidth: number;
  minPrevWidth: number;
  /**
   * The left-hand neighbour is the elastic Agent column. It has a floor, but no
   * ceiling and no stored width: it simply takes whatever the others leave.
   */
  prevIsElastic: boolean;
}

/**
 * How far a divider may actually travel, given both columns' floors and the
 * ceiling. Positive is rightwards: the left column grows, the right one shrinks
 * by the same amount, which is what keeps every other divider still and the
 * dragged one under the pointer.
 *
 * Pure, because the arithmetic is the only part of resizing worth testing — the
 * rest is pointer events.
 */
export function clampResizeDelta(delta: number, b: ResizeBounds): number {
  const lo = Math.max(b.minPrevWidth - b.startPrevWidth, b.startWidth - MAX_COLUMN_WIDTH);
  let hi = b.startWidth - b.minWidth;
  if (!b.prevIsElastic) hi = Math.min(hi, MAX_COLUMN_WIDTH - b.startPrevWidth);
  // A window too narrow to satisfy both floors: refuse to move rather than
  // honouring one of them by breaking the other.
  if (hi < lo) return 0;
  return Math.min(hi, Math.max(lo, delta));
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

/**
 * Sessions the user wants kept in front of them, in a section pinned to the top
 * of the dashboard.
 *
 * The exact opposite of `ArchiveService`, and deliberately its mirror image:
 * both answer "where does this row go", both are stored globally because they
 * are about the session rather than about one window, and the two are mutually
 * exclusive — wanting something out of the way and at the top at once is not a
 * state worth being able to reach, so setting either clears the other.
 *
 * "Global" here means one stored list rather than one per window; it is not a
 * live channel between windows. A pin made elsewhere shows up when this window
 * next reads — so writes apply a single change to freshly-read storage instead
 * of saving this window's whole list, which would silently drop it.
 *
 * Order is remembered, unlike every other section. The rest of the table sorts
 * by recency, which is right when the question is "what moved"; a pinned
 * section that reorders itself every time an agent writes a line would defeat
 * the point of pinning, which is knowing where to look. Pins therefore stay
 * where they were put, oldest first, and a new pin joins the bottom.
 */

import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';

const STORAGE_KEY = 'agentWrangler.pinnedKeys';

interface PinRecord {
  key: string;
  /** ms epoch the pin was made — the sort key for the section. */
  atMs: number;
}

export class PinService {
  private pins: PinRecord[];
  private emitter = new Emitter<void>();

  constructor(private storage: KeyValueStorage) {
    this.pins = this.read();
  }

  /**
   * Tolerant on purpose: this runs during `activate()`, and a throw here would
   * take the whole extension down over a preference. Anything that is not a
   * list of records is treated as no pins.
   */
  private read(): PinRecord[] {
    const raw = this.storage.get<unknown>(STORAGE_KEY, []);
    return Array.isArray(raw) ? raw.filter(isRecord) : [];
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  isPinned(key: string): boolean {
    return this.pins.some((p) => p.key === key);
  }

  /** When it was pinned, for the section's sort. Undefined when it is not. */
  pinnedAt(key: string): number | undefined {
    return this.pins.find((p) => p.key === key)?.atMs;
  }

  get count(): number {
    return this.pins.length;
  }

  set(key: string, pinned: boolean): void {
    if (pinned === this.isPinned(key)) return;
    // Apply this one change to what storage says *now*, rather than writing our
    // own list back whole. The in-memory copy was taken when this window
    // started, so writing it back would undo everything another window has
    // pinned since — the "a second window neither sees nor preserves these
    // records" failure that made a persisted paused-set the wrong design.
    // Pausing could fall back on the OS for its truth; this cannot, so the
    // narrowest possible write is the protection.
    //
    // Only the delta is applied, deliberately: unioning our list in as well
    // would resurrect pins another window had removed, and storage already
    // holds everything this window has ever written.
    const merged = new Map(this.read().map((p) => [p.key, p]));
    if (pinned) merged.set(key, { key, atMs: Date.now() });
    else merged.delete(key);
    this.pins = [...merged.values()].sort((a, b) => a.atMs - b.atMs);
    void this.storage.update(STORAGE_KEY, this.pins);
    this.emitter.fire();
  }

  toggle(key: string): void {
    this.set(key, !this.isPinned(key));
  }
}

function isRecord(r: unknown): r is PinRecord {
  const o = r as PinRecord | undefined;
  return typeof o?.key === 'string' && typeof o.atMs === 'number';
}

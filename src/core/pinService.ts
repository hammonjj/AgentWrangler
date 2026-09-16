/**
 * Sessions the user wants kept in front of them, in a section pinned to the top
 * of the dashboard.
 *
 * The exact opposite of `ArchiveService`, and deliberately its mirror image:
 * both answer "where does this row go", both are global state because they are
 * about the session rather than about one window, and the two are mutually
 * exclusive — wanting something out of the way and at the top at once is not a
 * state worth being able to reach, so setting either clears the other.
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
    this.pins = storage.get<PinRecord[]>(STORAGE_KEY, []).filter(isRecord);
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
    this.pins = pinned ? [...this.pins, { key, atMs: Date.now() }] : this.pins.filter((p) => p.key !== key);
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

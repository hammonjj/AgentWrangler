import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';

/**
 * A set of folder paths kept in global state — the shape both of the launcher
 * dropdown's curations (removed folders, starred folders) take.
 *
 * Global state, like the column layout and for the same reason: which folders
 * are worth offering is a preference about the machine, not about one window,
 * and a per-webview set would have each dashboard curating its own list.
 */
export class StoredDirSet {
  private dirs: Set<string>;
  private emitter = new Emitter<void>();

  constructor(
    private storage: KeyValueStorage,
    private key: string,
  ) {
    this.dirs = new Set(storage.get<string[]>(key, []).filter((d) => typeof d === 'string'));
  }

  /** Fires only on a real change, so two dashboards echoing one click do not loop. */
  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get value(): ReadonlySet<string> {
    return this.dirs;
  }

  protected add(dir: string): void {
    if (this.dirs.has(dir)) return;
    this.dirs.add(dir);
    this.save();
  }

  protected delete(dir: string): void {
    if (!this.dirs.delete(dir)) return;
    this.save();
  }

  private save(): void {
    void this.storage.update(this.key, [...this.dirs]);
    this.emitter.fire();
  }
}

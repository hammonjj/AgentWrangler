import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';

const STORAGE_KEY = 'agentWrangler.hiddenProjects';

/**
 * Folders the user has taken out of the launcher's dropdown.
 *
 * A removal has to be recorded rather than acted on, because the list is not
 * ours to edit: it is rebuilt on every scan from `~/.claude.json`, which still
 * contains the folder and which we have no business writing to. So the entry
 * stays where it is and this set hides it.
 *
 * Global state, like the column layout and for the same reason: which folders
 * are worth offering is a preference about the machine, not about one window,
 * and a per-webview set would have each dashboard curating its own list.
 */
export class HiddenProjectsService {
  private dirs: Set<string>;
  private emitter = new Emitter<void>();

  constructor(private storage: KeyValueStorage) {
    this.dirs = new Set(storage.get<string[]>(STORAGE_KEY, []).filter((d) => typeof d === 'string'));
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get value(): ReadonlySet<string> {
    return this.dirs;
  }

  hide(dir: string): void {
    if (this.dirs.has(dir)) return;
    this.dirs.add(dir);
    this.save();
  }

  /** Browsing back to a folder is how it comes back; nothing else un-hides one. */
  unhide(dir: string): void {
    if (!this.dirs.delete(dir)) return;
    this.save();
  }

  private save(): void {
    void this.storage.update(STORAGE_KEY, [...this.dirs]);
    this.emitter.fire();
  }
}

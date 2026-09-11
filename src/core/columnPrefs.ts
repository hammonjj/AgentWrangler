import { sanitizeColumnPrefs, type ColumnPrefs } from '../shared/columns';
import { Emitter, type Disposable, type Listener } from './events';
import type { KeyValueStorage } from './archive';

const STORAGE_KEY = 'agentWrangler.columnPrefs';

/**
 * The user's column layout — widths they dragged, columns they hid — kept in
 * global state rather than webview state.
 *
 * Webview state would have been less code, but it is per-webview: the editor
 * tab and the bottom-panel dock would each have remembered a different layout,
 * and neither would have survived being closed and reopened. A column layout is
 * a preference, so it lives where preferences live and every dashboard in every
 * window shows the same one.
 */
export class ColumnPrefsService {
  private prefs: ColumnPrefs;
  private emitter = new Emitter<void>();

  constructor(private storage: KeyValueStorage) {
    this.prefs = sanitizeColumnPrefs(storage.get<unknown>(STORAGE_KEY, {}));
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get value(): ColumnPrefs {
    return this.prefs;
  }

  /** Store a layout from the webview. Ignores a no-op so one dashboard's snapshot doesn't loop. */
  set(next: unknown): void {
    const clean = sanitizeColumnPrefs(next);
    if (JSON.stringify(clean) === JSON.stringify(this.prefs)) return;
    this.prefs = clean;
    void this.storage.update(STORAGE_KEY, clean);
    this.emitter.fire();
  }
}

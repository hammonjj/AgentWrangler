import { Emitter, type Disposable, type Listener } from './events';

/** Structural subset of vscode.Memento so this stays vscode-free and testable. */
export interface KeyValueStorage {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): unknown;
}

const STORAGE_KEY = 'agentWrangler.archivedKeys';

/**
 * Persisted set of archived session keys. Archived sessions render in a
 * always-last "Archived" status section and are excluded from the status bar count
 * and waiting toasts.
 */
export class ArchiveService {
  private keys: Set<string>;
  private emitter = new Emitter<void>();

  constructor(private storage: KeyValueStorage) {
    this.keys = new Set(storage.get<string[]>(STORAGE_KEY, []));
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  isArchived(key: string): boolean {
    return this.keys.has(key);
  }

  toggle(key: string): void {
    this.set(key, !this.isArchived(key));
  }

  /**
   * Explicit form, for the caller that has to clear this without knowing the
   * current value — pinning a row has to unarchive it, since wanting something
   * out of the way and at the top at once is not a state worth reaching.
   */
  set(key: string, archived: boolean): void {
    if (archived === this.keys.has(key)) return;
    if (archived) this.keys.add(key);
    else this.keys.delete(key);
    void this.storage.update(STORAGE_KEY, [...this.keys]);
    this.emitter.fire();
  }
}

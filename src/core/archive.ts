import { Emitter, type Disposable, type Listener } from './events';

/** Structural subset of vscode.Memento so this stays vscode-free and testable. */
export interface KeyValueStorage {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): unknown;
}

const STORAGE_KEY = 'agentWrangler.archivedKeys';

/**
 * Persisted set of archived session keys. Archived sessions render in a
 * pinned-last "Archived" section and are excluded from the status bar count
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
    if (!this.keys.delete(key)) this.keys.add(key);
    void this.storage.update(STORAGE_KEY, [...this.keys]);
    this.emitter.fire();
  }
}

import type { KeyValueStorage } from './archive';
import { StoredDirSet } from './storedDirSet';

const STORAGE_KEY = 'agentWrangler.hiddenProjects';

/**
 * Folders the user has taken out of the launcher's dropdown.
 *
 * A removal has to be recorded rather than acted on, because the list is not
 * ours to edit: it is rebuilt on every scan from `~/.claude.json`, which still
 * contains the folder and which we have no business writing to. So the entry
 * stays where it is and this set hides it.
 */
export class HiddenProjectsService extends StoredDirSet {
  constructor(storage: KeyValueStorage) {
    super(storage, STORAGE_KEY);
  }

  hide(dir: string): void {
    this.add(dir);
  }

  /** Browsing back to a folder is how it comes back; nothing else un-hides one. */
  unhide(dir: string): void {
    this.delete(dir);
  }
}

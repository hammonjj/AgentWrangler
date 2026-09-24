import type { KeyValueStorage } from './archive';
import { StoredDirSet } from './storedDirSet';

const STORAGE_KEY = 'agentWrangler.favouriteProjects';

/**
 * Folders the user starred in the launcher's dropdown, which lead the list.
 *
 * Kept by path even while a folder is missing from disk: the scan drops a
 * missing folder before favourites are applied, so a stale entry is never
 * offered, and a checkout that comes back comes back starred.
 */
export class FavouriteProjectsService extends StoredDirSet {
  constructor(storage: KeyValueStorage) {
    super(storage, STORAGE_KEY);
  }

  favourite(dir: string): void {
    this.add(dir);
  }

  unfavourite(dir: string): void {
    this.delete(dir);
  }
}

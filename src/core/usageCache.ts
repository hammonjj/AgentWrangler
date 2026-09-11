/**
 * The last good usage read, shared by every VSCode window on this machine.
 *
 * Each window runs its own extension host and therefore its own poller. Left
 * alone, N windows meant N requests a minute — and a reload meant N requests
 * inside a second, which the usage endpoint answered with HTTP 429. With the
 * cache, a window that finds a read fresher than the poll interval on disk
 * uses it and asks Claude nothing; one window's read serves them all.
 *
 * File-based rather than in-process on purpose: it lives in the extension's
 * globalStorage, the one place every window already shares (the cross-window
 * relay lives there too).
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { UsageSnapshot } from '../shared/usage';

export interface UsageCache {
  read(): Promise<UsageSnapshot | undefined>;
  write(snapshot: UsageSnapshot): Promise<void>;
}

export class FileUsageCache implements UsageCache {
  constructor(private file: string) {}

  async read(): Promise<UsageSnapshot | undefined> {
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      const snap = JSON.parse(text) as UsageSnapshot;
      if (typeof snap?.fetchedAtMs !== 'number' || !Array.isArray(snap.windows)) return undefined;
      return snap;
    } catch {
      return undefined;
    }
  }

  async write(snapshot: UsageSnapshot): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      // Write-then-rename so a reader never sees half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(snapshot), 'utf8');
      await fsp.rename(tmp, this.file);
    } catch {
      // A cache miss later is the whole cost of a failed write.
    }
  }
}

/** For tests, and for a host with no writable storage. */
export class MemoryUsageCache implements UsageCache {
  private snap?: UsageSnapshot;
  async read(): Promise<UsageSnapshot | undefined> {
    return this.snap;
  }
  async write(snapshot: UsageSnapshot): Promise<void> {
    this.snap = snapshot;
  }
}

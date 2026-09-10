import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInThisWorkspace } from './workspace';

interface RelayNote {
  sessionId: string;
  cwd: string;
  createdAt: number;
}

/** A note is actionable this long — covers a brand-new window activating. */
const NOTE_FRESH_MS = 30_000;
/** Anything older than this is litter and gets deleted on sight. */
const NOTE_STALE_MS = 5 * 60_000;

/**
 * Cross-window "open this session" relay.
 *
 * Agent Wrangler runs in every VSCode window; all instances share one mailbox
 * directory (extension globalStorage). Clicking a session owned by another
 * window writes a note file and focuses that window via the `code` CLI
 * (opening an already-open folder focuses its window; an unopened folder gets
 * a fresh window, whose instance then finds the note on activation). The
 * instance whose workspace contains the note's cwd claims the note and opens
 * the session in its Claude panel.
 */
export class CrossWindowRelay implements vscode.Disposable {
  private watcher?: fs.FSWatcher;
  private processed = new Set<string>();
  private scanning = false;
  private disposed = false;

  constructor(
    private dir: string,
    private onOpenRequest: (sessionId: string) => void,
    private log: (msg: string) => void,
  ) {}

  async start(): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
    } catch (err) {
      this.log(`relay: cannot create mailbox dir ${this.dir}: ${String(err)}`);
      return;
    }
    await this.scan(); // notes written while this window was still starting
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, () => void this.scan());
      this.watcher.on('error', (err) => {
        this.log(`relay: mailbox watcher error: ${String(err)}`);
        this.watcher = undefined;
      });
    } catch (err) {
      this.log(`relay: cannot watch mailbox dir: ${String(err)}`);
    }
  }

  /** Ask the window owning `cwd` to open the session, and bring it to front. */
  async request(sessionId: string, cwd: string): Promise<void> {
    const note: RelayNote = { sessionId, cwd, createdAt: Date.now() };
    const name = `open-${note.createdAt}-${Math.random().toString(36).slice(2, 8)}.json`;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      // tmp + rename so readers never see a partial write
      const tmp = path.join(this.dir, `.tmp-${name}`);
      await fsp.writeFile(tmp, JSON.stringify(note), 'utf8');
      await fsp.rename(tmp, path.join(this.dir, name));
    } catch (err) {
      this.log(`relay: failed to write note: ${String(err)}`);
    }
    this.focusWindow(cwd);
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.disposed) return;
    this.scanning = true;
    try {
      let names: string[];
      try {
        names = await fsp.readdir(this.dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.startsWith('open-') || !name.endsWith('.json') || this.processed.has(name)) continue;
        this.processed.add(name);
        const file = path.join(this.dir, name);

        let note: RelayNote | undefined;
        try {
          note = JSON.parse(await fsp.readFile(file, 'utf8')) as RelayNote;
        } catch {
          continue; // unreadable/claimed by another window
        }
        if (!note || typeof note.sessionId !== 'string' || typeof note.cwd !== 'string') {
          void fsp.unlink(file).catch(() => undefined);
          continue;
        }
        const age = Date.now() - (note.createdAt ?? 0);
        if (age > NOTE_STALE_MS) {
          void fsp.unlink(file).catch(() => undefined);
          continue;
        }
        if (age > NOTE_FRESH_MS) continue; // expired; cleanup later
        if (!isInThisWorkspace(note.cwd)) continue; // addressed to a different window

        void fsp.unlink(file).catch(() => undefined); // claim
        this.log(`relay: opening session ${note.sessionId} (requested from another window)`);
        this.onOpenRequest(note.sessionId);
      }
    } finally {
      this.scanning = false;
    }
  }

  private focusWindow(cwd: string): void {
    // VSCode's own CLI ships inside the app: focuses the window that has the
    // folder open (or opens a new window for it, which then claims the note).
    const cli = path.join(vscode.env.appRoot, 'bin', 'code');
    cp.execFile(cli, [cwd], { timeout: 10_000 }, (err) => {
      if (err) this.log(`relay: could not focus window for ${cwd}: ${String(err)}`);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
  }
}

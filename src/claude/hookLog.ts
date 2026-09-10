/**
 * Watches the hook event logs and maintains authoritative per-session state.
 *
 * Layout: `<claudeHome>/agentwrangler/<pid>.jsonl`, one file per Claude process.
 * The sharding is a correctness requirement, not tidiness. `cat >>` is atomic
 * only while the payload fits in one write(): measured on macOS, 30 concurrent
 * appends stay intact at 20 KB each, but at 64 KB 6 of 30 lines are corrupted
 * and at 128 KB most are. A hook payload carries `tool_input`, so writing a
 * ~64 KB file blows straight through that — sharded, the same test is clean at
 * 1 MB.
 *
 * `$PPID` in the hook shell is the Claude process, which is also the registry's
 * key. Session identity still comes from `session_id` inside each payload, so a
 * wrong or shared pid costs only file granularity, never correctness.
 *
 * Reading follows the pattern established by the transcript viewer: the
 * format-agnostic primitives from `transcriptTail` (`readRange`,
 * `splitCompleteLines`) plus a per-file byte offset, restarting when a file
 * shrinks. Deliberately NOT routed through `readTranscriptSummary`, whose state
 * record fuses offset bookkeeping with Claude transcript domain fields.
 */
import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Emitter, type Disposable } from '../core/events';
import { parseHookLine, reduceHookEvent, type HookSessionState } from './hookEvents';
import { claudeHome } from './paths';
import { isPidAlive } from './registry';
import { MAX_CHUNK_BYTES, readRange, splitCompleteLines, TAIL_CHUNK_BYTES } from './transcriptTail';

const FILE_DEBOUNCE_MS = 120;
const LOG_FILE_RE = /^(\d+)\.jsonl$/;

/** `<claudeHome>/agentwrangler` — baked into the installed hook command as an absolute path. */
export function hookLogDir(): string {
  return path.join(claudeHome(), 'agentwrangler');
}

interface FileCursor {
  byteOffset: number;
  sizeBytes: number;
}

export class HookLog implements Disposable {
  private states = new Map<string, HookSessionState>();
  private cursors = new Map<string, FileCursor>();
  private changeEmitter = new Emitter<void>();
  private turnEmitter = new Emitter<number>();
  private watcher?: fsSync.FSWatcher;
  private timers = new Map<string, NodeJS.Timeout>();
  private dir: string;
  private started = false;
  private disposed = false;
  /** Receipt time of the newest event across all sessions — proves hooks are live. */
  private lastEventAtMs = 0;

  constructor(
    private log: (msg: string) => void = () => undefined,
    dir?: string,
  ) {
    this.dir = dir ?? hookLogDir();
  }

  onDidChange = (listener: () => void): Disposable => this.changeEmitter.event(listener);

  /** Fires with the working duration (ms) of each turn observed reaching Stop. */
  onTurnCompleted = (listener: (durationMs: number) => void): Disposable => this.turnEmitter.event(listener);

  /** Authoritative state for a session id (lowercased), if hooks have reported it. */
  get(sessionId: string): HookSessionState | undefined {
    return this.states.get(sessionId.toLowerCase());
  }

  /** True once any hook event has ever been read — used to detect silently disabled hooks. */
  get hasEverReported(): boolean {
    return this.lastEventAtMs > 0;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.scanAll();
    this.ensureWatcher();
  }

  /** Re-read every log file from its cursor. Cheap: unchanged files are skipped by size. */
  async scanAll(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return; // dir absent until hooks are installed
    }
    let changed = false;
    for (const name of names) {
      if (!LOG_FILE_RE.test(name)) continue;
      if (await this.readFile(path.join(this.dir, name))) changed = true;
    }
    if (changed) this.changeEmitter.fire();
  }

  /** Recreate the watcher if the directory has appeared or the watch died. */
  ensureWatcher(): void {
    if (this.disposed || this.watcher) return;
    try {
      this.watcher = fsSync.watch(this.dir, { persistent: false }, (_event, filename) => {
        if (filename) this.onFileEvent(filename.toString());
      });
      this.watcher.on('error', (err) => {
        this.log(`hook log watcher error: ${String(err)}`);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Directory doesn't exist yet; the provider's poll retries.
    }
  }

  private onFileEvent(filename: string): void {
    if (!LOG_FILE_RE.test(filename)) return;
    const full = path.join(this.dir, filename);
    const existing = this.timers.get(full);
    if (existing) clearTimeout(existing);
    this.timers.set(
      full,
      setTimeout(() => {
        this.timers.delete(full);
        void this.readFile(full).then((changed) => {
          if (changed) this.changeEmitter.fire();
        });
      }, FILE_DEBOUNCE_MS),
    );
  }

  /** Read appended bytes and fold them into session state. Returns true if anything changed. */
  private async readFile(filePath: string): Promise<boolean> {
    let size: number;
    try {
      const st = await fsp.stat(filePath);
      if (!st.isFile()) return false;
      size = st.size;
    } catch {
      this.cursors.delete(filePath);
      return false;
    }

    const prev = this.cursors.get(filePath);
    // Rotation/truncation: the file shrank below where we were reading.
    const rewritten = prev !== undefined && size < prev.byteOffset;
    const from = rewritten || prev === undefined ? Math.max(0, size - TAIL_CHUNK_BYTES) : prev.byteOffset;
    const startsMidLine = from > 0 && (rewritten || prev === undefined);
    // Catching up on a file we've never read: these events already happened, and
    // all of them get this instant as their receipt time.
    const backlog = prev === undefined;

    if (!rewritten && prev !== undefined && size === prev.sizeBytes) return false;
    if (size === 0) {
      this.cursors.set(filePath, { byteOffset: 0, sizeBytes: 0 });
      return false;
    }

    const end = Math.min(size, from + MAX_CHUNK_BYTES);
    const buf = await readRange(filePath, from, end);
    if (!buf) return false;

    const { lines, endOffset } = splitCompleteLines(buf, startsMidLine);
    this.cursors.set(filePath, { byteOffset: from + endOffset, sizeBytes: size });

    const now = Date.now();
    const completedTurns: number[] = [];
    let changed = false;
    for (const line of lines) {
      const event = parseHookLine(line, now);
      if (!event) continue; // torn write, subagent, or served: call
      const before = this.states.get(event.sessionId);
      const after = reduceHookEvent(before, event);
      // `lastTurnMs` only changes on the event that ends a turn. Backlog turns
      // all measure ~0 against a shared receipt time — never baseline data.
      if (!backlog && after.lastTurnMs !== undefined && after.lastTurnMs !== before?.lastTurnMs) {
        completedTurns.push(after.lastTurnMs);
      }
      // A turn whose start we only inferred from the backlog has an unknowable
      // age; flagged here so nothing downstream renders it as elapsed time.
      if (backlog && after.turnStartedAtMs !== undefined) after.turnStartUncertain = true;
      this.states.set(event.sessionId, after);
      this.lastEventAtMs = now;
      changed = true;
    }
    // Fired after the pass so a listener always sees fully-applied state.
    for (const ms of completedTurns) this.turnEmitter.fire(ms);
    return changed;
  }

  /**
   * Drop logs for processes that are gone and whose last write is outside the
   * ended window, plus their in-memory state. Called from the provider's poll.
   */
  async prune(endedWindowMs: number): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - endedWindowMs;
    for (const name of names) {
      const m = LOG_FILE_RE.exec(name);
      if (!m) continue;
      const pid = Number(m[1]);
      if (isPidAlive(pid)) continue;
      const full = path.join(this.dir, name);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs >= cutoff) continue;
        await fsp.unlink(full);
        this.cursors.delete(full);
        this.log(`hook log pruned: ${name}`);
      } catch {
        // gone already, or not ours to delete
      }
    }
    for (const [id, st] of this.states) {
      if (st.lastEventAtMs < cutoff) this.states.delete(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.watcher?.close();
    this.changeEmitter.dispose();
    this.turnEmitter.dispose();
    this.states.clear();
    this.cursors.clear();
  }
}

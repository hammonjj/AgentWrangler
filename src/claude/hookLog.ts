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
import type { PermissionSuggestion } from './permissionDetail';
import { isPidAlive } from './registry';
import { MAX_CHUNK_BYTES, readRange, splitCompleteLines, TAIL_CHUNK_BYTES } from './transcriptTail';

const FILE_DEBOUNCE_MS = 120;
const LOG_FILE_RE = /^(\d+)\.jsonl$/;
/** `<claudePid>-<hookShellPid>`, as the PermissionRequest hook script names its marker. */
const REQUEST_ID_RE = /^\d+-\d+$/;

/** `<claudeHome>/agentwrangler` — baked into the installed hook command as an absolute path. */
export function hookLogDir(): string {
  return path.join(claudeHome(), 'agentwrangler');
}

/**
 * What answering a prompt from the dashboard does. `always` is `allow` plus the
 * permission rules Claude Code's own "don't ask again" would have added.
 */
export type PermissionBehavior = 'allow' | 'deny' | 'always';

/**
 * What the PermissionRequest hook script prints for Claude Code to read as its
 * decision. The shape is Claude Code's: `decision` must be `{behavior: "allow"}`
 * or `{behavior: "deny", message}`, and an allow may carry `updatedPermissions`
 * — the `permission_suggestions` from the payload, handed straight back. Claude
 * Code applies those to the session and persists them where each says.
 */
export function permissionDecisionJson(
  behavior: PermissionBehavior,
  suggestions: PermissionSuggestion[] = [],
): string {
  const decision =
    behavior === 'deny'
      ? { behavior: 'deny', message: 'Denied from the Agent Wrangler dashboard.' }
      : behavior === 'always' && suggestions.length > 0
        ? { behavior: 'allow', updatedPermissions: suggestions }
        : { behavior: 'allow' };
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })}\n`;
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

  // ---- permission decisions ----

  private requestMarker(id: string): string {
    return path.join(this.dir, 'requests', id);
  }

  /**
   * True while the hook script for this prompt is still polling. The marker is
   * the script's own liveness flag: it removes it when it exits, and we remove
   * it (see `readFile`) the moment the log shows the prompt was answered.
   */
  pendingRequestExists(id: string | undefined): boolean {
    if (!id || !REQUEST_ID_RE.test(id)) return false;
    return fsSync.existsSync(this.requestMarker(id));
  }

  /**
   * Answer a session's open permission prompt from outside Claude Code. Writes
   * the decision file the hook script is polling for (tmp + rename, so the
   * script never reads a partial file). Returns false when there is nothing to
   * answer: no open prompt, or its script has already exited.
   *
   * The state is not flipped to busy here. Claude Code races the hook against
   * its own dialog, so this decision may lose to an answer given there; the
   * events that follow (PreToolUse / PermissionDenied) say what actually
   * happened. Only the marker id is cleared, so the buttons go away at once.
   */
  async decide(sessionId: string, behavior: PermissionBehavior): Promise<boolean> {
    const st = this.states.get(sessionId.toLowerCase());
    const id = st?.permissionRequestId;
    if (!st || !id || !this.pendingRequestExists(id)) return false;

    const target = path.join(this.dir, 'decisions', `${id}.json`);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(`${target}.tmp`, permissionDecisionJson(behavior, st.permissionSuggestions), 'utf8');
      await fsp.rename(`${target}.tmp`, target);
    } catch (err) {
      this.log(`permission decision write failed: ${String(err)}`);
      return false;
    }
    this.states.set(st.sessionId, { ...st, permissionRequestId: undefined });
    this.changeEmitter.fire();
    return true;
  }

  /** The prompt is over (answered, superseded, or the turn moved on): release the script. */
  private releaseRequest(id: string): void {
    if (!REQUEST_ID_RE.test(id)) return;
    fsp.unlink(this.requestMarker(id)).catch(() => undefined); // already gone is fine
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
      // The prompt this marker belonged to is no longer open: tell its hook
      // script to stop waiting, so it does not sit in the process table until
      // its ceiling.
      const openId = before?.permissionRequestId;
      if (openId !== undefined && after.permissionRequestId !== openId) this.releaseRequest(openId);
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

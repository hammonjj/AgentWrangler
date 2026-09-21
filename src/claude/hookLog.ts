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
 *
 * Every window reads these files independently, and a hook payload carries no
 * timestamp of its own, so an event's receipt time is whenever *this* extension
 * host read the line. Two consequences follow: a window that has just started
 * stamps the whole backlog with one instant (hence `turnStartUncertain`), and a
 * window that stops reading a file cannot tell that apart from a session going
 * quiet. `readFile` must therefore always read to the end of what it stat'd.
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
   * `expectedRequestId` is the prompt the caller believes it is answering, and
   * it is what stops a decision landing on the wrong one. A button is rendered
   * from a snapshot; by the time it is pressed the session may have answered
   * that prompt and opened another, and without this check the click would
   * allow the *replacement*. The id here is the authoritative one — it comes
   * from the event stream, not from a snapshot — so this is the right place for
   * the guard. Callers that genuinely mean "whatever is open" may omit it.
   *
   * The state is not flipped to busy here. Claude Code races the hook against
   * its own dialog, so this decision may lose to an answer given there; the
   * events that follow (PreToolUse / PermissionDenied) say what actually
   * happened. Only the marker id is cleared, so the buttons go away at once.
   */
  async decide(
    sessionId: string,
    behavior: PermissionBehavior,
    expectedRequestId?: string,
  ): Promise<boolean> {
    const st = this.states.get(sessionId.toLowerCase());
    const id = st?.permissionRequestId;
    if (!st || !id || !this.pendingRequestExists(id)) return false;
    if (expectedRequestId !== undefined && id !== expectedRequestId) return false;

    const target = path.join(this.dir, 'decisions', `${id}.json`);
    // Pid-qualified, exactly as FileUsageCache does it: two windows answering
    // one prompt would otherwise interleave their writes into a single temp
    // path and then both rename it, handing the hook script a torn file.
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(tmp, permissionDecisionJson(behavior, st.permissionSuggestions), 'utf8');
      await fsp.rename(tmp, target);
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

  /**
   * Read appended bytes and fold them into session state. Returns true if
   * anything changed.
   *
   * Reads in chunks of at most `MAX_CHUNK_BYTES` and keeps going until the
   * cursor reaches the size we stat'd, because `sizeBytes` is the
   * skip-if-unchanged guard and may only claim what was actually consumed.
   * Recording the whole size after a capped read makes the next pass skip the
   * file until it grows again, so a window that ever fell a chunk behind on a
   * busy log froze there — and a frozen cursor reads as silence, which is how a
   * live session ends up in *Possibly stuck* in one window and `busy` in the
   * one next to it.
   */
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
    // Catching up on a file we've never read: these events already happened, and
    // all of them get this instant as their receipt time.
    const backlog = prev === undefined;

    if (!rewritten && prev !== undefined && size === prev.sizeBytes) return false;
    if (size === 0) {
      this.cursors.set(filePath, { byteOffset: 0, sizeBytes: 0 });
      return false;
    }

    let offset = rewritten || backlog ? Math.max(0, size - TAIL_CHUNK_BYTES) : prev.byteOffset;
    let startsMidLine = offset > 0 && (rewritten || backlog);

    const completedTurns: number[] = [];
    let changed = false;
    let aborted = false;

    while (offset < size) {
      const end = Math.min(size, offset + MAX_CHUNK_BYTES);
      const buf = await readRange(filePath, offset, end);
      // Read failed, or the file shrank under us: leave the cursor where it is
      // and let the next pass (which will see the new size) sort it out.
      if (!buf || buf.length === 0) {
        aborted = true;
        break;
      }

      const { lines, endOffset } = splitCompleteLines(buf, startsMidLine);
      if (endOffset === 0) {
        // No line boundary in this chunk. At EOF that is the writer mid-line, so
        // wait for the rest of it. Short of EOF it is one payload bigger than a
        // whole chunk, which can never be assembled here: skip past it rather
        // than wedge the cursor on it for the life of the window.
        if (end >= size) break;
        this.log(`hook log: skipping a line over ${MAX_CHUNK_BYTES} bytes in ${path.basename(filePath)}`);
        offset = end;
        startsMidLine = true;
        this.cursors.set(filePath, { byteOffset: offset, sizeBytes: offset });
        continue;
      }

      offset += endOffset;
      startsMidLine = false;
      // Only what has been consumed, so an abort below still re-reads the rest.
      this.cursors.set(filePath, { byteOffset: offset, sizeBytes: offset });
      if (this.applyLines(lines, backlog, completedTurns)) changed = true;
    }

    // Caught up (or parked on an incomplete trailing line): everything up to
    // `size` has now been examined, so an unchanged file can be skipped.
    if (!aborted) this.cursors.set(filePath, { byteOffset: offset, sizeBytes: size });

    // Fired after the pass so a listener always sees fully-applied state.
    for (const ms of completedTurns) this.turnEmitter.fire(ms);
    return changed;
  }

  /**
   * Fold one chunk's worth of lines into session state, collecting the turns
   * that finished. Returns true if any line counted.
   */
  private applyLines(lines: string[], backlog: boolean, completedTurns: number[]): boolean {
    const now = Date.now();
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

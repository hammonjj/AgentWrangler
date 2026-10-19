/**
 * The core's side of exclusive resource leases (#68): policy, not the lock.
 *
 * Design: `docs/plans/spikes/f2-resource-leases.md`. The lock of record is a
 * lease directory beside `lease-hook.sh`, so the hook grants and refuses while
 * the core is down. This service:
 *
 * - declares the resources (`leases.resources`, switched on by
 *   `leases.enabled`) by compiling them to `resources.tsv`, the one file the
 *   hook reads; off, the file is empty and every tool call takes the hook's
 *   fast path;
 * - lets the orchestration scheduler hold a lease for an attempt before its
 *   session exists (`acquire`, never waiting), and `bind` it to the session
 *   once it does (ask A5);
 * - reaps leases whose holder is gone: a dead or reused pid, a session the
 *   registry says has ended, an attempt orchestration no longer runs, or an
 *   attempt lease never bound by its `bindBy`;
 * - force-releases a lease and cancels a wait (#69 puts these on the table).
 *
 * Synchronous file work throughout: a handful of tiny files, touched when an
 * attempt starts or ends, and every few seconds by the reaper.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Disposable } from '../events';
import {
  DEFAULT_BIND_BY_MS,
  DEFAULT_LEASE_RESOURCES,
  QUALIFIER_LENGTH,
  compileResourcesTsv,
  labelOf,
  parseLeaseResources,
  qualifiedKey,
  type AcquireResult,
  type Lease,
  type LeaseHolder,
  type LeaseKeyBy,
  type LeaseResource,
} from '../../shared/leases';
import {
  ABANDONED_MS,
  HOLDER_FILE,
  REAP_LOCK_STALE_MS,
  formatHolder,
  leaseOf,
  leaseSlug,
  parseHolder,
  reapReason,
  sameHolder,
  type HolderFile,
  type ReapContext,
  type ReapReason,
} from './leaseFiles';

export type ReleaseWhy = 'holder' | 'session-ended' | 'stale' | 'forced' | ReapReason;

export interface LeaseService {
  /** Resources as declared and switched on; empty while leases are off. */
  resources(): LeaseResource[];
  list(): Lease[];
  /**
   * Core-side acquire: never waits. Used by the scheduler before it starts an
   * attempt (holder kind `attempt`, pid the core's own until `bind`). The name
   * is a declared resource's key, or an orchestration lease name such as
   * `unity-editor:Game` (§13.5), which shares the declared `unity-editor`
   * lease when there is one. `cwd` qualifies a per-repository lease.
   */
  acquire(resourceKey: string, holder: LeaseHolder, opts?: { scope?: 'session'; cwd?: string }): AcquireResult;
  /** Who holds the lease `acquire` would take now, if anyone else live does. Reaps a stale one. */
  heldBy(resourceKey: string, opts?: { cwd?: string; except?: LeaseHolder }): Lease | undefined;
  /** A5: the attempt's session exists now. Rewrites the holder's session and pid to the agent's. */
  bind(key: string, attemptId: string, sessionId: string, agentPid?: number): void;
  release(key: string, why: ReleaseWhy): void;
  /** Every lease an attempt holds, when it ends. */
  releaseAttempt(attemptId: string): void;
  /** The user's Release: the holder's running command carries on; its own later release is a no-op. */
  forceRelease(key: string): void;
  /** The user's Stop waiting: the session's waiting hook denies at once. */
  cancelWait(sessionId: string, key?: string): void;
  onDidChange: (listener: () => void) => Disposable;
}

export interface LeaseServiceDeps {
  /** `<hook log dir>/leases`. */
  dir: string;
  /** `leases.enabled` and `leases.resources`, read fresh. */
  settings: () => { enabled: boolean; resources: unknown };
  /** `startTimeOf` from procStart. */
  startTimeOf(pid: number): string | undefined;
  /** `isSameProcessAlive` from procStart. */
  alive(pid: number, pidStart: string | undefined): boolean;
  sessionState: ReapContext['sessionState'];
  /**
   * Orchestration is on, so it will say which attempts still run once it has
   * recovered: until then an attempt's lease is kept, not judged by a pid that
   * may be the last core's.
   */
  holdAttemptLeases?: () => boolean;
  /** The repository a directory belongs to, as the hook names it: `git rev-parse --path-format=absolute --git-common-dir`. */
  gitCommonDir?(cwd: string): string | undefined;
  now?: () => number;
  pid?: number;
  log?: (line: string) => void;
}

/** What the hook computes for a `repo`/`cwd` lease: the first chars of an md5 (`md5 -qs`). */
export function qualifierFor(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, QUALIFIER_LENGTH);
}

export function gitCommonDirOf(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export class FileLeaseService implements LeaseService {
  private readonly emitter = new Emitter<void>();
  private readonly now: () => number;
  private readonly pid: number;
  private readonly repoDirs = new Map<string, string>();
  private selfStart: string | undefined;
  private lastSignature = '';
  private lastTsv: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Set by orchestration once it can answer; see `ReapContext.attemptActive`. */
  attemptActive: ReapContext['attemptActive'];

  constructor(private readonly deps: LeaseServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.pid = deps.pid ?? process.pid;
  }

  readonly onDidChange = (listener: () => void): Disposable => this.emitter.event(listener);

  /** Compile the resources, reap, and keep doing both every `intervalMs`. */
  start(intervalMs = 5000): void {
    this.syncResources();
    this.reap();
    this.lastSignature = this.signature();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.emitter.dispose();
  }

  /** The reaper's pass, and a change event when anything moved (the hook's acquires and releases included). */
  tick(): void {
    try {
      this.reap();
    } catch (e) {
      this.log(`leases: reap failed: ${String(e)}`);
    }
    this.changed();
  }

  // ---- Resources ----

  declared(): LeaseResource[] {
    const s = this.deps.settings();
    const { resources, errors } = parseLeaseResources(s.resources === undefined ? DEFAULT_LEASE_RESOURCES : s.resources);
    for (const e of errors) this.log(`leases: ${e}`);
    return resources;
  }

  resources(): LeaseResource[] {
    return this.deps.settings().enabled ? this.declared() : [];
  }

  /** Write `resources.tsv` when what it should say changed. Empty while leases are off. */
  syncResources(): void {
    const tsv = compileResourcesTsv(this.resources());
    if (tsv === this.lastTsv && fs.existsSync(this.tsvPath())) return;
    try {
      this.ensureDir();
      const file = this.tsvPath();
      const tmp = `${file}.${this.pid}.tmp`;
      fs.writeFileSync(tmp, tsv, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      this.lastTsv = tsv;
    } catch (e) {
      this.log(`leases: could not write resources.tsv: ${String(e)}`);
    }
  }

  // ---- Leases ----

  list(): Lease[] {
    const out: Lease[] = [];
    for (const key of this.keys()) {
      const h = this.readHolder(key);
      if (h) out.push(leaseOf(key, h));
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  acquire(resourceKey: string, holder: LeaseHolder, opts: { scope?: 'session'; cwd?: string } = {}): AcquireResult {
    const target = this.target(resourceKey, opts.cwd);
    this.ensureDir();
    const dir = this.leaseDir(target.key);
    for (let tries = 0; tries < 3; tries++) {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const cur = this.readHolder(target.key);
        if (cur && sameHolder(leaseOf(target.key, cur).holder, holder)) return { ok: true, lease: leaseOf(target.key, cur) };
        if (this.reapable(target.key, cur)) {
          this.reapLocked(target.key, 'stale');
          continue;
        }
        return { ok: false, heldBy: cur ? leaseOf(target.key, cur) : this.creating(target) };
      }
      const now = this.now();
      const h: HolderFile = {
        v: 1,
        resource: target.resource,
        ...(holder.kind === 'session' ? { sessionId: holder.sessionId } : { attemptId: holder.attemptId, ...(holder.sessionId ? { sessionId: holder.sessionId } : {}) }),
        pid: this.pid,
        ...(this.ownStart() ? { pidStart: this.ownStart() } : {}),
        scope: opts.scope ?? 'session',
        since: now,
        ...(holder.kind === 'attempt' && !holder.sessionId ? { bindBy: now + DEFAULT_BIND_BY_MS } : {}),
        label: target.label,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      };
      this.writeHolder(target.key, h);
      this.log(`leases: ${target.key} acquired by ${describeHolder(holder)}`);
      this.changed();
      return { ok: true, lease: leaseOf(target.key, h) };
    }
    const cur = this.readHolder(target.key);
    return { ok: false, heldBy: cur ? leaseOf(target.key, cur) : this.creating(target) };
  }

  heldBy(resourceKey: string, opts: { cwd?: string; except?: LeaseHolder } = {}): Lease | undefined {
    const target = this.target(resourceKey, opts.cwd);
    if (!fs.existsSync(this.leaseDir(target.key))) return undefined;
    const cur = this.readHolder(target.key);
    if (cur && opts.except && sameHolder(leaseOf(target.key, cur).holder, opts.except)) return undefined;
    if (this.reapable(target.key, cur)) {
      this.reapLocked(target.key, 'stale');
      return fs.existsSync(this.leaseDir(target.key)) ? this.creating(target) : undefined;
    }
    return cur ? leaseOf(target.key, cur) : this.creating(target);
  }

  bind(key: string, attemptId: string, sessionId: string, agentPid?: number): void {
    const cur = this.readHolder(key);
    if (!cur || cur.attemptId !== attemptId) {
      this.log(`leases: ${key} is no longer held by attempt ${attemptId}; its session ${sessionId} runs without it`);
      return;
    }
    const pid = agentPid !== undefined && agentPid > 0 ? agentPid : this.pid;
    const pidStart = pid === this.pid ? this.ownStart() : this.deps.startTimeOf(pid);
    const next: HolderFile = { ...cur, sessionId, pid };
    delete next.bindBy;
    if (pidStart) next.pidStart = pidStart;
    else delete next.pidStart;
    if (next.sessionId === cur.sessionId && next.pid === cur.pid && next.pidStart === cur.pidStart && cur.bindBy === undefined) return;
    this.writeHolder(key, next);
    this.log(`leases: ${key} bound to session ${sessionId}${pid !== this.pid ? ` (pid ${pid})` : ''}`);
    this.changed();
  }

  release(key: string, why: ReleaseWhy): void {
    const dir = this.leaseDir(key);
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    this.log(`leases: ${key} released (${why})`);
    this.changed();
  }

  releaseAttempt(attemptId: string): void {
    for (const key of this.keys()) {
      if (this.readHolder(key)?.attemptId === attemptId) this.release(key, 'holder');
    }
  }

  forceRelease(key: string): void {
    this.release(key, 'forced');
  }

  cancelWait(sessionId: string): void {
    try {
      const dir = path.join(this.deps.dir, 'cancel');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, path.basename(sessionId)), '', { mode: 0o600 });
    } catch (e) {
      this.log(`leases: could not cancel the wait of ${sessionId}: ${String(e)}`);
    }
  }

  /** Release every lease whose holder is gone. Returns what it released. */
  reap(): string[] {
    const out: string[] = [];
    for (const key of this.keys()) {
      const cur = this.readHolder(key);
      const why = cur ? reapReason(cur, this.reapContext()) : this.abandoned(key) ? 'stale' : undefined;
      if (!why) {
        // Kept for a running attempt: say so to the hook, which cannot ask orchestration (`ATTEMPT_HEARTBEAT_MINUTES`).
        if (cur?.attemptId) this.heartbeat(key);
        continue;
      }
      if (this.reapLocked(key, why)) out.push(key);
    }
    this.sweepCancels();
    return out;
  }

  // ---- Internals ----

  private target(resourceKey: string, cwd: string | undefined): { key: string; resource: string; label: string } {
    const base = resourceKey.split(':')[0];
    const declared = this.declared().find((r) => r.key === base);
    const resource = declared ? declared.key : leaseSlug(resourceKey);
    const keyBy: LeaseKeyBy = declared ? declared.keyBy : 'repo';
    return { key: qualifiedKey(resource, this.qualifier(keyBy, cwd)), resource, label: declared ? labelOf(declared) : resourceKey };
  }

  private qualifier(keyBy: LeaseKeyBy, cwd: string | undefined): string | undefined {
    if (keyBy === 'global' || !cwd) return undefined;
    if (keyBy === 'cwd') return qualifierFor(cwd);
    let common = this.repoDirs.get(cwd);
    if (common === undefined) {
      common = (this.deps.gitCommonDir ?? gitCommonDirOf)(cwd) ?? cwd;
      this.repoDirs.set(cwd, common);
    }
    return qualifierFor(common);
  }

  private reapContext(): ReapContext {
    const hold = this.deps.holdAttemptLeases?.() === true;
    return {
      now: this.now(),
      alive: (pid, start) => this.deps.alive(pid, start),
      sessionState: (id) => this.deps.sessionState(id),
      attemptActive: (id) => {
        const active = this.attemptActive?.(id);
        return active === undefined && hold ? true : active;
      },
    };
  }

  private reapable(key: string, cur: HolderFile | undefined): boolean {
    return cur ? reapReason(cur, this.reapContext()) !== undefined : this.abandoned(key);
  }

  /** Under `<key>.reap/`, re-checked there: a lease cannot be replaced while it exists, so the check is not overtaken. */
  private reapLocked(key: string, why: ReleaseWhy): boolean {
    const lock = `${this.leaseDir(key)}.reap`;
    try {
      fs.mkdirSync(lock);
    } catch {
      if (this.olderThan(lock, REAP_LOCK_STALE_MS)) fs.rmSync(lock, { recursive: true, force: true });
      return false;
    }
    try {
      const cur = this.readHolder(key);
      if (!fs.existsSync(this.leaseDir(key)) || !this.reapable(key, cur)) return false;
      this.release(key, why);
      return true;
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }

  /** Wall-clock time, not `now`: the hook compares it with `find -mmin`. */
  private heartbeat(key: string): void {
    const t = new Date();
    try {
      fs.utimesSync(path.join(this.leaseDir(key), HOLDER_FILE), t, t);
    } catch {
      // Released meanwhile.
    }
  }

  private abandoned(key: string): boolean {
    return this.olderThan(this.leaseDir(key), ABANDONED_MS);
  }

  private olderThan(p: string, ms: number): boolean {
    try {
      return this.now() - fs.statSync(p).mtimeMs > ms;
    } catch {
      return false;
    }
  }

  /** A lease whose holder is still being written: held, by someone not yet known. */
  private creating(target: { key: string; resource: string; label: string }): Lease {
    return { key: target.key, resource: target.resource, holder: { kind: 'session', sessionId: '' }, scope: 'command', since: this.now(), label: target.label };
  }

  /** Cancel markers nobody picked up: the wait ended some other way. */
  private sweepCancels(): void {
    const dir = path.join(this.deps.dir, 'cancel');
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      if (this.olderThan(p, ABANDONED_MS)) fs.rmSync(p, { force: true });
    }
  }

  private keys(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.deps.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && e.name !== 'cancel' && !e.name.endsWith('.reap')).map((e) => e.name);
  }

  private readHolder(key: string): HolderFile | undefined {
    try {
      return parseHolder(fs.readFileSync(path.join(this.leaseDir(key), HOLDER_FILE), 'utf8'));
    } catch {
      return undefined;
    }
  }

  private writeHolder(key: string, h: HolderFile): void {
    const file = path.join(this.leaseDir(key), HOLDER_FILE);
    const tmp = `${file}.${this.pid}.tmp`;
    fs.writeFileSync(tmp, formatHolder(h), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private leaseDir(key: string): string {
    return path.join(this.deps.dir, key);
  }

  private tsvPath(): string {
    return path.join(this.deps.dir, 'resources.tsv');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
  }

  private ownStart(): string | undefined {
    if (this.selfStart === undefined) this.selfStart = this.deps.startTimeOf(this.pid) ?? '';
    return this.selfStart || undefined;
  }

  private signature(): string {
    return this.list()
      .map((l) => `${l.key}:${l.holder.kind === 'attempt' ? l.holder.attemptId : ''}:${l.holder.sessionId ?? ''}:${l.since}`)
      .join('|');
  }

  private changed(): void {
    const sig = this.signature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    this.emitter.fire();
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }
}

function describeHolder(h: LeaseHolder): string {
  return h.kind === 'attempt' ? `attempt ${h.attemptId}` : `session ${h.sessionId}`;
}

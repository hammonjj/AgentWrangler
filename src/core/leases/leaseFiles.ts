/**
 * The lease file format and the rules over it (#68), pure.
 *
 * A lease is a directory, `<leases>/<key>/`, whose `mkdir` is the atomic
 * acquire; `holder.json` inside it says who holds it. Both the core and
 * `lease-hook.sh` write it, as one line of JSON. The hook reads it back with a
 * `sed` per field, so the core writes the same flat shape: strings and
 * integers only, `cwd` (the one free-text path) last.
 */
import type { SessionRecordState } from '../session/sessionRegistry';
import { resourceOfKey, type Lease, type LeaseHolder, type LeaseScope } from '../../shared/leases';

export const HOLDER_FILE = 'holder.json';
/** A lease directory with no `holder.json` this long after it was made was abandoned mid-acquire. */
export const ABANDONED_MS = 60_000;
/** A `.reap` lock this old was left by a reaper that died. */
export const REAP_LOCK_STALE_MS = 60_000;

export interface HolderFile {
  v: 1;
  resource: string;
  sessionId?: string;
  attemptId?: string;
  pid: number;
  pidStart?: string;
  scope: LeaseScope;
  since: number;
  /** An attempt lease not bound to a session by then is released. */
  bindBy?: number;
  label?: string;
  cwd?: string;
}

/** One line, keys in the order the hook expects, nothing it cannot read. */
export function formatHolder(h: HolderFile): string {
  const ordered: HolderFile = {
    v: 1,
    resource: h.resource,
    ...(h.sessionId ? { sessionId: h.sessionId } : {}),
    ...(h.attemptId ? { attemptId: h.attemptId } : {}),
    pid: Math.floor(h.pid),
    ...(h.pidStart ? { pidStart: h.pidStart } : {}),
    scope: h.scope,
    since: Math.floor(h.since),
    ...(h.bindBy !== undefined ? { bindBy: Math.floor(h.bindBy) } : {}),
    ...(h.label ? { label: h.label } : {}),
    ...(h.cwd ? { cwd: h.cwd } : {}),
  };
  return `${JSON.stringify(ordered)}\n`;
}

const SCOPES: readonly LeaseScope[] = ['command', 'turn', 'session'];

/** `holder.json` as written by either side; undefined when torn or foreign. */
export function parseHolder(text: string): HolderFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : undefined);
  const pid = num('pid');
  const since = num('since');
  const scope = r.scope as LeaseScope;
  const resource = str('resource');
  if (pid === undefined || since === undefined || !SCOPES.includes(scope) || !resource) return undefined;
  const sessionId = str('sessionId');
  const attemptId = str('attemptId');
  if (!sessionId && !attemptId) return undefined;
  const bindBy = num('bindBy');
  return {
    v: 1,
    resource,
    ...(sessionId ? { sessionId } : {}),
    ...(attemptId ? { attemptId } : {}),
    pid,
    ...(str('pidStart') ? { pidStart: str('pidStart') } : {}),
    scope,
    since,
    ...(bindBy !== undefined ? { bindBy } : {}),
    ...(str('label') ? { label: str('label') } : {}),
    ...(str('cwd') ? { cwd: str('cwd') } : {}),
  };
}

export function holderOf(h: HolderFile): LeaseHolder {
  if (h.attemptId) return { kind: 'attempt', attemptId: h.attemptId, ...(h.sessionId ? { sessionId: h.sessionId } : {}) };
  return { kind: 'session', sessionId: h.sessionId! };
}

export function leaseOf(key: string, h: HolderFile): Lease {
  return {
    key,
    resource: h.resource || resourceOfKey(key),
    holder: holderOf(h),
    scope: h.scope,
    since: h.since,
    pid: h.pid,
    ...(h.pidStart ? { pidStart: h.pidStart } : {}),
    ...(h.cwd ? { cwd: h.cwd } : {}),
    ...(h.label ? { label: h.label } : {}),
  };
}

/** Whether `want` is the holder already named: the same attempt, or the same session. */
export function sameHolder(have: LeaseHolder, want: LeaseHolder): boolean {
  if (have.kind === 'attempt' && want.kind === 'attempt') return have.attemptId === want.attemptId;
  if (have.kind === 'session' && want.kind === 'session') return have.sessionId.toLowerCase() === want.sessionId.toLowerCase();
  return false;
}

export type ReapReason = 'stale' | 'session-ended' | 'unbound' | 'attempt-ended';

/** States after which a session holds nothing (spike: the reaper's registry transitions). */
const ENDED_STATES: readonly SessionRecordState[] = ['stopped', 'ended', 'failed', 'interrupted'];

export interface ReapContext {
  now: number;
  /** Same pid, same start time. */
  alive(pid: number, pidStart: string | undefined): boolean;
  /** What the registry says of a session, and since when; undefined for one AW does not run. */
  sessionState(sessionId: string): { state: SessionRecordState; changedAt?: number } | undefined;
  /**
   * Whether orchestration still runs this attempt; undefined when it cannot
   * say (orchestration off, or not recovered yet). When it can, it decides:
   * an attempt lease outlives the core that took it, and its pid is only
   * the core's until it is bound.
   */
  attemptActive?(attemptId: string): boolean | undefined;
}

/** Why the core may release this lease now, or undefined to keep it. */
export function reapReason(h: HolderFile, ctx: ReapContext): ReapReason | undefined {
  if (h.attemptId) {
    const unbound = !h.sessionId && h.bindBy !== undefined && ctx.now > h.bindBy;
    const active = ctx.attemptActive?.(h.attemptId);
    if (active === false) return 'attempt-ended';
    if (unbound) return 'unbound';
    if (active === true) return undefined;
    return ctx.alive(h.pid, h.pidStart) ? undefined : 'stale';
  }
  // Only an end recorded after the lease was taken: a session resumed outside
  // AW (a terminal `claude --resume`) keeps its last record until AW sees it.
  const rec = h.sessionId ? ctx.sessionState(h.sessionId) : undefined;
  if (rec && ENDED_STATES.includes(rec.state) && rec.changedAt !== undefined && rec.changedAt >= h.since) return 'session-ended';
  return ctx.alive(h.pid, h.pidStart) ? undefined : 'stale';
}

/**
 * A resource name as a lease directory's: the resource key a declared
 * resource uses, or an orchestration lease name (`unity-editor:Game`) folded
 * to `[a-z0-9-]`.
 */
export function leaseSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 64) : 'resource';
}

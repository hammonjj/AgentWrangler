/**
 * Exclusive resource leases (#68): what a resource is, and the rules every
 * side of the lease agrees on. Pure — the core's `LeaseService`, the hook
 * script and the orchestration scheduler all read the same declarations.
 *
 * Design: `docs/plans/spikes/f2-resource-leases.md`. A resource is declared
 * once, as "tool calls that match these patterns need lease K"; a
 * `PreToolUse` hook acquires K before a matching call runs. The lock of record
 * is a lease directory next to the hook script, so it holds while the core is
 * down.
 */

export type LeaseKeyBy = 'global' | 'repo' | 'cwd';
/** `command` and `turn` are granted by the hook; `session` only by the core (the scheduler, A5). */
export type LeaseScope = 'command' | 'turn' | 'session';

export interface LeaseResource {
  /** Stable id: 'aw-app', 'unity-editor'. `[a-z0-9-]+`. */
  key: string;
  /** What needs it. ERE patterns matched anywhere in the tool input as the hook sees it. */
  match: { bash?: string[]; tools?: string[] };
  /** One machine-wide lease, one per repository (every worktree shares it), or one per directory. */
  keyBy: LeaseKeyBy;
  /** 'command': held for the call. 'turn': held until the session's turn ends. */
  scope: 'command' | 'turn';
  /** How long a waiting call waits before it is denied. */
  waitSec?: number;
  /** Shown in deny messages and chips. */
  label?: string;
}

export type LeaseHolder =
  | { kind: 'session'; sessionId: string }
  /** Held by the scheduler for an attempt before its session exists; bound to it afterwards (A5). */
  | { kind: 'attempt'; attemptId: string; sessionId?: string };

export interface Lease {
  /** Qualified: 'unity-editor@3f9a1c0d2b4e', or the bare resource key for `global`. */
  key: string;
  resource: string;
  holder: LeaseHolder;
  scope: LeaseScope;
  /** ms epoch. */
  since: number;
  pid?: number;
  pidStart?: string;
  cwd?: string;
  label?: string;
}

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; heldBy: Lease };

/** The switch: off, no resource is declared to the hook and nothing waits. */
export const LEASES_ENABLED_KEY = 'leases.enabled';
/** The declared resources, a list in `settings.json`; absent means `DEFAULT_LEASE_RESOURCES`. */
export const LEASES_RESOURCES_KEY = 'leases.resources';

export const DEFAULT_WAIT_SEC = 900;
/**
 * The longest any call may wait. The hook's `PreToolUse` timeout is fixed at
 * install time, and a hook killed by its timeout lets the tool run (spike
 * evidence 1), so every wait must end well inside it.
 */
export const MAX_WAIT_SEC = 1700;
/** An attempt lease that never got a session is released after this (spike: `bindBy`). */
export const DEFAULT_BIND_BY_MS = 10 * 60 * 1000;
/** Chars of the md5 used to qualify a `repo`/`cwd` lease. */
export const QUALIFIER_LENGTH = 12;

/**
 * Ships with the setting but does nothing until `leases.enabled` is on (#68):
 * the convention in CLAUDE.md ("only one agent runs `app:install` at a time"),
 * enforced.
 */
export const DEFAULT_LEASE_RESOURCES: LeaseResource[] = [
  {
    key: 'aw-app',
    label: 'the installed app',
    keyBy: 'global',
    scope: 'command',
    waitSec: 600,
    match: { bash: ['npm run app:install', 'install-app\\.sh', 'quit app "Agent Wrangler"'] },
  },
];

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A tab or newline would break a `resources.tsv` row; nothing else is special to it. */
const UNSAFE_FIELD_RE = /[\t\r\n]/;

/**
 * The resources a setting declares, keeping only well-formed ones. Foreign
 * input: whatever someone wrote into `settings.json`. Problems are returned,
 * not thrown, so one bad entry does not switch every lease off.
 */
export function parseLeaseResources(raw: unknown): { resources: LeaseResource[]; errors: string[] } {
  const errors: string[] = [];
  const resources: LeaseResource[] = [];
  if (!Array.isArray(raw)) return { resources, errors: raw === undefined ? [] : ['leases.resources is not a list'] };
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const where = `leases.resources[${i}]`;
    if (!item || typeof item !== 'object') return void errors.push(`${where} is not an object`);
    const r = item as Record<string, unknown>;
    const key = r.key;
    if (typeof key !== 'string' || !KEY_RE.test(key)) return void errors.push(`${where}: key must match [a-z0-9-]+`);
    if (seen.has(key)) return void errors.push(`${where}: key ${key} is declared twice`);
    const keyBy = r.keyBy ?? 'global';
    if (keyBy !== 'global' && keyBy !== 'repo' && keyBy !== 'cwd') return void errors.push(`${where}: keyBy must be global, repo or cwd`);
    const scope = r.scope ?? 'command';
    if (scope !== 'command' && scope !== 'turn') return void errors.push(`${where}: scope must be command or turn`);
    const m = (r.match && typeof r.match === 'object' ? r.match : {}) as Record<string, unknown>;
    const bash = patternList(m.bash);
    const tools = patternList(m.tools);
    if (bash === null || tools === null) return void errors.push(`${where}: match.bash and match.tools must be lists of strings without tabs or newlines`);
    for (const p of [...bash, ...tools]) {
      if (!validRegExp(p)) return void errors.push(`${where}: ${JSON.stringify(p)} is not a valid pattern`);
    }
    const waitSec = r.waitSec;
    if (waitSec !== undefined && (typeof waitSec !== 'number' || !Number.isFinite(waitSec) || waitSec < 0)) {
      return void errors.push(`${where}: waitSec must be a number of seconds`);
    }
    const label = r.label;
    if (label !== undefined && (typeof label !== 'string' || UNSAFE_FIELD_RE.test(label))) return void errors.push(`${where}: label must be one line of text`);
    seen.add(key);
    resources.push({
      key,
      keyBy,
      scope,
      match: { ...(bash.length > 0 ? { bash } : {}), ...(tools.length > 0 ? { tools } : {}) },
      ...(waitSec !== undefined ? { waitSec: Math.min(Math.floor(waitSec), MAX_WAIT_SEC) } : {}),
      ...(label !== undefined && label.trim().length > 0 ? { label: label.trim() } : {}),
    });
  });
  return { resources, errors };
}

function patternList(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const p of v) {
    if (typeof p !== 'string' || p.length === 0 || UNSAFE_FIELD_RE.test(p)) return null;
    out.push(p);
  }
  return out;
}

/** Close enough to an ERE check: what JS rejects, `grep -E` would mostly reject too. */
function validRegExp(p: string): boolean {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}

export function waitSecOf(r: LeaseResource): number {
  return Math.min(r.waitSec ?? DEFAULT_WAIT_SEC, MAX_WAIT_SEC);
}

export function labelOf(r: Pick<LeaseResource, 'key' | 'label'>): string {
  return r.label ?? r.key;
}

/**
 * `resources.tsv`, the one file the hook reads: a row per pattern,
 * `key keyBy scope waitSec kind pattern label`, tab-separated. Empty when
 * leases are off or nothing is declared, which is the hook's fast path.
 * Sorted by key so every session acquires several leases in the same order
 * (no two sessions can each hold one and wait for the other).
 */
export function compileResourcesTsv(resources: readonly LeaseResource[]): string {
  const rows: string[] = [];
  for (const r of [...resources].sort((a, b) => a.key.localeCompare(b.key))) {
    const head = [r.key, r.keyBy, r.scope, String(waitSecOf(r))];
    for (const p of r.match.tools ?? []) rows.push([...head, 'tool', p, labelOf(r)].join('\t'));
    for (const p of r.match.bash ?? []) rows.push([...head, 'bash', p, labelOf(r)].join('\t'));
  }
  return rows.length > 0 ? `${rows.join('\n')}\n` : '';
}

/** The lease directory's name: the resource key, qualified for `repo`/`cwd`. */
export function qualifiedKey(resource: string, qualifier: string | undefined): string {
  return qualifier ? `${resource}@${qualifier}` : resource;
}

/** 'unity-editor@3f9a…' → 'unity-editor'. */
export function resourceOfKey(key: string): string {
  const at = key.indexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/** "for 6 min" style, as the hook's deny message words it. */
export function heldForText(sinceMs: number, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  return min < 1 ? 'for under a minute' : `for ${min} min`;
}

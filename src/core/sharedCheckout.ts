/**
 * "Are two live agents working in one checkout?"
 *
 * Two agents in one checkout share one index and one working tree, so one
 * agent's commit can carry the other's half-finished edits under its own
 * message — the hazard the repo's CLAUDE.md warns about. Separate linked
 * worktrees of the same repo do not share either, so they are fine: the unit
 * is the checkout root (the linked worktree's root, else the main repo's), not
 * the repo.
 *
 * Pure: the caller resolves each session's root, this only groups. Warning
 * only — nothing here stops a launch.
 */
import type { AgentSession } from '../shared/model';

export interface CheckoutEntry {
  key: string;
  /** Checkout root, or undefined when the session is not in git (or its cwd is unknown). */
  root: string | undefined;
  /** What to call it in the other rows' tooltips. */
  label: string;
}

export interface SharedCheckout {
  /** The checkout root the sessions share. */
  root: string;
  /** Labels of the other live sessions in it, never including this one. */
  others: string[];
}

/** `/a/b/` and `/a/b` are one checkout. */
export function normalizeRoot(root: string): string {
  return root.length > 1 ? root.replace(/\/+$/, '') : root;
}

/**
 * Whether a session counts as occupying its checkout right now.
 *
 * A Claude row is `ended` once its process is gone, so anything else is live.
 * A Codex row never ends — its status comes from the rollout, and a thread
 * from last month reads `done` forever — so it counts only while Agent
 * Wrangler is running it or it is visibly mid-turn. An idle external `codex`
 * CLI is missed; that is the price of not flagging every old thread.
 */
export function occupiesCheckout(s: Pick<AgentSession, 'provider' | 'status' | 'runnerOwned'>): boolean {
  if (s.status === 'ended') return false;
  if (s.provider !== 'codex') return true;
  return s.runnerOwned === true || s.status === 'busy' || s.status === 'stuck' || s.status === 'blocked';
}

/**
 * Group live sessions by checkout root. Returns an entry for every session
 * whose checkout has at least one other live session in it; sessions alone in
 * theirs (or outside git) are absent.
 */
export function sharedCheckouts(entries: readonly CheckoutEntry[]): Map<string, SharedCheckout> {
  const byRoot = new Map<string, CheckoutEntry[]>();
  for (const e of entries) {
    if (!e.root) continue;
    const root = normalizeRoot(e.root);
    const group = byRoot.get(root);
    if (group) group.push(e);
    else byRoot.set(root, [e]);
  }
  const out = new Map<string, SharedCheckout>();
  for (const [root, group] of byRoot) {
    if (group.length < 2) continue;
    for (const e of group) {
      out.set(e.key, { root, others: group.filter((o) => o.key !== e.key).map((o) => o.label) });
    }
  }
  return out;
}

/**
 * The live sessions already in the checkout a folder belongs to, for the
 * launcher's "someone is already in here" warning.
 */
export function occupantsOf(root: string | undefined, entries: readonly CheckoutEntry[]): string[] {
  if (!root) return [];
  const want = normalizeRoot(root);
  return entries.filter((e) => e.root && normalizeRoot(e.root) === want).map((e) => e.label);
}

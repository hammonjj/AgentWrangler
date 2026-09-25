/**
 * Mission file versions, and the pure functions that bring an old file up to
 * date on load (`docs/plans/intelligent-orchestration.md` §23.4).
 *
 * - **v0**: the shape the plan first described (2026-09-24), before the #25
 *   gate: no `v`, and `attempt.assignment.sessionId` as one id.
 * - **v1**: `assignment.sessionIds[]`, because a session's id can change
 *   during its life (§7.2), plus `v` and defaults for every list.
 *
 * A migration never throws on a field it does not know; it keeps it.
 */
import type { Mission } from '../../shared/orchestration/types';

export const MISSION_SCHEMA_VERSION = 1;

export class UnreadableMission extends Error {
  constructor(readonly why: string) {
    super(`mission file unreadable: ${why}`);
    this.name = 'UnreadableMission';
  }
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** v0 → v1. */
function fromV0(doc: Json): Json {
  const attempts = list(doc.attempts).map((a) => {
    if (!isObject(a)) return a;
    const assignment = isObject(a.assignment) ? { ...a.assignment } : {};
    if (!Array.isArray(assignment.sessionIds)) {
      const id = assignment.sessionId;
      assignment.sessionIds = typeof id === 'string' && id ? [id] : [];
    }
    delete assignment.sessionId;
    return { ...a, assignment, verification: list(a.verification), flags: isObject(a.flags) ? a.flags : {} };
  });
  return {
    ...doc,
    v: 1,
    policyChanges: list(doc.policyChanges),
    tasks: list(doc.tasks),
    assessments: list(doc.assessments),
    decisions: list(doc.decisions),
    attempts,
    worktrees: list(doc.worktrees),
  };
}

const STEPS: Record<number, (doc: Json) => Json> = { 0: fromV0 };

/**
 * Bring a parsed mission file to the current version. Throws
 * `UnreadableMission` for anything that is not a mission at all, or that was
 * written by a newer build (never guessed at: a newer build's fields may carry
 * meaning this one would drop).
 */
export function migrateMission(raw: unknown): Mission {
  if (!isObject(raw)) throw new UnreadableMission('not an object');
  let doc: Json = raw;
  let v = typeof doc.v === 'number' ? doc.v : 0;
  if (v > MISSION_SCHEMA_VERSION) throw new UnreadableMission(`written by a newer version (v${v})`);
  while (v < MISSION_SCHEMA_VERSION) {
    const step = STEPS[v];
    if (!step) throw new UnreadableMission(`no migration from v${v}`);
    doc = step(doc);
    v = doc.v as number;
  }
  if (typeof doc.id !== 'string' || typeof doc.state !== 'string' || typeof doc.repoRoot !== 'string') {
    throw new UnreadableMission('missing id, state or repoRoot');
  }
  return doc as unknown as Mission;
}

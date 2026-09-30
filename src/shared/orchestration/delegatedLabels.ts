/**
 * How the derived orchestration state (#101, `delegatedState.ts`) reads on
 * screen: the table's chips, the Missions pane's outcome facts and the
 * conversation's delegated-work summary all take their words from here, so
 * the three surfaces say the same thing. Nothing here derives state: every
 * input is a value the store already worked out (status contract §3, §4, §8,
 * §11). No Node, no DOM.
 */
import type { SessionStatus } from '../model';
import {
  ACTIVITY_PHASES,
  headlineOf,
  type Certainty,
  type LinkedOutcome,
  type LinkedPhase,
  type LinkedWork,
  type TaskPhase,
  type WaitInfo,
  type WaitSource,
} from './delegatedState';

/** Which colour a chip takes: needs you, quiet activity, a finished outcome, a failure, or unknown. */
export type LinkedTone = 'needs' | 'activity' | 'terminal' | 'failed' | 'unknown';

export function linkedTone(w: Pick<LinkedWork, 'phase' | 'needsYou' | 'certainty'>): LinkedTone {
  if (w.certainty === 'unknown' || w.phase === 'unknown') return 'unknown';
  if (w.phase === 'failed') return 'failed';
  if (w.needsYou) return 'needs';
  if (ACTIVITY_PHASES.has(w.phase)) return 'activity';
  return 'terminal';
}

/** §8: the marker a value carries. Verified carries none. */
export function certaintyMark(c: Certainty): '' | '~' | '?' {
  return c === 'inferred' ? '~' : c === 'unknown' ? '?' : '';
}

const SOURCE_TEXT: Record<WaitSource, string> = {
  hook: 'the status hooks',
  'pid-file': "Claude Code's session file",
  transcript: 'the transcript',
  sdk: 'the in-app session',
  'codex-app-server': 'the Codex app server',
  'codex-rollout': 'the Codex rollout file',
  mission: 'the mission record',
};

/** "Verified from the mission record" / "Estimated from the transcript" / "Unknown: …". */
export function certaintyText(c: Certainty, source?: WaitSource): string {
  const from = source ? ` from ${SOURCE_TEXT[source]}` : '';
  if (c === 'verified') return `Verified${from}.`;
  if (c === 'inferred') return `Estimated${from}: a heuristic, not a reported fact.`;
  return 'Unknown: no signal can say right now, so it is not guessed.';
}

const REASON_TEXT: Record<WaitInfo['reason'], string> = {
  permission: 'needs your permission',
  'user-question': 'needs an answer',
  'plan-approval': 'needs plan approval',
  'user-reply': 'its last reply asks you something',
  'awaiting-approval': 'delegated work waits for your approval',
  'awaiting-children': 'waiting on work it delegated; nothing for you',
  background: 'background work it will resume on',
  resource: 'waiting for a lease',
  'rate-limit': 'rate limited',
  queued: 'delegated work is queued',
  dependency: 'delegated work waits on a dependency',
  verifying: 'delegated work is being verified',
  planning: 'delegating: the planner is deciding',
};

/** §3 in words: what the row is waiting for, with its detail when there is one. */
export function waitReasonText(wait: WaitInfo): string {
  const base = REASON_TEXT[wait.reason] ?? wait.reason;
  return wait.detail ? `${base} (${wait.detail})` : base;
}

/** Whether the phase's drill-down is the conversation's own card (§10) rather than Missions. */
export function drillsToConversation(p: LinkedPhase): boolean {
  return p === 'planning' || p === 'awaiting-approval';
}

/** A chip on a table row, with its ≈300 px form. */
export interface RowChip {
  text: string;
  short: string;
  title: string;
  tone: LinkedTone;
  /** Where a click on it goes: a mission in Missions, or nowhere of its own (the row opens the conversation). */
  missionId?: string;
  /** The chip is a guess (`~`) or unknown (`?`). */
  mark: '' | '~' | '?';
}

/**
 * The row's reason chip for a Waiting row that is not a provider prompt (the
 * prompt has its own "Needs X" chip): what the user is asked to do.
 */
export function waitingReasonChip(status: SessionStatus, wait: WaitInfo | undefined): RowChip | undefined {
  if (status !== 'waiting' || !wait) return undefined;
  const mark = certaintyMark(wait.certainty);
  if (wait.reason === 'user-reply') {
    return {
      text: 'Asked you something',
      short: 'Your reply',
      title: `Its last reply asks you something. ${certaintyText(wait.certainty, wait.source)}`,
      tone: 'needs',
      mark,
    };
  }
  return undefined;
}

/**
 * A4: the linked-work chip, the most urgent entry plus "+N". A row whose own
 * wait is keyed to that entry says so: waiting on delegated work (not on you),
 * or waiting for your approval of it.
 */
export function linkedChip(linked: readonly LinkedWork[] | undefined, wait: WaitInfo | undefined): RowChip | undefined {
  const head = headlineOf(linked ?? []);
  if (!head) return undefined;
  const w = head.entry;
  const more = head.more > 0 ? ` +${head.more}` : '';
  const certainty: Certainty = w.certainty === 'unknown' ? 'unknown' : w.keyedEstimated && w.keyed ? 'inferred' : w.certainty;
  const mark = certaintyMark(certainty);
  const onIt = wait?.ref?.missionId === w.missionId;
  const others = (linked ?? []).filter((x) => x !== w).map((x) => `${x.title} (${x.text})`);
  const drill = drillsToConversation(w.phase) ? 'Click the row to answer it in the conversation.' : 'Click to open it in Missions.';
  let text = `Delegated: ${w.text}`;
  let lead = '';
  if (onIt && wait?.reason === 'awaiting-children') {
    text = `Waiting on delegated work · ${w.text}`;
    lead = 'Waiting on work it delegated. Nothing for you to do, so it is not counted as needing you.';
  } else if (onIt && wait?.reason === 'awaiting-approval') {
    lead = 'Waiting for you to approve work it delegated.';
  } else if (w.needsYou) {
    lead = 'Delegated work needs you (counted once, on the mission).';
  } else if (ACTIVITY_PHASES.has(w.phase)) {
    lead = 'Delegated work in progress. Nothing for you to do.';
  }
  const lines = [
    lead,
    `${w.title}: ${w.text}`,
    w.why,
    ...(w.outcome ? outcomeFacts(w.outcome).map((f) => f.title) : []),
    `${certaintyText(certainty, 'mission')}${w.keyedEstimated && w.keyed ? ' Which turn it belongs to is estimated.' : ''}`,
    drill,
    others.length > 0 ? `${others.length} more delegated: ${others.join('; ')}` : '',
  ];
  return {
    text: `${text}${more}`,
    short: `${w.short}${more}`,
    title: lines.filter(Boolean).join('\n'),
    tone: linkedTone({ ...w, certainty }),
    ...(drillsToConversation(w.phase) ? {} : { missionId: w.missionId }),
    mark,
  };
}

/** One of the three C1–C3 facts of a finished mission, as its own chip. */
export interface OutcomeFact {
  kind: 'integrated' | 'verification' | 'closeout';
  text: string;
  title: string;
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
}

/** C1–C3: where it went, whether it was checked, who closes out. Never one "done". */
export function outcomeFacts(o: LinkedOutcome): OutcomeFact[] {
  const where: OutcomeFact = !o.integrated
    ? { kind: 'integrated', text: 'Discarded', title: 'Its result was discarded: nothing was merged.', tone: 'neutral' }
    : o.finish === 'pull-request'
      ? { kind: 'integrated', text: 'PR opened', title: `Integrated: a pull request was opened${o.pullRequestUrl ? ` (${o.pullRequestUrl})` : ''}. It is not merged until you merge it.`, tone: 'ok' }
      : o.finish === 'keep'
        ? { kind: 'integrated', text: 'Kept on branch', title: 'Integrated: kept on its branch, not merged.', tone: 'ok' }
        : { kind: 'integrated', text: 'Merged', title: `Integrated: merged${o.mergeCommit ? ` at ${o.mergeCommit.slice(0, 8)}` : ''}. Merged says where the branch went, not that the work was checked.`, tone: 'ok' };
  const checked: OutcomeFact =
    o.verification === 'verified'
      ? { kind: 'verification', text: 'Verified', title: 'Verified: every required task passed its checks.', tone: 'ok' }
      : o.verification === 'failed'
        ? { kind: 'verification', text: 'Checks failed', title: 'A required check failed.', tone: 'bad' }
        : {
            kind: 'verification',
            text: o.noChecks ? 'Unverified · no checks configured' : 'Unverified',
            title: o.noChecks
              ? 'Unverified: the repository configures no verification commands, so nothing was checked.'
              : 'Unverified: no required check passed (for example a result you accepted yourself).',
            tone: 'warn',
          };
  const closeout: OutcomeFact = {
    kind: 'closeout',
    text: 'Closeout: yours',
    title: 'Agent Wrangler closes no GitHub issue and opens no follow-up: closing out is yours.',
    tone: 'neutral',
  };
  return [where, checked, closeout];
}

/** A task's row state (from `taskPhase`), worded so "done" never stands in for "verified". */
export const TASK_PHASE_LABEL: Record<TaskPhase, string> = {
  'to-start': 'to start',
  pending: 'not started',
  queued: 'queued',
  running: 'running',
  'worker-asks': 'worker asks',
  verifying: 'verifying',
  'needs-you': 'needs you',
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
};

/** The summary block's phase word, one per linked phase (§4). */
export const LINKED_PHASE_LABEL: Record<LinkedPhase, string> = {
  planning: 'Planning',
  'awaiting-approval': 'Awaiting approval',
  'needs-you': 'Needs you',
  'awaiting-children': 'Awaiting results',
  running: 'Running',
  queued: 'Queued',
  verifying: 'Verifying',
  paused: 'Paused',
  'ready-for-review': 'Ready to merge',
  integrated: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
};

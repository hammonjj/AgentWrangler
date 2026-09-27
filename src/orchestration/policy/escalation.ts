/**
 * The escalation policy (`docs/plans/intelligent-orchestration.md` §15.2–15.3,
 * #41): a classified failure plus the task's history → the ladder's next step,
 * with every step it had to skip recorded beside it.
 *
 * Pure. The one thing it cannot know from values — whether some model at a
 * tier is there for it to move to — is asked through `probe`, which the task
 * runner answers from a resolver snapshot and a test answers from a table.
 *
 * What makes a runaway loop impossible, all enforced here:
 *
 * - **Every loop has a counter.** Quality attempts (3), infra retries (2, not
 *   counted as quality), capacity waits (3), empty and stuck retries (1 each),
 *   tier / effort / harness steps, and a hard ceiling on attempts of any kind
 *   (8). A counter that is spent blocks the step, and a blocked step moves the
 *   task on or hands it to a person — never back to a step already taken.
 * - **Same signature**: twice in a row moves to the next axis, three times is
 *   `needs-human`, whatever else is left.
 * - **Caps are never exceeded** (§10.2): `maxAttempts`, `maxEstimatedCostUsd`,
 *   `maxTier`, `maxEffort`; `frontier` only when the mission allows it (§6.3).
 *   A step a cap forbids is recorded as blocked by it, saying which scope set it.
 * - **Pins freeze their dimension** (`pinnedDimensions`, #40).
 * - **A rate limit waits; it never raises the tier.** Nothing here changes a
 *   permission mode or a tool list: a step is a route, never a permission.
 */
import { EFFORT_LEVELS, type EffortLevel, type EscalationAction, type EscalationBlock, type EscalationDecision, type ExecutionTarget, type HarnessId, type Millis, type OutcomeCategory, type RouteCaps, type RouteDimension, type RoutingMode, type TierName } from '../../shared/orchestration/types';
import { tierRank, type TierDef } from '../../shared/orchestration/catalog';
import type { Classification } from './outcome';

/** The limits of §15.3. `limitsFor(mode)` gives the defaults. */
export interface EscalationLimits {
  /** Attempts at the work itself: every attempt except infra retries, capacity waits and resumes. */
  qualityAttempts: number;
  /** Infra retries of the same route in a row, before a harness switch or a person. */
  infraRetries: number;
  /** Rate limits in a row the task waits out before a person is asked. */
  capacityWaits: number;
  /** Tier steps per task: 1 when the router routes, 0 when a person picked the route (§15.3). */
  tierSteps: number;
  effortSteps: number;
  /** Harness switches per task; 0 when a person picked the route. */
  harnessSwitches: number;
  /** The same signature this many times in a row goes to a person (twice moves to the next axis). */
  sameSignatureHuman: number;
  /** Retries after an attempt that changed nothing, and after one that ran past its wall clock. */
  emptyRetries: number;
  stuckRetries: number;
  /** Attempts of any kind a task may have, whatever the counters above say. */
  hardMaxAttempts: number;
  /** Wait before each infra retry, in order; the last repeats. */
  infraBackoffMs: readonly number[];
  /** How long to wait out a rate limit when nothing says when capacity returns. */
  capacityWaitMs: number;
  /** The longest a single wait may be. */
  maxWaitMs: number;
  /** Active time an attempt may run before it is stopped as stuck. */
  wallClockMs: number;
}

export const DEFAULT_LIMITS: EscalationLimits = {
  qualityAttempts: 3,
  infraRetries: 2,
  capacityWaits: 3,
  tierSteps: 1,
  effortSteps: 1,
  harnessSwitches: 1,
  sameSignatureHuman: 3,
  emptyRetries: 1,
  stuckRetries: 1,
  hardMaxAttempts: 8,
  infraBackoffMs: [15_000, 60_000],
  capacityWaitMs: 5 * 60_000,
  maxWaitMs: 6 * 60 * 60_000,
  wallClockMs: 45 * 60_000,
};

/** §15.3's defaults for a routing mode: a route a person picked does not change tier or harness on its own. */
export function limitsFor(mode: RoutingMode, overrides: Partial<EscalationLimits> = {}): EscalationLimits {
  const byMode: Partial<EscalationLimits> = mode === 'auto' ? {} : { tierSteps: 0, harnessSwitches: 0 };
  return { ...DEFAULT_LIMITS, ...byMode, ...overrides };
}

/** One ended attempt of the task, oldest first, as the policy counts it. */
export interface AttemptHistoryItem {
  id: string;
  n: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  category?: OutcomeCategory;
  signature?: string;
  /** A resume of an interrupted attempt: a continuation, not another try (§23.3). */
  resume?: boolean;
  /** Started automatically by `autoRecover`. */
  autoResumed?: boolean;
}

/** The route the failed attempt ran on. */
export interface EscalationRoute {
  harness: HarnessId;
  model: string;
  tier: TierName;
  /** AW's level. Undefined: the harness's default effort, which has no place on AW's scale. */
  effort?: EffortLevel;
  /** Its context window, when reported. */
  contextWindow?: number;
}

/** What `probe` is asked: is there a model the policy allows to move to? */
export interface ProbeRequest {
  tier: TierName;
  /** Stay on this harness (it is pinned, or the step is not a harness switch). */
  harness?: HarnessId;
  /** A harness switch: anything but this one. */
  notHarness?: HarnessId;
  /** A context step: a window larger than this. */
  largerContextThan?: number;
  /** The tier is escalation-only (`frontier`), already allowed by the mission. */
  escalationTier?: boolean;
}

export type ProbeAnswer = { ok: true; target: ExecutionTarget } | { ok: false; reason: string };

export interface EscalationInput {
  taskId: string;
  /** The attempt that just ended. Its history item is the last of `history`. */
  afterAttemptId: string;
  classification: Classification;
  history: readonly AttemptHistoryItem[];
  /** The task's decisions so far, oldest first. */
  decisions: readonly EscalationDecision[];
  route: EscalationRoute;
  mode: RoutingMode;
  /** From `pinnedDimensions` of the policy the next attempt would run under. */
  pinned: readonly RouteDimension[];
  /** Which scope pinned each dimension, for the reason ("the task", "the mission"). */
  pinnedBy?: Partial<Record<RouteDimension, string>>;
  caps: RouteCaps;
  /** Which scope set each cap. */
  cappedBy?: Partial<Record<keyof RouteCaps, string>>;
  frontierAllowed: boolean;
  autoRecover: boolean;
  /** For `lost`: whether a Resume is possible, and whether one may follow on its own (not after a host crash). */
  lost?: { resumable: boolean; autoResumable: boolean };
  tiers: readonly TierDef[];
  /** What the task's attempts have cost, where anything reported it. */
  spentUsd?: number;
  /** The failed attempt's session can take another message (live, or resumable). */
  sessionContinuable: boolean;
  /** Its harness can change effort in a running session (§6.4). */
  effortMidSession: boolean;
  /** When the route's source has capacity again, if something reported it. */
  capacityBackAt?: Millis;
  limits: EscalationLimits;
  probe: (req: ProbeRequest) => ProbeAnswer;
  now: Millis;
  newId: () => string;
}

export interface EscalationOutcome {
  /** Every step decided, the skipped ones first, the one taken last. */
  decisions: EscalationDecision[];
  /** The step taken. */
  final: EscalationDecision;
}

const QUALITY_EXEMPT: readonly (OutcomeCategory | undefined)[] = ['infra', 'capacity', 'lost'];
const ROUTE_STEPS: readonly EscalationAction[] = ['raise-effort', 'raise-tier', 'switch-harness', 'switch-model'];

/** Decide the next step after a failed attempt. Pure. */
export function decideEscalation(input: EscalationInput): EscalationOutcome {
  const { classification: cls, limits, route, now } = input;
  const out: EscalationDecision[] = [];
  const repeats = trailing(input.history, (h) => h.signature === cls.signature && h.status !== 'succeeded');
  const base = (action: EscalationAction, reason: string, extra: Partial<EscalationDecision> = {}): EscalationDecision => ({
    id: input.newId(),
    taskId: input.taskId,
    afterAttemptId: input.afterAttemptId,
    evidence: { category: cls.category, signature: cls.signature, repeats },
    action,
    reason,
    decidedAt: now,
    ...extra,
  });
  const block = (action: EscalationAction, blockedBy: EscalationBlock, reason: string, delta?: EscalationDecision['delta']): void => {
    out.push(base(action, reason, { blockedBy, ...(delta ? { delta } : {}) }));
  };
  const end = (d: EscalationDecision): EscalationOutcome => {
    out.push(d);
    return { decisions: out, final: d };
  };
  const human = (reason: string): EscalationOutcome => end(base('needs-human', reason));

  const tries = input.history.filter((h) => !h.resume).length;
  const quality = input.history.filter((h) => !h.resume && !QUALITY_EXEMPT.includes(h.category)).length;
  const priorSteps = input.decisions.filter((d) => !d.blockedBy && hasStep(d)).length;
  const used = (action: EscalationAction) => input.decisions.filter((d) => d.action === action && !d.blockedBy).length;
  const capScope = (k: keyof RouteCaps) => input.cappedBy?.[k] ?? 'the policy';
  const pinScope = (d: RouteDimension) => input.pinnedBy?.[d] ?? 'the policy';

  /**
   * Take a launching step, unless a count cap or limit forbids another
   * attempt now; then that step is recorded as blocked, and the task stops.
   */
  const launch = (action: EscalationAction, reason: string, extra: Partial<EscalationDecision>, opts: { quality: boolean }): EscalationOutcome => {
    const refusal = launchRefusal(opts.quality);
    if (refusal) {
      block(action, refusal.by, refusal.reason, extra.delta);
      return end(base(refusal.by === 'cap' ? 'stop' : 'needs-human', refusal.reason));
    }
    return end(base(action, reason, { ...extra, step: priorSteps + 1 }));
  };
  const launchRefusal = (countsAsQuality: boolean): { by: EscalationBlock; reason: string } | undefined => {
    const c = input.caps;
    if (c.maxAttempts !== undefined && tries >= c.maxAttempts) {
      return { by: 'cap', reason: `Attempt ${tries + 1} would pass ${capScope('maxAttempts')}'s cap of ${c.maxAttempts} attempts.` };
    }
    if (c.maxEstimatedCostUsd !== undefined && input.spentUsd !== undefined && input.spentUsd >= c.maxEstimatedCostUsd) {
      return { by: 'cap', reason: `The task has spent an estimated $${input.spentUsd.toFixed(2)}; ${capScope('maxEstimatedCostUsd')} caps it at $${c.maxEstimatedCostUsd.toFixed(2)}.` };
    }
    if (tries >= limits.hardMaxAttempts) return { by: 'limit', reason: `${tries} attempts is the most any task gets.` };
    if (countsAsQuality && quality >= limits.qualityAttempts) {
      return { by: 'limit', reason: `${quality} attempts at the work is the limit of ${limits.qualityAttempts}.` };
    }
    return undefined;
  };
  const continueOrFresh = (): 'continue' | 'fresh' => (input.sessionContinuable ? 'continue' : 'fresh');

  // ---- The ladder's route steps (§15.2 `quality-repeat`) ----

  const raiseEffort = (): EscalationOutcome | undefined => {
    if (input.pinned.includes('effort')) return void block('raise-effort', 'pin', `Effort is pinned by ${pinScope('effort')}, so it is not raised.`);
    const cur = route.effort;
    if (cur === undefined) return void block('raise-effort', 'unavailable', 'The attempt ran at the harness’s default effort, which has no step up on AW’s scale.');
    const i = EFFORT_LEVELS.indexOf(cur);
    const next = EFFORT_LEVELS[i + 1];
    if (!next) return void block('raise-effort', 'unavailable', `Effort is already ${cur}.`);
    const cap = input.caps.maxEffort;
    if (cap && EFFORT_LEVELS.indexOf(next) > EFFORT_LEVELS.indexOf(cap)) {
      return void block('raise-effort', 'cap', `Would raise effort to ${next}; ${capScope('maxEffort')} caps effort at ${cap}.`, { effort: next });
    }
    if (used('raise-effort') >= limits.effortSteps) {
      return void block('raise-effort', 'limit', `Effort has been raised ${used('raise-effort')} time(s); the limit is ${limits.effortSteps}.`, { effort: next });
    }
    const mode = input.effortMidSession && input.sessionContinuable ? 'continue' : 'fresh';
    return launch('raise-effort', `Failed the same way twice: raising effort from ${cur} to ${next}.`, { delta: { effort: next }, mode }, { quality: true });
  };

  const raiseTier = (): EscalationOutcome | undefined => {
    if (input.pinned.includes('tier')) return void block('raise-tier', 'pin', `The model is pinned by ${pinScope('tier')}, so its tier stays ${route.tier}.`);
    const i = tierRank(input.tiers, route.tier);
    if (i < 0) return void block('raise-tier', 'unavailable', `${route.model || 'The model'} has no tier to step up from.`);
    const next = input.tiers[i + 1];
    if (!next) return void block('raise-tier', 'unavailable', `${route.tier} is already the top tier.`);
    if (next.reachableBy === 'escalation' && !input.frontierAllowed) {
      return void block('raise-tier', 'cap', `Would raise to ${next.name}; not allowed for this mission.`, { tier: next.name });
    }
    const cap = input.caps.maxTier;
    const capRank = cap ? tierRank(input.tiers, cap) : -1;
    if (cap && capRank >= 0 && i + 1 > capRank) {
      return void block('raise-tier', 'cap', `Would raise tier to ${next.name}; ${capScope('maxTier')} is capped at ${cap}.`, { tier: next.name });
    }
    if (used('raise-tier') >= limits.tierSteps) {
      const why = limits.tierSteps === 0 ? 'a route picked by hand does not change tier on its own' : `the limit is ${limits.tierSteps} tier step(s)`;
      return void block('raise-tier', 'limit', `Would raise tier to ${next.name}; ${why}.`, { tier: next.name });
    }
    const found = input.probe({ tier: next.name, ...(input.pinned.includes('harness') ? { harness: route.harness } : {}), escalationTier: next.reachableBy === 'escalation' });
    if (!found.ok) return void block('raise-tier', 'unavailable', `No ${next.name} model to raise to: ${found.reason}`, { tier: next.name });
    return launch('raise-tier', `Failed the same way again: raising tier from ${route.tier} to ${next.name} (${found.target.model}).`, { delta: { tier: next.name }, target: found.target, mode: 'fresh' }, { quality: true });
  };

  const switchHarness = (opts: { quality: boolean; why: string }): EscalationOutcome | undefined => {
    if (input.pinned.includes('harness')) return void block('switch-harness', 'pin', `The harness is pinned by ${pinScope('harness')}.`);
    if (input.pinned.includes('model')) return void block('switch-harness', 'pin', `The model is pinned by ${pinScope('model')}, and it runs on one harness.`);
    if (used('switch-harness') >= limits.harnessSwitches) {
      const why = limits.harnessSwitches === 0 ? 'a route picked by hand does not change harness on its own' : `the limit is ${limits.harnessSwitches} switch(es)`;
      return void block('switch-harness', 'limit', `Would switch harness; ${why}.`);
    }
    const found = input.probe({ tier: route.tier, notHarness: route.harness });
    if (!found.ok) return void block('switch-harness', 'unavailable', `No other harness has a ${route.tier} model: ${found.reason}`);
    return launch('switch-harness', `${opts.why}: switching to ${found.target.harness} (${found.target.model}), same tier.`, { delta: { harness: found.target.harness }, target: found.target, mode: 'fresh' }, opts);
  };

  /** Everything the ladder had to skip, in a sentence for the person it lands with. */
  const skipped = (): string => {
    const reasons = out.filter((d) => d.blockedBy).map((d) => d.reason);
    return reasons.length > 0 ? ` ${reasons.join(' ')}` : '';
  };

  // ---- Categories (§15.2) ----

  switch (cls.category) {
    case 'lost': {
      const lost = input.lost ?? { resumable: false, autoResumable: false };
      const alreadyAuto = input.history.at(-1)?.autoResumed === true;
      if (input.autoRecover && lost.resumable && lost.autoResumable && !alreadyAuto) {
        return end(base('retry-same', `${capitalise(cls.detail)}; resuming it once, as autoRecover allows.`, { mode: 'continue' }));
      }
      const why = !input.autoRecover
        ? 'Resume the attempt or retry it fresh.'
        : !lost.autoResumable
          ? 'Resume the attempt or retry it fresh; it is never resumed on its own after a host crash.'
          : alreadyAuto
            ? 'Resume the attempt or retry it fresh; it was already resumed once on its own.'
            : 'Retry it fresh.';
      return human(`${capitalise(cls.detail)}. ${why}`);
    }

    case 'infra': {
      if (cls.retryable === false) return human(`${capitalise(cls.detail)}; retrying unchanged cannot help. Fix it, then retry.`);
      const inRow = trailing(input.history, (h) => h.category === 'infra');
      if (inRow <= limits.infraRetries) {
        const wait = limits.infraBackoffMs[Math.min(inRow - 1, limits.infraBackoffMs.length - 1)] ?? 0;
        return launch('retry-same', `${capitalise(cls.detail)}: retrying the same route (${inRow} of ${limits.infraRetries}).`, { mode: continueOrFresh(), notBefore: now + wait }, { quality: false });
      }
      block('retry-same', 'limit', `${inRow} infra failures in a row; the limit is ${limits.infraRetries} retries.`);
      return switchHarness({ quality: false, why: 'The route keeps failing' }) ?? human(`${capitalise(cls.detail)}, ${inRow} times in a row.${skipped()}`);
    }

    case 'capacity': {
      const inRow = trailing(input.history, (h) => h.category === 'capacity');
      if (inRow > limits.capacityWaits) return human(`Rate limited ${inRow} times in a row; waiting has not helped.`);
      const until = Math.min(now + limits.maxWaitMs, Math.max(now, input.capacityBackAt ?? now + limits.capacityWaitMs));
      return launch('wait', `Rate limited: waiting for capacity, then the same route (never a bigger model).`, { mode: continueOrFresh(), notBefore: until }, { quality: false });
    }

    case 'context': {
      if (input.pinned.includes('model')) block('switch-model', 'pin', `The model is pinned by ${pinScope('model')}.`);
      else if (route.contextWindow === undefined) block('switch-model', 'unavailable', 'Its context window was never reported, so a larger one cannot be picked.');
      else {
        const found = input.probe({ tier: route.tier, largerContextThan: route.contextWindow, harness: route.harness });
        if (found.ok) {
          return launch('switch-model', `Its context overflowed: moving to ${found.target.model}, same tier, larger window.`, { target: found.target, mode: 'fresh' }, { quality: true });
        }
        block('switch-model', 'unavailable', `No ${route.tier} model with a larger window: ${found.reason}`);
      }
      return end(base('split-task', `Too large for one attempt: split it into smaller tasks.${skipped()}`));
    }

    case 'quality-new':
      return launch('continue-with-feedback', `${capitalise(cls.detail)}: sending the failure back to the agent.`, { mode: continueOrFresh() }, { quality: true });

    case 'quality-repeat': {
      if (repeats >= limits.sameSignatureHuman) return human(`Failed the same way ${repeats} times in a row.`);
      return raiseEffort() ?? raiseTier() ?? switchHarness({ quality: true, why: 'Failed the same way again' }) ?? human(`Failed the same way ${repeats} times, and nothing is left to change.${skipped()}`);
    }

    case 'empty': {
      const inRow = trailing(input.history, (h) => h.category === 'empty');
      if (inRow > limits.emptyRetries) return human(`Changed nothing, ${inRow} times in a row.`);
      return launch('continue-with-feedback', 'Changed nothing: asking the agent once more, explicitly, to make the change.', { mode: continueOrFresh() }, { quality: true });
    }

    case 'stuck': {
      const inRow = trailing(input.history, (h) => h.category === 'stuck');
      if (inRow > limits.stuckRetries) return human(`${capitalise(cls.detail)}, ${inRow} times in a row.`);
      return launch('retry-same', `${capitalise(cls.detail)}: stopped it; one fresh try.`, { mode: 'fresh' }, { quality: true });
    }

    case 'ambiguity':
      return human(`${capitalise(cls.detail)}: a person has to answer before anything else runs.`);

    case 'policy':
      return human(`${capitalise(cls.detail)}. Escalation never changes permissions; decide what it may do, then retry.`);

    case 'budget':
      return end(base('stop', `${capitalise(cls.detail)}`));
  }
}

/** A step that started (or will start) an attempt: it carries a step number. */
function hasStep(d: EscalationDecision): boolean {
  return d.step !== undefined;
}

/** How many of the last items in a row satisfy `f`. */
function trailing<T>(items: readonly T[], f: (t: T) => boolean): number {
  let n = 0;
  for (let i = items.length - 1; i >= 0 && f(items[i]); i--) n++;
  return n;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Whether a decision changes the route (so the next attempt is decided by escalation, not the person who picked it). */
export function changesRoute(action: EscalationAction): boolean {
  return ROUTE_STEPS.includes(action);
}

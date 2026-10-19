/**
 * The proposals section of the Analytics view and the detail behind each one
 * (#52, plan §20). Every sentence is decided here from `routingProposals.ts`;
 * the webview lays out strings and posts back Accept, Reject or Revoke.
 *
 * A proposal always shows its cohort, counts, interval and data window, and an
 * accepted rule keeps the evidence it was accepted on.
 */
import type { AnalyticsDataset } from './analytics';
import {
  cohortText,
  dataSummary,
  DOWNGRADE_MIN_OBSERVATIONS,
  generateProposals,
  intervalText,
  pendingProposals,
  proposalText,
  ruleHealth,
  windowText,
  type LearnedRule,
  type ProposalEvidence,
  type RejectedProposal,
  type RoutingProposal,
} from './routingProposals';
import type { TierName } from './types';

/** What an accepted rule or open proposal a click is about. */
export type ProposalRef = { kind: 'proposal'; id: string } | { kind: 'rule'; id: string };

export interface ProposalCardView {
  ref: ProposalRef;
  id: string;
  direction: 'downgrade' | 'upgrade';
  /** "basic passed first time 20 of 20; lower the floor from standard to basic?" */
  title: string;
  cohort: string;
  counts: string;
  interval: string;
  window: string;
  /** Why it cannot be accepted: the corpus veto's reasons. Absent: it can. */
  refused?: string[];
}

export interface RuleCardView {
  ref: ProposalRef;
  id: string;
  title: string;
  cohort: string;
  accepted: string;
  evidence: string;
  /** `review`: the route it sends work to now fails often enough that the rule should be looked at again. */
  health: 'ok' | 'review' | 'no-recent-data';
  healthText: string;
}

export interface ProposalsView {
  pending: ProposalCardView[];
  rules: RuleCardView[];
  /** Always set: how much history there is and what it takes before anything is proposed. */
  note: string;
}

/** What the section is computed from. */
export interface ProposalsInput {
  rules: readonly LearnedRule[];
  rejected: readonly RejectedProposal[];
  /** The tiers the router may ask for, weakest first. */
  tiers: readonly TierName[];
  /** The corpus veto: the reasons a rule is refused, empty when it is not. */
  veto?: (rule: LearnedRule) => string[];
}

const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function countsText(e: ProposalEvidence): string {
  return `${e.successes} of ${e.observations} passed first time on ${e.route.tier}`;
}

/** Every proposal the history supports right now, before decisions are applied. */
export function currentProposals(ds: AnalyticsDataset, input: ProposalsInput, now: number): RoutingProposal[] {
  return generateProposals(ds, { now, tiers: input.tiers });
}

export function proposalsView(ds: AnalyticsDataset, input: ProposalsInput, now: number): ProposalsView {
  const pending = pendingProposals(currentProposals(ds, input, now), input.rules, input.rejected, now);
  const summary = dataSummary(ds, now);
  const note =
    pending.length > 0 || input.rules.length > 0
      ? `Based on ${summary.observations} finished tasks${summary.pending > 0 ? ` (${summary.pending} more are under 14 days old and not counted yet)` : ''}.`
      : `Nothing to propose yet: ${summary.observations} finished ${summary.observations === 1 ? 'task counts' : 'tasks count'}${summary.pending > 0 ? `, ${summary.pending} more are under 14 days old` : ''}. ` +
        `A proposal needs at least ${DOWNGRADE_MIN_OBSERVATIONS} observations of a cheaper route in one cohort (10 to raise a floor). Until then the deterministic policy applies.`;
  return {
    pending: pending.map((p) => {
      const refused = input.veto?.({ id: p.id, direction: p.direction, cohort: p.cohort, fromTier: p.fromTier, toTier: p.toTier, evidence: p.evidence, acceptedAt: now }) ?? [];
      return {
        ref: { kind: 'proposal', id: p.id },
        id: p.id,
        direction: p.direction,
        title: proposalText(p),
        cohort: cohortText(p.cohort),
        counts: countsText(p.evidence),
        interval: intervalText(p.evidence),
        window: windowText(p.evidence),
        ...(refused.length > 0 ? { refused } : {}),
      };
    }),
    rules: input.rules.map((r) => {
      const h = ruleHealth(r, ds, now);
      return {
        ref: { kind: 'rule', id: r.id },
        id: r.id,
        title: `${r.direction === 'downgrade' ? 'Lowered' : 'Raised'} the floor from ${r.fromTier} to ${r.toTier}`,
        cohort: cohortText(r.cohort),
        accepted: `accepted ${dayText(r.acceptedAt)}`,
        evidence: `${countsText(r.evidence)} · ${intervalText(r.evidence)} · ${windowText(r.evidence)}`,
        health: h.state,
        healthText:
          h.state === 'review'
            ? `Review: since you accepted it, ${h.recent!.successes} of ${h.recent!.n} passed first time on ${r.toTier}.`
            : h.state === 'ok'
              ? `Holding: ${h.recent!.successes} of ${h.recent!.n} recent tasks passed first time.`
              : 'Not enough recent tasks on this route to re-check it.',
      };
    }),
    note,
  };
}

/** A proposal or rule as the detail pane shows it, or undefined when it is gone. */
export function proposalEvidenceOf(
  ds: AnalyticsDataset,
  input: ProposalsInput,
  ref: ProposalRef,
  now: number,
): { title: string; subtitle: string; facts: { label: string; value: string }[]; evidenceIds: string[] } | undefined {
  const rule = ref.kind === 'rule' ? input.rules.find((r) => r.id === ref.id) : undefined;
  const proposal = ref.kind === 'proposal' ? currentProposals(ds, input, now).find((p) => p.id === ref.id) : undefined;
  const src = rule ?? proposal;
  if (!src) return undefined;
  const e = src.evidence;
  return {
    title: rule ? 'Accepted routing rule' : 'Routing proposal',
    subtitle: proposalText(src),
    facts: [
      { label: 'Cohort', value: cohortText(src.cohort) },
      { label: 'Policy asked for', value: e.policyTier },
      { label: 'Route measured', value: e.route.tier },
      { label: 'Passed first time', value: `${e.successes} of ${e.observations}` },
      { label: 'Success rate', value: intervalText(e) },
      { label: 'Data window', value: windowText(e) },
      { label: 'Pooled across', value: e.pooledFrom === 'repository' ? 'this repository only' : 'all repositories' },
      { label: 'Proposed change', value: `${src.direction === 'downgrade' ? 'lower' : 'raise'} the floor from ${src.fromTier} to ${src.toTier}, one step` },
      ...(rule ? [{ label: 'Accepted', value: dayText(rule.acceptedAt) }] : []),
    ],
    evidenceIds: e.recordIds,
  };
}

export function parseProposalRef(raw: unknown): ProposalRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if ((r.kind === 'proposal' || r.kind === 'rule') && typeof r.id === 'string' && r.id !== '') return { kind: r.kind, id: r.id };
  return undefined;
}

export type RoutingProposalDecision = 'accept' | 'reject' | 'revoke';

export function parseDecision(raw: unknown): RoutingProposalDecision | undefined {
  return raw === 'accept' || raw === 'reject' || raw === 'revoke' ? raw : undefined;
}

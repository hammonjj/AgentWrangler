/**
 * "Why this route" (`docs/plans/intelligent-orchestration.md` §9.5; #38).
 *
 * Pure. Assembled from what was stored — the decision, its shadow, the
 * assessment it was routed from — and never regenerated: the explanation of
 * an attempt that ran last week is what the router said last week, even if the
 * rules or the catalog have changed since.
 *
 * The answer to "why is this running on an expensive model?" has to name the
 * rules that fired, the inputs they read and the cheaper candidates that were
 * passed over, in words a person can check against the assessment above it.
 */
import { modelLabel } from '../../shared/modelName';
import { harnessLabel } from '../../shared/harness';
import type { RouteExplanationView } from '../../shared/orchestration/taskView';
import type {
  ExecutionTarget,
  Mission,
  RouteAgreement,
  RouteRecommendation,
  RouteRequirement,
  RoutingDecision,
  RoutingReason,
} from '../../shared/orchestration/types';
import { contextNeedOf, CONTEXT_NEED_PREFIX } from '../policy/router';

/** "Sonnet 5 · medium (standard)": a target as a person reads it. */
export function targetLabel(t: ExecutionTarget): string {
  const name = modelLabel(t.resolvedModel ?? t.model) ?? (t.model || `${harnessLabel(t.harness)} default`);
  const effort = t.effortNative && t.effortNative !== 'none' ? ` · ${t.effortNative}` : '';
  const tier = t.tier && t.tier !== 'unassigned' ? ` (${t.tier})` : ' (unassigned)';
  return `${name}${effort}${tier}`;
}

function kTokens(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`;
}

/** "standard (up to expert) · medium effort · needs edit, shell · 150k context". */
export function requirementText(r: RouteRequirement): string {
  const parts = [r.minTier === r.maxTier ? r.minTier : `${r.minTier} (up to ${r.maxTier})`, `${r.effort} effort`];
  const tools = r.needs.filter((n) => !n.startsWith(CONTEXT_NEED_PREFIX));
  if (tools.length > 0) parts.push(`needs ${tools.join(', ')}`);
  const ctx = contextNeedOf(r.needs);
  if (ctx !== undefined) parts.push(`${kTokens(ctx)} context`);
  return parts.join(' · ');
}

const TIER_RULE = /^(tier|floor|ceiling|guard|confidence|cap)\./;

function sentence(texts: string[]): string {
  return texts.map((t) => t.replace(/\.$/, '')).join('; ');
}

/** The §9.5 paragraph for a recommendation: tier because, effort because, cheaper candidates passed over. */
function because(rec: Pick<RouteRecommendation, 'reasons' | 'requirement' | 'resolution'>): string {
  const tier = rec.reasons.filter((r) => TIER_RULE.test(r.ruleId));
  const effort = rec.reasons.filter((r) => r.ruleId.startsWith('effort.'));
  const out: string[] = [];
  if (tier.length > 0) out.push(`${cap(rec.requirement.minTier)} because ${sentence(tier.map((r) => r.text))}.`);
  if (effort.length > 0) out.push(`${cap(rec.requirement.effort)} effort because ${sentence(effort.map((r) => r.text))}.`);
  const cheaper = rec.resolution.candidates.filter((c) => c.verdict === 'rejected' && /below the required/.test(c.reason)).map((c) => c.reason);
  if (cheaper.length > 0) out.push(`Cheaper candidates: ${cheaper.slice(0, 3).join('; ')}${cheaper.length > 3 ? `; and ${cheaper.length - 3} more` : ''}.`);
  return out.join(' ');
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const AGREEMENT_TEXT: Record<RouteAgreement, string> = {
  accepted: 'accepted as recommended',
  matched: 'the same as the recommendation',
  'changed-tier': 'a different tier from the recommendation',
  'changed-harness': 'a different harness from the recommendation',
  'changed-model': 'a different model from the recommendation',
  'changed-effort': 'a different effort from the recommendation',
  'no-recommendation': 'no recommendation to compare with',
};

function recommendedText(rec: RouteRecommendation): string {
  if (rec.resolution.target && rec.verdict === 'route') return targetLabel(rec.resolution.target);
  if (rec.resolution.target) return `${targetLabel(rec.resolution.target)}, after a person decides (${rec.note ?? rec.verdict})`;
  return `nothing (${rec.note ?? rec.verdict})`;
}

/** The explanation view of a proposal on its own: what `assisted` shows before anything runs. */
export function explainRecommendation(rec: RouteRecommendation, confidence?: string): RouteExplanationView {
  const headline = recommendedText(rec);
  return {
    headline,
    decided: rec.verdict === 'route' ? 'Recommended' : rec.verdict === 'blocked' ? 'Blocked for now' : 'Needs you',
    summary: [`${headline}.`, because(rec), confidence ? `Assessment confidence: ${confidence}.` : ''].filter(Boolean).join(' '),
    requirement: requirementText(rec.requirement),
    rules: rec.reasons.map(ruleRow),
    gates: rec.requirement.gates.map(String),
    fallbacks: rec.resolution.candidates.filter((c) => c.verdict === 'fallback').map((c) => targetLabel(c.target)),
    rejected: rec.resolution.candidates.filter((c) => c.verdict === 'rejected').map((c) => c.reason),
    note: rec.resolution.note ?? rec.note,
    versions: `${rec.policyVersion} · ${rec.resolution.catalogVersion}`,
  };
}

function ruleRow(r: RoutingReason): { ruleId: string; text: string } {
  return { ruleId: r.ruleId, text: r.text };
}

/** The explanation of an attempt's decision (§9.5): the strip's panel and the route chip's tooltip. */
export function explainDecision(m: Mission, d: RoutingDecision): RouteExplanationView {
  const ran = d.resolution.target;
  const rec = d.shadow;
  const confidence = rec ? m.assessments.find((a) => a.id === rec.assessmentId)?.confidence : undefined;
  const conf = confidence ? `Assessment confidence: ${confidence}.` : '';

  if (d.decidedBy === 'router' && rec) {
    const base = explainRecommendation(rec, confidence);
    const headline = targetLabel(ran);
    return {
      ...base,
      headline,
      decided: d.mode === 'auto' ? 'Routed automatically' : 'Recommended and accepted',
      summary: [`${headline}.`, because(rec), `Mode: ${d.mode}, ${d.mode === 'auto' ? 'automatic' : 'accepted by you'}.`, conf].filter(Boolean).join(' '),
      note: d.resolution.note ?? base.note,
    };
  }

  const headline = targetLabel(ran);
  const changed = d.overrides.length > 0 ? ` (${d.overrides.join(', ')})` : '';
  const decided = d.reasons.some((r) => r.ruleId === 'assisted.changed') ? `Changed from the recommendation${changed}` : 'Picked by you';
  if (!rec) {
    return {
      headline,
      decided,
      summary: `${headline}. Picked by you. There is no recommendation to compare with yet: the task had not been assessed when it launched.`,
      rules: [],
      gates: [],
      fallbacks: [],
      rejected: [],
    };
  }
  const agreement = d.agreement ?? 'no-recommendation';
  const comparison = `The router would have picked ${recommendedText(rec)}: this is ${AGREEMENT_TEXT[agreement]}.`;
  return {
    headline,
    decided,
    summary: [`${headline}. ${decided}.`, comparison, because(rec), conf].filter(Boolean).join(' '),
    requirement: requirementText(rec.requirement),
    rules: rec.reasons.map(ruleRow),
    gates: rec.requirement.gates.map(String),
    comparison,
    fallbacks: rec.resolution.candidates.filter((c) => c.verdict === 'fallback').map((c) => targetLabel(c.target)),
    rejected: rec.resolution.candidates.filter((c) => c.verdict === 'rejected').map((c) => c.reason),
    note: rec.resolution.note ?? rec.note,
    versions: `${rec.policyVersion} · ${rec.resolution.catalogVersion}`,
  };
}

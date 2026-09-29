/** Conservative, provider-independent assessment. No model call and no side effects. */
export const DELEGATION_INTENT_VERSION = 1;

export interface DelegationContext {
  repoRoot: string;
  policyVersion: string;
  verificationCommands: string[];
}

export type DelegationReason = 'unavailable' | 'explicit' | 'conversation' | 'interactive' | 'ambiguous' | 'bounded-work';
export interface DelegationAssessment {
  decision: 'continue' | 'offer';
  reason: DelegationReason;
}
export type DelegationOfferOutcome = 'accepted' | 'declined' | 'ignored';
export interface DelegationOffer {
  id: string;
  reason: string;
  objective: string;
  acceptanceCriteria: string[];
  repository: string;
}

export function assessDelegation(text: string, context?: DelegationContext): DelegationAssessment {
  const stay = (reason: DelegationReason): DelegationAssessment => ({ decision: 'continue', reason });
  if (!context) return stay('unavailable');
  const t = text.trim();
  // Explicit shortcuts retain their existing agent/CLI path, including resolving "this".
  if (/^(?:please\s+)?(?:delegate\b|hand\s+(?:this|it)\s+off\b|run\s+(?:this|it)\s+as\s+a\s+task\b|aw\s+(?:delegate|task)\b)/i.test(t)) return stay('explicit');
  if (/\b(?:don['’]t|do not|never)\s+delegate\b|\b(?:keep|stay|work)\s+(?:working\s+)?(?:here|in (?:this|the) conversation)\b/i.test(t)) return stay('interactive');
  if (/^(?:(?:please|can you|could you|would you)\s+)?(?:explain|discuss|review|summarize|compare|brainstorm|describe|evaluate|tell me|show me|help me understand)\b|^(?:why|what|how|should|could|is|are|does|do)\b(?!\s+you\b)/i.test(t)) return stay('conversation');
  if (/\b(?:quick|tiny|small|one[- ]line|typo|wording|rename|interactive|step by step|pair with me)\b/i.test(t)) return stay('interactive');
  if (/\b(?:add|fix|update|change)\s+(?:(?:a|the|one|single)\s+)?(?:label|tooltip|comment|word|button text|null check)\b/i.test(t)) return stay('interactive');
  // Context-dependent or exploratory requests cannot become a self-contained objective.
  if (/\b(?:maybe|perhaps|not sure|figure out what|as discussed|above|earlier|previous|that approach|this approach|same thing|do that|do it|fix it|fix this|implement this|implement that)\b/i.test(t)) return stay('ambiguous');
  const action = /^(?:(?:please|can you|could you|would you|i want you to|help me)\s+)*(?:implement|build|add|fix|refactor|migrate|create|replace|remove|update|write)\s+\S/i.test(t);
  const scoped = /\b(?:in|for|to|across|so that|so it|when)\b|\b[\w/-]+\.(?:ts|tsx|js|py|cs|rs|go)\b|\b(?:issue|bug)\s*#?\d+/i.test(t);
  const verification = /\b(?:tests?|test coverage|verify|validation|acceptance criteria|typecheck|checks? pass)\b/i.test(t) || context.verificationCommands.length > 0;
  const background = /\b(?:tests?|migration|end[- ]to[- ]end|integration|across|background|multi[- ](?:step|file)|refactor|migrate)\b/i.test(t);
  if (!action || !scoped || !verification || !background || t.split(/\s+/).length < 9) return stay('ambiguous');
  return { decision: 'offer', reason: 'bounded-work' };
}

/** Preserve the complete request; never substitute a lossy classifier summary. */
export function delegationOffer(id: string, text: string, context: DelegationContext): DelegationOffer {
  const criteriaSection = text.match(/acceptance criteria\s*:?\s*\n([\s\S]*)/i)?.[1];
  const criteria = criteriaSection?.split('\n').map((s) => s.replace(/^\s*(?:[-*]|\d+\.)\s*(?:\[[ x]\]\s*)?/i, '').trim()).filter(Boolean);
  return {
    id,
    reason: 'This is bounded repository work with independent checks that can run in the background.',
    objective: text.trim(),
    acceptanceCriteria: criteria?.length ? criteria : [
      'Complete the behavior requested in the objective and verify it with relevant checks.',
      ...(context.verificationCommands.length ? [`Repository checks pass: ${context.verificationCommands.join(', ')}.`] : []),
    ],
    repository: context.repoRoot,
  };
}

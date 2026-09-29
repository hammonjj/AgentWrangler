import { randomUUID } from 'node:crypto';
import { assessDelegation, delegationOffer, DELEGATION_INTENT_VERSION, type DelegationContext, type DelegationOffer, type DelegationOfferOutcome } from '../../shared/delegationIntent';
import type { AgentSession } from '../../shared/model';
import type { DelegationSuggestionRecord } from '../../shared/orchestration/telemetry';

/** Only the application supplies repository identity, planner access and telemetry. */
export interface ConversationDelegation {
  context(session: AgentSession): DelegationContext | undefined;
  delegate(request: { folder: string; objective: string; acceptanceCriteria: string[]; origin: { provider: 'claude' | 'codex'; sessionId: string } }): Promise<unknown>;
  record(record: DelegationSuggestionRecord): void;
}

/** One pending send. Classification can only publish an offer, never call the planner. */
export class DelegationSuggestion {
  offer?: DelegationOffer;
  private settle?: (outcome: DelegationOfferOutcome) => void;

  constructor(private readonly publish: (offer?: DelegationOffer) => void) {}

  decide(id: string, outcome: DelegationOfferOutcome): void {
    if (this.offer?.id !== id || !['accepted', 'declined', 'ignored'].includes(outcome)) return;
    this.settle?.(outcome);
  }

  async intercept(text: string, session: AgentSession, service: ConversationDelegation | undefined, signal: AbortSignal): Promise<boolean> {
    const context = service?.context(session);
    if (!service || !context || assessDelegation(text, context).decision !== 'offer') return false;
    if (signal.aborted) throw new Error('Send cancelled; your draft was kept.');
    const offer = delegationOffer(randomUUID(), text, context);
    const started = Date.now();
    const outcome = await new Promise<DelegationOfferOutcome>((resolve) => {
      const abort = () => finish('ignored');
      const finish = (result: DelegationOfferOutcome) => {
        signal.removeEventListener('abort', abort);
        this.settle = undefined;
        this.offer = undefined;
        this.publish(undefined);
        resolve(result);
      };
      this.offer = offer;
      this.settle = finish;
      signal.addEventListener('abort', abort, { once: true });
      this.publish(offer);
    });
    // Whitelist fields: no prompt, criterion, repository path or session title.
    try {
      service.record({ v: 1, type: 'delegation-suggestion', id: offer.id, at: Date.now(),
        provider: session.provider, outcome, reason: 'bounded-work',
        assessorVersion: DELEGATION_INTENT_VERSION, repoPolicyVersion: context.policyVersion,
        durationMs: Date.now() - started });
    } catch { /* Observability must not break the user's action. */ }
    if (signal.aborted) throw new Error('Send cancelled; your draft was kept.');
    if (outcome !== 'accepted') return false;
    // Recheck availability after the human wait, before creating any proposal.
    const current = service.context(session);
    if (current?.repoRoot !== context.repoRoot) throw new Error('Repository is no longer available for delegation; your draft was kept.');
    await service.delegate({ folder: context.repoRoot, objective: offer.objective,
      acceptanceCriteria: offer.acceptanceCriteria,
      origin: { provider: session.provider, sessionId: session.sessionId } });
    return true;
  }
}

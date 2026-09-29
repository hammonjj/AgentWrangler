import type { DelegationOffer, DelegationOfferOutcome } from '../../shared/delegationIntent';

/** A click is required; no focus, keyboard shortcuts, or timer chooses Delegate. */
export function renderDelegationOffer(
  container: HTMLElement,
  offer: DelegationOffer | undefined,
  decide: (id: string, outcome: DelegationOfferOutcome) => void,
): void {
  container.replaceChildren();
  container.hidden = !offer;
  if (!offer) return;
  const card = document.createElement('div');
  card.className = 'blk ask proposal st-pending';
  const heading = document.createElement('strong');
  heading.className = 'askhead';
  heading.textContent = 'Delegate this work?';
  const reason = document.createElement('p');
  reason.className = 'qtext';
  reason.textContent = offer.reason;
  const details = document.createElement('details');
  details.className = 'propdetails';
  const summary = document.createElement('summary');
  summary.textContent = 'Review the handoff';
  const objective = document.createElement('p');
  objective.className = 'propobjective';
  objective.textContent = offer.objective;
  const repository = document.createElement('p');
  repository.className = 'propobjective';
  repository.textContent = `Repository: ${offer.repository}`;
  const criteria = document.createElement('ul');
  for (const text of offer.acceptanceCriteria) {
    const item = document.createElement('li');
    item.textContent = text;
    criteria.append(item);
  }
  details.append(summary, objective, repository, criteria);
  const note = document.createElement('p');
  note.className = 'asknote';
  note.textContent = 'Delegate prepares a plan for your approval. Work starts only after you approve it.';
  const buttons = document.createElement('div');
  buttons.className = 'askrow';
  let settled = false;
  for (const [outcome, label] of [
    ['accepted', 'Delegate'], ['declined', 'Keep working here'], ['ignored', 'Dismiss suggestion'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = outcome === 'accepted' ? 'askbtn primary' : 'askbtn';
    button.textContent = label;
    if (outcome === 'ignored') button.title = 'Dismiss and send this request in the conversation';
    button.addEventListener('click', () => {
      if (settled) return;
      settled = true;
      for (const child of buttons.querySelectorAll('button')) child.disabled = true;
      decide(offer.id, outcome);
    });
    buttons.append(button);
  }
  card.append(heading, reason, details, note, buttons);
  container.append(card);
}

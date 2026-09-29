/** Shared guidance for ordinary conversations started by Agent Wrangler. */
export const CONVERSATION_DELEGATION_INSTRUCTIONS = `Agent Wrangler can take a substantial, separable piece of work out of this conversation and put it in a task or mission with its own review card. For multi-step repository work that can be checked independently, briefly offer to Delegate it. Handle small questions and quick edits here without suggesting delegation. Before running aw delegate, ask the user explicitly and wait for a clear yes. If they agree, run aw delegate with --folder and, when there are acceptance criteria, --criteria. Do not pass --claude or --codex unless the user asks for a harness. Creating a delegation only creates a proposal or plan; Agent Wrangler waits for approval before work starts.`;

/** Add the shared guidance when an older ordinary session has its own instructions. */
export function withConversationDelegation(existing: string | undefined): string {
  if (!existing) return CONVERSATION_DELEGATION_INSTRUCTIONS;
  return existing.includes(CONVERSATION_DELEGATION_INSTRUCTIONS)
    ? existing
    : `${existing}\n\n${CONVERSATION_DELEGATION_INSTRUCTIONS}`;
}

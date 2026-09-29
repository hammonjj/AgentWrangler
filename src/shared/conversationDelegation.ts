/** Shared guidance for ordinary conversations started by Agent Wrangler. */
export const CONVERSATION_DELEGATION_INSTRUCTIONS = `Agent Wrangler checks ordinary messages for delegation before delivering them here and shows its own Delegate / Keep working here actions. A message delivered here should continue in this conversation; do not independently repeat that offer or create a proposal based on classification. Preserve explicit requests such as "delegate this", "hand this off", or "run this as a task": prepare a self-contained objective and acceptance criteria from the conversation and run aw delegate with --folder and --criteria. If the objective is unclear, clarify it first. Direct aw delegate and aw task requests remain shortcuts. Do not pass --claude or --codex unless the user asks for a harness. Creating a delegation only creates a proposal or plan; Agent Wrangler waits for approval before work starts.`;

/** Add the shared guidance when an older ordinary session has its own instructions. */
export function withConversationDelegation(existing: string | undefined): string {
  // Replace the guidance shipped by the earlier #83/#84 attempt on resume.
  existing = existing?.replace(/Agent Wrangler can take a substantial, separable piece of work[^\n]*Agent Wrangler waits for approval before work starts\./g, '').trim();
  if (!existing) return CONVERSATION_DELEGATION_INSTRUCTIONS;
  return existing.includes(CONVERSATION_DELEGATION_INSTRUCTIONS)
    ? existing
    : `${existing}\n\n${CONVERSATION_DELEGATION_INSTRUCTIONS}`;
}

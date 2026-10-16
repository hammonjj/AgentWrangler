/** A subagent's transcript, boiled down to the few lines a nested table row can show as progress. */
import type { ConvBlock } from '../shared/conversation';
import type { SubagentStep } from '../shared/messages';

/** How many of the newest steps are kept. */
export const MAX_STEPS = 12;
const MAX_TEXT = 240;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

/** Assistant replies and tool calls, oldest first; prompts, thinking, notes and asks are not progress. */
export function subagentSteps(blocks: readonly ConvBlock[]): SubagentStep[] {
  const steps: SubagentStep[] = [];
  for (const b of blocks) {
    if (b.kind === 'assistant') {
      const text = oneLine(b.text);
      if (text) steps.push({ kind: 'say', text });
    } else if (b.kind === 'tool') {
      const text = oneLine(b.inputPreview ? `${b.name} ${b.inputPreview}` : b.name);
      steps.push({ kind: 'tool', text, state: b.state });
    }
  }
  return steps.slice(-MAX_STEPS);
}

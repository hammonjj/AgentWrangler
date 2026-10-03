/**
 * What answering a host-held ask sends back: the `canUseTool` result
 * `RunnerView` sends a host for each button. Pure, so the shapes are tested.
 */
import type { QuestionView } from '../../shared/conversation';
import type { RawPermissionResult } from '../../shared/sessionProtocol';

/** The parts of a raw ask an answer needs. */
export interface AskInput {
  input: Record<string, unknown>;
  suggestions?: unknown[];
}

/** Allow, always-allow or deny a permission ask. */
export function permissionResult(ask: AskInput, decision: 'allow' | 'always' | 'deny', message?: string): RawPermissionResult {
  if (decision === 'deny') return { behavior: 'deny', message: message?.trim() || 'Denied from Agent Wrangler.' };
  return {
    behavior: 'allow',
    updatedInput: ask.input,
    // "Always allow" is Claude Code's own don't-ask-again: hand its own
    // suggestion back and it writes and persists the rule itself.
    ...(decision === 'always' && ask.suggestions?.length ? { updatedPermissions: ask.suggestions } : {}),
  };
}

/** An `AskUserQuestion` is allowed *with* the answers filled in. */
export function questionResult(ask: AskInput, answers: Record<string, string>): RawPermissionResult {
  return { behavior: 'allow', updatedInput: { ...ask.input, answers } };
}

/** Approve a plan, or reject it with feedback for the model. */
export function planResult(ask: AskInput, approve: boolean, feedback?: string): RawPermissionResult {
  return approve
    ? { behavior: 'allow', updatedInput: ask.input }
    : { behavior: 'deny', message: feedback?.trim() || 'Keep planning: that plan was not approved.' };
}

/** `AskUserQuestion`'s input, defensively: it is foreign JSON like any tool's. */
export function parseQuestions(raw: unknown): QuestionView[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionView[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const qq = q as Record<string, unknown>;
    if (typeof qq.question !== 'string') continue;
    const options = Array.isArray(qq.options)
      ? qq.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
          .map((o) => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : '',
          }))
          .filter((o) => o.label !== '')
      : [];
    out.push({
      question: qq.question,
      header: typeof qq.header === 'string' ? qq.header : '',
      multiSelect: qq.multiSelect === true,
      options,
    });
  }
  return out;
}

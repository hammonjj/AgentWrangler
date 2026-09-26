/**
 * What answering a host-held ask sends back, and what a pending one looks like
 * to the row and the remote.
 *
 * Pure, and shared by the two things that answer asks over a host's socket:
 * `RunnerView` (the app's copy of a session) and the remote daemon's
 * `HostedAsks` (which follows hosts while the app is not running). Both must
 * send the host exactly the same `canUseTool` result for the same button, so
 * the shapes live here once rather than in each.
 */
import { capBlock, type QuestionView } from '../../shared/conversation';
import type { AgentSession } from '../../shared/model';
import type { RawAsk, RawPermissionResult } from '../../shared/sessionProtocol';
import { permissionDetail } from '../permissionDetail';

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

/** Which card a raw ask is. */
export function askKind(toolName: string): 'question' | 'plan' | 'permission' {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'permission';
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

/** A host-held permission as the row and the remote show it (`HostedPermission`). */
export interface PendingPermissionView {
  requestId: string;
  toolName: string;
  ask: NonNullable<AgentSession['blockedAsk']>;
}

/**
 * The newest pending ask of each kind, as `DecoratedSessions` takes them.
 * Newest because that is the one being asked: `RunnerView` reads its blocks
 * backwards for the same reason.
 */
export function pendingViews(
  asks: readonly RawAsk[],
  cwd: string,
): {
  permission?: PendingPermissionView;
  question?: NonNullable<AgentSession['pendingQuestion']>;
  plan?: NonNullable<AgentSession['pendingPlan']>;
} {
  const out: ReturnType<typeof pendingViews> = {};
  for (let i = asks.length - 1; i >= 0; i--) {
    const raw = asks[i];
    const kind = askKind(raw.toolName);
    if (kind === 'question' && !out.question) {
      out.question = { requestId: raw.requestId, questions: parseQuestions(raw.input.questions) };
    } else if (kind === 'plan' && !out.plan) {
      const capped = capBlock(new Map(), `a:${raw.requestId}`, typeof raw.input.plan === 'string' ? raw.input.plan : '');
      out.plan = { requestId: raw.requestId, plan: capped.text, more: capped.more };
    } else if (kind === 'permission' && !out.permission) {
      const detail = permissionDetail(raw.toolName, raw.input, cwd);
      out.permission = {
        requestId: raw.requestId,
        toolName: raw.toolName,
        ask: { summary: raw.title ?? detail?.summary, body: detail?.body, isCommand: detail?.isCommand },
      };
    }
  }
  return out;
}

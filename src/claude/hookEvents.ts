/**
 * Pure parsing/reduction of Claude Code hook events into per-session status.
 *
 * Claude Code runs a command on lifecycle events and writes a JSON payload to
 * its stdin; our installed hook appends that payload verbatim as one line to a
 * per-pid log. This module turns those lines into authoritative status, which
 * is what the transcript can never give us: a permission prompt, a tool that is
 * still in flight, and a genuinely wedged session all look identical in a
 * transcript tail.
 *
 * No filesystem access here — `hookLog.ts` owns that — so the reduction is
 * unit-testable against synthetic lines.
 */
import type { PermissionAsk, SessionStatus, TodoProgress } from '../shared/model';
import { parsePermissionSuggestions, permissionDetail, type PermissionSuggestion } from './permissionDetail';

/**
 * Written by our own PermissionRequest hook script, right after the payload it
 * relays: names the marker file the script is now waiting on, so the dashboard
 * can offer Allow/Deny for exactly that prompt. Not a Claude Code event.
 */
export const PERMISSION_PENDING_EVENT = 'AgentWranglerPermissionPending';

/**
 * Tools that block on the human by design rather than by permission: the
 * agent has asked a question and `PreToolUse` fires while it waits for the
 * answer. Rendered as blocked with the question as the detail, not as a
 * long-running tool.
 */
const INTERACTIVE_TOOLS: Record<string, string> = {
  AskUserQuestion: 'answer',
  ExitPlanMode: 'plan approval',
};

/**
 * Events we register. Every one of these exists in Claude Code 2.1.227 (the
 * Homebrew CLI on PATH) as well as 2.1.266 (bundled in the VSCode extension) —
 * the two installs differ only by the model-switch pair, which we don't use.
 *
 * `PermissionRequest` is the load-bearing one: it fires the instant a
 * permission dialog opens, whereas `Notification`/`permission_prompt` is on a
 * 6-second timer and would make the dashboard feel laggy.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionRequest',
  'PermissionDenied',
  'Stop',
  'StopFailure',
  'Notification',
  'Elicitation',
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Fields we read off a payload. Everything is optional — the log is foreign input. */
export interface HookEvent {
  hookEventName: string;
  sessionId: string;
  cwd?: string;
  toolName?: string;
  /** `Notification` only: permission_prompt | idle_prompt | agent_needs_input | … */
  notificationType?: string;
  /** `SessionEnd` only: clear | resume | logout | prompt_input_exit | other. */
  reason?: string;
  /** `SessionStart` only: startup | resume | clear | compact. */
  source?: string;
  /**
   * `Stop` only: the text of the reply that ended the turn, as Claude Code
   * hands it to the hook. What decides Waiting-on-you vs Done.
   */
  lastAssistantMessage?: string;
  /** `PermissionRequest` / interactive `PreToolUse`: what the ask is for. */
  detail?: PermissionAsk;
  /**
   * `PermissionRequest` only: the permission updates Claude Code's own "don't
   * ask again" would apply. Handed straight back in an *Always allow* decision.
   */
  suggestions?: PermissionSuggestion[];
  /** Our own pending marker (see `PERMISSION_PENDING_EVENT`). */
  requestId?: string;
  /** Set on subagent events; those are folded into the parent, never shown as sessions. */
  agentId?: string;
  /**
   * `TodoWrite` only: the checklist reduced to counts. The rest of `tool_input`
   * is dropped at parse time — payloads reach tens of KB and none of it is state
   * we need to keep per session.
   */
  todo?: TodoProgress;
  /** Our receipt time. Hook payloads carry no timestamp of their own. */
  receivedAtMs: number;
}

/** Rolling state for one session, derived from its event stream. */
export interface HookSessionState {
  sessionId: string;
  cwd?: string;
  status: SessionStatus;
  /** Why we're blocked (tool name / elicitation label), for the row subtitle. */
  blockedReason?: string;
  /** What the block is for (the command, the file, the question). */
  blockedDetail?: PermissionAsk;
  /** Marker our hook script is waiting on; cleared the moment anything unblocks. */
  permissionRequestId?: string;
  /** What an *Always allow* would hand back to Claude Code for this prompt. */
  permissionSuggestions?: PermissionSuggestion[];
  /**
   * True from `SessionStart` until the first prompt: the session exists but
   * nothing has happened in it yet. The dashboard hides such sessions when
   * they also have no transcript — an empty conversation is not waiting on
   * anyone.
   */
  fresh: boolean;
  /**
   * The reply that ended the most recent turn (`Stop.last_assistant_message`),
   * or undefined when the turn ended without one being reported. Read once to
   * split waiting from done; not kept across the next prompt.
   */
  lastReply?: string;
  /** The last turn ended in `StopFailure`: an error the human should see, never "done". */
  turnFailed?: boolean;
  /** Tool in flight: PreToolUse seen with no matching completion yet. */
  activeTool?: { name: string; sinceMs: number };
  /** Receipt time of the most recent event — drives genuine-stall detection. */
  lastEventAtMs: number;
  lastEventName: string;
  /** True once SessionEnd arrives; the pid usually disappears at the same time. */
  finished: boolean;

  // ---- current turn ----
  /**
   * Receipt time of the `UserPromptSubmit` that began the turn in flight, or
   * undefined between turns. A session already running when hooks were installed
   * never gets one, and correctly reports no progress rather than a guess.
   */
  turnStartedAtMs?: number;
  /** Tool calls since the turn began. */
  turnToolCalls: number;
  /** Time this turn has already spent parked on a human, in ms. */
  turnBlockedMs: number;
  /** Set while blocked; folded into `turnBlockedMs` when the human answers. */
  blockedSinceMs?: number;
  /**
   * True when `turnStartedAtMs` came from replaying a log backlog rather than
   * from watching the event arrive. Hook payloads carry no timestamp of their
   * own, so a backlog read stamps the whole file with one receipt time — a turn
   * already 20 minutes old would otherwise report as seconds. Consumers must
   * suppress elapsed/pace while this is set; the next real prompt clears it.
   */
  turnStartUncertain?: boolean;
  /** Latest `TodoWrite` snapshot for this turn. */
  todo?: TodoProgress;
  /**
   * Working duration of the turn that just finished, in ms — set on the state
   * transition that ends a turn and left in place afterwards. `HookLog` watches
   * it change to feed the pace baseline; nothing else reads it.
   */
  lastTurnMs?: number;
}

/**
 * Notification types that mean a human has to act. `idle_prompt` is deliberately
 * absent: it only fires after CLAUDE_CODE_IDLE_THRESHOLD_MINUTES, which defaults
 * to 75 minutes, so it is useless as a live signal — `Stop` is the real
 * end-of-turn event.
 */
const BLOCKING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'agent_needs_input',
  'worker_permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
]);

/**
 * Parse one log line. Returns undefined for anything we can't or shouldn't use:
 * malformed JSON (a torn write), events from subagents (`agent_id` — mirrors the
 * `isSidechain` drop in the transcript reader), and `served:` sessions, which are
 * remote calls rather than local sessions.
 */
export function parseHookLine(line: string, receivedAtMs: number): HookEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;

  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    obj = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const hookEventName = str(obj.hook_event_name);
  const sessionId = str(obj.session_id);
  if (!hookEventName || !sessionId) return undefined;
  if (sessionId.startsWith('served:')) return undefined;

  const agentId = str(obj.agent_id);
  if (agentId) return undefined;

  const toolName = str(obj.tool_name);
  const cwd = str(obj.cwd);
  // The subject line is only ever shown for a block, so it is only computed
  // for the events that can cause one — tool_input can be tens of KB.
  const wantsDetail =
    hookEventName === 'PermissionRequest' ||
    hookEventName === 'Elicitation' ||
    (hookEventName === 'PreToolUse' && toolName !== undefined && toolName in INTERACTIVE_TOOLS);
  return {
    hookEventName,
    sessionId: sessionId.toLowerCase(),
    cwd,
    toolName,
    notificationType: str(obj.notification_type),
    reason: str(obj.reason),
    source: str(obj.source),
    lastAssistantMessage: hookEventName === 'Stop' ? str(obj.last_assistant_message) : undefined,
    detail: wantsDetail ? permissionDetail(toolName, obj.tool_input, cwd) : undefined,
    suggestions:
      hookEventName === 'PermissionRequest' ? parsePermissionSuggestions(obj.permission_suggestions) : undefined,
    requestId: hookEventName === PERMISSION_PENDING_EVENT ? str(obj.request_id) : undefined,
    agentId: undefined,
    todo: toolName === TODO_TOOL ? parseTodos(obj.tool_input) : undefined,
    receivedAtMs,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const TODO_TOOL = 'TodoWrite';

/**
 * Reduce a `TodoWrite` payload to counts plus the item in flight. Shape:
 * `{ todos: [{ content, status: pending|in_progress|completed, activeForm }] }`.
 * An empty list is a real signal (the agent cleared its checklist), so it maps
 * to undefined rather than 0/0, which would render as a finished progress bar.
 */
export function parseTodos(toolInput: unknown): TodoProgress | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const todos = (toolInput as Record<string, unknown>).todos;
  if (!Array.isArray(todos) || todos.length === 0) return undefined;

  let completed = 0;
  let active: string | undefined;
  for (const t of todos) {
    if (typeof t !== 'object' || t === null) continue;
    const item = t as Record<string, unknown>;
    if (item.status === 'completed') completed++;
    else if (item.status === 'in_progress' && active === undefined) {
      active = str(item.activeForm) ?? str(item.content);
    }
  }
  return { completed, total: todos.length, active };
}

/**
 * Fold one event into a session's state. Unknown event names update liveness
 * (so a newer Claude Code emitting events we've never heard of still counts as
 * activity) without changing status.
 */
export function reduceHookEvent(prev: HookSessionState | undefined, e: HookEvent): HookSessionState {
  const base: HookSessionState = prev ?? {
    sessionId: e.sessionId,
    status: 'busy',
    lastEventAtMs: e.receivedAtMs,
    lastEventName: e.hookEventName,
    finished: false,
    // First sight of a session mid-stream (hooks installed after it started):
    // it has plainly done things, so it is not fresh.
    fresh: false,
    turnToolCalls: 0,
    turnBlockedMs: 0,
  };

  const next: HookSessionState = {
    ...base,
    cwd: e.cwd ?? base.cwd,
    lastEventAtMs: e.receivedAtMs,
    lastEventName: e.hookEventName,
  };

  switch (e.hookEventName) {
    case 'SessionStart':
      // A fresh session sits at its prompt until the user says something. A
      // resume is fresh too in the sense that matters here — no prompt yet —
      // but it has a transcript, so the provider keeps it visible.
      return {
        ...next,
        ...clearTurn(),
        ...unblocked(),
        status: 'waiting',
        activeTool: undefined,
        fresh: true,
        lastReply: undefined,
        turnFailed: false,
      };

    case 'SessionEnd':
      // A turn cut short by an exit never completed, so it is not baseline data.
      return {
        ...next,
        ...clearTurn(),
        ...unblocked(),
        status: 'ended',
        activeTool: undefined,
        finished: true,
      };

    case 'UserPromptSubmit':
      // Also fires when a queued prompt is picked up: the clock restarts, which
      // is what "how long has the current work been running" should mean.
      return {
        ...next,
        ...unblocked(),
        status: 'busy',
        activeTool: undefined,
        fresh: false,
        lastReply: undefined,
        turnFailed: false,
        turnStartedAtMs: e.receivedAtMs,
        turnToolCalls: 0,
        turnBlockedMs: 0,
        blockedSinceMs: undefined,
        turnStartUncertain: false,
        todo: undefined,
      };

    case 'PreToolUse': {
      const interactive = e.toolName !== undefined ? INTERACTIVE_TOOLS[e.toolName] : undefined;
      if (interactive !== undefined) {
        // The tool *is* the wait: it runs until the human answers. Permission
        // (if any) is already settled by now, so the blocked clock keeps going
        // rather than restarting.
        return {
          ...next,
          ...block(base, e.receivedAtMs),
          status: 'blocked',
          blockedReason: interactive,
          blockedDetail: e.detail,
          permissionRequestId: undefined,
          permissionSuggestions: undefined,
          activeTool: undefined,
          fresh: false,
          turnToolCalls: base.turnToolCalls + 1,
        };
      }
      // Reached only once permission is settled, so it also ends a blocked spell.
      return {
        ...next,
        ...unblock(base, e.receivedAtMs),
        ...unblocked(),
        status: 'busy',
        activeTool: { name: e.toolName ?? 'tool', sinceMs: e.receivedAtMs },
        fresh: false,
        turnToolCalls: base.turnToolCalls + 1,
        todo: e.todo ?? base.todo,
      };
    }

    // Any completion clears the in-flight tool. PostToolBatch fires once per
    // batch, so it also covers tools whose individual events we missed.
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PostToolBatch':
      return {
        ...next,
        ...unblock(base, e.receivedAtMs),
        ...unblocked(),
        status: 'busy',
        activeTool: undefined,
        fresh: false,
        todo: e.todo ?? base.todo,
      };

    case 'PermissionRequest':
      return {
        ...next,
        ...block(base, e.receivedAtMs),
        status: 'blocked',
        blockedReason: e.toolName ?? 'permission',
        blockedDetail: e.detail,
        // A new prompt supersedes any marker from the previous one.
        permissionRequestId: undefined,
        permissionSuggestions: e.suggestions,
        fresh: false,
      };

    case PERMISSION_PENDING_EVENT:
      // Only meaningful while the prompt it belongs to is still open.
      return base.status === 'blocked' ? { ...next, permissionRequestId: e.requestId } : next;

    case 'PermissionDenied':
      // The user answered, so we're no longer blocked; the turn continues.
      return { ...next, ...unblock(base, e.receivedAtMs), ...unblocked(), status: 'busy' };

    case 'Elicitation':
      return {
        ...next,
        ...block(base, e.receivedAtMs),
        status: 'blocked',
        blockedReason: e.toolName ?? 'input',
        blockedDetail: e.detail,
        permissionRequestId: undefined,
        permissionSuggestions: undefined,
        fresh: false,
      };

    case 'Notification':
      if (e.notificationType && BLOCKING_NOTIFICATIONS.has(e.notificationType)) {
        return {
          ...next,
          ...block(base, e.receivedAtMs),
          status: 'blocked',
          blockedReason: base.blockedReason ?? e.toolName ?? 'input',
          fresh: false,
        };
      }
      return next; // liveness only — login/completion notices say nothing about status

    case 'Stop':
    case 'StopFailure': {
      const settled = unblock(base, e.receivedAtMs);
      // The one place a turn is known to have finished: its working duration
      // becomes a sample for the pace baseline.
      const lastTurnMs =
        base.turnStartedAtMs === undefined
          ? base.lastTurnMs
          : Math.max(0, e.receivedAtMs - base.turnStartedAtMs - settled.turnBlockedMs);
      return {
        ...next,
        ...clearTurn(),
        ...unblocked(),
        // `waiting` here means "turn over, idle at the prompt". Whether the
        // reply asked anything — waiting vs done — is the provider's call,
        // made from `lastReply` (or the transcript when that is missing).
        status: 'waiting',
        activeTool: undefined,
        fresh: false,
        lastReply: e.lastAssistantMessage,
        turnFailed: e.hookEventName === 'StopFailure',
        lastTurnMs,
      };
    }

    default:
      return next;
  }
}

/** Fields a block sets, reset together whenever the block ends. */
function unblocked(): Pick<
  HookSessionState,
  'blockedReason' | 'blockedDetail' | 'permissionRequestId' | 'permissionSuggestions'
> {
  return {
    blockedReason: undefined,
    blockedDetail: undefined,
    permissionRequestId: undefined,
    permissionSuggestions: undefined,
  };
}

type TurnFields = Pick<
  HookSessionState,
  'turnStartedAtMs' | 'turnToolCalls' | 'turnBlockedMs' | 'blockedSinceMs' | 'turnStartUncertain' | 'todo'
>;

function clearTurn(): TurnFields {
  return {
    turnStartedAtMs: undefined,
    turnToolCalls: 0,
    turnBlockedMs: 0,
    blockedSinceMs: undefined,
    turnStartUncertain: false,
    todo: undefined,
  };
}

/** Start the blocked clock, unless it is already running (a repeat notification). */
function block(base: HookSessionState, nowMs: number): Pick<HookSessionState, 'blockedSinceMs'> {
  return { blockedSinceMs: base.blockedSinceMs ?? nowMs };
}

/** Stop the blocked clock and bank the time spent waiting on a human. */
function unblock(base: HookSessionState, nowMs: number): Pick<HookSessionState, 'turnBlockedMs' | 'blockedSinceMs'> {
  if (base.blockedSinceMs === undefined) return { turnBlockedMs: base.turnBlockedMs, blockedSinceMs: undefined };
  return {
    turnBlockedMs: base.turnBlockedMs + Math.max(0, nowMs - base.blockedSinceMs),
    blockedSinceMs: undefined,
  };
}

/**
 * Blocked time so far this turn, counting a spell that is still open. Without
 * the open spell a session sitting on a permission prompt would keep accruing
 * "working" time it isn't doing.
 */
export function turnBlockedMsAt(st: HookSessionState, nowMs: number): number {
  const open = st.blockedSinceMs === undefined ? 0 : Math.max(0, nowMs - st.blockedSinceMs);
  return st.turnBlockedMs + open;
}

/**
 * Final status for a session, applying the one time-based rule that survives:
 * a hook-reporting session that has gone completely silent — no events at all,
 * nothing in flight — is genuinely anomalous.
 *
 * Note what does NOT become stuck: a session with a tool in flight stays `busy`
 * however long it runs, because a 20-minute test suite is work, not a stall.
 * That distinction is the entire reason for this module.
 */
export function statusFromHookState(
  st: HookSessionState,
  nowMs: number,
  stuckThresholdMs: number,
): SessionStatus {
  if (st.status === 'blocked' || st.status === 'waiting' || st.status === 'done' || st.status === 'ended') {
    return st.status;
  }
  if (st.activeTool) return 'busy';
  return nowMs - st.lastEventAtMs > stuckThresholdMs ? 'stuck' : 'busy';
}

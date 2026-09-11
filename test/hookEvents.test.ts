import { describe, expect, it } from 'vitest';
import {
  parseHookLine,
  parseTodos,
  reduceHookEvent,
  statusFromHookState,
  turnBlockedMsAt,
  type HookSessionState,
} from '../src/claude/hookEvents';

const SID = '11111111-2222-3333-4444-555555555555';
const T0 = 1_700_000_000_000;

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function feed(events: Record<string, unknown>[], startMs = T0, stepMs = 1000): HookSessionState {
  let st: HookSessionState | undefined;
  events.forEach((e, i) => {
    const parsed = parseHookLine(line({ session_id: SID, ...e }), startMs + i * stepMs);
    if (!parsed) throw new Error(`unparseable test event: ${JSON.stringify(e)}`);
    st = reduceHookEvent(st, parsed);
  });
  if (!st) throw new Error('no events');
  return st;
}

/** One parsed event at an explicit receipt time, for tests that need real gaps. */
function ev(hookEventName: string, atMs: number, extra: Record<string, unknown> = {}) {
  const parsed = parseHookLine(line({ hook_event_name: hookEventName, session_id: SID, ...extra }), atMs);
  if (!parsed) throw new Error(`unparseable test event: ${hookEventName}`);
  return parsed;
}

describe('parseHookLine', () => {
  it('extracts the fields we need', () => {
    const e = parseHookLine(
      line({
        hook_event_name: 'PreToolUse',
        session_id: SID,
        cwd: '/proj',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
      T0,
    );
    expect(e).toMatchObject({ hookEventName: 'PreToolUse', sessionId: SID, cwd: '/proj', toolName: 'Bash' });
    expect(e?.receivedAtMs).toBe(T0);
  });

  it('lowercases the session id so it matches registry/transcript keys', () => {
    const upper = SID.toUpperCase();
    expect(parseHookLine(line({ hook_event_name: 'Stop', session_id: upper }), T0)?.sessionId).toBe(SID);
  });

  it('skips torn and empty lines instead of throwing', () => {
    // A concurrent large write can leave a partial line; it must not kill the pass.
    expect(parseHookLine('{"hook_event_name":"PreToolUse","session_id":"abc","tool_inp', T0)).toBeUndefined();
    expect(parseHookLine('', T0)).toBeUndefined();
    expect(parseHookLine('   ', T0)).toBeUndefined();
    expect(parseHookLine('null', T0)).toBeUndefined();
    expect(parseHookLine('[1,2,3]', T0)).toBeUndefined();
  });

  it('requires both event name and session id', () => {
    expect(parseHookLine(line({ hook_event_name: 'Stop' }), T0)).toBeUndefined();
    expect(parseHookLine(line({ session_id: SID }), T0)).toBeUndefined();
  });

  it('drops subagent events', () => {
    // Subagents get their own agent_id; they are folded into the parent session
    // upstream and must never surface as sessions of their own.
    const e = parseHookLine(line({ hook_event_name: 'Stop', session_id: SID, agent_id: 'agent-1' }), T0);
    expect(e).toBeUndefined();
  });

  it('drops served: (remote call) sessions', () => {
    expect(parseHookLine(line({ hook_event_name: 'Stop', session_id: 'served:abc' }), T0)).toBeUndefined();
  });
});

describe('reduceHookEvent', () => {
  it('marks a fresh session as waiting at its prompt, and flags it as untouched', () => {
    const st = feed([{ hook_event_name: 'SessionStart', source: 'startup' }]);
    expect(st.status).toBe('waiting');
    // Nothing has happened here yet; with no transcript either, the provider hides it.
    expect(st.fresh).toBe(true);
    expect(feed([{ hook_event_name: 'SessionStart' }, { hook_event_name: 'UserPromptSubmit' }]).fresh).toBe(false);
  });

  it('is not fresh when first seen mid-stream (hooks installed after it started)', () => {
    expect(feed([{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }]).fresh).toBe(false);
  });

  it('goes busy on prompt submit and waiting again on Stop', () => {
    expect(feed([{ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }]).status).toBe('busy');
    expect(feed([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'Stop' }]).status).toBe('waiting');
  });

  it('keeps the reply that ended the turn, for the waiting/done split', () => {
    const st = feed([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'Stop', last_assistant_message: 'All done, nothing committed.' },
    ]);
    expect(st.lastReply).toBe('All done, nothing committed.');
    expect(st.turnFailed).toBe(false);
    // The next prompt spends it.
    const next = reduceHookEvent(st, ev('UserPromptSubmit', T0 + 5000));
    expect(next.lastReply).toBeUndefined();
  });

  it('treats StopFailure as end-of-turn too, and marks the turn failed', () => {
    const st = feed([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'StopFailure' }]);
    expect(st.status).toBe('waiting');
    expect(st.turnFailed).toBe(true);
  });

  it('blocks on PermissionRequest and names the tool', () => {
    const st = feed([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    ]);
    expect(st.status).toBe('blocked');
    expect(st.blockedReason).toBe('Bash');
  });

  it('carries what the permission is for, and what an Always would allow', () => {
    const suggestion = {
      type: 'addRules',
      destination: 'localSettings',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    };
    const st = feed([
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'npm test', description: 'Run the tests' },
        permission_suggestions: [suggestion],
      },
    ]);
    expect(st.blockedDetail).toEqual({ summary: 'Run the tests', body: 'npm test', isCommand: true });
    expect(st.permissionSuggestions).toEqual([suggestion]);
    // Cleared with the block.
    const after = reduceHookEvent(st, ev('PreToolUse', T0 + 1000, { tool_name: 'Bash' }));
    expect(after.blockedDetail).toBeUndefined();
    expect(after.permissionSuggestions).toBeUndefined();
  });

  it('treats a question to the user as blocked, with the question as the detail', () => {
    // AskUserQuestion runs until the human answers: PreToolUse fires, then nothing.
    const st = feed([
      { hook_event_name: 'UserPromptSubmit' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Ship it?', header: 'Ship', options: [] }] },
      },
    ]);
    expect(st.status).toBe('blocked');
    expect(st.blockedReason).toBe('answer');
    expect(st.blockedDetail?.body).toBe('Ship it?');
    expect(st.activeTool).toBeUndefined();
    // Answered: the tool completes and the turn goes on.
    expect(reduceHookEvent(st, ev('PostToolUse', T0 + 9000, { tool_name: 'AskUserQuestion' })).status).toBe('busy');
  });

  it('attaches our pending marker to the open prompt, and drops it when the prompt is answered', () => {
    const open = feed([
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      { hook_event_name: 'AgentWranglerPermissionPending', request_id: '4242-777' },
    ]);
    expect(open.permissionRequestId).toBe('4242-777');

    for (const answer of [
      ev('PreToolUse', T0 + 5000, { tool_name: 'Bash' }),
      ev('PermissionDenied', T0 + 5000, { tool_name: 'Bash' }),
      ev('Stop', T0 + 5000),
      ev('UserPromptSubmit', T0 + 5000),
    ]) {
      expect(reduceHookEvent(open, answer).permissionRequestId, answer.hookEventName).toBeUndefined();
    }
    // A second prompt supersedes the first marker rather than inheriting it.
    expect(reduceHookEvent(open, ev('PermissionRequest', T0 + 5000, { tool_name: 'Edit' })).permissionRequestId).toBeUndefined();
  });

  it('ignores a pending marker that arrives when nothing is blocked', () => {
    const st = feed([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'AgentWranglerPermissionPending', request_id: '1-2' },
    ]);
    expect(st.status).toBe('busy');
    expect(st.permissionRequestId).toBeUndefined();
  });

  it('unblocks once the user answers', () => {
    const denied = feed([
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      { hook_event_name: 'PermissionDenied', tool_name: 'Bash', reason: 'no' },
    ]);
    expect(denied.status).toBe('busy');
    expect(denied.blockedReason).toBeUndefined();

    // Granting permission is followed by the tool actually running.
    const granted = feed([
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    ]);
    expect(granted.status).toBe('busy');
    expect(granted.blockedReason).toBeUndefined();
  });

  it('tracks the in-flight tool and clears it on completion', () => {
    const running = feed([{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }]);
    expect(running.activeTool).toEqual({ name: 'Bash', sinceMs: T0 });

    for (const done of ['PostToolUse', 'PostToolUseFailure', 'PostToolBatch']) {
      const st = feed([{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { hook_event_name: done }]);
      expect(st.activeTool, done).toBeUndefined();
    }
  });

  it('blocks on notification types that need a human, ignores the rest', () => {
    expect(feed([{ hook_event_name: 'Notification', notification_type: 'permission_prompt' }]).status).toBe(
      'blocked',
    );
    expect(feed([{ hook_event_name: 'Notification', notification_type: 'agent_needs_input' }]).status).toBe(
      'blocked',
    );
    // A login notice says nothing about whether the agent needs you.
    const busy = feed([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'Notification', notification_type: 'auth_success' },
    ]);
    expect(busy.status).toBe('busy');
  });

  it('ignores idle_prompt, which only fires after ~75 minutes', () => {
    // Reacting to it would be harmless but misleading; Stop is the real signal.
    const st = feed([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
    ]);
    expect(st.status).toBe('busy');
  });

  it('ends on SessionEnd', () => {
    const st = feed([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'SessionEnd', reason: 'clear' }]);
    expect(st.status).toBe('ended');
    expect(st.finished).toBe(true);
  });

  it('counts an unknown event as activity without changing status', () => {
    // A newer Claude Code may emit events this build has never heard of.
    const st = feed([
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
      { hook_event_name: 'SomeFutureEvent' },
    ]);
    expect(st.status).toBe('blocked');
    expect(st.lastEventAtMs).toBe(T0 + 1000);
    expect(st.lastEventName).toBe('SomeFutureEvent');
  });
});

describe('parseTodos', () => {
  const todos = (items: Record<string, unknown>[]) => parseTodos({ todos: items });

  it('counts completed items and names the one in flight', () => {
    const t = todos([
      { content: 'a', status: 'completed', activeForm: 'Doing a' },
      { content: 'b', status: 'completed', activeForm: 'Doing b' },
      { content: 'c', status: 'in_progress', activeForm: 'Doing c' },
      { content: 'd', status: 'pending', activeForm: 'Doing d' },
    ]);
    expect(t).toEqual({ completed: 2, total: 4, active: 'Doing c' });
  });

  it('falls back to content when activeForm is missing', () => {
    expect(todos([{ content: 'Fix the build', status: 'in_progress' }])?.active).toBe('Fix the build');
  });

  it('reports no active item when nothing is in progress', () => {
    expect(todos([{ content: 'a', status: 'pending' }])).toEqual({ completed: 0, total: 1, active: undefined });
  });

  it('treats a cleared list as no checklist, not as 0/0', () => {
    // 0/0 would render as an empty progress bar on a session with no todos.
    expect(todos([])).toBeUndefined();
    expect(parseTodos({})).toBeUndefined();
    expect(parseTodos(undefined)).toBeUndefined();
    expect(parseTodos('nope')).toBeUndefined();
    expect(parseTodos({ todos: 'nope' })).toBeUndefined();
  });

  it('survives junk entries inside a well-formed list', () => {
    expect(todos([{ content: 'a', status: 'completed' }, null as never, 42 as never])).toEqual({
      completed: 1,
      total: 3,
      active: undefined,
    });
  });

  it('is only read off TodoWrite payloads', () => {
    const todoInput = { todos: [{ content: 'a', status: 'completed' }] };
    const write = parseHookLine(
      line({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'TodoWrite', tool_input: todoInput }),
      T0,
    );
    expect(write?.todo).toEqual({ completed: 1, total: 1, active: undefined });

    // A Bash payload that happens to contain a `todos` key is not a checklist.
    const bash = parseHookLine(
      line({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: 'Bash', tool_input: todoInput }),
      T0,
    );
    expect(bash?.todo).toBeUndefined();
  });
});

describe('turn tracking', () => {
  it('starts a turn on prompt submit and clears it at Stop', () => {
    const running = feed([{ hook_event_name: 'UserPromptSubmit' }]);
    expect(running.turnStartedAtMs).toBe(T0);

    const done = feed([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'Stop' }]);
    expect(done.turnStartedAtMs).toBeUndefined();
    expect(done.lastTurnMs).toBe(1000);
  });

  it('counts tool calls within the turn and resets them on the next prompt', () => {
    const st = feed([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read' },
    ]);
    expect(st.turnToolCalls).toBe(2);

    const next = reduceHookEvent(st, parseHookLine(line({ hook_event_name: 'UserPromptSubmit', session_id: SID }), T0 + 9000)!);
    expect(next.turnToolCalls).toBe(0);
    expect(next.turnStartedAtMs).toBe(T0 + 9000);
  });

  it('excludes time parked on a permission prompt from the turn duration', () => {
    // Prompt at T0, permission asked at +1s, granted at +61s, Stop at +71s:
    // 71s wall clock, 60s of it waiting on a human, so 11s of actual work.
    let s = reduceHookEvent(undefined, ev('UserPromptSubmit', T0));
    s = reduceHookEvent(s, ev('PermissionRequest', T0 + 1000, { tool_name: 'Bash' }));
    s = reduceHookEvent(s, ev('PreToolUse', T0 + 61_000, { tool_name: 'Bash' }));
    s = reduceHookEvent(s, ev('Stop', T0 + 71_000));
    expect(s.lastTurnMs).toBe(11_000);
  });

  it('keeps the blocked clock running while the prompt is still open', () => {
    let s = reduceHookEvent(undefined, ev('UserPromptSubmit', T0));
    s = reduceHookEvent(s, ev('PermissionRequest', T0 + 1000, { tool_name: 'Bash' }));
    expect(turnBlockedMsAt(s, T0 + 31_000)).toBe(30_000);

    // A repeat notification for the same prompt must not restart the clock.
    s = reduceHookEvent(s, ev('Notification', T0 + 7000, { notification_type: 'permission_prompt' }));
    expect(turnBlockedMsAt(s, T0 + 31_000)).toBe(30_000);
  });

  it('tracks the checklist across the turn and drops it on the next prompt', () => {
    const todoInput = (items: Record<string, unknown>[]) => ({ todos: items });
    let s = reduceHookEvent(undefined, ev('UserPromptSubmit', T0));
    s = reduceHookEvent(
      s,
      ev('PreToolUse', T0 + 1000, {
        tool_name: 'TodoWrite',
        tool_input: todoInput([
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
        ]),
      }),
    );
    expect(s.todo).toEqual({ completed: 1, total: 2, active: 'Doing b' });

    // An unrelated tool call leaves the checklist alone.
    s = reduceHookEvent(s, ev('PreToolUse', T0 + 2000, { tool_name: 'Bash' }));
    expect(s.todo).toEqual({ completed: 1, total: 2, active: 'Doing b' });

    s = reduceHookEvent(s, ev('UserPromptSubmit', T0 + 3000));
    expect(s.todo).toBeUndefined();
  });

  it('does not report a turn duration for a session killed mid-turn', () => {
    // SessionEnd is an exit, not a completion; it must not become baseline data.
    const st = feed([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'SessionEnd' }]);
    expect(st.lastTurnMs).toBeUndefined();
    expect(st.turnStartedAtMs).toBeUndefined();
  });

  it('reports no turn for a session whose prompt we never saw', () => {
    // Hooks installed mid-session: tools fire with no UserPromptSubmit ahead of
    // them, and an invented start time would be worse than none.
    const st = feed([{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { hook_event_name: 'Stop' }]);
    expect(st.lastTurnMs).toBeUndefined();
  });
});

describe('statusFromHookState', () => {
  const threshold = 60_000;

  it('keeps a long-running tool busy however long it takes', () => {
    // The whole point: a 20-minute test suite is work, not a stall.
    const st = feed([{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }]);
    expect(statusFromHookState(st, T0 + 20 * 60_000, threshold)).toBe('busy');
  });

  it('reports stuck only when nothing is in flight and all events stopped', () => {
    const st = feed([{ hook_event_name: 'PostToolBatch' }]);
    expect(statusFromHookState(st, T0 + 30_000, threshold)).toBe('busy');
    expect(statusFromHookState(st, T0 + 61_000, threshold)).toBe('stuck');
  });

  it('never downgrades a state a human has to act on', () => {
    const blocked = feed([{ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }]);
    const waiting = feed([{ hook_event_name: 'Stop' }]);
    const ended = feed([{ hook_event_name: 'SessionEnd' }]);
    const long = T0 + 86_400_000;
    expect(statusFromHookState(blocked, long, threshold)).toBe('blocked');
    expect(statusFromHookState(waiting, long, threshold)).toBe('waiting');
    expect(statusFromHookState(ended, long, threshold)).toBe('ended');
  });

  it('never turns a blocked question into stuck, however long it goes unanswered', () => {
    const asked = feed([{ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }]);
    expect(statusFromHookState(asked, T0 + 86_400_000, threshold)).toBe('blocked');
  });
});

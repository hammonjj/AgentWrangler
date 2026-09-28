import { describe, expect, it } from 'vitest';
import {
  applyTaskChanges,
  countTasks,
  finishedTaskIdsIn,
  launchedTaskOf,
  liveTranscriptTasks,
  MAX_TRACKED_TASKS,
  parseHookBackgroundTasks,
  type BackgroundTaskRef,
} from '../src/claude/backgroundTasks';
import { backgroundTasksFor } from '../src/claude/claudeProvider';
import { parseHookLine, reduceHookEvent, statusFromHookState, type HookSessionState } from '../src/claude/hookEvents';
import { deriveStatus, holdForBackground } from '../src/claude/status';
import { mergeSummaries, parseSummaryLines, type TranscriptSummary } from '../src/claude/transcriptTail';
import { SessionStore } from '../src/core/sessionStore';
import { backgroundTasksChip, type AgentSession } from '../src/shared/model';
import { mkAssistant, mkText, mkToolResult, mkToolUse, mkUser } from './fixtures';

// Shapes recorded from Claude Code 2.1.281–2.1.283; ids, text and paths are synthetic.
const SID = '11111111-2222-3333-4444-555555555555';
const T0 = Date.parse('2026-08-24T17:00:00.000Z');
const OUT = '/private/tmp/claude-501/-Users-test-proj/tasks';

const hookTasks = [
  { id: 'a0000000000000001', type: 'subagent', status: 'running', description: 'Review the change', agent_type: 'Explore' },
  { id: 'b00000001', type: 'shell', status: 'running', description: 'Run the tests', command: 'npm test' },
];

function hook(events: Record<string, unknown>[]): HookSessionState {
  let st: HookSessionState | undefined;
  events.forEach((e, i) => {
    const parsed = parseHookLine(JSON.stringify({ session_id: SID, ...e }), T0 + i * 1000);
    if (!parsed) throw new Error('unparseable');
    st = reduceHookEvent(st, parsed);
  });
  return st!;
}

/** The tool result a launch writes. */
function launch(toolUseResult: Record<string, unknown>, atIso = '2026-08-24T17:00:01.000Z'): string {
  return mkUser([mkToolResult('launched in the background')], { toolUseResult, timestamp: atIso });
}
const shellLaunch = (id: string, extra: Record<string, unknown> = {}) =>
  launch({ stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id, ...extra });
const agentLaunch = (id: string) =>
  launch({ isAsync: true, status: 'async_launched', agentId: id, description: 'Review', outputFile: `${OUT}/${id}.output` });
const monitorLaunch = (id: string) => launch({ taskId: id, timeoutMs: 1_200_000, persistent: false });

function notification(id: string, status?: string): string {
  return [
    '<task-notification>',
    `<task-id>${id}</task-id>`,
    `<output-file>${OUT}/${id}.output</output-file>`,
    status !== undefined ? `<status>${status}</status>` : '<event>line matched</event>',
    '<summary>Background command "Run the tests" finished</summary>',
    '</task-notification>',
  ].join('\n');
}
const enqueue = (content: string) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-08-24T17:05:00.000Z', sessionId: SID, content });
const report = mkAssistant([mkText('Started the review; I will report back when it finishes.')], 'end_turn');

function summaryOf(chunks: string[][]): TranscriptSummary {
  let s: TranscriptSummary | undefined;
  for (const lines of chunks) s = mergeSummaries(s, parseSummaryLines(lines), { sizeBytes: 1, mtimeMs: T0, byteOffset: 1 });
  return s!;
}
const ids = (t: BackgroundTaskRef[] | undefined) => (t ?? []).map((x) => x.id);

describe('hook tier: Stop.background_tasks', () => {
  it('parses the running tasks by kind', () => {
    expect(parseHookBackgroundTasks(hookTasks)).toEqual([
      { id: 'a0000000000000001', kind: 'subagent' },
      { id: 'b00000001', kind: 'shell' },
    ]);
  });

  it('tells "no field" (older Claude Code) apart from "none running"', () => {
    expect(parseHookBackgroundTasks(undefined)).toBeUndefined();
    expect(parseHookBackgroundTasks([])).toEqual([]);
  });

  it('drops finished entries and names unknown kinds "other"', () => {
    expect(
      parseHookBackgroundTasks([
        { id: 'x', type: 'shell', status: 'completed' },
        { id: 'y', type: 'monitor', status: 'running' },
        'junk',
      ]),
    ).toEqual([{ id: 'y', kind: 'other' }]);
  });

  it('a Stop records the list, the next Stop replaces it, SessionStart clears it', () => {
    const held = hook([
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'Stop', last_assistant_message: 'Started it.', background_tasks: hookTasks },
    ]);
    expect(ids(held.backgroundTasks)).toEqual(['a0000000000000001', 'b00000001']);

    // The task notification starts a turn with UserPromptSubmit; its Stop reports again.
    const released = hook([
      { hook_event_name: 'Stop', last_assistant_message: 'Started it.', background_tasks: hookTasks },
      { hook_event_name: 'UserPromptSubmit' },
      { hook_event_name: 'Stop', last_assistant_message: 'The review found nothing.', background_tasks: [] },
    ]);
    expect(released.backgroundTasks).toEqual([]);

    const restarted = hook([
      { hook_event_name: 'Stop', background_tasks: hookTasks },
      { hook_event_name: 'SessionStart', source: 'resume' },
    ]);
    expect(restarted.backgroundTasks).toBeUndefined();
  });

  it('a quiet background wait never becomes Possibly stuck', () => {
    const st = hook([{ hook_event_name: 'Stop', last_assistant_message: 'Started it.', background_tasks: hookTasks }]);
    const hourLater = T0 + 3_600_000;
    const raw = statusFromHookState(st, hourLater, 600_000);
    expect(raw).toBe('waiting'); // turn over; the provider splits waiting/done from the reply
    expect(holdForBackground('done', st.backgroundTasks!.length)).toBe('busy');
  });
});

describe('transcript tier: launches and notifications', () => {
  it('opens a run_in_background shell and an async subagent', () => {
    const s = summaryOf([[mkAssistant([mkToolUse('Bash', { command: 'npm test', run_in_background: true })], 'tool_use'), shellLaunch('b1'), agentLaunch('a1'), report]]);
    expect(s.backgroundTasks).toEqual([
      { id: 'b1', kind: 'shell', launchedAtMs: T0 + 1000 },
      { id: 'a1', kind: 'subagent', launchedAtMs: T0 + 1000 },
    ]);
  });

  it('opens a foreground command moved to the background on timeout', () => {
    expect(ids(summaryOf([[shellLaunch('b2', { timedOutAfterMs: 120_000 })]]).backgroundTasks)).toEqual(['b2']);
  });

  it('a notification with a status ends the task; several stay open until the last one ends', () => {
    const s1 = summaryOf([[shellLaunch('b1'), agentLaunch('a1'), report], [enqueue(notification('b1', 'completed'))]]);
    expect(ids(s1.backgroundTasks)).toEqual(['a1']);
    const s2 = summaryOf([[shellLaunch('b1'), agentLaunch('a1'), report], [enqueue(notification('b1', 'completed'))], [enqueue(notification('a1', 'failed'))]]);
    expect(s2.backgroundTasks).toEqual([]);
  });

  it('the user line a notification becomes ends it too (it may be the only copy in a tail read)', () => {
    const s = summaryOf([[shellLaunch('b1')], [mkUser(notification('b1', 'killed'), { origin: { kind: 'task-notification' } })]]);
    expect(s.backgroundTasks).toEqual([]);
  });

  it('a monitor event (no status) leaves the monitor running', () => {
    const s = summaryOf([[monitorLaunch('m1')], [enqueue(notification('m1'))]]);
    expect(s.backgroundTasks).toEqual([{ id: 'm1', kind: 'other', launchedAtMs: T0 + 1000 }]);
  });

  it('TaskStop ends a task', () => {
    const stop = mkUser([mkToolResult('stopped')], { toolUseResult: { message: 'Successfully stopped task: b1', task_id: 'b1', task_type: 'local_bash' } });
    expect(summaryOf([[shellLaunch('b1')], [stop]]).backgroundTasks).toEqual([]);
  });

  it('ignores a notification for a task this transcript never launched (one a subagent started)', () => {
    expect(ids(summaryOf([[shellLaunch('b1')], [enqueue(notification('zzz', 'completed'))]]).backgroundTasks)).toEqual(['b1']);
  });

  it('a task that ends mid-turn is closed before the turn ends', () => {
    const s = summaryOf([[shellLaunch('b1'), mkAssistant([mkToolUse('Read', { file_path: '/Users/test/proj/a.ts' })], 'tool_use'), enqueue(notification('b1', 'completed')), report]]);
    expect(s.backgroundTasks).toEqual([]);
    expect(deriveStatus({ pidAlive: true, lastMeaningful: s.lastMeaningful, transcriptMtimeMs: T0, lastAssistantText: s.lastAssistantText, nowMs: T0, stuckThresholdMs: 600_000 })).toBe('done');
  });

  it('extracts ids from notifications batched into one prompt', () => {
    expect(finishedTaskIdsIn(`${notification('b1', 'completed')}\n${notification('m1')}\n${notification('a1', 'stopped')}`)).toEqual(['b1', 'a1']);
    expect(finishedTaskIdsIn('an ordinary prompt')).toEqual([]);
  });

  it('ignores tool results that launched nothing', () => {
    expect(launchedTaskOf({ stdout: 'ok', stderr: '', interrupted: false }, T0)).toBeUndefined();
    expect(launchedTaskOf('text result', T0)).toBeUndefined();
    expect(launchedTaskOf({ status: 'completed', agentId: 'a1' }, T0)).toBeUndefined(); // a foreground subagent
  });

  it('bounds how many open tasks it keeps', () => {
    const many = Array.from({ length: MAX_TRACKED_TASKS + 5 }, (_, i) => ({ id: `t${i}`, kind: 'shell' as const }));
    const kept = applyTaskChanges(undefined, many, []);
    expect(kept).toHaveLength(MAX_TRACKED_TASKS);
    expect(kept![0].id).toBe('t5');
  });
});

describe('which tasks count', () => {
  const transcript = { backgroundTasks: [{ id: 'old', kind: 'shell' as const, launchedAtMs: T0 }, { id: 'new', kind: 'subagent' as const, launchedAtMs: T0 + 60_000 }] };

  it('drops transcript launches from before this process started (a resume; the old tasks died with the old process)', () => {
    expect(ids(liveTranscriptTasks(transcript.backgroundTasks, T0 + 30_000))).toEqual(['new']);
    expect(ids(liveTranscriptTasks(transcript.backgroundTasks, undefined))).toEqual(['old', 'new']);
  });

  it("prefers the last Stop's list, falling back to the transcript when no Stop reported one", () => {
    expect(backgroundTasksFor({ backgroundTasks: [] }, transcript, undefined)).toEqual([]);
    expect(ids(backgroundTasksFor({ backgroundTasks: undefined }, transcript, T0 + 30_000))).toEqual(['new']);
    expect(ids(backgroundTasksFor(undefined, transcript, undefined))).toEqual(['old', 'new']);
    expect(backgroundTasksFor(undefined, undefined, undefined)).toEqual([]);
  });
});

describe('holdForBackground', () => {
  it('keeps a finished report out of Done while anything runs', () => {
    expect(holdForBackground('done', 1)).toBe('busy');
    expect(holdForBackground('done', 0)).toBe('done');
  });

  it('leaves every other status alone: a question still waits on the human, a dead pid is still Ended', () => {
    for (const s of ['waiting', 'blocked', 'busy', 'stuck', 'ended'] as const) expect(holdForBackground(s, 3)).toBe(s);
  });
});

describe('row chip', () => {
  it('says how many, short enough for a narrow pane, with the kinds in the tooltip', () => {
    expect(backgroundTasksChip({ subagents: 1, shells: 0, other: 0 })).toEqual({
      text: '1 in background',
      title: 'Turn over, waiting on 1 subagent running in the background. It carries on when they report back.',
    });
    expect(backgroundTasksChip({ subagents: 2, shells: 1, other: 1 }).title).toContain('2 subagents, 1 shell and 1 other task');
    expect(countTasks([{ id: 'a', kind: 'subagent' }, { id: 'b', kind: 'shell' }, { id: 'c', kind: 'shell' }])).toEqual({ subagents: 1, shells: 2, other: 0 });
    expect(countTasks([])).toBeUndefined();
  });
});

describe('done notices', () => {
  it('no "is done" edge fires while held; it fires once the work is handed back and the turn ends', async () => {
    let row: AgentSession = { provider: 'claude', sessionId: SID, key: `claude:${SID}`, title: 'Test', status: 'busy', lastActivityAt: 100 };
    const store = new SessionStore();
    await store.register({ id: 'claude', displayName: 'Claude Code', start: async () => {}, refresh: async () => {}, scan: async () => [row], onDidChange: () => ({ dispose() {} }), dispose() {} });
    const edges: string[][] = [];
    store.onDidUpdate((u) => edges.push(u.becameWaiting.map((s) => s.status)));

    row = { ...row, status: holdForBackground('done', 1), backgroundTasks: { subagents: 1, shells: 0, other: 0 }, lastActivityAt: 200 };
    await store.refresh();
    row = { ...row, status: holdForBackground('done', 0), backgroundTasks: undefined, lastActivityAt: 300 };
    await store.refresh();

    expect(edges).toEqual([[], ['done']]);
    store.dispose();
  });
});

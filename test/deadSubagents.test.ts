import { describe, expect, it } from 'vitest';
import { settleDeadSubagents } from '../src/claude/backgroundTasks';
import { liveBackgroundWork } from '../src/claude/claudeProvider';
import { parseHookLine, reduceHookEvent, type HookSessionState } from '../src/claude/hookEvents';
import { mergeSummaries, parseSummaryLines, type TranscriptSummary } from '../src/claude/transcriptTail';
import type { SubagentInfo } from '../src/shared/model';
import { mkAssistant, mkToolResult, mkToolUse, mkUser } from './fixtures';

// Ids, times and text are synthetic.
const SID = '11111111-2222-3333-4444-555555555555';
const at = (min: number) => Date.parse('2026-08-24T17:00:00.000Z') + min * 60_000;
const iso = (min: number) => new Date(at(min)).toISOString();

function hook(events: Array<[number, Record<string, unknown>]>): HookSessionState {
  let st: HookSessionState | undefined;
  for (const [min, e] of events) {
    const parsed = parseHookLine(JSON.stringify({ session_id: SID, ...e }), at(min));
    if (!parsed) throw new Error('unparseable');
    st = reduceHookEvent(st, parsed);
  }
  return st!;
}
const running = (...ids: string[]) => ids.map((id) => ({ id, type: 'subagent', status: 'running', description: 'Survey' }));

/** An async Agent launch at `min`: the tool use, then its immediate `async_launched` result. */
function launch(toolUseId: string, agentId: string, min: number): string[] {
  return [
    mkAssistant([mkToolUse('Agent', { description: `Survey ${agentId}` }, toolUseId)], 'tool_use', { timestamp: iso(min) }),
    mkUser([mkToolResult('launched', toolUseId)], {
      toolUseResult: { isAsync: true, status: 'async_launched', agentId },
      timestamp: iso(min),
    }),
  ];
}

function listOf(lines: string[]): SubagentInfo[] {
  const s: TranscriptSummary = mergeSummaries(undefined, parseSummaryLines(lines), { sizeBytes: 1, mtimeMs: at(0), byteOffset: 1 });
  return s.subagentList ?? [];
}
const statuses = (list: SubagentInfo[] | undefined) => Object.fromEntries((list ?? []).map((s) => [s.agentId, s.status]));

describe('subagents that die without a task notification', () => {
  // Two launched, both killed silently, then two more launched in a later turn.
  const list = listOf([...launch('t1', 'old-a', 0), ...launch('t2', 'old-b', 0), ...launch('t3', 'new-a', 70), ...launch('t4', 'new-b', 70)]);

  it('records when each subagent launched', () => {
    expect(list.map((s) => s.launchedAtMs)).toEqual([at(0), at(0), at(70), at(70)]);
  });

  it('retires launches from before the current turn that the last Stop no longer lists', () => {
    const h = hook([
      [1, { hook_event_name: 'Stop', background_tasks: running('old-a', 'old-b') }],
      [2, { hook_event_name: 'UserPromptSubmit' }],
      [3, { hook_event_name: 'Stop', background_tasks: [] }],
      [69, { hook_event_name: 'UserPromptSubmit' }],
    ]);
    expect(statuses(settleDeadSubagents(list, liveBackgroundWork(h, at(-1))))).toEqual({
      'old-a': 'done',
      'old-b': 'done',
      'new-a': 'working',
      'new-b': 'working',
    });
  });

  it('judges every launch against the last Stop between turns', () => {
    const h = hook([[71, { hook_event_name: 'Stop', background_tasks: running('new-b') }]]);
    expect(statuses(settleDeadSubagents(list, liveBackgroundWork(h, at(-1))))).toEqual({
      'old-a': 'done',
      'old-b': 'done',
      'new-a': 'done',
      'new-b': 'working',
    });
  });

  it('leaves the list alone when the turn start is only a backlog read time', () => {
    const h = { ...hook([[3, { hook_event_name: 'Stop', background_tasks: [] }], [69, { hook_event_name: 'UserPromptSubmit' }]]), turnStartUncertain: true };
    expect(settleDeadSubagents(list, liveBackgroundWork(h, at(-1)))).toBe(list);
  });

  it('retires launches from before this process started, with no hooks at all', () => {
    expect(statuses(settleDeadSubagents(list, liveBackgroundWork(undefined, at(60))))).toEqual({
      'old-a': 'done',
      'old-b': 'done',
      'new-a': 'working',
      'new-b': 'working',
    });
  });

  it('keeps a subagent whose launch time is unknown', () => {
    const unknown = list.map((s) => ({ ...s, launchedAtMs: undefined }));
    const h = hook([[71, { hook_event_name: 'Stop', background_tasks: [] }]]);
    expect(settleDeadSubagents(unknown, liveBackgroundWork(h, at(60)))).toBe(unknown);
  });
});

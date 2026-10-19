import { describe, expect, it } from 'vitest';
import { parseSummaryLines } from '../src/claude/transcriptTail';

// Test data structure: matches Claude Code transcript format
const line = (type: string, message: unknown) => JSON.stringify({ type, message, timestamp: '2024-01-01T12:00:00Z' });
const taskNotif = (taskId: string) => JSON.stringify({ type: 'task-notification', task_id: taskId, timestamp: '2024-01-01T12:00:00Z' });
const use = (name: string, id: string | undefined, input: Record<string, unknown>) => ({ type: 'tool_use', name, id, input });

describe('Claude transcript subagent extraction', () => {
  it('extracts Agent tool_use launches under the tool-use id', () => {
    const lines = [line('assistant', { content: [use('Agent', 'toolu_1', { description: 'Code reviewer', subagent_type: 'reviewer' })] })];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'toolu_1', label: 'Code reviewer', agentType: 'reviewer', background: false },
    ]);
  });

  it('extracts Task tool_use launches and flags background ones', () => {
    const lines = [line('assistant', { content: [use('Task', 'toolu_2', { description: 'Run tests', run_in_background: true })] })];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'toolu_2', label: 'Run tests', agentType: undefined, background: true },
    ]);
  });

  it('ignores non-Agent/Task tool uses', () => {
    const lines = [line('assistant', { content: [use('Bash', 'toolu_3', { command: 'ls' })] })];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toBeUndefined();
  });

  it('extracts tool_result completions', () => {
    const lines = [line('user', { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Done' }] })];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListClosed).toEqual(['toolu_1']);
  });

  it('extracts task-notification completions', () => {
    const partial = parseSummaryLines([taskNotif('task-456')]);
    expect(partial.subagentListClosed).toEqual(['task-456']);
  });

  it('tracks both opens and closes in one chunk', () => {
    const lines = [
      line('assistant', { content: [use('Agent', 'toolu_new', { description: 'New agent' })] }),
      line('user', { content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: 'Completed' }] }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'toolu_new', label: 'New agent', agentType: undefined, background: false },
    ]);
    expect(partial.subagentListClosed).toEqual(['toolu_old']);
  });

  it('handles multiple tool uses in one message', () => {
    const lines = [
      line('assistant', {
        content: [use('Agent', 'toolu_a', { description: 'First' }), use('Task', 'toolu_b', { description: 'Second' })],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened?.length).toBe(2);
    expect(partial.subagentListOpened).toContainEqual({ id: 'toolu_a', label: 'First', agentType: undefined, background: false });
    expect(partial.subagentListOpened).toContainEqual({ id: 'toolu_b', label: 'Second', agentType: undefined, background: false });
  });

  it('ignores a launch with no tool-use id', () => {
    const lines = [line('assistant', { content: [use('Agent', undefined, { description: 'No ID' })] })];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toBeUndefined();
  });

  it('defaults to a short id when description is missing', () => {
    const lines = [line('assistant', { content: [use('Agent', 'toolu_abcdefgh1234', {})] })];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'toolu_abcdefgh1234', label: 'toolu_ab', agentType: undefined, background: false },
    ]);
  });
});

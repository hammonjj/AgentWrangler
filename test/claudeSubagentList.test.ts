import { describe, expect, it } from 'vitest';
import { parseSummaryLines } from '../src/claude/transcriptTail';

// Test data structure: matches Claude Code transcript format
const line = (type: string, message: unknown) => JSON.stringify({ type, message, timestamp: '2024-01-01T12:00:00Z' });
const taskNotif = (taskId: string) => JSON.stringify({ type: 'task-notification', task_id: taskId, timestamp: '2024-01-01T12:00:00Z' });

describe('Claude transcript subagent extraction', () => {
  it('extracts Agent tool_use launches', () => {
    const lines = [
      line('assistant', {
        content: [
          {
            type: 'tool_use',
            name: 'Agent',
            input: { subagent_id: 'agent-123', description: 'Code reviewer', subagent_type: 'reviewer' },
          },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'agent-123', label: 'Code reviewer', agentType: 'reviewer' },
    ]);
  });

  it('extracts Task tool_use launches', () => {
    const lines = [
      line('assistant', {
        content: [
          {
            type: 'tool_use',
            name: 'Task',
            input: { task_id: 'task-456', description: 'Run tests' },
          },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'task-456', label: 'Run tests', agentType: undefined },
    ]);
  });

  it('ignores non-Agent/Task tool uses', () => {
    const lines = [
      line('assistant', {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toBeUndefined();
  });

  it('extracts tool_result completions', () => {
    const lines = [
      line('user', {
        content: [
          { type: 'tool_result', tool_use_id: 'agent-123', content: 'Done' },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListClosed).toEqual(['agent-123']);
  });

  it('extracts task-notification completions', () => {
    const lines = [
      taskNotif('task-456'),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListClosed).toEqual(['task-456']);
  });

  it('tracks both opens and closes in one chunk', () => {
    const lines = [
      line('assistant', {
        content: [
          {
            type: 'tool_use',
            name: 'Agent',
            input: { subagent_id: 'agent-new', description: 'New agent' },
          },
        ],
      }),
      line('user', {
        content: [
          { type: 'tool_result', tool_use_id: 'agent-old', content: 'Completed' },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'agent-new', label: 'New agent', agentType: undefined },
    ]);
    expect(partial.subagentListClosed).toEqual(['agent-old']);
  });

  it('handles multiple tool uses in one message', () => {
    const lines = [
      line('assistant', {
        content: [
          {
            type: 'tool_use',
            name: 'Agent',
            input: { subagent_id: 'agent-1', description: 'First' },
          },
          {
            type: 'tool_use',
            name: 'Task',
            input: { task_id: 'task-1', description: 'Second' },
          },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened?.length).toBe(2);
    expect(partial.subagentListOpened).toContainEqual({ id: 'agent-1', label: 'First', agentType: undefined });
    expect(partial.subagentListOpened).toContainEqual({ id: 'task-1', label: 'Second', agentType: undefined });
  });

  it('ignores subagent info with missing id', () => {
    const lines = [
      line('assistant', {
        content: [
          {
            type: 'tool_use',
            name: 'Agent',
            input: { description: 'No ID' },
          },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toBeUndefined();
  });

  it('defaults to short id when description missing', () => {
    const lines = [
      line('assistant', {
        content: [
          {
            type: 'tool_use',
            name: 'Agent',
            input: { subagent_id: 'abcd1234-5678-90ab-cdef' },
          },
        ],
      }),
    ];
    const partial = parseSummaryLines(lines);
    expect(partial.subagentListOpened).toEqual([
      { id: 'abcd1234-5678-90ab-cdef', label: 'abcd1234', agentType: undefined },
    ]);
  });
});

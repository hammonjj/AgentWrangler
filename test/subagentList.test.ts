import { describe, expect, it } from 'vitest';
import { mergeSummaries, parseSummaryLines } from '../src/claude/transcriptTail';
import { MAX_STEPS, subagentSteps } from '../src/claude/subagentSteps';
import type { ConvBlock } from '../src/shared/conversation';

const stat = { sizeBytes: 1, mtimeMs: 1, byteOffset: 1 };

function launch(id: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] },
  });
}

function result(id: string, toolUseResult: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult,
  });
}

function summarize(lines: string[]) {
  return mergeSummaries(undefined, parseSummaryLines(lines), stat).subagentList;
}

describe('subagent list from a transcript', () => {
  it('opens a launch under its tool-use id', () => {
    const list = summarize([launch('toolu_1', { description: 'Find usage', subagent_type: 'Explore' })]);
    expect(list).toEqual([expect.objectContaining({ id: 'toolu_1', label: 'Find usage', agentType: 'Explore', status: 'working' })]);
  });

  it('closes a foreground subagent on its result and keeps its transcript id', () => {
    const list = summarize([
      launch('toolu_1', { description: 'Find usage' }),
      result('toolu_1', { agentId: 'abc123', status: 'completed' }),
    ]);
    expect(list).toEqual([expect.objectContaining({ id: 'toolu_1', agentId: 'abc123', status: 'done' })]);
  });

  it('keeps a background subagent working until its task notification', () => {
    const launched = [
      launch('toolu_2', { description: 'Long job', run_in_background: true }),
      result('toolu_2', { isAsync: true, status: 'async_launched', agentId: 'bg9' }),
    ];
    expect(summarize(launched)).toEqual([
      expect.objectContaining({ id: 'toolu_2', agentId: 'bg9', background: true, status: 'working' }),
    ]);
    const notice = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification><task-id>bg9</task-id><status>completed</status></task-notification>',
    });
    expect(summarize([...launched, notice])).toEqual([expect.objectContaining({ id: 'toolu_2', status: 'done' })]);
  });
});

describe('subagentSteps', () => {
  const tool = (n: number, state: 'running' | 'done' | 'error'): ConvBlock => ({
    kind: 'tool',
    id: `t${n}`,
    toolUseId: `t${n}`,
    name: 'Read',
    inputPreview: `/Users/test/proj/f${n}.ts`,
    state,
  });

  it('keeps replies and tool calls, flattened, and drops the rest', () => {
    const steps = subagentSteps([
      { kind: 'user', id: 'u', text: 'prompt' },
      { kind: 'thinking', id: 'k', text: 'hmm' },
      { kind: 'assistant', id: 'a', text: 'Looking\n  at it' },
      tool(1, 'running'),
    ]);
    expect(steps).toEqual([
      { kind: 'say', text: 'Looking at it' },
      { kind: 'tool', text: 'Read /Users/test/proj/f1.ts', state: 'running' },
    ]);
  });

  it('keeps only the newest steps', () => {
    const blocks = Array.from({ length: MAX_STEPS + 5 }, (_, i) => tool(i, 'done'));
    const steps = subagentSteps(blocks);
    expect(steps).toHaveLength(MAX_STEPS);
    expect(steps[steps.length - 1].text).toContain(`f${MAX_STEPS + 4}.ts`);
  });
});

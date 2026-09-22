import { describe, expect, it } from 'vitest';
import { rolloutBlocks, rolloutStatus, summarizeRolloutLines } from '../src/codex/rollout';

const line = (type: string, payload: unknown, timestamp = '2026-09-17T12:00:00.000Z') =>
  JSON.stringify({ timestamp, type, payload });

describe('Codex rollout parsing', () => {
  it('extracts provider-neutral session metadata and active turn state', () => {
    const summary = summarizeRolloutLines([
      line('session_meta', { id: '019abc00-0000-7000-8000-000000000001', cwd: '/Users/test/proj', source: 'vscode' }),
      line('turn_context', { model: 'gpt-5-codex', cwd: '/Users/test/proj' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the parser' }] }),
      line('event_msg', { type: 'task_started', started_at: 1_789_660_800 }),
    ], '/Users/test/.codex/sessions/rollout.jsonl', Date.parse('2026-09-17T12:01:00Z'))!;

    expect(summary.sessionId).toBe('019abc00-0000-7000-8000-000000000001');
    expect(summary.subtitle).toBe('Fix the parser');
    expect(summary.model).toBe('gpt-5-codex');
    expect(summary.source).toBe('vscode');
    expect(rolloutStatus(summary, summary.lastActivityAt + 1000, 600_000)).toBe('busy');
  });

  it('distinguishes completed reports, questions, and failed turns', () => {
    const base = summarizeRolloutLines([
      line('session_meta', { id: '019abc00-0000-7000-8000-000000000002' }),
      line('event_msg', { type: 'task_started', started_at: 1 }),
      line('event_msg', { type: 'task_complete', last_agent_message: 'Tests pass.' }),
    ], '/Users/test/rollout.jsonl', 100)!;
    expect(rolloutStatus(base, 100, 10)).toBe('done');
    expect(rolloutStatus({ ...base, lastAssistantText: 'Which option should I use?' }, 100, 10)).toBe('waiting');
    expect(rolloutStatus({ ...base, failed: true }, 100, 10)).toBe('waiting');
  });

  it('maps user, assistant, tool, and error records into conversation blocks', () => {
    const blocks = rolloutBlocks([
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] }),
      line('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: { cmd: 'npm test' } }),
      line('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'ok' }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(blocks[1]).toMatchObject({ kind: 'tool', state: 'done', result: { text: 'ok' } });
  });

  it('formats Codex commentary as work and hides internal final-answer metadata', () => {
    const blocks = rolloutBlocks([
      line('response_item', { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking tests.' }] }),
      line('response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Done.\n<oai-mem-citation>private</oai-mem-citation>' }] }),
    ]);
    expect(blocks).toMatchObject([
      { kind: 'thinking', text: 'Checking tests.' },
      { kind: 'assistant', text: 'Done.' },
    ]);
  });

  it('uses the explicit user event when the response-item prompt is outside a bounded read', () => {
    const summary = summarizeRolloutLines([
      line('session_meta', { id: '019abc00-0000-7000-8000-000000000003' }),
      line('event_msg', { type: 'user_message', message: 'Make the transcript readable' }),
    ], '/Users/test/rollout.jsonl', 100)!;
    expect(summary.title).toBe('Make the transcript readable');
  });

  it('turns Codex patch events into an edited-files summary instead of raw tool JSON', () => {
    const blocks = rolloutBlocks([
      line('response_item', { type: 'custom_tool_call', call_id: 'edit-1', name: 'exec', input: 'apply patch' }),
      line('event_msg', { type: 'patch_apply_end', call_id: 'edit-1', success: true, changes: {
        '/repo/src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new' },
        '/repo/src/b.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y' },
      } }),
      line('response_item', { type: 'custom_tool_call_output', call_id: 'edit-1', output: '[{"type":"input_text","text":"Success"}]' }),
    ]);
    expect(blocks[0]).toMatchObject({
      kind: 'tool', name: 'Edited 2 files', inputPreview: 'a.ts, b.ts', state: 'done',
      result: { diffs: [{ file: '/repo/src/a.ts' }, { file: '/repo/src/b.ts' }] },
    });
  });

  it('keeps block ids stable when a bounded tail drops older records', () => {
    const old = line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old' }] }, '2026-09-17T11:00:00Z');
    const current = line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Current' }] });
    expect(rolloutBlocks([old, current])[1].id).toBe(rolloutBlocks([current])[0].id);
  });
});

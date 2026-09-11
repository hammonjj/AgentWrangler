import { describe, expect, it } from 'vitest';
import { createRunnerState, reduceRunnerMessage, type RunnerBlocksState } from '../src/claude/runner/runnerBlocks';
import type { ConvBlock } from '../src/shared/conversation';

/** The SDK message shapes this reducer consumes, as the CLI emits them. */
const init = (over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-opus-5',
  permissionMode: 'default',
  slash_commands: ['compact', 'clear'],
  ...over,
});
const messageStart = (id = 'msg_1', model = 'claude-opus-5') => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { id, model } },
});
const blockStart = (index: number, type: 'text' | 'thinking') => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index, content_block: { type } },
});
const delta = (index: number, text: string, thinking = false) => ({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index,
    delta: thinking ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text },
  },
});
const blockStop = (index: number) => ({ type: 'stream_event', event: { type: 'content_block_stop', index } });
const assistant = (content: unknown[], over: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { id: 'msg_1', model: 'claude-opus-5', content, stop_reason: null },
  parent_tool_use_id: null,
  ...over,
});
const toolResult = (toolUseId: string, content: string, isError = false, tur?: unknown) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  parent_tool_use_id: null,
  tool_use_result: tur,
});
const result = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  queued_turn_count: 0,
  ...over,
});

/** Feed a whole stream through and collect the net effect. */
function run(msgs: unknown[], state: RunnerBlocksState = createRunnerState()) {
  const blocks = new Map<string, ConvBlock>();
  const order: string[] = [];
  let composer: Record<string, unknown> = {};
  let turnEnds = 0;
  for (const m of msgs) {
    const r = reduceRunnerMessage(state, m);
    for (const b of r.appends) {
      blocks.set(b.id, b);
      order.push(b.id);
    }
    for (const p of r.patches) {
      const prev = blocks.get(p.id);
      if (prev) blocks.set(p.id, { ...prev, ...p.block } as ConvBlock);
    }
    if (r.composer) composer = { ...composer, ...r.composer };
    if (r.turnEnd) turnEnds++;
  }
  return { blocks: order.map((id) => blocks.get(id) as ConvBlock), composer, turnEnds, state };
}

describe('reduceRunnerMessage', () => {
  it('grows a reply from stream deltas', () => {
    const { blocks } = run([
      messageStart(),
      blockStart(0, 'text'),
      delta(0, 'Hel'),
      delta(0, 'lo'),
      blockStop(0),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: false });
  });

  it('does not render the same reply twice when the complete message follows', () => {
    // The CLI sends the text as deltas AND as a complete message. Rendering
    // both is the obvious bug here, so it gets the explicit test.
    const { blocks } = run([
      messageStart(),
      blockStart(0, 'text'),
      delta(0, 'Hel'),
      delta(0, 'lo'),
      blockStop(0),
      assistant([{ type: 'text', text: 'Hello' }]),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: false });
  });

  it('lets the complete message correct what was streamed', () => {
    const { blocks } = run([
      messageStart(),
      blockStart(0, 'text'),
      delta(0, 'Hel'),
      blockStop(0),
      assistant([{ type: 'text', text: 'Hello, corrected' }]),
    ]);
    expect(blocks[0]).toMatchObject({ text: 'Hello, corrected', streaming: false });
  });

  it('renders a reply that never streamed at all', () => {
    // Partial messages off, or a turn that was interrupted: no slots exist and
    // the complete message must still be shown rather than dropped.
    const { blocks } = run([assistant([{ type: 'text', text: 'no streaming here' }])]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'assistant', text: 'no streaming here' });
  });

  it('keeps streamed text and thinking apart', () => {
    const { blocks } = run([
      messageStart(),
      blockStart(0, 'thinking'),
      delta(0, 'hmm', true),
      blockStop(0),
      blockStart(1, 'text'),
      delta(1, 'answer'),
      blockStop(1),
      assistant([{ type: 'thinking', thinking: 'hmm' }]),
      assistant([{ type: 'text', text: 'answer' }]),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['thinking', 'assistant']);
    expect(blocks[0]).toMatchObject({ text: 'hmm' });
    expect(blocks[1]).toMatchObject({ text: 'answer' });
  });

  it('starts fresh slots for each API message', () => {
    const { blocks } = run([
      messageStart('msg_1'),
      blockStart(0, 'text'),
      delta(0, 'first'),
      blockStop(0),
      assistant([{ type: 'text', text: 'first' }]),
      messageStart('msg_2'),
      blockStart(0, 'text'),
      delta(0, 'second'),
      blockStop(0),
      assistant([{ type: 'text', text: 'second' }], { message: { id: 'msg_2', content: [{ type: 'text', text: 'second' }] } }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => (b as { text: string }).text)).toEqual(['first', 'second']);
  });

  it('creates a tool call only from the complete message, then pairs its result', () => {
    const { blocks } = run([
      messageStart(),
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]),
      toolResult('toolu_1', 'a.txt'),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      name: 'Bash',
      inputPreview: 'ls',
      state: 'done',
      result: { text: 'a.txt', isError: false },
    });
  });

  it('marks a failed tool call', () => {
    const { blocks } = run([
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'nope' } }]),
      toolResult('toolu_1', 'not found', true),
    ]);
    expect(blocks[0]).toMatchObject({ state: 'error', result: { isError: true } });
  });

  it('shows an edit as a diff', () => {
    const { blocks } = run([
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/Users/test/proj/a.ts' } }]),
      toolResult('toolu_1', 'ok', false, {
        filePath: '/Users/test/proj/a.ts',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
      }),
    ]);
    const result = (blocks[0] as { result: { diff?: { patch: string } } }).result;
    expect(result.diff?.patch).toContain('+new');
  });

  it('ignores a result for a call it never saw', () => {
    const { blocks } = run([toolResult('toolu_unknown', 'orphan')]);
    expect(blocks).toHaveLength(0);
  });

  it('tags subagent tool calls with their parent', () => {
    const { blocks } = run([
      assistant([{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/Users/test/proj/x' } }], {
        parent_tool_use_id: 'toolu_agent',
      }),
    ]);
    expect(blocks[0]).toMatchObject({ parentToolUseId: 'toolu_agent' });
  });

  it('reads the session state off init and status', () => {
    const { composer } = run([
      init(),
      { type: 'system', subtype: 'status', status: 'requesting' },
    ]);
    expect(composer).toMatchObject({
      permissionMode: 'default',
      model: 'claude-opus-5',
      slashCommands: ['compact', 'clear'],
      busy: true,
    });
  });

  it('ends the turn idle, and busy again when sends are queued behind it', () => {
    const idle = run([result()]);
    expect(idle.turnEnds).toBe(1);
    expect(idle.composer).toMatchObject({ busy: false, queued: 0 });

    const queued = run([result({ queued_turn_count: 2 })]);
    expect(queued.composer).toMatchObject({ busy: true, queued: 2 });
  });

  it('turns a failed turn into an error note', () => {
    const { blocks } = run([result({ subtype: 'error_during_execution', is_error: true, result: 'it broke' })]);
    expect(blocks[0]).toMatchObject({ kind: 'note', tone: 'error', text: 'it broke' });
  });

  it('notes a compaction, so a shrinking context is never a mystery', () => {
    const { blocks } = run([
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 120000 } },
    ]);
    expect(blocks[0]).toMatchObject({ kind: 'note', tone: 'info' });
    expect((blocks[0] as { text: string }).text).toContain('compacted');
  });

  it('ignores message types it has never heard of', () => {
    // The stream grows new informational types between Claude Code releases;
    // an unknown one must not break the pane.
    const { blocks } = run([
      { type: 'rate_limit_event', foo: 1 },
      { type: 'system', subtype: 'thinking_tokens' },
      { type: 'tool_progress', tool_use_id: 'x', elapsed_time_seconds: 3 },
      undefined,
      null,
      'nonsense',
    ]);
    expect(blocks).toHaveLength(0);
  });
});

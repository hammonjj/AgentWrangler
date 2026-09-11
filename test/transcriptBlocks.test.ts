import { describe, expect, it } from 'vitest';
import {
  createTranscriptState,
  diffFromToolUseResult,
  reduceTranscriptLines,
  toolInputPreview,
} from '../src/claude/transcriptBlocks';
import { MAX_BLOCK_CHARS, type ConvBlock } from '../src/shared/conversation';
import {
  mkAiTitle,
  mkAssistant,
  mkAttachment,
  mkQueueOp,
  mkSidechainAssistant,
  mkText,
  mkThinking,
  mkToolResult,
  mkToolUse,
  mkUser,
} from './fixtures';

/** Reduce a batch against a fresh state, for the single-pass cases. */
function reduce(lines: string[]) {
  return reduceTranscriptLines(createTranscriptState(), lines);
}

function kinds(blocks: ConvBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

describe('reduceTranscriptLines', () => {
  it('turns a prompt and a reply into two blocks', () => {
    const { appends } = reduce([mkUser('do the thing'), mkAssistant([mkText('done')], 'end_turn')]);
    expect(kinds(appends)).toEqual(['user', 'assistant']);
    expect(appends[0]).toMatchObject({ kind: 'user', text: 'do the thing' });
    expect(appends[1]).toMatchObject({ kind: 'assistant', text: 'done', model: 'claude-opus-5' });
  });

  it('keeps thinking, which the old viewer dropped', () => {
    const { appends } = reduce([mkAssistant([mkThinking('weighing options')], null)]);
    expect(appends[0]).toMatchObject({ kind: 'thinking', text: 'weighing options' });
  });

  it('merges the lines of one reply into a single block', () => {
    // Claude Code writes one line per content block; a reply split over three
    // of them is one paragraph, not three messages.
    const { appends, patches } = reduce([
      mkAssistant([mkText('first')], null, { msgId: 'msg_A' }),
      mkAssistant([mkText('second')], null, { msgId: 'msg_A' }),
    ]);
    expect(appends).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].block).toMatchObject({ text: 'first\nsecond' });
    expect(patches[0].id).toBe(appends[0].id);
  });

  it('starts a new block when the reply is a new message', () => {
    const { appends } = reduce([
      mkAssistant([mkText('first')], 'end_turn', { msgId: 'msg_A' }),
      mkAssistant([mkText('second')], 'end_turn', { msgId: 'msg_B' }),
    ]);
    expect(appends).toHaveLength(2);
  });

  it('pairs a tool result with its call, even chunks later', () => {
    // The whole reason this is a reducer: the call and its result almost never
    // arrive in the same read.
    const state = createTranscriptState();
    const first = reduceTranscriptLines(state, [mkAssistant([mkToolUse('Bash', { command: 'ls' })], 'tool_use')]);
    expect(first.appends[0]).toMatchObject({ kind: 'tool', name: 'Bash', state: 'running', inputPreview: 'ls' });

    const second = reduceTranscriptLines(state, [mkUser([mkToolResult('a.txt\nb.txt')])]);
    expect(second.appends).toHaveLength(0);
    expect(second.patches).toHaveLength(1);
    expect(second.patches[0].id).toBe(first.appends[0].id);
    expect(second.patches[0].block).toMatchObject({
      state: 'done',
      result: { text: 'a.txt\nb.txt', isError: false, truncated: false },
    });
  });

  it('marks a failed tool call', () => {
    const state = createTranscriptState();
    reduceTranscriptLines(state, [mkAssistant([mkToolUse('Bash', { command: 'nope' })], 'tool_use')]);
    const { patches } = reduceTranscriptLines(state, [mkUser([mkToolResult('command not found', 'toolu_x', true)])]);
    expect(patches[0].block).toMatchObject({ state: 'error', result: { isError: true } });
  });

  it('ignores a result whose call is above the tail window', () => {
    // Opening a long session reads only the end of the file, so some results
    // have nothing on screen to attach to. They must not become stray blocks.
    const { appends, patches } = reduce([mkUser([mkToolResult('orphan output')])]);
    expect(appends).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it('renders an edit as a diff', () => {
    const state = createTranscriptState();
    reduceTranscriptLines(state, [mkAssistant([mkToolUse('Edit', { file_path: '/Users/test/proj/a.ts' })], 'tool_use')]);
    const line = JSON.parse(mkUser([mkToolResult('ok')]));
    line.toolUseResult = {
      filePath: '/Users/test/proj/a.ts',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }],
    };
    const { patches } = reduceTranscriptLines(state, [JSON.stringify(line)]);
    const result = (patches[0].block as { result: { diff?: { file: string; patch: string } } }).result;
    expect(result.diff?.file).toBe('/Users/test/proj/a.ts');
    expect(result.diff?.patch).toContain('@@ -1,1 +1,2 @@');
    expect(result.diff?.patch).toContain('+new');
  });

  it('skips subagent lines, injected context, and bookkeeping', () => {
    const { appends } = reduce([
      mkSidechainAssistant(),
      mkUser('<system-reminder>noise</system-reminder>', { isMeta: true }),
      mkAiTitle('a title'),
      mkQueueOp(),
      mkAttachment(),
      mkAssistant([mkText('the only real block')], 'end_turn'),
    ]);
    expect(kinds(appends)).toEqual(['assistant']);
  });

  it('shows a slash command as the command, not its tag soup', () => {
    const { appends } = reduce([
      mkUser('<command-name>/review</command-name><command-message>review</command-message><command-args>--fix</command-args>'),
    ]);
    expect(appends[0]).toMatchObject({ kind: 'user', text: '/review --fix' });
  });

  it('demotes other machine-injected tag soup to a note', () => {
    const { appends } = reduce([mkUser('<local-command-stdout>build ok</local-command-stdout>')]);
    expect(appends[0]).toMatchObject({ kind: 'note', tone: 'info' });
    expect((appends[0] as { text: string }).text).toContain('build ok');
  });

  it('counts images that rode along with a prompt', () => {
    const { appends } = reduce([
      mkUser([{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64' } }]),
    ]);
    expect(appends[0]).toMatchObject({ kind: 'user', text: 'look at this', imageCount: 1 });
  });

  it('caps a very long block rather than sending megabytes to the webview', () => {
    const { appends } = reduce([mkAssistant([mkText('x'.repeat(MAX_BLOCK_CHARS + 500))], 'end_turn')]);
    const text = (appends[0] as { text: string }).text;
    expect(text.length).toBeLessThan(MAX_BLOCK_CHARS + 40);
    expect(text.endsWith('… [truncated]')).toBe(true);
  });

  it('survives a corrupt line mid-file', () => {
    const { appends } = reduce(['{not json', mkAssistant([mkText('after')], 'end_turn')]);
    expect(kinds(appends)).toEqual(['assistant']);
  });

  it('gives every block a distinct id', () => {
    const { appends } = reduce([
      mkAssistant([mkText('a'), mkToolUse('Read', { file_path: '/Users/test/proj/x' })], 'tool_use'),
      mkUser('next'),
    ]);
    const ids = appends.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('toolInputPreview', () => {
  it('prefers the field that says what the tool will do', () => {
    expect(toolInputPreview({ command: 'npm test', description: 'run tests' })).toBe('npm test');
    expect(toolInputPreview({ file_path: '/Users/test/proj/a.ts' })).toBe('/Users/test/proj/a.ts');
    expect(toolInputPreview({ nothing: 1 })).toBe('{"nothing":1}');
  });

  it('flattens newlines so a heredoc stays one line', () => {
    expect(toolInputPreview({ command: 'a\n  b' })).toBe('a b');
  });
});

describe('diffFromToolUseResult', () => {
  it('returns nothing when there is no patch to show', () => {
    expect(diffFromToolUseResult(undefined)).toBeUndefined();
    expect(diffFromToolUseResult({ stdout: 'hi' })).toBeUndefined();
    expect(diffFromToolUseResult({ structuredPatch: [] })).toBeUndefined();
  });
});

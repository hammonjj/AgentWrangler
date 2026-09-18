import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archivePage, archivedTool, subagentPath } from '../src/claude/conversationArchive';
import { readTranscriptTail } from '../src/claude/transcriptHistory';
import { mkAssistant, mkText, mkToolUse, mkUser } from './fixtures';
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-archive-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
async function write(lines: string[]) { const file = path.join(dir, 'session.jsonl'); await fs.writeFile(file, lines.join('\n') + '\n'); return file; }
describe('archive reads', () => {
  it('pages a large conversation backwards without gaps or duplicates', async () => {
    const file = await write(Array.from({ length: 250 }, (_, i) => mkUser(`prompt ${i}`)));
    const last = await archivePage(file); const middle = await archivePage(file, last.blocks[0].id); const first = await archivePage(file, middle.blocks[0].id);
    expect([first.blocks.length, middle.blocks.length, last.blocks.length]).toEqual([50, 100, 100]);
    expect([first.more, middle.more, last.more]).toEqual([false, true, true]);
    expect(new Set([...first.blocks, ...middle.blocks, ...last.blocks].map((b) => b.id)).size).toBe(250);
  });
  it('searches text beyond the initial block cap', async () => {
    const file = await write([mkUser('x'.repeat(7000) + ' unique-needle')]);
    const page = await archivePage(file, undefined, 'UNIQUE-NEEDLE'); expect(page.blocks).toHaveLength(1);
    expect(page.overflow.get(page.blocks[0].id)).toContain('unique-needle');
  });
  it('applies tool results on initial open and can retrieve the uncapped output', async () => {
    const text = 'a'.repeat(20000);
    const file = await write([mkAssistant([mkToolUse('Read', {}, 'tool-1')], 'tool_use'), mkUser([{ type: 'tool_result', tool_use_id: 'tool-1', content: text }], { toolUseResult: { agentId: 'safe-agent' } })]);
    expect((await readTranscriptTail(file)).blocks[0]).toMatchObject({ kind: 'tool', state: 'done', result: { truncated: true } });
    expect(await archivedTool(file, 'tool-1')).toEqual({ text, agentId: 'safe-agent' });
    expect((await archivePage(file)).blocks[0]).toMatchObject({ state: 'done' });
  });
  it('reads sidechain content only when explicitly loading a subagent', async () => {
    const file = await write([mkAssistant([mkText('child work')], 'end_turn', { isSidechain: true })]);
    expect((await archivePage(file)).blocks).toHaveLength(0);
    expect((await archivePage(file, undefined, '', true)).blocks[0]).toMatchObject({ text: 'child work' });
    expect(() => subagentPath(file, '../../secret')).toThrow();
    expect(subagentPath(file, 'abc')).toBe(path.join(dir, 'session/subagents/agent-abc.jsonl'));
  });
  it('reports missing files and stale cursors rather than inventing an empty beginning', async () => {
    await expect(archivePage(path.join(dir, 'absent'))).rejects.toThrow();
    const file = await write([mkUser('one')]);
    await expect(archivePage(file, 't:missing')).rejects.toThrow('cursor');
  });
});

it('finds a query that occurs only in a later tool-result patch', async () => {
  const file = await write([mkAssistant([mkToolUse('Read', {}, 'tool-2')], 'tool_use'), mkUser([{ type: 'tool_result', tool_use_id: 'tool-2', content: 'needle in output' }])]);
  const page = await archivePage(file, undefined, 'needle');
  expect(page.blocks).toHaveLength(1);
  expect(page.blocks[0]).toMatchObject({ kind: 'tool', result: { text: 'needle in output' } });
});

it('loads only history older than the first visible live-runner block', async () => {
  const file = await write([mkUser('before', { timestamp: '2026-09-01T01:00:00Z' }), mkUser('current', { timestamp: '2026-09-01T02:00:00Z' })]);
  const page = await archivePage(file, undefined, '', false, '2026-09-01T02:00:00Z');
  expect(page.blocks).toHaveLength(1);
  expect(page.blocks[0]).toMatchObject({ text: 'before' });
});

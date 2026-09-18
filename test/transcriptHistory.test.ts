import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INIT_TAIL_BYTES,
  MAX_INIT_BLOCKS,
  loadResumeHistory,
  readTranscriptTail,
  transcriptPathFor,
} from '../src/claude/transcriptHistory';
import { mkAssistant, mkText, mkUser } from './fixtures';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const CWD = '/Users/test/proj';

describe('readTranscriptTail', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-hist-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Write a transcript and read it back the way the pane would. */
  async function write(lines: string[]): Promise<string> {
    const file = path.join(dir, 'session.jsonl');
    await fs.writeFile(file, lines.map((l) => `${l}\n`).join(''));
    return file;
  }

  it('turns a transcript into the blocks the pane renders', async () => {
    const file = await write([mkUser('do the thing'), mkAssistant([mkText('done')], 'end_turn')]);

    const read = await readTranscriptTail(file);

    expect(read.blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    expect(read.blocks[0]).toMatchObject({ text: 'do the thing' });
    expect(read.truncated).toBe(false);
    // The whole file was consumed, so a tailing caller carries on from the end.
    expect(read.byteOffset).toBe((await fs.stat(file)).size);
  });

  it('reads an empty conversation rather than throwing when the file is gone', async () => {
    const read = await readTranscriptTail(path.join(dir, 'nope.jsonl'));

    expect(read.blocks).toEqual([]);
    expect(read.truncated).toBe(false);
    expect(read.byteOffset).toBe(0);
  });

  it('reads an empty conversation when there is no path at all', async () => {
    // A session the registry knows about before its transcript exists.
    const read = await readTranscriptTail(undefined);

    expect(read.blocks).toEqual([]);
    expect(read.truncated).toBe(false);
  });

  it('keeps the newest blocks and flags the rest as truncated', async () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_INIT_BLOCKS + 20; i++) lines.push(mkUser(`prompt ${i}`));
    const file = await write(lines);

    const read = await readTranscriptTail(file);

    expect(read.blocks).toHaveLength(MAX_INIT_BLOCKS);
    expect(read.truncated).toBe(true);
    // The *newest* end is the one worth keeping: it is where you left off.
    expect(read.blocks.at(-1)).toMatchObject({ text: `prompt ${MAX_INIT_BLOCKS + 19}` });
  });

  it('reads only the tail of a file bigger than the window, and says so', async () => {
    // One fat prompt per line, so a handful of lines blow past the byte budget.
    const fat = 'x'.repeat(64 * 1024);
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(mkUser(`${i} ${fat}`));
    const file = await write(lines);
    expect((await fs.stat(file)).size).toBeGreaterThan(INIT_TAIL_BYTES);

    const read = await readTranscriptTail(file);

    expect(read.truncated).toBe(true);
    expect(read.blocks.length).toBeLessThan(12);
    // A partial first line is dropped, never rendered as a half-parsed block.
    expect(read.blocks.every((b) => b.kind === 'user')).toBe(true);
  });
});

describe('transcriptPathFor', () => {
  it('builds the path Claude Code writes, from the cwd slug and the id', () => {
    const file = transcriptPathFor(SESSION_ID, CWD);

    expect(path.basename(file)).toBe(`${SESSION_ID}.jsonl`);
    expect(path.basename(path.dirname(file))).toBe('-Users-test-proj');
  });
});

describe('loadResumeHistory', () => {
  let home: string;
  const realHome = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-home-'));
    process.env.CLAUDE_CONFIG_DIR = home;
  });

  afterEach(async () => {
    if (realHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = realHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('finds the resumed session s conversation by id and cwd', async () => {
    const dir = path.join(home, 'projects', '-Users-test-proj');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${SESSION_ID}.jsonl`),
      `${mkUser('where were we')}\n${mkAssistant([mkText('here')], 'end_turn')}\n`,
    );

    const history = await loadResumeHistory(SESSION_ID, CWD);

    expect(history.blocks.map((b) => b.kind)).toEqual(['user', 'assistant']);
    expect(history.blocks.at(-1)).toMatchObject({ text: 'here' });
  });

  it('is empty, not an error, when the cwd does not match the transcript', async () => {
    // The slug is a best-effort hint: a wrong cwd costs the history and nothing
    // else, so the pane still opens and the session still runs.
    const history = await loadResumeHistory(SESSION_ID, '/Users/test/somewhere-else');

    expect(history).toMatchObject({ blocks: [], truncated: false });
    expect(history.overflow?.size ?? 0).toBe(0);
  });
});

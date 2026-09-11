import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mergeSummaries,
  parseHeadLines,
  parseSummaryLines,
  readTranscriptSummary,
  splitCompleteLines,
  type TranscriptSummary,
} from '../src/claude/transcriptTail';
import {
  mkAiTitle,
  mkAssistant,
  mkAtisLatch,
  mkAttachment,
  mkLastPrompt,
  mkPrLink,
  mkQueueOp,
  mkSidechainAssistant,
  mkText,
  mkToolResult,
  mkToolUse,
  mkUser,
  toBuf,
} from './fixtures';

describe('splitCompleteLines', () => {
  it('splits complete lines and reports the byte offset past the last newline', () => {
    const buf = toBuf(['{"a":1}', '{"b":2}']);
    const { lines, endOffset } = splitCompleteLines(buf, false);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(endOffset).toBe(buf.length);
  });

  it('excludes a trailing partial line', () => {
    const full = toBuf(['{"a":1}']);
    const buf = Buffer.concat([full, Buffer.from('{"partial')]);
    const { lines, endOffset } = splitCompleteLines(buf, false);
    expect(lines).toEqual(['{"a":1}']);
    expect(endOffset).toBe(full.length);
  });

  it('discards the partial first line when starting mid-file', () => {
    const buf = Buffer.from('tail-of-a-line}\n{"b":2}\n', 'utf8');
    const { lines } = splitCompleteLines(buf, true);
    expect(lines).toEqual(['{"b":2}']);
  });

  it('returns nothing for a chunk with no newline', () => {
    const { lines, endOffset } = splitCompleteLines(Buffer.from('no newline here'), false);
    expect(lines).toEqual([]);
    expect(endOffset).toBe(0);
  });
});

describe('parseSummaryLines', () => {
  it('reads a finished turn: assistant end_turn with trailing metadata lines (real-world shape)', () => {
    const p = parseSummaryLines([
      mkAssistant([mkText('All done.')], 'end_turn'),
      mkAiTitle('Fix the flux capacitor'),
      mkLastPrompt('please fix it'),
      mkAtisLatch(),
    ]);
    expect(p.lastMeaningful).toMatchObject({ kind: 'assistant', stopReason: 'end_turn' });
    expect(p.aiTitle).toBe('Fix the flux capacitor');
    expect(p.lastPrompt).toBe('please fix it');
  });

  it('reads a mid-work tail: assistant tool_use', () => {
    const p = parseSummaryLines([mkAssistant([mkToolUse('Bash', { command: 'ls' })], 'tool_use')]);
    expect(p.lastMeaningful).toMatchObject({ kind: 'assistant', stopReason: 'tool_use' });
  });

  it('keeps the text of the latest reply, across the tool_use lines of the same turn', () => {
    const p = parseSummaryLines([
      mkUser('please fix it'),
      mkAssistant([mkText('Looking.')], 'tool_use'),
      mkAssistant([mkToolUse('Bash', { command: 'ls' })], 'tool_use'),
      mkUser([mkToolResult('out')]), // a tool result is not a new prompt
      mkAssistant([mkText('Fixed. Should I push?')], 'end_turn'),
    ]);
    expect(p.lastAssistantText).toBe('Fixed. Should I push?');
  });

  it('forgets the reply once a new prompt arrives', () => {
    const p = parseSummaryLines([mkAssistant([mkText('Fixed.')], 'end_turn'), mkUser('now do the other one')]);
    expect(p.lastAssistantText).toBeUndefined();
    expect(p.lastMeaningful?.kind).toBe('user');
  });

  it('treats user tool-result and queue-operation lines as meaningful', () => {
    expect(parseSummaryLines([mkUser([mkToolResult('out')])]).lastMeaningful?.kind).toBe('user');
    expect(parseSummaryLines([mkQueueOp()]).lastMeaningful?.kind).toBe('queue-operation');
  });

  it('ignores sidechain (subagent) lines and attachments', () => {
    const p = parseSummaryLines([
      mkAssistant([mkText('main')], 'end_turn'),
      mkAttachment(),
      mkSidechainAssistant(),
    ]);
    expect(p.lastMeaningful).toMatchObject({ kind: 'assistant', stopReason: 'end_turn' });
  });

  it('survives garbage lines', () => {
    const p = parseSummaryLines(['not json at all {{{', mkAssistant([mkText('ok')], 'end_turn'), '']);
    expect(p.lastMeaningful?.stopReason).toBe('end_turn');
  });

  it('captures cwd, gitBranch, slug and pr-link', () => {
    const p = parseSummaryLines([
      mkUser('hello'),
      mkPrLink(4851, 'https://github.com/x/y/pull/4851', 'x/y'),
    ]);
    expect(p.cwd).toBe('/Users/test/proj');
    expect(p.gitBranch).toBe('dev');
    expect(p.slug).toBe('test-session-slug');
    expect(p.prLink).toEqual({ prNumber: 4851, prUrl: 'https://github.com/x/y/pull/4851', prRepository: 'x/y' });
  });
});

describe('parseHeadLines', () => {
  it('extracts the first non-meta user prompt, string content', () => {
    const h = parseHeadLines([
      mkUser('<local-command-caveat>ignore me</local-command-caveat>', { isMeta: true }),
      mkUser('Build me a VSCode extension please'),
    ]);
    expect(h.firstUserText).toBe('Build me a VSCode extension please');
  });

  it('extracts array text content', () => {
    const h = parseHeadLines([mkUser([mkText('array style prompt')])]);
    expect(h.firstUserText).toBe('array style prompt');
  });

  it('skips tool_result-only user lines', () => {
    const h = parseHeadLines([mkUser([mkToolResult('big output')]), mkUser('real prompt')]);
    expect(h.firstUserText).toBe('real prompt');
  });
});

describe('mergeSummaries', () => {
  it('overlays newer fields, keeps prior ones', () => {
    const prev: TranscriptSummary = {
      lastMeaningful: { kind: 'user' },
      aiTitle: 'Old title',
      slug: 'old-slug',
      headReadDone: true,
      byteOffset: 100,
      mtimeMs: 1,
      sizeBytes: 100,
    };
    const merged = mergeSummaries(
      prev,
      { lastMeaningful: { kind: 'assistant', stopReason: 'end_turn' } },
      { sizeBytes: 200, mtimeMs: 2, byteOffset: 200 },
    );
    expect(merged.lastMeaningful?.stopReason).toBe('end_turn');
    expect(merged.aiTitle).toBe('Old title');
    expect(merged.slug).toBe('old-slug');
    expect(merged.headReadDone).toBe(true);
    expect(merged.byteOffset).toBe(200);
  });

  it('keeps the old reply text only when the new chunk saw no turn activity', () => {
    const prev: TranscriptSummary = {
      lastMeaningful: { kind: 'assistant', stopReason: 'end_turn' },
      lastAssistantText: 'Old reply.',
      headReadDone: true,
      byteOffset: 100,
      mtimeMs: 1,
      sizeBytes: 100,
    };
    const stat = { sizeBytes: 200, mtimeMs: 2, byteOffset: 200 };
    // Only metadata lines appended (ai-title etc.): the reply still stands.
    expect(mergeSummaries(prev, { aiTitle: 'T' }, stat).lastAssistantText).toBe('Old reply.');
    // A new prompt appended: the chunk cleared the reply, and that wins.
    expect(mergeSummaries(prev, { lastMeaningful: { kind: 'user' } }, stat).lastAssistantText).toBeUndefined();
  });
});

describe('readTranscriptSummary (fs integration)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-test-'));
    file = path.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns undefined for a missing file', async () => {
    expect(await readTranscriptSummary(path.join(dir, 'nope.jsonl'))).toBeUndefined();
  });

  it('reads incrementally across appends, only new bytes', async () => {
    await fs.writeFile(file, toBuf([mkUser('start'), mkAssistant([mkToolUse('Bash', { command: 'ls' })], 'tool_use')]));
    const s1 = await readTranscriptSummary(file);
    expect(s1?.lastMeaningful).toMatchObject({ kind: 'assistant', stopReason: 'tool_use' });
    const offset1 = s1!.byteOffset;
    expect(offset1).toBe((await fs.stat(file)).size);

    await fs.appendFile(file, toBuf([mkAssistant([mkText('done')], 'end_turn'), mkAiTitle('New Title')]));
    const s2 = await readTranscriptSummary(file, s1);
    expect(s2?.lastMeaningful?.stopReason).toBe('end_turn');
    expect(s2?.aiTitle).toBe('New Title');
    expect(s2?.byteOffset).toBe((await fs.stat(file)).size);
    expect(s2?.byteOffset).toBeGreaterThan(offset1);

    // unchanged file → identical object back (cheap poll path)
    const s3 = await readTranscriptSummary(file, s2);
    expect(s3).toBe(s2);
  });

  it('leaves a partial trailing line for the next pass', async () => {
    await fs.writeFile(file, toBuf([mkUser('start')]));
    const s1 = await readTranscriptSummary(file);
    const boundary = s1!.byteOffset;

    const nextLine = mkAssistant([mkText('finished')], 'end_turn');
    const half = Math.floor(nextLine.length / 2);
    await fs.appendFile(file, nextLine.slice(0, half));
    const s2 = await readTranscriptSummary(file, s1);
    expect(s2?.lastMeaningful?.kind).toBe('user'); // partial line not parsed
    expect(s2?.byteOffset).toBe(boundary);

    await fs.appendFile(file, nextLine.slice(half) + '\n');
    const s3 = await readTranscriptSummary(file, s2);
    expect(s3?.lastMeaningful).toMatchObject({ kind: 'assistant', stopReason: 'end_turn' });
  });

  it('falls back to a head read for the title when the tail window lacks one', async () => {
    // Small tail chunk to force the tail window to miss the head.
    const lines = [mkUser('the very first prompt', { slug: undefined })];
    for (let i = 0; i < 50; i++) lines.push(mkAttachment());
    // Strip slug from every line so only firstUserText can provide a title.
    const stripped = lines.map((l) => {
      const o = JSON.parse(l);
      delete o.slug;
      return JSON.stringify(o);
    });
    await fs.writeFile(file, toBuf(stripped));
    const s = await readTranscriptSummary(file, undefined, {
      tailChunkBytes: 512,
      headChunkBytes: 64 * 1024,
      needTitle: true,
    });
    expect(s?.firstUserText).toBe('the very first prompt');
    expect(s?.headReadDone).toBe(true);
  });

  it('handles a rewritten (truncated) file by starting over', async () => {
    await fs.writeFile(file, toBuf([mkUser('one'), mkAssistant([mkText('a')], 'end_turn')]));
    const s1 = await readTranscriptSummary(file);
    await fs.writeFile(file, toBuf([mkUser('fresh')])); // smaller than s1.byteOffset
    const s2 = await readTranscriptSummary(file, s1);
    expect(s2?.lastMeaningful?.kind).toBe('user');
    expect(s2?.byteOffset).toBe((await fs.stat(file)).size);
  });
});

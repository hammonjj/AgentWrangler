/**
 * Bounded, incremental reader for Claude Code transcript JSONL files.
 *
 * Transcripts can be tens of MB; we never read more than ~1 MiB in a pass.
 * A per-file byte offset (always on a line boundary) lets watcher-driven
 * updates read only appended bytes.
 *
 * The parsing core is pure (Buffer/string in, summary out) for unit testing;
 * only `readTranscriptSummary` touches the filesystem.
 */
import * as fs from 'node:fs/promises';
import type { PrLink } from '../shared/model';

export const TAIL_CHUNK_BYTES = 256 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const HEAD_CHUNK_BYTES = 64 * 1024;

export interface LastMeaningful {
  kind: 'assistant' | 'user' | 'queue-operation';
  /** message.stop_reason for assistant lines ("end_turn", "tool_use", null while streaming). */
  stopReason?: string | null;
  timestamp?: string;
}

export interface TranscriptSummary {
  lastMeaningful?: LastMeaningful;
  /**
   * Text blocks of the most recent assistant line that had any. Claude Code
   * writes one line per content block, so the final line of a finished turn is
   * normally the reply text; this is what says whether that reply asked for
   * anything (waiting) or just reported (done).
   */
  lastAssistantText?: string;
  /** Last {"type":"ai-title"} seen — the freshest model-generated title. */
  aiTitle?: string;
  /** Last {"type":"last-prompt"} seen (~200 char preview of the user's last prompt). */
  lastPrompt?: string;
  /** `slug` field stamped on user/assistant lines (kebab-case of the first prompt). */
  slug?: string;
  cwd?: string;
  gitBranch?: string;
  prLink?: PrLink;
  /** Head-read fallback title, fetched at most once per file. */
  firstUserText?: string;
  headReadDone: boolean;
  /** File offset just past the last complete line processed (a '\n' boundary). */
  byteOffset: number;
  mtimeMs: number;
  sizeBytes: number;
}

const NL = 0x0a;

/**
 * Split a chunk into complete lines. `endOffset` is the index just past the
 * last '\n' in the buffer (0 if none) — a trailing partial line is excluded
 * and will be re-read on the next pass. With `startsMidLine`, everything up
 * to (and including) the first '\n' is discarded — this both drops the
 * partial first line of a mid-file read and neutralizes a UTF-8 character
 * split at the read boundary.
 */
export function splitCompleteLines(buf: Buffer, startsMidLine: boolean): { lines: string[]; endOffset: number } {
  let start = 0;
  if (startsMidLine) {
    const firstNl = buf.indexOf(NL);
    if (firstNl === -1) return { lines: [], endOffset: 0 };
    start = firstNl + 1;
  }
  const lastNl = buf.lastIndexOf(NL);
  if (lastNl === -1 || lastNl < start) return { lines: [], endOffset: startsMidLine ? start : 0 };

  const text = buf.subarray(start, lastNl).toString('utf8');
  const lines = text.length === 0 ? [] : text.split('\n');
  return { lines, endOffset: lastNl + 1 };
}

/** Fields extractable from a parsed chunk (forward pass, last-wins ≡ backwards scan). */
export type SummaryPartial = Pick<
  TranscriptSummary,
  'lastMeaningful' | 'lastAssistantText' | 'aiTitle' | 'lastPrompt' | 'slug' | 'cwd' | 'gitBranch' | 'prLink'
>;

/** Cap on the reply text kept per transcript; `needsReply` only reads the tail anyway. */
const MAX_REPLY_CHARS = 4000;

/** Joined text blocks of an assistant message's content, or undefined when there are none. */
function assistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_REPLY_CHARS ? text.slice(-MAX_REPLY_CHARS) : text;
}

export function parseSummaryLines(lines: string[]): SummaryPartial {
  const out: SummaryPartial = {};
  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // partial flush / corruption — skip the line, keep going
    }
    if (!obj || typeof obj !== 'object') continue;
    if (obj.isSidechain === true) continue; // subagent lines are not this session's state

    if (typeof obj.cwd === 'string') out.cwd = obj.cwd;
    if (typeof obj.gitBranch === 'string') out.gitBranch = obj.gitBranch;
    if (typeof obj.slug === 'string') out.slug = obj.slug;

    switch (obj.type) {
      case 'assistant': {
        out.lastMeaningful = {
          kind: 'assistant',
          stopReason: obj.message?.stop_reason ?? null,
          timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
        };
        const text = assistantText(obj.message?.content);
        if (text !== undefined) out.lastAssistantText = text;
        break;
      }
      case 'user':
        out.lastMeaningful = {
          kind: 'user',
          timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
        };
        // A real prompt starts a new turn, so the previous reply is spent. Tool
        // results are also `user` lines but belong to the turn in progress.
        if (!isToolResultOnly(obj.message?.content)) out.lastAssistantText = undefined;
        break;
      case 'queue-operation':
        out.lastMeaningful = {
          kind: 'queue-operation',
          timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined,
        };
        break;
      case 'ai-title':
        if (typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) out.aiTitle = obj.aiTitle.trim();
        break;
      case 'last-prompt':
        if (typeof obj.lastPrompt === 'string' && obj.lastPrompt.trim()) out.lastPrompt = obj.lastPrompt.trim();
        break;
      case 'pr-link':
        if (typeof obj.prUrl === 'string') {
          out.prLink = {
            prNumber: typeof obj.prNumber === 'number' ? obj.prNumber : 0,
            prUrl: obj.prUrl,
            prRepository: typeof obj.prRepository === 'string' ? obj.prRepository : undefined,
          };
        }
        break;
      default:
        break; // attachment, atis-latch, file-history-*, unknown → metadata, ignore
    }
  }
  return out;
}

/** True for a `user` line that only carries tool results (mid-turn plumbing, not a prompt). */
function isToolResultOnly(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((b: any) => b && typeof b === 'object' && b.type === 'tool_result')
  );
}

/** Head-chunk pass: only contributes a first-prompt fallback title (+ ids if still missing). */
export function parseHeadLines(lines: string[]): { firstUserText?: string; slug?: string; cwd?: string; gitBranch?: string } {
  const out: { firstUserText?: string; slug?: string; cwd?: string; gitBranch?: string } = {};
  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || obj.isSidechain === true) continue;
    if (out.slug === undefined && typeof obj.slug === 'string') out.slug = obj.slug;
    if (out.cwd === undefined && typeof obj.cwd === 'string') out.cwd = obj.cwd;
    if (out.gitBranch === undefined && typeof obj.gitBranch === 'string') out.gitBranch = obj.gitBranch;
    if (out.firstUserText === undefined && obj.type === 'user' && obj.isMeta !== true) {
      const text = extractUserText(obj.message?.content);
      if (text) out.firstUserText = text;
    }
    if (out.firstUserText !== undefined) break;
  }
  return out;
}

export function extractUserText(content: unknown): string | undefined {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  text = text
    .replace(/<[^>\n]{1,80}>/g, ' ') // strip caveat/system tag wrappers
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

export function mergeSummaries(
  prev: TranscriptSummary | undefined,
  next: SummaryPartial,
  stat: { sizeBytes: number; mtimeMs: number; byteOffset: number; headReadDone?: boolean },
): TranscriptSummary {
  // The reply text is cleared by a new prompt, so "unset in this chunk" only
  // means "keep the old one" when the chunk saw no prompt or reply at all.
  const sawTurnBoundary = next.lastMeaningful !== undefined;
  return {
    lastMeaningful: next.lastMeaningful ?? prev?.lastMeaningful,
    lastAssistantText: sawTurnBoundary ? next.lastAssistantText : prev?.lastAssistantText,
    aiTitle: next.aiTitle ?? prev?.aiTitle,
    lastPrompt: next.lastPrompt ?? prev?.lastPrompt,
    slug: next.slug ?? prev?.slug,
    cwd: next.cwd ?? prev?.cwd,
    gitBranch: next.gitBranch ?? prev?.gitBranch,
    prLink: next.prLink ?? prev?.prLink,
    firstUserText: prev?.firstUserText,
    headReadDone: stat.headReadDone ?? prev?.headReadDone ?? false,
    byteOffset: stat.byteOffset,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.sizeBytes,
  };
}

/** Read bytes [start, end) of a file. Returns undefined on any fs error (e.g. ENOENT mid-read). */
export async function readRange(filePath: string, start: number, end: number): Promise<Buffer | undefined> {
  if (end <= start) return Buffer.alloc(0);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const length = end - start;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface ReadOptions {
  tailChunkBytes?: number;
  headChunkBytes?: number;
  /** Fetch the head-chunk fallback title if no better title source is known yet. */
  needTitle?: boolean;
}

/**
 * Produce/refresh a summary for a transcript file. Returns `prev` untouched
 * when size+mtime are unchanged (the cheap poll path) and `undefined` when
 * the file is gone.
 */
export async function readTranscriptSummary(
  filePath: string,
  prev?: TranscriptSummary,
  opts?: ReadOptions,
): Promise<TranscriptSummary | undefined> {
  const tailChunk = opts?.tailChunkBytes ?? TAIL_CHUNK_BYTES;
  const headChunk = opts?.headChunkBytes ?? HEAD_CHUNK_BYTES;

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return undefined;
  }
  const size = stat.size;
  const mtimeMs = stat.mtimeMs;

  if (prev && size === prev.sizeBytes && mtimeMs === prev.mtimeMs) return prev;

  const rewritten = prev !== undefined && size < prev.byteOffset;
  const base = rewritten ? undefined : prev;

  let partial: SummaryPartial = {};
  let byteOffset: number;
  let coveredHead = false;

  if (base && size > base.byteOffset && size - base.byteOffset <= tailChunk) {
    // Incremental: read only the appended bytes; offset is a line boundary.
    const buf = await readRange(filePath, base.byteOffset, size);
    if (buf === undefined) return undefined;
    const { lines, endOffset } = splitCompleteLines(buf, false);
    partial = parseSummaryLines(lines);
    byteOffset = base.byteOffset + endOffset;
  } else if (base && size === base.byteOffset) {
    // mtime changed but nothing appended (touch) — just refresh stat fields.
    byteOffset = base.byteOffset;
  } else {
    // Fresh tail read (first look, or gap larger than a chunk, or rewrite).
    let readStart = Math.max(0, size - tailChunk);
    let buf = await readRange(filePath, readStart, size);
    if (buf === undefined) return undefined;
    let split = splitCompleteLines(buf, readStart > 0);
    if (split.lines.length === 0 && readStart > 0 && size > tailChunk) {
      // Huge single line — one bigger retry, then give up and let mtime drive status.
      readStart = Math.max(0, size - MAX_CHUNK_BYTES);
      buf = await readRange(filePath, readStart, size);
      if (buf === undefined) return undefined;
      split = splitCompleteLines(buf, readStart > 0);
    }
    partial = parseSummaryLines(split.lines);
    byteOffset = readStart + split.endOffset;
    coveredHead = readStart === 0;
  }

  let summary = mergeSummaries(base, partial, {
    sizeBytes: size,
    mtimeMs,
    byteOffset,
    headReadDone: coveredHead ? true : undefined,
  });

  // Head fallback for a title, at most once per file.
  if (
    opts?.needTitle &&
    !summary.headReadDone &&
    summary.aiTitle === undefined &&
    summary.slug === undefined &&
    summary.firstUserText === undefined
  ) {
    const buf = await readRange(filePath, 0, Math.min(size, headChunk));
    if (buf !== undefined) {
      const { lines } = splitCompleteLines(buf, false);
      const head = parseHeadLines(lines);
      summary = {
        ...summary,
        firstUserText: head.firstUserText,
        slug: summary.slug ?? head.slug,
        cwd: summary.cwd ?? head.cwd,
        gitBranch: summary.gitBranch ?? head.gitBranch,
      };
    }
    summary.headReadDone = true; // never repeat, even on failure
  }

  return summary;
}

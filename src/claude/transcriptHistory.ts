/**
 * The tail of a transcript file, as conversation blocks.
 *
 * Two callers need exactly this read. The read-only pane opens on a session it
 * does not own and shows what is in the file. And a session this window
 * **resumes** — after a reload, a Take over, or a Resume here — has a whole
 * conversation behind it that exists *only* in the file: the SDK replays
 * nothing to a resuming client, it just continues. Without this read a resumed
 * pane rendered an empty conversation while the model still held every word of
 * it, so the only way to see where you were was to ask the agent to repeat
 * itself.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ConvBlock } from '../shared/conversation';
import { projectsDir, slugForCwd } from './paths';
import { createTranscriptState, reduceTranscriptLines, type TranscriptState } from './transcriptBlocks';
import { readRange, splitCompleteLines } from './transcriptTail';

/** Tail read on open: enough for a long session's recent history, never the whole file. */
export const INIT_TAIL_BYTES = 512 * 1024;
/** Blocks rendered on open. The rest of the tail is dropped with a "truncated" notch. */
export const MAX_INIT_BLOCKS = 300;

/** What was said before now, and whether there was more of it than we kept. */
export interface ConversationHistory {
  blocks: ConvBlock[];
  /** Conversation exists above the first block; the pane says so rather than implying a start. */
  truncated: boolean;
}

export interface TranscriptTailRead extends ConversationHistory {
  /** Reducer state, so a caller that keeps tailing carries on from here. */
  state: TranscriptState;
  /** First byte not yet consumed. */
  byteOffset: number;
}

/** An empty result, fresh each time: callers keep the array they are given. */
function emptyRead(state: TranscriptState): TranscriptTailRead {
  return { blocks: [], truncated: false, state, byteOffset: 0 };
}

/**
 * Where Claude Code keeps a session's transcript.
 *
 * `slugForCwd` is the direction Claude Code itself computes, so this is exact
 * when the cwd is right, and simply finds no file when it is not — which costs
 * a resumed pane its history and nothing else.
 */
export function transcriptPathFor(sessionId: string, cwd: string): string {
  return path.join(projectsDir(), slugForCwd(cwd), `${sessionId}.jsonl`);
}

/**
 * Read the last `INIT_TAIL_BYTES` of a transcript into blocks.
 *
 * Never throws: a missing or unreadable file reads as an empty conversation,
 * because the pane's status line already says what happened to the session and
 * an error page there would be worse than a quiet one.
 */
export async function readTranscriptTail(filePath: string | undefined): Promise<TranscriptTailRead> {
  const state = createTranscriptState();
  if (!filePath) return emptyRead(state);

  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return emptyRead(state);
  }

  const readStart = Math.max(0, size - INIT_TAIL_BYTES);
  const buf = await readRange(filePath, readStart, size);
  if (buf === undefined) return emptyRead(state);

  const split = splitCompleteLines(buf, readStart > 0);
  // Patches are dropped here on purpose: a result whose call is above the
  // window has nothing on screen to patch.
  let blocks = reduceTranscriptLines(state, split.lines).appends;
  const truncated = readStart > 0 || blocks.length > MAX_INIT_BLOCKS;
  if (blocks.length > MAX_INIT_BLOCKS) blocks = blocks.slice(-MAX_INIT_BLOCKS);
  return { blocks, truncated, state, byteOffset: readStart + split.endOffset };
}

/**
 * The conversation behind a session this window is about to resume.
 *
 * Read once, before the resumed process can append to the file, so what comes
 * back is strictly the *old* half of the conversation. The new half arrives
 * live through the runner's own blocks, and the two must never overlap.
 */
export async function loadResumeHistory(sessionId: string, cwd: string): Promise<ConversationHistory> {
  const { blocks, truncated } = await readTranscriptTail(transcriptPathFor(sessionId, cwd));
  return { blocks, truncated };
}

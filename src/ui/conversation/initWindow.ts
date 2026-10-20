/**
 * The recent window a conversation opens with (#192).
 *
 * A long conversation need not arrive whole to be useful: the last turns render at once, and the
 * pane's "Load earlier messages" pages the rest in from the transcript (`archivePage`, by a cursor
 * that is the id or time of the first block shown). Over the relay every block is billed bytes
 * and a slow batch behind it, so a remote tab opens on a small window.
 */
import type { ConvBlock } from '../../shared/conversation';

/** Blocks a remote tab opens with. A LAN tab keeps `MAX_INIT_BLOCKS`. */
export const RELAY_INIT_BLOCKS = 60;

export interface InitWindow {
  blocks: ConvBlock[];
  /** Blocks were left off the front: the pane offers "Load earlier messages". */
  trimmed: boolean;
}

/**
 * The last `max` blocks, starting where a turn starts: the window begins at a user message when
 * one is near, so an assistant's work is not shown without the question it answers. It may take a
 * few more than `max` to do that, never fewer, and never more than half again.
 */
export function recentWindow(blocks: ConvBlock[], max: number): InitWindow {
  if (blocks.length <= max) return { blocks, trimmed: false };
  const target = blocks.length - max;
  const floor = Math.max(0, target - Math.floor(max / 2));
  let start = target;
  for (let i = target; i >= floor; i--) {
    if (blocks[i].kind === 'user') {
      start = i;
      break;
    }
  }
  return { blocks: blocks.slice(start), trimmed: start > 0 };
}

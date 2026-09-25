/**
 * `aw attach`: a session's conversation as terminal lines. Pure.
 *
 * The core streams the same view the pane gets (blocks, then appends and
 * patches). A terminal cannot redraw a block the way the pane does, so this
 * prints each block once, when it is final: prose when it stops streaming, a
 * tool call when it starts and again only if it fails, an ask when it opens
 * and when it is settled.
 */
import type { SessionViewEvent } from '../core/session/sessionHandle';
import type { BlockPatch, ConvBlock } from '../shared/conversation';
import { safe } from './format';

/** How many blocks of the snapshot to show on attach; older ones are counted, not printed. */
export const ATTACH_BACKLOG = 20;

export class AttachRenderer {
  private blocks = new Map<string, ConvBlock>();
  /** Blocks already printed in their final form. */
  private printed = new Set<string>();

  /** The snapshot: the last few finished blocks, and what is open now. */
  start(blocks: readonly ConvBlock[], truncated: boolean): string[] {
    const out: string[] = [];
    const shown = blocks.slice(-ATTACH_BACKLOG);
    const hidden = blocks.length - shown.length;
    if (hidden > 0 || truncated) out.push('… earlier conversation not shown (open it in the app)');
    for (const b of blocks) this.blocks.set(b.id, b);
    for (const b of blocks.slice(0, hidden)) this.printed.add(b.id);
    for (const b of shown) out.push(...this.appear(b));
    return out.map(safe);
  }

  /** The lines an event adds. Agent-written text, so control characters are stripped. */
  event(e: SessionViewEvent): string[] {
    return this.eventLines(e).map(safe);
  }

  private eventLines(e: SessionViewEvent): string[] {
    switch (e.type) {
      case 'append':
        return e.blocks.flatMap((b) => {
          this.blocks.set(b.id, b);
          return this.appear(b);
        });
      case 'patch':
        return this.patch(e.patch);
      case 'lifecycle':
        if (e.lifecycle === 'ended') return ['— the session ended'];
        if (e.lifecycle === 'error') return ['— the session stopped with an error'];
        if (e.lifecycle === 'unreachable') return ['— its session host is not answering'];
        return [];
      case 'reset':
        this.blocks.clear();
        this.printed.clear();
        return ['— the conversation was cleared'];
      case 'turnEnd':
        return ['— turn finished'];
      default:
        return [];
    }
  }

  /** A block's first sight. Prose still streaming waits for its last patch. */
  private appear(b: ConvBlock): string[] {
    if ((b.kind === 'assistant' || b.kind === 'thinking') && b.streaming) return [];
    if (this.printed.has(b.id)) return [];
    this.printed.add(b.id);
    const lines = renderBlock(b);
    // A settled ask seen for the first time (in the snapshot): say how it went too.
    if ((b.kind === 'permission' || b.kind === 'question' || b.kind === 'plan') && b.state !== 'pending') {
      lines.push(...indent(b, [`→ ${settled(b.state)}`]));
    }
    if (b.kind === 'tool' && b.state === 'error') lines.push(...toolError(b));
    return lines;
  }

  private patch(p: BlockPatch): string[] {
    const before = this.blocks.get(p.id);
    if (!before) return [];
    const after = { ...before, ...p.block } as ConvBlock;
    this.blocks.set(p.id, after);
    if (!this.printed.has(p.id)) return this.appear(after);
    if (after.kind === 'tool' && before.kind === 'tool' && before.state === 'running' && after.state === 'error') return toolError(after);
    if (
      (after.kind === 'permission' || after.kind === 'question' || after.kind === 'plan') &&
      (before.kind === 'permission' || before.kind === 'question' || before.kind === 'plan') &&
      before.state === 'pending' &&
      after.state !== 'pending'
    ) {
      return indent(after, [`→ ${settled(after.state)}`]);
    }
    return [];
  }
}

function settled(state: string): string {
  switch (state) {
    case 'allowed':
      return 'allowed';
    case 'denied':
      return 'denied';
    case 'expired':
      return 'no longer asked';
    default:
      return state;
  }
}

/** One block, as lines. */
export function renderBlock(b: ConvBlock): string[] {
  const more = (n?: number) => (n ? [`… ${n} more characters (open it in the app)`] : []);
  switch (b.kind) {
    case 'user':
      return indent(b, [...prefixLines('> ', b.text), ...(b.imageCount ? [`> [${b.imageCount} image${b.imageCount === 1 ? '' : 's'}]`] : []), ...more(b.more)]);
    case 'assistant':
      return indent(b, [...b.text.split('\n'), ...more(b.more)]);
    case 'thinking':
      return [];
    case 'tool':
      return indent(b, [`▸ ${b.name}${b.inputPreview ? ` ${oneLine(b.inputPreview)}` : ''}`]);
    case 'permission': {
      const what = b.body ?? b.summary;
      return indent(b, [`? ${b.toolName} wants permission${what ? `: ${oneLine(what)}` : ''} (answer it in the app or Discord)`]);
    }
    case 'question':
      return indent(b, [`? Question: ${b.questions.map((q) => q.question).join(' / ')} (answer it in the app)`]);
    case 'plan': {
      const first = b.plan.split('\n').find((l) => l.trim().length > 0) ?? '';
      return indent(b, [`? Plan waiting for approval: ${oneLine(first.replace(/^#+\s*/, ''))} (answer it in the app)`]);
    }
    case 'note':
      return indent(b, [`${b.tone === 'info' ? '·' : '!'} ${b.text}`]);
    default:
      return [];
  }
}

function toolError(b: Extract<ConvBlock, { kind: 'tool' }>): string[] {
  const first = b.result?.text.split('\n').find((l) => l.trim().length > 0);
  return indent(b, [`  ✗ ${first ? oneLine(first) : 'failed'}`]);
}

/** A subagent's blocks sit under its Agent call. */
function indent(b: ConvBlock, lines: string[]): string[] {
  return b.parentToolUseId ? lines.map((l) => `    ${l}`) : lines;
}

function prefixLines(prefix: string, text: string): string[] {
  return text.split('\n').map((l) => `${prefix}${l}`);
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

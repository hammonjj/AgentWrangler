/**
 * Agent SDK messages → conversation blocks. Pure: no vscode, no fs, no SDK
 * runtime import (types only), so the whole stream can be replayed in tests.
 *
 * The awkward part is that one API message reaches us twice. With
 * `includePartialMessages` the text arrives as a run of `stream_event` deltas —
 * which is what makes a reply appear a word at a time — and then the same text
 * arrives again as a complete `assistant` message. Rendering both would double
 * every reply.
 *
 * The rule here: streaming **creates** text and thinking blocks, and the
 * complete message only **corrects** them. The CLI emits one `assistant`
 * message per content block, in the same order the blocks were streamed, so the
 * n-th text block of a message reconciles with the n-th streamed text slot. If
 * no streaming happened at all (an interrupted turn, a build with partial
 * messages off) there are no slots and the complete message is appended as-is,
 * so nothing is ever lost.
 *
 * Tool calls are only ever created from the complete message: their input
 * arrives as partial JSON that is useless until it is whole.
 */
import {
  capText,
  MAX_TOOL_RESULT_CHARS,
  type BlockPatch,
  type ComposerState,
  type ConvBlock,
  type ToolResultView,
} from '../../shared/conversation';
import { diffFromToolUseResult, toolInputPreview } from '../transcriptBlocks';

export interface RunnerSlot {
  id: string;
  kind: 'assistant' | 'thinking';
  text: string;
  /** The complete message has already corrected this slot. */
  reconciled: boolean;
}

export interface RunnerBlocksState {
  counter: number;
  /** Streamed blocks of the API message in flight, in content order. */
  slots: RunnerSlot[];
  /** Stream-event content index → position in `slots`. */
  byIndex: Map<number, number>;
  /** `tool_use_id` → block id, so a result patches the call that made it. */
  toolBlocks: Map<string, string>;
  /** Model of the message in flight, stamped onto its assistant blocks. */
  model?: string;
}

export interface TurnEnd {
  isError: boolean;
  text: string;
  /** Sends still waiting behind this turn, so the composer can say so. */
  queued: number;
}

export interface RunnerReduction {
  appends: ConvBlock[];
  patches: BlockPatch[];
  /** What this message says about the session's live state, if anything. */
  composer?: Partial<ComposerState>;
  /** Present on the one `result` message that ends a turn. */
  turnEnd?: TurnEnd;
}

export function createRunnerState(): RunnerBlocksState {
  return { counter: 0, slots: [], byIndex: new Map(), toolBlocks: new Map() };
}

const EMPTY: RunnerReduction = { appends: [], patches: [] };

function nextId(state: RunnerBlocksState): string {
  return `r:${++state.counter}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A note block, for the things that are facts about the run rather than conversation. */
export function noteBlock(state: RunnerBlocksState, tone: 'info' | 'warn' | 'error', text: string): ConvBlock {
  return { kind: 'note', id: nextId(state), ts: nowIso(), tone, text: capText(text, 600) };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join('\n');
  }
  return '';
}

function toolResultView(content: unknown, isError: boolean, tur: unknown): ToolResultView {
  const raw = resultText(content).trim();
  return {
    text: raw.length > MAX_TOOL_RESULT_CHARS ? raw.slice(0, MAX_TOOL_RESULT_CHARS) : raw,
    isError,
    truncated: raw.length > MAX_TOOL_RESULT_CHARS,
    diff: diffFromToolUseResult(tur),
  };
}

/** The streamed slot a complete content block should correct, if there is one. */
function claimSlot(state: RunnerBlocksState, kind: 'assistant' | 'thinking'): RunnerSlot | undefined {
  return state.slots.find((s) => s.kind === kind && !s.reconciled);
}

function reduceStreamEvent(state: RunnerBlocksState, event: any): RunnerReduction {
  if (!event || typeof event !== 'object') return EMPTY;

  switch (event.type) {
    case 'message_start': {
      // A new API message: its content blocks are numbered from zero again.
      state.slots = [];
      state.byIndex = new Map();
      const model = event.message?.model;
      state.model = typeof model === 'string' ? model : undefined;
      return EMPTY;
    }
    case 'content_block_start': {
      const kind =
        event.content_block?.type === 'text'
          ? 'assistant'
          : event.content_block?.type === 'thinking'
            ? 'thinking'
            : undefined;
      if (!kind || typeof event.index !== 'number') return EMPTY;
      const id = nextId(state);
      state.byIndex.set(event.index, state.slots.length);
      state.slots.push({ id, kind, text: '', reconciled: false });
      const block: ConvBlock =
        kind === 'assistant'
          ? { kind: 'assistant', id, ts: nowIso(), text: '', streaming: true, model: state.model }
          : { kind: 'thinking', id, ts: nowIso(), text: '', streaming: true };
      return { appends: [block], patches: [] };
    }
    case 'content_block_delta': {
      const slot = slotAt(state, event.index);
      if (!slot) return EMPTY;
      const delta = event.delta ?? {};
      const piece =
        typeof delta.text === 'string' ? delta.text : typeof delta.thinking === 'string' ? delta.thinking : undefined;
      if (piece === undefined) return EMPTY; // input_json_delta and friends
      slot.text += piece;
      return { appends: [], patches: [{ id: slot.id, block: { text: capText(slot.text) } }] };
    }
    case 'content_block_stop': {
      const slot = slotAt(state, event.index);
      if (!slot) return EMPTY;
      return { appends: [], patches: [{ id: slot.id, block: { streaming: false } }] };
    }
    default:
      return EMPTY;
  }
}

function slotAt(state: RunnerBlocksState, index: unknown): RunnerSlot | undefined {
  if (typeof index !== 'number') return undefined;
  const at = state.byIndex.get(index);
  return at === undefined ? undefined : state.slots[at];
}

function reduceAssistant(state: RunnerBlocksState, msg: any): RunnerReduction {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return EMPTY;
  const model = typeof msg.message?.model === 'string' ? msg.message.model : state.model;
  const appends: ConvBlock[] = [];
  const patches: BlockPatch[] = [];

  for (const b of content) {
    if (!b || typeof b !== 'object') continue;

    if (b.type === 'text' && typeof b.text === 'string') {
      if (!b.text.trim()) continue;
      const slot = claimSlot(state, 'assistant');
      if (slot) {
        slot.reconciled = true;
        slot.text = b.text;
        patches.push({ id: slot.id, block: { text: capText(b.text), streaming: false, model } });
      } else {
        appends.push({ kind: 'assistant', id: nextId(state), ts: nowIso(), text: capText(b.text), model });
      }
      continue;
    }

    if (b.type === 'thinking' && typeof b.thinking === 'string') {
      if (!b.thinking.trim()) continue;
      const slot = claimSlot(state, 'thinking');
      if (slot) {
        slot.reconciled = true;
        slot.text = b.thinking;
        patches.push({ id: slot.id, block: { text: capText(b.thinking), streaming: false } });
      } else {
        appends.push({ kind: 'thinking', id: nextId(state), ts: nowIso(), text: capText(b.thinking) });
      }
      continue;
    }

    if (b.type === 'tool_use') {
      const id = nextId(state);
      const toolUseId = typeof b.id === 'string' ? b.id : id;
      state.toolBlocks.set(toolUseId, id);
      appends.push({
        kind: 'tool',
        id,
        ts: nowIso(),
        toolUseId,
        name: typeof b.name === 'string' ? b.name : 'tool',
        inputPreview: toolInputPreview(b.input),
        input: b.input,
        state: 'running',
        parentToolUseId: typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : undefined,
      });
    }
  }

  return { appends, patches };
}

function reduceUser(state: RunnerBlocksState, msg: any): RunnerReduction {
  const content = msg?.message?.content;
  if (!Array.isArray(content)) return EMPTY;
  const patches: BlockPatch[] = [];

  for (const b of content) {
    if (!b || typeof b !== 'object' || b.type !== 'tool_result') continue;
    const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined;
    if (!toolUseId) continue;
    const target = state.toolBlocks.get(toolUseId);
    if (!target) continue;
    const isError = b.is_error === true;
    patches.push({
      id: target,
      block: { state: isError ? 'error' : 'done', result: toolResultView(b.content, isError, msg.tool_use_result) },
    });
  }
  return { appends: [], patches };
}

/**
 * Fold one SDK message into the conversation.
 *
 * Unknown message types are ignored on purpose: the stream carries a growing
 * set of informational messages, and a pane that threw on the first unfamiliar
 * one would break on a Claude Code upgrade.
 */
export function reduceRunnerMessage(state: RunnerBlocksState, msg: any): RunnerReduction {
  if (!msg || typeof msg !== 'object') return EMPTY;

  switch (msg.type) {
    case 'stream_event':
      return reduceStreamEvent(state, msg.event);

    case 'assistant':
      return reduceAssistant(state, msg);

    case 'user':
      return reduceUser(state, msg);

    case 'result': {
      const isError = msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
      const text = typeof msg.result === 'string' ? msg.result : '';
      const queued = typeof msg.queued_turn_count === 'number' ? msg.queued_turn_count : 0;
      return {
        appends: isError ? [noteBlock(state, 'error', text || `Turn ended: ${msg.subtype ?? 'error'}`)] : [],
        patches: [],
        composer: { busy: queued > 0, queued },
        turnEnd: { isError, text, queued },
      };
    }

    case 'system':
      return reduceSystem(state, msg);

    default:
      return EMPTY;
  }
}

function reduceSystem(state: RunnerBlocksState, msg: any): RunnerReduction {
  switch (msg.subtype) {
    case 'init':
      return {
        appends: [],
        patches: [],
        composer: {
          permissionMode: msg.permissionMode,
          model: typeof msg.model === 'string' ? msg.model : undefined,
          slashCommands: Array.isArray(msg.slash_commands)
            ? msg.slash_commands.filter((c: unknown): c is string => typeof c === 'string')
            : undefined,
        },
      };

    // A status only ever *raises* busy. The turn is what owns that flag — it is
    // set when the message is sent and cleared by the `result` that ends the
    // turn — and the status subtype carries values we have not enumerated
    // (anything that is not `requesting`/`compacting` reads as "not generating
    // right now", which is also true while a five-minute build runs). Clearing
    // it here put the button back to Send in the middle of a turn.
    case 'status': {
      const composer: Partial<ComposerState> = {};
      if (msg.status === 'requesting' || msg.status === 'compacting') composer.busy = true;
      if (typeof msg.permissionMode === 'string') composer.permissionMode = msg.permissionMode;
      return { appends: [], patches: [], composer };
    }

    case 'compact_boundary': {
      const pre = msg.compact_metadata?.pre_tokens;
      return {
        appends: [
          noteBlock(
            state,
            'info',
            typeof pre === 'number'
              ? `Context compacted (${pre.toLocaleString()} tokens summarised).`
              : 'Context compacted.',
          ),
        ],
        patches: [],
      };
    }

    case 'permission_denied':
      return {
        appends: [
          noteBlock(state, 'warn', `${msg.tool_name ?? 'A tool'} was denied${msg.decision_reason ? `: ${msg.decision_reason}` : '.'}`),
        ],
        patches: [],
      };

    case 'notification':
      return typeof msg.text === 'string' && msg.text.trim()
        ? { appends: [noteBlock(state, 'info', msg.text)], patches: [] }
        : EMPTY;

    default:
      return EMPTY;
  }
}

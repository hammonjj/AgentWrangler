/**
 * Claude Code transcript JSONL → conversation blocks. Pure: no fs, no vscode.
 *
 * The pane needs the whole conversation — thinking, tool calls, their results
 * and diffs — where the old read-only viewer rendered three kinds of block and
 * dropped the rest. It reads the file in append-only chunks, so this is a
 * *reducer* rather than a mapper: a tool call
 * appears in one chunk and its result lands in another, minutes later, and the
 * second chunk must patch the first chunk's block rather than adding a stray
 * one. `state` is what carries that across chunks.
 */
import {
  capBlock,
  capText,
  MAX_TOOL_RESULT_CHARS,
  type BlockPatch,
  type ConvBlock,
  type ToolResultView,
} from '../shared/conversation';

export interface TranscriptReduction {
  appends: ConvBlock[];
  patches: BlockPatch[];
}

export interface TranscriptState {
  /** `tool_use_id` → block id, so a later chunk's result finds its call. */
  toolBlocks: Map<string, string>;
  /**
   * The assistant block still being extended. Claude Code writes one line per
   * content block, so a single reply arrives as several lines sharing
   * `message.id`; they read as one paragraph, not several.
   */
  openAssistant?: { id: string; msgId: string; text: string };
  /** Fallback id source for lines with no uuid. */
  counter: number;
  /**
   * Block id → the whole text, for the blocks whose text did not fit the wire
   * cap. This is what "Show the rest" is answered from, so it has to outlive
   * the chunk the block was read in. Bounded by `rememberFullText`.
   */
  overflow: Map<string, string>;
}

export function createTranscriptState(): TranscriptState {
  return { toolBlocks: new Map(), counter: 0, overflow: new Map() };
}

/** One line's stable block id. Several blocks per line get an index suffix. */
function blockId(state: TranscriptState, obj: { uuid?: unknown }, index: number): string {
  const uuid = typeof obj.uuid === 'string' && obj.uuid ? obj.uuid : `n${++state.counter}`;
  return index === 0 ? `t:${uuid}` : `t:${uuid}#${index}`;
}

/** One line describing what a tool was asked to do. Ported from the old viewer. */
export function toolInputPreview(input: unknown): string {
  let s = '';
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const field of ['command', 'description', 'file_path', 'path', 'prompt', 'pattern', 'query', 'url', 'skill']) {
      if (typeof o[field] === 'string' && (o[field] as string).trim()) {
        s = o[field] as string;
        break;
      }
    }
    if (!s) {
      try {
        s = JSON.stringify(o);
      } catch {
        s = '';
      }
    }
  } else if (input !== undefined && input !== null) {
    s = String(input);
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

/** Text of a `tool_result` block's content, which is a string or a block array. */
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

/**
 * A unified-diff rendering of an edit's `structuredPatch`, which is far easier
 * to read than the "here is the file with a cursor" text the tool returns.
 */
export function diffFromToolUseResult(tur: unknown): { file: string; patch: string } | undefined {
  if (!tur || typeof tur !== 'object') return undefined;
  const o = tur as Record<string, unknown>;
  const hunks = o.structuredPatch;
  if (!Array.isArray(hunks) || hunks.length === 0) return undefined;
  const file = typeof o.filePath === 'string' ? o.filePath : '';
  const out: string[] = [];
  for (const h of hunks) {
    if (!h || typeof h !== 'object') continue;
    const hh = h as Record<string, unknown>;
    const lines = Array.isArray(hh.lines) ? (hh.lines as unknown[]).filter((l) => typeof l === 'string') : [];
    if (lines.length === 0) continue;
    out.push(`@@ -${Number(hh.oldStart) || 0},${Number(hh.oldLines) || 0} +${Number(hh.newStart) || 0},${Number(hh.newLines) || 0} @@`);
    for (const l of lines) out.push(l as string);
  }
  if (out.length === 0) return undefined;
  return { file, patch: capText(out.join('\n')) };
}

function toolResultView(content: unknown, isError: boolean, tur: unknown, overflow: Map<string, string>, id: string): ToolResultView {
  const raw = resultText(content).trim();
  capBlock(overflow, id, raw, MAX_TOOL_RESULT_CHARS);
  return {
    text: raw.length > MAX_TOOL_RESULT_CHARS ? raw.slice(0, MAX_TOOL_RESULT_CHARS) : raw,
    isError,
    truncated: raw.length > MAX_TOOL_RESULT_CHARS,
    diff: diffFromToolUseResult(tur),
  };
}

/**
 * A slash command is stored as a tag soup (`<command-name>`, `<command-args>`,
 * …) that is unreadable raw. Pull the command back out of it.
 */
function slashCommandText(text: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (!name) return undefined;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text);
  const cmd = name[1].trim();
  const rest = args?.[1]?.trim();
  return rest ? `${cmd} ${rest}` : cmd;
}

/** Text blocks of a user message's content, plus how many images rode along. */
function userContent(content: unknown): { text: string; imageCount: number } {
  if (typeof content === 'string') return { text: content, imageCount: 0 };
  if (!Array.isArray(content)) return { text: '', imageCount: 0 };
  let imageCount = 0;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const bb = b as Record<string, unknown>;
    if (bb.type === 'text' && typeof bb.text === 'string') parts.push(bb.text);
    else if (bb.type === 'image') imageCount++;
  }
  return { text: parts.join('\n'), imageCount };
}

/**
 * Fold a batch of complete JSONL lines into the conversation.
 *
 * Subagent lines (`isSidechain`) are skipped: the transcript does not stamp
 * them with the `tool_use_id` of the Agent call that spawned them, so there is
 * nothing reliable to nest them under. The parent Agent tool block still shows
 * the call and its final report, which is what the pane is for.
 */
export function reduceTranscriptLines(state: TranscriptState, lines: string[]): TranscriptReduction {
  const appends: ConvBlock[] = [];
  const patches: BlockPatch[] = [];

  const push = (b: ConvBlock): void => {
    // Any other block ends the run of assistant text that could be extended.
    if (b.kind !== 'assistant') state.openAssistant = undefined;
    appends.push(b);
  };

  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a partial flush or a corrupt line: skip it, keep the rest
    }
    if (!obj || typeof obj !== 'object' || obj.isSidechain === true) continue;

    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

    if (obj.type === 'user') {
      if (obj.isMeta === true) continue; // injected context, caveats: not conversation

      const content = obj.message?.content;

      // Tool results first: they are user-role lines but belong to the tool
      // block that asked, which may have arrived chunks ago.
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object' || (b as any).type !== 'tool_result') continue;
          const bb = b as Record<string, unknown>;
          const toolUseId = typeof bb.tool_use_id === 'string' ? bb.tool_use_id : undefined;
          if (!toolUseId) continue;
          const target = state.toolBlocks.get(toolUseId);
          if (!target) continue; // its call is older than our tail window
          const isError = bb.is_error === true;
          patches.push({
            id: target,
            block: { state: isError ? 'error' : 'done', result: toolResultView(bb.content, isError, obj.toolUseResult, state.overflow, target) },
          });
        }
      }

      const { text, imageCount } = userContent(content);
      const trimmed = text.trim();
      if (!trimmed) continue;
      const slash = slashCommandText(trimmed);
      if (slash !== undefined) {
        push({ kind: 'user', id: blockId(state, obj, 0), ts, text: `/${slash.replace(/^\//, '')}` });
        continue;
      }
      // Local command output and other machine-injected tag soup read as noise
      // in a conversation; keep them, but as a note rather than as something
      // the human said.
      if (trimmed.startsWith('<')) {
        push({ kind: 'note', id: blockId(state, obj, 0), ts, tone: 'info', text: capText(trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 400) });
        continue;
      }
      const uid = blockId(state, obj, 0);
      push({ kind: 'user', id: uid, ts, ...capBlock(state.overflow, uid, trimmed), imageCount: imageCount || undefined });
      continue;
    }

    if (obj.type === 'assistant') {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      const msgId = typeof obj.message?.id === 'string' ? obj.message.id : undefined;
      const model = typeof obj.message?.model === 'string' ? obj.message.model : undefined;

      content.forEach((b: any, i: number) => {
        if (!b || typeof b !== 'object') return;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const open = state.openAssistant;
          if (open && msgId !== undefined && open.msgId === msgId) {
            open.text = `${open.text}\n${b.text}`;
            // `more` travels with every patch: a reply that has just grown past
            // the cap has to gain the button, and one the cap no longer bites
            // on has to lose it, so the field cannot be left off.
            const capped = capBlock(state.overflow, open.id, open.text);
            patches.push({ id: open.id, block: { text: capped.text, more: capped.more } });
            return;
          }
          const id = blockId(state, obj, i);
          appends.push({ kind: 'assistant', id, ts, msgId, model, ...capBlock(state.overflow, id, b.text) });
          state.openAssistant = msgId === undefined ? undefined : { id, msgId, text: b.text };
          return;
        }
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          const id = blockId(state, obj, i);
          push({ kind: 'thinking', id, ts, ...capBlock(state.overflow, id, b.thinking) });
          return;
        }
        if (b.type === 'tool_use') {
          const id = blockId(state, obj, i);
          const toolUseId = typeof b.id === 'string' ? b.id : id;
          state.toolBlocks.set(toolUseId, id);
          push({
            kind: 'tool',
            id,
            ts,
            toolUseId,
            name: typeof b.name === 'string' ? b.name : 'tool',
            inputPreview: toolInputPreview(b.input),
            input: b.input,
            state: 'running',
          });
        }
      });
      continue;
    }
    // Every other line type (summary, ai-title, last-prompt, attachment,
    // queue-operation…) is bookkeeping, not conversation.
  }

  return { appends, patches };
}

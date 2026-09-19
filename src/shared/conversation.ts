/**
 * The conversation pane's block model.
 *
 * Two very different things produce these blocks — a transcript file being
 * tailed from disk, and (later) a Claude Code process this extension drives —
 * and the webview must not be able to tell which. So this file is the contract
 * between them: anything a renderer needs is here, and anything source-specific
 * stays in the source.
 *
 * Imported by BOTH the extension host and the webview bundle, so it must stay
 * free of `vscode`, Node and DOM imports.
 */

/**
 * Mirrors the Agent SDK's `PermissionMode`. Duplicated rather than imported
 * because shared code is bundled into the webview, where the SDK cannot go.
 * Keep in step with `@anthropic-ai/claude-agent-sdk`.
 */
export type PermissionModeName = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

/**
 * Where an ask (a permission prompt, a question, a plan) stands.
 *
 * `expired` is the one that matters: Claude Code races our answer against its
 * own dialog, so a prompt can be settled somewhere else while the card is still
 * on screen. The card then says so rather than offering a button that would do
 * nothing.
 */
export type AskState = 'pending' | 'allowed' | 'denied' | 'expired';

/** A tool's output, already capped for the wire. */
export interface ToolResultView {
  text: string;
  isError: boolean;
  /** True when `text` is a prefix of a longer output; the card offers to fetch the rest. */
  truncated: boolean;
  /** Edits and writes carry a unified patch, which reads far better than the raw result text. */
  diff?: { file: string; patch: string };
}

export interface QuestionOptionView {
  label: string;
  description: string;
}

/**
 * An image on its way *out* — pasted or dropped into the composer. The read
 * side has counted `image` blocks since phase 1 (`imageCount` on a user block);
 * this is the other direction.
 *
 * Base64 because that is the shape the Messages API wants and the shape the
 * clipboard gives, so nothing has to touch disk on the way.
 */
export interface ImageAttachment {
  /** `image/png`, `image/jpeg`, `image/gif`, `image/webp` — what the API accepts. */
  mediaType: string;
  /** Base64 payload, without the `data:...;base64,` prefix. */
  data: string;
}

/** Media types the Messages API accepts; anything else is refused before it is encoded. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/**
 * Per-image ceiling. The API rejects images past ~5 MB, and a rejection arrives
 * as a failed turn long after the paste, so the composer refuses it at the
 * point where the user can still do something about it.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Base64 costs 4 bytes per 3, so this is the decoded size of an encoded payload. */
export function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export interface QuestionView {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: QuestionOptionView[];
}

/**
 * One rendered unit of a conversation.
 *
 * `id` is stable for the life of the pane so the host can patch a block in
 * place — a tool block gains its result minutes after it appears, and a
 * streaming reply grows word by word.
 */
export type ConvBlock = (
  | { kind: 'user'; id: string; ts?: string; text: string; more?: number; imageCount?: number }
  | {
      kind: 'assistant';
      id: string;
      ts?: string;
      msgId?: string;
      text: string;
      more?: number;
      streaming?: boolean;
      model?: string;
    }
  | { kind: 'thinking'; id: string; ts?: string; text: string; more?: number; streaming?: boolean }
  | {
      kind: 'tool';
      id: string;
      ts?: string;
      toolUseId: string;
      name: string;
      /** One line: the command, the file, the query — what `permissionDetail` does for prompts. */
      inputPreview: string;
      input?: unknown;
      result?: ToolResultView;
      state: 'running' | 'done' | 'error';
      /** Set on a subagent's tool calls, so the renderer can nest them under the Agent block. */
      parentToolUseId?: string;
    }
  | {
      kind: 'permission';
      id: string;
      /** Opaque handle the source needs to answer this ask. */
      requestId: string;
      toolName: string;
      /** Claude's own one-line description of what it is about to do. */
      summary?: string;
      /** The literal thing that will happen: the command, the file, the URL. */
      body?: string;
      /** `body` is a shell command, so render it monospaced and say so. */
      isCommand?: boolean;
      input?: unknown;
      /**
       * The rule an *Always allow* would add, as Claude Code phrases it
       * (`Bash(npm test:*)`). Absent when the ask offered no suggestion, which
       * is what decides whether the button appears at all.
       */
      alwaysAllowRule?: string;
      state: AskState;
    }
  | { kind: 'question'; id: string; requestId: string; questions: QuestionView[]; state: AskState; answers?: Record<string, string> }
  | { kind: 'plan'; id: string; requestId: string; plan: string; more?: number; planFilePath?: string; state: AskState }
  /** Out-of-band facts: compaction, errors, "this session ended", "adopted here". */
  | { kind: 'note'; id: string; ts?: string; tone: 'info' | 'warn' | 'error'; text: string }) & { parentToolUseId?: string };

export type ConvBlockKind = ConvBlock['kind'];

/**
 * An in-place update of a block already on screen. Both sources need it: a
 * tool result lands long after its call, and an ask is settled long after it
 * is asked.
 */
export interface BlockPatch {
  id: string;
  block: Partial<ConvBlock>;
}

/** Longest text carried in one block. Matches the old viewer's cap. */
export const MAX_BLOCK_CHARS = 6000;
/** Longest tool output sent unasked; the rest is fetched on demand. */
export const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * Cap a string for the wire, marking the cut so the renderer never implies
 * completeness. For text nobody can ask for the rest of — a note, a banner —
 * where the marker *is* the whole story. Prose blocks use `capBlock`.
 */
export function capText(text: string, max: number = MAX_BLOCK_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated]` : text;
}

/** A block's text as it goes on the wire, and how much of it stayed behind. */
export interface CappedText {
  text: string;
  /** Characters cut. Absent when nothing was, which is the common case. */
  more?: number;
}

/**
 * Total characters of held-back text one conversation keeps so the pane can ask
 * for the rest.
 *
 * A budget rather than a count of entries: what costs memory is the length of
 * what is kept, and one 300 KB reply is worth more of the budget than thirty
 * 2 KB ones. Oldest goes first, because "show the rest" is asked about
 * something on screen, and the oldest overflow is the furthest from it.
 */
export const MAX_OVERFLOW_CHARS = 2_000_000;

/**
 * Keep the full text of a block that had to be cut, so `fullBlockText` can
 * answer for it later. Re-remembering a block moves it to the end, which is
 * what makes a streaming reply the *last* thing to be evicted rather than the
 * first.
 */
export function rememberFullText(store: Map<string, string>, id: string, text: string): void {
  store.delete(id);
  store.set(id, text);
  let total = 0;
  for (const v of store.values()) total += v.length;
  for (const [k, v] of store) {
    if (total <= MAX_OVERFLOW_CHARS) break;
    // Never the one just added: it is the one about to be on screen. A single
    // text bigger than the whole budget therefore survives alone, which beats
    // holding nothing at all for the block the reader is looking at.
    if (k === id) continue;
    store.delete(k);
    total -= v.length;
  }
}

/**
 * Cap one block's prose, keeping the rest where the pane can ask for it.
 *
 * Unlike `capText` this leaves no marker in the text: the block carries `more`
 * instead, and the renderer turns that into a button. A marker inside the text
 * would be indistinguishable from something the model actually wrote, and
 * markdown would render it as part of the last paragraph.
 *
 * Re-capping a block that has since become short (a streamed reply rewritten by
 * its complete message) drops what was held for it, so the pane can never fetch
 * a stale "rest" that no longer follows the text on screen.
 */
export function capBlock(store: Map<string, string>, id: string, text: string, max: number = MAX_BLOCK_CHARS): CappedText {
  if (text.length <= max) {
    store.delete(id);
    return { text };
  }
  rememberFullText(store, id, text);
  return { text: text.slice(0, max), more: text.length - max };
}

/**
 * What the pane can currently do with this session. Computed by the host from
 * where the session's process lives, so the webview renders buttons without
 * knowing any of those rules.
 */
export interface ConversationCapabilities {
  /** The session is driven by this extension, so the composer can send. */
  canSend: boolean;
  /** Sending takes ownership, possibly after the current turn finishes. */
  adoptOnSend?: boolean;
  sendHint?: string;
  canInterrupt: boolean;
  /** Idle and owned elsewhere: its process could be ended and resumed here. */
  canAdopt: boolean;
  /** Ended: nothing to end first, so it can simply be resumed here. */
  canResumeHere: boolean;
  /** Driven here: it could be handed back to a terminal or the Claude Code panel. */
  canRelease: boolean;
  /** Status is inferred from the transcript rather than pushed by hooks. */
  estimated: boolean;
  /** Why the composer is disabled, in one sentence, when `canSend` is false. */
  readOnlyReason?: string;
}

/**
 * One row of the model dropdown, as the CLI itself advertises it. The list is
 * asked for rather than hardcoded so the dropdown offers exactly the models
 * this account can use.
 */
export interface ModelChoice {
  /** What `setModel` is called with — usually an alias like `sonnet`. */
  value: string;
  label: string;
  /**
   * The wire id `value` resolves to. The CLI reports the *resolved* id as the
   * current model, so without this the dropdown could not tell which row is
   * selected.
   */
  resolved?: string;
  /**
   * How hard this model can be asked to think, in the CLI's own order — the
   * `supportedEffortLevels` it advertises. Absent when the model has no effort
   * control at all, which is what hides the dropdown: the levels are a property
   * of the model, not of the product, and Haiku has none.
   */
  effortLevels?: string[];
}

/** Live state of a session this extension drives. Absent for transcript-backed panes. */
export interface ComposerState {
  permissionMode: PermissionModeName;
  model?: string;
  /** Absent until the CLI answers; the dropdown stays hidden until then. */
  models?: ModelChoice[];
  /**
   * How hard this session is currently being asked to think. Absent means the
   * CLI's own default, which is what an empty selection puts back.
   */
  effort?: string;
  slashCommands: string[];
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  busy: boolean;
  queued: number;
}

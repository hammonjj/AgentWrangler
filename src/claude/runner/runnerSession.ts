/**
 * One Claude Code session this extension runs itself.
 *
 * The Agent SDK spawns the same `claude` binary the Claude Code panel uses, in
 * headless streaming mode, and hands us the conversation as an async iterable
 * while we hand it user messages through another one. That is the only
 * documented way to *type into* a session from our own UI: there is no
 * supported channel into a running terminal session.
 *
 * A session started here has no terminal and no Claude Code panel — this pane
 * is its entire interface — but it is an ordinary session in every other
 * respect: it registers in `~/.claude/sessions`, runs the user's hooks, writes
 * the normal transcript, and can be resumed anywhere afterwards.
 *
 * No `vscode` import: the SDK's `query` is injected, so the whole thing runs
 * under vitest with a fake stream.
 */
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Emitter, type Disposable } from '../../core/events';
import type {
  BlockPatch,
  ComposerState,
  ConvBlock,
  ImageAttachment,
  ModelChoice,
  PermissionModeName,
  QuestionView,
} from '../../shared/conversation';
import { capText } from '../../shared/conversation';
import { parsePermissionSuggestions, permissionDetail, suggestionLabels } from '../permissionDetail';
import { createRunnerState, noteBlock, reduceRunnerMessage, type RunnerBlocksState } from './runnerBlocks';
import { InputQueue } from '../../core/runner/inputQueue';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

/**
 * What a user message carries. The SDK re-exports neither `MessageParam` nor
 * the block types, so the two shapes we actually send are spelled out here and
 * cast at the boundary, rather than importing from `@anthropic-ai/sdk` just for
 * a type.
 */
type UserContent =
  | string
  | ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[];

export interface RunnerDeps {
  query: QueryFn;
  /** Absolute path of the `claude` to spawn. */
  binary: string;
  log: (msg: string) => void;
}

export interface RunnerStartOptions {
  cwd: string;
  /** Session id to continue. Its process must already be gone, or they interleave. */
  resume?: string;
  permissionMode?: PermissionModeName;
  model?: string;
}

/**
 * `starting` until the CLI's first `init`, then `idle`/`running` per turn.
 * `ended` is a clean exit; `error` is the stream throwing.
 */
export type RunnerLifecycle = 'starting' | 'idle' | 'running' | 'ending' | 'ended' | 'error';

interface PendingAsk {
  blockId: string;
  kind: 'permission' | 'question' | 'plan';
  input: Record<string, unknown>;
  /** `updatedPermissions` for an "always allow", when the ask offered any. */
  suggestions?: unknown[];
  resolve: (result: PermissionResult) => void;
  settled: boolean;
}

/** Blocks kept in memory per runner session; older ones drop off the top. */
const MAX_BLOCKS = 2000;
/** How long a graceful `end()` waits for the CLI to exit before killing it. */
const END_GRACE_MS = 5000;

export class RunnerSession {
  readonly cwd: string;
  readonly startedAt = Date.now();
  sessionId?: string;
  lifecycle: RunnerLifecycle = 'starting';

  readonly blocks: ConvBlock[] = [];
  composer: ComposerState = { permissionMode: 'default', slashCommands: [], busy: false, queued: 0 };

  private input = new InputQueue<SDKUserMessage>();
  private query?: Query;
  private blockState: RunnerBlocksState = createRunnerState();
  private pending = new Map<string, PendingAsk>();
  private truncated = false;

  private appendEmitter = new Emitter<ConvBlock[]>();
  private patchEmitter = new Emitter<BlockPatch>();
  private composerEmitter = new Emitter<ComposerState>();
  private stateEmitter = new Emitter<RunnerLifecycle>();

  readonly onAppend = (l: (blocks: ConvBlock[]) => void): Disposable => this.appendEmitter.event(l);
  readonly onPatch = (l: (patch: BlockPatch) => void): Disposable => this.patchEmitter.event(l);
  readonly onComposer = (l: (composer: ComposerState) => void): Disposable => this.composerEmitter.event(l);
  readonly onLifecycle = (l: (state: RunnerLifecycle) => void): Disposable => this.stateEmitter.event(l);

  constructor(
    private opts: RunnerStartOptions,
    private deps: RunnerDeps,
  ) {
    this.cwd = opts.cwd;
    if (opts.permissionMode) this.composer.permissionMode = opts.permissionMode;
    if (opts.model) this.composer.model = opts.model;
    if (opts.resume) this.sessionId = opts.resume;
  }

  /** True while the pane's composer should be live. */
  get canSend(): boolean {
    return this.lifecycle === 'idle' || this.lifecycle === 'running' || this.lifecycle === 'starting';
  }

  get everythingTruncated(): boolean {
    return this.truncated;
  }

  start(): void {
    const options: Options = {
      cwd: this.opts.cwd,
      resume: this.opts.resume,
      permissionMode: this.opts.permissionMode,
      model: this.opts.model,
      pathToClaudeCodeExecutable: this.deps.binary,
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      stderr: (data) => this.deps.log(`runner stderr: ${data.trim().slice(0, 400)}`),
    };
    try {
      this.query = this.deps.query({ prompt: this.input, options });
    } catch (err) {
      this.fail(`Could not start Claude Code: ${String(err)}`);
      return;
    }
    void this.pump();
  }

  send(text: string, images?: ImageAttachment[]): void {
    const pics = images ?? [];
    // An image on its own is a real message ("what is wrong with this?"), so
    // emptiness is judged on both halves rather than on the text alone.
    if (!this.canSend || (!text.trim() && pics.length === 0)) return;
    // The CLI does not echo our own sends back, so the pane has to show them.
    this.append([
      {
        kind: 'user',
        id: `u:${Date.now()}:${this.blocks.length}`,
        ts: new Date().toISOString(),
        text: capText(text),
        imageCount: pics.length || undefined,
      },
    ]);
    // A string content is the common case and the one the CLI logs most
    // readably; blocks are used only when there is actually an image.
    const content: UserContent =
      pics.length === 0
        ? text
        : [
            ...pics.map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
            })),
            // Text last: the model reads the instruction after the thing it refers to.
            ...(text.trim() ? [{ type: 'text' as const, text }] : []),
          ];
    this.input.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.setComposer({ busy: true });
    this.setLifecycle('running');
  }

  async interrupt(): Promise<void> {
    try {
      await this.query?.interrupt();
    } catch (err) {
      this.deps.log(`runner interrupt failed: ${String(err)}`);
    }
  }

  async setPermissionMode(mode: PermissionModeName): Promise<void> {
    try {
      await this.query?.setPermissionMode(mode);
      this.setComposer({ permissionMode: mode });
    } catch (err) {
      this.deps.log(`runner setPermissionMode failed: ${String(err)}`);
    }
  }

  async setModel(model?: string): Promise<void> {
    try {
      await this.query?.setModel(model);
      this.setComposer({ model });
    } catch (err) {
      this.deps.log(`runner setModel failed: ${String(err)}`);
    }
  }

  /**
   * Ask the CLI which models this account may use, once, after `init` proves
   * the control channel is up. A hardcoded list would go stale and could offer
   * a model the account cannot reach; when the call fails the list stays empty
   * and the pane simply hides the dropdown.
   */
  private async loadModels(): Promise<void> {
    try {
      const models = (await this.query?.supportedModels()) ?? [];
      const choices: ModelChoice[] = models
        .filter((m) => typeof m?.value === 'string' && m.value !== '')
        .map((m) => ({
          value: m.value,
          label: m.displayName || m.value,
          resolved: typeof m.resolvedModel === 'string' ? m.resolvedModel : undefined,
        }));
      if (choices.length > 0) this.setComposer({ models: choices });
    } catch (err) {
      this.deps.log(`runner supportedModels failed: ${String(err)}`);
    }
  }

  /** Answer a permission ask. False when there was nothing left to answer. */
  decide(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string): boolean {
    const ask = this.pending.get(requestId);
    if (!ask || ask.settled) return false;
    this.settle(requestId, ask, decision === 'deny' ? 'denied' : 'allowed');
    if (decision === 'deny') {
      ask.resolve({ behavior: 'deny', message: message?.trim() || 'Denied from Agent Wrangler.' });
      return true;
    }
    ask.resolve({
      behavior: 'allow',
      updatedInput: ask.input,
      // "Always allow" is Claude Code's own don't-ask-again: hand its own
      // suggestion back and it writes and persists the rule itself.
      ...(decision === 'always' && ask.suggestions?.length
        ? { updatedPermissions: ask.suggestions as never }
        : {}),
    });
    return true;
  }

  /** Answer an `AskUserQuestion`, which is allowed *with* the answers filled in. */
  answer(requestId: string, answers: Record<string, string>): boolean {
    const ask = this.pending.get(requestId);
    if (!ask || ask.settled || ask.kind !== 'question') return false;
    this.settle(requestId, ask, 'allowed', { answers });
    ask.resolve({ behavior: 'allow', updatedInput: { ...ask.input, answers } });
    return true;
  }

  /** Approve or reject a plan. Rejecting sends the feedback back to the model. */
  decidePlan(requestId: string, approve: boolean, feedback?: string): boolean {
    const ask = this.pending.get(requestId);
    if (!ask || ask.settled || ask.kind !== 'plan') return false;
    this.settle(requestId, ask, approve ? 'allowed' : 'denied');
    if (approve) ask.resolve({ behavior: 'allow', updatedInput: ask.input });
    else ask.resolve({ behavior: 'deny', message: feedback?.trim() || 'Keep planning: that plan was not approved.' });
    return true;
  }

  /** Close stdin so the CLI exits on its own, then force it if it does not. */
  async end(): Promise<void> {
    if (this.lifecycle === 'ended' || this.lifecycle === 'ending') return;
    this.setLifecycle('ending');
    // Anything still parked on a human would otherwise hold the process open.
    for (const [requestId, ask] of [...this.pending]) {
      if (ask.settled) continue;
      this.settle(requestId, ask, 'expired');
      ask.resolve({ behavior: 'deny', message: 'The session was closed.' });
    }
    this.input.close();
    await new Promise<void>((resolve) => {
      if (this.lifecycle === 'ended' || this.lifecycle === 'error') return resolve();
      const timer = setTimeout(() => {
        sub.dispose();
        try {
          this.query?.close();
        } catch {
          // already gone
        }
        resolve();
      }, END_GRACE_MS);
      const sub = this.onLifecycle((s) => {
        if (s !== 'ended' && s !== 'error') return;
        clearTimeout(timer);
        sub.dispose();
        resolve();
      });
    });
  }

  dispose(): void {
    void this.end();
    this.appendEmitter.dispose();
    this.patchEmitter.dispose();
    this.composerEmitter.dispose();
    this.stateEmitter.dispose();
  }

  // ---- internals ----

  private canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = options.requestId;
      const block = this.askBlock(requestId, toolName, input, options);
      const ask: PendingAsk = {
        blockId: block.id,
        kind: block.kind as PendingAsk['kind'],
        input,
        suggestions: options.suggestions,
        resolve,
        settled: false,
      };
      this.pending.set(requestId, ask);
      this.append([block]);
      this.setLifecycle('running');

      // The turn can be aborted (an interrupt, or the prompt answered in
      // another surface) while the card is still on screen. Settle rather than
      // leave a button that can no longer do anything.
      const onAbort = () => {
        if (ask.settled) return;
        this.settle(requestId, ask, 'expired');
        resolve({ behavior: 'deny', message: 'The request was cancelled.' });
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    });

  /** Turn one `canUseTool` call into the card the pane shows for it. */
  private askBlock(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: { title?: string; description?: string; suggestions?: unknown[] },
  ): ConvBlock {
    const id = `a:${requestId}`;

    if (toolName === 'AskUserQuestion') {
      return { kind: 'question', id, requestId, questions: parseQuestions(input.questions), state: 'pending' };
    }
    if (toolName === 'ExitPlanMode') {
      return {
        kind: 'plan',
        id,
        requestId,
        plan: capText(typeof input.plan === 'string' ? input.plan : ''),
        planFilePath: typeof input.planFilePath === 'string' ? input.planFilePath : undefined,
        state: 'pending',
      };
    }

    const detail = permissionDetail(toolName, input, this.cwd);
    const suggestions = parsePermissionSuggestions(options.suggestions);
    const rules = suggestionLabels(suggestions);
    return {
      kind: 'permission',
      id,
      requestId,
      toolName,
      summary: options.title ?? detail?.summary,
      body: detail?.body,
      isCommand: detail?.isCommand,
      input,
      alwaysAllowRule: rules.length > 0 ? rules.join(', ') : undefined,
      state: 'pending',
    };
  }

  private settle(
    requestId: string,
    ask: PendingAsk,
    state: 'allowed' | 'denied' | 'expired',
    extra: Record<string, unknown> = {},
  ): void {
    ask.settled = true;
    this.pending.delete(requestId);
    this.patch({ id: ask.blockId, block: { state, ...extra } as Partial<ConvBlock> });
  }

  private async pump(): Promise<void> {
    const query = this.query;
    if (!query) return;
    try {
      for await (const msg of query) {
        this.onMessage(msg);
      }
      this.setLifecycle('ended');
    } catch (err) {
      this.fail(String(err));
    }
  }

  private onMessage(msg: unknown): void {
    const m = msg as { type?: string; subtype?: string; session_id?: string };
    if (typeof m.session_id === 'string' && m.session_id && this.sessionId !== m.session_id) {
      this.sessionId = m.session_id;
      this.deps.log(`runner session id ${m.session_id} (${this.cwd})`);
    }
    if (m.type === 'system' && m.subtype === 'init' && this.lifecycle === 'starting') {
      this.setLifecycle('idle');
      void this.loadModels();
    }

    const { appends, patches, composer, turnEnd } = reduceRunnerMessage(this.blockState, msg);
    for (const p of patches) this.patch(p);
    if (appends.length > 0) this.append(appends);
    if (composer) this.setComposer(composer);
    if (turnEnd) {
      this.setLifecycle(turnEnd.queued > 0 ? 'running' : 'idle');
      this.setComposer({ busy: turnEnd.queued > 0, queued: turnEnd.queued });
    }
  }

  private fail(message: string): void {
    this.deps.log(`runner failed: ${message}`);
    this.append([noteBlock(this.blockState, 'error', message)]);
    this.setLifecycle('error');
  }

  private append(blocks: ConvBlock[]): void {
    this.blocks.push(...blocks);
    if (this.blocks.length > MAX_BLOCKS) {
      this.blocks.splice(0, this.blocks.length - MAX_BLOCKS);
      this.truncated = true;
    }
    this.appendEmitter.fire(blocks);
  }

  private patch(patch: BlockPatch): void {
    const at = this.blocks.findIndex((b) => b.id === patch.id);
    if (at >= 0) this.blocks[at] = { ...this.blocks[at], ...patch.block } as ConvBlock;
    this.patchEmitter.fire(patch);
  }

  private setComposer(next: Partial<ComposerState>): void {
    this.composer = { ...this.composer, ...next };
    this.composerEmitter.fire(this.composer);
  }

  private setLifecycle(next: RunnerLifecycle): void {
    if (this.lifecycle === next) return;
    // A finished session never goes back to running.
    if (this.lifecycle === 'ended' || this.lifecycle === 'error') return;
    this.lifecycle = next;
    this.stateEmitter.fire(next);
  }
}

/** `AskUserQuestion`'s input, defensively — it is foreign JSON like any tool's. */
function parseQuestions(raw: unknown): QuestionView[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionView[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const qq = q as Record<string, unknown>;
    if (typeof qq.question !== 'string') continue;
    const options = Array.isArray(qq.options)
      ? qq.options
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
          .map((o) => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : '',
          }))
          .filter((o) => o.label !== '')
      : [];
    out.push({
      question: qq.question,
      header: typeof qq.header === 'string' ? qq.header : '',
      multiSelect: qq.multiSelect === true,
      options,
    });
  }
  return out;
}

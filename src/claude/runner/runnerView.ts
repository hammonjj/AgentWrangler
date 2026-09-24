/**
 * The translation half of a Claude Code session Agent Wrangler runs, and its
 * `SessionHandle`.
 *
 * It turns the execution layer's raw events (SDK messages, asks, lifecycle;
 * `src/shared/sessionProtocol.ts`) into what the pane shows: blocks, the
 * composer, the pending question or plan. It builds the permission results the
 * pane's buttons mean and hands them back as raw results. It never touches the
 * SDK `Query` itself: everything goes through `ClaudeExecution`, which is
 * `ClaudeSdkSession` in-process today and a session host over a socket from
 * Stage 3 (`docs/plans/session-lifecycle-architecture.md` §5.1).
 *
 * The public surface is the one the single class it replaced had (execution
 * and translation fused, before Stage 1), with the commands now async and
 * saying what they did.
 */
import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Disposable } from '../../core/events';
import type { CommandOutcome, SessionHandle, SessionLifecycle } from '../../core/session/sessionHandle';
import { SessionViewBase } from '../../core/session/sessionView';
import type {
  BlockPatch,
  ComposerState,
  ConvBlock,
  ImageAttachment,
  ModelChoice,
  PermissionModeName,
  QuestionView,
} from '../../shared/conversation';
import { capBlock } from '../../shared/conversation';
import { modelChoiceLabel } from '../../shared/modelName';
import type {
  ControlRequest,
  HostEvent,
  HostSnapshot,
  RawAsk,
  RawPermissionResult,
  RespondOutcome,
  SendResult,
} from '../../shared/sessionProtocol';
import { parsePermissionSuggestions, permissionDetail, suggestionLabels } from '../permissionDetail';
import type { ConversationHistory } from '../transcriptHistory';
import { createRunnerState, noteBlock, reduceRunnerMessage, type RunnerBlocksState } from './runnerBlocks';

/**
 * What `RunnerView` needs from the execution layer: the session protocol,
 * as calls. `ClaudeSdkSession` satisfies it in-process; a socket client will
 * in Stage 3. Results may be sync or async so both fit.
 */
export interface ClaudeExecution {
  readonly cwd: string;
  readonly startedAt: number;
  snapshot(): HostSnapshot;
  subscribe(fromSeq: number, listener: (event: HostEvent) => void): Disposable;
  start(): void;
  send(message: SDKUserMessage): SendResult | Promise<SendResult>;
  respondAsk(requestId: string, result: RawPermissionResult): RespondOutcome | Promise<RespondOutcome>;
  control(req: ControlRequest): Promise<unknown>;
  end(opts?: { graceMs?: number }): Promise<void>;
}

export interface RunnerViewOptions {
  cwd: string;
  resume?: string;
  /** A fresh session's id, when the launch chose one. */
  sessionId?: string;
  permissionMode?: PermissionModeName;
  model?: string;
  effort?: string;
  origin?: unknown;
}

export interface RunnerViewDeps {
  exec: ClaudeExecution;
  log: (msg: string) => void;
  /**
   * The conversation a resumed session already has. The SDK replays nothing to
   * a resuming client, so the only copy of what was said before is the
   * transcript on disk. Injected so the view stays free of the filesystem.
   */
  loadHistory?: (sessionId: string, cwd: string) => Promise<ConversationHistory>;
  /** Message uuids, injectable for tests. */
  newUuid?: () => string;
}

/** A local runner's lifecycle: the handle's, of which it never enters the remote-only states. */
export type RunnerLifecycle = SessionLifecycle;

interface PendingAsk {
  blockId: string;
  kind: 'permission' | 'question' | 'plan';
  input: Record<string, unknown>;
  /** `updatedPermissions` for an "always allow", when the ask offered any. */
  suggestions?: unknown[];
  /** A command for it is in flight; a second click must not answer twice. */
  answering: boolean;
}

/** Blocks kept in memory per session; older ones drop off the top. */
const MAX_BLOCKS = 2000;
/** Silence after an interrupt that counts as the turn being over (see `interrupt`). */
const INTERRUPT_GRACE_MS = 5000;
/** Attempts at the model list before giving up on a CLI that cannot answer. */
const MAX_MODEL_ASKS = 3;

export class RunnerView extends SessionViewBase implements SessionHandle {
  readonly provider = 'claude' as const;
  readonly cwd: string;
  readonly startedAt: number;
  readonly origin?: unknown;
  sessionId: string | undefined = undefined;
  lifecycle: RunnerLifecycle = 'starting';

  readonly blocks: ConvBlock[] = [];
  composer: ComposerState = { permissionMode: 'default', slashCommands: [], busy: false, queued: 0 };

  private readonly exec: ClaudeExecution;
  private blockState: RunnerBlocksState = createRunnerState();
  private pending = new Map<string, PendingAsk>();
  private truncated = false;
  /** What was said before this process took the conversation over. */
  private historyPromise?: Promise<ConversationHistory>;
  /** Held-back text of that history's long blocks, for "Show the rest". */
  private historyOverflow?: Map<string, string>;
  /** Armed by `interrupt`, cleared by the turn actually ending. */
  private interruptTimer?: ReturnType<typeof setTimeout>;
  /** The model list has been answered, so `init` does not ask for it again. */
  private modelsLoaded = false;
  private modelAttempts = 0;
  private execSub?: Disposable;
  private readonly newUuid: () => string;

  constructor(
    opts: RunnerViewOptions,
    private deps: RunnerViewDeps,
  ) {
    super();
    this.exec = deps.exec;
    this.cwd = opts.cwd;
    this.startedAt = deps.exec.startedAt;
    this.origin = opts.origin;
    this.newUuid = deps.newUuid ?? randomUUID;
    if (opts.permissionMode) this.composer.permissionMode = opts.permissionMode;
    if (opts.effort) this.composer.effort = opts.effort;
    if (opts.model) this.composer.model = opts.model;
    if (!opts.resume && opts.sessionId) this.sessionId = opts.sessionId;
    if (opts.resume) {
      this.sessionId = opts.resume;
      // Issued before `start` creates the process, so it snapshots the file as
      // it stood before this process could append to it. The new half of the
      // conversation arrives through `blocks`; the two must not overlap.
      this.historyPromise = deps.loadHistory
        ?.(opts.resume, this.cwd)
        .then((h) => {
          // Zero blocks is the signature of a transcript we failed to find.
          deps.log(`runner history for ${opts.resume}: ${h.blocks.length} blocks`);
          this.historyOverflow = h.overflow;
          return h;
        })
        .catch((err) => {
          // History is a nicety; failing to read it must not cost the session.
          deps.log(`runner history unavailable: ${String(err)}`);
          return { blocks: [], truncated: false };
        });
    }
    // Everything the execution layer has said, from the start.
    this.execSub = this.exec.subscribe(0, (event) => this.onHostEvent(event));
  }

  // ---- reading ----

  get pendingQuestion(): Extract<ConvBlock, { kind: 'question' }> | undefined {
    return [...this.blocks].reverse().find(
      (block): block is Extract<ConvBlock, { kind: 'question' }> => block.kind === 'question' && block.state === 'pending',
    );
  }

  /** Symmetrical with `pendingQuestion`, including reading backwards: the one being asked is the last. */
  get pendingPlan(): Extract<ConvBlock, { kind: 'plan' }> | undefined {
    return [...this.blocks].reverse().find(
      (block): block is Extract<ConvBlock, { kind: 'plan' }> => block.kind === 'plan' && block.state === 'pending',
    );
  }

  /** True while the pane's composer should be live. */
  get canSend(): boolean {
    return this.lifecycle === 'idle' || this.lifecycle === 'running' || this.lifecycle === 'starting';
  }

  get everythingTruncated(): boolean {
    return this.truncated;
  }

  protected get truncatedView(): boolean {
    return this.truncated;
  }

  /**
   * Everything said before this process took over, for a resumed session.
   * Empty for one started fresh here, which has no past to show.
   */
  async history(): Promise<ConversationHistory> {
    return (await this.historyPromise) ?? { blocks: [], truncated: false };
  }

  /**
   * The whole text of a block the pane was only sent the start of. Two stores,
   * because a resumed conversation has two halves: the transcript read at
   * start (`t:` ids) and what this process has said since.
   */
  fullBlockText(id: string): string | undefined {
    return this.blockState.overflow.get(id) ?? this.historyOverflow?.get(id);
  }

  // ---- commands ----

  start(): void {
    this.exec.start();
    void this.loadModels();
    void this.loadCommands();
  }

  async send(text: string, images?: ImageAttachment[]): Promise<CommandOutcome> {
    const pics = images ?? [];
    if (!this.canSend) return 'gone';
    // An image on its own is a real message ("what is wrong with this?").
    if (!text.trim() && pics.length === 0) return 'applied';
    // Set on every send (CP0): the CLI keeps it as the transcript entry's uuid,
    // so a client reattaching later can dedupe its own sends against the file.
    const uuid = this.newUuid();
    // The CLI does not echo our own sends back, so the pane has to show them.
    const userId = `u:${Date.now()}:${this.blocks.length}`;
    this.append([
      {
        kind: 'user',
        id: userId,
        ts: new Date().toISOString(),
        ...capBlock(this.blockState.overflow, userId, text),
        imageCount: pics.length || undefined,
      },
    ]);
    const content =
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
    this.setComposer({ busy: true });
    this.setLifecycle('running');
    const result = await this.exec.send({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid,
    } as SDKUserMessage);
    if (result.accepted || result.duplicate) return 'applied';
    this.deps.log('runner send refused: the session is ending');
    // Say so where the message was shown, and do not leave the composer busy.
    this.append([noteBlock(this.blockState, 'error', 'Not sent: the session is ending.')]);
    this.setComposer({ busy: false });
    return 'gone';
  }

  /**
   * Stop the turn. `busy` has to come back down or the composer is stuck
   * offering to interrupt a turn that is over. Normally the `result` message
   * does that; whether an interrupt always produces one is not documented, so
   * a watchdog calls the turn over after a few seconds of silence.
   */
  async interrupt(): Promise<CommandOutcome> {
    let outcome: CommandOutcome = 'applied';
    try {
      await this.exec.control({ op: 'interrupt' });
    } catch (err) {
      this.deps.log(`runner interrupt failed: ${String(err)}`);
      outcome = 'gone';
    }
    clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = undefined;
      if (!this.composer.busy) return;
      this.deps.log('runner interrupt produced no result; treating the turn as over');
      this.setComposer({ busy: false });
      this.setLifecycle('idle');
    }, INTERRUPT_GRACE_MS);
    return outcome;
  }

  async setPermissionMode(mode: PermissionModeName): Promise<CommandOutcome> {
    try {
      await this.exec.control({ op: 'setPermissionMode', mode });
      this.setComposer({ permissionMode: mode });
      return 'applied';
    } catch (err) {
      this.deps.log(`runner setPermissionMode failed: ${String(err)}`);
      return 'gone';
    }
  }

  /**
   * Change how hard this session thinks. There is no `Query.setEffort`, so
   * this sends the CLI's own `/effort <level>`: the CLI owns the setting and
   * reports what it did, and the change lands in the transcript. Only when the
   * command is advertised; an older CLI would answer `/effort high` as a sentence.
   */
  async setEffort(effort: string): Promise<CommandOutcome> {
    const level = effort.trim();
    if (level === this.composer.effort) return 'applied';
    if (!this.composer.slashCommands.includes('effort')) {
      this.deps.log('runner setEffort: this CLI does not offer /effort');
      return 'unsupported';
    }
    // Recorded before the send so the dropdown does not spring back while the
    // command is in flight; the CLI is the thing that can contradict it.
    this.setComposer({ effort: level || undefined });
    return this.send(level ? `/effort ${level}` : '/effort');
  }

  async setModel(model?: string): Promise<CommandOutcome> {
    try {
      await this.exec.control({ op: 'setModel', model });
      this.setComposer({ model });
      return 'applied';
    } catch (err) {
      this.deps.log(`runner setModel failed: ${String(err)}`);
      return 'gone';
    }
  }

  /** Answer a permission ask. */
  async decide(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string): Promise<CommandOutcome> {
    const ask = this.claim(requestId);
    if (!ask) return 'stale';
    const result: RawPermissionResult =
      decision === 'deny'
        ? { behavior: 'deny', message: message?.trim() || 'Denied from Agent Wrangler.' }
        : {
            behavior: 'allow',
            updatedInput: ask.input,
            // "Always allow" is Claude Code's own don't-ask-again: hand its own
            // suggestion back and it writes and persists the rule itself.
            ...(decision === 'always' && ask.suggestions?.length ? { updatedPermissions: ask.suggestions } : {}),
          };
    return this.respond(requestId, ask, result, decision === 'deny' ? 'denied' : 'allowed');
  }

  /** Answer an `AskUserQuestion`, which is allowed *with* the answers filled in. */
  async answer(requestId: string, answers: Record<string, string>): Promise<CommandOutcome> {
    const ask = this.claim(requestId, 'question');
    if (!ask) return 'stale';
    return this.respond(requestId, ask, { behavior: 'allow', updatedInput: { ...ask.input, answers } }, 'allowed', { answers });
  }

  /** Approve or reject a plan. Rejecting sends the feedback back to the model. */
  async decidePlan(requestId: string, approve: boolean, feedback?: string): Promise<CommandOutcome> {
    const ask = this.claim(requestId, 'plan');
    if (!ask) return 'stale';
    const result: RawPermissionResult = approve
      ? { behavior: 'allow', updatedInput: ask.input }
      : { behavior: 'deny', message: feedback?.trim() || 'Keep planning: that plan was not approved.' };
    return this.respond(requestId, ask, result, approve ? 'allowed' : 'denied');
  }

  /** Stop the agent with the playbook's end sequence (§7.1). */
  async end(): Promise<void> {
    if (this.lifecycle === 'ended' || this.lifecycle === 'error') return;
    this.setLifecycle('ending');
    await this.exec.end();
  }

  dispose(): void {
    clearTimeout(this.interruptTimer);
    void this.end();
    this.execSub?.dispose();
    this.disposeView();
  }

  // ---- internals ----

  /** Take a pending ask for answering, once. */
  private claim(requestId: string, kind?: PendingAsk['kind']): PendingAsk | undefined {
    const ask = this.pending.get(requestId);
    if (!ask || ask.answering || (kind && ask.kind !== kind)) return undefined;
    ask.answering = true;
    return ask;
  }

  private async respond(
    requestId: string,
    ask: PendingAsk,
    result: RawPermissionResult,
    state: 'allowed' | 'denied',
    extra: Record<string, unknown> = {},
  ): Promise<CommandOutcome> {
    let outcome: RespondOutcome;
    try {
      outcome = await this.exec.respondAsk(requestId, result);
    } catch (err) {
      this.deps.log(`runner respondAsk failed: ${String(err)}`);
      ask.answering = false;
      return 'gone';
    }
    if (outcome !== 'applied') {
      // Settled some other way while we were answering. Its `askSettled` may
      // have been skipped as "ours in flight", so settle the card here rather
      // than leave it pending for good.
      if (this.pending.get(requestId) === ask) {
        this.pending.delete(requestId);
        this.patch({ id: ask.blockId, block: { state: 'expired' } as Partial<ConvBlock> });
      }
      return outcome;
    }
    this.pending.delete(requestId);
    this.patch({ id: ask.blockId, block: { state, ...extra } as Partial<ConvBlock> });
    return 'applied';
  }

  private onHostEvent(event: HostEvent): void {
    switch (event.type) {
      case 'message':
        this.onMessage(event.msg);
        return;
      case 'ask':
        this.onAsk(event.ask);
        return;
      case 'askSettled': {
        const ask = this.pending.get(event.requestId);
        if (!ask) return;
        // Our own answer in flight: `respond` patches the card, with any extras.
        if (event.reason === 'responded' && ask.answering) return;
        this.pending.delete(event.requestId);
        // An outcome the host could not tell (a hook-answered tool that then
        // failed) shows as expired: over, without claiming which way.
        const state = event.reason === 'answeredElsewhere' || event.reason === 'responded' ? (event.outcome ?? 'expired') : 'expired';
        this.patch({ id: ask.blockId, block: { state } as Partial<ConvBlock> });
        return;
      }
      case 'exit':
        if (event.exit.error) this.fail(event.exit.error);
        else this.setLifecycle('ended');
        return;
      case 'state':
      case 'sessionId':
        // The view derives both from the messages themselves, as it always has.
        return;
    }
  }

  private onAsk(raw: RawAsk): void {
    const block = this.askBlock(raw);
    this.pending.set(raw.requestId, {
      blockId: block.id,
      kind: block.kind as PendingAsk['kind'],
      input: raw.input,
      suggestions: raw.suggestions,
      answering: false,
    });
    this.append([block]);
    this.setLifecycle('running');
  }

  /** Turn one raw ask into the card the pane shows for it. */
  private askBlock(raw: RawAsk): ConvBlock {
    const { requestId, toolName, input } = raw;
    const id = `a:${requestId}`;

    if (toolName === 'AskUserQuestion') {
      return { kind: 'question', id, requestId, questions: parseQuestions(input.questions), state: 'pending' };
    }
    if (toolName === 'ExitPlanMode') {
      // A plan is acted on rather than read, so the half past the cap has to be
      // reachable: approving half a plan is approving something unread.
      const capped = capBlock(this.blockState.overflow, id, typeof input.plan === 'string' ? input.plan : '');
      return {
        kind: 'plan',
        id,
        requestId,
        plan: capped.text,
        more: capped.more,
        planFilePath: typeof input.planFilePath === 'string' ? input.planFilePath : undefined,
        state: 'pending',
      };
    }

    const detail = permissionDetail(toolName, input, this.cwd);
    const suggestions = parsePermissionSuggestions(raw.suggestions);
    const rules = suggestionLabels(suggestions);
    return {
      kind: 'permission',
      id,
      requestId,
      toolName,
      summary: raw.title ?? detail?.summary,
      body: detail?.body,
      isCommand: detail?.isCommand,
      input,
      alwaysAllowRule: rules.length > 0 ? rules.join(', ') : undefined,
      state: 'pending',
    };
  }

  private onMessage(msg: unknown): void {
    const m = msg as { type?: string; subtype?: string; session_id?: string };
    if (typeof m.session_id === 'string' && m.session_id && this.sessionId !== m.session_id) {
      const changed = this.sessionId !== undefined;
      this.sessionId = m.session_id;
      if (changed) {
        // `/clear`: a new conversation in the same process.
        this.blocks.length = 0;
        this.blockState = createRunnerState();
        this.historyPromise = undefined;
        this.historyOverflow = undefined;
        this.truncated = false;
        this.setComposer({ costUsd: undefined, contextTokens: undefined, contextWindow: undefined });
        this.emitReset();
      }
      this.deps.log(`runner session id ${m.session_id} (${this.cwd})`);
    }
    if (m.type === 'system' && m.subtype === 'init') {
      if (this.lifecycle === 'starting') this.setLifecycle('idle');
      // Only if the ask at start failed: `loadModels` is a no-op once answered.
      void this.loadModels();
    }

    const { appends, patches, composer, turnEnd } = reduceRunnerMessage(this.blockState, msg);
    for (const p of patches) this.patch(p);
    if (appends.length > 0) this.append(appends);
    if (composer) this.setComposer(composer);
    if (turnEnd) {
      void this.refreshContext();
      clearTimeout(this.interruptTimer);
      this.interruptTimer = undefined;
      this.setLifecycle(turnEnd.queued > 0 ? 'running' : 'idle');
      this.setComposer({ busy: turnEnd.queued > 0, queued: turnEnd.queued });
      // The SDK's `result`, untranslated: usage, cost, turns, timings, stop reason.
      this.emitTurnEnd(msg);
    }
  }

  private async refreshContext(): Promise<void> {
    try {
      const usage = (await this.exec.control({ op: 'getContextUsage' })) as
        | { totalTokens?: number; maxTokens?: number }
        | undefined;
      if (usage) this.setComposer({ contextTokens: usage.totalTokens, contextWindow: usage.maxTokens });
    } catch {
      /* Optional on older CLIs. No fabricated context percentage. */
    }
  }

  private async loadCommands(): Promise<void> {
    try {
      const commands = (await this.exec.control({ op: 'supportedCommands' })) as { name: string }[] | undefined;
      if (commands) {
        this.setComposer({ slashCommands: [...new Set(['compact', 'clear', 'context', ...commands.map((c) => c.name)])] });
      }
    } catch {
      /* Older CLI: init still supplies the advertised list. */
    }
  }

  /**
   * Ask the CLI which models this account may use, once, as soon as the
   * process is spawned. `system/init` does not arrive until a turn begins, so
   * waiting for it left the dropdown hidden for the whole first turn; `init`
   * is only a retry point if this first attempt fails.
   */
  private async loadModels(): Promise<void> {
    if (this.modelsLoaded || this.modelAttempts >= MAX_MODEL_ASKS) return;
    this.modelAttempts++;
    try {
      const models = ((await this.exec.control({ op: 'supportedModels' })) ?? []) as {
        value?: unknown;
        displayName?: string;
        resolvedModel?: unknown;
        supportsEffort?: unknown;
        supportedEffortLevels?: unknown;
      }[];
      const choices: ModelChoice[] = models
        .filter((m) => typeof m?.value === 'string' && m.value !== '')
        .map((m) => {
          const resolved = typeof m.resolvedModel === 'string' ? m.resolvedModel : undefined;
          // Which levels a model has comes from the model: Haiku has none and
          // `xhigh` is not everywhere.
          const effortLevels =
            m.supportsEffort === true && Array.isArray(m.supportedEffortLevels) && m.supportedEffortLevels.length > 0
              ? [...(m.supportedEffortLevels as string[])]
              : undefined;
          return {
            value: m.value as string,
            label: m.displayName ? modelChoiceLabel(m.displayName, resolved) : (m.value as string),
            resolved,
            effortLevels,
          };
        });
      if (choices.length > 0) {
        this.modelsLoaded = true;
        this.setComposer({ models: choices });
      }
    } catch (err) {
      this.deps.log(`runner supportedModels failed: ${String(err)}`);
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
    this.emitAppend(blocks);
  }

  private patch(patch: BlockPatch): void {
    const at = this.blocks.findIndex((b) => b.id === patch.id);
    if (at >= 0) this.blocks[at] = { ...this.blocks[at], ...patch.block } as ConvBlock;
    this.emitPatch(patch);
  }

  private setComposer(next: Partial<ComposerState>): void {
    this.composer = { ...this.composer, ...next };
    this.emitComposer(this.composer);
  }

  private setLifecycle(next: RunnerLifecycle): void {
    if (this.lifecycle === next) return;
    // A finished session never goes back to running.
    if (this.lifecycle === 'ended' || this.lifecycle === 'error') return;
    // Ending only goes on to finished.
    if (this.lifecycle === 'ending' && next !== 'ended' && next !== 'error') return;
    this.lifecycle = next;
    // A process that has gone is not mid-turn, whatever the last message said.
    if (next === 'ended' || next === 'error') this.setComposer({ busy: false, queued: 0 });
    this.emitLifecycle(next);
  }
}

/** `AskUserQuestion`'s input, defensively: it is foreign JSON like any tool's. */
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

/**
 * A Codex thread Agent Wrangler drives, and its `SessionHandle`.
 *
 * Codex already has the split Claude is being given: `CodexAppServer` is
 * execution and transport, and this class is translation, turning the server's
 * notifications and requests for one thread into blocks and a composer.
 */
import * as path from 'node:path';
import { Emitter, type Disposable } from '../core/events';
import { finishedTurnStatus } from '../core/needsReply';
import type {
  CommandOutcome,
  LaunchRequest,
  SessionExecutor,
  SessionHandle,
  SessionLifecycle,
} from '../core/session/sessionHandle';
import { SessionViewBase } from '../core/session/sessionView';
import type { ConversationHistory } from '../claude/transcriptHistory';
import { capText, type ComposerState, type ConvBlock, type ImageAttachment } from '../shared/conversation';
import type { AgentSession } from '../shared/model';
import { CodexAppServer, type RpcNotification, type RpcServerRequest } from './appServer';

function threadIdOf(params: any): string | undefined {
  return params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId;
}

export class CodexRunner extends SessionViewBase implements SessionHandle {
  readonly provider = 'codex' as const;
  readonly startedAt = Date.now();
  readonly composer: ComposerState = { permissionMode: 'default', slashCommands: [], busy: false, queued: 0 };
  readonly blocks: ConvBlock[] = [];
  readonly pendingPlan = undefined;
  private ended = false;
  /** Set by the service: how this thread is released when it is ended. */
  endHook?: () => void;
  private subs: Disposable[] = [];
  private activeTurnId?: string;
  private pendingApprovals = new Map<string, string | number>();
  private pendingQuestions = new Map<string, string | number>();
  private itemBlocks = new Map<string, string>();
  private streamingId?: string;
  private streamingText = '';
  private streamingKind: 'assistant' | 'thinking' = 'assistant';
  private turnAssistantText = '';
  private turnOutcome: 'completed' | 'failed' | 'interrupted' = 'completed';
  private idleStatus: 'waiting' | 'done';
  private lastActivityAt = Date.now();
  private seq = 0;

  private currentModel?: string;

  /** The question currently waiting on this runner, if any. */
  get pendingQuestion(): Extract<ConvBlock, { kind: 'question' }> | undefined {
    return [...this.blocks].reverse().find(
      (block): block is Extract<ConvBlock, { kind: 'question' }> =>
        block.kind === 'question' && this.pendingQuestions.has(block.requestId),
    );
  }

  constructor(
    readonly server: CodexAppServer,
    readonly threadId: string,
    readonly cwd: string,
    model?: string,
    initialBlocks: ConvBlock[] = [],
    private stateChanged: () => void = () => undefined,
    readonly origin?: string,
  ) {
    super();
    this.blocks.push(...initialBlocks);
    const lastAssistant = [...initialBlocks].reverse().find((block) => block.kind === 'assistant');
    this.idleStatus = lastAssistant?.kind === 'assistant' ? finishedTurnStatus(lastAssistant.text) : 'waiting';
    this.currentModel = model;
    this.composer.model = model;
    this.subs.push(server.onNotification((event) => this.onNotification(event)), server.onRequest((event) => this.onRequest(event)));
  }

  get session(): AgentSession {
    const blockedReason = this.pendingQuestions.size > 0 ? 'Question' : this.pendingApprovals.size > 0 ? 'Approval' : undefined;
    return {
      provider: 'codex', sessionId: this.threadId, key: `codex:${this.threadId.toLowerCase()}`,
      title: path.basename(this.cwd) || 'New Codex conversation', cwd: this.cwd, projectName: path.basename(this.cwd),
      model: this.currentModel,
      status: blockedReason ? 'blocked' : this.composer.busy ? 'busy' : this.idleStatus,
      blockedReason,
      lastActivityAt: this.lastActivityAt,
      startedAt: this.startedAt,
      runnerOwned: true,
    };
  }

  // ---- SessionHandle: the cached view ----

  get sessionId(): string {
    return this.threadId;
  }

  get lifecycle(): SessionLifecycle {
    if (this.ended) return 'ended';
    return this.composer.busy ? 'running' : 'idle';
  }

  get canSend(): boolean {
    return !this.ended;
  }

  /** The row this thread shows as until the store has one of its own. */
  get liveSession(): AgentSession {
    return this.session;
  }

  protected get truncatedView(): boolean {
    return false;
  }

  /** Codex history arrives as the initial blocks, so there is nothing separate to load. */
  async history(): Promise<ConversationHistory> {
    return { blocks: [], truncated: false };
  }

  fullBlockText(): string | undefined {
    return undefined;
  }

  // ---- commands ----

  async send(text: string, images: ImageAttachment[] = []): Promise<CommandOutcome> {
    if (this.ended) return 'gone';
    if (!text.trim() && images.length === 0) return 'applied';
    const content: any[] = [];
    if (text.trim()) content.push({ type: 'text', text: text.trim(), text_elements: [] });
    for (const image of images) content.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
    this.add({ kind: 'user', id: this.id(), text: text.trim(), imageCount: images.length || undefined });
    this.turnAssistantText = '';
    this.turnOutcome = 'completed';
    const result = await this.server.request<any>('turn/start', { threadId: this.threadId, input: content, ...(this.currentModel ? { model: this.currentModel } : {}) });
    this.activeTurnId = result?.turn?.id;
    this.setBusy(true);
    return 'applied';
  }

  async interrupt(): Promise<CommandOutcome> {
    if (!this.activeTurnId) return 'stale';
    await this.server.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
    return 'applied';
  }

  async setModel(model?: string): Promise<CommandOutcome> {
    this.currentModel = model;
    this.composer.model = model;
    if (this.activeTurnId) {
      await this.server.request('turn/settings/update', { threadId: this.threadId, turnId: this.activeTurnId, model: model ?? null });
    }
    this.emitComposer(this.composer);
    return 'applied';
  }

  /** Codex takes its permission policy per thread at start; there is no live switch here. */
  async setPermissionMode(): Promise<CommandOutcome> {
    return 'unsupported';
  }

  /** Effort is start-time only for Codex threads started here. */
  async setEffort(): Promise<CommandOutcome> {
    return 'unsupported';
  }

  setModels(models: ComposerState['models']): void {
    this.composer.models = models;
    this.emitComposer(this.composer);
  }

  async decide(requestId: string, decision: 'allow' | 'always' | 'deny'): Promise<CommandOutcome> {
    const rpcId = this.pendingApprovals.get(requestId);
    if (rpcId === undefined) return 'stale';
    this.pendingApprovals.delete(requestId);
    this.server.respond(rpcId, { decision: decision === 'deny' ? 'decline' : 'accept' });
    this.emitPatchAndStore({ id: requestId, block: { state: decision === 'deny' ? 'denied' : 'allowed' } });
    this.touch();
    return 'applied';
  }

  async answer(requestId: string, answers: Record<string, string>): Promise<CommandOutcome> {
    const rpcId = this.pendingQuestions.get(requestId);
    if (rpcId === undefined) return 'stale';
    this.pendingQuestions.delete(requestId);
    this.server.respond(rpcId, {
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }])),
    });
    this.emitPatchAndStore({ id: requestId, block: { state: 'allowed', answers } });
    this.touch();
    return 'applied';
  }

  /** Codex has no plan mode, so there is never a plan to decide. */
  async decidePlan(): Promise<CommandOutcome> {
    return 'unsupported';
  }

  /** Release the thread: this client stops driving it. The thread itself lives on in Codex. */
  async end(): Promise<void> {
    if (this.ended) return;
    if (this.endHook) this.endHook();
    else this.shutdown();
  }

  private onNotification(event: RpcNotification): void {
    if (threadIdOf(event.params) !== this.threadId) return;
    const params = event.params ?? {};
    if (event.method === 'turn/started') {
      this.activeTurnId = params.turn?.id;
      this.setBusy(true);
      this.turnAssistantText = '';
      this.turnOutcome = 'completed';
      return;
    }
    if (event.method === 'turn/completed') {
      const outcome = params.turn?.error || params.turn?.status === 'failed'
        ? 'failed'
        : params.turn?.status === 'interrupted' || params.turn?.status === 'cancelled'
          ? 'interrupted'
          : 'completed';
      this.turnOutcome = outcome;
      this.idleStatus = finishedTurnStatus(this.turnAssistantText || undefined, outcome);
      this.activeTurnId = undefined;
      this.streamingId = undefined;
      this.streamingText = '';
      this.pendingApprovals.clear();
      this.pendingQuestions.clear();
      this.setBusy(false);
      if (params.turn?.error?.message) this.add({ kind: 'note', id: this.id(), tone: 'error', text: capText(params.turn.error.message) });
      // Codex's own turn-completion payload, untranslated (token usage, status).
      this.emitTurnEnd(params);
      return;
    }
    if (event.method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      if (!this.streamingId) {
        this.streamingId = this.id();
        this.streamingText = '';
        this.streamingKind = params.phase === 'commentary' ? 'thinking' : 'assistant';
        this.add(this.streamingKind === 'thinking'
          ? { kind: 'thinking', id: this.streamingId, text: '', streaming: true }
          : { kind: 'assistant', id: this.streamingId, text: '', streaming: true, model: this.currentModel });
      }
      this.streamingText += delta;
      if (this.streamingKind === 'assistant') this.turnAssistantText += delta;
      this.emitPatchAndStore({ id: this.streamingId, block: { text: capText(this.streamingText), streaming: true } });
      return;
    }
    if (event.method === 'item/started') {
      const item = params.item;
      if (!item?.id || item.type === 'agentMessage') return;
      const blockId = this.id();
      const tool = this.toolBlock(item, blockId);
      if (!tool) return;
      this.itemBlocks.set(item.id, blockId);
      this.add(tool);
      return;
    }
    if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const text = String(params.item.text ?? this.streamingText);
      this.turnAssistantText = text;
      if (this.streamingId) this.emitPatchAndStore({ id: this.streamingId, block: { text: capText(text), streaming: false } });
      this.streamingId = undefined;
      this.streamingText = '';
      this.streamingKind = 'assistant';
      if (!this.composer.busy) {
        this.idleStatus = finishedTurnStatus(text || undefined, this.turnOutcome);
        this.touch();
      }
      return;
    }
    if (event.method === 'item/completed') {
      const item = params.item;
      const blockId = item?.id ? this.itemBlocks.get(item.id) : undefined;
      if (!blockId) return;
      const failed = item.status === 'failed' || item.status === 'declined' || !!item.error;
      const output = item.aggregatedOutput ?? item.result ?? item.error?.message;
      this.emitPatchAndStore({
        id: blockId,
        block: {
          state: failed ? 'error' : 'done',
          ...(output === undefined ? {} : { result: { text: capText(typeof output === 'string' ? output : JSON.stringify(output), 4000), isError: failed, truncated: false } }),
        },
      });
    }
  }

  private onRequest(event: RpcServerRequest): void {
    if (threadIdOf(event.params) !== this.threadId) return;
    if (event.method === 'item/tool/requestUserInput') {
      const requestId = `codex-question:${String(event.id)}`;
      this.pendingQuestions.set(requestId, event.id);
      this.add({
        kind: 'question', id: requestId, requestId, state: 'pending',
        questions: (event.params?.questions ?? []).map((question: any) => ({
          question: String(question.question ?? ''), header: String(question.header ?? ''),
          options: (question.options ?? []).map((option: any) => ({ label: String(option.label ?? ''), description: String(option.description ?? '') })),
        })),
      });
      this.touch();
      return;
    }
    if (!/requestApproval$/.test(event.method)) return;
    const requestId = `codex-approval:${String(event.id)}`;
    this.pendingApprovals.set(requestId, event.id);
    const command = event.params?.command ?? event.params?.item?.command;
    this.add({
      kind: 'permission', id: requestId, requestId,
      toolName: event.params?.toolName ?? (command ? 'Shell' : 'tool'),
      summary: event.params?.reason,
      body: Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? command : undefined,
      isCommand: !!command, state: 'pending',
    });
    this.touch();
  }

  private id(): string { return `cr:${this.seq++}`; }
  private toolBlock(item: any, id: string): ConvBlock | undefined {
    if (item.type === 'commandExecution') {
      return { kind: 'tool', id, toolUseId: item.id, name: 'Shell', inputPreview: String(item.command ?? ''), input: { command: item.command, cwd: item.cwd }, state: 'running' };
    }
    if (item.type === 'fileChange') {
      return { kind: 'tool', id, toolUseId: item.id, name: 'File change', inputPreview: `${item.changes?.length ?? 0} change(s)`, input: item.changes, state: 'running' };
    }
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      const name = item.tool ?? 'tool';
      return { kind: 'tool', id, toolUseId: item.id, name, inputPreview: JSON.stringify(item.arguments ?? {}).slice(0, 300), input: item.arguments, state: 'running' };
    }
    return undefined;
  }
  private add(block: ConvBlock): void {
    this.blocks.push(block);
    this.lastActivityAt = Date.now();
    this.emitAppend([block]);
  }
  /** Patch the stored block too, so `snapshot()` and `blocks` show what the pane shows. */
  private emitPatchAndStore(patch: { id: string; block: Partial<ConvBlock> }): void {
    const at = this.blocks.findIndex((b) => b.id === patch.id);
    if (at >= 0) this.blocks[at] = { ...this.blocks[at], ...patch.block } as ConvBlock;
    this.emitPatch(patch);
  }
  private touch(): void {
    this.lastActivityAt = Date.now();
    this.stateChanged();
  }
  private setBusy(busy: boolean): void {
    const was = this.lifecycle;
    this.composer.busy = busy;
    this.lastActivityAt = Date.now();
    this.emitComposer(this.composer);
    if (this.lifecycle !== was) this.emitLifecycle(this.lifecycle);
    this.stateChanged();
  }
  shutdown(): void {
    if (this.ended) return;
    this.ended = true;
    for (const sub of this.subs) sub.dispose();
    this.subs = [];
    this.emitLifecycle('ended');
    this.disposeView();
  }
}

export class CodexRunnerService implements SessionExecutor, Disposable {
  readonly provider = 'codex' as const;
  private runners = new Map<string, CodexRunner>();
  private change = new Emitter<void>();
  constructor(
    private server: CodexAppServer,
    private rememberModels?: (models: ComposerState['models']) => void,
  ) {}
  onDidChange = (listener: () => void): Disposable => this.change.event(listener);
  owns(id: string | undefined): boolean { return !!id && this.runners.has(id.toLowerCase()); }
  get(id: string | undefined): CodexRunner | undefined { return id ? this.runners.get(id.toLowerCase()) : undefined; }
  list(): CodexRunner[] { return [...this.runners.values()]; }

  /** Start a thread, or rejoin one with `resume`. The one-object form of `start` / `resume`. */
  async launch(request: LaunchRequest): Promise<CodexRunner> {
    if (request.provider !== 'codex') throw new Error(`CodexRunnerService cannot launch a ${request.provider} session`);
    const runner = request.resume
      ? await this.resume(request.resume, request.cwd, request.initialBlocks ?? [], request.model)
      : await this.start(request.cwd, request.model, request.effort, request.origin);
    if (request.initialPrompt) await runner.send(request.initialPrompt);
    return runner;
  }

  async start(cwd: string, model?: string, effort?: string, origin?: string): Promise<CodexRunner> {
    const result = await this.server.request<any>('thread/start', {
      cwd,
      ...(model ? { model } : {}),
      ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string') throw new Error('Codex App Server returned no thread id');
    const runner = new CodexRunner(this.server, threadId, cwd, result?.model ?? model, [], () => this.change.fire(), origin);
    return this.track(runner);
  }
  async resume(threadId: string, cwd: string, initialBlocks: ConvBlock[] = [], model?: string): Promise<CodexRunner> {
    const key = threadId.toLowerCase();
    const existing = this.runners.get(key);
    if (existing) return existing;
    const result = await this.server.request<any>('thread/resume', { threadId });
    const resumedId = result?.thread?.id ?? threadId;
    const runner = new CodexRunner(
      this.server, resumedId, cwd, result?.thread?.model ?? result?.model ?? model, initialBlocks, () => this.change.fire(),
    );
    return this.track(runner);
  }
  async fork(threadId: string, cwd: string, initialBlocks: ConvBlock[] = [], model?: string): Promise<CodexRunner> {
    const result = await this.server.request<any>('thread/fork', { threadId });
    const forkedId = result?.thread?.id;
    if (typeof forkedId !== 'string') throw new Error('Codex App Server returned no forked thread id');
    const runner = new CodexRunner(
      this.server, forkedId, cwd, result?.thread?.model ?? result?.model ?? model, initialBlocks, () => this.change.fire(),
    );
    return this.track(runner);
  }
  private track(runner: CodexRunner): CodexRunner {
    this.runners.set(runner.threadId.toLowerCase(), runner);
    runner.endHook = () => this.release(runner.threadId);
    this.change.fire();
    this.loadModels(runner);
    return runner;
  }
  release(threadId: string): void {
    const key = threadId.toLowerCase();
    const runner = this.runners.get(key);
    if (!runner) return;
    this.runners.delete(key);
    runner.shutdown();
    void this.server.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    this.change.fire();
  }
  private loadModels(runner: CodexRunner): void {
    void this.server.request<any>('model/list', { includeHidden: false }).then((list) => {
      const models = (list?.data ?? []).map((entry: any) => ({
        value: String(entry.model ?? entry.id),
        label: String(entry.displayName ?? entry.model ?? entry.id),
        resolved: String(entry.model ?? entry.id),
        effortLevels: Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts.map((level: any) => String(level.reasoningEffort ?? level.effort ?? level))
          : undefined,
      }));
      runner.setModels(models);
      this.rememberModels?.(models);
    }).catch(() => undefined);
  }
  dispose(): void { for (const runner of this.runners.values()) runner.shutdown(); this.runners.clear(); this.server.dispose(); this.change.dispose(); }
}

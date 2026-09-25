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
import type { ExecutorRegistry } from '../core/session/sessionRegistry';
import type { ConversationHistory } from '../claude/transcriptHistory';
import { capText, type ComposerState, type ConvBlock, type ImageAttachment } from '../shared/conversation';
import type { AgentSession } from '../shared/model';
import { CodexAppServer, type ReconnectEvent, type RpcNotification, type RpcServerRequest } from './appServer';
import { readRolloutBlocks } from './rollout';

function threadIdOf(params: any): string | undefined {
  return params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId;
}

/**
 * Why a `thread/resume` failed, in the terms the app acts on (spike S4):
 *
 * - `open-elsewhere`: another app-server (usually the VS Code extension's)
 *   holds the thread's writer lock. Show it read-only and do not retry; the
 *   lock frees about 60 s after that side goes idle with no subscribers.
 * - `no-rollout`: a thread with no turns yet cannot be resumed from another
 *   connection, and after a restart it never will be. Disposable.
 */
export function classifyResumeError(error: unknown): 'open-elsewhere' | 'no-rollout' | 'other' {
  const message = error instanceof Error ? error.message : String(error);
  if (/already has (?:an active|a live local) writer/i.test(message)) return 'open-elsewhere';
  if (/no rollout found/i.test(message)) return 'no-rollout';
  return 'other';
}

/** The subset of `CodexAppServer` the runners use; tests pass a fake. */
type Server = Pick<CodexAppServer, 'request' | 'respond' | 'onNotification' | 'onRequest'> &
  Partial<Pick<CodexAppServer, 'onReconnect' | 'instance' | 'dispose'>>;

export const OPEN_ELSEWHERE_REASON =
  'This Codex conversation is open in another app (usually VS Code), so Agent Wrangler can only show it. ' +
  'Take it over once that app has let go of it.';

export class CodexRunner extends SessionViewBase implements SessionHandle {
  readonly provider = 'codex' as const;
  readonly startedAt = Date.now();
  readonly composer: ComposerState = { permissionMode: 'default', slashCommands: [], busy: false, queued: 0 };
  readonly blocks: ConvBlock[] = [];
  readonly pendingPlan = undefined;
  private ended = false;
  /** Set when the thread turned out to be held by another app-server: shown, not driven. */
  private elsewhere = false;
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
  /** The last `thread/tokenUsage/updated`: `total` is cumulative per thread, `last` one turn's worth. */
  private tokenUsage?: { turnId?: string; tokenUsage: unknown };
  private idleStatus: 'waiting' | 'done';
  private lastActivityAt = Date.now();
  private seq = 0;

  private currentModel?: string;
  /**
   * Effort sent on the next `turn/start`. Codex takes effort per turn, and it
   * sticks for the turns after (orchestration plan §6.4). Undefined sends
   * nothing, which leaves the thread on whatever it last had.
   */
  private currentEffort?: string;

  /** The question currently waiting on this runner, if any. */
  get pendingQuestion(): Extract<ConvBlock, { kind: 'question' }> | undefined {
    return [...this.blocks].reverse().find(
      (block): block is Extract<ConvBlock, { kind: 'question' }> =>
        block.kind === 'question' && this.pendingQuestions.has(block.requestId),
    );
  }

  constructor(
    readonly server: Server,
    readonly threadId: string,
    readonly cwd: string,
    model?: string,
    initialBlocks: ConvBlock[] = [],
    private stateChanged: () => void = () => undefined,
    readonly origin?: unknown,
  ) {
    super();
    this.blocks.push(...initialBlocks);
    const lastAssistant = [...initialBlocks].reverse().find((block) => block.kind === 'assistant');
    this.idleStatus = lastAssistant?.kind === 'assistant' ? finishedTurnStatus(lastAssistant.text) : 'waiting';
    this.currentModel = model;
    this.composer.model = model;
    this.subs.push(server.onNotification((event) => this.onNotification(event)), server.onRequest((event) => this.handleRequest(event)));
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
    return !this.ended && !this.elsewhere;
  }

  /** Why the composer is read-only, when this thread can be shown but not driven. */
  get readOnlyReason(): string | undefined {
    return this.elsewhere ? OPEN_ELSEWHERE_REASON : undefined;
  }

  get openElsewhere(): boolean {
    return this.elsewhere;
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
    if (this.elsewhere) return 'unsupported';
    if (!text.trim() && images.length === 0) return 'applied';
    const content: any[] = [];
    if (text.trim()) content.push({ type: 'text', text: text.trim(), text_elements: [] });
    for (const image of images) content.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
    this.add({ kind: 'user', id: this.id(), text: text.trim(), imageCount: images.length || undefined });
    this.turnAssistantText = '';
    this.turnOutcome = 'completed';
    const result = await this.server.request<any>('turn/start', {
      threadId: this.threadId,
      input: content,
      ...(this.currentModel ? { model: this.currentModel } : {}),
      ...(this.currentEffort ? { effort: this.currentEffort } : {}),
    });
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

  /**
   * Change how hard the thread thinks from the next turn on: Codex takes
   * `effort` on `turn/start` (plan §6.4). A turn already running keeps its
   * effort. Empty means "no override", so the next turn sends none and the
   * thread keeps the level it last ran at.
   */
  async setEffort(effort: string): Promise<CommandOutcome> {
    if (this.ended) return 'gone';
    const level = effort.trim() || undefined;
    this.currentEffort = level;
    this.composer.effort = level;
    this.emitComposer(this.composer);
    return 'applied';
  }

  /** The effort the thread was started with, so the composer shows it. Not re-sent: the thread already has it. */
  startedWithEffort(effort: string | undefined): void {
    if (effort) this.composer.effort = effort;
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
    if (event.method === 'serverRequest/resolved') {
      // Another subscriber (a second window, Discord, the core before a
      // restart) answered first. The card stops offering buttons that would
      // now do nothing.
      this.settleElsewhere(params.requestId);
      return;
    }
    if (event.method === 'thread/tokenUsage/updated') {
      // `turn/completed` carries no usage; this is where Codex reports it.
      if (params.tokenUsage && typeof params.tokenUsage === 'object') {
        this.tokenUsage = { turnId: typeof params.turnId === 'string' ? params.turnId : undefined, tokenUsage: params.tokenUsage };
      }
      return;
    }
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
      // Codex's own turn-completion payload, untranslated (`{threadId, turn}`:
      // status, error, timings). It has no usage of its own, so the latest
      // `thread/tokenUsage/updated` rides along as `usageUpdate` (its params
      // minus the thread id: {turnId, tokenUsage: {total, last,
      // modelContextWindow}}), and the thread's model as `model`: the only two
      // things added.
      this.emitTurnEnd({ ...params, ...(this.tokenUsage ? { usageUpdate: this.tokenUsage } : {}), model: this.currentModel });
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
      const commentary = params.item.phase === 'commentary' || (this.streamingId !== undefined && this.streamingKind === 'thinking');
      if (!commentary) this.turnAssistantText = text;
      if (this.streamingId) this.emitPatchAndStore({ id: this.streamingId, block: { text: capText(text), streaming: false } });
      // Streamed while nobody was connected: no deltas, only the whole item.
      else if (text) {
        this.add(commentary
          ? { kind: 'thinking', id: this.id(), text: capText(text) }
          : { kind: 'assistant', id: this.id(), text: capText(text), model: this.currentModel });
      }
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
      if (!item?.id) return;
      let blockId = this.itemBlocks.get(item.id);
      if (!blockId) {
        // Started while nobody was connected, so there was no `item/started`:
        // make the block from the finished item.
        const id = this.id();
        const tool = this.toolBlock(item, id);
        if (!tool) return;
        this.itemBlocks.set(item.id, id);
        this.add(tool);
        blockId = id;
      }
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

  /**
   * The card's id for a server request. Request ids are per server process and
   * start again at 0 when it restarts, so the server instance is part of it:
   * `(instance, id)` is what is unique.
   */
  private requestKey(kind: 'approval' | 'question', id: string | number): string {
    const instance = this.server.instance;
    return `codex-${kind}:${instance ? `${instance}:` : ''}${String(id)}`;
  }

  /**
   * A request the server sent, or re-sent: after `thread/resume` on a new
   * connection it sends every pending ask again with its original id. A card
   * already on screen for it stays as it is.
   */
  handleRequest(event: RpcServerRequest): void {
    if (threadIdOf(event.params) !== this.threadId || this.ended) return;
    if (event.method === 'item/tool/requestUserInput') {
      const requestId = this.requestKey('question', event.id);
      if (this.reopen(requestId, event.id, this.pendingQuestions)) return;
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
    const requestId = this.requestKey('approval', event.id);
    if (this.reopen(requestId, event.id, this.pendingApprovals)) return;
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

  /**
   * A re-sent request whose card exists: keep the card. If this side had
   * answered it but the answer never arrived (the connection dropped first),
   * the server is still asking, so the card is pending again.
   */
  private reopen(requestId: string, rpcId: string | number, pending: Map<string, string | number>): boolean {
    if (pending.has(requestId)) return true;
    const block = this.blocks.find((b) => b.id === requestId);
    if (!block) return false;
    pending.set(requestId, rpcId);
    if ('state' in block && block.state !== 'pending') this.emitPatchAndStore({ id: requestId, block: { state: 'pending' } });
    this.touch();
    return true;
  }

  /** `serverRequest/resolved`: someone else answered this request. */
  private settleElsewhere(rpcId: unknown): void {
    for (const pending of [this.pendingApprovals, this.pendingQuestions]) {
      for (const [requestId, id] of pending) {
        if (String(id) !== String(rpcId)) continue;
        pending.delete(requestId);
        this.emitPatchAndStore({ id: requestId, block: { state: 'expired' } });
        this.touch();
        return;
      }
    }
  }

  // ---- reconnects and restarts (Stage 5) ----

  /**
   * The server this thread was on is gone and a new one has started. What was
   * in flight did not survive: the turn is recorded as interrupted, and the
   * asks it was waiting on are never sent again.
   */
  serverRestarted(): void {
    if (this.ended) return;
    const hadWork = this.composer.busy || this.pendingApprovals.size > 0 || this.pendingQuestions.size > 0;
    for (const requestId of [...this.pendingApprovals.keys(), ...this.pendingQuestions.keys()]) {
      this.emitPatchAndStore({ id: requestId, block: { state: 'expired' } });
    }
    this.pendingApprovals.clear();
    this.pendingQuestions.clear();
    if (this.streamingId) this.emitPatchAndStore({ id: this.streamingId, block: { streaming: false } });
    this.streamingId = undefined;
    this.streamingText = '';
    this.activeTurnId = undefined;
    this.itemBlocks.clear();
    if (hadWork) {
      this.add({
        kind: 'note', id: this.id(), tone: 'warn',
        text: 'The Codex server restarted, so the turn in progress was interrupted and its pending requests were dropped. Send again to continue.',
      });
      this.idleStatus = 'waiting';
    }
    this.setBusy(false);
  }

  /** Rejoined with `thread/resume`: take the thread's state from the server's answer. */
  resumed(result: any): void {
    if (this.ended) return;
    this.elsewhere = false;
    const thread = result?.thread;
    const model = thread?.model ?? result?.model;
    if (typeof model === 'string' && model !== this.currentModel) {
      this.currentModel = model;
      this.composer.model = model;
    }
    const turns: any[] = [
      ...(Array.isArray(thread?.turns) ? thread.turns : []),
      ...(Array.isArray(result?.initialTurnsPage?.data) ? result.initialTurnsPage.data : []),
    ];
    const running = turns.find((turn) => turn?.status === 'inProgress');
    const active = thread?.status?.type === 'active';
    if (active) {
      if (running?.id) this.activeTurnId = running.id;
      this.setBusy(true);
    } else {
      // Finished while nobody was connected: its `turn/completed` went to no one.
      this.activeTurnId = undefined;
      if (this.streamingId) this.emitPatchAndStore({ id: this.streamingId, block: { streaming: false } });
      this.streamingId = undefined;
      this.streamingText = '';
      this.setBusy(false);
    }
  }

  /**
   * Replace the conversation with `history` (the rollout, read after a
   * resume), keeping what arrived since the resume: pending cards the server
   * has just re-sent, and anything that streamed in while the file was read.
   * The pane re-reads the snapshot on `reset`.
   */
  rebuild(history: ConvBlock[], keepFrom: number): void {
    if (this.ended) return;
    const pendingIds = new Set([...this.pendingApprovals.keys(), ...this.pendingQuestions.keys()]);
    const before = this.blocks.slice(0, keepFrom).filter((b) => pendingIds.has(b.id));
    const after = this.blocks.slice(keepFrom);
    const keep = [...before, ...after];
    const historyIds = new Set(history.map((b) => b.id));
    this.blocks.splice(0, this.blocks.length, ...history, ...keep.filter((b) => !historyIds.has(b.id)));
    const lastAssistant = [...history].reverse().find((block) => block.kind === 'assistant');
    if (!this.composer.busy && lastAssistant?.kind === 'assistant') this.idleStatus = finishedTurnStatus(lastAssistant.text);
    this.emitReset();
    this.touch();
  }

  /** How many blocks there are now: the mark `rebuild` keeps from. */
  get blockCount(): number {
    return this.blocks.length;
  }

  /**
   * Another app-server holds this thread's writer lock. Keep showing it, stop
   * offering to drive it, and do not retry: that is the user's call.
   */
  markElsewhere(): void {
    if (this.ended || this.elsewhere) return;
    this.elsewhere = true;
    this.pendingApprovals.clear();
    this.pendingQuestions.clear();
    this.activeTurnId = undefined;
    this.add({ kind: 'note', id: this.id(), tone: 'warn', text: OPEN_ELSEWHERE_REASON });
    this.composer.busy = false;
    this.emitComposer(this.composer);
    this.stateChanged();
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
  /**
   * Requests for threads with no runner yet. The server re-sends pending asks
   * right after the `thread/resume` response, in the same breath, so they can
   * arrive before the runner that asked exists. Handed over in `track`.
   */
  private unclaimed: { threadId: string; instance?: string; event: RpcServerRequest }[] = [];
  private subs: Disposable[] = [];
  private readonly log: (message: string) => void;
  constructor(
    private server: Server,
    private rememberModels?: (models: ComposerState['models']) => void,
    private record: {
      /** Records every thread and what became of it, so a restart can offer them back. */
      registry?: ExecutorRegistry;
      locate?: (cwd: string) => { repoRoot?: string; worktree?: string; branch?: string };
      log?: (message: string) => void;
      /** Reads a rollout file into blocks; injectable for tests. */
      readHistory?: (path: string) => Promise<{ blocks: ConvBlock[] }>;
    } = {},
  ) {
    this.log = record.log ?? (() => undefined);
    this.subs.push(server.onRequest((event) => {
      const threadId = threadIdOf(event.params);
      if (!threadId || this.runners.has(threadId.toLowerCase())) return;
      this.unclaimed.push({ threadId: threadId.toLowerCase(), instance: server.instance, event });
      if (this.unclaimed.length > 100) this.unclaimed.shift();
    }));
    if (server.onReconnect) this.subs.push(server.onReconnect((event) => void this.reconnected(event)));
  }
  onDidChange = (listener: () => void): Disposable => this.change.event(listener);
  owns(id: string | undefined): boolean { return !!id && this.runners.has(id.toLowerCase()); }
  get(id: string | undefined): CodexRunner | undefined { return id ? this.runners.get(id.toLowerCase()) : undefined; }
  list(): CodexRunner[] { return [...this.runners.values()]; }

  /** Start a thread, or rejoin one with `resume`. The one-object form of `start` / `resume`. */
  async launch(request: LaunchRequest): Promise<CodexRunner> {
    if (request.provider !== 'codex') throw new Error(`CodexRunnerService cannot launch a ${request.provider} session`);
    const runner = request.resume
      ? await this.resume(request.resume, request.cwd, request.initialBlocks ?? [], request.model, { origin: request.origin })
      : await this.start(request.cwd, request.model, request.effort, request.origin);
    if (request.initialPrompt) await runner.send(request.initialPrompt);
    return runner;
  }

  async start(cwd: string, model?: string, effort?: string, origin?: unknown): Promise<CodexRunner> {
    const result = await this.server.request<any>('thread/start', {
      cwd,
      ...(model ? { model } : {}),
      ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string') throw new Error('Codex App Server returned no thread id');
    const runner = new CodexRunner(this.server, threadId, cwd, result?.model ?? model, [], () => this.change.fire(), origin);
    runner.startedWithEffort(effort);
    return this.track(runner, { effort });
  }
  async resume(
    threadId: string,
    cwd: string,
    initialBlocks: ConvBlock[] = [],
    model?: string,
    options: { historyFromServer?: boolean; origin?: unknown } = {},
  ): Promise<CodexRunner> {
    const key = threadId.toLowerCase();
    const existing = this.runners.get(key);
    if (existing) return existing;
    const result = await this.server.request<any>('thread/resume', { threadId });
    const resumedId = result?.thread?.id ?? threadId;
    const runner = new CodexRunner(
      this.server, resumedId, cwd, result?.thread?.model ?? result?.model ?? model, initialBlocks, () => this.change.fire(), options.origin,
    );
    const mark = runner.blockCount;
    this.track(runner);
    runner.resumed(result);
    if (options.historyFromServer) await this.reloadHistory(runner, result, mark);
    return runner;
  }

  /**
   * Rejoin the threads the last run of the app was driving (`records`: the
   * registry's Codex sessions that were live when it stopped). One still
   * loaded in the host server comes back exactly as it was, running or
   * waiting, and the server re-sends its pending asks after `thread/resume`.
   * One it has unloaded (idle for a minute with nobody attached, which is
   * every idle thread after a quit) is loaded again from disk; nothing of it
   * was in flight. A thread with no turns cannot be, and is dropped.
   */
  async reattach(records: { sessionId: string; cwd: string; launch?: { model?: string }; origin?: unknown }[]): Promise<{
    reattached: string[];
    elsewhere: string[];
    dropped: string[];
    failed: string[];
  }> {
    const out = { reattached: [] as string[], elsewhere: [] as string[], dropped: [] as string[], failed: [] as string[] };
    for (const record of records) {
      try {
        await this.resume(record.sessionId, record.cwd, [], record.launch?.model, { historyFromServer: true, origin: record.origin });
        out.reattached.push(record.sessionId);
      } catch (error) {
        const kind = classifyResumeError(error);
        if (kind === 'open-elsewhere') {
          this.record.registry?.setState(record.sessionId, 'stopped', 'open-elsewhere');
          out.elsewhere.push(record.sessionId);
        } else if (kind === 'no-rollout') {
          this.record.registry?.forget?.(record.sessionId);
          out.dropped.push(record.sessionId);
        } else {
          this.log(`codex: could not rejoin ${record.sessionId}: ${String(error)}`);
          out.failed.push(record.sessionId);
        }
      }
    }
    return out;
  }

  /** Every thread the server has loaded, across pages. */
  async loadedThreads(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.server.request<any>('thread/loaded/list', cursor ? { cursor } : {});
      for (const id of result?.data ?? []) if (typeof id === 'string') ids.push(id);
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return ids;
  }

  /** How many loaded threads have a turn running (or waiting on an ask): what a server stop would interrupt. */
  async activeThreads(): Promise<number> {
    let active = 0;
    for (const threadId of await this.loadedThreads()) {
      const owned = this.get(threadId);
      if (owned) {
        if (owned.lifecycle === 'running' || owned.session.status === 'blocked') active++;
        continue;
      }
      const read = await this.server.request<any>('thread/read', { threadId }).catch(() => undefined);
      if (read?.thread?.status?.type === 'active') active++;
    }
    return active;
  }

  /**
   * The connection came back. The same server still has every thread and
   * re-sends their pending asks on resume; a new server has lost everything
   * that was in flight, so the runners say so first.
   */
  private async reconnected(event: ReconnectEvent): Promise<void> {
    this.unclaimed = [];
    for (const runner of this.list()) {
      // Marked first, so the restart note is kept when the history is re-read.
      const mark = runner.blockCount;
      if (event.restarted) runner.serverRestarted();
      await this.rejoin(runner, mark);
    }
  }

  private async rejoin(runner: CodexRunner, mark: number): Promise<void> {
    let result: any;
    try {
      result = await this.server.request<any>('thread/resume', { threadId: runner.threadId });
    } catch (error) {
      const kind = classifyResumeError(error);
      if (kind === 'open-elsewhere') {
        runner.markElsewhere();
        this.record.registry?.setState(runner.threadId, 'stopped', 'open-elsewhere');
        this.log(`codex: ${runner.threadId} is open in another app; showing it read-only`);
      } else if (kind === 'no-rollout') {
        // Never sent a message, and the server that knew it is gone.
        this.drop(runner.threadId);
        this.record.registry?.forget?.(runner.threadId);
      } else {
        this.log(`codex: could not rejoin ${runner.threadId}: ${String(error)}`);
      }
      return;
    }
    runner.resumed(result);
    await this.reloadHistory(runner, result, mark);
  }

  /** Read what happened while nobody was connected from the rollout, when the server says where it is. */
  private async reloadHistory(runner: CodexRunner, result: any, mark: number): Promise<void> {
    const file = result?.thread?.path;
    if (typeof file !== 'string' || !file) return;
    try {
      const history = await (this.record.readHistory ?? readRolloutBlocks)(file);
      runner.rebuild(history.blocks, mark);
    } catch (error) {
      this.log(`codex: could not read the history of ${runner.threadId}: ${String(error)}`);
    }
  }

  /** Forget a runner without touching the thread or its record: it was never ours to release. */
  drop(threadId: string): void {
    const key = threadId.toLowerCase();
    const runner = this.runners.get(key);
    if (!runner) return;
    this.runners.delete(key);
    runner.shutdown();
    this.change.fire();
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
  private track(runner: CodexRunner, launch: { effort?: string } = {}): CodexRunner {
    this.runners.set(runner.threadId.toLowerCase(), runner);
    runner.endHook = () => this.release(runner.threadId);
    const place = this.record.locate?.(runner.cwd) ?? {};
    this.record.registry?.live({
      sessionId: runner.threadId,
      provider: 'codex',
      cwd: runner.cwd,
      repoRoot: place.repoRoot,
      worktree: place.worktree,
      branchAtStart: place.branch,
      launch: { model: runner.composer.model, effort: launch.effort },
      origin: runner.origin,
    });
    this.change.fire();
    this.loadModels(runner);
    const key = runner.threadId.toLowerCase();
    const mine = this.unclaimed.filter((u) => u.threadId === key && u.instance === this.server.instance);
    this.unclaimed = this.unclaimed.filter((u) => u.threadId !== key);
    for (const u of mine) runner.handleRequest(u.event);
    return runner;
  }
  release(threadId: string): void {
    const key = threadId.toLowerCase();
    const runner = this.runners.get(key);
    if (!runner) return;
    this.runners.delete(key);
    runner.shutdown();
    // Released on purpose (Close, Release): stopped here, not interrupted.
    this.record.registry?.setState(runner.threadId, 'stopped');
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
  /**
   * Stop driving every thread. With the host server they keep running there,
   * and their records stay `live`, so the next start rejoins them.
   */
  dispose(): void {
    for (const sub of this.subs) sub.dispose();
    for (const runner of this.runners.values()) runner.shutdown();
    this.runners.clear();
    this.server.dispose?.();
    this.change.dispose();
  }
}

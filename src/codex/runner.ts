import * as path from 'node:path';
import { Emitter, type Disposable } from '../core/events';
import { capText, type BlockPatch, type ComposerState, type ConvBlock, type ImageAttachment } from '../shared/conversation';
import type { AgentSession } from '../shared/model';
import type { ConversationInit, ConversationSource } from '../ui/conversation/source';
import { CodexAppServer, type RpcNotification, type RpcServerRequest } from './appServer';

function threadIdOf(params: any): string | undefined {
  return params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId;
}

export class CodexRunner implements ConversationSource {
  readonly kind = 'runner' as const;
  readonly startedAt = Date.now();
  readonly composer: ComposerState = { permissionMode: 'default', slashCommands: [], busy: false, queued: 0 };
  private blocks: ConvBlock[] = [];
  private append = new Emitter<ConvBlock[]>();
  private patch = new Emitter<BlockPatch>();
  private composerEvents = new Emitter<ComposerState>();
  private subs: Disposable[] = [];
  private activeTurnId?: string;
  private pendingApprovals = new Map<string, string | number>();
  private pendingQuestions = new Map<string, string | number>();
  private itemBlocks = new Map<string, string>();
  private streamingId?: string;
  private streamingText = '';
  private seq = 0;

  private currentModel?: string;

  constructor(readonly server: CodexAppServer, readonly threadId: string, readonly cwd: string, model?: string) {
    this.currentModel = model;
    this.composer.model = model;
    this.subs.push(server.onNotification((event) => this.onNotification(event)), server.onRequest((event) => this.onRequest(event)));
  }

  get session(): AgentSession {
    return {
      provider: 'codex', sessionId: this.threadId, key: `codex:${this.threadId.toLowerCase()}`,
      title: path.basename(this.cwd) || 'New Codex conversation', cwd: this.cwd, projectName: path.basename(this.cwd),
      model: this.currentModel, status: this.composer.busy ? 'busy' : 'waiting', lastActivityAt: Date.now(), startedAt: this.startedAt,
      runnerOwned: true,
    };
  }

  onAppend = (listener: (blocks: ConvBlock[]) => void): Disposable => this.append.event(listener);
  onPatch = (listener: (patch: BlockPatch) => void): Disposable => this.patch.event(listener);
  onComposer = (listener: (composer: ComposerState) => void): Disposable => this.composerEvents.event(listener);
  async init(): Promise<ConversationInit> { return { blocks: [...this.blocks], truncated: false }; }
  setSession(): void {}

  async send(text: string, images: ImageAttachment[] = []): Promise<void> {
    if (!text.trim() && images.length === 0) return;
    const content: any[] = [];
    if (text.trim()) content.push({ type: 'text', text: text.trim(), text_elements: [] });
    for (const image of images) content.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` });
    this.add({ kind: 'user', id: this.id(), text: text.trim(), imageCount: images.length || undefined });
    const result = await this.server.request<any>('turn/start', { threadId: this.threadId, input: content, ...(this.currentModel ? { model: this.currentModel } : {}) });
    this.activeTurnId = result?.turn?.id;
    this.setBusy(true);
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId) return;
    await this.server.request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId });
  }

  async setModel(model?: string): Promise<void> {
    this.currentModel = model;
    this.composer.model = model;
    if (this.activeTurnId) {
      await this.server.request('turn/settings/update', { threadId: this.threadId, turnId: this.activeTurnId, model: model ?? null });
    }
    this.composerEvents.fire({ ...this.composer });
  }

  setModels(models: ComposerState['models']): void {
    this.composer.models = models;
    this.composerEvents.fire({ ...this.composer });
  }

  async decide(requestId: string, decision: 'allow' | 'always' | 'deny'): Promise<boolean> {
    const rpcId = this.pendingApprovals.get(requestId);
    if (rpcId === undefined) return false;
    this.pendingApprovals.delete(requestId);
    this.server.respond(rpcId, { decision: decision === 'deny' ? 'decline' : 'accept' });
    this.patch.fire({ id: requestId, block: { state: decision === 'deny' ? 'denied' : 'allowed' } });
    return true;
  }

  async answer(requestId: string, answers: Record<string, string>): Promise<boolean> {
    const rpcId = this.pendingQuestions.get(requestId);
    if (rpcId === undefined) return false;
    this.pendingQuestions.delete(requestId);
    this.server.respond(rpcId, {
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }])),
    });
    this.patch.fire({ id: requestId, block: { state: 'allowed', answers } });
    return true;
  }

  private onNotification(event: RpcNotification): void {
    if (threadIdOf(event.params) !== this.threadId) return;
    const params = event.params ?? {};
    if (event.method === 'turn/started') {
      this.activeTurnId = params.turn?.id;
      this.setBusy(true);
      return;
    }
    if (event.method === 'turn/completed') {
      this.activeTurnId = undefined;
      this.streamingId = undefined;
      this.streamingText = '';
      this.setBusy(false);
      if (params.turn?.error?.message) this.add({ kind: 'note', id: this.id(), tone: 'error', text: capText(params.turn.error.message) });
      return;
    }
    if (event.method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      if (!this.streamingId) {
        this.streamingId = this.id();
        this.streamingText = '';
        this.add({ kind: 'assistant', id: this.streamingId, text: '', streaming: true, model: this.currentModel });
      }
      this.streamingText += delta;
      this.patch.fire({ id: this.streamingId, block: { text: capText(this.streamingText), streaming: true } });
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
    if (event.method === 'item/completed' && params.item?.type === 'agentMessage' && this.streamingId) {
      this.patch.fire({ id: this.streamingId, block: { text: capText(params.item.text ?? this.streamingText), streaming: false } });
      this.streamingId = undefined;
      this.streamingText = '';
      return;
    }
    if (event.method === 'item/completed') {
      const item = params.item;
      const blockId = item?.id ? this.itemBlocks.get(item.id) : undefined;
      if (!blockId) return;
      const failed = item.status === 'failed' || item.status === 'declined' || !!item.error;
      const output = item.aggregatedOutput ?? item.result ?? item.error?.message;
      this.patch.fire({
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
  private add(block: ConvBlock): void { this.blocks.push(block); this.append.fire([block]); }
  private setBusy(busy: boolean): void {
    this.composer.busy = busy;
    this.composerEvents.fire({ ...this.composer });
  }
  /** A pane releases only its listeners; the service owns runner lifetime. */
  dispose(): void {}
  shutdown(): void { for (const sub of this.subs) sub.dispose(); this.subs = []; this.append.dispose(); this.patch.dispose(); this.composerEvents.dispose(); }
}

export class CodexRunnerService implements Disposable {
  private runners = new Map<string, CodexRunner>();
  private change = new Emitter<void>();
  constructor(
    private server: CodexAppServer,
    private rememberModels?: (models: ComposerState['models']) => void,
  ) {}
  onDidChange = (listener: () => void): Disposable => this.change.event(listener);
  owns(id: string | undefined): boolean { return !!id && this.runners.has(id.toLowerCase()); }
  get(id: string | undefined): CodexRunner | undefined { return id ? this.runners.get(id.toLowerCase()) : undefined; }
  async start(cwd: string, model?: string, effort?: string): Promise<CodexRunner> {
    const result = await this.server.request<any>('thread/start', {
      cwd,
      ...(model ? { model } : {}),
      ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
    });
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string') throw new Error('Codex App Server returned no thread id');
    const runner = new CodexRunner(this.server, threadId, cwd, result?.model ?? model);
    this.runners.set(threadId.toLowerCase(), runner);
    this.change.fire();
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
    return runner;
  }
  dispose(): void { for (const runner of this.runners.values()) runner.shutdown(); this.runners.clear(); this.server.dispose(); this.change.dispose(); }
}

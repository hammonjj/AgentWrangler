/**
 * One session Agent Wrangler runs, whichever agent it is and wherever it runs.
 *
 * Everything outside the executors talks to sessions through this interface:
 * the conversation pane, the dashboard's ownership questions, remote control,
 * `createApp`'s adopt/close/release/resume. Nothing holds a Claude
 * `RunnerView` or a `CodexRunner` by its class. That is what lets Stage 3
 * replace the in-process Claude handle with one fed by a session host over a
 * socket without touching any of those call sites
 * (`docs/plans/session-lifecycle-architecture.md` §5, Stage 1).
 *
 * Three parts:
 * - a **cached synchronous view** (`lifecycle`, `composer`, `blocks`,
 *   `pendingQuestion`, `pendingPlan`, `canSend`) that callers may read at any
 *   time without awaiting;
 * - **`snapshot()` + `subscribe(fromSeq)`**: the same view as a numbered event
 *   stream, so a consumer can join late and catch up;
 * - **async commands** that say what happened (`CommandOutcome`) rather than
 *   whether they threw.
 */
import type { Disposable } from '../events';
import type { ConversationHistory } from '../../claude/transcriptHistory';
import type { BlockPatch, ComposerState, ConvBlock, ImageAttachment, PermissionModeName } from '../../shared/conversation';
import type { AgentSession } from '../../shared/model';

export type SessionProvider = 'claude' | 'codex';

/**
 * `starting` until the agent is ready, then `idle`/`running` per turn; `ending`
 * while it is being stopped; `ended` for a clean exit and `error` for a failed
 * one. `connecting` and `unreachable` describe the link to a session host and
 * are only produced by remote handles (Stage 3); local ones never enter them.
 */
export type SessionLifecycle =
  | 'starting'
  | 'idle'
  | 'running'
  | 'ending'
  | 'ended'
  | 'error'
  | 'connecting'
  | 'unreachable';

/**
 * What a command did.
 * - `applied`: done.
 * - `stale`: the thing it answered was already answered or has changed.
 * - `gone`: the session, or the thing it addressed, no longer exists.
 * - `unsupported`: this kind of session cannot do that.
 */
export type CommandOutcome = 'applied' | 'stale' | 'gone' | 'unsupported';

/** The view as numbered events: what the pane and every other consumer is fed. */
export type SessionViewEvent =
  | { seq: number; type: 'append'; blocks: ConvBlock[] }
  | { seq: number; type: 'patch'; patch: BlockPatch }
  | { seq: number; type: 'composer'; composer: ComposerState }
  | { seq: number; type: 'lifecycle'; lifecycle: SessionLifecycle }
  /** The conversation was replaced (`/clear`): start again from a snapshot. */
  | { seq: number; type: 'reset' }
  /** A turn finished. `raw` is the provider's own turn-end payload, untranslated. */
  | { seq: number; type: 'turnEnd'; raw: unknown };

export interface SessionViewSnapshot {
  /** Subscribe from this to follow on without a gap or a repeat. */
  seq: number;
  provider: SessionProvider;
  sessionId?: string;
  lifecycle: SessionLifecycle;
  composer: ComposerState;
  /** What this process has said, newest last. Earlier history is `history()`. */
  blocks: ConvBlock[];
  /** Blocks were dropped off the top of `blocks`. */
  truncated: boolean;
}

/**
 * How to start a session. One object rather than positional arguments so new
 * fields (the orchestrator's `origin`, say) reach every executor without
 * changing a call site (orchestration plan §1.3, A1).
 */
export interface LaunchRequest {
  provider: SessionProvider;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionModeName;
  /** Id for a fresh session, known before its first turn. */
  sessionId?: string;
  /** Session id to continue. */
  resume?: string;
  /** Sent as the first message once the session is up. */
  initialPrompt?: string;
  /**
   * Who asked for it, opaque: e.g. `{kind: 'orchestration', missionId, taskId}`.
   * Recorded in the registry, never interpreted by the executor.
   */
  origin?: unknown;
  /** Codex only: blocks to show for the conversation so far when resuming. */
  initialBlocks?: ConvBlock[];
}

export interface SessionHandle {
  readonly provider: SessionProvider;
  /** Unknown for a fresh Claude session until its first `init`, unless the launch named one. */
  readonly sessionId: string | undefined;
  readonly cwd: string;
  readonly startedAt: number;
  readonly origin?: unknown;

  // ---- cached synchronous view ----
  readonly lifecycle: SessionLifecycle;
  readonly composer: ComposerState;
  readonly blocks: readonly ConvBlock[];
  readonly canSend: boolean;
  /** Why `canSend` is false for a session that is still shown (a Codex thread open in another app). */
  readonly readOnlyReason?: string;
  readonly pendingQuestion: Extract<ConvBlock, { kind: 'question' }> | undefined;
  readonly pendingPlan: Extract<ConvBlock, { kind: 'plan' }> | undefined;
  /**
   * The row this session shows as before the store has one of its own, when
   * the handle can describe itself (Codex). Undefined means the caller builds it.
   */
  readonly liveSession?: AgentSession;

  snapshot(): SessionViewSnapshot;
  /** Events after `fromSeq`, then live. Throws `ResyncNeeded` if the gap is gone: take a snapshot. */
  subscribe(fromSeq: number, listener: (event: SessionViewEvent) => void): Disposable;

  // Conveniences over `subscribe`, for listeners that only follow live events.
  onAppend(listener: (blocks: ConvBlock[]) => void): Disposable;
  onPatch(listener: (patch: BlockPatch) => void): Disposable;
  onComposer(listener: (composer: ComposerState) => void): Disposable;
  onLifecycle(listener: (lifecycle: SessionLifecycle) => void): Disposable;
  onReset(listener: () => void): Disposable;
  onTurnEnd(listener: (raw: unknown) => void): Disposable;

  /** The conversation from before this process took it over, for a resumed session. */
  history(): Promise<ConversationHistory>;
  /** The whole text of a block the pane was sent only the start of. */
  fullBlockText(id: string): string | undefined;

  // ---- commands ----
  send(text: string, images?: ImageAttachment[]): Promise<CommandOutcome>;
  interrupt(): Promise<CommandOutcome>;
  setPermissionMode(mode: PermissionModeName): Promise<CommandOutcome>;
  setModel(model?: string): Promise<CommandOutcome>;
  setEffort(effort: string): Promise<CommandOutcome>;
  decide(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string): Promise<CommandOutcome>;
  answer(requestId: string, answers: Record<string, string>): Promise<CommandOutcome>;
  decidePlan(requestId: string, approve: boolean, feedback?: string): Promise<CommandOutcome>;
  /** Stop the agent. Resolves once it has exited (or the stop sequence ran out). */
  end(): Promise<void>;
}

/** Starts and tracks one provider's sessions. */
export interface SessionExecutor {
  readonly provider: SessionProvider;
  launch(request: LaunchRequest): Promise<SessionHandle>;
  /** The live handle for a session id, if this executor runs it. */
  get(sessionId: string | undefined): SessionHandle | undefined;
  owns(sessionId: string | undefined): boolean;
  list(): SessionHandle[];
  /** A session was started, changed id or lifecycle, or ended. */
  onDidChange(listener: () => void): Disposable;
}

/**
 * The store's sessions, plus the decorations that are true of a session rather
 * than of the surface looking at it.
 *
 * `SessionStore` holds what the providers discovered. Two facts that every
 * surface must respect are not discovered but decided here — whether the user
 * has shoved a session out of the way, and whether its process is frozen — and
 * until this existed they were applied in exactly one place: the dashboard's
 * own snapshot push. Anything that read the store directly got sessions with
 * neither, silently.
 *
 * That was not a hypothetical. `remoteAskFor` skips archived and paused
 * sessions, at length and for good reasons, and was handed raw store sessions
 * that never carried either flag — so pausing every agent on the machine left
 * their permission prompts live in Discord, offering buttons that resolve into
 * a stopped process. The fix is not to teach the remote layer about the archive;
 * it is to have one decorated view and give it to both.
 *
 * Deliberately not folded into `SessionStore.decorate`: the store is shared with
 * providers and knows nothing about services the app assembles. This is the app
 * composing its own view over it, which is why the dependencies arrive as
 * functions rather than as the services themselves.
 *
 * No Node or DOM imports: this is `core`, and a test can drive it with two
 * lambdas.
 */
import { Emitter, type Disposable, type Listener } from './events';
import type { AgentSession } from '../shared/model';

/**
 * What the app knows about a session that provider discovery does not.
 *
 * The runner accessors are optional because they answer a different question
 * from the other two: not "what has the user decided about this session" but
 * "what is this window's own copy of it waiting on right now". A consumer that
 * does not care about in-process asks simply does not pass them.
 *
 * They are keyed by `sessionId` rather than by `key` because that is what the
 * runner registry knows; the store's `key` is a provider-qualified wrapper
 * around it.
 */
export interface SessionDecorations {
  /** The user shoved this row out of the way (`ArchiveService`). */
  isArchived(key: string): boolean;
  /** Its process is stopped and spending nothing (`PauseService`). */
  isPaused(pid: number | undefined): boolean;
  /** This window runs the session itself, so its in-process asks are answerable here. */
  runnerOwned?(sessionId: string | undefined): boolean;
  /** The `AskUserQuestion` this window's runner is parked on, if any. */
  pendingQuestion?(sessionId: string | undefined): AgentSession['pendingQuestion'];
  /** The `ExitPlanMode` this window's runner is parked on, if any. */
  pendingPlan?(sessionId: string | undefined): AgentSession['pendingPlan'];
}

/** Just enough of `SessionStore` to decorate: the list, and when it moves. */
export interface SessionSource {
  readonly sessions: AgentSession[];
  onDidUpdate(listener: Listener<unknown>): Disposable;
}

/** Anything whose changes should make the view fire even though the store has not moved. */
export interface ChangeSource {
  onDidChange(listener: () => void): Disposable;
}

/**
 * Apply the decorations to one session.
 *
 * Returns the session unchanged when neither applies, so the common case
 * allocates nothing and an identity comparison upstream still holds. Both
 * fields are `undefined` rather than `false` when not set, matching how
 * `AgentSession` declares them and how the dashboard has always written them —
 * an explicit `false` would change every session's JSON for no reader's benefit.
 */
export function decorateSession(s: AgentSession, d: SessionDecorations): AgentSession {
  const archived = d.isArchived(s.key) || undefined;
  const paused = d.isPaused(s.pid) || undefined;
  const runnerOwned = d.runnerOwned?.(s.sessionId) || undefined;
  const pendingQuestion = d.pendingQuestion?.(s.sessionId);
  const pendingPlan = d.pendingPlan?.(s.sessionId);
  if (
    archived === undefined &&
    paused === undefined &&
    runnerOwned === undefined &&
    pendingQuestion === undefined &&
    pendingPlan === undefined
  ) {
    return s;
  }
  return { ...s, archived, paused, runnerOwned, pendingQuestion, pendingPlan };
}

/**
 * A live, decorated view of the store.
 *
 * Shaped to satisfy the remote layer's `SessionSnapshot` structurally —
 * `{ sessions, onDidUpdate }` — so `core` need not import from `remote` to be
 * handed to it.
 *
 * It fires on the store *and* on every change source it was given. That second
 * part is the whole point: archiving a session or pausing its process changes
 * what should be mirrored without touching anything a provider scan would
 * notice, so a consumer subscribed only to the store would keep showing the ask
 * until the session next did something of its own accord.
 */
export class DecoratedSessions implements Disposable {
  private subs: Disposable[] = [];
  private emitter = new Emitter<void>();

  readonly onDidUpdate = (listener: () => void): Disposable => this.emitter.event(listener);

  constructor(
    private source: SessionSource,
    private decorations: SessionDecorations,
    changes: ChangeSource[] = [],
  ) {
    this.subs.push(this.source.onDidUpdate(() => this.emitter.fire()));
    for (const c of changes) this.subs.push(c.onDidChange(() => this.emitter.fire()));
  }

  get sessions(): AgentSession[] {
    return this.source.sessions.map((s) => decorateSession(s, this.decorations));
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.emitter.dispose();
  }
}

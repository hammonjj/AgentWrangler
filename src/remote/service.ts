/**
 * Keeps a remote surface showing what Agent Wrangler is currently asking.
 *
 * This is a reconciler, not a state machine. On every store update it recomputes
 * the set of asks that *should* be mirrored, compares that against the messages
 * it has posted, and publishes, edits or closes to make the second match the
 * first. That shape is deliberate: the permission's own lifecycle already has
 * an owner — Claude Code, observed through the hook marker — and a second state
 * machine tracking the same thing would be a second answer that can disagree.
 *
 * So the only state here is a map from an Agent Wrangler interaction to the
 * message mirroring it, and the loop is:
 *
 *     desired = sessions.map(remoteAskFor)     // recomputed, never stored
 *     desired - mirrored  -> publish
 *     mirrored - desired  -> close
 *
 * which is idempotent, self-healing after a restart, and has no notion of
 * "resolving" to get stuck in.
 *
 * A press is not trusted. It arrives with an opaque id and a choice, and both
 * are re-checked against live state before anything is applied — see `onInvoke`.
 * The decision itself is then made by `actions.decidePermission`, the same call
 * the dashboard button makes; nothing here talks to a provider or a hook.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Emitter, type Disposable } from '../core/events';
import type { PermissionDecisionOutcome, SessionActions } from '../ui/actions';
import type { SessionDTO } from '../shared/model';
import {
  remoteAskFor,
  type RemoteAsk,
  type RemoteAskKind,
  type RemoteChoiceAction,
  type RemoteNotice,
} from '../shared/remote';
import type { AuditLog } from './audit';
import { MirrorStore, type Mirror } from './mirrorStore';
import { redactForDisplay } from './redact';
import type { RemoteClose, RemoteInvocation, RemoteTransport } from './transport';

/** Just enough of the store to reconcile against, so tests need no real one. */
export interface SessionSnapshot {
  readonly sessions: SessionDTO[];
  onDidUpdate(listener: () => void): Disposable;
}

/**
 * Just the three. Narrow on purpose: this may answer prompts, nothing else —
 * it cannot start, stop, adopt or archive anything.
 */
export type PermissionActions = Pick<SessionActions, 'decidePermission' | 'answerQuestion' | 'decidePlan'>;

export interface RemoteConfig {
  enabled: boolean;
  /**
   * The toolbar's Discord button: everything outbound, or nothing. Off silences
   * `notify()` *and* permission mirroring — the button that says "notifications
   * are off" posting permission cards anyway is the one thing it must not do.
   * Anything already published is closed as `cancelled` when it goes off, so
   * the channel is not left holding live buttons nobody is listening for.
   *
   * The prompt itself is untouched: it is still there in Agent Wrangler, and
   * turning the button back on republishes it while it is still open.
   */
  notificationsEnabled: boolean;
  guildId: string;
  channelId: string;
  /** Stable service-side user ids. Empty means nobody, and publishing is refused. */
  authorizedUserIds: string[];
  /** Folded to `~` in anything published. */
  homeDir?: string;
}

/** Ceiling on a published command. `permissionDetail` already capped it at 2000. */
const MAX_BODY_CHARS = 1200;
const MAX_SUMMARY_CHARS = 200;

export class RemoteControlService implements Disposable {
  private transport?: RemoteTransport;
  private subs: Disposable[] = [];
  private transportSubs: Disposable[] = [];
  /**
   * Passes are serialised, and `reconcile()` resolves only once the system has
   * actually converged — callers (and tests) can await it and know the remote
   * surface matches the store. `pending` collapses a burst of store updates
   * into one pass, since a pass that has not started yet will see the newest
   * state anyway.
   */
  private chain: Promise<void> = Promise.resolve();
  private pending?: Promise<void>;
  private disposed = false;
  private warnedNoAllowlist = false;
  private changeEmitter = new Emitter<void>();

  /** Fires when the mirrored set or the connection changes, for a future UI chip. */
  readonly onDidChange = (listener: () => void): Disposable => this.changeEmitter.event(listener);

  constructor(
    private sessions: SessionSnapshot,
    private actions: PermissionActions,
    private mirrors: MirrorStore,
    private config: () => RemoteConfig,
    private audit: AuditLog,
    private log: (message: string) => void = () => undefined,
  ) {
    this.subs.push(this.sessions.onDidUpdate(() => void this.reconcile()));
  }

  get connected(): boolean {
    return this.transport?.connected === true;
  }

  get mirroredCount(): number {
    return this.mirrors.all().length;
  }

  /**
   * Hand over the transport, or take it away.
   *
   * Only the process holding the leader lease ever passes one; every other
   * instance runs this service with none and does nothing, which is what keeps
   * five windows from posting five messages for one prompt.
   */
  setTransport(transport: RemoteTransport | undefined): void {
    for (const s of this.transportSubs) s.dispose();
    this.transportSubs = [];
    this.transport = transport;
    if (transport) {
      this.transportSubs.push(
        transport.onDidInvoke((invocation) => void this.onInvoke(invocation)),
        transport.onDidChangeConnection(() => {
          this.changeEmitter.fire();
          void this.reconcile();
        }),
      );
    }
    this.changeEmitter.fire();
    void this.reconcile();
  }

  /**
   * Make the remote surface match what Agent Wrangler is asking.
   *
   * Cheap and safe to call as often as the store fires: the common case is a
   * set comparison over a handful of sessions and no I/O at all.
   */
  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    // A pass that is queued but not yet running will read the current state
    // when it starts, so it already covers this request.
    if (this.pending) return this.pending;
    const run = this.enqueue(async () => {
      this.pending = undefined;
      if (!this.disposed) await this.pass();
    });
    this.pending = run;
    return run;
  }

  /**
   * Everything that touches the mirror map goes through here, so a press and a
   * reconcile can never interleave halfway through each other's writes. The
   * chain swallows failures rather than breaking, since a broken chain would
   * silently skip every later pass.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(
      () => undefined,
      (err) => this.log(`remote: ${String(err)}`),
    );
    return run;
  }

  /** Resolves once queued work has drained. For shutdown, and for tests. */
  whenIdle(): Promise<void> {
    return this.chain;
  }

  private async pass(): Promise<void> {
    await this.mirrors.load();
    const cfg = this.config();
    const transport = this.transport;

    // Disabled, muted, or nothing to publish through: close anything still
    // showing rather than leaving live buttons behind, then stop.
    if (!cfg.enabled || !cfg.notificationsEnabled || !transport) {
      if (transport) await this.closeAll(transport, 'cancelled');
      return;
    }
    if (!transport.connected) return; // reconnect fires onDidChangeConnection

    // Fail closed: with nobody authorised, a published card is a button that
    // can only ever be refused. Say so once rather than on every pass.
    if (cfg.authorizedUserIds.length === 0) {
      if (!this.warnedNoAllowlist) {
        this.warnedNoAllowlist = true;
        this.log('remote control is enabled but no authorized user ids are set; publishing nothing');
      }
      await this.closeAll(transport, 'cancelled');
      return;
    }
    this.warnedNoAllowlist = false;

    const desired = new Map<string, RemoteAsk>();
    for (const s of this.sessions.sessions) {
      const ask = remoteAskFor(s);
      if (ask) desired.set(ask.askKey, ask);
    }

    // Gone from Agent Wrangler: it was answered, expired, or the session ended.
    for (const mirror of this.mirrors.all()) {
      if (desired.has(mirror.askKey)) continue;
      await this.closeMirror(transport, mirror, this.outcomeFor(mirror));
    }

    // New, or changed while still open.
    for (const [askKey, ask] of desired) {
      const mirror = this.mirrors.get(askKey);
      if (!mirror) await this.publish(transport, ask);
      else if (mirror.renderHash !== renderHash(ask)) await this.update(transport, mirror, ask);
    }
  }

  /**
   * Announce something that has already happened — auto-pause, today.
   *
   * Deliberately not part of `pass()`. A notice is an event, not a state to
   * reconcile towards: the reconciler's whole guarantee is that running it twice
   * changes nothing, and an event re-derived on every pass would post again
   * every time the store ticked. So this is a direct call from whoever knows the
   * thing happened, sent once.
   *
   * It goes through the same queue as everything else so it cannot interleave
   * with a pass, and it does *not* require an authorized-user allowlist: the
   * allowlist governs who may press a button, and there is no button here.
   * Failure is swallowed by the queue — the local dialog already said it, and a
   * dropped Discord message must not stop agents from being paused.
   */
  notify(notice: RemoteNotice): Promise<void> {
    return this.enqueue(async () => {
      const transport = this.transport;
      const cfg = this.config();
      if (this.disposed || !transport) return;
      if (!cfg.enabled || !cfg.notificationsEnabled) {
        this.log(`notice suppressed, notifications off: ${notice.title}`);
        return;
      }
      if (!transport.connected) {
        // No queueing for later: by the time a reconnect lands this is old news.
        this.log(`notice dropped, not connected: ${notice.title}`);
        return;
      }
      this.log(`notice: ${notice.title}`);
      await transport.notify(notice);
    });
  }

  /**
   * A press. Everything about it is foreign input, so it is checked against
   * live Agent Wrangler state — not against what was true when the message was
   * posted, which may be minutes or an agent ago.
   */
  private onInvoke(invocation: RemoteInvocation): Promise<void> {
    return this.enqueue(() => this.applyInvocation(invocation));
  }

  private async applyInvocation(invocation: RemoteInvocation): Promise<void> {
    const cfg = this.config();
    const transport = this.transport;
    if (!transport) return;

    const base = { interactionId: invocation.interactionId, actorId: invocation.actor.id, actorName: invocation.actor.displayName };

    // 1. Scope. Cheapest check, and it runs before anything is looked up.
    if (
      (invocation.scope.guildId !== undefined && invocation.scope.guildId !== cfg.guildId) ||
      (invocation.scope.channelId !== undefined && invocation.scope.channelId !== cfg.channelId)
    ) {
      this.audit.write({ event: 'refused-out-of-scope', ...base });
      this.log(`remote: press from outside the configured guild/channel, ignored`);
      return;
    }

    // 2. Do we know this message?
    await this.mirrors.load();
    const mirror = this.mirrors.byInteractionId(invocation.interactionId);
    if (!mirror) {
      this.audit.write({ event: 'refused-unknown', ...base });
      await transport.reply(invocation, 'Agent Wrangler is no longer tracking that request.');
      return;
    }

    // 3. May this person act? By immutable id — a display name is neither
    //    unique nor permanent, and this is the only thing standing between a
    //    channel member and a permission decision.
    if (!cfg.authorizedUserIds.includes(invocation.actor.id)) {
      this.audit.write({ event: 'refused-unauthorised', askKey: mirror.askKey, sessionKey: mirror.sessionKey, ...base, choiceId: invocation.choiceId });
      this.log(`remote: unauthorised press by ${invocation.actor.id}`);
      await transport.reply(invocation, 'You are not authorised to answer Agent Wrangler prompts.');
      return;
    }

    // 4. Is this still the ask it was posted for? Re-derived now, from the
    //    store, rather than trusted from the message.
    const session = this.sessions.sessions.find((s) => s.key === mirror.sessionKey);
    const ask = session ? remoteAskFor(session) : undefined;
    if (!ask || ask.askKey !== mirror.askKey) {
      this.audit.write({ event: 'refused-stale', askKey: mirror.askKey, sessionKey: mirror.sessionKey, ...base, choiceId: invocation.choiceId });
      await transport.reply(invocation, 'That request has already been answered.');
      await this.closeMirror(transport, mirror, { outcome: 'answered-locally', atMs: Date.now() });
      return;
    }

    // 5. Is the choice one this ask actually offers?
    const choice = ask.choices.find((c) => c.action === invocation.choiceId);
    if (!choice) {
      this.audit.write({ event: 'refused-stale', askKey: ask.askKey, sessionKey: ask.sessionKey, ...base, choiceId: invocation.choiceId });
      await transport.reply(invocation, 'That option is no longer offered for this request.');
      return;
    }

    this.audit.write({ event: 'pressed', askKey: ask.askKey, sessionKey: ask.sessionKey, toolName: ask.toolName, ...base, choiceId: choice.action });

    // 6. Apply it, through the same action the local button uses. The expected
    //    request id is what stops this landing on a newer prompt if one opened
    //    between the checks above and here. Which action depends on the kind:
    //    a permission writes a decision file that any process can honour, a
    //    question and a plan resolve a promise that only this one holds.
    let outcome: PermissionDecisionOutcome;
    try {
      outcome = await this.applyChoice(ask, choice.action);
    } catch (err) {
      this.audit.write({ event: 'apply-failed', askKey: ask.askKey, ...base, detail: String(err) });
      this.log(`remote: applying ${choice.action} failed: ${String(err)}`);
      await transport.reply(invocation, 'Agent Wrangler could not apply that decision.');
      return;
    }

    this.audit.write({ event: 'applied', askKey: ask.askKey, sessionKey: ask.sessionKey, toolName: ask.toolName, ...base, choiceId: choice.action, outcome });

    if (outcome !== 'applied') {
      // Someone got there first, at the machine or in Claude Code's own dialog.
      await transport.reply(invocation, 'That request had already been answered.');
      await this.closeMirror(transport, mirror, { outcome: 'answered-locally', atMs: Date.now() });
      return;
    }

    // Remember who, so the closing message can say it. The close itself is left
    // to the next reconcile, which is driven by Agent Wrangler noticing the ask
    // is gone — the same path a local answer takes.
    await this.mirrors.put({
      ...mirror,
      lastPress: { actor: invocation.actor, choiceId: choice.action, label: choice.label, atMs: Date.now() },
    });
    this.changeEmitter.fire();
  }

  /**
   * Route a pressed choice to the action that settles it.
   *
   * Exhaustive on `kind` on purpose: adding a fourth sort of ask should fail to
   * compile here rather than fall through to a default that silently does the
   * wrong thing with somebody's agent.
   *
   * A question's `opt<n>` is turned back into an answer *here*, from the ask
   * re-read from live state a few lines above — never from the message. That is
   * what makes an index safe to put in a `custom_id`: if the options changed,
   * the index is resolved against the options that exist now, and the
   * staleness checks have already refused anything that moved on.
   */
  private applyChoice(ask: RemoteAsk, action: RemoteChoiceAction): Promise<PermissionDecisionOutcome> {
    switch (ask.kind) {
      case 'permission':
        return this.actions.decidePermission(ask.sessionKey, action as 'allow' | 'deny' | 'always', {
          expectedRequestId: ask.requestId,
        });
      case 'question': {
        const index = Number(action.slice('opt'.length));
        const option = ask.options[index];
        if (!option) return Promise.resolve('stale');
        return this.actions.answerQuestion(ask.sessionKey, ask.requestId, { [ask.question]: option.label });
      }
      case 'plan':
        // Approve only. A rejection with no feedback is a different act from
        // the local button's, so it is not offered — see `planAskFor`.
        return this.actions.decidePlan(ask.sessionKey, ask.requestId, true);
    }
  }

  // ---- mirror operations ----

  private async publish(transport: RemoteTransport, ask: RemoteAsk): Promise<void> {
    const interactionId = randomBytes(16).toString('base64url');
    try {
      const ref = await transport.publish(interactionId, this.redact(ask));
      await this.mirrors.put({
        interactionId,
        askKey: ask.askKey,
        sessionKey: ask.sessionKey,
        requestId: ask.requestId,
        kind: ask.kind,
        ref,
        renderHash: renderHash(ask),
        publishedAtMs: Date.now(),
      });
      this.audit.write({ event: 'published', askKey: ask.askKey, sessionKey: ask.sessionKey, toolName: ask.toolName, interactionId });
      this.changeEmitter.fire();
    } catch (err) {
      // Never retried in a loop: the local prompt is untouched and the agent is
      // not waiting on us. The next store update tries again.
      this.audit.write({ event: 'publish-failed', askKey: ask.askKey, detail: String(err) });
      this.log(`remote: publishing ${ask.askKey} failed: ${String(err)}`);
    }
  }

  private async update(transport: RemoteTransport, mirror: Mirror, ask: RemoteAsk): Promise<void> {
    try {
      await transport.update(mirror.ref, mirror.interactionId, this.redact(ask));
      await this.mirrors.put({ ...mirror, renderHash: renderHash(ask) });
    } catch (err) {
      this.log(`remote: updating ${mirror.askKey} failed: ${String(err)}`);
    }
  }

  private async closeMirror(transport: RemoteTransport, mirror: Mirror, outcome: RemoteClose): Promise<void> {
    // The ask is gone by definition here, so the close is rendered from what
    // the mirror remembers rather than from live state.
    const ask = placeholderAsk(mirror);
    try {
      await transport.close(mirror.ref, ask, outcome);
    } catch (err) {
      this.log(`remote: closing ${mirror.askKey} failed: ${String(err)}`);
      // Fall through: dropping the record anyway is right. A message we cannot
      // edit is one we will never edit, and keeping it would retry forever.
    }
    await this.mirrors.remove(mirror.askKey);
    this.audit.write({
      event: 'closed',
      askKey: mirror.askKey,
      sessionKey: mirror.sessionKey,
      interactionId: mirror.interactionId,
      outcome: outcome.outcome,
      actorId: outcome.by?.id,
      choiceId: outcome.choiceId,
    });
    this.changeEmitter.fire();
  }

  private async closeAll(transport: RemoteTransport, outcome: RemoteClose['outcome']): Promise<void> {
    for (const mirror of this.mirrors.all()) {
      await this.closeMirror(transport, mirror, { outcome, atMs: Date.now() });
    }
  }

  /**
   * How a mirror that has left the desired set should read.
   *
   * A remote press we applied gives the honest answer. Otherwise it was
   * answered at the machine — and the hook path genuinely cannot tell allow
   * from deny after the fact (there is no `PermissionGranted` event), so the
   * message says where it was answered rather than guessing what was chosen.
   */
  private outcomeFor(mirror: Mirror): RemoteClose {
    const press = mirror.lastPress;
    if (!press) return { outcome: 'answered-locally', atMs: Date.now() };
    return {
      outcome: closedOutcomeFor(mirror.kind, press.choiceId),
      label: press.label,
      by: press.actor,
      choiceId: press.choiceId,
      atMs: press.atMs,
    };
  }

  /**
   * Scrub and cap anything on its way out. Applied here so every transport gets
   * it, and switched on `kind` so no member of the union can quietly acquire a
   * text field that skips the scrubber.
   *
   * A question's text and a plan's prose are closer to transcript content than
   * a permission's command ever was, and they go through exactly the same
   * treatment: home folded to `~`, secrets masked, length capped. The cap on a
   * plan is what makes `more` matter — see `planPayload`.
   */
  private redact(ask: RemoteAsk): RemoteAsk {
    const home = this.config().homeDir;
    const short = (s: string): string => redactForDisplay(s, { home, max: MAX_SUMMARY_CHARS });
    const long = (s: string): string => redactForDisplay(s, { home, max: MAX_BODY_CHARS });

    switch (ask.kind) {
      case 'permission': {
        if (!ask.subject) return ask;
        return {
          ...ask,
          subject: {
            ...ask.subject,
            summary: ask.subject.summary === undefined ? undefined : short(ask.subject.summary),
            body: ask.subject.body === undefined ? undefined : long(ask.subject.body),
          },
        };
      }
      case 'question':
        return {
          ...ask,
          question: short(ask.question),
          options: ask.options.map((o) => ({
            label: short(o.label),
            description: o.description === undefined ? undefined : short(o.description),
          })),
        };
      case 'plan': {
        const plan = long(ask.plan);
        return {
          ...ask,
          plan,
          // Whatever the cap took is added to what the block cap already held
          // back, so the card's "+N more" counts every character the reader
          // cannot see rather than only some of them.
          more: (ask.more ?? 0) + Math.max(0, ask.plan.length - plan.length) || undefined,
        };
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.transportSubs) s.dispose();
    for (const s of this.subs) s.dispose();
    this.transportSubs = [];
    this.subs = [];
    this.changeEmitter.dispose();
  }
}

/**
 * How a settled ask should read, given what it was and which button was hit.
 *
 * A permission was allowed or denied; a plan that got its one button was
 * approved; a question was *answered*, and "allowed" would say nothing about
 * what was chosen.
 */
function closedOutcomeFor(kind: RemoteAskKind, choiceId: string): RemoteClose['outcome'] {
  if (kind === 'question') return 'answered';
  if (kind === 'plan') return 'allowed';
  return choiceId === 'deny' ? 'denied' : 'allowed';
}

/** What was rendered, so an unchanged ask is not re-edited after a failover. */
export function renderHash(ask: RemoteAsk): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ask.askKey,
        ask.kind,
        ask.title,
        ask.toolName,
        ask.note ?? '',
        // Everything a card's body is drawn from, per kind. A field missing
        // here is a field whose change never reaches an already-posted message.
        ask.kind === 'permission' ? [ask.subject?.summary ?? '', ask.subject?.body ?? ''] : [],
        ask.kind === 'question' ? [ask.question, ask.options.map((o) => [o.label, o.description ?? ''])] : [],
        ask.kind === 'plan' ? [ask.plan, ask.more ?? 0] : [],
        ask.context,
        ask.choices.map((c) => [c.action, c.label]),
      ]),
    )
    .digest('base64url')
    .slice(0, 16);
}

/**
 * A stand-in for an ask that no longer exists, so a transport can still render
 * the header of the message it is closing. Carries no subject: the command is
 * already in the channel, and re-sending it on the way out adds nothing.
 */
function placeholderAsk(mirror: Mirror): RemoteAsk {
  const base = {
    askKey: mirror.askKey,
    sessionKey: mirror.sessionKey,
    requestId: mirror.requestId,
    title: '',
    toolName: '',
    context: { agent: '' },
    choices: [],
  };
  switch (mirror.kind) {
    case 'question':
      return { ...base, kind: 'question', question: '', options: [], choices: [] };
    case 'plan':
      return { ...base, kind: 'plan', plan: '', choices: [] };
    default:
      return { ...base, kind: 'permission', choices: [] };
  }
}

/**
 * What the control socket (`aw`) can ask of the app, answered from the app's
 * own services, so a command does exactly what the equivalent click does:
 * rows come from the same store as the table, `send` goes to the session's
 * handle the way the pane's composer does, and `stop` is the menu's Stop…
 * without the dialog (`AgentWranglerApp.stopSession`).
 */
import type { SessionHandle, SessionViewEvent } from '../core/session/sessionHandle';
import type { SessionExecutors } from '../core/session/sessionExecutors';
import {
  RPC_AMBIGUOUS,
  RPC_NOT_FOUND,
  RPC_UNSUPPORTED,
  resolveSessionRef,
  type ControlCommandOutcome,
  type ControlLifecycle,
  type ControlPendingView,
  type ControlStatus,
  type ControlRecordView,
  type ControlSession,
  type ControlSessionClosed,
  type ControlSessionResult,
  type ControlStatusResult,
} from '../core/control/protocol';
import { ControlError, type ControlBackend, type ControlSubscription } from '../core/control/server';
import { displayTitle, type AgentSession } from '../shared/model';
import type { AgentWranglerApp } from './createApp';

export interface ControlBackendDeps {
  build: string;
  appPid: number;
  startedAt: number;
  /** One line of feedback in the app when a command changed something, so it never happens unseen. */
  flash?: (message: string) => void;
}

export function createControlBackend(app: AgentWranglerApp, deps: ControlBackendDeps): ControlBackend {
  const row = (s: AgentSession): ControlSession => ({
    key: s.key,
    sessionId: s.sessionId,
    title: displayTitle(s),
    provider: s.provider,
    // A UI status the wire does not list is a type error here, not a silent wire change.
    status: s.status satisfies ControlStatus,
    projectName: s.projectName,
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    worktree: s.worktree,
    model: s.model,
    pid: s.pid,
    lastActivityAt: s.lastActivityAt,
    archived: app.archive.isArchived(s.key),
    runBy: app.runBy(s.sessionId),
    blockedOn: s.status === 'blocked' ? s.blockedReason : undefined,
  });

  /** Any row, archived or not: a command naming an id means that id. */
  const find = (ref: string): AgentSession => {
    const found = resolveSessionRef(app.store.sessions, ref);
    if ('match' in found) return found.match;
    if (found.error === 'ambiguous') {
      throw new ControlError(RPC_AMBIGUOUS, `"${ref}" matches ${found.matches.length} sessions`, {
        matches: found.matches.map((s) => ({ key: s.key, sessionId: s.sessionId, title: displayTitle(s) })),
      });
    }
    throw new ControlError(RPC_NOT_FOUND, `no session matches "${ref}"`);
  };

  const handleFor = (s: AgentSession, what: string): SessionHandle => {
    const handle = app.sessions.get(s.sessionId);
    if (!handle) {
      throw new ControlError(
        RPC_UNSUPPORTED,
        `Agent Wrangler does not run ${displayTitle(s)}, so it cannot ${what} it. Open it in the app and take it over first.`,
      );
    }
    return handle;
  };

  const describe = () => ({ build: deps.build, appPid: deps.appPid, startedAt: deps.startedAt });
  // Pinned: the wire's unions must cover the UI's (see protocol.ts's header).
  const lifecycleOf = (h: SessionHandle | undefined): ControlLifecycle | undefined => h?.lifecycle;

  return {
    describe,

    status(): ControlStatusResult {
      const byStatus: Partial<Record<ControlStatus, number>> = {};
      for (const s of app.store.sessions) {
        if (app.archive.isArchived(s.key)) continue;
        byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      }
      const counts = app.sessionCounts();
      return { ...describe(), byStatus, running: { hosted: counts.hosted, app: counts.local } };
    },

    sessions: ({ all }) => app.store.sessions.filter((s) => all || !app.archive.isArchived(s.key)).map(row),

    session(ref): ControlSessionResult {
      const s = find(ref);
      const handle = app.sessions.get(s.sessionId);
      const r = app.sessionRegistry.get(s.sessionId);
      const record: ControlRecordView | undefined = r && {
        state: r.state,
        endedReason: r.endedReason,
        createdAt: r.createdAt,
        launch: { model: r.launch.model, effort: r.launch.effort, permissionMode: r.launch.permissionMode },
      };
      return { session: row(s), record, lifecycle: lifecycleOf(handle), pending: pendingOf(s, handle) };
    },

    subscribe(ref, maxBlocks, onEvent: (event: SessionViewEvent) => void, onClosed: (reason: ControlSessionClosed['reason']) => void): ControlSubscription {
      const s = find(ref);
      const handle = handleFor(s, 'attach to');
      const snap = handle.snapshot();
      const subs = [
        handle.subscribe(snap.seq, (event) => {
          onEvent(event);
          if (event.type === 'lifecycle' && (event.lifecycle === 'ended' || event.lifecycle === 'error')) onClosed('ended');
        }),
        app.sessions.onDidChange(() => onClosedIfGone(app.sessions, handle, onClosed)),
      ];
      const blocks = maxBlocks > 0 ? snap.blocks.slice(-maxBlocks) : [];
      return {
        result: {
          key: s.key,
          sessionId: snap.sessionId,
          lifecycle: snap.lifecycle satisfies ControlLifecycle,
          blocks,
          truncated: snap.truncated || blocks.length < snap.blocks.length,
        },
        dispose: () => subs.forEach((d) => d.dispose()),
      };
    },

    async send(ref, text) {
      const s = find(ref);
      const handle = handleFor(s, 'send to');
      if (!handle.canSend) {
        return handle.readOnlyReason ? { outcome: 'unsupported', reason: handle.readOnlyReason } : { outcome: 'stale' };
      }
      const outcome: ControlCommandOutcome = await handle.send(text);
      if (outcome === 'applied') deps.flash?.(`aw sent a message to ${displayTitle(s)}`);
      return { outcome };
    },

    async stop(ref, force) {
      const s = find(ref);
      const outcome = await app.stopSession(s.key, { force });
      if (outcome === 'gone') throw new ControlError(RPC_NOT_FOUND, `no session matches "${ref}"`);
      if (outcome === 'stopped') deps.flash?.(`aw stopped ${displayTitle(s)}`);
      return outcome;
    },

    projects: () =>
      app.projects.value.map((p) => ({ dir: p.dir, name: p.name, lastUsedAt: p.lastUsedAt, favourite: p.favourite, occupiedBy: p.occupiedBy })),
  };
}

/**
 * After a change in who runs what: close the subscription as `gone` if the
 * handle is no longer one AW runs (released, closed, taken over elsewhere).
 * Looked up by the handle itself, not the id the attach began with: Claude
 * Code issues a new id on compaction and resume, and the handle follows it.
 * An ended handle is left to its own `lifecycle` event, which says `ended`.
 */
export function onClosedIfGone(
  sessions: Pick<SessionExecutors, 'list'>,
  handle: SessionHandle,
  onClosed: (reason: ControlSessionClosed['reason']) => void,
): void {
  if (handle.lifecycle === 'ended' || handle.lifecycle === 'error') {
    onClosed('ended');
    return;
  }
  if (!sessions.list().includes(handle)) onClosed('gone');
}

/** What it is waiting on the user for, in one line, when anything. */
export function pendingOf(s: AgentSession, handle: SessionHandle | undefined): ControlPendingView | undefined {
  if (handle?.pendingQuestion) {
    const q = handle.pendingQuestion.questions[0];
    return { kind: 'question', summary: q ? q.question : 'a question' };
  }
  if (handle?.pendingPlan) {
    const first = handle.pendingPlan.plan.split('\n').find((l) => l.trim().length > 0) ?? 'a plan';
    return { kind: 'plan', summary: first.replace(/^#+\s*/, '').slice(0, 200) };
  }
  const ask = handle ? [...handle.blocks].reverse().find((b) => b.kind === 'permission' && b.state === 'pending') : undefined;
  if (ask && ask.kind === 'permission') {
    const what = ask.summary ?? ask.body ?? '';
    return { kind: 'permission', summary: `${ask.toolName}${what ? `: ${what.split('\n')[0].slice(0, 200)}` : ''}` };
  }
  if (s.status === 'blocked') return { kind: 'permission', summary: s.blockedReason ?? 'a permission prompt' };
  return undefined;
}

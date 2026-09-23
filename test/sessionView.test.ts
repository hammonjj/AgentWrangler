import { describe, expect, it } from 'vitest';
import { Emitter, type Disposable, type Listener } from '../src/core/events';
import { DecoratedSessions, decorateSession, type SessionSource } from '../src/core/sessionView';
import type { AgentSession } from '../src/shared/model';
import { remoteAskFor } from '../src/shared/remote';

function session(extra: Partial<AgentSession> = {}): AgentSession {
  return {
    provider: 'claude',
    sessionId: 'sess-a',
    key: 'claude:sess-a',
    title: 'a conversation',
    status: 'blocked',
    lastActivityAt: 0,
    pid: 4242,
    blockedReason: 'Bash',
    permissionRequestId: '100-1',
    ...extra,
  };
}

/** A store stand-in: a list, and a way to say it moved. */
class FakeSource implements SessionSource {
  sessions: AgentSession[] = [];
  private emitter = new Emitter<unknown>();
  onDidUpdate = (l: Listener<unknown>): Disposable => this.emitter.event(l);
  fire(): void {
    this.emitter.fire(undefined);
  }
}

class FakeChanges {
  private emitter = new Emitter<void>();
  onDidChange = (l: () => void): Disposable => this.emitter.event(l);
  fire(): void {
    this.emitter.fire();
  }
}

const none = { isArchived: () => false, isPaused: () => false };

function sourceOf(...sessions: AgentSession[]): FakeSource {
  const source = new FakeSource();
  source.sessions = sessions;
  return source;
}

describe('decorateSession', () => {
  it('leaves an undecorated session exactly as it was', () => {
    const s = session();
    expect(decorateSession(s, none)).toBe(s);
  });

  it('sets archived by key and paused by pid', () => {
    const decorated = decorateSession(session(), {
      isArchived: (key) => key === 'claude:sess-a',
      isPaused: (pid) => pid === 4242,
    });
    expect(decorated).toMatchObject({ archived: true, paused: true });
  });

  it('writes undefined rather than false, as the dashboard always has', () => {
    const decorated = decorateSession(session(), { isArchived: () => true, isPaused: () => false });
    expect(decorated.archived).toBe(true);
    expect('paused' in decorated && decorated.paused).toBeFalsy();
    expect(decorated.paused).toBeUndefined();
  });

  it('passes the pid through verbatim, including when there is none', () => {
    // An ended session has no pid. `PauseService.isPaused(undefined)` answers
    // false, and the decorator's job is to ask rather than to guess first.
    const seen: (number | undefined)[] = [];
    decorateSession(session({ pid: undefined }), { isArchived: () => false, isPaused: (pid) => (seen.push(pid), false) });
    expect(seen).toEqual([undefined]);
  });
});

describe('the runner decorations', () => {
  const question = { requestId: 'req_1', questions: [{ question: 'Alpha or Beta?', header: 'Choice', options: [{ label: 'Alpha', description: 'the first' }] }] };
  const plan = { requestId: 'req_2', plan: '# Plan', more: 12 };

  it('carries what this window is parked on, keyed by session id', () => {
    const decorated = decorateSession(session(), {
      ...none,
      runnerOwned: (id) => id === 'sess-a',
      pendingQuestion: (id) => (id === 'sess-a' ? question : undefined),
      pendingPlan: (id) => (id === 'sess-a' ? plan : undefined),
    });
    expect(decorated).toMatchObject({ runnerOwned: true, pendingQuestion: question, pendingPlan: plan });
  });

  it('leaves a session this window does not run completely alone', () => {
    // The store's own sessions are every agent on the machine; only the ones
    // this process runs have an in-process ask to report.
    const s = session({ sessionId: 'somebody-elses' });
    const decorated = decorateSession(s, {
      ...none,
      runnerOwned: (id) => id === 'sess-a',
      pendingQuestion: (id) => (id === 'sess-a' ? question : undefined),
      pendingPlan: () => undefined,
    });
    expect(decorated).toBe(s);
  });

  it('is optional: a consumer that does not care about in-process asks passes none', () => {
    expect(decorateSession(session(), none).pendingPlan).toBeUndefined();
    expect(decorateSession(session(), none).runnerOwned).toBeUndefined();
  });

  it('drops the ask the moment the runner settles it', () => {
    let parked: typeof plan | undefined = plan;
    const source = sourceOf(session());
    const view = new DecoratedSessions(source, { ...none, pendingPlan: () => parked });
    expect(view.sessions[0].pendingPlan).toEqual(plan);
    parked = undefined;
    expect(view.sessions[0].pendingPlan).toBeUndefined();
    view.dispose();
  });
});

describe('DecoratedSessions', () => {
  it('decorates what the source holds, live', () => {
    const source = new FakeSource();
    source.sessions = [session()];
    const archived = new Set<string>();
    const view = new DecoratedSessions(source, { isArchived: (k) => archived.has(k), isPaused: () => false });

    expect(view.sessions[0].archived).toBeUndefined();
    archived.add('claude:sess-a');
    expect(view.sessions[0].archived).toBe(true);
    view.dispose();
  });

  it('fires on the source and on every change source it was given', () => {
    const source = new FakeSource();
    const archive = new FakeChanges();
    const pause = new FakeChanges();
    const view = new DecoratedSessions(source, none, [archive, pause]);

    let fired = 0;
    view.onDidUpdate(() => (fired += 1));
    source.fire();
    archive.fire();
    pause.fire();
    expect(fired).toBe(3);
    view.dispose();
  });

  it('stops firing once disposed', () => {
    const source = new FakeSource();
    const pause = new FakeChanges();
    const view = new DecoratedSessions(source, none, [pause]);
    let fired = 0;
    view.onDidUpdate(() => (fired += 1));
    view.dispose();
    source.fire();
    pause.fire();
    expect(fired).toBe(0);
  });
});

/**
 * The defect this view exists for.
 *
 * `remoteAskFor` skips archived and paused sessions and always has; what it was
 * handed never carried either flag, so the skip never happened. These assert the
 * two halves together — the projection's rule, and the view that makes the rule
 * reachable — because passing either one alone is what the bug looked like.
 */
describe('a paused or archived session presents no remote ask', () => {
  it('mirrors an ordinary blocked session', () => {
    expect(remoteAskFor(decorateSession(session(), none))).toBeDefined();
  });

  it('mirrors nothing once the process is frozen', () => {
    const view = new DecoratedSessions(sourceOf(session()), { isArchived: () => false, isPaused: () => true });
    expect(remoteAskFor(view.sessions[0])).toBeUndefined();
    view.dispose();
  });

  it('mirrors nothing once the row is archived', () => {
    const view = new DecoratedSessions(sourceOf(session()), { isArchived: () => true, isPaused: () => false });
    expect(remoteAskFor(view.sessions[0])).toBeUndefined();
    view.dispose();
  });
});

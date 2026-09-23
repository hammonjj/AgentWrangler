import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Emitter, type Disposable } from '../src/core/events';
import { MemoryAuditLog } from '../src/remote/audit';
import { MirrorStore } from '../src/remote/mirrorStore';
import { RemoteControlService, type RemoteConfig, type SessionSnapshot } from '../src/remote/service';
import type {
  RemoteClose,
  RemoteInvocation,
  RemoteMessageRef,
  RemoteTransport,
} from '../src/remote/transport';
import type { SessionDTO } from '../src/shared/model';
import type { RemoteAsk, RemoteNotice } from '../src/shared/remote';

/** The three write paths, each reporting success and recording nothing. */
function noopActions() {
  return {
    decidePermission: async () => 'applied' as const,
    answerQuestion: async () => 'applied' as const,
    decidePlan: async () => 'applied' as const,
  };
}

/** A transport that records instead of talking to anything. */
class FakeTransport implements RemoteTransport {
  readonly id = 'fake';
  connected = true;
  published: { interactionId: string; ask: RemoteAsk; ref: RemoteMessageRef }[] = [];
  updated: { ref: RemoteMessageRef; ask: RemoteAsk }[] = [];
  closed: { ref: RemoteMessageRef; outcome: RemoteClose }[] = [];
  replies: { invocation: RemoteInvocation; text: string }[] = [];
  notices: RemoteNotice[] = [];
  failPublish = false;
  private seq = 0;
  private invoke = new Emitter<RemoteInvocation>();
  private conn = new Emitter<void>();

  onDidInvoke = (l: (i: RemoteInvocation) => void): Disposable => this.invoke.event(l);
  onDidChangeConnection = (l: () => void): Disposable => this.conn.event(l);
  async connect(): Promise<void> {
    this.connected = true;
    this.conn.fire();
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.conn.fire();
  }
  async publish(interactionId: string, ask: RemoteAsk): Promise<RemoteMessageRef> {
    if (this.failPublish) throw new Error('publish refused');
    const ref = { channelId: 'C1', messageId: `M${this.seq++}` };
    this.published.push({ interactionId, ask, ref });
    return ref;
  }
  async update(ref: RemoteMessageRef, _id: string, ask: RemoteAsk): Promise<void> {
    this.updated.push({ ref, ask });
  }
  async close(ref: RemoteMessageRef, _ask: RemoteAsk, outcome: RemoteClose): Promise<void> {
    this.closed.push({ ref, outcome });
  }
  async reply(invocation: RemoteInvocation, text: string): Promise<void> {
    this.replies.push({ invocation, text });
  }
  async notify(notice: RemoteNotice): Promise<void> {
    this.notices.push(notice);
  }
  dispose(): void {
    this.invoke.dispose();
    this.conn.dispose();
  }

  /**
   * Fire a press. Settling is not this object's to know about: the caller
   * awaits `svc.whenIdle()`, which is the service's own answer to "have you
   * finished with that yet".
   */
  press(choiceId: string, actorId = 'U-allowed', scope: RemoteInvocation['scope'] = { guildId: 'G1', channelId: 'C1' }): void {
    this.pressOn(this.published[this.published.length - 1].interactionId, choiceId, actorId, scope);
  }
  pressOn(interactionId: string, choiceId: string, actorId = 'U-allowed', scope: RemoteInvocation['scope'] = { guildId: 'G1', channelId: 'C1' }): void {
    this.invoke.fire({ interactionId, choiceId, actor: { id: actorId, displayName: 'Tester' }, scope });
  }
}

/** A store we can drive by hand; the shape `RemoteControlService` actually needs. */
function fakeSessions(
  initial: SessionDTO[] = [],
): SessionSnapshot & { set(s: SessionDTO[]): void; setQuietly(s: SessionDTO[]): void } {
  let list = initial;
  const changed = new Emitter<void>();
  return {
    get sessions() {
      return list;
    },
    onDidUpdate: (l: () => void) => changed.event(l),
    set(next: SessionDTO[]) {
      list = next;
      changed.fire();
    },
    /**
     * Change what the store would report without announcing it — the window
     * between a prompt being answered and the provider's next scan firing.
     * A press arriving in that window is the case `refused-stale` exists for.
     */
    setQuietly(next: SessionDTO[]) {
      list = next;
    },
  };
}

function blocked(extra: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-a',
    key: 'claude:sess-a',
    title: 'agent-a',
    status: 'blocked',
    lastActivityAt: 1,
    permissionRequestId: '100-1',
    blockedReason: 'Bash',
    blockedAsk: { summary: 'Run the tests', body: 'npm test', isCommand: true },
    ...extra,
  };
}

/** A session this window runs, parked on a question from its own runner. */
function asking(extra: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-q',
    key: 'claude:sess-q',
    title: 'agent-q',
    status: 'blocked',
    lastActivityAt: 1,
    runnerOwned: true,
    pendingQuestion: {
      requestId: 'req_7',
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          options: [
            { label: 'Postgres', description: 'the boring one' },
            { label: 'SQLite', description: 'the small one' },
          ],
        },
      ] as never,
    },
    ...extra,
  };
}

/** A session this window runs, parked on a plan. */
function planning(extra: Partial<SessionDTO> = {}): SessionDTO {
  return {
    provider: 'claude',
    sessionId: 'sess-p',
    key: 'claude:sess-p',
    title: 'agent-p',
    status: 'blocked',
    lastActivityAt: 1,
    runnerOwned: true,
    pendingPlan: { requestId: 'req_9', plan: '# Plan\n\nrewrite everything' },
    ...extra,
  };
}

const CONFIG: RemoteConfig = {
  enabled: true,
  notificationsEnabled: true,
  guildId: 'G1',
  channelId: 'C1',
  authorizedUserIds: ['U-allowed'],
};

describe('RemoteControlService', () => {
  let dir: string;
  let transport: FakeTransport;
  let audit: MemoryAuditLog;
  let decisions: { key: string; behavior: string; expectedRequestId?: string }[];
  let answersGiven: { key: string; requestId: string; answers: Record<string, string> }[] = [];
  let plansDecided: { key: string; requestId: string; approve: boolean }[] = [];
  let outcome: 'applied' | 'stale' | 'gone' | 'unsupported';
  let cfg: RemoteConfig;

  const build = async (sessions: SessionSnapshot) => {
    const store = new MirrorStore(path.join(dir, 'mirrors.json'));
    const svc = new RemoteControlService(
      sessions,
      {
        decidePermission: async (key, behavior, opts) => {
          decisions.push({ key, behavior, expectedRequestId: opts?.expectedRequestId });
          return outcome;
        },
        answerQuestion: async (key, requestId, answers) => {
          answersGiven.push({ key, requestId, answers });
          return outcome;
        },
        decidePlan: async (key, requestId, approve) => {
          plansDecided.push({ key, requestId, approve });
          return outcome;
        },
      },
      store,
      () => cfg,
      audit,
    );
    svc.setTransport(transport);
    await svc.reconcile();
    return { svc, store };
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-remote-'));
    transport = new FakeTransport();
    audit = new MemoryAuditLog();
    decisions = [];
    answersGiven = [];
    plansDecided = [];
    outcome = 'applied';
    cfg = { ...CONFIG };
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  describe('mirroring', () => {
    it('publishes one message for a blocked session', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      expect(transport.published).toHaveLength(1);
      expect(transport.published[0].ask.toolName).toBe('Bash');
      expect(svc.mirroredCount).toBe(1);
      svc.dispose();
    });

    it('does not republish when nothing material changed', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      sessions.set([blocked({ lastActivityAt: 999 })]); // a poll tick, same ask
      await svc.reconcile();
      expect(transport.published).toHaveLength(1);
      expect(transport.updated).toHaveLength(0);
      svc.dispose();
    });

    it('edits in place when the ask itself changes while still open', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      sessions.set([blocked({ blockedAsk: { summary: 'Run the tests', body: 'npm run test:ci', isCommand: true } })]);
      await svc.reconcile();
      expect(transport.published).toHaveLength(1);
      expect(transport.updated).toHaveLength(1);
      svc.dispose();
    });

    it('mirrors two concurrent asks without crosstalk', async () => {
      const b = blocked({ sessionId: 'sess-b', key: 'claude:sess-b', title: 'agent-b', permissionRequestId: '200-1' });
      const sessions = fakeSessions([blocked(), b]);
      const { svc } = await build(sessions);
      expect(transport.published).toHaveLength(2);

      // Answer only the first; the second must be untouched.
      sessions.set([b]);
      await svc.reconcile();
      expect(transport.closed).toHaveLength(1);
      expect(svc.mirroredCount).toBe(1);
      svc.dispose();
    });

    it('publishes nothing when no session is blocked', async () => {
      const { svc } = await build(fakeSessions([blocked({ status: 'busy', permissionRequestId: undefined })]));
      expect(transport.published).toHaveLength(0);
      svc.dispose();
    });

    it('survives a transport that refuses to publish, and retries next pass', async () => {
      const sessions = fakeSessions([blocked()]);
      transport.failPublish = true;
      const { svc } = await build(sessions);
      expect(transport.published).toHaveLength(0);
      expect(audit.events()).toContain('publish-failed');

      transport.failPublish = false;
      await svc.reconcile();
      expect(transport.published).toHaveLength(1);
      svc.dispose();
    });

    it('redacts the command on the way out', async () => {
      const sessions = fakeSessions([
        blocked({ blockedAsk: { body: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 npm publish', isCommand: true } }),
      ]);
      const { svc } = await build(sessions);
      const posted = transport.published[0].ask;
      expect(posted.kind === 'permission' && posted.subject?.body).not.toContain('ghp_');
      svc.dispose();
    });
  });

  describe('local resolution is reflected remotely', () => {
    it('closes the message when the ask disappears', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      sessions.set([blocked({ status: 'busy', permissionRequestId: undefined })]);
      await svc.reconcile();
      expect(transport.closed).toHaveLength(1);
      expect(transport.closed[0].outcome.outcome).toBe('answered-locally');
      expect(svc.mirroredCount).toBe(0);
      svc.dispose();
    });

    it('says "answered locally" rather than guessing allow or deny', async () => {
      // The hook path cannot observe *which* answer was given after the fact.
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      sessions.set([]);
      await svc.reconcile();
      expect(transport.closed[0].outcome.by).toBeUndefined();
      svc.dispose();
    });
  });

  describe('remote resolution is applied locally', () => {
    it('invokes the same action the dashboard button does, with the request id', async () => {
      const { svc } = await build(fakeSessions([blocked()]));
      transport.press('allow');
      await svc.whenIdle();
      expect(decisions).toEqual([{ key: 'claude:sess-a', behavior: 'allow', expectedRequestId: '100-1' }]);
      svc.dispose();
    });

    it('passes always through unchanged when the ask offers it', async () => {
      const sessions = fakeSessions([blocked({ alwaysAllow: { rules: ['Bash(npm test:*)'], destination: 'session' } })]);
      const { svc } = await build(sessions);
      transport.press('always');
      await svc.whenIdle();
      expect(decisions[0].behavior).toBe('always');
      svc.dispose();
    });

    it('records who pressed, so the close can say so', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      transport.press('allow');
      await svc.whenIdle();
      sessions.set([]); // Agent Wrangler notices it is answered
      await svc.reconcile();
      expect(transport.closed[0].outcome).toMatchObject({ outcome: 'allowed', choiceId: 'allow', by: { id: 'U-allowed' } });
      svc.dispose();
    });

    it('renders a deny as denied', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      transport.press('deny');
      await svc.whenIdle();
      sessions.set([]);
      await svc.reconcile();
      expect(transport.closed[0].outcome.outcome).toBe('denied');
      svc.dispose();
    });

    it('refuses a choice the ask does not offer', async () => {
      // No alwaysAllow on this session, so there is no "always" button.
      const { svc } = await build(fakeSessions([blocked()]));
      transport.press('always');
      await svc.whenIdle();
      expect(decisions).toHaveLength(0);
      expect(transport.replies[0].text).toContain('no longer offered');
      svc.dispose();
    });
  });

  describe('races and stale presses', () => {
    it('cannot answer a newer prompt with an older message', async () => {
      // The hazard: publish A, A is answered locally, B opens on the same
      // session, and the old message is pressed.
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      const staleInteraction = transport.published[0].interactionId;

      sessions.set([blocked({ permissionRequestId: '100-2' })]); // A gone, B open
      await svc.reconcile();
      expect(transport.published).toHaveLength(2);

      transport.pressOn(staleInteraction, 'allow');
      await svc.whenIdle();
      expect(decisions).toHaveLength(0);
      expect(audit.events()).toContain('refused-unknown');
      svc.dispose();
    });

    it('refuses when the session moved on between publish and press', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      const interactionId = transport.published[0].interactionId;
      // The ask changes but no reconcile has run, so the mirror still exists.
      sessions.setQuietly([blocked({ permissionRequestId: '100-9' })]);
      transport.pressOn(interactionId, 'allow');
      await svc.whenIdle();
      expect(decisions).toHaveLength(0);
      expect(audit.events()).toContain('refused-stale');
      expect(transport.replies[0].text).toContain('already been answered');
      svc.dispose();
    });

    it('handles the decision having been made locally a moment earlier', async () => {
      outcome = 'gone'; // decidePermission says there was nothing left to answer
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      transport.press('allow');
      await svc.whenIdle();
      expect(decisions).toHaveLength(1);
      expect(transport.replies[0].text).toContain('already been answered');
      expect(transport.closed).toHaveLength(1);
      svc.dispose();
    });

    it('does not apply twice when the same card is pressed twice', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      const id = transport.published[0].interactionId;
      transport.pressOn(id, 'allow');
      await svc.whenIdle();
      // Agent Wrangler has noticed and the mirror is gone.
      sessions.set([]);
      await svc.reconcile();
      transport.pressOn(id, 'deny');
      await svc.whenIdle();
      expect(decisions).toHaveLength(1);
      svc.dispose();
    });
  });

  describe('authorisation', () => {
    it('refuses an unauthorised presser and changes nothing', async () => {
      const { svc } = await build(fakeSessions([blocked()]));
      transport.press('allow', 'U-stranger');
      await svc.whenIdle();
      expect(decisions).toHaveLength(0);
      expect(transport.closed).toHaveLength(0); // still pending
      expect(transport.replies[0].text).toContain('not authorised');
      expect(audit.events()).toContain('refused-unauthorised');
      svc.dispose();
    });

    it('audits the refusal with who tried', async () => {
      const { svc } = await build(fakeSessions([blocked()]));
      transport.press('allow', 'U-stranger');
      await svc.whenIdle();
      const rec = audit.records.find((r) => r.event === 'refused-unauthorised');
      expect(rec?.actorId).toBe('U-stranger');
      svc.dispose();
    });

    it('ignores a press from another guild or channel', async () => {
      const { svc } = await build(fakeSessions([blocked()]));
      transport.press('allow', 'U-allowed', { guildId: 'G-other', channelId: 'C1' });
      await svc.whenIdle();
      transport.press('allow', 'U-allowed', { guildId: 'G1', channelId: 'C-other' });
      await svc.whenIdle();
      expect(decisions).toHaveLength(0);
      expect(audit.events().filter((e) => e === 'refused-out-of-scope')).toHaveLength(2);
      svc.dispose();
    });

    it('fails closed when nobody is authorised', async () => {
      cfg = { ...CONFIG, authorizedUserIds: [] };
      const { svc } = await build(fakeSessions([blocked()]));
      expect(transport.published).toHaveLength(0);
      svc.dispose();
    });
  });

  describe('being switched off', () => {
    it('closes everything when disabled mid-flight', async () => {
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      cfg = { ...CONFIG, enabled: false };
      await svc.reconcile();
      expect(transport.closed).toHaveLength(1);
      expect(transport.closed[0].outcome.outcome).toBe('cancelled');
      expect(svc.mirroredCount).toBe(0);
      svc.dispose();
    });

    it('does nothing at all with no transport', async () => {
      const store = new MirrorStore(path.join(dir, 'm.json'));
      const svc = new RemoteControlService(fakeSessions([blocked()]), noopActions(), store, () => cfg, audit);
      await svc.reconcile();
      expect(svc.mirroredCount).toBe(0);
      svc.dispose();
    });

    it('publishes nothing while disconnected, then catches up on reconnect', async () => {
      transport.connected = false;
      const sessions = fakeSessions([blocked()]);
      const { svc } = await build(sessions);
      expect(transport.published).toHaveLength(0);

      await transport.connect();
      await svc.reconcile();
      expect(transport.published).toHaveLength(1);
      svc.dispose();
    });
  });

  describe('failover', () => {
    it('a second process closes a message the first one posted', async () => {
      const file = path.join(dir, 'shared.json');
      const sessions = fakeSessions([blocked()]);

      const storeA = new MirrorStore(file);
      const svcA = new RemoteControlService(sessions, noopActions(), storeA, () => cfg, audit);
      svcA.setTransport(transport);
      await svcA.reconcile();
      expect(transport.published).toHaveLength(1);
      const ref = transport.published[0].ref;
      svcA.dispose(); // the window goes away

      // A different process, a fresh transport, the same file on disk.
      const transportB = new FakeTransport();
      const storeB = new MirrorStore(file);
      const sessionsB = fakeSessions([]); // the ask is over by now
      const svcB = new RemoteControlService(sessionsB, noopActions(), storeB, () => cfg, audit);
      svcB.setTransport(transportB);
      await svcB.reconcile();

      expect(transportB.published).toHaveLength(0);
      expect(transportB.closed).toHaveLength(1);
      expect(transportB.closed[0].ref).toEqual(ref);
      svcB.dispose();
      transportB.dispose();
    });

    it('a second process does not republish an ask the first already mirrored', async () => {
      const file = path.join(dir, 'shared.json');
      const sessions = fakeSessions([blocked()]);
      const storeA = new MirrorStore(file);
      const svcA = new RemoteControlService(sessions, noopActions(), storeA, () => cfg, audit);
      svcA.setTransport(transport);
      await svcA.reconcile();
      svcA.dispose();

      const transportB = new FakeTransport();
      const svcB = new RemoteControlService(sessions, noopActions(), new MirrorStore(file), () => cfg, audit);
      svcB.setTransport(transportB);
      await svcB.reconcile();
      expect(transportB.published).toHaveLength(0);
      svcB.dispose();
      transportB.dispose();
    });
  });

  describe('notices', () => {
    const NOTICE = { title: '⏸️ Agents paused — plan usage reached 98%', body: 'Paused 3 agents.', tone: 'warn' } as const;

    it('posts a notice with no buttons and nothing to reconcile', async () => {
      const { svc } = await build(fakeSessions([]));
      await svc.notify(NOTICE);
      expect(transport.notices).toEqual([NOTICE]);
      // A notice is an event, not state: reconciling again must not repeat it.
      await svc.reconcile();
      expect(transport.notices).toHaveLength(1);
      expect(svc.mirroredCount).toBe(0);
      svc.dispose();
    });

    it('sends nothing when remote control is off', async () => {
      const { svc } = await build(fakeSessions([]));
      cfg = { ...cfg, enabled: false };
      await svc.notify(NOTICE);
      expect(transport.notices).toHaveLength(0);
      svc.dispose();
    });

    it('muted posts nothing at all: no notice, and the open cards are closed', async () => {
      const { svc } = await build(fakeSessions([blocked()]));
      await svc.reconcile();
      expect(svc.mirroredCount).toBe(1);

      // Off is off. A button that says notifications are off while permission
      // cards keep arriving reads as broken, so the mute covers them too.
      cfg = { ...cfg, notificationsEnabled: false };
      await svc.notify(NOTICE);
      expect(transport.notices).toHaveLength(0);
      await svc.reconcile();
      expect(svc.mirroredCount).toBe(0);

      // The prompt itself is untouched, so switching back on republishes it.
      cfg = { ...cfg, notificationsEnabled: true };
      await svc.reconcile();
      expect(svc.mirroredCount).toBe(1);
      svc.dispose();
    });

    it('drops the notice rather than queueing it when disconnected', async () => {
      const { svc } = await build(fakeSessions([]));
      await transport.disconnect();
      await svc.notify(NOTICE);
      await transport.connect();
      await svc.whenIdle();
      expect(transport.notices).toHaveLength(0);
      svc.dispose();
    });

    it('still posts with an empty allowlist: there is no button to authorise', async () => {
      const { svc } = await build(fakeSessions([]));
      cfg = { ...cfg, authorizedUserIds: [] };
      await svc.notify(NOTICE);
      expect(transport.notices).toHaveLength(1);
      svc.dispose();
    });
  });
});

describe('RemoteControlService, questions and plans', () => {
  let dir: string;
  let transport: FakeTransport;
  let audit: MemoryAuditLog;
  let cfg: RemoteConfig;
  let answers: { key: string; requestId: string; answers: Record<string, string> }[];
  let plans: { key: string; requestId: string; approve: boolean }[];
  let outcome: 'applied' | 'stale' | 'gone' | 'unsupported';

  const build = async (sessions: SessionSnapshot) => {
    const svc = new RemoteControlService(
      sessions,
      {
        decidePermission: async () => outcome,
        answerQuestion: async (key, requestId, given) => {
          answers.push({ key, requestId, answers: given });
          return outcome;
        },
        decidePlan: async (key, requestId, approve) => {
          plans.push({ key, requestId, approve });
          return outcome;
        },
      },
      new MirrorStore(path.join(dir, 'mirrors.json')),
      () => cfg,
      audit,
    );
    svc.setTransport(transport);
    await svc.reconcile();
    return svc;
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-remote-qp-'));
    transport = new FakeTransport();
    audit = new MemoryAuditLog();
    cfg = { ...CONFIG };
    answers = [];
    plans = [];
    outcome = 'applied';
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('turns a pressed option back into the answer the local form would post', async () => {
    const svc = await build(fakeSessions([asking()]));
    expect(transport.published).toHaveLength(1);
    transport.press('opt1');
    await svc.whenIdle();
    expect(answers).toEqual([
      { key: 'claude:sess-q', requestId: 'req_7', answers: { 'Which database?': 'SQLite' } },
    ]);
    svc.dispose();
  });

  it('resolves the index against live state, not against the message', async () => {
    // The custom_id carries an index because the options it indexes are re-read
    // at press time. If they changed, the staleness checks refuse it first.
    const sessions = fakeSessions([asking()]);
    const svc = await build(sessions);
    sessions.set([asking({ pendingQuestion: { requestId: 'req_8', questions: asking().pendingQuestion!.questions } })]);
    await svc.reconcile();
    transport.pressOn(transport.published[0].interactionId, 'opt0');
    await svc.whenIdle();
    expect(answers).toEqual([]);
    expect(audit.records.some((r) => r.event === 'refused-unknown' || r.event === 'refused-stale')).toBe(true);
    svc.dispose();
  });

  it('refuses an option index the question does not have', async () => {
    const svc = await build(fakeSessions([asking()]));
    transport.press('opt4');
    await svc.whenIdle();
    expect(answers).toEqual([]);
    svc.dispose();
  });

  it('closes a question saying what was chosen, not that it was allowed', async () => {
    const sessions = fakeSessions([asking()]);
    const svc = await build(sessions);
    transport.press('opt0');
    await svc.whenIdle();
    sessions.set([asking({ pendingQuestion: undefined })]); // the runner settled it
    await svc.reconcile();
    expect(transport.closed[0].outcome).toMatchObject({ outcome: 'answered', label: 'Postgres' });
    svc.dispose();
  });

  it('approves a plan, and never rejects one', async () => {
    const svc = await build(fakeSessions([planning()]));
    expect(transport.published[0].ask.kind).toBe('plan');
    expect(transport.published[0].ask.choices.map((c) => c.action)).toEqual(['approve']);
    transport.press('approve');
    await svc.whenIdle();
    expect(plans).toEqual([{ key: 'claude:sess-p', requestId: 'req_9', approve: true }]);
    svc.dispose();
  });

  it('mirrors a question and a plan on two sessions without crosstalk', async () => {
    const svc = await build(fakeSessions([asking(), planning()]));
    expect(transport.published).toHaveLength(2);
    transport.pressOn(transport.published[0].interactionId, 'opt0');
    await svc.whenIdle();
    expect(answers).toHaveLength(1);
    expect(plans).toHaveLength(0);
    svc.dispose();
  });

  it('publishes an unbuttonable question with no components at all', async () => {
    const multi = asking({
      pendingQuestion: {
        requestId: 'req_7',
        questions: [{ question: 'Which?', header: 'H', multiSelect: true, options: [{ label: 'A' }] }] as never,
      },
    });
    const svc = await build(fakeSessions([multi]));
    expect(transport.published[0].ask.choices).toEqual([]);
    expect(transport.published[0].ask.note).toMatch(/Agent Wrangler/);
    svc.dispose();
  });

  it('redacts a question and a plan on the way out, as it does a command', async () => {
    const leaky = planning({
      pendingPlan: { requestId: 'req_9', plan: 'token GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345 then deploy' },
    });
    const svc = await build(fakeSessions([leaky]));
    const posted = transport.published[0].ask;
    expect(posted.kind === 'plan' && posted.plan).not.toContain('ghp_');
    svc.dispose();
  });
});

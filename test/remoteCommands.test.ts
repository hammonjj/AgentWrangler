import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../src/remote/audit';
import { RemoteCommandService } from '../src/remote/commandService';
import { createCommandRegistry, formatStatusReply, formatUsageReply, type CommandCapabilities } from '../src/remote/commands';
import type { RemoteConfig } from '../src/remote/service';
import type { RemoteCommandInvocation, RemoteTransport } from '../src/remote/transport';
import { authorize } from '../src/core/access';
import type { UsageState } from '../src/shared/usage';

const NOW = 1_800_000_000_000;

function caps(over: Partial<CommandCapabilities> = {}): CommandCapabilities & { notifications: boolean } {
  const state = { notifications: false };
  return Object.assign(state, {
    usage: () => ({ claude: { error: { kind: 'no-credentials', atMs: NOW } } as UsageState }),
    statusCounts: () => ({}),
    waitingAsks: () => ({ permissions: 0, questions: 0, plans: 0 }),
    notificationsEnabled: () => state.notifications,
    setNotificationsEnabled: async (on: boolean) => {
      state.notifications = on;
    },
    now: () => NOW,
    ...over,
  });
}

const CFG: RemoteConfig = { enabled: true, notificationsEnabled: false, guildId: 'g1', channelId: 'c1', authorizedUserIds: ['u1'] };

function fakeTransport() {
  const replies: string[] = [];
  const t = {
    replyToCommand: async (_inv: RemoteCommandInvocation, text: string) => void replies.push(text),
  } as unknown as RemoteTransport;
  return { t, replies };
}

const inv = (name: string, over: Partial<RemoteCommandInvocation> = {}): RemoteCommandInvocation => ({
  invocationId: 'i1',
  name,
  actor: { id: 'u1', displayName: 'Owner' },
  scope: { guildId: 'g1', channelId: 'c1' },
  ...over,
});

describe('remote command registry (#59)', () => {
  it('lists every command, help included, with Discord-legal names', () => {
    const reg = createCommandRegistry(caps());
    const names = reg.list().map((c) => c.name);
    expect(names).toEqual(['status', 'usage', 'enable-notifications', 'disable-notifications', 'help']);
    for (const c of reg.list()) {
      expect(c.name).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('/help names every command', async () => {
    const reg = createCommandRegistry(caps());
    const help = await reg.get('help')!.run();
    for (const c of reg.list()) expect(help).toContain(`/${c.name}`);
  });

  it('turns notifications on and off, and says when nothing changed', async () => {
    const c = caps();
    const reg = createCommandRegistry(c);
    expect(await reg.get('enable-notifications')!.run()).toMatch(/are on/);
    expect(c.notifications).toBe(true);
    expect(await reg.get('enable-notifications')!.run()).toMatch(/already on/);
    expect(await reg.get('disable-notifications')!.run()).toMatch(/are off/);
    expect(c.notifications).toBe(false);
  });
});

describe('remote command replies', () => {
  it('/status is counts only', () => {
    const text = formatStatusReply(true, { permissions: 2, questions: 1, plans: 0 }, { blocked: 2, busy: 3, done: 1 });
    expect(text).toBe(
      ['Notifications: on.', 'Waiting on you: 2 permission prompts, 1 question.', 'Agents: 2 waiting on a prompt, 3 working, 1 done.'].join('\n'),
    );
    expect(formatStatusReply(false, { permissions: 0, questions: 0, plans: 0 }, {})).toBe(
      ['Notifications: off.', 'Nothing is waiting on you.', 'No agents in the table.'].join('\n'),
    );
  });

  it('/usage gives each window with its reset and the reading\'s age, or why there is none', () => {
    const claude: UsageState = {
      last: {
        fetchedAtMs: NOW - 120_000,
        windows: [
          { id: 'session', label: 'Session', percent: 54.4, resetsAtMs: NOW + 90 * 60_000, active: true },
          { id: 'weekly_all', label: 'Weekly (all models)', percent: 12, active: true },
        ],
        spendKnown: false,
      } as never,
    };
    const text = formatUsageReply({ claude, codex: { error: { kind: 'network', atMs: NOW } } }, NOW);
    expect(text).toContain('Claude (read 2 min ago):');
    expect(text).toContain('  Session: 54%, resets in 1 h 30 min');
    expect(text).toContain('  Weekly (all models): 12%');
    expect(text).toMatch(/^Codex: Could not reach Claude/m);
  });
});

describe('remote command service', () => {
  function service(audit: AuditRecord[], over: Partial<RemoteConfig> = {}, policy = authorize) {
    const c = caps();
    return { c, svc: new RemoteCommandService(createCommandRegistry(c), () => ({ ...CFG, ...over }), { write: (r) => void audit.push(r) }, () => undefined, policy) };
  }

  it('runs a command for an authorised user in scope, privately, and audits it', async () => {
    const audit: AuditRecord[] = [];
    const { c, svc } = service(audit);
    const { t, replies } = fakeTransport();
    // Works while notifications are off: that is what this command is for.
    await svc.run(t, inv('enable-notifications'));
    expect(c.notifications).toBe(true);
    expect(replies).toEqual(['Notifications are on. Anything still waiting is posted again.']);
    expect(audit).toMatchObject([{ event: 'command', detail: 'enable-notifications', via: 'discord', action: 'settings.write', actorId: 'u1' }]);
  });

  it('refuses, privately and audited, a user not on the allowlist, and changes nothing', async () => {
    const audit: AuditRecord[] = [];
    const { c, svc } = service(audit);
    const { t, replies } = fakeTransport();
    await svc.run(t, inv('enable-notifications', { actor: { id: 'stranger', displayName: 'x' } }));
    expect(c.notifications).toBe(false);
    expect(replies[0]).toMatch(/not authorised/);
    expect(audit[0]).toMatchObject({ event: 'refused-unauthorised', actorId: 'stranger' });
  });

  it('refuses one from another guild or channel', async () => {
    const audit: AuditRecord[] = [];
    const { svc } = service(audit);
    const { t, replies } = fakeTransport();
    await svc.run(t, inv('status', { scope: { guildId: 'other', channelId: 'c1' } }));
    expect(replies[0]).toMatch(/own channel/);
    expect(audit[0]).toMatchObject({ event: 'refused-out-of-scope' });
  });

  it('refuses when the access policy does, and answers an unknown command', async () => {
    const audit: AuditRecord[] = [];
    const { c, svc } = service(audit, {}, () => 'deny');
    const { t, replies } = fakeTransport();
    await svc.run(t, inv('enable-notifications'));
    expect(c.notifications).toBe(false);
    expect(audit[0]).toMatchObject({ event: 'refused-unauthorised', action: 'settings.write' });
    await service(audit).svc.run(t, inv('nope'));
    expect(replies.at(-1)).toMatch(/does not know/);
  });

  it('offers its commands to a transport that has them', () => {
    const audit: AuditRecord[] = [];
    const { svc } = service(audit);
    let offered: string[] = [];
    const t = { setCommands: (c: { name: string }[]) => (offered = c.map((x) => x.name)), onDidCommand: () => ({ dispose() {} }) } as unknown as RemoteTransport;
    svc.setTransport(t);
    expect(offered).toContain('usage');
    svc.dispose();
  });
});

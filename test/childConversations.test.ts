/**
 * Child conversations (#198): the pure rules. Who may act on which child
 * (`authorize` with an agent principal), the origin that carries the parent
 * link, nesting rows under their parent, worktree naming, what `aw child done`
 * may do, and `aw child`'s command line. Synthetic paths only.
 */
import { describe, expect, it } from 'vitest';
import { agentContext, authorize, createAccessGate, ownerContext, type ActionName, type ResourceRef } from '../src/core/access';
import { childBranch, childSlug, childWorktreePath, doneDecision, pickDefaultBranch, uniqueSlug } from '../src/core/childWorktree';
import { autoResumeCandidate } from '../src/core/session/recovery';
import type { SessionRecord } from '../src/core/session/sessionRegistry';
import { createControlBackend } from '../src/app/controlBackend';
import type { AgentWranglerApp } from '../src/app/createApp';
import { ControlError } from '../src/core/control/server';
import { RPC_UNAUTHORIZED } from '../src/core/control/protocol';
import { agentShellRefusal, parseArgs } from '../src/cli/args';
import { formatChildDone, formatChildList, formatChildSpawn } from '../src/cli/format';
import {
  CHILD_CONVERSATION_GUIDANCE,
  childCallerDecision,
  childInstructions,
  childNeedsYou,
  childOrigin,
  nestChildren,
  parseChildOrigin,
  withChildGuidance,
} from '../src/shared/childConversations';
import { agentIdOfOrigin, agentOrigin, agentView, createAgent } from '../src/shared/durableAgents';
import { CONVERSATION_DELEGATION_INSTRUCTIONS } from '../src/shared/conversationDelegation';

const ORIGIN = childOrigin({
  agentId: 'agent-a',
  childId: 'fix-login-test',
  parent: { provider: 'claude', sessionId: 'parent-0001' },
  worktree: '/Users/test/proj-child-fix-login-test',
  branch: 'child/fix-login-test',
  repo: '/Users/test/proj',
});

describe('authorize: an agent acts on its own children only', () => {
  const as = (agentId: string) => agentContext(agentId);
  const child = (agentId?: string): ResourceRef => ({ kind: 'session', id: 'claude:kid-1', ...(agentId ? { agentId } : {}) });
  const acts: ActionName[] = ['child.send', 'child.read', 'child.stop', 'child.done'];

  it.each(acts)('%s on its own child: allowed', (action) => {
    expect(authorize(as('agent-a'), action, child('agent-a'))).toBe('allow');
  });

  it.each(acts)("%s on another agent's child: refused", (action) => {
    expect(authorize(as('agent-a'), action, child('agent-b'))).toBe('deny');
  });

  it.each(acts)('%s on a session that is no child: refused', (action) => {
    expect(authorize(as('agent-a'), action, child())).toBe('deny');
  });

  it.each(acts)('%s with no resource, or a non-session one: refused', (action) => {
    expect(authorize(as('agent-a'), action, undefined)).toBe('deny');
    expect(authorize(as('agent-a'), action, { kind: 'mission', id: 'm1', agentId: 'agent-a' })).toBe('deny');
  });

  it('spawn and the list name the agent itself, and only itself', () => {
    expect(authorize(as('agent-a'), 'child.spawn', { kind: 'agent', id: 'agent-a' })).toBe('allow');
    expect(authorize(as('agent-a'), 'child.read', { kind: 'agent', id: 'agent-a' })).toBe('allow');
    expect(authorize(as('agent-a'), 'child.spawn', { kind: 'agent', id: 'agent-b' })).toBe('deny');
    // Spawning "into" a session is not a thing.
    expect(authorize(as('agent-a'), 'child.spawn', child('agent-a'))).toBe('deny');
    expect(authorize(as('agent-a'), 'child.send', { kind: 'agent', id: 'agent-a' })).toBe('deny');
  });

  it('an agent principal still cannot send to or stop sessions the ordinary way', () => {
    expect(authorize(as('agent-a'), 'session.send', child('agent-a'))).toBe('deny');
    expect(authorize(as('agent-a'), 'session.close', child('agent-a'))).toBe('deny');
    expect(authorize(as('agent-a'), 'view.read')).toBe('allow');
  });

  it('a forged agent principal is refused', () => {
    const forged = { principal: { id: 'agent:agent-b', kind: 'agent', agentId: 'agent-a' }, via: 'cli' } as unknown as Parameters<typeof authorize>[0];
    expect(authorize(forged, 'child.send', child('agent-a'))).toBe('deny');
  });

  it('the owner may (it is the single-user policy)', () => {
    expect(authorize(ownerContext('cli'), 'child.done', child('agent-b'))).toBe('allow');
  });

  it("the audit names the child's owner, ids only", () => {
    const lines: unknown[] = [];
    const gate = createAccessGate({ audit: { write: (r) => lines.push(r) } });
    expect(gate.admit(as('agent-a'), 'child.stop', child('agent-b'))).toBe(false);
    expect(lines).toEqual([{ event: 'refused-unauthorised', principal: 'agent:agent-a', via: 'cli', action: 'child.stop', resource: { kind: 'session', id: 'claude:kid-1', agentId: 'agent-b' } }]);
  });
});

describe('who is calling', () => {
  it("an agent's conversation may act as that agent", () => {
    expect(childCallerDecision('agent-a', agentOrigin('agent-a'))).toEqual({ agentId: 'agent-a' });
  });
  it('a conversation that is no agent\'s is refused', () => {
    expect(childCallerDecision(undefined, undefined)).toMatchObject({ refused: 'not-an-agent' });
  });
  it('a child is refused, even if it were somehow held by an agent: one level only', () => {
    expect(childCallerDecision(undefined, ORIGIN)).toMatchObject({ refused: 'child' });
    expect(childCallerDecision('agent-a', ORIGIN)).toMatchObject({ refused: 'child' });
  });
});

describe('control backend: the scope is enforced server-side, through the real authorize', () => {
  function backendWith(target: { agentId?: string }) {
    const ran: string[] = [];
    const entry = target.agentId ? { key: 'claude:kid-1', provider: 'claude', sessionId: 'kid-1', origin: { ...ORIGIN, agentId: target.agentId } } : undefined;
    const app = {
      children: {
        callerOf: () => ({ agent: { id: 'agent-a', name: 'Synthetic PO' } }),
        resolve: () => ({ key: 'claude:kid-1', ...(entry ? { entry } : {}) }),
        view: () => ({}),
        send: async () => {
          ran.push('send');
          return { outcome: 'applied' };
        },
        stop: async () => {
          ran.push('stop');
          return 'stopped';
        },
        done: async () => {
          ran.push('done');
          return { outcome: 'done', message: 'ok' };
        },
      },
    } as unknown as AgentWranglerApp;
    return { backend: createControlBackend(app, { build: 't', appPid: 1, startedAt: 0, gate: createAccessGate() }), ran };
  }
  const origin = { provider: 'claude' as const, sessionId: 'parent-0001' };
  const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ControlError ? e.code : 'other'));

  it('its own child: send, stop and done run', async () => {
    const r = backendWith({ agentId: 'agent-a' });
    await r.backend.childSend({ origin, ref: 'kid', text: 'go' });
    await r.backend.childStop({ origin, ref: 'kid' });
    await r.backend.childDone({ origin, ref: 'kid' });
    expect(r.ran).toEqual(['send', 'stop', 'done']);
  });

  it("another agent's child, or a session that is no child: refused, nothing ran", async () => {
    for (const target of [{ agentId: 'agent-b' }, {}]) {
      const r = backendWith(target);
      expect(await code(r.backend.childSend({ origin, ref: 'kid', text: 'go' }))).toBe(RPC_UNAUTHORIZED);
      expect(await code(r.backend.childStop({ origin, ref: 'kid' }))).toBe(RPC_UNAUTHORIZED);
      expect(await code(r.backend.childDone({ origin, ref: 'kid' }))).toBe(RPC_UNAUTHORIZED);
      expect(() => r.backend.childRead({ origin, ref: 'kid' })).toThrow(ControlError);
      expect(r.ran).toEqual([]);
    }
  });

  it('a caller that is a child or no agent is refused before anything resolves', async () => {
    const app = {
      children: {
        callerOf: () => ({ refused: 'child', message: 'one level only' }),
        resolve: () => {
          throw new Error('must not resolve');
        },
      },
    } as unknown as AgentWranglerApp;
    const backend = createControlBackend(app, { build: 't', appPid: 1, startedAt: 0, gate: createAccessGate() });
    expect(await code(backend.childSpawn({ origin, prompt: 'x' }))).toBe(RPC_UNAUTHORIZED);
    expect(await code(backend.childSend({ origin, ref: 'kid', text: 'x' }))).toBe(RPC_UNAUTHORIZED);
  });
});

describe('the child origin', () => {
  it('round-trips, and is never an agent origin', () => {
    expect(parseChildOrigin(JSON.parse(JSON.stringify(ORIGIN)))).toEqual(ORIGIN);
    // durableAgents.follow() adopts agent origins; a child must not be one.
    expect(agentIdOfOrigin(ORIGIN)).toBeUndefined();
    expect(parseChildOrigin(agentOrigin('agent-a'))).toBeUndefined();
  });

  it('a torn or foreign origin is not a child', () => {
    expect(parseChildOrigin(undefined)).toBeUndefined();
    expect(parseChildOrigin({ kind: 'orchestration', missionId: 'm' })).toBeUndefined();
    expect(parseChildOrigin({ ...ORIGIN, agentId: '' })).toBeUndefined();
    expect(parseChildOrigin({ ...ORIGIN, parent: { provider: 'gpt', sessionId: 'x' } })).toBeUndefined();
    const { branch: _branch, ...noBranch } = ORIGIN;
    expect(parseChildOrigin(noBranch)).toBeUndefined();
  });

  it('a child interrupted by a restart comes back like any session (not excluded like orchestration)', () => {
    const rec = (sessionId: string, origin: unknown): SessionRecord =>
      ({ v: 1, sessionId, provider: 'claude', cwd: '/Users/test/proj', launch: {}, origin, state: 'interrupted', createdAt: 0, lastShownAt: 1000, updatedAt: 1000 }) as SessionRecord;
    expect(autoResumeCandidate([rec('kid', ORIGIN)], 2000)?.sessionId).toBe('kid');
    expect(autoResumeCandidate([rec('m', { kind: 'orchestration' }), rec('kid', ORIGIN)], 2000)?.sessionId).toBe('kid');
  });
});

describe('nesting rows under their parent', () => {
  const row = (key: string, parentKey?: string, status: 'busy' | 'blocked' | 'done' = 'busy') => ({ key, status, ...(parentKey !== undefined ? { childOf: { parentKey } } : {}) });

  it('children go under their parent; everything else stays top level, in order', () => {
    const rows = [row('p'), row('k1', 'p'), row('x'), row('k2', 'p')];
    const { top, children } = nestChildren(rows);
    expect(top.map((r) => r.key)).toEqual(['p', 'x']);
    expect(children.get('p')?.map((r) => r.key)).toEqual(['k1', 'k2']);
  });

  it('a child whose parent is not shown is an ordinary row', () => {
    const { top, children } = nestChildren([row('k1', 'gone'), row('k2')]);
    expect(top.map((r) => r.key)).toEqual(['k1', 'k2']);
    expect(children.size).toBe(0);
  });

  it('a child with no parent key (the agent has no current conversation) is an ordinary row', () => {
    const { top } = nestChildren([{ key: 'k1', childOf: {} }]);
    expect(top.map((r) => r.key)).toEqual(['k1']);
  });

  it('never nests under another child, nor under itself: one level only', () => {
    const { top, children } = nestChildren([row('p'), row('k1', 'p'), row('k2', 'k1'), row('k3', 'k3')]);
    expect(children.get('p')?.map((r) => r.key)).toEqual(['k1']);
    expect(top.map((r) => r.key)).toEqual(['p', 'k2', 'k3']);
  });

  it('a child needs you while it waits on a permission, a question or a plan', () => {
    expect(childNeedsYou([row('a'), row('b', 'p', 'done')])).toBe(false);
    expect(childNeedsYou([row('a'), row('b', 'p', 'blocked')])).toBe(true);
    expect(childNeedsYou([{ status: 'waiting', pendingQuestion: { requestId: 'r' } }])).toBe(true);
    expect(childNeedsYou([{ status: 'waiting', pendingPlan: { requestId: 'r' } }])).toBe(true);
  });
});

describe('worktree naming', () => {
  it('a slug from a name or a prompt', () => {
    expect(childSlug('Fix the flaky login test, then report back on it please')).toBe('fix-the-flaky-login-test-then');
    expect(childSlug('Café crème!')).toBe('cafe-creme');
    expect(childSlug('!!!')).toBe('child');
    expect(childSlug('a'.repeat(80)).length).toBeLessThanOrEqual(40);
  });

  it('a sibling directory and a child/ branch, never the mission layout', () => {
    expect(childWorktreePath('/Users/test/proj', 'fix-login')).toBe('/Users/test/proj-child-fix-login');
    expect(childWorktreePath('/Users/test/proj/', 'fix-login')).toBe('/Users/test/proj-child-fix-login');
    expect(childBranch('fix-login')).toBe('child/fix-login');
    expect(childWorktreePath('/Users/test/proj', 'x')).not.toContain('.aw/');
  });

  it('the first free slug', () => {
    expect(uniqueSlug('fix', () => false)).toBe('fix');
    const taken = new Set(['fix', 'fix-2']);
    expect(uniqueSlug('fix', (s) => taken.has(s))).toBe('fix-3');
    expect(uniqueSlug('fix', () => true, 3)).toBeUndefined();
  });

  it('the default branch: origin HEAD when local, else main, else master', () => {
    expect(pickDefaultBranch('origin/develop\n', ['develop', 'main'])).toBe('develop');
    expect(pickDefaultBranch('origin/develop', ['main'])).toBe('main');
    expect(pickDefaultBranch(undefined, ['master', 'feat/x'])).toBe('master');
    expect(pickDefaultBranch(undefined, ['feat/x'])).toBeUndefined();
  });
});

describe('aw child done: what it may do', () => {
  const base = { registered: true, dirty: [] as string[], merged: true as boolean | undefined, working: false, discard: false, defaultBranch: 'main', branch: 'child/fix' };

  it('merged and clean: removes the tree and deletes the branch', () => {
    expect(doneDecision(base)).toEqual({ ok: true, clean: false, deleteBranch: true });
  });

  it('refuses dirty, unmerged, unknown or working, saying why', () => {
    expect(doneDecision({ ...base, dirty: ['a.ts'] })).toMatchObject({ ok: false, reasons: [expect.stringContaining('a.ts')] });
    expect(doneDecision({ ...base, merged: false })).toMatchObject({ ok: false, reasons: [expect.stringContaining('not in main')] });
    expect(doneDecision({ ...base, merged: undefined })).toMatchObject({ ok: false });
    expect(doneDecision({ ...base, working: true })).toMatchObject({ ok: false, reasons: [expect.stringContaining('still working')] });
  });

  it('--discard goes ahead: cleans a dirty tree first, and keeps an unmerged branch', () => {
    expect(doneDecision({ ...base, dirty: ['a.ts'], merged: false, working: true, discard: true })).toEqual({ ok: true, clean: true, deleteBranch: false });
  });

  it('a worktree already gone is not dirty', () => {
    expect(doneDecision({ ...base, registered: false, dirty: [] })).toEqual({ ok: true, clean: false, deleteBranch: true });
  });
});

describe('aw child: the command line', () => {
  it('spawn: options anywhere, the rest is the prompt', () => {
    expect(parseArgs(['child', 'spawn', '--codex', 'Fix', 'the', 'test', '--name', 'login', '--folder', '/Users/test/proj'])).toEqual({ kind: 'childSpawn', prompt: 'Fix the test', provider: 'codex', name: 'login', folder: '/Users/test/proj', json: false });
    expect(parseArgs(['child', 'spawn', '-'])).toEqual({ kind: 'childSpawn', prompt: undefined, json: false });
    expect(parseArgs(['child', 'spawn', '--', '--name', 'is', 'text'])).toMatchObject({ prompt: '--name is text' });
    expect(parseArgs(['child', 'spawn', '--claude', '--codex', 'x'])).toHaveProperty('error');
    expect(parseArgs(['child', 'spawn'])).toHaveProperty('error');
    expect(parseArgs(['child', 'spawn', '--name'])).toHaveProperty('error');
  });

  it('send takes everything after the id, flags included', () => {
    expect(parseArgs(['child', 'send', 'fix', 'use', '--force', 'carefully'])).toEqual({ kind: 'childSend', ref: 'fix', text: 'use --force carefully' });
    expect(parseArgs(['child', 'send', 'fix', '-'])).toEqual({ kind: 'childSend', ref: 'fix', text: undefined });
    expect(parseArgs(['child', 'send', 'fix'])).toHaveProperty('error');
  });

  it('list, read, stop, done', () => {
    expect(parseArgs(['child', 'list'])).toEqual({ kind: 'childList', json: false });
    expect(parseArgs(['child', 'list', '--json'])).toEqual({ kind: 'childList', json: true });
    expect(parseArgs(['child', 'read', 'fix', '--last', '5'])).toEqual({ kind: 'childRead', ref: 'fix', last: 5, json: false });
    expect(parseArgs(['child', 'read', 'fix', '--last', '0'])).toHaveProperty('error');
    expect(parseArgs(['child', 'stop', 'fix', '--force'])).toEqual({ kind: 'childStop', ref: 'fix', force: true });
    expect(parseArgs(['child', 'done', 'fix', '--discard'])).toEqual({ kind: 'childDone', ref: 'fix', discard: true, json: false });
    expect(parseArgs(['child', 'done'])).toHaveProperty('error');
    expect(parseArgs(['child', 'done', 'a', 'b'])).toHaveProperty('error');
    expect(parseArgs(['child', 'stop', 'fix', '--discard'])).toHaveProperty('error');
    expect(parseArgs(['child', 'list', '--last', '3'])).toHaveProperty('error');
    expect(parseArgs(['child', 'frobnicate'])).toHaveProperty('error');
    expect(parseArgs(['child'])).toHaveProperty('error');
  });

  it('is not refused in an agent shell: the core scopes it instead', () => {
    for (const argv of [['child', 'spawn', 'x'], ['child', 'send', 'k', 'x'], ['child', 'stop', 'k'], ['child', 'done', 'k']]) {
      const cmd = parseArgs(argv);
      if ('error' in cmd) throw new Error(cmd.error);
      expect(agentShellRefusal(cmd, 'a Claude Code session')).toBeUndefined();
    }
    // The ordinary send and stop still are.
    const send = parseArgs(['send', 'k', 'x']);
    if ('error' in send) throw new Error(send.error);
    expect(agentShellRefusal(send, 'a Claude Code session')).toContain('refused');
  });

  it('prints what the agent needs next', () => {
    const child = { childId: 'fix', key: 'claude:k1', provider: 'claude', branch: 'child/fix', worktree: '/Users/test/proj-child-fix' };
    expect(formatChildSpawn({ child, repo: '/Users/test/proj' })).toContain('aw child done fix');
    expect(formatChildList({ agent: 'PO', children: [] }, 0)).toContain('no child conversations');
    expect(formatChildList({ agent: 'PO', children: [{ ...child, needsYou: true, status: 'blocked' }] }, 0)).toContain('waiting on the user');
    expect(formatChildDone({ outcome: 'refused', message: 'Not done: unmerged.', child })).toBe('Refused. Not done: unmerged.');
  });
});

describe('what the conversations are told', () => {
  it('durable agents get the child guidance once, not the delegation guidance', () => {
    const once = withChildGuidance('You are "PO".');
    expect(once).toContain('aw child spawn');
    expect(withChildGuidance(once)).toBe(once);
    expect(once).not.toContain(CONVERSATION_DELEGATION_INSTRUCTIONS);
    expect(CHILD_CONVERSATION_GUIDANCE).toContain('aw child done');
  });

  it('a child is told its branch, that the parent merges, and that it cannot spawn', () => {
    const text = childInstructions(ORIGIN, 'PO');
    expect(text).toContain('child/fix-login-test');
    expect(text).toContain('Do not merge');
    expect(text).toContain('cannot start child conversations');
  });

  it('the Agents view lists an agent\'s children', () => {
    const agent = createAgent('agent-a', { name: 'PO', role: 'Owns the backlog', scope: { kind: 'global' }, provider: 'claude' }, 1);
    const kids = [{ childId: 'fix', key: 'claude:k1', provider: 'claude' as const, branch: 'child/fix', worktree: '/Users/test/proj-child-fix' }];
    expect(agentView(agent, () => undefined, kids).children).toEqual(kids);
    expect(agentView(agent, () => undefined).children).toEqual([]);
  });
});

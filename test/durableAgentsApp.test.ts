import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDurableAgents, type DurableAgentDeps } from '../src/app/durableAgents';
import { DurableAgentStore } from '../src/core/durableAgentStore';
import type { AgentSession } from '../src/shared/model';

function memoryStorage() {
  const doc: Record<string, unknown> = {};
  return {
    get<T>(key: string, def: T): T {
      return (doc[key] as T) ?? def;
    },
    update(key: string, value: unknown) {
      doc[key] = JSON.parse(JSON.stringify(value));
      return undefined;
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-agents-')));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'po.md'), 'Write acceptance criteria first.');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The app half of durable agents, over a real store and fakes for everything that runs. */
function rig(answer: string | undefined = 'Save') {
  let h = 0;
  const agents = new DurableAgentStore(memoryStorage(), () => 100, () => 'a1', () => (++h).toString(16).padStart(8, '0'));
  const rows = new Map<string, AgentSession>();
  const warn = vi.fn(async () => answer);
  const deps = {
    agents,
    store: { get: (key: string) => rows.get(key) },
    sessions: { list: () => [], onDidChange: () => ({ dispose() {} }) },
    launchDefaults: {},
    projects: { value: [{ dir, name: 'proj' }], add() {} },
    dialogs: { warn },
    surface: () => undefined,
    globalDir: () => path.join(dir, 'global'),
    log: () => undefined,
  } as unknown as DurableAgentDeps;
  const app = createDurableAgents(deps);
  const row = (provider: 'claude' | 'codex', sessionId: string, cwd = dir) => rows.set(`${provider}:${sessionId}`, { provider, sessionId, key: `${provider}:${sessionId}`, title: 't', status: 'done', lastActivityAt: 1, cwd });
  return { app, agents, warn, row };
}

const INPUT = { name: 'PO', role: 'Owns the backlog', provider: 'claude' };

describe('durable agents in the app', () => {
  it('saves an agent with an instructions file, and refuses a missing one at the form (#182)', async () => {
    const r = rig();
    expect(await r.app.directory.save(undefined, { ...INPUT, scope: { kind: 'folder', dir }, instructionsFile: 'docs/missing.md' })).toMatchObject({ error: expect.stringContaining('was not found') });
    expect(await r.app.directory.save(undefined, { ...INPUT, scope: { kind: 'folder', dir }, instructionsFile: 'docs/po.md' })).toEqual({ id: 'a1' });
  });

  it('asks before an edit that ends the current conversation, and keeps it when the user says no (#182)', async () => {
    const r = rig('Cancel');
    await r.app.directory.save(undefined, { ...INPUT, scope: { kind: 'folder', dir } });
    r.agents.link('a1', { provider: 'claude', sessionId: 's1' });
    expect(await r.app.directory.save('a1', { ...INPUT, role: 'Reviews PRs', scope: { kind: 'folder', dir } })).toEqual({ id: 'a1' });
    expect(r.warn).not.toHaveBeenCalled();
    expect(await r.app.directory.save('a1', { ...INPUT, provider: 'codex', scope: { kind: 'folder', dir } })).toEqual({ cancelled: true });
    expect(r.warn).toHaveBeenCalledTimes(1);
    expect(r.agents.get('a1')).toMatchObject({ provider: 'claude', current: { sessionId: 's1' } });
  });

  it('resumes with the instructions, file and memory as they are now (#180, #182)', async () => {
    const r = rig();
    await r.app.directory.save(undefined, { ...INPUT, scope: { kind: 'folder', dir }, instructionsFile: 'docs/po.md' });
    r.app.directory.memory('a1', { op: 'remember', kind: 'decision', text: 'Postgres for now' });
    r.agents.link('a1', { provider: 'claude', sessionId: 's1' });
    const origin = { kind: 'agent', agentId: 'a1' };
    const text = r.app.resumeInstructions({ provider: 'claude', sessionId: 'S1' }, origin)!;
    expect(text).toContain('Write acceptance criteria first.');
    expect(text).toContain('Postgres for now');
    // Not an agent's, and never was: keep what it has.
    expect(r.app.resumeInstructions({ provider: 'claude', sessionId: 'x' }, { kind: 'orchestration' })).toBeUndefined();
    fs.rmSync(path.join(dir, 'docs', 'po.md'));
    expect(() => r.app.resumeInstructions({ provider: 'claude', sessionId: 's1' }, origin)).toThrow(/was not found/);
  });

  it('a resumed session speaks as the agent that holds it now, or as nobody once unassigned (#181)', async () => {
    const r = rig();
    await r.app.directory.save(undefined, { ...INPUT, scope: { kind: 'global' } });
    r.row('claude', 's1');
    const launchedBy = { kind: 'agent', agentId: 'a1' };
    // Assigned by hand, with no agent origin of its own: it still gets the agent's role.
    r.app.directory.assign('claude:s1', 'a1');
    expect(r.app.resumeInstructions({ provider: 'claude', sessionId: 's1' }, undefined)).toContain('"PO"');
    r.app.directory.assign('claude:s1', undefined);
    const plain = r.app.resumeInstructions({ provider: 'claude', sessionId: 's1' }, launchedBy)!;
    expect(plain).not.toContain('"PO"');
    expect(plain).not.toContain('aw remember');
  });

  it("takes a proposal from the agent's conversation only, and stores nothing until it is approved (#180)", async () => {
    const r = rig();
    await r.app.directory.save(undefined, { ...INPUT, scope: { kind: 'folder', dir } });
    r.agents.link('a1', { provider: 'claude', sessionId: 'S1' });
    expect(() => r.app.propose({ provider: 'claude', sessionId: 'stranger' }, { op: 'add', text: 'x' })).toThrow(/does not belong to a durable agent/);
    const p = r.app.propose({ provider: 'claude', sessionId: 's1' }, { op: 'add', kind: 'preference', text: 'Prefers tables' });
    expect(p).toEqual({ agentName: 'PO', proposalId: 'p-00000001' });
    expect(r.app.conversations.memoryFor('claude:s1')).toMatchObject({ agentId: 'a1', items: [], proposals: [{ op: 'add', text: 'Prefers tables' }] });
    expect(r.app.directory.memory('a1', { op: 'approve', proposalId: 'p-00000001' })).toEqual({});
    expect(r.app.conversations.memoryFor('agent:a1')?.items.map((i) => i.text)).toEqual(['Prefers tables']);
    expect(r.app.directory.memory('a1', { op: 'grant' })).toEqual({ error: 'That memory change was not understood.' });
  });

  it('assigns and unassigns from Sessions, within the agent\'s harness and folder, and makes an earlier one current (#181)', async () => {
    const r = rig();
    await r.app.directory.save(undefined, { ...INPUT, scope: { kind: 'folder', dir } });
    r.row('claude', 's1');
    r.row('claude', 's2', '/Users/test/elsewhere');
    r.row('codex', 't1');
    expect(r.app.directory.assign('claude:s2', 'a1')).toMatchObject({ error: expect.stringContaining('works in') });
    expect(r.app.directory.assign('codex:t1', 'a1')).toMatchObject({ error: expect.stringContaining('runs on Claude') });
    expect(r.app.directory.assign('claude:s1', 'a1')).toEqual({});
    expect(r.app.directory.ownerOf('claude', 's1')).toEqual({ id: 'a1', name: 'PO', current: true });
    r.agents.link('a1', { provider: 'claude', sessionId: 's3' });
    expect(r.app.directory.ownerOf('claude', 's1')?.current).toBe(false);
    expect(r.app.directory.makeCurrent('a1', 'claude:s1')).toEqual({});
    expect(r.agents.get('a1')?.current?.sessionId).toBe('s1');
    expect(r.app.directory.makeCurrent('a1', 'claude:nope')).toHaveProperty('error');
    // A conversation left behind by a harness change cannot come back as current.
    r.agents.update('a1', { name: 'PO', role: 'Owns the backlog', provider: 'codex', scope: { kind: 'folder', dir } });
    expect(r.app.directory.makeCurrent('a1', 'claude:s1')).toMatchObject({ error: expect.stringContaining('ran on Claude') });
    r.agents.update('a1', { name: 'PO', role: 'Owns the backlog', provider: 'claude', scope: { kind: 'folder', dir } });
    expect(r.app.directory.assign('claude:s1', undefined)).toEqual({});
    expect(r.app.directory.ownerOf('claude', 's1')).toBeUndefined();
  });

  it("resumes a Codex thread on typing only when it is an agent's current one (#181)", async () => {
    const r = rig();
    await r.app.directory.save(undefined, { ...INPUT, provider: 'codex', scope: { kind: 'folder', dir } });
    r.agents.link('a1', { provider: 'codex', sessionId: 't1' });
    expect(r.app.conversations.resumesOnType('codex', 'T1')).toBe(true);
    expect(r.app.conversations.resumesOnType('codex', 't2')).toBe(false);
  });
});

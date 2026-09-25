import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunnerService } from '../src/claude/runner/runnerService';
import { SessionExecutors } from '../src/core/session/sessionExecutors';
import type { SessionHandle } from '../src/core/session/sessionHandle';
import { SessionRegistry } from '../src/core/session/sessionRegistry';
import { SimulatedHarness } from '../src/orchestration/harness/simulatedHarness';
import { HostHarness, alive, noHistory, until } from './support/hostHarness';

/**
 * The simulated harness through a real, detached session host (#30): the
 * same script the in-process tests play, played by the fake agent
 * (`AW_SESSION_HOST_FAKE=1`) behind #4's hosted launch path. What reaches
 * the worktree, the registry and the turn events is the same either way.
 */

const h = new HostHarness();

beforeAll(() => h.build(), 60_000);
afterEach(async () => {
  expect(await h.cleanup()).toEqual([]);
});
afterAll(() => h.dispose());

function memento() {
  const doc: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

function hostedRig() {
  const registry = new SessionRegistry(memento());
  const runners = new RunnerService({
    query: () => {
      throw new Error('hosted sessions never run in-process');
    },
    binary: () => '/fake',
    log: () => undefined,
    registry,
    loadHistory: noHistory,
    hosts: { supervisor: h.supervisor(), enabled: () => true },
  });
  return { registry, runners, sessions: new SessionExecutors([runners]) };
}

describe('simulated harness in a session host', () => {
  it('plays an edit attempt in a real host: files, registry record and turn end', async () => {
    const worktree = path.join(h.root, 'wt-edit');
    fs.mkdirSync(worktree);
    const { registry, sessions } = hostedRig();
    const harness = new SimulatedHarness({
      scenario: { tasks: { t1: [{ behaviour: 'edit', files: { 'src/a.ts': 'export const a = 1;\n' }, usage: { in: 500, out: 50 } }] } },
      sessions,
    });
    const handle: SessionHandle = await harness.launch({
      cwd: worktree,
      prompt: 'Do it',
      target: { harness: 'claude-code', model: 'claude-haiku-4-5', effortNative: 'low' },
      origin: { kind: 'orchestration', missionId: 'm1', taskId: 't1', attemptId: 'a1' },
    });
    const ends: unknown[] = [];
    handle.onTurnEnd((raw) => ends.push(raw));
    await until(() => ends.length === 1, 15_000, 'the scripted turn');

    expect(fs.readFileSync(path.join(worktree, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(ends[0]).toMatchObject({ subtype: 'success', modelUsage: { 'claude-haiku-4-5': { inputTokens: 500, outputTokens: 50 } } });
    expect(registry.get(handle.sessionId)).toMatchObject({ state: 'live', origin: { taskId: 't1', attemptId: 'a1' } });
    const m = await h.manifestWithAgent(handle.sessionId!);
    expect(alive(m.hostPid)).toBe(true);

    await handle.end();
    await until(() => !alive(m.hostPid) && !alive(m.agentPid), 15_000, 'the host to exit');
  }, 40_000);

  it('a scripted crash kills the real agent process mid-turn', async () => {
    const worktree = path.join(h.root, 'wt-crash');
    fs.mkdirSync(worktree);
    const { sessions } = hostedRig();
    const harness = new SimulatedHarness({ scenario: { default: { behaviour: 'crash', files: { 'half.ts': 'export const' } } }, sessions });
    const handle = await harness.launch({
      cwd: worktree,
      prompt: 'Do it',
      target: { harness: 'claude-code', model: 'claude-haiku-4-5', effortNative: 'none' },
      origin: { kind: 'orchestration', missionId: 'm1', taskId: 't2', attemptId: 'a1' },
    });
    const m = await h.manifestWithAgent(handle.sessionId!);
    await until(() => handle.lifecycle === 'error' || handle.lifecycle === 'ended', 15_000, 'the crash');
    expect(fs.readFileSync(path.join(worktree, 'half.ts'), 'utf8')).toBe('export const');
    await until(() => !alive(m.agentPid), 15_000, 'the agent to be gone');
  }, 40_000);
});

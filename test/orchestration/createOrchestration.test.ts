import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchDefaults } from '../../src/core/launchDefaults';
import { createOrchestration, missionsDir, type OrchestrationDeps } from '../../src/orchestration';
import { MissionStore } from '../../src/orchestration/store/missionStore';
import { mission } from './fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function deps(doc: Record<string, unknown>, startupSettled: Promise<void>, logs: string[] = []): OrchestrationDeps {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-orch-'));
  dirs.push(dataDir);
  const settings = { get: <T>(k: string, f: T): T => (k in doc ? (doc[k] as T) : f) };
  return {
    settings,
    dataDir,
    sessions: { launch: async () => { throw new Error('no launches in #26'); }, get: () => undefined, list: () => [], onDidChange: () => ({ dispose: () => undefined }) },
    registry: { all: () => [], get: () => undefined },
    launchDefaults: new LaunchDefaults(settings),
    startupSettled,
    log: (m) => logs.push(m),
  };
}

describe('createOrchestration', () => {
  it('is inert and touches nothing on disk when disabled (the default)', async () => {
    const d = deps({}, new Promise(() => undefined));
    const o = createOrchestration(d);
    expect(o.enabled).toBe(false);
    expect(o.store).toBeUndefined();
    await o.ready;
    expect(fs.readdirSync(d.dataDir)).toEqual([]);
  });

  it('when enabled, reads missions only after #4\'s startup has settled', async () => {
    let settle!: () => void;
    const logs: string[] = [];
    const d = deps({ 'orchestration.enabled': true }, new Promise<void>((r) => (settle = r)), logs);
    new MissionStore(missionsDir(d.dataDir)).save(mission());
    const o = createOrchestration(d);
    expect(o.enabled).toBe(true);
    await Promise.resolve();
    expect(o.tasks!.list()).toEqual([]);
    settle();
    await o.ready;
    expect(o.tasks!.list().map((m) => m.id)).toEqual([mission().id]);
    o.dispose();
  });

  it('refuses a Claude task while session hosts are off (G1)', async () => {
    const d = deps({ 'orchestration.enabled': true }, Promise.resolve());
    const o = createOrchestration({ ...d, hostsEnabled: () => false });
    await o.ready;
    await expect(
      o.tasks!.start({ folder: d.dataDir, objective: 'x', acceptanceCriteria: [], route: { harness: 'claude-code' } }),
    ).rejects.toThrow(/Keep conversations running/);
    expect(o.tasks!.list()).toEqual([]);
    o.dispose();
  });
});

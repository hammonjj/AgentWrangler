import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPidAlive } from '../src/claude/registry';
import { RunnerService } from '../src/claude/runner/runnerService';
import type { RunnerView } from '../src/claude/runner/runnerView';
import { LaunchDefaults } from '../src/core/launchDefaults';
import { HostSupervisor } from '../src/core/session/hostSupervisor';
import { readManifests } from '../src/core/session/manifestFile';
import { SessionRegistry } from '../src/core/session/sessionRegistry';
import type { LaunchPolicy } from '../src/shared/launchPolicy';

/**
 * #71 end to end, with real detached session hosts over real sockets and the
 * scripted agent (`AW_SESSION_HOST_FAKE=1`): a Claude session launched with a
 * deny rule still has it after a Resume, and after a §7.4 move to a host of a
 * newer build, including one adopted without a registry record. The agent
 * reports the SDK options each start was given (`policy?`).
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-'));
const runDir = path.join(root, 'run');
const bundle = path.join(root, 'host.js');
const log = () => undefined;
const noHistory = async () => ({ blocks: [], truncated: false });

const POLICY: LaunchPolicy = {
  claude: { allowedTools: ['Bash(npm test:*)'], disallowedTools: ['Bash(git push:*)'], maxTurns: 30 },
};

function supervisor(build = 'test'): HostSupervisor {
  return new HostSupervisor({
    runDir,
    fallbackRunDir: path.join(root, 'fb'),
    logDir: path.join(root, 'logs'),
    runtime: { buildId: build, prepare: async () => ({ exe: process.execPath, entry: bundle }) },
    log,
    build,
    hostEnv: { AW_SESSION_HOST_FAKE: '1' },
  });
}

function memento() {
  const doc: Record<string, unknown> = {};
  return {
    get: <T>(key: string, fallback: T): T => (key in doc ? (doc[key] as T) : fallback),
    update: (key: string, value: unknown) => {
      doc[key] = value;
    },
  };
}

function service(sup: HostSupervisor, registry: SessionRegistry): RunnerService {
  return new RunnerService({
    query: () => {
      throw new Error('hosted only');
    },
    binary: () => '/fake',
    log,
    registry,
    loadHistory: noHistory,
    hosts: { supervisor: sup, enabled: () => true },
  });
}

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const manifestFor = (sessionId: string) =>
  readManifests(runDir)
    .map((m) => m.manifest)
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt)[0];

/** Ask the agent which policy options its current start was given. */
async function policyOf(view: RunnerView): Promise<Record<string, unknown>> {
  const before = view.blocks.length;
  expect(await view.send('policy?')).toBe('applied');
  let reply: string | undefined;
  await until(() => {
    const block = view.blocks.slice(before).find((b) => b.kind === 'assistant' && b.text.startsWith('policy: '));
    reply = block && 'text' in block ? block.text : undefined;
    return reply !== undefined;
  });
  return JSON.parse(reply!.slice('policy: '.length));
}

beforeAll(async () => {
  await esbuild.build({
    entryPoints: ['src/sessionHost/main.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: bundle,
    define: { 'import.meta.url': '__aw_import_meta_url', AW_SDK_VERSION: '"test"' },
    banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => {
  for (const { manifest } of readManifests(runDir, true)) {
    if (isPidAlive(manifest.hostPid)) process.kill(manifest.hostPid, 'SIGKILL');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'darwin')('launch policy through session hosts', () => {
  it('holds after a Resume: recorded at launch, applied again from the record', async () => {
    const id = 'cccccccc-0000-4000-8000-000000000001';
    const registry = new SessionRegistry(memento());
    const runners = service(supervisor(), registry);
    const first = await runners.launch({ provider: 'claude', cwd: root, sessionId: id, permissionMode: 'auto', policy: POLICY });
    expect(await policyOf(first)).toEqual({ ...POLICY.claude, permissionMode: 'auto' });
    expect(manifestFor(id)?.launch?.policy).toEqual(POLICY);
    const hostPid = manifestFor(id)!.hostPid;
    await runners.end(first);
    await until(() => !isPidAlive(hostPid));

    // Resume the way the app does: from the record.
    const record = registry.get(id)!;
    expect(record.launch.policy).toEqual(POLICY);
    const defaults = new LaunchDefaults({ get: <T>(_k: string, d: T) => d });
    const again = await runners.launch({ provider: 'claude', cwd: record.cwd, resume: id, ...defaults.resumed('claude', record.launch) });
    expect(await policyOf(again)).toEqual({ ...POLICY.claude, permissionMode: 'auto' });
    expect(manifestFor(id)?.launch).toMatchObject({ resume: true, policy: POLICY });
    const againPid = manifestFor(id)!.hostPid;
    await runners.end(again);
    await until(() => !isPidAlive(againPid));
  }, 45_000);

  it('holds after a §7.4 move to a newer host, even when the registry lost the record', async () => {
    const id = 'cccccccc-0000-4000-8000-000000000002';
    // Started by the old app.
    const oldRunners = service(supervisor('build-old'), new SessionRegistry(memento()));
    const first = await oldRunners.launch({ provider: 'claude', cwd: root, sessionId: id, permissionMode: 'auto', policy: POLICY });
    expect(await policyOf(first)).toMatchObject({ disallowedTools: ['Bash(git push:*)'] });
    first.detach();
    const oldHost = manifestFor(id)!;

    // The new app adopts it with no record: the manifest's copy of the policy is what it has.
    const newSup = supervisor('build-new');
    const registry = new SessionRegistry(memento());
    const runners = service(newSup, registry);
    const view = runners.adopt(newSup.scan().alive.find((m) => m.sessionId === id)!, undefined)!;
    expect(view.policy).toEqual(POLICY);
    await until(() => view.lifecycle === 'idle');
    expect(view.outdatedHost).toBe(true);

    // The next send moves it to a new host: the agent there has the same rules.
    const turns: unknown[] = [];
    view.onTurnEnd((raw) => turns.push(raw));
    expect(await policyOf(view)).toMatchObject({ disallowedTools: ['Bash(git push:*)'], allowedTools: ['Bash(npm test:*)'], maxTurns: 30 });
    expect(view.outdatedHost).toBe(false);
    const current = manifestFor(id)!;
    expect(current.hostId).not.toBe(oldHost.hostId);
    expect(current.launch).toMatchObject({ resume: true, policy: POLICY });
    await until(() => !isPidAlive(oldHost.hostPid));

    // A caller's message id comes back on the turn it caused.
    expect(await view.send('mine', undefined, { clientMessageId: 'dddddddd-0000-4000-8000-000000000001' })).toBe('applied');
    await until(() => turns.some((t) => (t as { user_message_uuid?: string }).user_message_uuid === 'dddddddd-0000-4000-8000-000000000001'));

    await view.end();
    await until(() => !isPidAlive(current.hostPid));
  }, 45_000);
});

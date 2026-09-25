import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPidAlive, readProcessEntries } from '../src/claude/registry';
import { RunnerService } from '../src/claude/runner/runnerService';
import type { RunnerView } from '../src/claude/runner/runnerView';
import { parentPidOf, startTimeOf } from '../src/core/procStart';
import { HostSupervisor } from '../src/core/session/hostSupervisor';
import { readManifests } from '../src/core/session/manifestFile';
import { sweepOrphans, sweepRefusal } from '../src/core/session/orphanSweep';
import { adoptHostedClaude, spawnHostedClaude } from '../src/core/session/remoteClaudeHandle';

/**
 * Stage 4, with real detached hosts over real sockets and a scripted agent:
 *
 * - a host SIGKILLed mid-session leaves its `claude` running under launchd,
 *   the sweep ends it (and waits), and a resume is then the only process on
 *   the id (the fake agent is a real process with a `sessions/<pid>.json`,
 *   `AW_FAKE_CLAUDE_SESSIONS_DIR`);
 * - a host on an older build moves to a new host on the next idle send, in
 *   the same view, and the old host goes (§7.4);
 * - the idle-orphan rule parks an idle session once nothing is connected, and
 *   never while something is (§7.5), with its hours pushed by `configure`.
 *
 * macOS only: an orphan's parent is launchd (pid 1) there.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-'));
const runDir = path.join(root, 'run');
const sessionsDir = path.join(root, 'sessions');
const bundle = path.join(root, 'host.js');
const noHistory = async () => ({ blocks: [], truncated: false });
const log = () => undefined;

function supervisor(build = 'test', opts: { idleHours?: () => number; checkMs?: number } = {}): HostSupervisor {
  return new HostSupervisor({
    runDir,
    fallbackRunDir: path.join(root, 'fb'),
    logDir: path.join(root, 'logs'),
    runtime: { buildId: build, prepare: async () => ({ exe: process.execPath, entry: bundle }) },
    log,
    build,
    orphanIdleHours: opts.idleHours,
    hostEnv: {
      AW_SESSION_HOST_FAKE: '1',
      AW_FAKE_CLAUDE_SESSIONS_DIR: sessionsDir,
      ...(opts.checkMs ? { AW_SESSION_HOST_IDLE_CHECK_MS: String(opts.checkMs), AW_SESSION_HOST_DRAIN_MS: '500' } : {}),
    },
  });
}

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const texts = (v: RunnerView) => v.blocks.map((b) => ('text' in b ? b.text : `[${b.kind}]`));
const manifestsFor = (sessionId: string) => readManifests(runDir).filter((m) => m.manifest.sessionId === sessionId).map((m) => m.manifest);
const manifestFor = (sessionId: string) => manifestsFor(sessionId).sort((a, b) => b.startedAt - a.startedAt)[0];
/** Processes still running this session id, by their `sessions/<pid>.json`. */
const liveAgents = async (sessionId: string) =>
  (await readProcessEntries(sessionsDir)).filter((e) => e.sessionId === sessionId && isPidAlive(e.pid) && startTimeOf(e.pid) === e.procStart);

const sweepDeps = (sup: HostSupervisor) => ({
  entries: () => readProcessEntries(sessionsDir),
  heldAgentPids: () => sup.heldAgentPids(),
  isAlive: isPidAlive,
  startTimeOf,
  parentOf: parentPidOf,
  kill: (pid: number, sig: 'SIGTERM' | 'SIGKILL') => process.kill(pid, sig),
  delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  log,
});

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

afterAll(async () => {
  for (const { manifest } of readManifests(runDir, true)) {
    if (isPidAlive(manifest.hostPid)) process.kill(manifest.hostPid, 'SIGKILL');
  }
  for (const e of await readProcessEntries(sessionsDir)) {
    if (isPidAlive(e.pid) && startTimeOf(e.pid) === e.procStart) process.kill(e.pid, 'SIGKILL');
  }
  for (const p of extras) if (isPidAlive(p.pid) && startTimeOf(p.pid) === p.start) process.kill(p.pid, 'SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- Stand-ins for a `claude` process, for the sweep's identity rows ----

/** Processes started here whose `sessions/<pid>.json` may not name them truly; ended in `afterAll`. */
const extras: { pid: number; start?: string }[] = [];

/**
 * Runs until killed. With `termDelayMs`, it takes that long to exit after SIGTERM, as a busy CLI
 * does (S1). Once its handler is installed it writes `<pid>.ready`, so no signal lands before it.
 */
function standInScript(termDelayMs = 0): string {
  const file = path.join(root, `standin-${termDelayMs}.js`);
  const onTerm = termDelayMs > 0 ? `setTimeout(() => process.exit(0), ${termDelayMs})` : 'process.exit(0)';
  const ready = JSON.stringify(root);
  fs.writeFileSync(
    file,
    `process.on('SIGTERM', () => { ${onTerm}; });\n` +
      `require('fs').writeFileSync(require('path').join(${ready}, process.pid + '.ready'), '');\n` +
      'setInterval(() => {}, 1000);\n',
  );
  return file;
}

async function track(pid: number): Promise<number> {
  await until(() => fs.existsSync(path.join(root, `${pid}.ready`)), 5000);
  extras.push({ pid, start: startTimeOf(pid) });
  return pid;
}

/** A child of this test process: its parent is not launchd, so it stands for a terminal's `claude`. */
function spawnOwned(): Promise<number> {
  const child = spawn(process.execPath, [standInScript()], { stdio: 'ignore' });
  return track(child.pid!);
}

/** A process whose parent has exited, so launchd adopted it: what a SIGKILLed host leaves behind. */
async function spawnOrphan(termDelayMs = 0): Promise<number> {
  const sh = spawn('/bin/sh', ['-c', `"${process.execPath}" "${standInScript(termDelayMs)}" >/dev/null 2>&1 & echo $!`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  sh.stdout!.on('data', (d) => (out += String(d)));
  await new Promise((r) => sh.on('exit', r));
  const pid = Number(out.trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  await track(pid);
  await until(() => parentPidOf(pid) === 1, 5000);
  return pid;
}

/** Write `sessions/<pid>.json` the way the CLI does. `procStart` defaults to the process's real start time. */
function writeEntry(pid: number, sessionId: string, procStart = startTimeOf(pid)): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({ pid, sessionId, procStart }));
}

describe.runIf(process.platform === 'darwin')('session host recovery, end to end', () => {
  it('sweeps the agent a killed host left behind, so a resume is the only process on the id', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000001';
    const sup = supervisor();
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: sup, binary: '/fake', log, loadHistory: noHistory });
    view.start();
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    const m = manifestFor(id)!;
    expect(m.agentPid).toBeDefined();
    const agent = m.agentPid!;
    // Mid-turn, as the CLI is when an orphan matters: an idle one exits on stdin EOF by itself.
    await view.send('hold');
    await until(() => view.lifecycle === 'running');

    // The host dies without a word: its agent is reparented to launchd and keeps running.
    process.kill(m.hostPid, 'SIGKILL');
    await until(() => view.lifecycle === 'error');
    expect(view.lastExit?.reason).toBe('lost');
    await until(() => parentPidOf(agent) === 1);
    expect(manifestFor(id)?.exit).toBeUndefined();

    // A resume would now fork the transcript. The sweep ends the orphan and waits for it.
    const swept = await sweepOrphans(id, sweepDeps(sup));
    expect(swept).toMatchObject({ swept: [agent], clear: true });
    expect(isPidAlive(agent)).toBe(false);
    // Its file may stay behind (this fake does not remove it); it is stale now, and ignored.
    expect(await liveAgents(id)).toEqual([]);

    // The manifest has done its job.
    sup.forget(m);
    expect(manifestsFor(id).find((x) => x.hostId === m.hostId)).toBeUndefined();

    // Resume: exactly one process on the id.
    const again = spawnHostedClaude({ cwd: root, resume: id }, { supervisor: sup, binary: '/fake', log, loadHistory: noHistory });
    again.start();
    await again.send('back');
    await until(() => texts(again).includes('echo: back'));
    expect((await liveAgents(id)).map((e) => e.pid)).toEqual([manifestFor(id)!.agentPid]);

    // And while that host lives, its agent is held: another sweep refuses a second resume without touching it.
    const second = await sweepOrphans(id, sweepDeps(sup));
    expect(second.clear).toBe(false);
    expect(sweepRefusal(second)).toBeDefined();
    expect(isPidAlive(manifestFor(id)!.agentPid!)).toBe(true);

    const pid = manifestFor(id)!.hostPid;
    await again.end();
    await until(() => !isPidAlive(pid));
    expect(await liveAgents(id)).toEqual([]);
  }, 45_000);

  it('moves a session on an older host build to a new host on its next idle send (§7.4)', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000002';
    // Started by the old app.
    const oldApp = supervisor('build-old');
    const first = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: oldApp, binary: '/fake', log, loadHistory: noHistory });
    first.start();
    await first.send('before');
    await until(() => texts(first).includes('echo: before'));
    first.detach();
    const oldHost = manifestFor(id)!;
    expect(oldHost.hostBuild).toBe('build-old');

    // The new app adopts it; it is behind, and says so once connected.
    const newApp = supervisor('build-new');
    const found = newApp.scan().alive.find((x) => x.sessionId === id)!;
    let swept = 0;
    const view = adoptHostedClaude(found, {}, {
      supervisor: newApp,
      binary: '/fake',
      log,
      loadHistory: noHistory,
      beforeResume: async (sid) => {
        swept++;
        const why = sweepRefusal(await sweepOrphans(sid, sweepDeps(newApp)));
        if (why) throw new Error(why);
      },
    });
    view.start();
    await until(() => view.lifecycle === 'idle');
    expect(view.outdatedHost).toBe(true);

    // The next send ends the old agent, sweeps, resumes on a fresh host, and is answered in the same view.
    expect(await view.send('after')).toBe('applied');
    await until(() => texts(view).includes('echo: after'));
    expect(swept).toBe(1);
    expect(view.outdatedHost).toBe(false);
    await until(() => !isPidAlive(oldHost.hostPid));
    const current = manifestFor(id)!;
    expect(current.hostId).not.toBe(oldHost.hostId);
    expect(current.hostBuild).toBe('build-new');
    expect(current.launch?.resume).toBe(true);
    // One process on the id, never two.
    expect((await liveAgents(id)).map((e) => e.pid)).toEqual([current.agentPid]);

    await view.end();
    await until(() => !isPidAlive(current.hostPid));
  }, 45_000);

  it('does not move a busy session: it waits for an idle send', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000003';
    const first = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: supervisor('build-old'), binary: '/fake', log, loadHistory: noHistory });
    first.start();
    await first.send('please ask');
    await until(() => first.blocks.some((b) => b.kind === 'permission' && b.state === 'pending'));
    first.detach();
    const oldHost = manifestFor(id)!;

    const newApp = supervisor('build-new');
    const view = adoptHostedClaude(newApp.scan().alive.find((x) => x.sessionId === id)!, {}, {
      supervisor: newApp,
      binary: '/fake',
      log,
      loadHistory: noHistory,
      beforeResume: async () => {
        throw new Error('must not migrate while an ask is pending');
      },
    });
    view.start();
    await until(() => view.blocks.some((b) => b.kind === 'permission' && b.state === 'pending'));
    expect(view.outdatedHost).toBe(true);
    // Answer it on the old host; it stays that host.
    const card = view.blocks.find((b) => b.kind === 'permission') as { requestId: string };
    expect(await view.decide(card.requestId, 'allow')).toBe('applied');
    await until(() => texts(view).includes('allowed'));
    expect(manifestFor(id)!.hostId).toBe(oldHost.hostId);

    await view.end();
    await until(() => !isPidAlive(oldHost.hostPid));
  }, 45_000);

  it('parks an idle session once nothing is connected, never while something is (§7.5)', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000004';
    // Off at spawn; turned on through `configure`, as a Preferences change would.
    let hours = 0;
    const sup = supervisor('test', { idleHours: () => hours, checkMs: 100 });
    const view = spawnHostedClaude({ cwd: root, sessionId: id }, { supervisor: sup, binary: '/fake', log, loadHistory: noHistory });
    view.start();
    await view.send('hi');
    await until(() => texts(view).includes('echo: hi'));
    await until(() => view.lifecycle === 'idle');
    hours = 1 / 3600; // one second
    view.reconfigure();

    // Connected: never parked, however long.
    await new Promise((r) => setTimeout(r, 2000));
    const m = manifestFor(id)!;
    expect(isPidAlive(m.hostPid)).toBe(true);

    // Nobody connected: parked about a second later, recorded as such, resumable.
    view.detach();
    await until(() => !isPidAlive(m.hostPid), 10_000);
    expect(manifestFor(id)?.exit).toMatchObject({ reason: 'stopped', trigger: 'idleTimeout' });
    expect(await liveAgents(id)).toEqual([]);
  }, 45_000);
});

/**
 * The sweep's identity rows (§16, added at CP0 from S1), with real processes
 * standing in for `claude` and real `sessions/<pid>.json` files, and the
 * resume going through `RunnerService` as the app's does. The unit tests in
 * `orphanSweep.test.ts` cover the same branches with fakes; these prove the
 * real probes (`ps` start time, parent pid) classify real processes the same way.
 */
describe.runIf(process.platform === 'darwin')('orphan identity, with real processes', () => {
  /** A Claude runner as the app wires it: hosts on, every resume swept first, history reads recorded. */
  function runner(sup: HostSupervisor, onHistory: () => void) {
    return new RunnerService({
      query: () => {
        throw new Error('hosted sessions never run in-process');
      },
      binary: () => '/fake',
      log,
      hosts: { supervisor: sup, enabled: () => true },
      loadHistory: async () => {
        onHistory();
        return { blocks: [], truncated: false };
      },
      beforeResume: async (sessionId) => {
        const why = sweepRefusal(await sweepOrphans(sessionId, sweepDeps(sup)));
        if (why) throw new Error(why);
      },
    });
  }

  it('a live process with a parent other than launchd is an owner: never signalled, and the resume is refused', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000011';
    const owner = await spawnOwned();
    writeEntry(owner, id);
    expect(parentPidOf(owner)).toBe(process.pid);

    const sup = supervisor();
    const swept = await sweepOrphans(id, sweepDeps(sup));
    expect(swept).toMatchObject({ swept: [], owners: [owner], clear: false });
    expect(sweepRefusal(swept)).toMatch(/take it over/);

    let historyReads = 0;
    await expect(runner(sup, () => historyReads++).resume({ cwd: root, resume: id })).rejects.toThrow(/take it over/);
    expect(historyReads).toBe(0);
    expect(manifestsFor(id)).toEqual([]);
    expect(isPidAlive(owner)).toBe(true);
    process.kill(owner, 'SIGKILL');
  }, 30_000);

  it('stale entries are ignored: a dead pid, and a live pid whose start time is not the one recorded', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000012';
    // A CLI that was SIGKILLed: its file outlives it.
    const dead = await spawnOwned();
    writeEntry(dead, id);
    process.kill(dead, 'SIGKILL');
    await until(() => !isPidAlive(dead), 5000);
    // A pid reused by something else: alive, orphaned even, but not the process the file names.
    const reused = await spawnOrphan();
    writeEntry(reused, id, 'Thu Jan  1 00:00:00 1970');

    const swept = await sweepOrphans(id, sweepDeps(supervisor()));
    expect(swept).toEqual({ swept: [], refused: [], owners: [], held: [], clear: true });
    // Nothing was signalled on a guess.
    expect(isPidAlive(reused)).toBe(true);
    process.kill(reused, 'SIGKILL');
  }, 30_000);

  it('the sweep waits for a slow orphan to exit, and only then is the history read and the session resumed', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000013';
    // Like a busy CLI: SIGTERM takes a while to land (S1 saw ~2.8 s).
    const orphan = await spawnOrphan(1500);
    writeEntry(orphan, id);

    const sup = supervisor();
    let orphanAliveAtHistory: boolean | undefined;
    const t0 = Date.now();
    const view = await runner(sup, () => {
      orphanAliveAtHistory ??= isPidAlive(orphan);
    }).resume({ cwd: root, resume: id });
    // `resume` returned only after the sweep: the orphan is gone, and it took its time going.
    expect(isPidAlive(orphan)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400);

    await view.send('back');
    await until(() => texts(view).includes('echo: back'));
    expect(orphanAliveAtHistory).toBe(false);
    // One process on the id: the resumed agent, not the orphan.
    expect((await liveAgents(id)).map((e) => e.pid)).toEqual([manifestFor(id)!.agentPid]);

    const host = manifestFor(id)!.hostPid;
    await view.end();
    await until(() => !isPidAlive(host));
  }, 30_000);
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveClaudeBinary } from '../src/claude/binary';
import type { RunnerView } from '../src/claude/runner/runnerView';
import { HostSupervisor } from '../src/core/session/hostSupervisor';
import { readManifests } from '../src/core/session/manifestFile';
import { adoptHostedClaude, spawnHostedClaude } from '../src/core/session/remoteClaudeHandle';

/**
 * A session host driving the real `claude`, on `haiku`, in a scratch folder.
 * Opt-in (`AW_LIVE_CLAUDE=1`): it spends a few tiny turns. It prints only
 * lifecycle facts, never conversation content; do not paste its output
 * anywhere public regardless.
 */
const live = process.env.AW_LIVE_CLAUDE === '1';
const d = live ? describe : describe.skip;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-'));
const runDir = path.join(root, 'run');
const bundle = path.join(root, 'host.js');
const cwd = path.join(root, 'proj');
const noHistory = async () => ({ blocks: [], truncated: false });

function supervisor(): HostSupervisor {
  return new HostSupervisor({
    runDir,
    fallbackRunDir: path.join(root, 'fb'),
    logDir: path.join(root, 'logs'),
    runtime: { buildId: 'live', prepare: async () => ({ exe: process.execPath, entry: bundle }) },
    log: () => undefined,
    build: 'live',
  });
}

async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const said = (v: RunnerView, text: string) => v.blocks.some((b) => b.kind === 'assistant' && b.text.toLowerCase().includes(text));

d('session host with the real claude', () => {
  beforeAll(async () => {
    fs.mkdirSync(cwd, { recursive: true });
    await esbuild.build({
      entryPoints: ['src/sessionHost/main.ts'],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      outfile: bundle,
      define: { 'import.meta.url': '__aw_import_meta_url', AW_SDK_VERSION: '"live"' },
      banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
      logLevel: 'silent',
    });
  }, 60_000);

  afterAll(() => {
    for (const { manifest } of readManifests(runDir)) {
      for (const pid of [manifest.agentPid, manifest.hostPid]) if (alive(pid)) process.kill(pid!, 'SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs a turn, survives its client, and carries on after reattach', async () => {
    const binary = resolveClaudeBinary('');
    const id = crypto.randomUUID();
    const view = spawnHostedClaude({ cwd, sessionId: id, model: 'haiku' }, { supervisor: supervisor(), binary, log: () => undefined, loadHistory: noHistory });
    view.start();
    await view.send('Reply with exactly: pong');
    await until(() => said(view, 'pong'), 90_000);
    const m = readManifests(runDir).find((x) => x.manifest.sessionId === id)!.manifest;
    expect(alive(m.agentPid)).toBe(true);
    view.detach();

    const sup = supervisor();
    const manifest = sup.scan().alive.find((x) => x.sessionId === id)!;
    const again = adoptHostedClaude(manifest, { model: 'haiku' }, { supervisor: sup, binary, log: () => undefined, loadHistory: noHistory });
    again.start();
    await until(() => again.lifecycle === 'idle', 30_000);
    await again.send('Reply with exactly: ping');
    await until(() => said(again, 'ping'), 90_000);
    await again.end();
    await until(() => !alive(m.hostPid) && !alive(m.agentPid), 20_000);
  }, 240_000);

  it('records what a mid-ask orphan does with the PermissionRequest hook installed (playbook §11.5)', async () => {
    const binary = resolveClaudeBinary('');
    const id = crypto.randomUUID();
    const view = spawnHostedClaude({ cwd, sessionId: id, model: 'haiku', permissionMode: 'default' }, { supervisor: supervisor(), binary, log: () => undefined, loadHistory: noHistory });
    view.start();
    await view.send('Use the Write tool to create a file named orphan-check.txt containing the word hello. Do nothing else.');
    await until(() => view.blocks.some((b) => b.kind === 'permission' && b.state === 'pending'), 90_000);
    const m = readManifests(runDir).find((x) => x.manifest.sessionId === id)!.manifest;
    view.detach();
    process.kill(m.hostPid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 10_000));
    const stillThere = alive(m.agentPid);
    // eslint-disable-next-line no-console
    console.log(`mid-ask orphan with the hook installed: agent ${stillThere ? 'still alive after 10 s (waiting on the hook)' : 'exited within 10 s'}`);
    if (stillThere) process.kill(m.agentPid!, 'SIGTERM');
    await until(() => !alive(m.agentPid), 20_000);
  }, 240_000);
});

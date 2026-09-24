/**
 * The session host: a small detached process that owns one Claude Code
 * session so it outlives the Agent Wrangler app (playbook §5, Stage 3).
 *
 * Run by the core as `<runtime exe> dist/sessionHost/main.js` with
 * `ELECTRON_RUN_AS_NODE=1`, detached (its own session and process group,
 * reparented to launchd when the app goes), stdout and stderr to a log file.
 *
 * Life: read the boot line from stdin (token and launch options; never argv,
 * never env), close stdin, listen on the socket, write the manifest, start the
 * agent. It never exits because no client is connected. It exits when the
 * agent has exited and the exit has reached a client (or a minute has passed),
 * or on a signal, after ending the agent.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { query as sdkQuery, type Options, type SpawnedProcess, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkSession, type QueryFn } from '../claude/runner/claudeSdkSession';
import { startTimeOf } from '../core/procStart';
import { writeJsonAtomic } from '../core/session/manifestFile';
import type { HostBoot, HostEvent, HostManifest } from '../shared/sessionProtocol';
import { CONTROL_OPS, HOST_PROTOCOL_VERSION } from '../shared/sessionProtocol';
import { agentEnv } from './env';
import { fakeQuery } from './fakeQuery';
import { HostServer } from './server';

declare const AW_SDK_VERSION: string | undefined;
const SDK_VERSION = typeof AW_SDK_VERSION === 'string' ? AW_SDK_VERSION : 'unknown';

/** After the agent exits, how long to wait for a client to take the news before exiting anyway. */
const DRAIN_MS = 60_000;
/** On a signal, how long the agent gets after SIGTERM before SIGKILL. */
const SIGNAL_GRACE_MS = 5000;
/** How much of the agent's stderr an exit record keeps. */
const STDERR_TAIL_CHARS = 2000;

function log(hostId: string, msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] host ${hostId} pid ${process.pid}: ${msg}\n`);
}

function readBootLine(): Promise<HostBoot> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      process.stdin.off('data', onData);
      // Nothing else ever comes on stdin; closing it means no stray reader holds it.
      process.stdin.destroy();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as HostBoot);
      } catch (err) {
        reject(err);
      }
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', () => reject(new Error('stdin closed before the boot line')));
  });
}

async function main(): Promise<void> {
  const boot = await readBootLine();
  const say = (m: string) => log(boot.hostId, m);
  const fake = process.env.AW_SESSION_HOST_FAKE === '1';
  say(`start build=${boot.hostBuild} cwd=${boot.launch.cwd}${boot.launch.resume ? ` resume=${boot.launch.resume}` : ''}${fake ? ' (fake agent)' : ''}`);

  let agent: ChildProcess | undefined;
  let agentExit: { code: number | null; signal: string | null } | undefined;
  let stderrTail = '';
  const startedAt = Date.now();
  const manifest: HostManifest = {
    v: 1,
    hostId: boot.hostId,
    provider: 'claude',
    sessionId: boot.launch.resume ?? boot.launch.sessionId,
    cwd: boot.launch.cwd,
    hostPid: process.pid,
    hostStartTime: startTimeOf(process.pid),
    socketPath: boot.socketPath,
    protocol: HOST_PROTOCOL_VERSION,
    hostBuild: boot.hostBuild,
    runtimeDir: boot.runtimeDir,
    sdkVersion: SDK_VERSION,
    startedAt,
    launch: {
      resume: boot.launch.resume !== undefined,
      permissionMode: boot.launch.permissionMode,
      model: boot.launch.model,
      effort: boot.launch.effort,
      binary: boot.launch.binary,
    },
  };
  const writeManifest = () => {
    try {
      writeJsonAtomic(boot.manifestPath, manifest);
    } catch (err) {
      say(`could not write the manifest: ${String(err)}`);
    }
  };

  // The host spawns `claude` itself so it knows the pid (manifest, signals),
  // with an explicit environment (no ELECTRON_*, AW_* or LaunchServices vars).
  const spawnAgent = (o: SpawnOptions): SpawnedProcess => {
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    agent = child;
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      say(`claude stderr: ${text.trim().slice(0, 400)}`);
    });
    child.once('spawn', () => {
      manifest.agentPid = child.pid;
      manifest.agentStartTime = child.pid ? startTimeOf(child.pid) : undefined;
      writeManifest();
    });
    child.once('exit', (code, signal) => {
      agentExit = { code, signal };
      // The exit record may already be written (the SDK's stream can end first): complete it.
      if (manifest.exit && manifest.exit.code === undefined && manifest.exit.signal === undefined) {
        manifest.exit = { ...manifest.exit, code, signal };
        writeManifest();
      }
    });
    // The SDK aborts this after its own stdin-EOF grace; honour it.
    o.signal?.addEventListener('abort', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, { once: true });
    return child as unknown as SpawnedProcess;
  };
  const sdkOptions: Partial<Options> = fake ? {} : { env: agentEnv(process.env), spawnClaudeCodeProcess: spawnAgent };

  const session = new ClaudeSdkSession(
    {
      cwd: boot.launch.cwd,
      resume: boot.launch.resume,
      sessionId: boot.launch.sessionId,
      permissionMode: boot.launch.permissionMode,
      model: boot.launch.model,
      effort: boot.launch.effort,
    },
    { query: (fake ? fakeQuery : sdkQuery) as QueryFn, binary: boot.launch.binary, log: say, sdkOptions },
  );

  const server = new HostServer({
    session,
    token: boot.token,
    log: say,
    describe: () => ({
      hostId: boot.hostId,
      hostBuild: boot.hostBuild,
      provider: 'claude',
      sdkVersion: SDK_VERSION,
      cliVersion: manifest.cliVersion,
      hostPid: process.pid,
      agentPid: manifest.agentPid,
      agentStartTime: manifest.agentStartTime,
      cwd: boot.launch.cwd,
      startedAt,
      capabilities: ['wire.largeImagesOmitted', ...CONTROL_OPS.map((op) => `control.${op}`)],
    }),
  });
  // What only the host knows goes into the exit record: how the agent process
  // itself went, and the last of what it said on stderr.
  session.decorateExit = (exit) => ({
    ...exit,
    ...(agentExit && exit.code === undefined && exit.signal === undefined ? agentExit : {}),
    ...(stderrTail && exit.reason !== 'ended' && exit.reason !== 'stopped' ? { stderrTail } : {}),
  });
  await server.listen(boot.socketPath);
  // Only once listening: a manifest is a promise that the socket answers.
  writeManifest();
  say(`listening on ${boot.socketPath}`);

  let finishing = false;
  const finish = async (code: number) => {
    if (finishing) return;
    finishing = true;
    // Never leave the agent behind: a host that exits must take its `claude` with it.
    if (agent && agent.exitCode === null && agent.signalCode === null) {
      say('the agent is still running at exit; killing it');
      agent.kill('SIGKILL');
    }
    await server.close();
    try {
      fs.rmSync(boot.socketPath, { force: true });
    } catch {
      // gone
    }
    say(`exiting (${code})`);
    process.exit(code);
  };

  const onEvent = (e: HostEvent) => {
    if (e.type === 'sessionId' && e.sessionId !== manifest.sessionId) {
      manifest.sessionId = e.sessionId;
      writeManifest();
    }
    if (e.type === 'message') {
      const m = e.msg as { type?: string; subtype?: string; claude_code_version?: unknown };
      if (m.type === 'system' && m.subtype === 'init' && typeof m.claude_code_version === 'string' && !manifest.cliVersion) {
        manifest.cliVersion = m.claude_code_version;
        writeManifest();
      }
    }
    if (e.type === 'exit') {
      // The tombstone: how the core tells "ended" from "lost" after a restart.
      manifest.exit = { ...e.exit, at: Date.now(), lastSeq: e.seq };
      writeManifest();
      say(`agent exited${e.exit.error ? `: ${e.exit.error}` : ''}`);
      void drainThenExit(e.seq);
    }
  };
  session.subscribe(session.snapshot().seq, onEvent);

  const drainThenExit = async (exitSeq: number) => {
    const deadline = Date.now() + DRAIN_MS;
    while (Date.now() < deadline && !server.delivered(exitSeq)) await sleep(250);
    // A beat for the last reply to leave the socket.
    await sleep(250);
    await finish(0);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (finishing) return;
    say(`${signal}: ending the agent`);
    void (async () => {
      const exited = await session.terminate(SIGNAL_GRACE_MS, signal);
      if (!exited && agent && agent.exitCode === null) {
        agent.kill('SIGKILL');
        await sleep(500);
      }
      if (!manifest.exit) {
        manifest.exit = { reason: 'signal', hostSignal: signal, ...agentExit, at: Date.now(), lastSeq: session.snapshot().seq };
        writeManifest();
      }
      await finish(0);
    })();
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => onSignal(signal));

  process.on('uncaughtException', (err) => {
    say(`uncaught: ${err.stack ?? String(err)}`);
    try {
      agent?.kill('SIGTERM');
    } catch {
      // gone
    }
    if (!manifest.exit) {
      manifest.exit = {
        reason: 'crashed',
        error: `session host crashed: ${err.message}`,
        ...(stderrTail ? { stderrTail } : {}),
        at: Date.now(),
        lastSeq: session.snapshot().seq,
      };
      writeManifest();
    }
    process.exit(1);
  });

  session.start();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  process.stdout.write(`[${new Date().toISOString()}] host pid ${process.pid}: failed to start: ${String(err)}\n`);
  process.exit(1);
});

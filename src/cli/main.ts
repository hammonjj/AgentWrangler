/**
 * `aw`: Agent Wrangler from a terminal (Stage 8, #21).
 *
 * A client of the running app, never a supervisor: it talks only to the app's
 * control socket, and with the app quit it can only read (`status`,
 * `sessions`). Run by `bin/aw`, with the installed app's own runtime as Node.
 */
import { RpcRemoteError } from '../core/rpc/ndjsonPeer';
import { defaultRunDirs } from '../core/control/paths';
import {
  RPC_AMBIGUOUS,
  type ControlProjectsResult,
  type ControlSendResult,
  type ControlSessionClosed,
  type ControlSessionEvent,
  type ControlSessionResult,
  type ControlSessionsResult,
  type ControlStatusResult,
  type ControlStopResult,
  type ControlSubscribeParams,
  type ControlSubscribeResult,
  type ControlSessionRef,
  type ControlDelegateResult,
  type ControlTaskProposeParams,
  type ControlTaskProposeResult,
  type ControlTasksResult,
  type ControlWebLinkResult,
  type ControlWebDevicesResult,
  type ControlWebPairResult,
  type ControlWebRevokeResult,
} from '../core/control/protocol';
import { encodeQr, qrToTerminal } from '../core/web/qr';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { agentEnvironment, originOf, parseArgs, webRefusal, USAGE, type Command } from './args';
import { ATTACH_BACKLOG, AttachRenderer } from './attach';
import { ControlClient } from './client';
import {
  formatDelegation,
  formatOffline,
  formatProjects,
  formatProposal,
  formatSession,
  formatSessions,
  formatStatus,
  formatTasks,
  formatWebDevices,
  formatWebPair,
  safe,
} from './format';
import { readOfflineView } from './offline';
import { runDaemonCommand } from './daemon';
import { coreDaemonAgentFor } from '../node/coreDaemonAgent';

declare const AW_BUILD_ID: string | undefined;
const BUILD_ID = typeof AW_BUILD_ID === 'string' ? AW_BUILD_ID : 'dev';

const NOT_RUNNING = 'Agent Wrangler is not running. Open it, then try again.';

async function run(argv: string[]): Promise<number> {
  const cmd = parseArgs(argv);
  if ('error' in cmd) {
    process.stderr.write(`${cmd.error}\n`);
    return 2;
  }
  if (cmd.kind === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd.kind === 'version') {
    process.stdout.write(`aw (Agent Wrangler build ${BUILD_ID})\n`);
    return 0;
  }
  if (cmd.kind === 'send' || cmd.kind === 'stop') {
    const inside = agentEnvironment(process.env);
    if (inside) {
      process.stderr.write(
        `aw ${cmd.kind}: refused, because this shell looks like ${inside}. ` +
          'One agent must not drive another through aw; run it from your own terminal.\n',
      );
      return 3;
    }
  }
  // The same speed bump: a printed sign-in link is the whole workbench, every
  // session's controls included. `aw web open` hands it to the browser instead.
  if (cmd.kind === 'web' && cmd.action === 'url') {
    const inside = agentEnvironment(process.env);
    if (inside) {
      process.stderr.write(`aw web url: refused, because this shell looks like ${inside}. Run it from your own terminal, or use aw web open.\n`);
      return 3;
    }
  }
  // Pairing prints a code that lets a device in as you, and revoking signs
  // one of yours out: neither is for an agent to do (#137).
  const refusal = webRefusal(cmd, agentEnvironment(process.env));
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    return 3;
  }

  const dirs = defaultRunDirs();
  // Before connecting: the daemon commands work whether or not anything answers.
  if (cmd.kind === 'daemon') return daemonCommand(cmd, dirs);
  const client = await ControlClient.connect(dirs, { build: BUILD_ID });
  if (!client) return offline(cmd, dirs.userDataDir, dirs.runDir);
  if (client.hello.build !== BUILD_ID && BUILD_ID !== 'dev') {
    process.stderr.write(`note: the running core is build ${client.hello.build} and this aw is ${BUILD_ID}; run aw daemon start to move it onto this build.\n`);
  }
  try {
    return await online(cmd, client);
  } finally {
    if (cmd.kind !== 'attach') client.close();
  }
}

/**
 * `aw daemon …` (#130). The daemon runs from the same bundle (or checkout) as
 * this `aw`, so `aw daemon start` from a newer install is also the update.
 */
function daemonCommand(cmd: Extract<Command, { kind: 'daemon' }>, dirs: ReturnType<typeof defaultRunDirs>): Promise<number> {
  // Quiet: the runtime clone and launchctl log progress, which a terminal does not need.
  const log = (m: string) => {
    if (process.env.AW_DEBUG) process.stderr.write(`${m}\n`);
  };
  const agent = coreDaemonAgentFor(__dirname, dirs, log);
  return runDaemonCommand(cmd, agent, {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    env: process.env,
    now: Date.now,
  });
}

/** The app is quit: read what can be read, refuse the rest. */
function offline(cmd: Command, userDataDir: string, runDir: string): number {
  if (cmd.kind !== 'status' && cmd.kind !== 'sessions') {
    process.stderr.write(`${NOT_RUNNING}\n`);
    return 1;
  }
  const view = readOfflineView(userDataDir, runDir);
  if (cmd.json) {
    process.stdout.write(`${JSON.stringify({ appRunning: false, ...view }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatOffline(view, Date.now(), width(), cmd.kind === 'sessions')}\n`);
  }
  return 0;
}

async function online(cmd: Command, client: ControlClient): Promise<number> {
  const now = Date.now();
  const print = (value: unknown, text: () => string, json: boolean) =>
    process.stdout.write(`${json ? JSON.stringify(value, null, 2) : text()}\n`);
  switch (cmd.kind) {
    case 'status': {
      const st = await client.request<ControlStatusResult>('status');
      print({ appRunning: true, ...st },() => formatStatus(st, now), cmd.json);
      return 0;
    }
    case 'sessions': {
      const r = await client.request<ControlSessionsResult>('sessions', { all: cmd.all });
      print(r, () => formatSessions(r.sessions, now, width()), cmd.json);
      return 0;
    }
    case 'session': {
      const r = await client.request<ControlSessionResult>('session', { ref: cmd.ref });
      print(r, () => formatSession(r, now), cmd.json);
      return 0;
    }
    case 'projects': {
      const r = await client.request<ControlProjectsResult>('projects');
      print(r, () => formatProjects(r.projects, now, width()), cmd.json);
      return 0;
    }
    case 'send': {
      const text = cmd.text ?? (await readStdin());
      if (text.trim().length === 0) {
        process.stderr.write('aw send: the message is empty.\n');
        return 2;
      }
      const r = await client.request<ControlSendResult>('send', { ref: cmd.ref, text });
      if (r.outcome === 'applied') {
        process.stdout.write('Sent.\n');
        return 0;
      }
      process.stderr.write(
        r.reason
          ? `Not sent: ${r.reason}\n`
          : r.outcome === 'stale'
            ? 'Not sent: the session cannot take a message right now (it is starting, stopping, or its host is not answering).\n'
            : r.outcome === 'gone'
              ? 'Not sent: the session has ended.\n'
              : 'Not sent: this session cannot be sent messages.\n',
      );
      return 1;
    }
    case 'stop': {
      const r = await client.request<ControlStopResult>('stop', { ref: cmd.ref, force: cmd.force }, { timeoutMs: 60_000 });
      const message: Record<ControlStopResult['outcome'], string> = {
        stopped: 'Stopped. The conversation is kept; resume it from the app.',
        working: 'Not stopped: it is working right now, and stopping it throws that turn away. Add --force to stop it anyway.',
        nothing: 'Nothing to stop: no process is known for this session.',
        refused: 'Not stopped: the process could not be stopped (it ignored both signals, or could not be verified). End it from its own terminal.',
        hostRefused: 'Not stopped: the session host holding it did not stop. See the app log.',
      };
      // Outcomes may grow within v1: an unknown one is reported as itself.
      const text = (message as Record<string, string>)[r.outcome] ?? `Not stopped (${String(r.outcome)}).`;
      (r.outcome === 'stopped' ? process.stdout : process.stderr).write(`${text}\n`);
      return r.outcome === 'stopped' ? 0 : 1;
    }
    case 'attach':
      return attach(cmd.ref, client);
    case 'delegate':
    case 'task': {
      const objective = cmd.objective ?? (await readStdin());
      if (objective.trim().length === 0) {
        process.stderr.write(`aw ${cmd.kind}: the objective is empty.\n`);
        return 2;
      }
      const params: ControlTaskProposeParams = {
        folder: path.resolve(cmd.folder ?? process.cwd()),
        objective,
        acceptanceCriteria: cmd.criteria,
        ...(cmd.harness ? { harness: cmd.harness } : {}),
        ...(originOf(process.env) ? { origin: originOf(process.env) } : {}),
      };
      if (cmd.kind === 'delegate') {
        // The app answers within ~100 s, with the planner's decision or "still planning".
        const r = await client.request<ControlDelegateResult>('delegate', params, { timeoutMs: 180_000 });
        print(r, () => formatDelegation(r, params.origin !== undefined), cmd.json);
        return 0;
      }
      // Assessing is one model call, which can take longer than a read.
      const r = await client.request<ControlTaskProposeResult>('task.propose', params, { timeoutMs: 180_000 });
      print(r, () => formatProposal(r, params.origin !== undefined), cmd.json);
      return 0;
    }
    case 'tasks': {
      const r = await client.request<ControlTasksResult>('tasks');
      print(r, () => formatTasks(r.tasks, now), cmd.json);
      return 0;
    }
    case 'web': {
      const r = await client.request<ControlWebLinkResult>('web.link');
      if (cmd.action === 'url') {
        process.stdout.write(`${r.url}\n`);
        process.stderr.write('Good once, for 2 minutes. Anyone who opens it first is signed in as you.\n');
        return 0;
      }
      await openInBrowser(r.url);
      process.stdout.write('Opened Agent Wrangler in your browser.\n');
      return 0;
    }
    case 'webPair': {
      const r = await client.request<ControlWebPairResult>('web.pair');
      process.stdout.write(qrToTerminal(encodeQr(r.url, 'M'), { ansi: process.stdout.isTTY === true }));
      process.stdout.write(`\n${formatWebPair(r, Date.now())}\n`);
      return 0;
    }
    case 'webDevices': {
      const r = await client.request<ControlWebDevicesResult>('web.devices');
      print(r, () => formatWebDevices(r.devices, now, width()), cmd.json);
      return 0;
    }
    case 'webRevoke': {
      const r = await client.request<ControlWebRevokeResult>('web.devices.revoke', { id: cmd.id });
      process.stdout.write(`Revoked ${safe(r.device.name)} (${r.device.id.slice(0, 8)}). Its open tabs have been disconnected.\n`);
      return 0;
    }
    default:
      return 2;
  }
}

/** Follow until the session ends, the app goes, or Ctrl-C. */
function attach(ref: string, client: ControlClient): Promise<number> {
  const renderer = new AttachRenderer();
  const out = (lines: string[]) => {
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
  };
  return new Promise<number>((resolve, reject) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      client.close();
      resolve(code);
    };
    // Notifications may arrive before `subscribe` answers; hold them until the snapshot is out.
    const early: ControlSessionEvent[] = [];
    let started = false;
    client.onNotification((n) => {
      if (n.method === 'session.event') {
        const e = (n.params as ControlSessionEvent).event;
        if (started) out(renderer.event(e));
        else early.push(n.params as ControlSessionEvent);
      } else if (n.method === 'session.closed') {
        const reason = (n.params as ControlSessionClosed).reason;
        if (reason === 'gone') out(['— Agent Wrangler no longer runs this session']);
        if (reason === 'overflow') out(['— fell too far behind; run aw attach again']);
        finish(reason === 'overflow' ? 1 : 0);
      }
    });
    client.onClose(() => {
      if (!done) out(['— Agent Wrangler went away']);
      finish(1);
    });
    process.once('SIGINT', () => finish(0));
    client.request<ControlSubscribeResult>('subscribe', { ref, maxBlocks: ATTACH_BACKLOG } satisfies ControlSubscribeParams).then(
      (snap) => {
        out(renderer.start(snap.blocks, snap.truncated));
        started = true;
        for (const e of early) out(renderer.event(e.event));
        if (snap.lifecycle === 'ended' || snap.lifecycle === 'error') {
          out(['— the session has ended']);
          finish(0);
        }
      },
      (err) => {
        done = true;
        client.close();
        reject(err);
      },
    );
  });
}

/** The default browser, by macOS's `open`. The link is an argument, never through a shell. */
function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', [url], (err) => (err ? reject(new Error(`could not open the browser: ${err.message}`)) : resolve()));
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function width(): number {
  return process.stdout.columns && process.stdout.columns > 40 ? process.stdout.columns : 100;
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof RpcRemoteError) {
      process.stderr.write(`aw: ${err.message}\n`);
      if (err.code === RPC_AMBIGUOUS) {
        const matches = ((err.data as { matches?: ControlSessionRef[] } | undefined)?.matches ?? []).slice(0, 10);
        for (const m of matches) process.stderr.write(`  ${m.sessionId}  ${m.title}\n`);
      }
    } else {
      process.stderr.write(`aw: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  },
);

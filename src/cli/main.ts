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
} from '../core/control/protocol';
import { agentEnvironment, parseArgs, USAGE, type Command } from './args';
import { ATTACH_BACKLOG, AttachRenderer } from './attach';
import { ControlClient } from './client';
import { formatOffline, formatProjects, formatSession, formatSessions, formatStatus } from './format';
import { readOfflineView } from './offline';

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

  const dirs = defaultRunDirs();
  const client = await ControlClient.connect(dirs, { build: BUILD_ID });
  if (!client) return offline(cmd, dirs.userDataDir, dirs.runDir);
  if (client.hello.build !== BUILD_ID && BUILD_ID !== 'dev') {
    process.stderr.write(`note: the running app is build ${client.hello.build} and this aw is ${BUILD_ID}; restart the app to match.\n`);
  }
  try {
    return await online(cmd, client);
  } finally {
    if (cmd.kind !== 'attach') client.close();
  }
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

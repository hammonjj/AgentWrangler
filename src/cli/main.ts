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
  type ControlRenameResult,
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
  type ControlAgentProposeParams,
  type ControlAgentProposeResult,
  type ControlTaskProposeParams,
  type ControlTaskProposeResult,
  type ControlTasksResult,
  type ControlWebLinkResult,
  type ControlWebDevicesResult,
  type ControlWebPairResult,
  type ControlWebRevokeResult,
  type ControlMissionsParams,
  type ControlMissionsResult,
  type ControlMissionParams,
  type ControlMissionResult,
  type ControlMissionActParams,
  type ControlMissionActResult,
  type ControlChildSpawnParams,
  type ControlChildSpawnResult,
  type ControlChildListResult,
  type ControlChildSendParams,
  type ControlChildReadParams,
  type ControlChildReadResult,
  type ControlChildDoneResult,
} from '../core/control/protocol';
import { encodeQr, qrToTerminal } from '../core/web/qr';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { agentEnvironment, agentShellRefusal, originOf, parseArgs, USAGE, type Command } from './args';
import { ATTACH_BACKLOG, AttachRenderer } from './attach';
import { ControlClient } from './client';
import {
  formatChildDone,
  formatChildList,
  formatChildReadHead,
  formatChildSpawn,
  formatDelegation,
  formatMission,
  formatMissionAct,
  formatMissions,
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
  // The agent-shell speed bumps, in one list (`agentShellRefusal`): `send` and
  // `stop` (one agent must not drive another), `rename --session` (an agent
  // names only its own conversation), `web url` (a printed sign-in link is the
  // whole workbench; `aw web open` hands it to the browser instead), and
  // pairing and revoking (#137).
  const refusal = agentShellRefusal(cmd, agentEnvironment(process.env));
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
    case 'rename': {
      const origin = originOf(process.env);
      const target = cmd.ref ?? (origin ? `${origin.provider}:${origin.sessionId}` : undefined);
      if (!target) {
        process.stderr.write('aw rename: which session? Run it inside a Claude Code or Codex conversation, or give --session <id>.\n');
        return 2;
      }
      const r = await client.request<ControlRenameResult>('rename', { ref: target, name: cmd.name });
      print(r, () => (cmd.name ? `Renamed to ${safe(r.title)}.` : `Cleared. It shows as ${safe(r.title)} again.`), cmd.json);
      return 0;
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
    case 'missions': {
      const origin = originOf(process.env);
      const r = await client.request<ControlMissionsResult>('missions', { all: cmd.all, mine: cmd.mine, ...(origin ? { origin } : {}) } satisfies ControlMissionsParams);
      print(r, () => formatMissions(r, now, width()), cmd.json);
      return 0;
    }
    case 'mission': {
      const origin = originOf(process.env);
      const r = await client.request<ControlMissionResult>('mission', { ref: cmd.ref, ...(origin ? { origin } : {}) } satisfies ControlMissionParams);
      print(r, () => formatMission(r, now), cmd.json);
      return 0;
    }
    case 'missionAct': {
      // The grant is a durable agent's, so this runs as the agent whose
      // conversation this shell is, never as you. From your own terminal,
      // the Missions page is where you accept, finish or cancel.
      const origin = originOf(process.env);
      if (!origin) {
        process.stderr.write(`aw mission ${cmd.act}: run this inside a durable agent's conversation, under its mission grant. To act on a mission yourself, use Missions in the app (aw web open).\n`);
        return 2;
      }
      const params: ControlMissionActParams = { origin, ref: cmd.ref, act: cmd.act, ...(cmd.how ? { how: cmd.how } : {}), ...(cmd.task ? { task: cmd.task } : {}) };
      // A finish can merge or push and open a PR, which takes longer than a read.
      const r = await client.request<ControlMissionActResult>('mission.act', params, { timeoutMs: 180_000 });
      print(r, () => formatMissionAct(r), cmd.json);
      return r.outcome === 'done' || r.outcome === 'requested' ? 0 : 1;
    }
    case 'remember':
    case 'forget': {
      const origin = originOf(process.env);
      if (!origin) {
        process.stderr.write(`aw ${cmd.kind}: run this inside a durable agent's conversation. To change an agent's memory yourself, use Agents in the app.\n`);
        return 2;
      }
      const text = cmd.kind === 'remember' ? (cmd.text ?? (await readStdin())) : undefined;
      if (cmd.kind === 'remember' && !text?.trim()) {
        process.stderr.write('aw remember: the note is empty.\n');
        return 2;
      }
      const params: ControlAgentProposeParams =
        cmd.kind === 'remember'
          ? { origin, op: 'add', text: text!, ...(cmd.memoryKind ? { kind: cmd.memoryKind } : {}) }
          : { origin, op: 'forget', itemId: cmd.itemId };
      const r = await client.request<ControlAgentProposeResult>('agent.propose', params);
      print(
        r,
        () =>
          r.proposalId
            ? `Proposed to ${safe(r.agent)}'s user. Nothing is stored until they approve it in Agent Wrangler; carry on without waiting.`
            : `Nothing new: ${safe(r.agent)}'s memory already says that, or the same proposal is waiting.`,
        cmd.json,
      );
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
      process.stdout.write(qrToTerminal(encodeQr(r.setupUrl ?? r.url, 'M'), { ansi: process.stdout.isTTY === true }));
      process.stdout.write(`\n${formatWebPair(r, Date.now())}\n`);
      return 0;
    }
    case 'webDevices': {
      const r = await client.request<ControlWebDevicesResult>('web.devices');
      print(r, () => formatWebDevices(r.devices, now, width()), cmd.json);
      return 0;
    }
    case 'childSpawn':
    case 'childList':
    case 'childSend':
    case 'childRead':
    case 'childStop':
    case 'childDone':
      return child(cmd, client, now);
    case 'webRevoke': {
      const r = await client.request<ControlWebRevokeResult>('web.devices.revoke', { id: cmd.id });
      process.stdout.write(`Revoked ${safe(r.device.name)} (${r.device.id.slice(0, 8)}). Its open tabs have been disconnected.\n`);
      return 0;
    }
    default:
      return 2;
  }
}

/**
 * `aw child …` (#198). Runs as the durable agent whose conversation this
 * shell is: the core refuses it from anywhere else, and on any session that
 * is not one of that agent's own children.
 */
async function child(
  cmd: Extract<Command, { kind: 'childSpawn' | 'childList' | 'childSend' | 'childRead' | 'childStop' | 'childDone' }>,
  client: ControlClient,
  now: number,
): Promise<number> {
  const origin = originOf(process.env);
  if (!origin) {
    process.stderr.write("aw child: run this inside a durable agent's conversation. Children belong to the agent that started them.\n");
    return 2;
  }
  const print = (value: unknown, text: () => string, json: boolean) => process.stdout.write(`${json ? JSON.stringify(value, null, 2) : text()}\n`);
  switch (cmd.kind) {
    case 'childSpawn': {
      const prompt = cmd.prompt ?? (await readStdin());
      if (prompt.trim().length === 0) {
        process.stderr.write('aw child spawn: the prompt is empty.\n');
        return 2;
      }
      const params: ControlChildSpawnParams = {
        origin,
        prompt,
        ...(cmd.provider ? { provider: cmd.provider } : {}),
        ...(cmd.folder !== undefined ? { folder: path.resolve(cmd.folder) } : {}),
        ...(cmd.name !== undefined ? { name: cmd.name } : {}),
      };
      // Cutting a worktree and starting a session takes longer than a read.
      const r = await client.request<ControlChildSpawnResult>('child.spawn', params, { timeoutMs: 180_000 });
      print(r, () => formatChildSpawn(r), cmd.json);
      return 0;
    }
    case 'childList': {
      const r = await client.request<ControlChildListResult>('child.list', { origin });
      print(r, () => formatChildList(r, now, width()), cmd.json);
      return 0;
    }
    case 'childSend': {
      const text = cmd.text ?? (await readStdin());
      if (text.trim().length === 0) {
        process.stderr.write('aw child send: the message is empty.\n');
        return 2;
      }
      const r = await client.request<ControlSendResult>('child.send', { origin, ref: cmd.ref, text } satisfies ControlChildSendParams, { timeoutMs: 120_000 });
      if (r.outcome === 'applied') {
        process.stdout.write('Sent.\n');
        return 0;
      }
      process.stderr.write(r.reason ? `Not sent: ${r.reason}\n` : `Not sent (${String(r.outcome)}).\n`);
      return 1;
    }
    case 'childRead': {
      const r = await client.request<ControlChildReadResult>('child.read', { origin, ref: cmd.ref, ...(cmd.last ? { last: cmd.last } : {}) } satisfies ControlChildReadParams);
      if (cmd.json) {
        print(r, () => '', true);
        return 0;
      }
      process.stdout.write(`${formatChildReadHead(r)}\n`);
      const lines = new AttachRenderer().start(r.blocks, r.truncated);
      if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    case 'childStop': {
      const r = await client.request<ControlStopResult>('child.stop', { origin, ref: cmd.ref, force: cmd.force }, { timeoutMs: 60_000 });
      const ok = r.outcome === 'stopped' || r.outcome === 'nothing';
      (ok ? process.stdout : process.stderr).write(
        r.outcome === 'stopped' ? 'Stopped. Its conversation and worktree are kept.\n' : r.outcome === 'working' ? 'Not stopped: it is working right now. Add --force to stop it anyway.\n' : r.outcome === 'nothing' ? 'Nothing to stop: it is not running.\n' : `Not stopped (${String(r.outcome)}).\n`,
      );
      return ok ? 0 : 1;
    }
    case 'childDone': {
      const r = await client.request<ControlChildDoneResult>('child.done', { origin, ref: cmd.ref, discard: cmd.discard }, { timeoutMs: 120_000 });
      print(r, () => formatChildDone(r), cmd.json);
      return r.outcome === 'done' ? 0 : 1;
    }
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

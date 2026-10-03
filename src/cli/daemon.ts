/**
 * `aw daemon start|stop|status` (#130): the core daemon from a terminal.
 *
 * Unlike every other command these do not go through the control socket:
 * `start` is how there comes to be one, and `stop` and `status` work from the
 * daemon's manifest and a probe of the socket. The work is
 * `src/node/coreDaemonAgent.ts`; this is the wording and the exit codes.
 */
import { describeCoreHolder, formatUptime } from '../core/daemon/coreDaemon';
import { CoreDaemonError, type CoreDaemonAgent } from '../node/coreDaemonAgent';
import { agentEnvironment } from './args';

export interface DaemonCommand {
  action: 'start' | 'stop' | 'status';
  all: boolean;
  json: boolean;
}

export interface DaemonIo {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  now(): number;
}

/** The exit code: 0 done (or running, for status), 1 not done (or not running), 3 refused. */
export async function runDaemonCommand(cmd: DaemonCommand, agent: Pick<CoreDaemonAgent, 'ensure' | 'stop' | 'status'>, io: DaemonIo): Promise<number> {
  try {
    switch (cmd.action) {
      case 'start': {
        const { outcome, manifest } = await agent.ensure();
        const what: Record<typeof outcome, string> = {
          running: 'The core daemon is already running',
          started: 'Started the core daemon',
          installed: 'Installed and started the core daemon',
          updated: 'Updated the core daemon to this build and started it',
          spawned: 'Started the core daemon (from this checkout, without a LaunchAgent)',
        };
        io.out(`${what[outcome]}: pid ${manifest.pid}, build ${manifest.build}.\n`);
        return 0;
      }
      case 'stop': {
        // A plain stop leaves every hosted conversation running, as a restart
        // does; --all ends them, this shell's own agent possibly among them.
        if (cmd.all) {
          const inside = agentEnvironment(io.env);
          if (inside) {
            io.err(`aw daemon stop --all: refused, because this shell looks like ${inside}. It ends every hosted conversation; run it from your own terminal.\n`);
            return 3;
          }
        }
        const r = await agent.stop(cmd.all);
        switch (r.outcome) {
          case 'stopped':
            io.out(
              cmd.all
                ? `Stopped the core daemon (pid ${r.pid}) and the conversations it ran.\n`
                : `Stopped the core daemon (pid ${r.pid}). Conversations in session hosts keep running; the next start reattaches them.\n`,
            );
            return 0;
          case 'not-running':
            io.out('The core daemon is not running.\n');
            return 0;
          case 'app':
            io.err('The Agent Wrangler app is running the core, not the daemon. Quit the app instead.\n');
            return 1;
          case 'timeout':
            io.err(`The core daemon (pid ${r.pid}) has not exited yet. It may still be ending agents; check aw daemon status in a moment.\n`);
            return 1;
        }
        return 1;
      }
      case 'status': {
        const st = await agent.status();
        const h = st.holder;
        if (cmd.json) {
          const running = h.kind === 'daemon';
          io.out(
            `${JSON.stringify(
              {
                running,
                holder: h.kind,
                ...(running ? { pid: h.manifest.pid, build: h.manifest.build, startedAt: h.manifest.startedAt, uptimeMs: io.now() - h.manifest.startedAt } : {}),
                launchAgent: st.launchAgent,
              },
              null,
              2,
            )}\n`,
          );
          return running ? 0 : 1;
        }
        const agentLine = st.launchAgent ? `LaunchAgent: installed (${st.plistPath})` : 'LaunchAgent: not installed';
        if (h.kind === 'daemon') {
          io.out(
            `Core daemon: running\n  pid      ${h.manifest.pid}\n  build    ${h.manifest.build}\n  uptime   ${formatUptime(io.now() - h.manifest.startedAt)}\n  ${agentLine}\n`,
          );
          return 0;
        }
        io.out(`Core daemon: not running (${describeCoreHolder(h, io.now())})\n  ${agentLine}\n`);
        return 1;
      }
    }
  } catch (err) {
    if (err instanceof CoreDaemonError) {
      io.err(`aw daemon ${cmd.action}: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

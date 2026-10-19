/**
 * Session hosts that run in this process: a stand-in for `HostSupervisor`
 * whose "host" is a `ClaudeSdkSession` over the given `query`.
 *
 * The app never uses it: every Claude conversation it runs is in a real,
 * detached session host (#122). Tests and the simulated harness drive whole
 * sessions through `RunnerService` with it, over a scripted `query`, without
 * spawning a process per session. Its sessions read as hosted — they can be
 * let go of without ending — so `RunnerService` treats them exactly as it
 * treats the app's.
 */
import { ClaudeSdkSession, type QueryFn } from '../claude/runner/claudeSdkSession';
import type { ClaudeExecution } from '../claude/runner/runnerView';
import type { HostLaunch } from '../core/session/hostSupervisor';
import type { SessionHosts } from '../core/session/remoteClaudeHandle';

/**
 * A real host's replay ring is 16 MiB, for a core that reconnects late. Here
 * the view subscribes from the first event, so the ring only has to exist.
 */
const IN_PROCESS_RING_BYTES = 1024 * 1024;

export interface InProcessHostsDeps {
  query: QueryFn;
  log?: (msg: string) => void;
  localKey?: (ref: string) => Promise<string | undefined>;
}

export interface InProcessHosts extends SessionHosts {
  /** Every launch, in order, as `RunnerService` asked for it. */
  readonly launches: HostLaunch[];
}

export function inProcessHosts(deps: InProcessHostsDeps): InProcessHosts {
  const launches: HostLaunch[] = [];
  const log = deps.log ?? (() => undefined);
  return {
    launches,
    spawn(launch) {
      launches.push(launch);
      // The same mapping `HostSupervisor` writes into a host's boot record.
      const session = new ClaudeSdkSession(
        {
          cwd: launch.cwd,
          resume: launch.resume ? launch.sessionId : undefined,
          sessionId: launch.resume ? undefined : launch.sessionId,
          forkFrom: launch.forkFrom && !launch.resume ? launch.forkFrom : undefined,
          permissionMode: launch.permissionMode,
          model: launch.model,
          effort: launch.effort,
          policy: launch.policy?.claude,
        },
        { query: deps.query, binary: launch.binary, log, ringBytes: IN_PROCESS_RING_BYTES, localKey: deps.localKey },
      );
      // Letting go does not end it, as with a real host: it simply runs on unwatched.
      const client: ClaudeExecution = Object.assign(session, { detach: () => undefined });
      return { client };
    },
    attach() {
      throw new Error('in-process hosts do not outlive the process, so there is nothing to reattach to');
    },
  };
}

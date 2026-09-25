/**
 * A Claude session run in a session host: the same `RunnerView` as an
 * in-process one, fed by a `HostClient` over the host's socket instead of by
 * a `ClaudeSdkSession` in this process (playbook §5.1, Stage 3).
 */
import { RunnerView, type ClaudeExecution, type MigrateExecution } from '../../claude/runner/runnerView';
import type { ConversationHistory } from '../../claude/transcriptHistory';
import type { LaunchPolicy } from '../../shared/launchPolicy';
import type { HostManifest } from '../../shared/sessionProtocol';
import type { PermissionModeName } from '../../shared/conversation';
import type { HostSupervisor } from './hostSupervisor';
import type { LaunchRequest } from './sessionHandle';

export interface RemoteClaudeDeps {
  supervisor: HostSupervisor;
  binary: string;
  log: (msg: string) => void;
  loadHistory?: (sessionId: string, cwd: string) => Promise<ConversationHistory>;
  /**
   * Run before a host resumes an id that something may still hold: the
   * orphan sweep (§7.3). Rejects when resuming is not safe. Used by version
   * migration (§7.4); a first resume is swept by its caller.
   */
  beforeResume?: (sessionId: string) => Promise<void>;
}

/** Start a new host for a session. `request.sessionId` or `request.resume` must be set. Not started: call `start()`. */
export function spawnHostedClaude(request: Omit<LaunchRequest, 'provider'>, deps: RemoteClaudeDeps): RunnerView {
  const sessionId = request.resume ?? request.sessionId;
  if (!sessionId) throw new Error('a hosted session needs its id before it starts');
  const { client } = deps.supervisor.spawn({
    cwd: request.cwd,
    sessionId,
    resume: request.resume !== undefined,
    permissionMode: request.permissionMode,
    model: request.model,
    effort: request.effort,
    binary: deps.binary,
    policy: request.policy,
    origin: request.origin,
  });
  return new RunnerView(
    {
      cwd: request.cwd,
      resume: request.resume,
      sessionId: request.resume ? undefined : sessionId,
      permissionMode: request.permissionMode,
      model: request.model,
      effort: request.effort,
      origin: request.origin,
      policy: request.policy,
    },
    { exec: client, log: deps.log, loadHistory: deps.loadHistory, migrate: migrator(sessionId, request.cwd, request.origin, deps) },
  );
}

/**
 * Reattach to a host a previous run of the app left running. The transcript
 * is read first: it is the view's history, and the host's ring is replayed
 * without the messages it already holds. The host is already running under
 * its policy; `launch.policy` is what a later migration re-applies.
 */
export function adoptHostedClaude(
  manifest: HostManifest,
  launch: { permissionMode?: PermissionModeName; model?: string; effort?: string; origin?: unknown; policy?: LaunchPolicy },
  deps: RemoteClaudeDeps,
): RunnerView {
  const history: Promise<ConversationHistory> =
    manifest.sessionId && deps.loadHistory
      ? deps.loadHistory(manifest.sessionId, manifest.cwd).catch(() => ({ blocks: [], truncated: false }))
      : Promise.resolve({ blocks: [], truncated: false });
  const client = deps.supervisor.attach(
    manifest,
    history.then((h) => h.uuids ?? new Set<string>()),
  );
  return new RunnerView(
    { cwd: manifest.cwd, sessionId: manifest.sessionId, history, ...launch },
    {
      exec: client,
      log: deps.log,
      migrate: manifest.sessionId ? migrator(manifest.sessionId, manifest.cwd, launch.origin ?? manifest.origin, deps) : undefined,
    },
  );
}

/**
 * The new host a version migration moves a session to: swept first, then a
 * fresh host of this build resuming the same id, on the view's current model,
 * mode and effort, under the policy it was launched with (§7.4). The view
 * names the id: a `/clear` inside the old host gave it a new one, and that is
 * the one to resume. `origin` does not change over a session's life, so the
 * new manifest carries the old one's.
 */
function migrator(initialId: string, cwd: string, origin: unknown, deps: RemoteClaudeDeps): MigrateExecution {
  return async (launch): Promise<ClaudeExecution> => {
    const sessionId = launch.sessionId ?? initialId;
    await deps.beforeResume?.(sessionId);
    const { client } = deps.supervisor.spawn({
      cwd,
      sessionId,
      resume: true,
      permissionMode: launch.permissionMode,
      model: launch.model,
      effort: launch.effort,
      binary: deps.binary,
      policy: launch.policy,
      origin,
    });
    return client;
  };
}

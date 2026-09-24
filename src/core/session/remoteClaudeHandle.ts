/**
 * A Claude session run in a session host: the same `RunnerView` as an
 * in-process one, fed by a `HostClient` over the host's socket instead of by
 * a `ClaudeSdkSession` in this process (playbook §5.1, Stage 3).
 */
import { RunnerView } from '../../claude/runner/runnerView';
import type { ConversationHistory } from '../../claude/transcriptHistory';
import type { HostManifest } from '../../shared/sessionProtocol';
import type { PermissionModeName } from '../../shared/conversation';
import type { HostSupervisor } from './hostSupervisor';
import type { LaunchRequest } from './sessionHandle';

export interface RemoteClaudeDeps {
  supervisor: HostSupervisor;
  binary: string;
  log: (msg: string) => void;
  loadHistory?: (sessionId: string, cwd: string) => Promise<ConversationHistory>;
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
    },
    { exec: client, log: deps.log, loadHistory: deps.loadHistory },
  );
}

/**
 * Reattach to a host a previous run of the app left running. The transcript
 * is read first: it is the view's history, and the host's ring is replayed
 * without the messages it already holds.
 */
export function adoptHostedClaude(
  manifest: HostManifest,
  launch: { permissionMode?: PermissionModeName; model?: string; effort?: string; origin?: unknown },
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
    { exec: client, log: deps.log },
  );
}

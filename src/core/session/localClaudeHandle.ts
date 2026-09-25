/**
 * A Claude session run in this process: `RunnerView` (translation, the handle)
 * over `ClaudeSdkSession` (execution). Stage 3 adds the remote twin, the same
 * `RunnerView` fed by a session host over a socket.
 */
import { ClaudeSdkSession, type QueryFn } from '../../claude/runner/claudeSdkSession';
import { RunnerView } from '../../claude/runner/runnerView';
import type { ConversationHistory } from '../../claude/transcriptHistory';
import type { LaunchRequest } from './sessionHandle';

const IN_PROCESS_RING_BYTES = 1024 * 1024;

export interface LocalClaudeDeps {
  query: QueryFn;
  binary: string;
  log: (msg: string) => void;
  loadHistory?: (sessionId: string, cwd: string) => Promise<ConversationHistory>;
}

/** Build a local Claude handle. It is not started: call `start()` once listeners are attached. */
export function createLocalClaudeHandle(request: Omit<LaunchRequest, 'provider'>, deps: LocalClaudeDeps): RunnerView {
  const exec = new ClaudeSdkSession(
    {
      cwd: request.cwd,
      resume: request.resume,
      sessionId: request.sessionId,
      permissionMode: request.permissionMode,
      model: request.model,
      effort: request.effort,
      policy: request.policy?.claude,
    },
    // In-process, the view subscribes from the first event and nothing joins
    // late, so the replay ring only has to exist, not to be deep. The 16 MiB
    // default is for the Stage 3 host, where a reconnecting core needs it.
    { query: deps.query, binary: deps.binary, log: deps.log, ringBytes: IN_PROCESS_RING_BYTES },
  );
  return new RunnerView(
    {
      cwd: request.cwd,
      resume: request.resume,
      sessionId: request.sessionId,
      permissionMode: request.permissionMode,
      model: request.model,
      effort: request.effort,
      origin: request.origin,
      policy: request.policy,
    },
    { exec, log: deps.log, loadHistory: deps.loadHistory },
  );
}

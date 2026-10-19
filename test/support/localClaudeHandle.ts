/**
 * Tests only: a `RunnerView` (translation, the handle) straight over a
 * `ClaudeSdkSession` (execution) in this process, with no host in between,
 * for tests of the view itself. The app has no such path: every Claude
 * conversation runs in a session host (#122). Tests that need a whole
 * `RunnerService` use `inProcessHosts` instead.
 */
import { ClaudeSdkSession, type QueryFn } from '../../src/claude/runner/claudeSdkSession';
import { RunnerView } from '../../src/claude/runner/runnerView';
import type { ConversationHistory } from '../../src/claude/transcriptHistory';
import type { LaunchRequest } from '../../src/core/session/sessionHandle';

const IN_PROCESS_RING_BYTES = 1024 * 1024;

export interface LocalClaudeDeps {
  query: QueryFn;
  binary: string;
  log: (msg: string) => void;
  loadHistory?: (sessionId: string, cwd: string) => Promise<ConversationHistory>;
  localKey?: (ref: string) => Promise<string | undefined>;
}

/** Build a local Claude handle. It is not started: call `start()` once listeners are attached. */
export function createLocalClaudeHandle(request: Omit<LaunchRequest, 'provider'>, deps: LocalClaudeDeps): RunnerView {
  const exec = new ClaudeSdkSession(
    {
      cwd: request.cwd,
      resume: request.resume,
      sessionId: request.sessionId,
      forkFrom: request.forkFrom,
      permissionMode: request.permissionMode,
      model: request.model,
      effort: request.effort,
      policy: request.policy?.claude,
    },
    // In-process, the view subscribes from the first event and nothing joins
    // late, so the replay ring only has to exist, not to be deep. The 16 MiB
    // default is for the Stage 3 host, where a reconnecting core needs it.
    { query: deps.query, binary: deps.binary, log: deps.log, ringBytes: IN_PROCESS_RING_BYTES, localKey: deps.localKey },
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

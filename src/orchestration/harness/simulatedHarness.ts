/**
 * The simulated harness (plan §26.3, #30): orchestration's tests run whole
 * attempts without an agent, without the network and without spending
 * anything, through **the same launch path as a real attempt**.
 *
 * It is the Claude Code adapter with a script attached. Each launch looks up
 * the next scripted attempt for its task (`origin.taskId`, in launch order),
 * puts the script at the head of the prompt (`withSimDirective`), and launches
 * through the `SessionExecutors` it was given. Whatever plays the Claude side
 * of those executors reads the script back:
 * - an in-process `RunnerService` built with `simulatedQuery`
 *   (`createSimulatedExecutors`), which is what vitest uses; or
 * - a `RunnerService` with session hosts on and `AW_SESSION_HOST_FAKE=1`,
 *   whose fake agent (`fakeQuery`) plays the same script in a real, detached host.
 *
 * Either way the registry record, the handle, the turn events and the files
 * written into the worktree are real.
 */
import { SessionExecutors } from '../../core/session/sessionExecutors';
import type { SessionHandle } from '../../core/session/sessionHandle';
import type { ExecutorRegistry } from '../../core/session/sessionRegistry';
import { RunnerService } from '../../claude/runner/runnerService';
import { simulatedQuery } from '../../sessionHost/simulatedAgent';
import type { ModelChoice } from '../../shared/conversation';
import type { HarnessId } from '../../shared/orchestration/types';
import { parseSimScenario, withSimDirective, type SimAttempt, type SimScenario } from '../../shared/orchestration/simulation';
import { ClaudeCodeHarness } from './claudeCodeHarness';
import type { AgentHarness, AttemptLaunch, HarnessCapabilities } from './types';

export interface SimulatedHarnessOptions {
  scenario: SimScenario;
  /** The executors to launch through: `createSimulatedExecutors().sessions`, or a hosted set. */
  sessions: Pick<SessionExecutors, 'launch'>;
  /**
   * The harness id it answers to (default `claude-code`), so routing,
   * telemetry and recovery treat its attempts like a real harness's.
   */
  id?: HarnessId;
  models?: ModelChoice[];
}

/** One launch the simulated harness made, for tests to assert on. */
export interface SimulatedLaunch {
  request: AttemptLaunch;
  attempt: SimAttempt;
  handle: SessionHandle;
}

export class SimulatedHarness implements AgentHarness {
  readonly id: HarnessId;
  private readonly scenario: SimScenario;
  private readonly inner: ClaudeCodeHarness;
  private readonly launchedPerTask = new Map<string, number>();
  readonly launches: SimulatedLaunch[] = [];

  constructor(opts: SimulatedHarnessOptions) {
    this.id = opts.id ?? 'claude-code';
    this.scenario = parseSimScenario(opts.scenario);
    const models = opts.models ?? [{ value: 'claude-simulated', label: 'Simulated', provider: 'anthropic' }];
    this.inner = new ClaudeCodeHarness({ sessions: opts.sessions, models: () => models });
  }

  capabilities(): HarnessCapabilities {
    return this.inner.capabilities();
  }

  models(): Promise<ModelChoice[]> {
    return this.inner.models();
  }

  /** The script the next launch for this task will play. */
  nextAttempt(taskId: string): SimAttempt {
    const n = this.launchedPerTask.get(taskId) ?? 0;
    const attempt = this.scenario.tasks?.[taskId]?.[n] ?? this.scenario.default;
    if (!attempt) throw new Error(`simulated harness: no scripted attempt ${n + 1} for task ${taskId}, and no default`);
    return attempt;
  }

  async launch(req: AttemptLaunch): Promise<SessionHandle> {
    if (req.target.harness !== this.id) throw new Error(`The ${this.id} harness cannot launch a ${req.target.harness} target`);
    const attempt = this.nextAttempt(req.origin.taskId);
    this.launchedPerTask.set(req.origin.taskId, (this.launchedPerTask.get(req.origin.taskId) ?? 0) + 1);
    const handle = await this.inner.launch({
      ...req,
      target: { ...req.target, harness: 'claude-code' },
      prompt: withSimDirective(attempt, req.prompt),
    });
    this.launches.push({ request: req, attempt, handle });
    return handle;
  }
}

/**
 * The executors a simulated harness launches through in tests: a real
 * `RunnerService` (the Claude `SessionExecutor`) whose sessions run
 * `simulatedQuery` in-process instead of the SDK. Pass a registry to see
 * the records attempts leave.
 */
export function createSimulatedExecutors(opts: { registry?: ExecutorRegistry; log?: (msg: string) => void } = {}): {
  sessions: SessionExecutors;
  runners: RunnerService;
} {
  const runners = new RunnerService({
    query: simulatedQuery,
    binary: () => '/simulated/claude',
    log: opts.log ?? (() => undefined),
    registry: opts.registry,
    // A simulated session has no transcript on disk.
    loadHistory: async () => ({ blocks: [], truncated: false }),
  });
  return { sessions: new SessionExecutors([runners]), runners };
}

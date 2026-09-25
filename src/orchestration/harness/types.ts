/**
 * The harness seam (`docs/plans/intelligent-orchestration.md` §6.1–6.2, #30).
 *
 * A harness is an agent loop that works in a directory: Claude Code, Codex.
 * Orchestration launches work only through an `AgentHarness`, and the
 * adapters behind it are the only orchestration code that touches #4's
 * `SessionExecutors`. The simulated harness sits behind the same interface
 * and the same executors, so a test that drives it drives the real launch path.
 */
import type { SessionHandle } from '../../core/session/sessionHandle';
import type { ModelChoice, PermissionModeName } from '../../shared/conversation';
import type { LaunchPolicy } from '../../shared/launchPolicy';
import type { ExecutionTarget, HarnessId, OrchestrationOrigin } from '../../shared/orchestration/types';

/**
 * What a harness can do **through its adapter**, which is what orchestration
 * can rely on. A capability the agent has but AW cannot yet pass through
 * #4's `LaunchRequest` (a Claude structured final output, a turn budget) is
 * `false` or empty here until it is plumbed.
 */
export interface HarnessCapabilities {
  tools: ('edit' | 'shell' | 'web' | 'mcp' | 'vision-input')[];
  /** Permission modes a launch may ask for. Empty: the harness takes its policy from its own configuration. */
  permissionModes: PermissionModeName[];
  /** The session id can be chosen before launch (so an attempt can record it write-ahead, §23.2). */
  preassignedSessionId: boolean;
  resume: boolean;
  fork: boolean;
  midSessionModelChange: boolean;
  /**
   * How effort changes in a running session (§6.4): the SDK itself (`native`),
   * the CLI's `/effort` (`slash-command`), on the next turn (`per-turn`), or not at all.
   */
  midSessionEffortChange: 'native' | 'slash-command' | 'per-turn' | 'none';
  structuredFinalOutput: boolean;
  budgetLimits: ('maxTurns' | 'maxBudgetUsd')[];
  reportsCost: boolean;
  reportsTokens: boolean;
  /** Where the effort actually applied is reported (§16.3). */
  reportsAppliedEffort: 'hook' | 'init' | 'none';
}

/** How to launch one attempt. */
export interface AttemptLaunch {
  /** The task's worktree. */
  cwd: string;
  /** The first message: the attempt's prompt. */
  prompt: string;
  /**
   * What runs it, from the routing decision. `harness` must be this harness;
   * `effortNative` is sent as is, and `none` means "send no effort".
   */
  target: Pick<ExecutionTarget, 'harness' | 'model' | 'effortNative'>;
  /** Recorded as the session's registry `origin`. */
  origin: OrchestrationOrigin;
  /** Claude only; ignored by a harness whose `permissionModes` is empty. */
  permissionMode?: PermissionModeName;
  /** Continue this session (escalation's "continue", §15.2) rather than start a fresh one. */
  resume?: string;
  /** A fresh session's id, when the harness can take one. Chosen by the adapter if absent. */
  sessionId?: string;
  /**
   * Tool rules, limits and sandbox (plan §24.1). On a resume, absent means
   * the session's recorded policy, never none: the executor re-applies it.
   */
  policy?: LaunchPolicy;
}

export interface AgentHarness {
  readonly id: HarnessId;
  capabilities(): HarnessCapabilities;
  /**
   * The models this harness last reported (`supportedModels()` / `model/list`).
   * #29's catalog turns them into descriptors with provenance.
   */
  models(): Promise<ModelChoice[]>;
  /** Start the attempt's session and send it the prompt. The handle is #4's. */
  launch(req: AttemptLaunch): Promise<SessionHandle>;
}

/** The effort to send for a target: its native level, or nothing for a model without effort control. */
export function nativeEffort(target: AttemptLaunch['target']): string | undefined {
  const e = target.effortNative?.trim();
  return e && e !== 'none' ? e : undefined;
}

export function assertTarget(harness: HarnessId, req: AttemptLaunch): void {
  if (req.target.harness !== harness) {
    throw new Error(`The ${harness} harness cannot launch a ${req.target.harness} target`);
  }
}

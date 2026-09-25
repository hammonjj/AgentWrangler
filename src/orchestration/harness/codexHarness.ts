/**
 * The Codex adapter (plan §6.2): an attempt becomes one
 * `SessionExecutors.launch` of a Codex thread. Codex chooses the thread id
 * (it is known once `thread/start` answers), and takes effort per turn
 * (§6.4), which is how a resumed thread gets the effort the route asked for.
 */
import type { SessionExecutors } from '../../core/session/sessionExecutors';
import type { SessionHandle } from '../../core/session/sessionHandle';
import type { ModelChoice } from '../../shared/conversation';
import { assertTarget, nativeEffort, type AgentHarness, type AttemptLaunch, type HarnessCapabilities } from './types';

export interface CodexHarnessDeps {
  sessions: Pick<SessionExecutors, 'launch'>;
  /** What the app-server last reported (`ModelCatalogService`). */
  models: () => ModelChoice[];
}

const CAPABILITIES: HarnessCapabilities = {
  tools: ['edit', 'shell', 'web', 'mcp', 'vision-input'],
  // Codex takes its sandbox and approval policy from its configuration; AW sends none yet (#71).
  permissionModes: [],
  preassignedSessionId: false,
  resume: true,
  // `thread/fork` exists, but not through `LaunchRequest`.
  fork: false,
  midSessionModelChange: true,
  midSessionEffortChange: 'per-turn',
  // `turn/start.outputSchema` exists, but not through `LaunchRequest`.
  structuredFinalOutput: false,
  budgetLimits: [],
  reportsCost: false,
  reportsTokens: true,
  reportsAppliedEffort: 'none',
};

export class CodexHarness implements AgentHarness {
  readonly id = 'codex';

  constructor(private deps: CodexHarnessDeps) {}

  capabilities(): HarnessCapabilities {
    return CAPABILITIES;
  }

  async models(): Promise<ModelChoice[]> {
    return this.deps.models().filter((m) => m.provider === 'openai');
  }

  async launch(req: AttemptLaunch): Promise<SessionHandle> {
    assertTarget(this.id, req);
    const effort = nativeEffort(req.target);
    // The prompt is sent here rather than as `initialPrompt`, so a resumed
    // thread has its effort set before the first turn it runs for us.
    const handle = await this.deps.sessions.launch({
      provider: 'codex',
      cwd: req.cwd,
      model: req.target.model || undefined,
      effort,
      ...(req.resume ? { resume: req.resume } : {}),
      origin: req.origin,
      ...(req.policy ? { policy: req.policy } : {}),
    });
    if (req.resume && effort) await handle.setEffort(effort);
    await handle.send(req.prompt);
    return handle;
  }
}

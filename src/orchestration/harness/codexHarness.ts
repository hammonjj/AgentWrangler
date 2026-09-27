/**
 * The Codex adapter (plan §6.2): an attempt becomes one
 * `SessionExecutors.launch` of a Codex thread. Codex chooses the thread id
 * (it is known once `thread/start` answers), and takes effort per turn
 * (§6.4), which is how a resumed thread gets the effort the route asked for.
 */
import type { SessionExecutors } from '../../core/session/sessionExecutors';
import type { SessionHandle } from '../../core/session/sessionHandle';
import type { ModelChoice } from '../../shared/conversation';
import type { CodexModelProvider } from '../../shared/launchPolicy';
import { isEndpointSource } from '../../shared/orchestration/localEndpoints';
import type { ModelSourceId } from '../../shared/orchestration/types';
import { assertTarget, nativeEffort, type AgentHarness, type AttemptLaunch, type HarnessCapabilities } from './types';

export interface CodexHarnessDeps {
  sessions: Pick<SessionExecutors, 'launch'>;
  /** What the app-server last reported (`ModelCatalogService`). */
  models: () => ModelChoice[];
  /**
   * The model provider for a `local:<id>` source (#51, §19.6 slice B), or
   * undefined when that endpoint is not registered or is off.
   */
  localProvider?: (source: ModelSourceId, model: string) => CodexModelProvider | undefined;
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
    let policy = req.policy;
    const source = req.target.source;
    if (source && isEndpointSource(source)) {
      // A local model is a Codex thread with a different model provider: the
      // sandbox and approval policy are the same as any attempt's (§19.6).
      if (!req.target.model) throw new Error('A local model has to be named: there is no default model on an endpoint.');
      const provider = this.deps.localProvider?.(source, req.target.model);
      if (!provider) throw new Error(`The endpoint for ${source} is not registered, or is off.`);
      policy = { ...policy, codex: { ...policy?.codex, modelProvider: provider } };
    }
    // The prompt is sent here rather than as `initialPrompt`, so a resumed
    // thread has its effort set before the first turn it runs for us.
    const handle = await this.deps.sessions.launch({
      provider: 'codex',
      cwd: req.cwd,
      model: req.target.model || undefined,
      effort,
      ...(req.resume ? { resume: req.resume } : {}),
      origin: req.origin,
      ...(policy ? { policy } : {}),
    });
    if (req.resume && effort) await handle.setEffort(effort);
    await handle.send(req.prompt, undefined, req.promptId ? { clientMessageId: req.promptId } : undefined);
    return handle;
  }
}

/**
 * The Claude Code adapter (plan §6.2): an attempt becomes one
 * `SessionExecutors.launch` of a Claude session, in-process or in a session
 * host as #4 decides. The id is chosen here, before launch, so the attempt
 * can hold it before the session exists (§23.2).
 */
import { randomUUID } from 'node:crypto';
import type { SessionExecutors } from '../../core/session/sessionExecutors';
import type { SessionHandle } from '../../core/session/sessionHandle';
import type { ModelChoice } from '../../shared/conversation';
import { parseLaunchPolicy, type ClaudeLocalProvider } from '../../shared/launchPolicy';
import { isEndpointSource } from '../../shared/orchestration/localEndpoints';
import type { ModelSourceId } from '../../shared/orchestration/types';
import { assertTarget, nativeEffort, type AgentHarness, type AttemptLaunch, type HarnessCapabilities } from './types';

export interface ClaudeCodeHarnessDeps {
  sessions: Pick<SessionExecutors, 'launch'>;
  /** What the CLI last reported (`ModelCatalogService`). */
  models: () => ModelChoice[];
  localProvider?: (source: ModelSourceId, model: string) => ClaudeLocalProvider | undefined;
}

const CAPABILITIES: HarnessCapabilities = {
  tools: ['edit', 'shell', 'web', 'mcp', 'vision-input'],
  permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
  preassignedSessionId: true,
  resume: true,
  // SDK `resume` + `forkSession` in a new `cwd`: the fork keeps the context and
  // its tools run in the new directory (#54 spike, 2026-09-29, CLI 2.1.284).
  fork: true,
  midSessionModelChange: true,
  // No SDK call; the view sends `/effort` when the CLI offers it (§6.4).
  midSessionEffortChange: 'slash-command',
  // `outputFormat` and `maxTurns`/`maxBudgetUsd` exist in the SDK but are not passed through `LaunchRequest`.
  structuredFinalOutput: false,
  budgetLimits: [],
  reportsCost: true,
  reportsTokens: true,
  reportsAppliedEffort: 'hook',
};

export class ClaudeCodeHarness implements AgentHarness {
  readonly id = 'claude-code';

  constructor(private deps: ClaudeCodeHarnessDeps) {}

  capabilities(): HarnessCapabilities {
    return CAPABILITIES;
  }

  async models(): Promise<ModelChoice[]> {
    return this.deps.models().filter((m) => (m.provider ?? 'anthropic') === 'anthropic');
  }

  async launch(req: AttemptLaunch): Promise<SessionHandle> {
    assertTarget(this.id, req);
    let policy = req.policy;
    if (req.target.source && isEndpointSource(req.target.source)) {
      if (!req.target.model) throw new Error('A local model has to be named: there is no default model on an endpoint.');
      const provider = this.deps.localProvider?.(req.target.source, req.target.model);
      if (!provider) throw new Error(`The endpoint for ${req.target.source} is not registered, is off, or has no native /v1/messages route and known context window.`);
      // Every later reader parses the policy. A provider the parser drops would
      // send the local model's name to Anthropic, so it cannot leave here.
      const parsed = parseLaunchPolicy({ claude: { localProvider: provider } })?.claude?.localProvider;
      if (!parsed) throw new Error(`The endpoint for ${req.target.source} gave a provider the launch policy does not accept.`);
      policy = { ...policy, claude: { ...policy?.claude, localProvider: parsed } };
    }
    const handle = await this.deps.sessions.launch({
      provider: 'claude',
      cwd: req.cwd,
      model: req.target.model || undefined,
      effort: nativeEffort(req.target),
      permissionMode: req.permissionMode,
      // A fork is a fresh session (its own id, chosen here) with another's conversation.
      ...(req.resume ? { resume: req.resume } : { sessionId: req.sessionId ?? randomUUID(), ...(req.fork ? { forkFrom: req.fork } : {}) }),
      // With an id of its own the prompt is sent here, so it carries that id.
      ...(req.promptId ? {} : { initialPrompt: req.prompt }),
      origin: req.origin,
      ...(policy ? { policy } : {}),
    });
    // Not awaited, like `initialPrompt`: the send settles when the agent takes it.
    if (req.promptId) void handle.send(req.prompt, undefined, { clientMessageId: req.promptId });
    return handle;
  }
}

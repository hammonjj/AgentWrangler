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
import { assertTarget, nativeEffort, type AgentHarness, type AttemptLaunch, type HarnessCapabilities } from './types';

export interface ClaudeCodeHarnessDeps {
  sessions: Pick<SessionExecutors, 'launch'>;
  /** What the CLI last reported (`ModelCatalogService`). */
  models: () => ModelChoice[];
}

const CAPABILITIES: HarnessCapabilities = {
  tools: ['edit', 'shell', 'web', 'mcp', 'vision-input'],
  permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
  preassignedSessionId: true,
  resume: true,
  // The SDK can fork, but `LaunchRequest` has no way to ask for it yet.
  fork: false,
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
    const handle = await this.deps.sessions.launch({
      provider: 'claude',
      cwd: req.cwd,
      model: req.target.model || undefined,
      effort: nativeEffort(req.target),
      permissionMode: req.permissionMode,
      ...(req.resume ? { resume: req.resume } : { sessionId: req.sessionId ?? randomUUID() }),
      // With an id of its own the prompt is sent here, so it carries that id.
      ...(req.promptId ? {} : { initialPrompt: req.prompt }),
      origin: req.origin,
      ...(req.policy ? { policy: req.policy } : {}),
    });
    // Not awaited, like `initialPrompt`: the send settles when the agent takes it.
    if (req.promptId) void handle.send(req.prompt, undefined, { clientMessageId: req.promptId });
    return handle;
  }
}

/**
 * Two words the code used to spell "provider" (`docs/plans/intelligent-orchestration.md` §6.1).
 *
 * - The **harness** is the agent loop that works in a directory: Claude Code or
 *   Codex. Sessions carry it as `provider: 'claude' | 'codex'` (it is in every
 *   session key, `claude:<id>`, so the short spelling stays on the wire), and
 *   orchestration names it `HarnessId` (`'claude-code' | 'codex'`).
 * - The **model source** is where inference runs and how it is limited:
 *   Anthropic or OpenAI today, `local:<name>` later. Model lists carry it as
 *   `ModelChoice.provider: 'anthropic' | 'openai'`.
 *
 * They are separate things, and only these functions translate between them.
 *
 * Imported by the main process and the webviews: no Node or DOM here.
 */

import type { HarnessId, ModelSourceId } from './orchestration/types';

/** The harness as a session carries it: the `provider` in `AgentSession` and in every session key. */
export type SessionProvider = 'claude' | 'codex';
export const SESSION_PROVIDERS: readonly SessionProvider[] = ['claude', 'codex'];

/** A hosted model source a harness reaches today. `ModelChoice.provider`. */
export type HostedSource = 'anthropic' | 'openai';
export const HOSTED_SOURCES: readonly HostedSource[] = ['anthropic', 'openai'];

export function isSessionProvider(value: unknown): value is SessionProvider {
  return value === 'claude' || value === 'codex';
}

/** The orchestration name for a session's harness. */
export function harnessOf(provider: SessionProvider): HarnessId {
  return provider === 'claude' ? 'claude-code' : 'codex';
}

/** The source a harness reaches with its own login. Codex can reach others through its config (§19); that is not modelled yet. */
export function sourceOf(provider: SessionProvider): HostedSource {
  return provider === 'claude' ? 'anthropic' : 'openai';
}

/** Which harnesses can drive models from this source. */
export function harnessesFor(source: ModelSourceId): HarnessId[] {
  if (source === 'anthropic') return ['claude-code'];
  if (source === 'openai') return ['codex'];
  return [];
}

/** A display name for a source. */
export function sourceLabel(source: ModelSourceId): string {
  if (source === 'anthropic') return 'Anthropic';
  if (source === 'openai') return 'OpenAI';
  if (source.startsWith('local:')) return `Local (${source.slice('local:'.length)})`;
  return source;
}

/** A display name for a harness. */
export function harnessLabel(harness: HarnessId): string {
  if (harness === 'claude-code') return 'Claude Code';
  if (harness === 'codex') return 'Codex';
  return harness;
}

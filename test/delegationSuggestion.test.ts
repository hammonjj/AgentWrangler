import { describe, expect, it, vi } from 'vitest';
import { DelegationSuggestion, type ConversationDelegation } from '../src/ui/conversation/delegationSuggestion';
import type { AgentSession } from '../src/shared/model';

const text = 'Implement a bounded retry policy for the importer with regression tests.';
const context = { repoRoot: '/Users/test/proj', policyVersion: 'default', verificationCommands: ['test'] };
const session = (provider: 'claude' | 'codex') => ({ provider, sessionId: 'synthetic-session', cwd: context.repoRoot }) as AgentSession;
function rig() {
  const publish = vi.fn();
  const suggestion = new DelegationSuggestion(publish);
  const service = { context: vi.fn(() => context), delegate: vi.fn(async () => {}), record: vi.fn() } satisfies ConversationDelegation;
  return { suggestion, service, publish, abort: new AbortController() };
}

describe.each(['claude', 'codex'] as const)('%s conversation suggestion', (provider) => {
  it.each(['accepted', 'declined', 'ignored'] as const)('requires an action and records %s exactly once without content', async (outcome) => {
    const r = rig();
    const pending = r.suggestion.intercept(text, session(provider), r.service, r.abort.signal);
    expect(r.suggestion.offer?.objective).toBe(text);
    expect(r.service.delegate).not.toHaveBeenCalled();
    expect(r.service.record).not.toHaveBeenCalled();
    r.suggestion.decide('stale-offer', 'accepted');
    expect(r.service.delegate).not.toHaveBeenCalled();
    const id = r.suggestion.offer!.id;
    r.suggestion.decide(id, outcome);
    r.suggestion.decide(id, 'accepted');
    expect(await pending).toBe(outcome === 'accepted');
    expect(r.service.delegate).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
    if (outcome === 'accepted') expect(r.service.delegate).toHaveBeenCalledWith({
      folder: context.repoRoot, objective: text,
      acceptanceCriteria: expect.any(Array), origin: { provider, sessionId: 'synthetic-session' },
    });
    expect(r.service.record).toHaveBeenCalledExactlyOnceWith({
      v: 1, type: 'delegation-suggestion', id, at: expect.any(Number), provider, outcome,
      reason: 'bounded-work', assessorVersion: 1, repoPolicyVersion: 'default', durationMs: expect.any(Number),
    });
    expect(JSON.stringify(r.service.record.mock.calls)).not.toContain(text);
    expect(JSON.stringify(r.service.record.mock.calls)).not.toContain(context.repoRoot);
    expect(r.publish).toHaveBeenLastCalledWith(undefined);
  });

  it('records an abandoned send as ignored, never delivers it, and rejects late acceptance', async () => {
    const r = rig();
    const pending = r.suggestion.intercept(text, session(provider), r.service, r.abort.signal);
    const id = r.suggestion.offer!.id;
    r.abort.abort();
    r.suggestion.decide(id, 'accepted');
    await expect(pending).rejects.toThrow('draft was kept');
    expect(r.service.record.mock.calls[0][0].outcome).toBe('ignored');
    expect(r.service.delegate).not.toHaveBeenCalled();
  });

  it('keeps explicit shortcuts and conversation requests on the existing path without an offer', async () => {
    const r = rig();
    for (const request of ['delegate this', 'aw task implement retries', 'Explain the retry tests']) {
      expect(await r.suggestion.intercept(request, session(provider), r.service, r.abort.signal)).toBe(false);
    }
    expect(r.publish).not.toHaveBeenCalled();
    expect(r.service.record).not.toHaveBeenCalled();
  });

  it('does not lose a draft when planner handoff fails', async () => {
    const r = rig();
    r.service.delegate.mockRejectedValueOnce(new Error('Planner unavailable'));
    const pending = r.suggestion.intercept(text, session(provider), r.service, r.abort.signal);
    r.suggestion.decide(r.suggestion.offer!.id, 'accepted');
    await expect(pending).rejects.toThrow('Planner unavailable');
    expect(r.suggestion.offer).toBeUndefined();
  });

  it('rechecks the repository after acceptance', async () => {
    const r = rig();
    const pending = r.suggestion.intercept(text, session(provider), r.service, r.abort.signal);
    r.service.context.mockReturnValueOnce({ ...context, repoRoot: '/Users/test/other' });
    r.suggestion.decide(r.suggestion.offer!.id, 'accepted');
    await expect(pending).rejects.toThrow('Repository is no longer available');
    expect(r.service.delegate).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { summarizeRolloutLines, type CodexRolloutSummary } from '../src/codex/rollout';
import { summarizeSubagents, visibleCodexSummaries } from '../src/codex/subagents';
import { subagentText } from '../src/shared/subagents';
import { SessionStore } from '../src/core/sessionStore';
import type { AgentSession } from '../src/shared/model';

const line = (type: string, payload: unknown) => JSON.stringify({ type, payload });
const summary = (id: string, extra: Partial<CodexRolloutSummary> = {}): CodexRolloutSummary => ({
  sessionId: id, path: '/Users/test/rollout.jsonl', lastActivityAt: 100,
  turnComplete: true, failed: false, lastAssistantText: "Tests pass.", ...extra,
});
const child = (id: string, parent: string, extra: Partial<CodexRolloutSummary> = {}) =>
  summary(id, { isSubagent: true, parentThreadId: parent, ...extra });

describe('Codex subagent discovery', () => {
  it('recognizes guardian and worker metadata, including serialized sources', () => {
    const parse = (source: unknown) => summarizeRolloutLines([
      line('session_meta', { id: 'child', source, originator: 'codex' }),
    ], '/Users/test/rollout.jsonl', 100)!;
    expect(parse({ subagent: { other: 'guardian' } })).toMatchObject({ isSubagent: true, isGuardian: true });
    expect(parse(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'ROOT', depth: 1 } } })))
      .toMatchObject({ isSubagent: true, isGuardian: false, parentThreadId: 'root' });
    expect(parse('vscode')).toMatchObject({ isSubagent: false, source: 'vscode' });
    expect(parse('{invalid')).toMatchObject({ isSubagent: false });
    expect(parse({ subagent: 'review' })).toMatchObject({ isSubagent: true });
  });

  it('hides all internal children by default and exposes even unlinked children for diagnostics', () => {
    const rows = [summary('root'), child('worker', 'root'), summary('orphan', { isSubagent: true }),
      child('guardian', 'root', { isGuardian: true })];
    expect(visibleCodexSummaries(rows, false).map((s) => s.sessionId)).toEqual(['root']);
    expect(visibleCodexSummaries(rows, true)).toEqual(rows);
  });

  it('counts nested workers once, excludes guardian trees, and preserves the parent status', () => {
    const root = summary('root');
    const rows = [root, child('a', 'ROOT', { turnComplete: false }), child('b', 'a'),
      child('c', 'root', { failed: true }), child('d', 'root', { turnComplete: false, lastActivityAt: 0 }),
      child('guardian', 'root', { isGuardian: true }), child('internal', 'guardian')];
    const counts = summarizeSubagents(rows, 110, 50);
    expect([...counts]).toEqual([['root', { working: 1, attention: 2, done: 1 }]]);
    expect(root.turnComplete).toBe(true);
    expect(subagentText(counts.get('root'))).toBe('2 needs attention · 1 working · 1 done');
    expect(subagentText(undefined)).toBe('');
  });

  it('does not assign orphans or cyclic ancestry to a main conversation', () => {
    expect(summarizeSubagents([summary('root'), child('orphan', 'missing'), child('a', 'b'), child('b', 'a'), child('self', 'self')], 100, 50).size).toBe(0);
  });

  it('skips injected setup messages when selecting the title and latest prompt', () => {
    const result = summarizeRolloutLines([
      line('session_meta', { id: 'root' }),
      ...['# AGENTS.md instructions for /Users/test/proj\n<INSTRUCTIONS>Rules</INSTRUCTIONS>',
        '<recommended_plugins>Plugins</recommended_plugins><environment_context>Context</environment_context>',
        'Fix the parser', '<environment_context>Updated context</environment_context>',
      ].map((text) => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })),
    ], '/Users/test/rollout.jsonl', 100)!;
    expect(result.title).toBe('Fix the parser');
    expect(result.subtitle).toBe('Fix the parser');
  });

  it('retains a user request following setup tags in the same message', () => {
    const result = summarizeRolloutLines([
      line('session_meta', { id: 'root' }),
      line('response_item', { type: 'message', role: 'user', content: '<environment_context>Context</environment_context>Actual request' }),
    ], '/Users/test/rollout.jsonl', 100)!;
    expect(result.title).toBe('Actual request');
  });

  it('publishes worker-only changes without changing the parent status or emitting completion alerts', async () => {
    let row: AgentSession = { provider: 'codex', sessionId: 'root', key: 'codex:root', title: 'Test',
      status: 'busy', lastActivityAt: 100, subagents: { working: 1, attention: 0, done: 0 } };
    const store = new SessionStore();
    await store.register({ id: 'codex', displayName: 'Codex', start: async () => {}, refresh: async () => {},
      scan: async () => [row], onDidChange: () => ({ dispose() {} }), dispose() {} });
    const updates: unknown[] = [];
    store.onDidUpdate((update) => updates.push(update));
    row = { ...row, subagents: { working: 0, attention: 0, done: 1 } };
    await store.refresh();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ upserted: [{ status: 'busy', subagents: { done: 1 } }], becameWaiting: [] });
    store.dispose();
  });

  it('uses an owned runner as the exact live status for every store consumer', async () => {
    const discovered: AgentSession = {
      provider: 'codex', sessionId: 'root', key: 'codex:root', title: 'Test', status: 'busy', lastActivityAt: 100,
    };
    let live: AgentSession | undefined;
    const store = new SessionStore();
    store.useLiveSessions(() => live);
    await store.register({ id: 'codex', displayName: 'Codex', start: async () => {}, refresh: async () => {},
      scan: async () => [discovered], onDidChange: () => ({ dispose() {} }), dispose() {} });
    const updates: any[] = [];
    store.onDidUpdate((update) => updates.push(update));
    live = { ...discovered, status: 'done', lastActivityAt: 200, runnerOwned: true };
    await store.refresh();
    expect(store.get('codex:root')).toMatchObject({ status: 'done', lastActivityAt: 200 });
    expect(updates.at(-1)?.becameWaiting).toMatchObject([{ status: 'done' }]);
    store.dispose();
  });
});

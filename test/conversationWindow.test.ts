/**
 * Incremental conversation history (#192): a remote tab opens on a small recent window, older
 * blocks page in by cursor with no gap or duplicate, and a LAN tab behaves as it always did.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessGate, ownerContext } from '../src/core/access';
import type { ConvBlock } from '../src/shared/conversation';
import type { ConversationToHost, HostToConversation } from '../src/shared/messages';
import type { AgentSession } from '../src/shared/model';
import { ConversationHost } from '../src/ui/conversation/conversationHost';
import { RELAY_INIT_BLOCKS, recentWindow } from '../src/ui/conversation/initWindow';
import { mkAssistant, mkText, mkUser } from './fixtures';

const block = (id: string, kind: 'user' | 'assistant'): ConvBlock => ({ id, kind, text: id } as ConvBlock);

describe('recentWindow', () => {
  it('leaves a short conversation whole', () => {
    const blocks = [block('a', 'user'), block('b', 'assistant')];
    expect(recentWindow(blocks, 10)).toEqual({ blocks, trimmed: false });
  });

  it('keeps the last max blocks, starting at a user message when one is near', () => {
    const blocks = Array.from({ length: 100 }, (_, i) => block(`b${i}`, i % 10 === 0 ? 'user' : 'assistant'));
    const w = recentWindow(blocks, 25);
    expect(w.trimmed).toBe(true);
    expect(w.blocks[0].id).toBe('b70');
    expect(w.blocks.at(-1)!.id).toBe('b99');
    expect(w.blocks.length).toBeGreaterThanOrEqual(25);
    expect(w.blocks.length).toBeLessThanOrEqual(37);
  });

  it('falls back to exactly max when no turn starts nearby', () => {
    const blocks = Array.from({ length: 100 }, (_, i) => block(`b${i}`, 'assistant'));
    expect(recentWindow(blocks, 25).blocks).toHaveLength(25);
  });
});

describe('a conversation opened from a transcript', () => {
  let dir: string;
  const hosts: ConversationHost[] = [];
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-window-'));
  });
  afterEach(async () => {
    hosts.splice(0).forEach((h) => h.dispose());
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function rig(scope: 'relay' | 'loopback', turns: number) {
    const file = path.join(dir, 'session.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < turns; i++) {
      lines.push(mkUser(`question ${i}`, { timestamp: `2026-09-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z` }));
      lines.push(mkAssistant([mkText(`answer ${i}`)], 'end_turn'));
    }
    await fs.writeFile(file, lines.join('\n') + '\n');
    const session: AgentSession = { provider: 'claude', sessionId: 's1', key: 'claude:s1', title: 'T', subtitle: '', status: 'done', lastActivityAt: 1, transcriptPath: file, cwd: '/Users/test/proj' } as AgentSession;
    const disposable = () => ({ dispose() {} });
    let receive!: (m: ConversationToHost) => void;
    const messages: HostToConversation[] = [];
    type Args = ConstructorParameters<typeof ConversationHost>;
    const host = new ConversationHost(
      { postMessage: async (m) => { messages.push(m as HostToConversation); return true; }, onDidReceiveMessage: (l) => { receive = l; return disposable(); } },
      { onDidUpdate: disposable, get: (k: string) => (k === session.key ? session : undefined), sessions: [session] } as unknown as Args[1],
      { pendingPermission: () => undefined } as unknown as Args[2], {} as Args[3],
      { onDidChange: disposable, get: () => undefined } as unknown as Args[4],
      { touch() {} },
      { decidePermission: async () => 'applied' } as unknown as Args[6], {} as Args[7], {} as Args[8], () => {}, {} as Args[10],
      { context: ownerContext('browser', { deviceScope: scope }), gate: createAccessGate() },
    );
    hosts.push(host);
    receive({ type: 'ready' });
    host.show(session.key);
    const init = await vi.waitFor(() => {
      const m = messages.find((x) => x.type === 'init');
      if (!m || m.type !== 'init') throw new Error('no init yet');
      return m;
    });
    return { file, init, messages, receive: (m: ConversationToHost) => receive(m) };
  }

  it('opens a remote tab on a small window and says there is more', async () => {
    const r = await rig('relay', 200);
    expect(r.init.blocks.length).toBeGreaterThanOrEqual(RELAY_INIT_BLOCKS);
    expect(r.init.blocks.length).toBeLessThanOrEqual(RELAY_INIT_BLOCKS * 1.5);
    expect(r.init.truncated).toBe(true);
    expect(r.init.blocks.at(-1)).toMatchObject({ text: 'answer 199' });
    expect(r.init.blocks[0].kind).toBe('user');
  });

  it('opens a LAN tab on what it always did: the last 300 blocks of the tail', async () => {
    const r = await rig('loopback', 200);
    expect(r.init.blocks).toHaveLength(300);
    expect(r.init.truncated).toBe(true);
  });

  it('pages older blocks in behind the window with no gap and no duplicate', async () => {
    const r = await rig('relay', 200);
    const seen = [...r.init.blocks];
    let cursor = r.init.blocks[0].id;
    for (let i = 0; i < 10; i++) {
      r.receive({ type: 'archive', requestId: `a${i}`, before: cursor, query: '' });
      const page = await vi.waitFor(() => {
        const m = r.messages.find((x) => x.type === 'archive' && x.requestId === `a${i}`);
        if (!m || m.type !== 'archive') throw new Error('no page yet');
        return m;
      });
      seen.unshift(...page.blocks);
      if (!page.more) break;
      cursor = page.blocks[0].id;
    }
    expect(new Set(seen.map((b) => b.id)).size).toBe(seen.length);
    expect(seen).toHaveLength(400);
    // In order, oldest first: question 0, answer 0, question 1, ...
    expect(seen.map((b) => (b as { text: string }).text)).toEqual(Array.from({ length: 200 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat());
  });

  it('refuses a cursor that is not in this transcript instead of guessing', async () => {
    const r = await rig('relay', 200);
    r.receive({ type: 'archive', requestId: 'unknown-cursor', before: 't:not-there', query: '' });
    const err = await vi.waitFor(() => {
      const m = r.messages.find((x) => x.type === 'archive' && x.requestId === 'unknown-cursor');
      if (!m || m.type !== 'archive') throw new Error('no answer yet');
      return m;
    });
    expect(err.error).toContain('cursor');
    expect(err.blocks).toEqual([]);
  });
});

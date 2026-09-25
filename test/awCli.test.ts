import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentEnvironment, parseArgs } from '../src/cli/args';
import { AttachRenderer, ATTACH_BACKLOG, renderBlock } from '../src/cli/attach';
import { ago, clip, formatOffline, formatProjects, formatSession, formatSessions, formatStatus, runByLabel, safe, statusLabel } from '../src/cli/format';
import { onClosedIfGone } from '../src/app/controlBackend';
import type { SessionHandle } from '../src/core/session/sessionHandle';
import { readRecords } from '../src/cli/offline';
import { controlSocketPath, MAX_SOCKET_PATH_BYTES } from '../src/core/control/paths';
import { resolveSessionRef, type ControlSession } from '../src/core/control/protocol';
import type { ConvBlock } from '../src/shared/conversation';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

function session(over: Partial<ControlSession> = {}): ControlSession {
  return {
    key: 'claude:1a2b3c4d-0000-4000-8000-000000000001',
    sessionId: '1a2b3c4d-0000-4000-8000-000000000001',
    title: 'Fix the flaky test',
    provider: 'claude',
    status: 'busy',
    projectName: 'proj',
    cwd: '/Users/test/proj',
    lastActivityAt: NOW - 5 * 60_000,
    archived: false,
    runBy: 'hosted',
    ...over,
  };
}

describe('parseArgs', () => {
  it('parses each command', () => {
    expect(parseArgs([])).toEqual({ kind: 'help' });
    expect(parseArgs(['status'])).toEqual({ kind: 'status', json: false });
    expect(parseArgs(['sessions', '--all', '--json'])).toEqual({ kind: 'sessions', json: true, all: true });
    expect(parseArgs(['ls'])).toEqual({ kind: 'sessions', json: false, all: false });
    expect(parseArgs(['session', '1a2b'])).toEqual({ kind: 'session', json: false, ref: '1a2b' });
    expect(parseArgs(['attach', '1a2b'])).toEqual({ kind: 'attach', ref: '1a2b' });
    expect(parseArgs(['stop', '1a2b', '--force'])).toEqual({ kind: 'stop', ref: '1a2b', force: true });
    expect(parseArgs(['projects', '--json'])).toEqual({ kind: 'projects', json: true });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['status', '--help'])).toEqual({ kind: 'help' });
  });

  it('takes everything after the id as the message, flag-looking words included', () => {
    expect(parseArgs(['send', '1a2b', 'run', 'the', 'tests', '--help'])).toEqual({ kind: 'send', ref: '1a2b', text: 'run the tests --help' });
    expect(parseArgs(['send', '1a2b', '-'])).toEqual({ kind: 'send', ref: '1a2b', text: undefined });
  });

  it('explains what is missing or wrong', () => {
    expect(parseArgs(['send'])).toHaveProperty('error');
    expect(parseArgs(['send', '1a2b'])).toHaveProperty('error');
    expect(parseArgs(['send', '1a2b', '  '])).toHaveProperty('error');
    expect(parseArgs(['session'])).toHaveProperty('error');
    expect(parseArgs(['stop', '1a2b', '--now'])).toEqual({ error: 'aw stop: unknown option --now' });
    expect(parseArgs(['frobnicate'])).toHaveProperty('error');
  });
});

describe('agentEnvironment', () => {
  it('recognises shells run by an agent, and nothing else', () => {
    expect(agentEnvironment({ AGENTWRANGLER_HOSTED: '1' })).toMatch(/hosts/);
    expect(agentEnvironment({ CLAUDECODE: '1' })).toMatch(/Claude Code/);
    expect(agentEnvironment({ CODEX_SANDBOX: 'seatbelt' })).toMatch(/Codex/);
    expect(agentEnvironment({ HOME: '/Users/test', TERM: 'xterm' })).toBeUndefined();
  });
});

describe('resolveSessionRef', () => {
  const a = session();
  const b = session({ key: 'codex:1a2b9999-0000', sessionId: '1a2b9999-0000', provider: 'codex' });
  const all = [a, b];

  it('matches a key or an id exactly, in any case', () => {
    expect(resolveSessionRef(all, a.key)).toEqual({ match: a });
    expect(resolveSessionRef(all, a.sessionId.toUpperCase())).toEqual({ match: a });
  });

  it('matches a unique prefix of four or more characters', () => {
    expect(resolveSessionRef(all, '1a2b3')).toEqual({ match: a });
    expect(resolveSessionRef(all, 'codex:1a2b')).toEqual({ match: b });
    expect(resolveSessionRef(all, '1a2')).toEqual({ error: 'notFound' });
    expect(resolveSessionRef(all, 'claude:1a2')).toEqual({ error: 'notFound' });
  });

  it('says when a prefix is ambiguous or matches nothing', () => {
    expect(resolveSessionRef(all, '1a2b')).toEqual({ error: 'ambiguous', matches: [a, b] });
    expect(resolveSessionRef(all, 'ffff')).toEqual({ error: 'notFound' });
    expect(resolveSessionRef(all, '  ')).toEqual({ error: 'notFound' });
  });
});

describe('formatting', () => {
  it('ago and clip', () => {
    expect(ago(NOW - 10_000, NOW)).toBe('just now');
    expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(ago(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
    expect(ago(NOW - 72 * 3600_000, NOW)).toBe('3d ago');
    expect(clip('a  b\nc', 10)).toBe('a b c');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
  });

  it('lists sessions as aligned columns, clipping the title to the width', () => {
    const text = formatSessions(
      [
        session(),
        session({ sessionId: 'ffff0000-1', key: 'claude:ffff0000-1', status: 'blocked', blockedOn: 'Bash', runBy: 'external', title: 'x'.repeat(200), archived: true }),
      ],
      NOW,
      100,
    );
    expect(text).toMatchInlineSnapshot(`
      "ID        STATUS         RUN BY     ACTIVE  PROJECT  TITLE
      1a2b3c4d  Busy           AW (host)  5m ago  proj     Fix the flaky test
      ffff0000  Waiting: Bash  —          5m ago  proj     [archived] xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…"
    `);
    expect(text.split('\n').every((l) => l.length <= 100)).toBe(true);
    expect(formatSessions([], NOW)).toBe('No sessions.');
  });

  it('summarises status', () => {
    expect(
      formatStatus({ build: 'abc', appPid: 42, startedAt: NOW - 2 * 3600_000, byStatus: { busy: 2, blocked: 1, done: 1 }, running: { hosted: 2, app: 1 } }, NOW),
    ).toBe(
      'Agent Wrangler is running (pid 42, build abc, up 2h).\n' +
        '4 sessions: 1 waiting on a prompt, 2 busy, 1 done.\n' +
        'Run by Agent Wrangler: 2 that survive a quit, 1 that end with it.',
    );
  });

  it('shows one session, leaving out what is unknown', () => {
    const text = formatSession(
      {
        session: session({ gitBranch: 'feat/x', model: 'claude-opus-5' }),
        lifecycle: 'running',
        pending: { kind: 'permission', summary: 'Bash: npm test' },
        record: { state: 'live', createdAt: NOW - 3600_000, launch: { effort: 'high', permissionMode: 'auto' } },
      },
      NOW,
    );
    expect(text).toContain('Status:     Busy (runner: running)');
    expect(text).toContain('Run by:     Agent Wrangler, survives a quit');
    expect(text).toContain('Waiting on: permission: Bash: npm test');
    expect(text).toContain('Launched:   effort high, mode auto');
    expect(text).not.toContain('Worktree');
    expect(text).not.toContain('Pid');
  });

  it('lists projects', () => {
    const text = formatProjects(
      [
        { dir: '/Users/test/proj', name: 'proj', favourite: true, lastUsedAt: NOW - 60 * 60_000, occupiedBy: ['a'] },
        { dir: '/Users/test/other', name: 'other' },
      ],
      NOW,
    );
    expect(text.split('\n')[1]).toBe('★ proj   1h ago  1 live    /Users/test/proj');
    expect(text.split('\n')[2]).toBe('other    never             /Users/test/other');
  });

  it('describes the read-only view with the app quit', () => {
    const view = {
      hosts: [
        { hostId: 'abcdefgh', sessionId: '1a2b3c4d-0000', cwd: '/Users/test/proj', alive: true, startedAt: NOW - 3600_000 },
        { hostId: 'zzzzzzzz', sessionId: 'dead0000-0000', cwd: '/Users/test/proj', alive: false, startedAt: NOW },
      ],
      records: [
        { sessionId: '1a2b3c4d-0000', provider: 'claude', cwd: '/Users/test/proj', state: 'live', lastShownAt: NOW },
        { sessionId: 'eeee0000-0000', provider: 'codex', cwd: '/Users/test/proj', state: 'stopped', lastShownAt: NOW - 60_000 },
      ],
    };
    const short = formatOffline(view, NOW, 100, false);
    expect(short).toContain('1 session host is still running');
    expect(short).toContain('1a2b3c4d  abcdefgh  1h ago');
    expect(short).not.toContain('zzzzzzzz');
    expect(short).not.toContain('registry');
    const full = formatOffline(view, NOW, 100, true);
    expect(full).toContain('eeee0000  codex     stopped');
    // The live host's session is not listed twice.
    expect(full.match(/1a2b3c4d/g)).toHaveLength(1);
  });
});

describe('AttachRenderer', () => {
  const user: ConvBlock = { kind: 'user', id: 'u1', text: 'run the tests' };
  const tool: ConvBlock = { kind: 'tool', id: 't1', toolUseId: 'tu1', name: 'Bash', inputPreview: 'npm test', state: 'running' };

  it('prints prose once, when it stops streaming', () => {
    const r = new AttachRenderer();
    expect(r.start([user], false)).toEqual(['> run the tests']);
    expect(r.event({ seq: 1, type: 'append', blocks: [{ kind: 'assistant', id: 'a1', text: 'Run', streaming: true }] })).toEqual([]);
    expect(r.event({ seq: 2, type: 'patch', patch: { id: 'a1', block: { text: 'Running them' } } })).toEqual([]);
    expect(r.event({ seq: 3, type: 'patch', patch: { id: 'a1', block: { text: 'Running them now.', streaming: false } } })).toEqual(['Running them now.']);
    expect(r.event({ seq: 4, type: 'patch', patch: { id: 'a1', block: { text: 'Running them now!' } } })).toEqual([]);
  });

  it('prints a tool call when it starts, and again only if it fails', () => {
    const r = new AttachRenderer();
    r.start([], false);
    expect(r.event({ seq: 1, type: 'append', blocks: [tool] })).toEqual(['▸ Bash npm test']);
    expect(r.event({ seq: 2, type: 'patch', patch: { id: 't1', block: { state: 'error', result: { text: '\nexit 1\nmore', isError: true, truncated: false } } } })).toEqual([
      '  ✗ exit 1',
    ]);
    r.event({ seq: 3, type: 'append', blocks: [{ ...tool, id: 't2' }] });
    expect(r.event({ seq: 4, type: 'patch', patch: { id: 't2', block: { state: 'done' } } })).toEqual([]);
  });

  it('prints an ask when it opens and when it is settled', () => {
    const r = new AttachRenderer();
    r.start([], false);
    const ask: ConvBlock = { kind: 'permission', id: 'p1', requestId: 'r1', toolName: 'Bash', body: 'rm -rf build', state: 'pending' };
    expect(r.event({ seq: 1, type: 'append', blocks: [ask] })).toEqual(['? Bash wants permission: rm -rf build (answer it in the app or Discord)']);
    expect(r.event({ seq: 2, type: 'patch', patch: { id: 'p1', block: { state: 'allowed' } } })).toEqual(['→ allowed']);
  });

  it('indents a subagent, skips thinking, and reports the session ending', () => {
    const r = new AttachRenderer();
    r.start([], false);
    expect(r.event({ seq: 1, type: 'append', blocks: [{ ...tool, parentToolUseId: 'agent1' }] })).toEqual(['    ▸ Bash npm test']);
    expect(r.event({ seq: 2, type: 'append', blocks: [{ kind: 'thinking', id: 'th', text: 'hmm' }] })).toEqual([]);
    expect(r.event({ seq: 3, type: 'lifecycle', lifecycle: 'ended' })).toEqual(['— the session ended']);
  });

  it('shows only the last blocks of a long snapshot, and says so', () => {
    const r = new AttachRenderer();
    const many: ConvBlock[] = Array.from({ length: ATTACH_BACKLOG + 5 }, (_, i) => ({ kind: 'user', id: `u${i}`, text: `m${i}` }));
    const lines = r.start(many, false);
    expect(lines[0]).toMatch(/earlier conversation not shown/);
    expect(lines).toHaveLength(ATTACH_BACKLOG + 1);
    expect(lines[1]).toBe('> m5');
  });

  it('renders a settled ask from the snapshot with its outcome', () => {
    const r = new AttachRenderer();
    const plan: ConvBlock = { kind: 'plan', id: 'pl', requestId: 'r', plan: '# Refactor the parser\n\nsteps', state: 'denied' };
    expect(r.start([plan], false)).toEqual(['? Plan waiting for approval: Refactor the parser (answer it in the app)', '→ denied']);
    expect(renderBlock({ kind: 'note', id: 'n', tone: 'warn', text: 'compacted' })).toEqual(['! compacted']);
  });
});

describe('readRecords', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads the registry newest first, skipping malformed records, and tolerates a missing file', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-'));
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        'agentWrangler.sessions': [
          { sessionId: 'old', provider: 'claude', cwd: '/Users/test/proj', state: 'stopped', lastShownAt: 1 },
          { sessionId: 'bad' },
          { sessionId: 'new', provider: 'codex', cwd: '/Users/test/proj', state: 'interrupted', endedReason: 'x', lastShownAt: 2 },
        ],
      }),
    );
    expect(readRecords(file).map((r) => r.sessionId)).toEqual(['new', 'old']);
    expect(readRecords(path.join(dir, 'missing.json'))).toEqual([]);
  });
});

describe('review fixes', () => {
  it('rejects stray positionals and short flags instead of ignoring them', () => {
    expect(parseArgs(['stop', 'abcd', '-f'])).toEqual({ error: 'aw stop: unknown option -f' });
    expect(parseArgs(['stop', 'a1b2', 'c3d4'])).toEqual({ error: 'aw stop: unexpected "c3d4"' });
    expect(parseArgs(['status', 'now'])).toEqual({ error: 'aw status: unexpected "now"' });
    expect(parseArgs(['nope', 'x'])).toEqual({ error: 'aw: no command "nope". Run aw help.' });
  });

  it('strips terminal escapes from agent-written text', () => {
    const osc52 = '\u001b]52;c;ZXZpbA==\u0007';
    expect(safe(`ok${osc52}\ttab\nline`)).toBe('ok]52;c;ZXZpbA==\ttab\nline');
    const r = new AttachRenderer();
    expect(r.start([{ kind: 'user', id: 'u', text: `hi\u001b[2J` }], false)).toEqual(['> hi[2J']);
    const text = formatSessions([session({ title: `evil\u001b]0;title\u0007` })], NOW);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('shows enum values it does not know as themselves', () => {
    expect(statusLabel('sleeping')).toBe('sleeping');
    expect(runByLabel('elsewhere')).toBe('elsewhere');
  });

  it('an attach survives an id change, says "ended" for an ended handle, and "gone" only when AW lets go', () => {
    const handle = { sessionId: 'new-id-after-compaction', lifecycle: 'running' } as unknown as SessionHandle;
    const closed: string[] = [];
    onClosedIfGone({ list: () => [handle] }, handle, (r) => closed.push(r));
    expect(closed).toEqual([]);
    onClosedIfGone({ list: () => [] }, handle, (r) => closed.push(r));
    expect(closed).toEqual(['gone']);
    const ended = { lifecycle: 'ended' } as unknown as SessionHandle;
    onClosedIfGone({ list: () => [] }, ended, (r) => closed.push(r));
    expect(closed).toEqual(['gone', 'ended']);
  });
});

describe('controlSocketPath', () => {
  it('uses run/ when the path fits, the fallback when it does not', () => {
    expect(controlSocketPath({ runDir: '/Users/test/run', fallbackRunDir: '/Users/test/.agentwrangler/run' })).toBe('/Users/test/run/core.sock');
    const long = `/Users/${'u'.repeat(60)}/Library/Application Support/Agent Wrangler/run`;
    const chosen = controlSocketPath({ runDir: long, fallbackRunDir: '/Users/test/.agentwrangler/run' });
    expect(chosen).toBe('/Users/test/.agentwrangler/run/core.sock');
    expect(Buffer.byteLength(chosen)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
  });
});

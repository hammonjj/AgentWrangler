import * as cp from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentState,
  detectIndent,
  hookCommandFor,
  installHooks,
  mergeHooks,
  PERMISSION_HOOK_TIMEOUT_SECONDS,
  PERMISSION_SCRIPT_NAME,
  permissionScript,
  permissionScriptPath,
  removeHooks,
  uninstallHooks,
  type HooksConfig,
} from '../src/claude/hookInstall';
import { HOOK_EVENTS } from '../src/claude/hookEvents';

const LOG_DIR = '/home/u/.claude/agentwrangler';

/**
 * A user's pre-existing hook, modelled on the real one on this machine: a
 * PreToolUse matcher on Bash running a python permission script in exec form.
 * Nothing we do may disturb it.
 */
const USER_HOOK: HooksConfig = {
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: '/usr/bin/python3', args: ['/home/u/.claude/hooks/allow-readonly.py'], timeout: 5 },
      ],
    },
  ],
};

describe('mergeHooks', () => {
  it('registers every event we rely on', () => {
    const { hooks, changed } = mergeHooks(undefined, LOG_DIR);
    expect(changed).toBe(true);
    for (const e of HOOK_EVENTS) expect(Object.keys(hooks), e).toContain(e);
  });

  it('writes a shell-form command (no args) so the >> redirection works', () => {
    const { hooks } = mergeHooks(undefined, LOG_DIR);
    const cmd = hooks.Stop[0].hooks![0];
    expect(cmd.command).toBe(`cat >> "${LOG_DIR}/$PPID.jsonl"`);
    // `args` would mean exec-without-a-shell, and redirection would be a literal argument.
    expect(cmd).not.toHaveProperty('args');
  });

  it('routes PermissionRequest through the waiting script, with a timeout to match', () => {
    const { hooks } = mergeHooks(undefined, LOG_DIR);
    const cmd = hooks.PermissionRequest[0].hooks![0];
    expect(cmd.command).toBe(`"${LOG_DIR}/${PERMISSION_SCRIPT_NAME}"`);
    expect(cmd.timeout).toBe(PERMISSION_HOOK_TIMEOUT_SECONDS);
    // Still recognisably ours, so uninstall finds it.
    expect(cmd.command).toContain('agentwrangler');
  });

  it('shards the log by $PPID rather than a single shared file', () => {
    // A shared log tears once a payload exceeds one write(): measured on macOS,
    // 30 concurrent 64 KB appends corrupt 6 lines, 128 KB corrupts most. A
    // tool_input carrying a large Write gets there easily.
    const { hooks } = mergeHooks(undefined, LOG_DIR);
    expect(hooks.PreToolUse[0].hooks![0].command).toContain('$PPID');
  });

  it('preserves an existing user hook on the same event', () => {
    const { hooks } = mergeHooks(USER_HOOK, LOG_DIR);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toEqual(USER_HOOK.PreToolUse[0]);
  });

  it('preserves hooks on events we do not touch', () => {
    const other: HooksConfig = { PreCompact: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] };
    const { hooks } = mergeHooks(other, LOG_DIR);
    expect(hooks.PreCompact).toEqual(other.PreCompact);
  });

  it('is idempotent', () => {
    const first = mergeHooks(USER_HOOK, LOG_DIR);
    const second = mergeHooks(first.hooks, LOG_DIR);
    expect(second.changed).toBe(false);
    expect(second.hooks).toEqual(first.hooks);
  });

  it('refreshes our entry in place when the log dir moved', () => {
    const first = mergeHooks(USER_HOOK, '/old/agentwrangler');
    const second = mergeHooks(first.hooks, LOG_DIR);
    expect(second.changed).toBe(true);
    expect(second.hooks.PreToolUse).toHaveLength(2); // replaced, not appended
    expect(second.hooks.PreToolUse[0]).toEqual(USER_HOOK.PreToolUse[0]);
    expect(second.hooks.PreToolUse[1].hooks![0].command).toBe(hookCommandFor(LOG_DIR, 'PreToolUse'));
  });
});

describe('permissionScript', () => {
  const script = permissionScript();

  it('is a POSIX sh script that logs, marks, polls and prints the decision', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('>> "$dir/$PPID.jsonl"');
    expect(script).toContain('"hook_event_name":"AgentWranglerPermissionPending"');
    expect(script).toContain('cat "$dec"');
    // Gives up when the dashboard withdraws the marker (prompt answered in Claude Code).
    expect(script).toContain('[ -e "$req" ] || exit 0');
  });

  it('stops polling before the hook timeout would kill it', () => {
    const polls = Number(/-lt (\d+)/.exec(script)![1]);
    expect(polls * 0.5).toBeLessThan(PERMISSION_HOOK_TIMEOUT_SECONDS);
  });

  it('parses with the system shell', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-script-'));
    try {
      const file = path.join(dir, 'permission-hook.sh');
      await fsp.writeFile(file, script, 'utf8');
      const res = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const p = cp.spawn('/bin/sh', ['-n', file]);
        let stderr = '';
        p.stderr.on('data', (d) => (stderr += String(d)));
        p.on('close', (code) => resolve({ code, stderr }));
      });
      expect(res.stderr).toBe('');
      expect(res.code).toBe(0);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('end to end: logs the payload, waits, and prints the decision it is given', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-script-e2e-'));
    try {
      const file = path.join(dir, 'permission-hook.sh');
      await fsp.writeFile(file, script, { encoding: 'utf8', mode: 0o755 });
      const payload = JSON.stringify({
        session_id: 'aaaaaaaa-2222-3333-4444-555555555555',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });

      const child = cp.spawn('/bin/sh', [file], { cwd: dir });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stdin.end(`${payload}\n`);

      // The script leaves its marker, then polls. Find the marker and answer it.
      const requests = path.join(dir, 'requests');
      let ids: string[] = [];
      for (let i = 0; i < 40 && ids.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ids = await fsp.readdir(requests).catch(() => []);
      }
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(/^\d+-\d+$/);

      // The log is named after the script's parent (`$PPID`), which is this test process.
      const logName = (await fsp.readdir(dir)).find((n) => n.endsWith('.jsonl'));
      expect(logName).toBe(`${process.pid}.jsonl`);
      const lines = (await fsp.readFile(path.join(dir, logName!), 'utf8')).trim().split('\n');
      expect(JSON.parse(lines[0])).toMatchObject({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
      expect(JSON.parse(lines[1])).toEqual({
        hook_event_name: 'AgentWranglerPermissionPending',
        session_id: 'aaaaaaaa-2222-3333-4444-555555555555',
        request_id: ids[0],
      });

      const decision = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n';
      await fsp.mkdir(path.join(dir, 'decisions'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'decisions', `${ids[0]}.json`), decision, 'utf8');

      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code).toBe(0);
      expect(stdout).toBe(decision);
      // Cleaned up after itself.
      expect(await fsp.readdir(requests)).toEqual([]);
      expect(await fsp.readdir(path.join(dir, 'decisions'))).toEqual([]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('end to end: exits quietly when its marker is withdrawn', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-script-e2e-'));
    try {
      const file = path.join(dir, 'permission-hook.sh');
      await fsp.writeFile(file, script, { encoding: 'utf8', mode: 0o755 });
      const child = cp.spawn('/bin/sh', [file], { cwd: dir });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += String(d)));
      child.stdin.end(`${JSON.stringify({ session_id: 'bbbbbbbb-2222-3333-4444-555555555555', hook_event_name: 'PermissionRequest' })}\n`);

      const requests = path.join(dir, 'requests');
      let ids: string[] = [];
      for (let i = 0; i < 40 && ids.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ids = await fsp.readdir(requests).catch(() => []);
      }
      expect(ids).toHaveLength(1);
      await fsp.unlink(path.join(requests, ids[0])); // what HookLog does once the prompt is answered in Claude

      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code).toBe(0);
      expect(stdout).toBe(''); // no decision printed: Claude Code keeps its own answer
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('removeHooks', () => {
  it('removes exactly ours and keeps the user hook', () => {
    const installed = mergeHooks(USER_HOOK, LOG_DIR).hooks;
    const { hooks, changed } = removeHooks(installed);
    expect(changed).toBe(true);
    expect(hooks.PreToolUse).toEqual(USER_HOOK.PreToolUse);
    // Events that only ever held our entry are dropped entirely.
    expect(hooks.Stop).toBeUndefined();
  });

  it('round-trips back to the original config', () => {
    const installed = mergeHooks(USER_HOOK, LOG_DIR).hooks;
    expect(removeHooks(installed).hooks).toEqual(USER_HOOK);
  });

  it('is a no-op when we were never installed', () => {
    expect(removeHooks(USER_HOOK).changed).toBe(false);
  });

  it('leaves an empty array the user wrote themselves alone', () => {
    const { hooks } = removeHooks({ Stop: [] });
    expect(hooks.Stop).toEqual([]);
  });
});

describe('detectIndent', () => {
  it('matches the existing file so we do not reformat it', () => {
    expect(detectIndent('{\n    "a": 1\n}')).toBe(4);
    expect(detectIndent('{\n  "a": 1\n}')).toBe(2);
    expect(detectIndent('{\n\t"a": 1\n}')).toBe('\t');
    expect(detectIndent('{}')).toBe(2);
  });
});

describe('install/uninstall against a real file', () => {
  let dir: string;
  let file: string;
  let logDir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-hooks-'));
    file = path.join(dir, 'settings.json');
    logDir = path.join(dir, 'agentwrangler');
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const realistic = {
    permissions: { allow: ['Bash(ls)'] },
    model: 'opus',
    hooks: USER_HOOK,
    enabledPlugins: { 'x@y': true },
    theme: 'dark',
  };

  it('preserves every unrelated key and backs the file up', async () => {
    await fsp.writeFile(file, `${JSON.stringify(realistic, null, 2)}\n`, 'utf8');
    const res = await installHooks(logDir, file);
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);

    const after = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(after.permissions).toEqual(realistic.permissions);
    expect(after.model).toBe('opus');
    expect(after.enabledPlugins).toEqual(realistic.enabledPlugins);
    expect(after.theme).toBe('dark');
    expect(after.hooks.PreToolUse[0]).toEqual(USER_HOOK.PreToolUse[0]);

    const backups = (await fsp.readdir(dir)).filter((f) => f.includes('agentwrangler-backup'));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await fsp.readFile(path.join(dir, backups[0]), 'utf8'))).toEqual(realistic);
  });

  it('creates the log directory and the executable permission script', async () => {
    await fsp.writeFile(file, '{}', 'utf8');
    await installHooks(logDir, file);
    expect((await fsp.stat(logDir)).isDirectory()).toBe(true);
    const script = await fsp.stat(permissionScriptPath(logDir));
    expect(script.isFile()).toBe(true);
    expect(script.mode & 0o111).not.toBe(0);
    expect(await fsp.readFile(permissionScriptPath(logDir), 'utf8')).toBe(permissionScript());
  });

  it('reports stale when the script is missing or outdated, and reinstall fixes it', async () => {
    await installHooks(logDir, file);
    expect((await currentState(logDir, file)).kind).toBe('installed');

    await fsp.writeFile(permissionScriptPath(logDir), '#!/bin/sh\n# old version\n', 'utf8');
    expect((await currentState(logDir, file)).kind).toBe('stale');

    const res = await installHooks(logDir, file);
    expect(res.changed).toBe(true);
    expect(res.message).toMatch(/script updated/);
    expect((await currentState(logDir, file)).kind).toBe('installed');
  });

  it('works when settings.json does not exist yet', async () => {
    const res = await installHooks(logDir, file);
    expect(res.ok).toBe(true);
    expect(JSON.parse(await fsp.readFile(file, 'utf8')).hooks.Stop).toHaveLength(1);
  });

  it('refuses to touch unparseable settings rather than clobbering them', async () => {
    // JSON with comments, a half-written file, whatever — losing it is unacceptable.
    const broken = '{\n  // a comment\n  "model": "opus"\n}';
    await fsp.writeFile(file, broken, 'utf8');
    const res = await installHooks(logDir, file);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not valid JSON/);
    expect(await fsp.readFile(file, 'utf8')).toBe(broken);
  });

  it('warns when disableAllHooks would silently suppress everything', async () => {
    await fsp.writeFile(file, JSON.stringify({ disableAllHooks: true }), 'utf8');
    const res = await installHooks(logDir, file);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/disableAllHooks/);
  });

  it('restores the original file on uninstall', async () => {
    const original = `${JSON.stringify(realistic, null, 2)}\n`;
    await fsp.writeFile(file, original, 'utf8');
    await installHooks(logDir, file);
    const res = await uninstallHooks(file);
    expect(res.changed).toBe(true);
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual(realistic);
  });

  it('reports install state accurately', async () => {
    await fsp.writeFile(file, JSON.stringify(realistic), 'utf8');
    expect(await currentState(logDir, file)).toEqual({ kind: 'absent' });

    await installHooks(logDir, file);
    expect(await currentState(logDir, file)).toEqual({ kind: 'installed', logDir });

    // A block pointing at an old directory is stale, not installed.
    expect((await currentState(path.join(dir, 'elsewhere'), file)).kind).toBe('stale');
  });

  it('detects a partially-installed block as stale', async () => {
    await installHooks(logDir, file);
    const obj = JSON.parse(await fsp.readFile(file, 'utf8'));
    delete obj.hooks.Stop;
    await fsp.writeFile(file, JSON.stringify(obj), 'utf8');
    expect((await currentState(logDir, file)).kind).toBe('stale');
  });
});

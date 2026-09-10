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
    expect(second.hooks.PreToolUse[1].hooks![0].command).toBe(hookCommandFor(LOG_DIR));
  });
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

  it('creates the log directory', async () => {
    await fsp.writeFile(file, '{}', 'utf8');
    await installHooks(logDir, file);
    expect((await fsp.stat(logDir)).isDirectory()).toBe(true);
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

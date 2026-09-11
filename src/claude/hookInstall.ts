/**
 * Installs/removes Agent Wrangler's hook block in `~/.claude/settings.json`.
 *
 * This is the one place the extension writes to the user's Claude config, so it
 * is deliberately conservative:
 *
 *  - It MERGES. Users have their own hooks (this machine already runs an
 *    `allow-readonly.py` PreToolUse hook on Bash); clobbering a hooks key would
 *    break someone's permission tooling.
 *  - Our entries are identified by a marker inside the command string, so
 *    uninstall removes exactly what we added and nothing that looks similar.
 *  - The file is backed up before the first write, and unparseable settings
 *    abort loudly rather than being overwritten.
 *  - Existing indentation is preserved, so a 96 KB settings file doesn't turn
 *    into a whole-file diff.
 *
 * Note for callers: Claude Code snapshots hooks at session startup, so an
 * install only affects sessions started afterwards. Editing settings mid-session
 * does nothing to running sessions.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { HOOK_EVENTS } from './hookEvents';
import { claudeHome } from './paths';

/** Present in every command we write; how we recognize our own entries later. */
export const HOOK_MARKER = 'agentwrangler';

/** Per-hook timeout (seconds). An append needs milliseconds; this is just a guard. */
const HOOK_TIMEOUT_SECONDS = 5;

/**
 * The PermissionRequest hook is the one that waits. Claude Code shows its own
 * dialog while the hook runs and takes whichever answers first (verified in the
 * 2.1.267 binary: hooks and the prompt are started together and raced), so a
 * long wait costs nothing — the dialog is not delayed — and it is what lets the
 * dashboard answer instead. The script gives up a little before this ceiling.
 */
export const PERMISSION_HOOK_TIMEOUT_SECONDS = 1800;
const PERMISSION_HOOK_MAX_POLLS = 3400; // × 0.5 s ≈ 28 min

export const PERMISSION_SCRIPT_NAME = 'permission-hook.sh';
/** Bumped whenever the script text changes; `currentState` reports the old file as stale. */
export const PERMISSION_SCRIPT_VERSION = 1;

export function permissionScriptPath(logDir: string): string {
  return path.join(logDir, PERMISSION_SCRIPT_NAME);
}

/**
 * The PermissionRequest hook. POSIX sh, no interpreter start-up beyond the
 * shell itself, no dependency past `sed` and `sleep`.
 *
 *  1. Append the payload to the per-process log exactly as the other hooks do.
 *  2. Leave an empty marker in `requests/` and announce it in the log with a
 *     synthetic `AgentWranglerPermissionPending` line, so the dashboard knows
 *     which prompt it can answer.
 *  3. Poll for `decisions/<id>.json`. The dashboard writes it when Allow or
 *     Deny is clicked; the script prints it — Claude Code reads the decision
 *     off stdout — and exits. If the marker disappears instead (the dashboard
 *     removes it once the prompt was answered in Claude Code), exit quietly.
 *
 * `$PPID` is the Claude process and `$$` this hook's shell, so the id is
 * unique per prompt without parsing anything. The session id is the one field
 * pulled out of the JSON, and it is a UUID, so a `sed` capture is safe.
 */
export function permissionScript(): string {
  return [
    '#!/bin/sh',
    `# Agent Wrangler PermissionRequest hook, v${PERMISSION_SCRIPT_VERSION}. Installed by the Agent Wrangler`,
    '# VSCode extension; re-run "Agent Wrangler: Install Status Hooks" to restore it.',
    '# Logs the permission prompt like every other hook, then waits for a decision',
    '# from the dashboard. Claude Code shows its own dialog meanwhile and takes',
    '# whichever answer comes first, so this wait never delays the prompt.',
    'dir=$(dirname "$0")',
    'payload=$(cat)',
    'printf \'%s\\n\' "$payload" >> "$dir/$PPID.jsonl"',
    'sid=$(printf \'%s\' "$payload" | sed -n \'s/.*"session_id":"\\([^"]*\\)".*/\\1/p\' | head -n 1)',
    '[ -n "$sid" ] || exit 0',
    'id="$PPID-$$"',
    'req="$dir/requests/$id"',
    'dec="$dir/decisions/$id.json"',
    'mkdir -p "$dir/requests" "$dir/decisions" || exit 0',
    ': > "$req" || exit 0',
    `printf '{"hook_event_name":"AgentWranglerPermissionPending","session_id":"%s","request_id":"%s"}\\n' "$sid" "$id" >> "$dir/$PPID.jsonl"`,
    'i=0',
    `while [ "$i" -lt ${PERMISSION_HOOK_MAX_POLLS} ]; do`,
    '  if [ -f "$dec" ]; then cat "$dec"; rm -f "$dec" "$req"; exit 0; fi',
    '  [ -e "$req" ] || exit 0',
    '  sleep 0.5',
    '  i=$((i+1))',
    'done',
    'rm -f "$req"',
    'exit 0',
    '',
  ].join('\n');
}

export interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommand[];
  [k: string]: unknown;
}

export type HooksConfig = Record<string, HookMatcherEntry[]>;

export function settingsPath(): string {
  return path.join(claudeHome(), 'settings.json');
}

/**
 * The shell command each hook runs. Shell form (no `args` key) is required:
 * `args` means exec-without-a-shell, and we need `>>`. `$PPID` is the Claude
 * process, which shards the log so concurrent sessions can't tear each other's
 * lines.
 */
export function hookCommandFor(logDir: string, event: string = 'Stop'): string {
  if (event === 'PermissionRequest') return `"${permissionScriptPath(logDir)}"`;
  return `cat >> "${logDir}/$PPID.jsonl"`;
}

export function isOurEntry(entry: HookMatcherEntry): boolean {
  return (entry.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(HOOK_MARKER));
}

function ourEntry(logDir: string, event: string): HookMatcherEntry {
  // No `matcher` key = match everything for this event. We filter by
  // notification_type etc. in our own parser rather than registering many
  // matchers, which keeps the block small and easy to verify by eye.
  const timeout = event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
  return {
    hooks: [{ type: 'command', command: hookCommandFor(logDir, event), timeout }],
  };
}

/**
 * Merge our entries into an existing hooks config. Pure. Other people's entries
 * are preserved in order; ours are replaced in place when the log dir changed.
 */
export function mergeHooks(
  existing: HooksConfig | undefined,
  logDir: string,
): { hooks: HooksConfig; changed: boolean } {
  const next: HooksConfig = {};
  let changed = false;

  for (const [event, entries] of Object.entries(existing ?? {})) {
    next[event] = Array.isArray(entries) ? [...entries] : entries;
  }

  for (const event of HOOK_EVENTS) {
    const entries = Array.isArray(next[event]) ? [...next[event]] : [];
    const mineAt = entries.findIndex(isOurEntry);
    const desired = ourEntry(logDir, event);
    if (mineAt === -1) {
      entries.push(desired);
      changed = true;
    } else if (JSON.stringify(entries[mineAt]) !== JSON.stringify(desired)) {
      entries[mineAt] = desired; // stale log dir or timeout → refresh in place
      changed = true;
    }
    next[event] = entries;
  }

  return { hooks: next, changed };
}

/** Remove exactly our entries, dropping events left empty. Pure. */
export function removeHooks(existing: HooksConfig | undefined): { hooks: HooksConfig; changed: boolean } {
  const next: HooksConfig = {};
  let changed = false;

  for (const [event, entries] of Object.entries(existing ?? {})) {
    if (!Array.isArray(entries)) {
      next[event] = entries;
      continue;
    }
    const kept = entries.filter((e) => !isOurEntry(e));
    if (kept.length !== entries.length) changed = true;
    // Only drop the key if it became empty *because of us*; an already-empty
    // array the user wrote stays as they left it.
    if (kept.length > 0 || entries.length === 0) next[event] = kept;
  }

  return { hooks: next, changed };
}

/** Indentation of the existing file, so we don't reformat a large settings.json. */
export function detectIndent(raw: string): string | number {
  const m = /\n([ \t]+)"/.exec(raw);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

export type InstallState =
  | { kind: 'installed'; logDir: string }
  | { kind: 'stale'; logDir: string }
  | { kind: 'absent' }
  | { kind: 'disabled'; why: string }
  | { kind: 'unreadable'; why: string };

interface RawSettings {
  hooks?: HooksConfig;
  disableAllHooks?: boolean;
  [k: string]: unknown;
}

async function readSettings(file: string): Promise<{ raw: string; obj: RawSettings } | { error: string }> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return { raw: '', obj: {} };
    return { error: `cannot read ${file}: ${String(err)}` };
  }
  if (raw.trim().length === 0) return { raw, obj: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: `${file} is not a JSON object` };
    }
    return { raw, obj: parsed as RawSettings };
  } catch (err) {
    // Do NOT overwrite something we can't parse (comments, trailing commas, or
    // a half-written file) — the user would silently lose their settings.
    return { error: `${file} is not valid JSON (${String(err)}); refusing to modify it` };
  }
}

/**
 * When settings.json was last written — a good enough proxy for "when were
 * hooks installed". Sessions started before that legitimately report nothing,
 * so it's what separates "hooks are suppressed" from "these sessions are old".
 */
export async function settingsModifiedAtMs(file = settingsPath()): Promise<number | undefined> {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function currentState(logDir: string, file = settingsPath()): Promise<InstallState> {
  const res = await readSettings(file);
  if ('error' in res) return { kind: 'unreadable', why: res.error };
  if (res.obj.disableAllHooks === true) return { kind: 'disabled', why: 'disableAllHooks is true in settings.json' };

  const hooks = res.obj.hooks ?? {};
  const found: string[] = [];
  let stale = false;
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const mine = entries.find(isOurEntry);
    if (!mine) continue;
    found.push(event);
    // Compare the whole entry, not just the command: a timeout change (the
    // PermissionRequest wait) is a real difference the reinstall must fix.
    if (JSON.stringify(mine) !== JSON.stringify(ourEntry(logDir, event))) stale = true;
  }

  if (found.length === 0) return { kind: 'absent' };
  if (stale || found.length !== HOOK_EVENTS.length) return { kind: 'stale', logDir };
  // The block can be current while the script it points at is old or gone.
  if (!(await permissionScriptCurrent(logDir))) return { kind: 'stale', logDir };
  return { kind: 'installed', logDir };
}

async function permissionScriptCurrent(logDir: string): Promise<boolean> {
  try {
    return (await fsp.readFile(permissionScriptPath(logDir), 'utf8')) === permissionScript();
  } catch {
    return false;
  }
}

/** Write the PermissionRequest script (tmp + rename, executable). */
async function writePermissionScript(logDir: string): Promise<void> {
  const target = permissionScriptPath(logDir);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, permissionScript(), { encoding: 'utf8', mode: 0o755 });
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, target);
}

async function writeWithBackup(file: string, raw: string, next: RawSettings): Promise<void> {
  if (raw.length > 0) {
    const backup = `${file}.agentwrangler-backup-${new Date().toISOString().replace(/[:.]/g, '')}`;
    await fsp.writeFile(backup, raw, 'utf8');
  }
  const indent = raw.length > 0 ? detectIndent(raw) : 2;
  const tmp = `${file}.agentwrangler-tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, indent)}\n`, 'utf8');
  await fsp.rename(tmp, file); // atomic: Claude Code never sees a partial file
}

export interface InstallResult {
  ok: boolean;
  changed: boolean;
  message: string;
}

export async function installHooks(logDir: string, file = settingsPath()): Promise<InstallResult> {
  const res = await readSettings(file);
  if ('error' in res) return { ok: false, changed: false, message: res.error };

  await fsp.mkdir(logDir, { recursive: true });
  const scriptWasCurrent = await permissionScriptCurrent(logDir);
  if (!scriptWasCurrent) await writePermissionScript(logDir);

  const { hooks, changed } = mergeHooks(res.obj.hooks, logDir);
  if (!changed) {
    return scriptWasCurrent
      ? { ok: true, changed: false, message: 'Agent Wrangler hooks were already installed and up to date.' }
      : {
          ok: true,
          changed: true,
          message:
            'Agent Wrangler permission hook script updated; settings.json was already current. ' +
            'Sessions started from now on use the new script.',
        };
  }
  await writeWithBackup(file, res.raw, { ...res.obj, hooks });

  const disabled = res.obj.disableAllHooks === true;
  return {
    ok: true,
    changed: true,
    message: disabled
      ? 'Hooks written, but `disableAllHooks` is true in settings.json — they will not run until you remove it.'
      : 'Agent Wrangler hooks installed. Claude Code captures hooks at session startup, so only sessions started from now on will report live status.',
  };
}

export async function uninstallHooks(file = settingsPath()): Promise<InstallResult> {
  const res = await readSettings(file);
  if ('error' in res) return { ok: false, changed: false, message: res.error };

  const { hooks, changed } = removeHooks(res.obj.hooks);
  if (!changed) return { ok: true, changed: false, message: 'No Agent Wrangler hooks were installed.' };

  const next: RawSettings = { ...res.obj };
  if (Object.keys(hooks).length === 0 && res.obj.hooks !== undefined) next.hooks = {};
  else next.hooks = hooks;
  await writeWithBackup(file, res.raw, next);

  return {
    ok: true,
    changed: true,
    message: 'Agent Wrangler hooks removed. Running sessions keep reporting until they end.',
  };
}

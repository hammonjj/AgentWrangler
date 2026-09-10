/**
 * Smoke test of the settings installer against the REAL `~/.claude/settings.json`
 * on this machine — operating on a COPY in a temp dir. The real file is only
 * ever read; nothing here writes to the user's Claude config.
 *
 * Skipped automatically when there is no settings.json (e.g. CI). This exists
 * because the unit tests use a small synthetic config, while real files are
 * large, hand-edited, and already contain the user's own hooks — exactly the
 * shape most likely to expose a merge bug.
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentState, installHooks, isOurEntry, settingsPath, uninstallHooks } from '../src/claude/hookInstall';
import { HOOK_EVENTS } from '../src/claude/hookEvents';

const real = settingsPath();
const hasSettings = fs.existsSync(real);

describe.runIf(hasSettings)('installer against the real settings.json (on a copy)', () => {
  it('preserves every key and every pre-existing hook, and uninstalls cleanly', async () => {
    const original = await fsp.readFile(real, 'utf8');
    let before: Record<string, unknown>;
    try {
      before = JSON.parse(original);
    } catch {
      // A JSONC/comment-bearing settings file is a valid thing to have; the
      // installer refuses to touch it, which is the behaviour under test.
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-live-'));
      const copy = path.join(dir, 'settings.json');
      await fsp.writeFile(copy, original, 'utf8');
      const res = await installHooks(path.join(dir, 'logs'), copy);
      expect(res.ok).toBe(false);
      expect(await fsp.readFile(copy, 'utf8')).toBe(original);
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-live-'));
    const copy = path.join(dir, 'settings.json');
    const logDir = path.join(dir, 'agentwrangler');
    await fsp.writeFile(copy, original, 'utf8');

    try {
      // Snapshot the user's own hook entries so we can prove we left them alone.
      const hooksBefore = (before.hooks ?? {}) as Record<string, unknown[]>;
      const theirEntries = Object.fromEntries(
        Object.entries(hooksBefore).map(([event, entries]) => [
          event,
          (Array.isArray(entries) ? entries : []).filter((e) => !isOurEntry(e as never)),
        ]),
      );

      // Once hooks are genuinely installed on this machine, `before` already
      // contains our block (pointing at the real log dir). Uninstall can then
      // only land on "the user's own hooks", never on `before` verbatim, so
      // compute that target the way `removeHooks` defines it: keys we emptied
      // are dropped, an already-empty array the user wrote stays.
      const theirHooksOnly: Record<string, unknown[]> = {};
      for (const [event, entries] of Object.entries(hooksBefore)) {
        const all = Array.isArray(entries) ? entries : [];
        const kept = theirEntries[event] ?? [];
        if (kept.length > 0 || all.length === 0) theirHooksOnly[event] = kept;
      }
      const hadOurs = Object.values(hooksBefore).some(
        (entries) => Array.isArray(entries) && entries.some((e) => isOurEntry(e as never)),
      );
      const afterUninstall: Record<string, unknown> = { ...before };
      if (before.hooks !== undefined || hadOurs) afterUninstall.hooks = theirHooksOnly;

      const res = await installHooks(logDir, copy);
      expect(res.ok, res.message).toBe(true);

      const after = JSON.parse(await fsp.readFile(copy, 'utf8')) as Record<string, unknown>;

      // Every top-level key the user had is still there, byte-identical except `hooks`.
      for (const key of Object.keys(before)) {
        expect(Object.keys(after), `top-level key ${key} survived`).toContain(key);
        if (key !== 'hooks') expect(after[key], `${key} unchanged`).toEqual(before[key]);
      }

      // Their hook entries survive, in order, on every event they configured.
      const hooksAfter = after.hooks as Record<string, unknown[]>;
      for (const [event, entries] of Object.entries(theirEntries)) {
        const kept = (hooksAfter[event] ?? []).filter((e) => !isOurEntry(e as never));
        expect(kept, `user hooks on ${event}`).toEqual(entries);
      }

      // And ours are present on every event we depend on.
      for (const event of HOOK_EVENTS) {
        expect((hooksAfter[event] ?? []).some((e) => isOurEntry(e as never)), `our hook on ${event}`).toBe(true);
      }
      expect(await currentState(logDir, copy)).toEqual({ kind: 'installed', logDir });

      // Uninstall must land exactly on the original content minus our block —
      // which is the original itself when the real file had none installed.
      const un = await uninstallHooks(copy);
      expect(un.ok).toBe(true);
      expect(JSON.parse(await fsp.readFile(copy, 'utf8'))).toEqual(afterUninstall);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }

    // Paranoia: the real file was never touched.
    expect(await fsp.readFile(real, 'utf8')).toBe(original);
  }, 30_000);
});

/**
 * Smoke test against the REAL ~/.claude on this machine (read-only).
 * Skipped automatically when ~/.claude/sessions doesn't exist (e.g. CI).
 */
import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectsDir, sessionsDir } from '../src/claude/paths';
import { isPidAlive, readRegistry } from '../src/claude/registry';
import { deriveStatus } from '../src/claude/status';
import { TranscriptIndex } from '../src/claude/transcriptIndex';

const hasClaude = fs.existsSync(sessionsDir());

describe.runIf(hasClaude)('live ~/.claude smoke', () => {
  it('reads the registry and derives statuses without throwing', async () => {
    const registry = await readRegistry(sessionsDir());
    expect(Array.isArray(registry)).toBe(true);
    for (const r of registry) {
      expect(isPidAlive(r.pid)).toBe(true);
      expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    }

    const index = new TranscriptIndex();
    await index.scanAll(projectsDir(), {
      liveIds: new Set(registry.map((r) => r.sessionId.toLowerCase())),
      endedWindowMs: 48 * 3_600_000,
      nowMs: Date.now(),
    });

    const now = Date.now();
    const rows = registry.map((r) => {
      const idx = index.get(r.sessionId.toLowerCase());
      const s = idx?.summary;
      const st = deriveStatus({
        pidAlive: true,
        lastMeaningful: s?.lastMeaningful,
        transcriptMtimeMs: s?.mtimeMs,
        nowMs: now,
        stuckThresholdMs: 60_000,
      });
      return {
        name: r.name ?? r.sessionId.slice(0, 8),
        status: st,
        title: s?.aiTitle ?? s?.slug ?? '(none)',
        last: s?.lastMeaningful ? `${s.lastMeaningful.kind}/${s.lastMeaningful.stopReason ?? '-'}` : '(no transcript)',
        cwd: r.cwd,
      };
    });

    // eslint-disable-next-line no-console
    console.table(rows);

    // Every live session must land on a live status, never 'ended'.
    for (const row of rows) expect(row.status).not.toBe('ended');
  }, 30_000);
});

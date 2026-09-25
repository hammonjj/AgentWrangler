/**
 * What `aw status` and `aw sessions` can say with the app quit: which session
 * hosts are still running (their manifests, checked against the process
 * table) and what the session registry last recorded. Read-only: nothing is
 * written, removed or signalled, since tidying is the app's job on its next
 * start (playbook §7.3, §20).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readManifests } from '../core/session/manifestFile';
import { isSameProcessAlive } from '../core/procStart';
import type { OfflineRecord, OfflineView } from './format';

/** The registry's key in `sessions.json` (`SessionRegistry`). */
const REGISTRY_KEY = 'agentWrangler.sessions';

export function readOfflineView(userDataDir: string, runDir: string): OfflineView {
  const hosts = readManifests(runDir, true).map(({ manifest: m }) => ({
    hostId: m.hostId,
    sessionId: m.sessionId,
    cwd: m.cwd,
    startedAt: m.startedAt,
    exitReason: m.exit?.reason,
    alive: !m.exit && isSameProcessAlive(m.hostPid, m.hostStartTime),
  }));
  return { hosts, records: readRecords(path.join(userDataDir, 'sessions.json')) };
}

/** The registry's records, newest first; anything malformed is skipped. */
export function readRecords(file: string): OfflineRecord[] {
  let raw: unknown;
  try {
    raw = (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)[REGISTRY_KEY];
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: OfflineRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.sessionId !== 'string' || typeof o.cwd !== 'string' || typeof o.state !== 'string' || typeof o.lastShownAt !== 'number') continue;
    out.push({
      sessionId: o.sessionId,
      provider: typeof o.provider === 'string' ? o.provider : 'claude',
      cwd: o.cwd,
      state: o.state,
      endedReason: typeof o.endedReason === 'string' ? o.endedReason : undefined,
      lastShownAt: o.lastShownAt,
    });
  }
  return out.sort((a, b) => b.lastShownAt - a.lastShownAt);
}

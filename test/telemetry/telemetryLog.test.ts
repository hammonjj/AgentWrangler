import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SEGMENTS, TelemetryLog, monthFile } from '../../src/core/telemetry/telemetryLog';
import type { TurnRecord } from '../../src/shared/orchestration/telemetry';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-tlog-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function turn(id: string, at: number): TurnRecord {
  return { v: 1, type: 'turn', at, id, sessionId: 's', harness: 'codex', source: 'openai', modelsUsed: {}, effort: {}, isError: false, costBasis: 'none' };
}

describe('TelemetryLog', () => {
  it('writes one file per UTC month', () => {
    const log = new TelemetryLog(dir);
    log.append(turn('a', Date.UTC(2026, 8, 30, 23, 59)));
    log.append(turn('b', Date.UTC(2026, 9, 1, 0, 1)));
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-09.jsonl', '2026-10.jsonl']);
    expect(monthFile('/x', Date.UTC(2027, 0, 5))).toBe(path.join('/x', '2027-01.jsonl'));
  });

  it('is idempotent by id', () => {
    const log = new TelemetryLog(dir);
    expect(log.append(turn('a', 0))).toBe(true);
    expect(log.append(turn('a', 0))).toBe(false);
    expect(fs.readFileSync(monthFile(dir, 0), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('remembers execution baselines across runs, marked as from disk', () => {
    new TelemetryLog(dir).setSegment('claude:h1', { totals: { models: {} }, lastId: 'r1', updatedAt: 5 });
    const next = new TelemetryLog(dir);
    expect(next.segment('claude:h1')).toEqual({ totals: { models: {} }, lastId: 'r1', updatedAt: 5, fromDisk: true });
    // The last id from disk also guards the log itself.
    expect(next.append(turn('r1', 0))).toBe(false);
  });

  it('keeps at most MAX_SEGMENTS baselines, dropping the oldest', () => {
    const log = new TelemetryLog(dir);
    for (let i = 0; i <= MAX_SEGMENTS; i++) log.setSegment(`k${i}`, { updatedAt: i });
    const again = new TelemetryLog(dir);
    expect(again.segment('k0')).toBeUndefined();
    expect(again.segment(`k${MAX_SEGMENTS}`)).toBeDefined();
  });

  it('starts empty on an unreadable state file', () => {
    fs.writeFileSync(path.join(dir, 'state.json'), 'nope');
    expect(new TelemetryLog(dir).segment('x')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  admissionRefusal,
  createJob,
  decideSlot,
  describeSchedule,
  latestSlot,
  MAX_JOB_HISTORY,
  nextSlot,
  parseStoredJobs,
  recordRun,
  sanitizeJobInput,
  setJobEnabled,
  type JobInput,
  type ScheduledJob,
} from '../src/shared/scheduledJobs';
import { ScheduledJobStore } from '../src/core/scheduledJobStore';
import { createJobDirectory, createScheduledJobs, type ScheduledJobDeps } from '../src/app/scheduledJobs';
import type { LaunchRequest } from '../src/core/session/sessionHandle';

const INPUT: JobInput = {
  name: 'Morning sweep',
  schedule: { weekdays: [1, 2, 3, 4, 5], time: '07:30' },
  provider: 'claude',
  folder: '/Users/test/proj',
  prompt: 'Review the open PRs.',
  allowedTools: ['Bash(gh pr view:*)'],
};

/** Local wall-clock time: the schedule is the Mac's own clock, whatever TZ the test runs in. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
// 2026-10-12 is a Monday.
const MON_0730 = at(2026, 10, 12, 7, 30);
const HOUR = 3_600_000;

function enabledJob(over: Partial<ScheduledJob> = {}): ScheduledJob {
  return { ...setJobEnabled(createJob('j1', INPUT, 0), true, at(2026, 10, 1)), ...over };
}

function memoryStorage(initial: Record<string, unknown> = {}) {
  const doc: Record<string, unknown> = { ...initial };
  return {
    doc,
    get<T>(key: string, def: T): T {
      return (doc[key] as T) ?? def;
    },
    update(key: string, value: unknown) {
      if (value === undefined) delete doc[key];
      else doc[key] = JSON.parse(JSON.stringify(value));
      return undefined;
    },
  };
}

describe('checking what the form sent', () => {
  it('accepts a tidy job, trims it and fills the defaults', () => {
    const r = sanitizeJobInput({ ...INPUT, name: ' Sweep ', folder: '/Users/test/proj/', schedule: { weekdays: [5, 1, 1, 3], time: '7:05' }, allowedTools: ' Read \n\nBash(gh pr view:*)\nRead' });
    expect(r).toEqual({
      value: {
        name: 'Sweep',
        kind: 'custom',
        schedule: { weekdays: [1, 3, 5], time: '07:05' },
        catchUpHours: 4,
        provider: 'claude',
        folder: '/Users/test/proj',
        prompt: 'Review the open PRs.',
        allowedTools: ['Read', 'Bash(gh pr view:*)'],
      },
    });
  });

  it.each([
    [{ ...INPUT, name: '' }, 'name'],
    [{ ...INPUT, schedule: { weekdays: [1], time: '25:00' } }, 'HH:MM'],
    [{ ...INPUT, schedule: { weekdays: [], time: '07:30' } }, 'day'],
    [{ ...INPUT, provider: 'gemini' }, 'Claude or Codex'],
    [{ ...INPUT, folder: 'proj' }, 'folder'],
    [{ ...INPUT, prompt: ' ' }, 'should do'],
    [{ ...INPUT, permissionMode: 'bypassPermissions' }, 'not allowed'],
    [{ ...INPUT, catchUpHours: 30 }, 'Catch-up'],
    [{ ...INPUT, maxWindowPercent: 0 }, 'percent'],
  ])('refuses %j', (input, words) => {
    const r = sanitizeJobInput(input);
    expect('error' in r && r.error).toContain(words);
  });

  it('never keeps allowed tools or a permission mode on a Codex job', () => {
    const r = sanitizeJobInput({ ...INPUT, provider: 'codex', permissionMode: 'acceptEdits' });
    expect('value' in r && r.value).toMatchObject({ provider: 'codex', allowedTools: [] });
    expect('value' in r && r.value.permissionMode).toBeUndefined();
  });
});

describe('a new job', () => {
  it('is off until turned on', () => {
    expect(createJob('j1', INPUT, 5).enabled).toBe(false);
    expect(decideSlot(createJob('j1', INPUT, 5), MON_0730)).toEqual({ kind: 'none' });
  });
});

describe('slots', () => {
  const weekdays = INPUT.schedule;

  it('finds the latest slot at or before now', () => {
    expect(latestSlot(weekdays, MON_0730)).toBe(MON_0730);
    expect(latestSlot(weekdays, MON_0730 - 1)).toBe(at(2026, 10, 9, 7, 30)); // the Friday before
    expect(latestSlot(weekdays, at(2026, 10, 18, 12))).toBe(at(2026, 10, 16, 7, 30)); // Sunday noon → Friday
  });

  it('finds the next slot after now', () => {
    expect(nextSlot(weekdays, MON_0730)).toBe(at(2026, 10, 13, 7, 30));
    expect(nextSlot(weekdays, at(2026, 10, 16, 8))).toBe(at(2026, 10, 19, 7, 30)); // Friday after → Monday
  });

  it('describes common schedules in words', () => {
    expect(describeSchedule(weekdays)).toBe('Weekdays at 07:30');
    expect(describeSchedule({ weekdays: [0, 1, 2, 3, 4, 5, 6], time: '06:00' })).toBe('Every day at 06:00');
    expect(describeSchedule({ weekdays: [1, 3], time: '09:15' })).toBe('Mon Wed at 09:15');
  });
});

describe('deciding a slot', () => {
  const cases: Array<[string, number, Partial<ScheduledJob>, ReturnType<typeof decideSlot>]> = [
    ['on time at the slot', MON_0730, {}, { kind: 'run', slot: MON_0730, late: false }],
    ['on time a minute after', MON_0730 + 60_000, {}, { kind: 'run', slot: MON_0730, late: false }],
    ['late inside the window', MON_0730 + 2 * HOUR, {}, { kind: 'run', slot: MON_0730, late: true }],
    ['at the window edge', MON_0730 + 4 * HOUR, {}, { kind: 'run', slot: MON_0730, late: true }],
    ['missed past the window', MON_0730 + 4 * HOUR + 1, {}, { kind: 'missed', slot: MON_0730 }],
    ['a zero window still runs on time', MON_0730 + 60_000, { catchUpHours: 0 }, { kind: 'run', slot: MON_0730, late: false }],
    ['a zero window misses after the grace', MON_0730 + 10 * 60_000, { catchUpHours: 0 }, { kind: 'missed', slot: MON_0730 }],
    ['nothing for a slot before it was turned on', MON_0730 + HOUR, { enabledAt: MON_0730 + 1 }, { kind: 'none' }],
  ];
  it.each(cases)('%s', (_name, now, over, expected) => {
    expect(decideSlot(enabledJob(over), now)).toEqual(expected);
  });

  it('never runs one slot twice', () => {
    for (const outcome of ['ran', 'late', 'failed', 'missed'] as const) {
      const job = recordRun(enabledJob(), { id: 'r', slot: MON_0730, at: MON_0730, outcome });
      expect(decideSlot(job, MON_0730 + HOUR)).toEqual({ kind: 'none' });
    }
  });

  it('retries a skipped slot while its window is open, and then leaves the skip as the record', () => {
    const job = recordRun(enabledJob(), { id: 'r', slot: MON_0730, at: MON_0730, outcome: 'skipped', reason: 'the fleet is paused' });
    expect(decideSlot(job, MON_0730 + HOUR)).toEqual({ kind: 'run', slot: MON_0730, late: true });
    expect(decideSlot(job, MON_0730 + 5 * HOUR)).toEqual({ kind: 'none' });
  });

  it('after a long sleep, runs or misses only the latest slot', () => {
    // Off from Friday morning to Monday 08:00: one late run for Monday, nothing for Friday.
    expect(decideSlot(enabledJob(), at(2026, 10, 12, 8))).toEqual({ kind: 'run', slot: MON_0730, late: true });
  });
});

describe('history', () => {
  it('replaces a repeated skip of one slot instead of piling them up', () => {
    let job = enabledJob();
    for (let i = 0; i < 5; i++) job = recordRun(job, { id: `r${i}`, slot: MON_0730, at: MON_0730 + i, outcome: 'skipped', reason: 'paused' });
    expect(job.history).toHaveLength(1);
    expect(job.history[0]!.id).toBe('r4');
  });

  it('keeps the newest runs only', () => {
    let job = enabledJob();
    for (let i = 0; i < MAX_JOB_HISTORY + 5; i++) job = recordRun(job, { id: `r${i}`, at: i, outcome: 'ran', manual: true });
    expect(job.history).toHaveLength(MAX_JOB_HISTORY);
    expect(job.history[0]!.id).toBe(`r${MAX_JOB_HISTORY + 4}`);
  });

  it('drops malformed stored jobs and runs rather than failing the lot', () => {
    const good = { ...enabledJob(), history: [{ id: 'r', at: 1, outcome: 'ran' }, { id: 'x', at: 2, outcome: 'exploded' }] };
    const parsed = parseStoredJobs([good, { id: 'bad' }, null, 'nope']);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.enabled).toBe(true);
    expect(parsed[0]!.history).toEqual([{ id: 'r', at: 1, outcome: 'ran' }]);
  });
});

describe('admission', () => {
  const base = { fleetPaused: false, autoPausePercent: 98 };
  it.each([
    [{ ...base, fleetPaused: true }, {}, 'paused'],
    [{ ...base, windowPercent: 98 }, {}, '98%'],
    [{ ...base, windowPercent: 70 }, { maxWindowPercent: 60 }, 'limit 60%'],
    [{ ...base, backoffUntil: 2_000 }, {}, 'rate-limited'],
  ])('refuses %j', (state, job, words) => {
    expect(admissionRefusal(job, state, 1_000)).toContain(words);
  });

  it('admits with headroom or no reading', () => {
    expect(admissionRefusal({}, { ...base, windowPercent: 50 }, 0)).toBeUndefined();
    expect(admissionRefusal({}, base, 0)).toBeUndefined();
  });
});

describe('the store', () => {
  it('persists jobs and their runs, and survives a reload', () => {
    const storage = memoryStorage();
    let n = 0;
    const store = new ScheduledJobStore(storage, () => 100, () => `id${++n}`);
    const job = store.create(INPUT);
    store.setEnabled(job.id, true);
    store.record(job.id, { id: 'r1', at: 100, outcome: 'ran', manual: true });
    store.amendRun(job.id, 'r1', { sessionId: 's1' });
    const again = new ScheduledJobStore(storage);
    expect(again.get('id1')).toMatchObject({ enabled: true, enabledAt: 100, history: [{ id: 'r1', sessionId: 's1' }] });
  });

  it('does not overwrite an edit made elsewhere when it records a run', () => {
    const storage = memoryStorage();
    const a = new ScheduledJobStore(storage, () => 1, () => 'j');
    a.create(INPUT);
    const b = new ScheduledJobStore(storage, () => 2);
    b.update('j', { ...INPUT, name: 'Renamed' });
    a.record('j', { id: 'r', at: 3, outcome: 'ran' });
    expect(new ScheduledJobStore(storage).get('j')).toMatchObject({ name: 'Renamed', history: [{ id: 'r' }] });
  });
});

describe('the scheduler', () => {
  function harness(opts: { globalDir?: string; now?: number; admission?: Partial<ReturnType<ScheduledJobDeps['admission']>>; folderExists?: boolean; mayStart?: boolean; sendOutcome?: string; launchThrows?: string } = {}) {
    const storage = memoryStorage();
    const store = new ScheduledJobStore(storage, () => at(2026, 10, 1), () => 'j1');
    const launches: LaunchRequest[] = [];
    const sent: string[] = [];
    const notices: string[] = [];
    let clock = opts.now ?? MON_0730;
    const timers: Array<() => void> = [];
    const jobs = createScheduledJobs({
      jobs: store,
      sessions: {
        async launch(req) {
          if (opts.launchThrows) throw new Error(opts.launchThrows);
          launches.push(req);
          return {
            provider: req.provider,
            sessionId: req.sessionId,
            async send(text: string) {
              sent.push(text);
              return opts.sendOutcome ?? 'applied';
            },
          } as never;
        },
      },
      launchDefaults: { request: (provider, cwd, overrides) => ({ provider, cwd, model: 'default-model', permissionMode: 'default', ...overrides }) },
      admission: () => ({ fleetPaused: false, autoPausePercent: 98, ...opts.admission }),
      mayStart: () => opts.mayStart ?? true,
      notify: (n) => notices.push(`${n.title}: ${n.body}`),
      log: () => {},
      now: () => clock,
      isDirectory: () => opts.folderExists ?? true,
      ...(opts.globalDir ? { globalDir: () => opts.globalDir! } : {}),
      setInterval: (fn) => timers.push(fn),
      clearInterval: () => {},
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    });
    const directory = createJobDirectory(store, jobs, { warn: async () => 'Delete' });
    return { store, jobs, directory, launches, sent, notices, timers, setClock: (t: number) => (clock = t) };
  }

  it('starts nothing for a job that is off', async () => {
    const h = harness();
    h.store.create(INPUT);
    await h.jobs.tick();
    expect(h.launches).toHaveLength(0);
  });

  it('launches an enabled job at its slot through the launch defaults, with its own settings, and sends the prompt', async () => {
    const h = harness();
    h.store.create({ ...INPUT, model: 'opus', permissionMode: 'acceptEdits' });
    h.store.setEnabled('j1', true);
    await h.jobs.tick();
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]).toMatchObject({
      provider: 'claude',
      cwd: '/Users/test/proj',
      model: 'opus',
      permissionMode: 'acceptEdits',
      policy: { claude: { allowedTools: ['Bash(gh pr view:*)'] } },
      origin: { kind: 'job', jobId: 'j1' },
    });
    expect(h.sent).toEqual(['Review the open PRs.']);
    const run = h.store.get('j1')!.history[0]!;
    expect(run).toMatchObject({ slot: MON_0730, outcome: 'ran', provider: 'claude', sessionId: h.launches[0]!.sessionId });
    // A second tick in the same slot does nothing.
    await h.jobs.tick();
    expect(h.launches).toHaveLength(1);
  });

  it('defaults a Claude job to default, never to auto, the launcher default or bypass', async () => {
    const h = harness();
    h.store.create(INPUT);
    h.store.setEnabled('j1', true);
    await h.jobs.tick();
    expect(h.launches[0]!.permissionMode).toBe('default');
  });

  it('labels a catch-up run late', async () => {
    const h = harness({ now: MON_0730 + 2 * HOUR });
    h.store.create(INPUT);
    h.store.setEnabled('j1', true);
    await h.jobs.tick();
    expect(h.store.get('j1')!.history[0]!.outcome).toBe('late');
  });

  it('records a missed slot once and starts nothing', async () => {
    const h = harness({ now: MON_0730 + 6 * HOUR });
    h.store.create(INPUT);
    h.store.setEnabled('j1', true);
    await h.jobs.tick();
    await h.jobs.tick();
    expect(h.launches).toHaveLength(0);
    expect(h.store.get('j1')!.history.map((r) => r.outcome)).toEqual(['missed']);
  });

  it('skips while paused, says why once, and runs late once the pause lifts', async () => {
    const admission = { fleetPaused: true };
    const h = harness({ admission });
    h.store.create(INPUT);
    h.store.setEnabled('j1', true);
    await h.jobs.tick();
    await h.jobs.tick();
    expect(h.launches).toHaveLength(0);
    expect(h.store.get('j1')!.history).toMatchObject([{ outcome: 'skipped', reason: 'the fleet is paused' }]);
    expect(h.notices).toHaveLength(1);
    admission.fleetPaused = false;
    h.setClock(MON_0730 + HOUR);
    await h.jobs.tick();
    expect(h.launches).toHaveLength(1);
    expect(h.store.get('j1')!.history.map((r) => r.outcome)).toEqual(['late']);
  });

  it('fails, without launching, when the folder is gone or the daemon may not start a session', async () => {
    for (const opts of [{ folderExists: false }, { mayStart: false }]) {
      const h = harness(opts);
      h.store.create(INPUT);
      h.store.setEnabled('j1', true);
      await h.jobs.tick();
      expect(h.launches).toHaveLength(0);
      expect(h.store.get('j1')!.history[0]!.outcome).toBe('failed');
    }
  });

  it('records a launch error as a failed run and says so', async () => {
    const h = harness({ launchThrows: 'no session host' });
    h.store.create(INPUT);
    h.store.setEnabled('j1', true);
    await h.jobs.tick();
    expect(h.store.get('j1')!.history[0]).toMatchObject({ outcome: 'failed', reason: 'no session host' });
    expect(h.notices[0]).toContain('no session host');
  });

  it('runs now on request, enabled or not, but still respects the pause', async () => {
    const h = harness();
    h.store.create(INPUT);
    const r = await h.directory.runNow('j1');
    expect('runId' in r).toBe(true);
    expect(h.store.get('j1')!.history[0]).toMatchObject({ manual: true, outcome: 'ran' });
    expect(h.store.get('j1')!.history[0]!.slot).toBeUndefined();

    const paused = harness({ admission: { fleetPaused: true } });
    paused.store.create(INPUT);
    expect(await paused.directory.runNow('j1')).toEqual({ error: 'Not started: the fleet is paused.' });
    expect(paused.launches).toHaveLength(0);
  });

  it('decides on start and on wake', async () => {
    const h = harness({ now: MON_0730 + HOUR });
    h.store.create(INPUT);
    h.store.setEnabled('j1', true);
    h.jobs.onWake();
    await h.jobs.tick(); // joins the wake's evaluation
    expect(h.launches).toHaveLength(1);
    expect(h.timers.length).toBeGreaterThanOrEqual(2); // the minute ticker and the first tick after start
  });

  it('saves through the directory with the same checks as the form', () => {
    const h = harness();
    expect(h.directory.save(undefined, { ...INPUT, name: '' })).toEqual({ error: 'Give the job a name.' });
    expect(h.directory.save(undefined, INPUT)).toEqual({ id: 'j1' });
    expect(h.directory.save('nope', INPUT)).toEqual({ error: 'That job no longer exists.' });
    expect(h.directory.views()[0]).toMatchObject({ id: 'j1', enabled: false, scheduleText: 'Weekdays at 07:30', starting: false });
  });

  it('says a brief is ready once per run, pointing at its session', async () => {
    const h = harness();
    h.store.create({ ...INPUT, notifyOnDone: true });
    await h.directory.runNow('j1');
    const sid = h.launches[0]!.sessionId!;
    h.jobs.sessionDone('claude', sid.toUpperCase());
    h.jobs.sessionDone('claude', sid);
    h.jobs.sessionDone('claude', 'someone-else');
    expect(h.notices).toEqual(['Morning sweep is ready: Open it to read.']);
    expect(h.directory.views()[0]!.latestSessionKey).toBe(`claude:${sid}`);
  });

  it('runs a Global job in the scratch folder', async () => {
    const { GLOBAL_PROJECT_DIR } = await import('../src/shared/model');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = `${mkdtempSync(`${tmpdir()}/aw-jobs-`)}/global`;
    const h = harness({ folderExists: false, globalDir: dir });
    h.store.create({ ...INPUT, folder: GLOBAL_PROJECT_DIR });
    await h.directory.runNow('j1');
    expect(h.launches[0]!.cwd).toBe(dir);
  });
});

describe('the Jobs view', () => {
  it('sends what the form holds in the shape the host checks', async () => {
    const { blankJobForm, jobFormInput, jobFormFor } = await import('../src/webview/dashboard/jobs');
    const form = { ...blankJobForm('/Users/test/proj'), name: 'Sweep', prompt: 'Go.', allowedTools: ' Read \n\n Bash(gh pr view:*) ', maxWindowPercent: '80' };
    const input = jobFormInput(form);
    expect(sanitizeJobInput(input)).toEqual({ value: expect.objectContaining({ name: 'Sweep', folder: '/Users/test/proj', allowedTools: ['Read', 'Bash(gh pr view:*)'], maxWindowPercent: 80, catchUpHours: 4 }) });
    const job = createJob('j1', (sanitizeJobInput(input) as { value: JobInput }).value, 0);
    expect(jobFormInput(jobFormFor({ ...job, scheduleText: '', starting: false }))).toEqual(input);
  });

  it('escapes what it draws and says a new job is off', async () => {
    const { jobsHtml, newJobsUiState } = await import('../src/webview/dashboard/jobs');
    const job = createJob('j1', { ...INPUT, name: '<b>x</b>' }, 0);
    const html = jobsHtml([{ ...job, scheduleText: 'Weekdays at 07:30', starting: false }], newJobsUiState(), [], 0);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('Turn on');
    expect(html).not.toMatch(/style=/);
  });
});

describe('the daily brief (#167)', () => {
  it('is a valid job: read-only tools, dontAsk, the Global folder, a notice when done', async () => {
    const { jobTemplate, BRIEF_ALLOWED_TOOLS, BRIEF_WORD_BUDGET } = await import('../src/shared/jobTemplates');
    const { GLOBAL_PROJECT_DIR } = await import('../src/shared/model');
    const r = sanitizeJobInput(jobTemplate('brief')!.input(undefined));
    expect('value' in r && r.value).toMatchObject({ kind: 'brief', permissionMode: 'dontAsk', folder: GLOBAL_PROJECT_DIR, notifyOnDone: true });
    expect(BRIEF_ALLOWED_TOOLS.some((t) => /send|reply|forward|create|update|delete|move|post|reaction|accept|respond|draft|schedule|trash|label/i.test(t))).toBe(false);
    expect('value' in r && r.value.prompt).toContain(`${BRIEF_WORD_BUDGET} words`);
  });

  it('every template passes the form checks once a folder is chosen', async () => {
    const { JOB_TEMPLATES } = await import('../src/shared/jobTemplates');
    for (const t of JOB_TEMPLATES) {
      const input = t.input('/Users/test/proj');
      const r = sanitizeJobInput({ ...input, name: input.name || 'x', prompt: input.prompt || 'x' });
      expect('value' in r).toBe(true);
    }
  });
});

describe('fixes from review', () => {
  it('keeps a stored job that no longer reads instead of deleting it on the next write', () => {
    const storage = memoryStorage({ 'agentWrangler.scheduledJobs': [{ id: 'broken', name: '' }] });
    const store = new ScheduledJobStore(storage, () => 1, () => 'j');
    store.create(INPUT);
    expect((storage.doc['agentWrangler.scheduledJobs'] as Array<{ id: string }>).map((j) => j.id)).toEqual(['j', 'broken']);
    expect(store.list.map((j) => j.id)).toEqual(['j']);
  });

  it('reads a job stored with auto as default', () => {
    const job = { ...createJob('j1', INPUT, 0), permissionMode: 'auto' };
    expect(parseStoredJobs([job])[0]!.permissionMode).toBeUndefined();
  });

  it('does not start a job turned off while an earlier job was still launching', async () => {
    const storage = memoryStorage();
    let n = 0;
    const store = new ScheduledJobStore(storage, () => at(2026, 10, 1), () => `j${++n}`);
    store.create(INPUT);
    store.create({ ...INPUT, name: 'Second' });
    store.setEnabled('j1', true);
    store.setEnabled('j2', true);
    const launched: string[] = [];
    const jobs = createScheduledJobs({
      jobs: store,
      sessions: {
        async launch(req) {
          launched.push((req.origin as { jobId: string }).jobId);
          if (launched.length === 1) store.setEnabled('j2', false); // turned off mid-tick
          return { provider: 'claude', sessionId: 's', send: async () => 'applied' } as never;
        },
      },
      launchDefaults: { request: (provider, cwd, o) => ({ provider, cwd, ...o }) },
      admission: () => ({ fleetPaused: false, autoPausePercent: 98 }),
      mayStart: () => true,
      notify: () => {},
      log: () => {},
      now: () => MON_0730,
      isDirectory: () => true,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    await jobs.tick();
    expect(launched).toEqual(['j1']);
  });
});

describe('repeating through the day (#184)', () => {
  const hourly = { weekdays: [1, 2, 3, 4, 5], time: '08:00', every: { minutes: 60, until: '20:00' } };

  it('checks the repeat', () => {
    const ok = sanitizeJobInput({ ...INPUT, schedule: { ...hourly, every: { minutes: '60', until: '20:00' } } });
    expect('value' in ok && ok.value.schedule).toEqual(hourly);
    expect('error' in sanitizeJobInput({ ...INPUT, schedule: { ...hourly, every: { minutes: 7, until: '20:00' } } })).toBe(true);
    expect('error' in sanitizeJobInput({ ...INPUT, schedule: { ...hourly, every: { minutes: 60, until: '07:00' } } })).toBe(true);
    const once = sanitizeJobInput({ ...INPUT, schedule: { weekdays: [1], time: '08:00', every: { minutes: '', until: '20:00' } } });
    expect('value' in once && once.value.schedule.every).toBeUndefined();
  });

  it('finds hourly slots, the last at the end time, and none overnight', () => {
    expect(latestSlot(hourly, at(2026, 10, 12, 10, 59))).toBe(at(2026, 10, 12, 10));
    expect(latestSlot(hourly, at(2026, 10, 12, 20, 30))).toBe(at(2026, 10, 12, 20));
    expect(latestSlot(hourly, at(2026, 10, 13, 7, 0))).toBe(at(2026, 10, 12, 20)); // Tuesday early → Monday's last
    expect(nextSlot(hourly, at(2026, 10, 12, 10, 0))).toBe(at(2026, 10, 12, 11));
    expect(nextSlot(hourly, at(2026, 10, 16, 20, 1))).toBe(at(2026, 10, 19, 8)); // Friday night → Monday 08:00
    expect(describeSchedule(hourly)).toBe('Weekdays, every hour, 08:00–20:00');
    expect(describeSchedule({ ...hourly, every: { minutes: 30, until: '12:00' } })).toBe('Weekdays, every 30 min, 08:00–12:00');
  });

  it('runs each slot once, and after a gap only the latest', () => {
    let job = enabledJob({ schedule: hourly });
    expect(decideSlot(job, at(2026, 10, 12, 9, 1))).toEqual({ kind: 'run', slot: at(2026, 10, 12, 9), late: false });
    job = recordRun(job, { id: 'r', slot: at(2026, 10, 12, 9), at: 0, outcome: 'ran' });
    expect(decideSlot(job, at(2026, 10, 12, 9, 30))).toEqual({ kind: 'none' });
    expect(decideSlot(job, at(2026, 10, 12, 13, 10))).toEqual({ kind: 'run', slot: at(2026, 10, 12, 13), late: true });
  });

  it('waits while the previous run is still going, without a notification', async () => {
    const storage = memoryStorage();
    const store = new ScheduledJobStore(storage, () => at(2026, 10, 1), () => 'j1');
    store.create({ ...INPUT, schedule: hourly });
    store.setEnabled('j1', true);
    store.record('j1', { id: 'r0', slot: at(2026, 10, 12, 9), at: 0, outcome: 'ran', provider: 'claude', sessionId: 's0' });
    let busy = true;
    let clock = at(2026, 10, 12, 10);
    const launched: string[] = [];
    const notices: string[] = [];
    const jobs = createScheduledJobs({
      jobs: store,
      sessions: { async launch(req) { launched.push(req.cwd); return { provider: 'claude', sessionId: 's1', send: async () => 'applied' } as never; } },
      launchDefaults: { request: (provider, cwd, o) => ({ provider, cwd, ...o }) },
      admission: () => ({ fleetPaused: false, autoPausePercent: 98 }),
      mayStart: () => true,
      runActive: (r) => busy && r.sessionId === 's0',
      notify: (n) => notices.push(n.title),
      log: () => {},
      now: () => clock,
      isDirectory: () => true,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    await jobs.tick();
    expect(launched).toHaveLength(0);
    expect(store.get('j1')!.history[0]).toMatchObject({ outcome: 'skipped', reason: 'the previous run is still going' });
    expect(notices).toEqual([]);
    busy = false;
    clock = at(2026, 10, 12, 10, 20);
    await jobs.tick();
    expect(launched).toHaveLength(1);
  });
});

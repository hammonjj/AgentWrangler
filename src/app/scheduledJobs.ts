/**
 * Scheduled jobs (#164, #165) as the core daemon runs them.
 *
 * Once a minute, and on start and wake, each enabled job's latest slot is
 * decided (`decideSlot`): run it, record it missed, or leave it. A run goes
 * through the same launch path as "new conversation", as the daemon acting
 * on the owner's behalf (`session.start`), with the job's model, effort,
 * permission mode and allowed tools. It is a normal session: it shows in the
 * table, its prompts wait in *Waiting* and reach the user through the usual
 * notifications, and nothing here answers one. No window is focused and
 * nothing is restarted.
 *
 * Admission follows the scheduler's rules (#45): no start while the fleet is
 * paused, while the provider is rate-limited, or while a usage window is at
 * the job's limit. A refused slot is recorded as skipped with the reason and
 * tried again while its catch-up window is open.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { Disposable } from '../core/events';
import type { LaunchDefaults } from '../core/launchDefaults';
import type { ScheduledJobStore } from '../core/scheduledJobStore';
import type { SessionExecutors } from '../core/session/sessionExecutors';
import type { HostNotice } from '../host/hostServices';
import { admissionRefusal, decideSlot, jobOrigin, jobView, sanitizeJobInput, type AdmissionState, type JobRun, type JobView, type ScheduledJob } from '../shared/scheduledJobs';
import type { JobDirectory } from '../ui/jobDirectory';

export interface ScheduledJobDeps {
  jobs: ScheduledJobStore;
  sessions: Pick<SessionExecutors, 'launch'>;
  launchDefaults: Pick<LaunchDefaults, 'request'>;
  /** Pause, usage and backoff for the job's provider, read now. */
  admission: (provider: ScheduledJob['provider']) => AdmissionState;
  /** May the daemon start a session on the owner's behalf (`authorize`, audited). */
  mayStart: (jobId: string) => boolean;
  notify: (notice: HostNotice) => void;
  log: (line: string) => void;
  now?: () => number;
  isDirectory?: (dir: string) => boolean;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export type RunNowResult = { runId: string } | { error: string };

export interface ScheduledJobs {
  views(): JobView[];
  /** Decide every job's slot now. Returns once the runs it started have launched. */
  tick(): Promise<void>;
  /** Start a run of the job now, enabled or not. Admission still applies. */
  runNow(id: string): Promise<RunNowResult>;
  /** The Mac woke: slots passed during the sleep are decided now. */
  onWake(): void;
  dispose(): void;
}

export const TICK_MS = 60_000;
/** The first decision after start, once usage and the session scan have had a moment. */
export const FIRST_TICK_MS = 15_000;

export function createScheduledJobs(deps: ScheduledJobDeps): ScheduledJobs {
  const { jobs, log } = deps;
  const now = deps.now ?? Date.now;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  /** Jobs with a run launching: one at a time per job. */
  const starting = new Set<string>();
  let ticking: Promise<void> | undefined;
  let disposed = false;

  const runId = () => `r-${randomUUID().slice(0, 8)}`;

  const notifyOnce = (job: ScheduledJob, run: JobRun, title: string) => {
    deps.notify({ title, body: `${job.name}: ${run.reason ?? run.outcome}`, tag: `job:${job.id}:${run.slot ?? run.id}:${run.outcome}` });
  };

  /** Launch one run. The run is recorded first, so a crash mid-launch still leaves a line. */
  async function launch(job: ScheduledJob, run: JobRun): Promise<RunNowResult> {
    if (!isDirectory(job.folder)) {
      const failed: JobRun = { ...run, outcome: 'failed', reason: `${job.folder} does not exist` };
      jobs.record(job.id, failed);
      notifyOnce(job, failed, 'Scheduled job failed');
      return { error: failed.reason! };
    }
    if (!deps.mayStart(job.id)) {
      const failed: JobRun = { ...run, outcome: 'failed', reason: 'not authorized to start a session' };
      jobs.record(job.id, failed);
      return { error: failed.reason! };
    }
    starting.add(job.id);
    jobs.record(job.id, { ...run, provider: job.provider });
    try {
      const claude = job.provider === 'claude';
      const handle = await deps.sessions.launch(
        deps.launchDefaults.request(job.provider, job.folder, {
          ...(job.model ? { model: job.model } : {}),
          ...(job.effort ? { effort: job.effort } : {}),
          ...(claude ? { sessionId: randomUUID(), permissionMode: job.permissionMode ?? 'auto' } : {}),
          ...(claude && job.allowedTools.length ? { policy: { claude: { allowedTools: [...job.allowedTools] } } } : {}),
          origin: jobOrigin(job.id, run.id),
        }),
      );
      const early = handle.sessionId;
      if (early) jobs.amendRun(job.id, run.id, { sessionId: early });
      log(`scheduled job ${job.id}: started a ${job.provider} session (${run.manual ? 'run now' : run.outcome})`);
      const outcome = await handle.send(job.prompt);
      if (outcome !== 'applied') throw new Error('the session started but did not take the prompt');
      // A Codex thread learns its id with its first turn.
      if (!early && handle.sessionId) jobs.amendRun(job.id, run.id, { sessionId: handle.sessionId });
      return { runId: run.id };
    } catch (error) {
      const reason = (error as Error).message || String(error);
      jobs.amendRun(job.id, run.id, { outcome: 'failed', reason });
      log(`scheduled job ${job.id}: run failed: ${reason}`);
      notifyOnce(job, { ...run, outcome: 'failed', reason }, 'Scheduled job failed');
      return { error: reason };
    } finally {
      starting.delete(job.id);
    }
  }

  async function decide(job: ScheduledJob, at: number): Promise<void> {
    if (starting.has(job.id)) return;
    const d = decideSlot(job, at);
    if (d.kind === 'none') return;
    if (d.kind === 'missed') {
      jobs.record(job.id, { id: runId(), slot: d.slot, at, outcome: 'missed', reason: 'the Mac was asleep or off past the catch-up window' });
      log(`scheduled job ${job.id}: missed its slot`);
      return;
    }
    const refusal = admissionRefusal(job, deps.admission(job.provider), at);
    if (refusal) {
      const firstSkip = !job.history.some((r) => r.slot === d.slot);
      const run: JobRun = { id: runId(), slot: d.slot, at, outcome: 'skipped', reason: refusal };
      jobs.record(job.id, run);
      if (firstSkip) {
        log(`scheduled job ${job.id}: skipped (${refusal})`);
        notifyOnce(job, run, 'Scheduled job skipped');
      }
      return;
    }
    await launch(job, { id: runId(), slot: d.slot, at, outcome: d.late ? 'late' : 'ran' });
  }

  function tick(): Promise<void> {
    if (disposed) return Promise.resolve();
    // One evaluation at a time: a wake and the minute timer arriving together decide once.
    ticking ??= (async () => {
      try {
        const at = now();
        for (const job of jobs.list) {
          if (!job.enabled) continue;
          try {
            await decide(job, at);
          } catch (error) {
            log(`scheduled job ${job.id}: ${(error as Error).message}`);
          }
        }
      } finally {
        ticking = undefined;
      }
    })();
    return ticking;
  }

  const setI = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms).unref());
  const clearI = deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout));
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const interval = setI(() => void tick(), TICK_MS);
  const first = setT(() => void tick(), FIRST_TICK_MS);
  const subs: Disposable[] = [];

  return {
    views: () => {
      const at = now();
      return jobs.list.map((j) => jobView(j, at, starting.has(j.id)));
    },
    tick,
    async runNow(id) {
      const job = jobs.get(id);
      if (!job) return { error: 'That job no longer exists.' };
      if (starting.has(id)) return { error: `${job.name} is already starting.` };
      const at = now();
      const refusal = admissionRefusal(job, deps.admission(job.provider), at);
      if (refusal) return { error: `Not started: ${refusal}.` };
      return launch(job, { id: runId(), at, outcome: 'ran', manual: true });
    },
    onWake() {
      log('woke from sleep: checking scheduled jobs');
      void tick();
    },
    dispose() {
      disposed = true;
      clearI(interval);
      clearT(first);
      subs.forEach((s) => s.dispose());
    },
  };
}

function defaultIsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The Jobs view's handle on the store and the scheduler (`ui/jobDirectory.ts`). */
export function createJobDirectory(store: ScheduledJobStore, jobs: ScheduledJobs): JobDirectory {
  return {
    views: () => jobs.views(),
    save(id, input) {
      const checked = sanitizeJobInput(input);
      if ('error' in checked) return checked;
      if (id === undefined) return { id: store.create(checked.value).id };
      const job = store.update(id, checked.value);
      return job ? { id: job.id } : { error: 'That job no longer exists.' };
    },
    setEnabled(id, on) {
      return store.setEnabled(id, on) ? {} : { error: 'That job no longer exists.' };
    },
    remove(id) {
      return store.remove(id) ? {} : { error: 'That job no longer exists.' };
    },
    runNow: (id) => jobs.runNow(id),
    onDidChange: (listener) => store.onDidChange(listener),
  };
}

/**
 * Scheduled jobs (#165), kept in Agent Wrangler's own state.
 *
 * Writes apply one change to freshly-read storage, as `DurableAgentStore`
 * does, so the scheduler recording a run and a pane editing the same job do
 * not clobber each other.
 */

import { randomUUID } from 'node:crypto';
import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';
import { createJob, editJob, parseStoredJobs, recordRun, setJobEnabled, type JobInput, type JobRun, type ScheduledJob } from '../shared/scheduledJobs';

const STORAGE_KEY = 'agentWrangler.scheduledJobs';

export class ScheduledJobStore {
  private jobs: ScheduledJob[];
  private emitter = new Emitter<void>();

  constructor(
    private storage: KeyValueStorage,
    private now: () => number = Date.now,
    private newId: () => string = randomUUID,
  ) {
    this.jobs = this.read();
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  private read(): ScheduledJob[] {
    return parseStoredJobs(this.storage.get<unknown>(STORAGE_KEY, []));
  }

  get list(): readonly ScheduledJob[] {
    return this.jobs;
  }

  get(id: string): ScheduledJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  create(input: JobInput): ScheduledJob {
    const job = createJob(this.newId(), input, this.now());
    this.write((all) => [...all, job]);
    return job;
  }

  update(id: string, input: JobInput): ScheduledJob | undefined {
    return this.change(id, (j) => editJob(j, input, this.now()));
  }

  setEnabled(id: string, on: boolean): ScheduledJob | undefined {
    return this.change(id, (j) => setJobEnabled(j, on, this.now()));
  }

  record(id: string, run: JobRun): ScheduledJob | undefined {
    return this.change(id, (j) => recordRun(j, run));
  }

  /** Fill in a run once its session is known. */
  amendRun(id: string, runId: string, patch: Partial<Pick<JobRun, 'sessionId' | 'outcome' | 'reason'>>): ScheduledJob | undefined {
    return this.change(id, (j) => ({ ...j, history: j.history.map((r) => (r.id === runId ? { ...r, ...patch } : r)) }));
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.write((all) => all.filter((j) => j.id !== id));
    return true;
  }

  private change(id: string, fn: (j: ScheduledJob) => ScheduledJob): ScheduledJob | undefined {
    let out: ScheduledJob | undefined;
    this.write((all) =>
      all.map((j) => {
        if (j.id !== id) return j;
        out = fn(j);
        return out;
      }),
    );
    return out;
  }

  private write(fn: (all: ScheduledJob[]) => ScheduledJob[]): void {
    const before = JSON.stringify(this.jobs);
    const next = fn(this.read());
    this.jobs = next;
    if (JSON.stringify(next) === before) return;
    void this.storage.update(STORAGE_KEY, next);
    this.emitter.fire();
  }
}

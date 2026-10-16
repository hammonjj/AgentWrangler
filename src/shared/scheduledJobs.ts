/**
 * Scheduled jobs (#164, #165): work the core daemon starts at a set time
 * without a click (`docs/plans/scheduled-agents.md`).
 *
 * A job is Agent Wrangler's own record. It names a weekday/time schedule and
 * how to launch the session (provider, model, effort, permission mode,
 * folder, prompt, allowed tools). A run is a normal session started through
 * the same path as "new conversation", so it shows in the table and its
 * permission prompts wait in *Waiting*: nothing here approves anything.
 *
 * Jobs are off by default. A slot that passed while the Mac slept runs once
 * inside the job's catch-up window and is labelled late; outside it the slot
 * is recorded as missed. One slot never runs twice.
 *
 * Times are the Mac's local wall clock. Pure: no Node or DOM imports.
 */

import type { PermissionModeName } from './conversation';
import type { SessionProvider } from './harness';
import { GLOBAL_PROJECT_DIR } from './model';

export type JobKind = 'custom' | 'brief' | 'prSweep';

export interface JobSchedule {
  /** Days it runs, 0 = Sunday … 6 = Saturday, ascending, no repeats. */
  weekdays: number[];
  /** Local time of day, `HH:MM`, 24-hour: the only slot, or the first of a repeating day. */
  time: string;
  /**
   * Repeat through the day (#184): a slot every `minutes` from `time` up to
   * and including `until`. Absent: once a day at `time`.
   */
  every?: { minutes: number; until: string };
}

/** The repeat intervals the form offers, in minutes. */
export const REPEAT_MINUTES = [15, 30, 60, 120, 180, 240, 360] as const;

export type JobOutcome = 'ran' | 'late' | 'skipped' | 'missed' | 'failed';

/** One run, or one slot that did not run. "Wrong means did nothing and said so." */
export interface JobRun {
  id: string;
  /** ms epoch of the scheduled slot. Absent for Run now. */
  slot?: number;
  /** ms epoch the decision was made (the start, for a run). */
  at: number;
  outcome: JobOutcome;
  /** Why it was skipped or failed, in words the user can act on. */
  reason?: string;
  /** Started by Run now rather than the schedule. */
  manual?: boolean;
  provider?: SessionProvider;
  sessionId?: string;
  /** The "ready" notice for this run was shown (`notifyOnDone`). */
  toldDone?: boolean;
}

/**
 * Permission modes a job may run in. Never `bypassPermissions`, and never
 * `auto`: its classifier approves tool calls nobody is watching.
 */
export const JOB_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk'] as const satisfies readonly PermissionModeName[];
export type JobPermissionMode = (typeof JOB_PERMISSION_MODES)[number];

export interface ScheduledJob {
  id: string;
  name: string;
  kind: JobKind;
  /** Off until the user turns it on. */
  enabled: boolean;
  /** ms epoch it was last turned on: slots before it are none of its business. */
  enabledAt?: number;
  schedule: JobSchedule;
  /** How long after its slot a job may still start, late. */
  catchUpHours: number;
  provider: SessionProvider;
  /** Empty means the launcher's current default. */
  model?: string;
  effort?: string;
  /** Claude only. Empty means `default`: anything not allowed waits in Waiting. */
  permissionMode?: JobPermissionMode;
  /** Absolute folder the session works in, or `GLOBAL_PROJECT_DIR` for the Global scratch folder. */
  folder: string;
  /** The first message the session is sent. */
  prompt: string;
  /** Claude permission rules approved without asking (`Bash(gh pr view:*)`). Claude only. */
  allowedTools: string[];
  /** Say so with a notification when a run's session finishes its turn (#167): the daily brief. */
  notifyOnDone?: boolean;
  /** Start a slot even while the previous run is still working. Off: that slot is skipped. */
  allowOverlap?: boolean;
  /**
   * PR sweeps only (#170): post each review as a pending GitHub review the
   * user submits. Leaves the machine under the user's name, so it is a
   * per-job opt-in. Never an approval or a change request.
   */
  postPendingReview?: boolean;
  /**
   * Skip a run while any usage window is at or above this percent. Empty
   * means the auto-pause percent.
   */
  maxWindowPercent?: number;
  createdAt: number;
  updatedAt: number;
  /** Newest first, at most `MAX_JOB_HISTORY`. */
  history: JobRun[];
}

/** What the form may set. */
export interface JobInput {
  name: string;
  kind?: JobKind;
  schedule: JobSchedule;
  catchUpHours?: number;
  provider: SessionProvider;
  model?: string;
  effort?: string;
  permissionMode?: JobPermissionMode;
  folder: string;
  prompt: string;
  allowedTools?: string[];
  notifyOnDone?: boolean;
  allowOverlap?: boolean;
  postPendingReview?: boolean;
  maxWindowPercent?: number;
}

export const MAX_JOB_HISTORY = 100;
export const DEFAULT_CATCH_UP_HOURS = 4;
export const MAX_CATCH_UP_HOURS = 23;
export const MAX_JOB_PROMPT = 20_000;
export const MAX_ALLOWED_TOOLS = 100;
/** A slot this close behind the clock is on time, not late (the evaluator ticks once a minute). */
export const ON_TIME_MS = 5 * 60_000;

const HOUR = 3_600_000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- Input -----------------------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v.trim() : undefined);
const isProvider = (v: unknown): v is SessionProvider => v === 'claude' || v === 'codex';
const isKind = (v: unknown): v is JobKind => v === 'custom' || v === 'brief' || v === 'prSweep';
const isMode = (v: unknown): v is JobPermissionMode => (JOB_PERMISSION_MODES as readonly unknown[]).includes(v);

export function parseTime(v: unknown): { h: number; m: number } | undefined {
  const m = typeof v === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : undefined;
}

function cleanSchedule(v: unknown): JobSchedule | { error: string } {
  const o = (v ?? {}) as Record<string, unknown>;
  const t = parseTime(o.time);
  if (!t) return { error: 'Give the time as HH:MM, 24-hour.' };
  const days = Array.isArray(o.weekdays) ? o.weekdays : [];
  const weekdays = [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (weekdays.length === 0) return { error: 'Pick at least one day.' };
  const out: JobSchedule = { weekdays, time: hhmm(t) };
  const every = o.every as Record<string, unknown> | undefined;
  if (every && every.minutes !== undefined && every.minutes !== '' && every.minutes !== 0) {
    const minutes = Number(every.minutes);
    if (!(REPEAT_MINUTES as readonly number[]).includes(minutes)) return { error: 'Pick a repeat interval from the list.' };
    const until = parseTime(every.until);
    if (!until) return { error: 'Give the repeat end as HH:MM, 24-hour.' };
    if (until.h * 60 + until.m <= t.h * 60 + t.m) return { error: 'The repeat must end after it starts, on the same day.' };
    out.every = { minutes, until: hhmm(until) };
  }
  return out;
}

const hhmm = (t: { h: number; m: number }) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;

/** Minutes after midnight of each slot in a day, in order. */
export function dailySlotMinutes(s: JobSchedule): number[] {
  const t = parseTime(s.time);
  if (!t) return [];
  const start = t.h * 60 + t.m;
  const until = s.every ? parseTime(s.every.until) : undefined;
  if (!s.every || !until || s.every.minutes <= 0) return [start];
  const end = until.h * 60 + until.m;
  const out: number[] = [];
  for (let m = start; m <= end; m += s.every.minutes) out.push(m);
  return out;
}

/**
 * Check what the form (or a template) sent. Shape and sense only: whether
 * the folder exists is the daemon's question, asked at run time.
 */
export function sanitizeJobInput(v: unknown): { value: JobInput } | { error: string } {
  const o = (v ?? {}) as Record<string, unknown>;
  const name = str(o.name);
  if (!name) return { error: 'Give the job a name.' };
  if (name.length > 80) return { error: 'Keep the name under 80 characters.' };
  const schedule = cleanSchedule(o.schedule);
  if ('error' in schedule) return schedule;
  if (!isProvider(o.provider)) return { error: 'Choose Claude or Codex.' };
  const folder = str(o.folder)?.replace(/(.)\/+$/, '$1');
  if (!folder || !(folder.startsWith('/') || folder === GLOBAL_PROJECT_DIR)) return { error: 'Choose the folder the job works in.' };
  const prompt = str(o.prompt);
  if (!prompt) return { error: 'Write what the job should do.' };
  if (prompt.length > MAX_JOB_PROMPT) return { error: `Keep the prompt under ${MAX_JOB_PROMPT} characters.` };
  // `auto` was briefly the default; stored jobs that carry it fall back to `default`.
  if (o.permissionMode !== undefined && o.permissionMode !== '' && o.permissionMode !== 'auto' && !isMode(o.permissionMode)) {
    return { error: 'That permission mode is not allowed for a job.' };
  }
  let catchUpHours = DEFAULT_CATCH_UP_HOURS;
  if (o.catchUpHours !== undefined && o.catchUpHours !== '') {
    const n = Number(o.catchUpHours);
    if (!Number.isFinite(n) || n < 0 || n > MAX_CATCH_UP_HOURS) return { error: `Catch-up is 0 to ${MAX_CATCH_UP_HOURS} hours.` };
    catchUpHours = n;
  }
  let maxWindowPercent: number | undefined;
  if (o.maxWindowPercent !== undefined && o.maxWindowPercent !== '' && o.maxWindowPercent !== null) {
    const n = Number(o.maxWindowPercent);
    if (!Number.isFinite(n) || n < 1 || n > 100) return { error: 'The usage limit is a percent from 1 to 100.' };
    maxWindowPercent = Math.round(n);
  }
  const rawTools = Array.isArray(o.allowedTools) ? o.allowedTools : typeof o.allowedTools === 'string' ? o.allowedTools.split('\n') : [];
  const allowedTools = [...new Set(rawTools.map(str).filter((t): t is string => !!t))];
  if (allowedTools.length > MAX_ALLOWED_TOOLS) return { error: `At most ${MAX_ALLOWED_TOOLS} allowed tools.` };
  if (allowedTools.some((t) => t.length > 300)) return { error: 'An allowed-tool rule is too long.' };
  const model = str(o.model);
  const effort = str(o.effort);
  return {
    value: {
      name,
      kind: isKind(o.kind) ? o.kind : 'custom',
      schedule,
      catchUpHours,
      provider: o.provider,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(o.provider === 'claude' && isMode(o.permissionMode) ? { permissionMode: o.permissionMode } : {}),
      folder,
      prompt,
      allowedTools: o.provider === 'claude' ? allowedTools : [],
      ...(o.notifyOnDone === true ? { notifyOnDone: true } : {}),
      ...(o.allowOverlap === true ? { allowOverlap: true } : {}),
      ...(o.postPendingReview === true && o.kind === 'prSweep' && o.provider === 'claude' ? { postPendingReview: true } : {}),
      ...(maxWindowPercent !== undefined ? { maxWindowPercent } : {}),
    },
  };
}

export function createJob(id: string, input: JobInput, now: number): ScheduledJob {
  return { ...fromInput(input), id, enabled: false, createdAt: now, updatedAt: now, history: [] };
}

export function editJob(job: ScheduledJob, input: JobInput, now: number): ScheduledJob {
  const next: ScheduledJob = { ...fromInput(input), id: job.id, enabled: job.enabled, createdAt: job.createdAt, updatedAt: now, history: job.history };
  if (job.enabledAt !== undefined) next.enabledAt = job.enabledAt;
  return next;
}

function fromInput(i: JobInput): Omit<ScheduledJob, 'id' | 'enabled' | 'createdAt' | 'updatedAt' | 'history'> {
  return {
    name: i.name,
    kind: i.kind ?? 'custom',
    schedule: { weekdays: [...i.schedule.weekdays], time: i.schedule.time, ...(i.schedule.every ? { every: { ...i.schedule.every } } : {}) },
    catchUpHours: i.catchUpHours ?? DEFAULT_CATCH_UP_HOURS,
    provider: i.provider,
    ...(i.model ? { model: i.model } : {}),
    ...(i.effort ? { effort: i.effort } : {}),
    ...(i.permissionMode ? { permissionMode: i.permissionMode } : {}),
    folder: i.folder,
    prompt: i.prompt,
    allowedTools: [...(i.allowedTools ?? [])],
    ...(i.notifyOnDone ? { notifyOnDone: true } : {}),
    ...(i.allowOverlap ? { allowOverlap: true } : {}),
    ...(i.postPendingReview ? { postPendingReview: true } : {}),
    ...(i.maxWindowPercent !== undefined ? { maxWindowPercent: i.maxWindowPercent } : {}),
  };
}

export function setJobEnabled(job: ScheduledJob, on: boolean, now: number): ScheduledJob {
  if (job.enabled === on) return job;
  return on ? { ...job, enabled: true, enabledAt: now, updatedAt: now } : { ...job, enabled: false, updatedAt: now };
}

/**
 * Add a run to the history, newest first. A slot already skipped is
 * replaced rather than added again, so a job retried every minute while the
 * fleet is paused leaves one line, not hundreds.
 */
export function recordRun(job: ScheduledJob, run: JobRun): ScheduledJob {
  const rest = job.history.filter((r) => !(run.slot !== undefined && r.slot === run.slot && r.outcome === 'skipped'));
  return { ...job, history: [run, ...rest].slice(0, MAX_JOB_HISTORY) };
}

/** Read back what was stored, dropping anything malformed rather than failing the lot. */
export function parseStoredJobs(v: unknown): ScheduledJob[] {
  if (!Array.isArray(v)) return [];
  const out: ScheduledJob[] = [];
  for (const raw of v) {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    const checked = sanitizeJobInput(o);
    if ('error' in checked) continue;
    const job = createJob(o.id, checked.value, typeof o.createdAt === 'number' ? o.createdAt : 0);
    job.updatedAt = typeof o.updatedAt === 'number' ? o.updatedAt : job.createdAt;
    job.enabled = o.enabled === true;
    if (typeof o.enabledAt === 'number') job.enabledAt = o.enabledAt;
    job.history = (Array.isArray(o.history) ? o.history : []).map(parseRun).filter((r): r is JobRun => r !== undefined).slice(0, MAX_JOB_HISTORY);
    out.push(job);
  }
  return out;
}

const OUTCOMES: readonly JobOutcome[] = ['ran', 'late', 'skipped', 'missed', 'failed'];

function parseRun(v: unknown): JobRun | undefined {
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.at !== 'number' || !OUTCOMES.includes(o.outcome as JobOutcome)) return undefined;
  return {
    id: o.id,
    at: o.at,
    outcome: o.outcome as JobOutcome,
    ...(typeof o.slot === 'number' ? { slot: o.slot } : {}),
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    ...(o.manual === true ? { manual: true } : {}),
    ...(isProvider(o.provider) ? { provider: o.provider } : {}),
    ...(typeof o.sessionId === 'string' ? { sessionId: o.sessionId } : {}),
    ...(o.toldDone === true ? { toldDone: true } : {}),
  };
}

// ---- Schedule --------------------------------------------------------------

/** The latest slot at or before `now`, in local time, looking back at most a week. */
export function latestSlot(schedule: JobSchedule, now: number): number | undefined {
  const minutes = dailySlotMinutes(schedule);
  if (minutes.length === 0 || schedule.weekdays.length === 0) return undefined;
  const d = new Date(now);
  for (let back = 0; back <= 7; back++) {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    if (!schedule.weekdays.includes(date.getDay())) continue;
    // Built from the wall clock each time, so a DST change moves no slot.
    for (let i = minutes.length - 1; i >= 0; i--) {
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes[i]!).getTime();
      if (at <= now) return at;
    }
  }
  return undefined;
}

/** The first slot after `now`, for "next run" in the view. */
export function nextSlot(schedule: JobSchedule, now: number): number | undefined {
  const minutes = dailySlotMinutes(schedule);
  if (minutes.length === 0 || schedule.weekdays.length === 0) return undefined;
  const d = new Date(now);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ahead);
    if (!schedule.weekdays.includes(date.getDay())) continue;
    for (const m of minutes) {
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, m).getTime();
      if (at > now) return at;
    }
  }
  return undefined;
}

export type SlotDecision =
  | { kind: 'none' }
  /** Start now. `late` when the slot passed more than `ON_TIME_MS` ago. */
  | { kind: 'run'; slot: number; late: boolean }
  /** The slot passed outside the catch-up window: record it, do not run. */
  | { kind: 'missed'; slot: number };

/**
 * What a job should do at `now`. Only the latest slot is considered: after a
 * long sleep the job runs (or misses) once, never once per lost day. A slot
 * with any record other than a skip is done; a skipped slot is retried while
 * its window is open.
 */
export function decideSlot(job: ScheduledJob, now: number): SlotDecision {
  if (!job.enabled) return { kind: 'none' };
  const slot = latestSlot(job.schedule, now);
  if (slot === undefined) return { kind: 'none' };
  if (job.enabledAt !== undefined && slot < job.enabledAt) return { kind: 'none' };
  const prior = job.history.find((r) => r.slot === slot);
  const age = now - slot;
  const open = age <= job.catchUpHours * HOUR || age <= ON_TIME_MS;
  if (prior && prior.outcome !== 'skipped') return { kind: 'none' };
  if (!open) return prior ? { kind: 'none' } : { kind: 'missed', slot };
  return { kind: 'run', slot, late: age > ON_TIME_MS };
}

// ---- Admission --------------------------------------------------------------

export interface AdmissionState {
  /** Every live agent frozen (Pause all, auto-pause). */
  fleetPaused: boolean;
  /** Highest usage-window percent for the job's provider, when known. */
  windowPercent?: number;
  /** The provider is rate-limited until then (ms epoch). */
  backoffUntil?: number;
  /** The auto-pause percent, the default threshold. */
  autoPausePercent: number;
}

/** Why the job may not start now, or undefined when it may (#45's rules). */
export function admissionRefusal(job: Pick<ScheduledJob, 'maxWindowPercent'>, s: AdmissionState, now: number): string | undefined {
  if (s.fleetPaused) return 'the fleet is paused';
  if (s.backoffUntil !== undefined && s.backoffUntil > now) return 'the provider is rate-limited';
  const limit = job.maxWindowPercent ?? s.autoPausePercent;
  if (s.windowPercent !== undefined && s.windowPercent >= limit) return `usage is at ${Math.round(s.windowPercent)}% (limit ${limit}%)`;
  return undefined;
}

// ---- Origin and view --------------------------------------------------------

export interface JobOrigin {
  kind: 'job';
  jobId: string;
  runId: string;
}

export const jobOrigin = (jobId: string, runId: string): JobOrigin => ({ kind: 'job', jobId, runId });

export function jobIdOfOrigin(origin: unknown): string | undefined {
  const o = origin as Partial<JobOrigin> | undefined;
  return o && o.kind === 'job' && typeof o.jobId === 'string' ? o.jobId : undefined;
}

export function describeSchedule(s: JobSchedule): string {
  const days = s.weekdays;
  const key = days.join(',');
  const which = key === '1,2,3,4,5' ? 'Weekdays' : key === '0,1,2,3,4,5,6' ? 'Every day' : key === '0,6' ? 'Weekends' : days.map((d) => DAY_NAMES[d]).join(' ');
  if (!s.every) return `${which} at ${s.time}`;
  const m = s.every.minutes;
  const step = m % 60 === 0 ? (m === 60 ? 'every hour' : `every ${m / 60} hours`) : `every ${m} min`;
  return `${which}, ${step}, ${s.time}–${s.every.until}`;
}

/** What the table pane shows for a job. Everything the edit form needs, plus derived times. */
export interface JobView extends ScheduledJob {
  scheduleText: string;
  /** ms epoch of the next slot while enabled. */
  nextRunAt?: number;
  /** A run of this job is starting now. */
  starting: boolean;
  /** The session of the newest run that started one: the latest brief, say. */
  latestSessionKey?: string;
}

/** A run's session as the table keys it. */
export function runSessionKey(r: Pick<JobRun, 'provider' | 'sessionId'>): string | undefined {
  return r.provider && r.sessionId ? `${r.provider}:${r.sessionId.toLowerCase()}` : undefined;
}

export function jobView(job: ScheduledJob, now: number, starting: boolean): JobView {
  const next = job.enabled ? nextSlot(job.schedule, now) : undefined;
  const latest = job.history.map(runSessionKey).find((k) => k !== undefined);
  return {
    ...job,
    scheduleText: describeSchedule(job.schedule),
    ...(next !== undefined ? { nextRunAt: next } : {}),
    starting,
    ...(latest ? { latestSessionKey: latest } : {}),
  };
}

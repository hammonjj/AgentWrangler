/**
 * The Jobs view (#166): scheduled jobs in the table pane. List them, turn
 * them on and off, edit the schedule, prompt and allowed tools, run one now,
 * and read each job's run history; a run that started a session opens it in
 * the conversation pane.
 *
 * It shares the Agents view's look (`:is(.agents, .jobs)` in the stylesheet)
 * and its rules: it may be 300 px wide, so everything wraps and the form
 * stacks off `#app.narrow`, never a media query. No inline styles. Every
 * check that matters is made again by the host (`shared/scheduledJobs.ts`).
 */
import { DEFAULT_CATCH_UP_HOURS, JOB_PERMISSION_MODES, REPEAT_MINUTES, runSessionKey, type JobInput, type JobOutcome, type JobRun, type JobView } from '../../shared/scheduledJobs';
import { AGENT_EFFORTS } from '../../shared/durableAgents';
import { JOB_TEMPLATES, jobTemplate, type JobTemplateId } from '../../shared/jobTemplates';
import { capitalize, formatAge, GLOBAL_PROJECT_DIR, type ProjectDTO } from '../../shared/model';
import type { DashboardToHost, HostToDashboard } from '../../shared/messages';
import type { ModelChoice } from '../../shared/conversation';
import { modelOptionsHtml } from './modelSelect';
import { isDue, MAX_REVIEWS_PER_SWEEP, type ReviewNeed, type SweepItem } from '../../shared/prSweep';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday first, the way a working week reads. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** The form's fields as typed, kept across repaints. */
export interface JobFormDraft {
  id?: string;
  name: string;
  kind: JobInput['kind'];
  weekdays: number[];
  time: string;
  /** Minutes between runs, or empty for once a day (#184). */
  repeat: string;
  until: string;
  catchUpHours: string;
  provider: 'claude' | 'codex';
  model: string;
  effort: string;
  permissionMode: string;
  folder: string;
  prompt: string;
  allowedTools: string;
  notifyOnDone: boolean;
  allowOverlap: boolean;
  postPendingReview: boolean;
  maxWindowPercent: string;
}

export interface JobsUiState {
  form?: JobFormDraft;
  pendingSave?: string;
  error?: string;
  /** The job whose history is open. */
  open?: string;
  /** The job whose history was opened by the click being rendered: it slides down once. */
  slide?: string;
  /** A Run now or on/off the view is waiting on, by job. */
  pending: Map<string, string>;
  /** The last refusal for a job's Run now or switch, shown on its card. */
  notes: Map<string, string>;
  /** The PR sweep whose preview is open, and each sweep's last preview. */
  previewOpen?: string;
  previews: Map<string, JobPreviewState>;
}

export interface JobPreviewState {
  /** The preview being waited on. */
  requestId?: string;
  repo?: string;
  items?: SweepItem[];
  error?: string;
}

export function newJobsUiState(): JobsUiState {
  return { pending: new Map(), notes: new Map(), previews: new Map() };
}

/** A new job's form, filled in from a template (`shared/jobTemplates.ts`). */
export function blankJobForm(folder?: string, template: JobTemplateId = 'custom'): JobFormDraft {
  const t = jobTemplate(template) ?? JOB_TEMPLATES[0]!;
  return formOf(t.input(folder && folder !== GLOBAL_PROJECT_DIR ? folder : undefined));
}

export function jobFormFor(j: JobView): JobFormDraft {
  return { ...formOf(j), id: j.id };
}

function formOf(j: JobInput): JobFormDraft {
  return {
    name: j.name,
    kind: j.kind ?? 'custom',
    weekdays: [...j.schedule.weekdays],
    time: j.schedule.time,
    repeat: j.schedule.every ? String(j.schedule.every.minutes) : '',
    until: j.schedule.every?.until ?? '20:00',
    catchUpHours: String(j.catchUpHours ?? DEFAULT_CATCH_UP_HOURS),
    provider: j.provider,
    model: j.model ?? '',
    effort: j.effort ?? '',
    permissionMode: j.permissionMode ?? '',
    folder: j.folder,
    prompt: j.prompt,
    allowedTools: (j.allowedTools ?? []).join('\n'),
    notifyOnDone: j.notifyOnDone === true,
    allowOverlap: j.allowOverlap === true,
    postPendingReview: j.postPendingReview === true,
    maxWindowPercent: j.maxWindowPercent !== undefined ? String(j.maxWindowPercent) : '',
  };
}

/** What goes to the host, which checks it again. */
export function jobFormInput(f: JobFormDraft): JobInput {
  return {
    name: f.name,
    ...(f.kind ? { kind: f.kind } : {}),
    schedule: { weekdays: [...f.weekdays], time: f.time, ...(f.repeat ? { every: { minutes: Number(f.repeat), until: f.until } } : {}) },
    catchUpHours: Number(f.catchUpHours === '' ? DEFAULT_CATCH_UP_HOURS : f.catchUpHours),
    provider: f.provider,
    ...(f.model.trim() ? { model: f.model.trim() } : {}),
    ...(f.effort ? { effort: f.effort } : {}),
    ...(f.permissionMode ? { permissionMode: f.permissionMode as JobInput['permissionMode'] } : {}),
    folder: f.folder,
    prompt: f.prompt,
    allowedTools: f.allowedTools.split('\n').map((t) => t.trim()).filter(Boolean),
    ...(f.notifyOnDone ? { notifyOnDone: true } : {}),
    ...(f.allowOverlap ? { allowOverlap: true } : {}),
    ...(f.postPendingReview && f.kind === 'prSweep' ? { postPendingReview: true } : {}),
    ...(f.maxWindowPercent.trim() ? { maxWindowPercent: Number(f.maxWindowPercent) } : {}),
  };
}

const OUTCOME_TEXT: Record<JobOutcome, string> = { ran: 'Ran', late: 'Ran late', skipped: 'Skipped', missed: 'Missed', failed: 'Failed' };
const OUTCOME_CLASS: Record<JobOutcome, string> = { ran: 'st-done', late: 'st-waiting', skipped: 'st-waiting', missed: 'st-stuck', failed: 'st-stuck' };

function when(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function runHtml(r: JobRun, nowMs: number): string {
  const key = runSessionKey(r);
  const what = r.manual ? 'Run now' : r.slot !== undefined ? `Slot ${when(r.slot)}` : '';
  const open = key ? ` class="jb-run open" data-jb="session" data-key="${esc(key)}" title="Open this run's conversation"` : ' class="jb-run"';
  return `<tr${open}><td><span class="ag-chip ag-st ${OUTCOME_CLASS[r.outcome]}">${esc(OUTCOME_TEXT[r.outcome])}</span></td><td>${esc(what)}</td><td><span class="ag-age" title="${esc(when(r.at))}">${esc(formatAge(nowMs, r.at))} ago</span></td><td class="jb-reason">${esc(r.reason ?? '')}</td></tr>`;
}

function itemHtml(j: JobView, ui: JobsUiState, nowMs: number): string {
  const id = esc(j.id);
  const last = j.history[0];
  const busy = ui.pending.has(j.id) || j.starting;
  const meta = [
    `<span class="ag-chip${j.enabled ? ' jb-on' : ''}">${j.enabled ? 'On' : 'Off'}</span>`,
    `<span class="ag-chip">${esc(j.scheduleText)}</span>`,
    j.folder === GLOBAL_PROJECT_DIR
      ? '<span class="ag-chip" title="Not tied to a project">Global</span>'
      : `<span class="ag-chip" title="${esc(j.folder)}">${esc(j.folder.split('/').filter(Boolean).pop() ?? j.folder)}</span>`,
    j.postPendingReview ? '<span class="ag-chip jb-posts" title="Posts each review to GitHub as a pending review under your name">Posts pending reviews</span>' : '',
    `<span class="ag-chip">${esc(j.provider === 'codex' ? 'Codex' : 'Claude')}${j.model ? ` · ${esc(j.model)}` : ''}${j.effort ? ` · ${esc(j.effort)}` : ''}</span>`,
    j.enabled && j.nextRunAt ? `<span class="ag-age">Next ${esc(when(j.nextRunAt))}</span>` : '',
    j.starting ? '<span class="ag-chip ag-st st-busy">Starting</span>' : '',
    last ? `<span class="ag-chip ag-st ${OUTCOME_CLASS[last.outcome]}" title="${esc(last.reason ?? '')}">Last: ${esc(OUTCOME_TEXT[last.outcome])} ${esc(formatAge(nowMs, last.at))} ago</span>` : '',
  ].join('');
  const open = ui.open === j.id;
  const note = ui.notes.get(j.id);
  return `<li class="ag-item${j.enabled ? '' : ' archived'}" data-job="${id}">
<div class="ag-open jb-head"><span class="ag-name">${esc(j.name)}</span><span class="ag-role">${esc(firstLine(j.prompt))}</span><span class="ag-meta">${meta}</span></div>
<span class="ag-actions">
<button type="button" class="ag-btn${j.enabled ? '' : ' primary'}" data-jb="toggle" data-id="${id}"${busy ? ' disabled' : ''} title="${j.enabled ? 'Stop running it on its schedule' : 'Run it on its schedule from now on'}">${j.enabled ? 'Turn off' : 'Turn on'}</button>
<button type="button" class="ag-btn" data-jb="run" data-id="${id}"${busy ? ' disabled' : ''} title="Start a run now, on or off. Still waits while the fleet is paused or usage is at its limit.">Run now</button>
<button type="button" class="ag-btn ag-tab${open ? ' on' : ''}" data-jb="history" data-id="${id}" aria-expanded="${open}">History ${j.history.length}</button>
${j.kind === 'prSweep' ? `<button type="button" class="ag-btn ag-tab${ui.previewOpen === j.id ? ' on' : ''}" data-jb="preview" data-id="${id}" aria-expanded="${ui.previewOpen === j.id}" title="Ask GitHub what a sweep would review now. Reviews nothing.">Preview</button>` : ''}
${j.latestSessionKey ? `<button type="button" class="ag-btn" data-jb="session" data-key="${esc(j.latestSessionKey)}" title="Open the latest run's conversation">Open latest</button>` : ''}
<button type="button" class="ag-btn" data-jb="edit" data-id="${id}">Edit</button>
<button type="button" class="ag-btn danger" data-jb="delete" data-id="${id}" title="Forget this job and its history. Sessions it started stay.">Delete</button>
</span>${note ? `<p class="ag-error jb-note" role="alert">${esc(note)}</p>` : ''}${open ? historyHtml(j, ui, nowMs) : ''}${ui.previewOpen === j.id ? previewHtml(ui.previews.get(j.id)) : ''}</li>`;
}

const NEED_TEXT: Record<ReviewNeed, string> = {
  new: 'Will review',
  updated: 'Will re-review: new commits',
  rerequested: 'Will re-review: asked again',
  inProgress: 'Review running',
  reviewed: 'Reviewed at this head',
  draft: 'Draft: skipped',
};

function previewHtml(p: JobPreviewState | undefined): string {
  if (!p || p.requestId) return '<div class="ag-panel"><p class="ag-note">Asking GitHub…</p></div>';
  if (p.error) return `<div class="ag-panel"><p class="ag-error" role="alert">${esc(p.error)}</p></div>`;
  const items = p.items ?? [];
  const rows = items
    .map((i) => {
      const cls = isDue(i.need) ? 'st-busy' : i.need === 'inProgress' ? 'st-waiting' : 'st-done';
      return `<li class="ag-hist"><span class="ag-histtext"><span class="ag-chip ag-st ${cls}">${esc(NEED_TEXT[i.need])}</span> <b>#${i.number}</b> ${esc(i.title)} <span class="ag-age">${esc(i.author)}${i.via === 'team' ? ' · team request' : ''}</span>${i.postError ? ` <span class="jb-reason">Not posted: ${esc(i.postError)}</span>` : ''}${i.reviewId !== undefined ? ' <span class="ag-age">pending review posted</span>' : ''}</span>
<span class="ag-memacts">${i.sessionKey ? `<button type="button" class="ag-btn" data-jb="session" data-key="${esc(i.sessionKey)}">Open review</button>` : ''}${i.url ? `<button type="button" class="ag-btn" data-jb="link" data-url="${esc(i.url)}">GitHub</button>` : ''}</span></li>`;
    })
    .join('');
  const due = items.filter((i) => isDue(i.need)).length;
  return `<div class="ag-panel"><p class="ag-note">${esc(p.repo ?? '')}: ${items.length} waiting on you, ${due} due. A run reviews at most ${MAX_REVIEWS_PER_SWEEP}.</p>${rows ? `<ul class="ag-histlist">${rows}</ul>` : ''}</div>`;
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim()) ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function historyHtml(j: JobView, ui: JobsUiState, nowMs: number): string {
  return `<div class="ag-panel jb-history${ui.slide === j.id ? ' slide' : ''}" data-panel="history">${
    j.history.length
      ? `<table class="jb-runs"><thead><tr><th>Outcome</th><th>Trigger</th><th>When</th><th>Note</th></tr></thead><tbody>${j.history.map((r) => runHtml(r, nowMs)).join('')}</tbody></table>`
      : '<p class="ag-note">No runs yet.</p>'
  }</div>`;
}

function formHtml(f: JobFormDraft, ui: JobsUiState, projects: readonly ProjectDTO[], models: readonly ModelChoice[]): string {
  const opt = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const folders = projects.filter((p) => p.dir !== GLOBAL_PROJECT_DIR);
  if (f.folder && f.folder !== GLOBAL_PROJECT_DIR && !folders.some((p) => p.dir === f.folder)) folders.unshift({ dir: f.folder, name: f.folder.split('/').filter(Boolean).pop() ?? f.folder });
  const folderOpts = [opt('', 'Choose a folder…', !f.folder), opt(GLOBAL_PROJECT_DIR, 'Global (no project)', f.folder === GLOBAL_PROJECT_DIR), ...folders.map((p) => opt(p.dir, `${p.name} — ${p.dir}`, p.dir === f.folder))].join('');
  const efforts = AGENT_EFFORTS.map((e) => opt(e, e ? capitalize(e) : 'Default', f.effort === e)).join('');
  const modes = [opt('', 'Ask for anything not allowed (default)', !f.permissionMode), ...JOB_PERMISSION_MODES.filter((m) => m !== 'default').map((m) => opt(m, MODE_TEXT[m] ?? m, f.permissionMode === m))].join('');
  const days = DAY_ORDER.map(
    (d) => `<label class="jb-day"><input type="checkbox" data-day="${d}"${f.weekdays.includes(d) ? ' checked' : ''}><span>${DAYS[d]}</span></label>`,
  ).join('');
  const claude = f.provider === 'claude';
  const busy = ui.pendingSave !== undefined;
  return `<form class="ag-form" data-job-form novalidate>
<h3 class="ag-formtitle">${f.id ? 'Edit job' : 'New job'}</h3>
<label class="ag-field"><span>Name</span><input data-f="name" maxlength="80" required value="${esc(f.name)}" placeholder="Morning PR sweep"></label>
<fieldset class="ag-field jb-days"><legend>Days</legend>${days}</fieldset>
<span class="ag-row">
<label class="ag-field"><span>${f.repeat ? 'From' : 'Time'}</span><input type="time" data-f="time" required value="${esc(f.time)}"></label>
<label class="ag-field"><span>Repeat</span><select data-f="repeat">${repeatOptions(f.repeat)}</select></label>
${f.repeat ? `<label class="ag-field"><span>Until</span><input type="time" data-f="until" required value="${esc(f.until)}"></label>` : ''}
</span>
<span class="ag-row">
<label class="ag-field"><span>Catch-up hours</span><input type="number" min="0" max="23" step="1" data-f="catchUpHours" value="${esc(f.catchUpHours)}"></label>
<label class="ag-field"><span>Usage limit %</span><input type="number" min="1" max="100" step="1" data-f="maxWindowPercent" value="${esc(f.maxWindowPercent)}" placeholder="Auto-pause %"></label>
</span>
<label class="ag-field"><span>Folder</span><select data-f="folder">${folderOpts}</select></label>
<span class="ag-row">
<label class="ag-field"><span>Harness</span><select data-f="provider">${opt('claude', 'Claude', claude)}${opt('codex', 'Codex', !claude)}</select></label>
<label class="ag-field"><span>Model</span><select data-f="model">${modelOptionsHtml(models, f.provider, f.model)}</select></label>
<label class="ag-field"><span>Effort</span><select data-f="effort">${efforts}</select></label>
</span>
${claude ? `<label class="ag-field"><span>Permission mode</span><select data-f="permissionMode">${modes}</select></label>` : ''}
${
  f.kind === 'prSweep'
    ? `<p class="ag-note">Reviews open pull requests in this folder's GitHub repository that wait on your review (by name or through a team; drafts skipped), each in its own worktree beside the folder. A PR is reviewed again when it gets new commits or your review is asked for again.</p>
${claude ? `<label class="jb-check"><input type="checkbox" data-f="postPendingReview"${f.postPendingReview ? ' checked' : ''}><span>Post each review to GitHub as a pending review that I submit</span></label>
<p class="ag-note jb-warn">This leaves this Mac: the review is posted under your GitHub name, as a pending review only you can see until you submit it. It never approves or requests changes. Off: reviews stay in Agent Wrangler.</p>` : ''}`
    : ''
}
<label class="jb-check"><input type="checkbox" data-f="notifyOnDone"${f.notifyOnDone ? ' checked' : ''}><span>Notify me when a run has finished, with a link to it</span></label>
<label class="jb-check"><input type="checkbox" data-f="allowOverlap"${f.allowOverlap ? ' checked' : ''}><span>Allow jobs to overlap</span></label>
<label class="ag-field"><span>Prompt</span><textarea data-f="prompt" rows="6" maxlength="20000" placeholder="What the job should do each time it runs.">${esc(f.prompt)}</textarea></label>
${
  claude
    ? `<label class="ag-field"><span>Allowed tools, one rule per line</span><textarea data-f="allowedTools" rows="4" placeholder="Read&#10;Bash(gh pr view:*)">${esc(f.allowedTools)}</textarea></label>
<p class="ag-note">${
        f.permissionMode === 'dontAsk'
          ? 'These run without asking. Anything else the job tries is refused, so it never waits on a prompt nobody sees.'
          : 'These run without asking. Anything else the job tries waits in Waiting for you; nothing is approved on your behalf.'
      }</p>`
    : '<p class="ag-note">Codex jobs ask for anything outside their sandbox; the request waits in Waiting for you.</p>'
}
<p class="ag-note">A slot missed while the Mac was asleep runs once when it wakes, inside the catch-up window, and is marked late. Nothing starts while the fleet is paused or usage is at the limit; the run is recorded as skipped.</p>
${ui.error ? `<p class="ag-error" role="alert">${esc(ui.error)}</p>` : ''}
<span class="ag-formactions"><button type="submit" class="ag-btn primary"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button><button type="button" class="ag-btn" data-jb="cancel">Cancel</button></span>
</form>`;
}

function repeatOptions(selected: string): string {
  const label = (m: number) => (m % 60 === 0 ? (m === 60 ? 'Every hour' : `Every ${m / 60} hours`) : `Every ${m} minutes`);
  return [`<option value=""${selected ? '' : ' selected'}>Once a day</option>`, ...REPEAT_MINUTES.map((m) => `<option value="${m}"${selected === String(m) ? ' selected' : ''}>${label(m)}</option>`)].join('');
}

const MODE_TEXT: Record<string, string> = { default: 'Ask for everything', acceptEdits: 'Accept edits', plan: 'Plan only', dontAsk: 'Deny what is not allowed' };

export function jobsHtml(jobs: readonly JobView[] | undefined, ui: JobsUiState, projects: readonly ProjectDTO[], nowMs: number, models: readonly ModelChoice[] = []): string {
  const all = jobs ?? [];
  const adding = ui.form !== undefined && !ui.form.id;
  const templates = `<button type="button" class="ag-btn primary" data-jb="new" data-template="custom"${adding ? ' disabled' : ''}>+ New job</button>`;
  const bar = `<div class="ag-bar"><span class="ag-hint">Work that starts at a set time. New jobs are off until you turn them on.</span>${templates}</div>`;
  const form = ui.form ? formHtml(ui.form, ui, projects, models) : '';
  const body =
    all.length === 0
      ? ui.form
        ? ''
        : '<div class="ag-empty">No jobs yet.<span class="hint">A job starts a normal conversation on a schedule — a morning review sweep, a daily brief. It shows in Sessions like any other, and its permission prompts wait for you.</span></div>'
      : `<ul class="ag-list">${all.map((j) => itemHtml(j, ui, nowMs)).join('')}</ul>`;
  return `<div class="jobs">${bar}${form}${body}</div>`;
}

/** Read the form back into the draft. */
export function readJobForm(form: HTMLElement, draft: JobFormDraft): JobFormDraft {
  const value = (f: string) => form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-f="${f}"]`)?.value;
  const weekdays = [...form.querySelectorAll<HTMLInputElement>('input[data-day]')].filter((c) => c.checked).map((c) => Number(c.dataset.day));
  return {
    ...draft,
    name: value('name') ?? draft.name,
    weekdays,
    time: value('time') ?? draft.time,
    repeat: value('repeat') ?? draft.repeat,
    until: value('until') ?? draft.until,
    catchUpHours: value('catchUpHours') ?? draft.catchUpHours,
    maxWindowPercent: value('maxWindowPercent') ?? draft.maxWindowPercent,
    folder: value('folder') ?? draft.folder,
    provider: (value('provider') ?? draft.provider) === 'codex' ? 'codex' : 'claude',
    model: value('model') ?? draft.model,
    effort: value('effort') ?? draft.effort,
    permissionMode: value('permissionMode') ?? draft.permissionMode,
    prompt: value('prompt') ?? draft.prompt,
    allowedTools: value('allowedTools') ?? draft.allowedTools,
    notifyOnDone: form.querySelector<HTMLInputElement>('[data-f="notifyOnDone"]')?.checked ?? draft.notifyOnDone,
    allowOverlap: form.querySelector<HTMLInputElement>('[data-f="allowOverlap"]')?.checked ?? draft.allowOverlap,
    postPendingReview: form.querySelector<HTMLInputElement>('[data-f="postPendingReview"]')?.checked ?? draft.postPendingReview,
  };
}

export interface JobsController {
  html(jobs: readonly JobView[] | undefined, projects: readonly ProjectDTO[], models: readonly ModelChoice[]): string;
  /** A click inside the view. True when it was the view's. */
  click(target: HTMLElement, jobs: readonly JobView[] | undefined, currentFolder: string): boolean;
  submit(event: Event): boolean;
  /** Keep what was typed, so a repaint draws it back. */
  input(event: Event): void;
  /** A `jobResult`. */
  result(m: Extract<HostToDashboard, { type: 'jobResult' }>): void;
  /** A `jobPreview`. */
  preview(m: Extract<HostToDashboard, { type: 'jobPreview' }>): void;
  /** A field of the form has focus: a snapshot must not repaint under the caret. */
  typing(): boolean;
}

export function createJobsController(app: HTMLElement, post: (m: DashboardToHost) => void, render: () => void): JobsController {
  const ui = newJobsUiState();
  const requestId = () => `jb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const focusName = () => app.querySelector<HTMLInputElement>('.jobs [data-f="name"]')?.focus();
  return {
    html: (jobs, projects, models) => jobsHtml(jobs, ui, projects, Date.now(), models),
    click(target, jobs, currentFolder) {
      if (!target.closest('.jobs')) return false;
      const button = target.closest<HTMLElement>('[data-jb]');
      if (!button || (button instanceof HTMLButtonElement && button.disabled)) return true;
      const id = button.dataset.id;
      const job = id ? jobs?.find((j) => j.id === id) : undefined;
      switch (button.dataset.jb) {
        case 'new':
          ui.form = blankJobForm(currentFolder, jobTemplate(button.dataset.template ?? '')?.id ?? 'custom');
          ui.error = undefined;
          render();
          focusName();
          break;
        case 'edit':
          if (!job) break;
          ui.form = jobFormFor(job);
          ui.error = undefined;
          render();
          focusName();
          break;
        case 'cancel':
          ui.form = undefined;
          ui.error = undefined;
          ui.pendingSave = undefined;
          (document.activeElement as HTMLElement | null)?.blur();
          render();
          break;
        case 'toggle':
        case 'run': {
          if (!job || ui.pending.has(job.id)) break;
          const rid = requestId();
          ui.pending.set(job.id, rid);
          ui.notes.delete(job.id);
          post(button.dataset.jb === 'run' ? { type: 'runJob', id: job.id, requestId: rid } : { type: 'jobEnable', id: job.id, on: !job.enabled, requestId: rid });
          render();
          break;
        }
        case 'history':
          if (!id) break;
          ui.open = ui.open === id ? undefined : id;
          ui.slide = ui.open;
          render();
          ui.slide = undefined;
          break;
        case 'delete':
          if (id) post({ type: 'deleteJob', id });
          break;
        case 'session':
          if (button.dataset.key) post({ type: 'rowClick', key: button.dataset.key });
          break;
        case 'link':
          if (button.dataset.url?.startsWith('https://')) post({ type: 'openExternal', url: button.dataset.url });
          break;
        case 'preview': {
          if (!id) break;
          if (ui.previewOpen === id) {
            ui.previewOpen = undefined;
            render();
            break;
          }
          ui.previewOpen = id;
          const rid = requestId();
          ui.previews.set(id, { requestId: rid });
          post({ type: 'previewJob', id, requestId: rid });
          render();
          break;
        }
      }
      return true;
    },
    submit(event) {
      const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>('.jobs form[data-job-form]');
      if (!form || !ui.form) return false;
      event.preventDefault();
      if (ui.pendingSave) return true;
      ui.form = readJobForm(form, ui.form);
      const rid = requestId();
      ui.pendingSave = rid;
      ui.error = undefined;
      post({ type: 'saveJob', ...(ui.form.id ? { id: ui.form.id } : {}), job: jobFormInput(ui.form), requestId: rid });
      (document.activeElement as HTMLElement | null)?.blur();
      render();
      return true;
    },
    input(event) {
      const form = (event.target as HTMLElement | null)?.closest?.<HTMLFormElement>('.jobs form[data-job-form]');
      if (!form || !ui.form) return;
      const before = ui.form;
      ui.form = readJobForm(form, ui.form);
      // Another harness has other models (#183).
      if (ui.form.provider !== before.provider) ui.form = { ...ui.form, model: '' };
      // Switching harness changes which fields the form has; the mode changes what its note says.
      if (ui.form.provider !== before.provider || ui.form.permissionMode !== before.permissionMode || ui.form.repeat !== before.repeat) render();
    },
    preview(m) {
      if (ui.previews.get(m.id)?.requestId !== m.requestId) return;
      ui.previews.set(m.id, { ...(m.repo ? { repo: m.repo } : {}), ...(m.items ? { items: m.items } : {}), ...(m.error ? { error: m.error } : {}) });
      render();
    },
    result(m) {
      if (ui.pendingSave === m.requestId) {
        ui.pendingSave = undefined;
        if (m.error) ui.error = m.error;
        else {
          ui.form = undefined;
          ui.error = undefined;
        }
        render();
        return;
      }
      for (const [id, rid] of ui.pending) {
        if (rid !== m.requestId) continue;
        ui.pending.delete(id);
        if (m.error) ui.notes.set(id, m.error);
        render();
        return;
      }
    },
    typing() {
      const active = document.activeElement;
      return (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) && active.closest('.jobs form') !== null;
    },
  };
}

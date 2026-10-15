/**
 * The Agents view (#179): the directory of durable agents, in the table pane.
 *
 * A row opens the agent's continuing conversation in the conversation pane
 * (the host decides whether that is its current session or an empty one the
 * first message starts). The form creates or edits an agent. Every number and
 * status arrives worked out by the host (`shared/durableAgents.ts`).
 *
 * It lives in a pane that may be 300 px wide, so everything wraps and the
 * form stacks; the narrow styles hang off `#app.narrow`, never a media query.
 * No inline styles.
 */
import { AGENT_EFFORTS, type DurableAgentInput, type DurableAgentView } from '../../shared/durableAgents';
import { capitalize, formatAge, GLOBAL_PROJECT_DIR, type ProjectDTO } from '../../shared/model';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The form's fields as typed, kept across repaints. `scope` is a folder or `GLOBAL_PROJECT_DIR`. */
export interface AgentFormDraft {
  /** Absent: a new agent. */
  id?: string;
  name: string;
  role: string;
  scope: string;
  provider: 'claude' | 'codex';
  model: string;
  effort: string;
  instructions: string;
}

export interface AgentsUiState {
  form?: AgentFormDraft;
  /** The save the form is waiting on. */
  pendingSave?: string;
  error?: string;
  /** The agent whose conversation was last opened from here. */
  selected?: string;
}

export function newAgentsUiState(): AgentsUiState {
  return {};
}

export function blankForm(scope?: string): AgentFormDraft {
  return { name: '', role: '', scope: scope && scope !== GLOBAL_PROJECT_DIR ? scope : GLOBAL_PROJECT_DIR, provider: 'claude', model: '', effort: '', instructions: '' };
}

export function formFor(a: DurableAgentView): AgentFormDraft {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    scope: a.scope.kind === 'folder' ? a.scope.dir : GLOBAL_PROJECT_DIR,
    provider: a.provider,
    model: a.model ?? '',
    effort: a.effort ?? '',
    instructions: a.instructions ?? '',
  };
}

/** What goes to the host: the host checks it again. */
export function formInput(f: AgentFormDraft): DurableAgentInput {
  return {
    name: f.name,
    role: f.role,
    scope: f.scope === GLOBAL_PROJECT_DIR ? { kind: 'global' } : { kind: 'folder', dir: f.scope },
    provider: f.provider,
    ...(f.model.trim() ? { model: f.model.trim() } : {}),
    ...(f.effort ? { effort: f.effort } : {}),
    ...(f.instructions.trim() ? { instructions: f.instructions } : {}),
  };
}

const STATUS_TEXT: Record<string, string> = {
  busy: 'Working',
  waiting: 'Waiting for you',
  blocked: 'Needs approval',
  stuck: 'Stuck',
  done: 'Idle',
  ended: 'Stopped',
};

function itemHtml(a: DurableAgentView, ui: AgentsUiState, nowMs: number): string {
  const status = a.currentStatus;
  const where = a.currentKey
    ? a.currentTitle
      ? `<span class="ag-where" title="Where you left off">${esc(a.currentTitle)}</span>`
      : `<span class="ag-where ag-missing">Last conversation not found</span>`
    : `<span class="ag-where ag-none">No conversation yet</span>`;
  const meta = [
    `<span class="ag-chip" title="${esc(a.scope.kind === 'folder' ? a.scope.dir : 'Not tied to a project')}">${esc(a.scopeLabel)}</span>`,
    `<span class="ag-chip">${esc(a.provider === 'codex' ? 'Codex' : 'Claude')}${a.model ? ` · ${esc(a.model)}` : ''}${a.effort ? ` · ${esc(a.effort)}` : ''}</span>`,
    status ? `<span class="ag-chip ag-st st-${esc(status)}">${esc(STATUS_TEXT[status] ?? capitalize(status))}</span>` : '',
    a.lastActivityAt ? `<span class="ag-age">${esc(formatAge(nowMs, a.lastActivityAt))} ago</span>` : '',
    a.historyCount > 0 ? `<span class="ag-age" title="Earlier conversations this agent remembers">${a.historyCount} earlier</span>` : '',
  ].join('');
  return `<li class="ag-item${ui.selected === a.id ? ' selected' : ''}" data-agent="${esc(a.id)}">
<button type="button" class="ag-open" data-ag="open" data-id="${esc(a.id)}" title="Open ${esc(a.name)}'s conversation">
<span class="ag-name">${esc(a.name)}</span><span class="ag-role">${esc(a.role)}</span>${where}<span class="ag-meta">${meta}</span></button>
<span class="ag-actions">
<button type="button" class="ag-btn" data-ag="fresh" data-id="${esc(a.id)}"${a.currentKey ? '' : ' disabled'} title="Keep the current conversation in history; your next message starts a new one">New conversation</button>
<button type="button" class="ag-btn" data-ag="edit" data-id="${esc(a.id)}">Edit</button>
<button type="button" class="ag-btn danger" data-ag="delete" data-id="${esc(a.id)}" title="Forget this agent. Its sessions stay, unassigned.">Delete</button>
</span></li>`;
}

function formHtml(f: AgentFormDraft, ui: AgentsUiState, projects: readonly ProjectDTO[]): string {
  const opt = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const folders = projects.filter((p) => p.dir !== GLOBAL_PROJECT_DIR);
  // A folder that has since left the list stays selectable on the agent it belongs to.
  if (f.scope !== GLOBAL_PROJECT_DIR && !folders.some((p) => p.dir === f.scope)) folders.unshift({ dir: f.scope, name: f.scope.split('/').filter(Boolean).pop() ?? f.scope });
  const scopes = [opt(GLOBAL_PROJECT_DIR, 'Global (no project)', f.scope === GLOBAL_PROJECT_DIR), ...folders.map((p) => opt(p.dir, `${p.name} — ${p.dir}`, p.dir === f.scope))].join('');
  const efforts = AGENT_EFFORTS.map((e) => opt(e, e ? capitalize(e) : 'Default', f.effort === e)).join('');
  const busy = ui.pendingSave !== undefined;
  return `<form class="ag-form" data-ag-form novalidate>
<h3 class="ag-formtitle">${f.id ? 'Edit agent' : 'New agent'}</h3>
<label class="ag-field"><span>Name</span><input data-f="name" maxlength="60" required value="${esc(f.name)}" placeholder="Product owner"></label>
<label class="ag-field"><span>Role</span><input data-f="role" maxlength="200" required value="${esc(f.role)}" placeholder="Owns the backlog and acceptance criteria for this project"></label>
<label class="ag-field"><span>Scope</span><select data-f="scope">${scopes}</select></label>
<span class="ag-row">
<label class="ag-field"><span>Harness</span><select data-f="provider">${opt('claude', 'Claude', f.provider === 'claude')}${opt('codex', 'Codex', f.provider === 'codex')}</select></label>
<label class="ag-field"><span>Model</span><input data-f="model" maxlength="100" value="${esc(f.model)}" placeholder="Default"></label>
<label class="ag-field"><span>Effort</span><select data-f="effort">${efforts}</select></label>
</span>
<label class="ag-field"><span>Instructions</span><textarea data-f="instructions" rows="5" maxlength="8000" placeholder="How this agent works: what it owns, how it reports, what it should not do. The repository's own instructions still apply.">${esc(f.instructions)}</textarea></label>
${f.id ? '<p class="ag-note">Changing the harness or scope starts a new conversation next time; the current one is kept in history.</p>' : ''}
${ui.error ? `<p class="ag-error" role="alert">${esc(ui.error)}</p>` : ''}
<span class="ag-formactions"><button type="submit" class="ag-btn primary"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button><button type="button" class="ag-btn" data-ag="cancel">Cancel</button></span>
</form>`;
}

export function agentsHtml(agents: readonly DurableAgentView[] | undefined, ui: AgentsUiState, projects: readonly ProjectDTO[], nowMs: number): string {
  const list = agents ?? [];
  const bar = `<div class="ag-bar"><span class="ag-hint">Agents you come back to. Selecting one continues its conversation.</span><button type="button" class="ag-btn primary" data-ag="new"${ui.form && !ui.form.id ? ' disabled' : ''}>+ New agent</button></div>`;
  const form = ui.form ? formHtml(ui.form, ui, projects) : '';
  const body =
    list.length === 0
      ? ui.form
        ? ''
        : `<div class="ag-empty">No agents yet.<span class="hint">An agent is a role you return to — a product owner for one project, a reviewer, a release manager. It keeps its instructions and its conversation; it runs nothing until you message it.</span></div>`
      : `<ul class="ag-list">${list.map((a) => itemHtml(a, ui, nowMs)).join('')}</ul>`;
  return `<div class="agents">${bar}${form}${body}</div>`;
}

/** Read the form's fields back into the draft. */
export function readForm(form: HTMLElement, draft: AgentFormDraft): AgentFormDraft {
  const value = (f: string) => (form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-f="${f}"]`)?.value ?? '');
  return {
    ...draft,
    name: value('name'),
    role: value('role'),
    scope: value('scope') || GLOBAL_PROJECT_DIR,
    provider: value('provider') === 'codex' ? 'codex' : 'claude',
    model: value('model'),
    effort: value('effort'),
    instructions: value('instructions'),
  };
}

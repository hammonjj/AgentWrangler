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
import { MEMORY_KINDS, MEMORY_KIND_LABEL, MAX_MEMORY_ITEM, type AgentMemoryKind } from '../../shared/agentMemory';
import { AGENT_EFFORTS, type DurableAgentInput, type DurableAgentView } from '../../shared/durableAgents';
import { capitalize, formatAge, GLOBAL_PROJECT_DIR, type ProjectDTO } from '../../shared/model';
import type { ModelChoice } from '../../shared/conversation';
import { modelOptionsHtml } from './modelSelect';

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
  instructionsFile: string;
}

/** What one agent card has open below it: its memory (#180) or its earlier conversations (#181). */
export interface AgentPanel {
  id: string;
  tab: 'memory' | 'history';
}

/** The memory add box, or an item being edited (`itemId`), as typed. */
export interface MemoryDraft {
  agentId: string;
  itemId?: string;
  kind: AgentMemoryKind;
  text: string;
}

export interface AgentsUiState {
  form?: AgentFormDraft;
  /** The save the form is waiting on. */
  pendingSave?: string;
  error?: string;
  /** The agent whose conversation was last opened from here. */
  selected?: string;
  panel?: AgentPanel;
  /** The add box as typed, and the item being edited, each kept across repaints on its own. */
  memoryAdd?: MemoryDraft;
  memoryEdit?: MemoryDraft;
  /** Which of the two the pending action is: only that one is cleared when it succeeds. */
  memorySubmitted?: 'add' | 'edit';
  /** A memory, history or assignment change the view is waiting on, and its refusal. */
  pendingAction?: string;
  panelError?: string;
  /** Archived agents are listed (#182). */
  showArchived?: boolean;
}

export function newAgentsUiState(): AgentsUiState {
  return {};
}

export function blankForm(scope?: string): AgentFormDraft {
  return { name: '', role: '', scope: scope && scope !== GLOBAL_PROJECT_DIR ? scope : GLOBAL_PROJECT_DIR, provider: 'claude', model: '', effort: '', instructions: '', instructionsFile: '' };
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
    instructionsFile: a.instructionsFile ?? '',
  };
}

/** What goes to the host: the host checks it again. */
export function formInput(f: AgentFormDraft): DurableAgentInput {
  const global = f.scope === GLOBAL_PROJECT_DIR;
  return {
    name: f.name,
    role: f.role,
    scope: global ? { kind: 'global' } : { kind: 'folder', dir: f.scope },
    provider: f.provider,
    ...(f.model.trim() ? { model: f.model.trim() } : {}),
    ...(f.effort ? { effort: f.effort } : {}),
    ...(f.instructions.trim() ? { instructions: f.instructions } : {}),
    // Sent with Global too, so the host refuses it in words rather than it vanishing.
    ...(f.instructionsFile.trim() ? { instructionsFile: f.instructionsFile.trim() } : {}),
  };
}

/** The agents the list shows: archived ones only when asked for. */
export function visibleAgents(agents: readonly DurableAgentView[], ui: AgentsUiState): DurableAgentView[] {
  return ui.showArchived ? [...agents] : agents.filter((a) => !a.archived);
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
    a.pinned ? '<span class="ag-chip ag-pinned" title="Listed first">Pinned</span>' : '',
    a.archived ? '<span class="ag-chip" title="Hidden from the list until Show archived">Archived</span>' : '',
  ].join('');
  const panel = ui.panel?.id === a.id ? ui.panel.tab : undefined;
  const id = esc(a.id);
  const toggle = (tab: 'memory' | 'history', label: string, title: string) =>
    `<button type="button" class="ag-btn ag-tab${panel === tab ? ' on' : ''}" data-ag="panel" data-tab="${tab}" data-id="${id}" aria-expanded="${panel === tab}" title="${esc(title)}">${esc(label)}</button>`;
  const proposals = a.proposals.length > 0 ? ` · ${a.proposals.length} to approve` : '';
  return `<li class="ag-item${ui.selected === a.id ? ' selected' : ''}${a.pinned ? ' pinned' : ''}${a.archived ? ' archived' : ''}${a.proposals.length ? ' asks' : ''}" data-agent="${id}">
<button type="button" class="ag-open" data-ag="open" data-id="${id}" title="Open ${esc(a.name)}'s conversation">
<span class="ag-name">${esc(a.name)}</span><span class="ag-role">${esc(a.role)}</span>${where}<span class="ag-meta">${meta}</span></button>
<span class="ag-actions">
${toggle('memory', `Memory ${a.memory.length}${proposals}`, 'Where we left off: what this agent carries into every conversation')}
${toggle('history', `History ${a.historyCount}`, 'Earlier conversations with this agent')}
<button type="button" class="ag-btn" data-ag="fresh" data-id="${id}"${a.currentKey ? '' : ' disabled'} title="Keep the current conversation in history; your next message starts a new one">New conversation</button>
<button type="button" class="ag-btn" data-ag="edit" data-id="${id}">Edit</button>
<button type="button" class="ag-btn" data-ag="pin" data-id="${id}" title="${a.pinned ? 'Stop listing it first' : 'List it first'}">${a.pinned ? 'Unpin' : 'Pin'}</button>
<button type="button" class="ag-btn" data-ag="archive" data-id="${id}" title="${a.archived ? 'List it again' : 'Hide it from the list. Nothing is deleted; Show archived brings it back.'}">${a.archived ? 'Restore' : 'Archive'}</button>
<button type="button" class="ag-btn danger" data-ag="delete" data-id="${id}" title="Forget this agent. Its sessions stay, unassigned.">Delete</button>
</span>${panel === 'memory' ? memoryPanelHtml(a, ui) : panel === 'history' ? historyPanelHtml(a, ui, nowMs) : ''}</li>`;
}

function kindOptions(selected: AgentMemoryKind): string {
  return MEMORY_KINDS.map((k) => `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(MEMORY_KIND_LABEL[k])}</option>`).join('');
}

/**
 * The agent's memory (#180): the proposals waiting for the user first, since
 * they are the only thing here that asks for something, then the items, each
 * editable and forgettable, then the box to remember something new.
 */
function memoryPanelHtml(a: DurableAgentView, ui: AgentsUiState): string {
  const id = esc(a.id);
  const busy = ui.pendingAction !== undefined;
  const dis = busy ? ' disabled' : '';
  const draft = ui.memoryEdit?.agentId === a.id ? ui.memoryEdit : undefined;
  const textOf = (itemId: string) => a.memory.find((i) => i.id === itemId)?.text;
  const proposals = a.proposals
    .map((p) => {
      const what =
        p.op === 'add'
          ? `<span class="ag-chip">${esc(MEMORY_KIND_LABEL[p.kind])}</span> ${esc(p.text)}`
          : `<span class="ag-chip">Forget</span> ${esc(textOf(p.itemId) ?? p.itemId)}`;
      return `<li class="ag-prop"><span class="ag-proptext"><b>${esc(a.name)} proposes:</b> ${what}</span>
<span class="ag-memacts"><button type="button" class="ag-btn primary" data-ag="mem" data-op="approve" data-pid="${esc(p.id)}" data-id="${id}"${dis}>Approve</button><button type="button" class="ag-btn" data-ag="mem" data-op="reject" data-pid="${esc(p.id)}" data-id="${id}"${dis}>Reject</button></span></li>`;
    })
    .join('');
  const items = a.memory
    .map((i) => {
      if (draft?.itemId === i.id) {
        return `<li class="ag-memitem"><form class="ag-memform" data-mem-form data-id="${id}" data-item="${esc(i.id)}"><select data-m="kind">${kindOptions(draft.kind)}</select><input data-m="text" maxlength="${MAX_MEMORY_ITEM}" value="${esc(draft.text)}" aria-label="Note"><button type="submit" class="ag-btn primary"${dis}>Save</button><button type="button" class="ag-btn" data-ag="memcancel" data-id="${id}">Cancel</button></form></li>`;
      }
      return `<li class="ag-memitem"><span class="ag-memtext"><span class="ag-chip">${esc(MEMORY_KIND_LABEL[i.kind])}</span> ${esc(i.text)}${i.source === 'agent' ? ' <span class="ag-age" title="Proposed by the agent and approved by you">from the agent</span>' : ''}</span>
<span class="ag-memacts"><button type="button" class="ag-btn" data-ag="memedit" data-item="${esc(i.id)}" data-id="${id}"${dis}>Edit</button><button type="button" class="ag-btn danger" data-ag="mem" data-op="forget" data-item="${esc(i.id)}" data-id="${id}"${dis} title="Remove it. Conversations started or resumed from now on no longer carry it.">Forget</button></span></li>`;
    })
    .join('');
  const add = ui.memoryAdd?.agentId === a.id ? ui.memoryAdd : { kind: 'decision' as AgentMemoryKind, text: '' };
  return `<div class="ag-panel" data-panel="memory">
${proposals ? `<ul class="ag-props">${proposals}</ul>` : ''}
${items ? `<ul class="ag-mem">${items}</ul>` : '<p class="ag-note">Nothing remembered yet. Add decisions, preferences, open questions and current work, so the next conversation picks up where this one left off.</p>'}
<form class="ag-memform" data-mem-form data-id="${id}"><select data-m="kind" aria-label="Kind">${kindOptions(add.kind)}</select><input data-m="text" maxlength="${MAX_MEMORY_ITEM}" value="${esc(add.text)}" placeholder="Remember…" aria-label="Something to remember"><button type="submit" class="ag-btn"${dis}>Remember</button></form>
<p class="ag-note">${a.memoryChars.toLocaleString('en-US')} of ${a.memoryCap.toLocaleString('en-US')} characters. Sent to each new or resumed conversation as context, never as permission.</p>
${ui.panelError ? `<p class="ag-error" role="alert">${esc(ui.panelError)}</p>` : ''}
</div>`;
}

/** The agent's earlier conversations (#181), newest first: open one, or carry on with it. */
function historyPanelHtml(a: DurableAgentView, ui: AgentsUiState, nowMs: number): string {
  const id = esc(a.id);
  const dis = ui.pendingAction !== undefined ? ' disabled' : '';
  const rows = a.history
    .map((h) => {
      const known = h.title !== undefined;
      const when = h.lastActivityAt ?? h.linkedAt;
      const status = h.status ? `<span class="ag-chip ag-st st-${esc(h.status)}">${esc(STATUS_TEXT[h.status] ?? capitalize(h.status))}</span>` : '';
      return `<li class="ag-hist"><span class="ag-histtext">${known ? esc(h.title!) : '<span class="ag-where ag-missing">Not in the table any more</span>'} ${status}${when ? `<span class="ag-age">${esc(formatAge(nowMs, when))} ago</span>` : ''}</span>
<span class="ag-memacts"><button type="button" class="ag-btn" data-ag="histopen" data-key="${esc(h.key)}" data-id="${id}"${known ? '' : ' disabled'}>Open</button><button type="button" class="ag-btn" data-ag="makecurrent" data-key="${esc(h.key)}" data-id="${id}"${dis} title="Typing to ${esc(a.name)} continues this conversation again; the current one moves here">Make current</button></span></li>`;
    })
    .join('');
  return `<div class="ag-panel" data-panel="history">
${rows ? `<ul class="ag-histlist">${rows}</ul>` : '<p class="ag-note">No earlier conversations. New conversation keeps the current one here; Sessions can also give a conversation to this agent from a row\'s menu.</p>'}
${ui.panelError ? `<p class="ag-error" role="alert">${esc(ui.panelError)}</p>` : ''}
</div>`;
}

function formHtml(f: AgentFormDraft, ui: AgentsUiState, projects: readonly ProjectDTO[], models: readonly ModelChoice[]): string {
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
<label class="ag-field"><span>Model</span><select data-f="model">${modelOptionsHtml(models, f.provider, f.model)}</select></label>
<label class="ag-field"><span>Effort</span><select data-f="effort">${efforts}</select></label>
</span>
<label class="ag-field"><span>Instructions</span><textarea data-f="instructions" rows="5" maxlength="8000" placeholder="How this agent works: what it owns, how it reports, what it should not do. The repository's own instructions still apply.">${esc(f.instructions)}</textarea></label>
<label class="ag-field"><span>Instructions file (optional, project agents only)</span><input data-f="instructionsFile" maxlength="300" value="${esc(f.instructionsFile)}" placeholder="docs/agents/product-owner.md"></label>
<p class="ag-note">A file in the project folder, read again each time a conversation starts or resumes, so edits to it apply from the next one. If it goes missing, sending says so.</p>
${f.id ? '<p class="ag-note">Everything applies from the next message. Changing the harness or scope starts a new conversation (you are asked first); the current one is kept in history, and memory carries over.</p>' : ''}
${ui.error ? `<p class="ag-error" role="alert">${esc(ui.error)}</p>` : ''}
<span class="ag-formactions"><button type="submit" class="ag-btn primary"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button><button type="button" class="ag-btn" data-ag="cancel">Cancel</button></span>
</form>`;
}

export function agentsHtml(agents: readonly DurableAgentView[] | undefined, ui: AgentsUiState, projects: readonly ProjectDTO[], nowMs: number, models: readonly ModelChoice[] = []): string {
  const all = agents ?? [];
  const list = visibleAgents(all, ui);
  const archived = all.filter((a) => a.archived).length;
  const archivedToggle = archived > 0 ? `<button type="button" class="ag-btn" data-ag="showarchived" aria-pressed="${ui.showArchived === true}">${ui.showArchived ? 'Hide archived' : `Show archived (${archived})`}</button>` : '';
  const bar = `<div class="ag-bar"><span class="ag-hint">Agents you come back to. Selecting one continues its conversation.</span>${archivedToggle}<button type="button" class="ag-btn primary" data-ag="new"${ui.form && !ui.form.id ? ' disabled' : ''}>+ New agent</button></div>`;
  const form = ui.form ? formHtml(ui.form, ui, projects, models) : '';
  const body =
    list.length === 0
      ? ui.form
        ? ''
        : all.length > 0
          ? '<div class="ag-empty">Every agent is archived.<span class="hint">Show archived lists them again.</span></div>'
          : `<div class="ag-empty">No agents yet.<span class="hint">An agent is a role you return to — a product owner for one project, a reviewer, a release manager. It keeps its instructions, its memory and its conversation; it runs nothing until you message it.</span></div>`
      : `<ul class="ag-list">${list.map((a) => itemHtml(a, ui, nowMs)).join('')}</ul>`;
  return `<div class="agents">${bar}${form}${body}</div>`;
}

/** Read a memory box back into the draft. */
export function readMemoryForm(form: HTMLElement): MemoryDraft | undefined {
  const agentId = form.dataset.id;
  if (!agentId) return undefined;
  const kind = form.querySelector<HTMLSelectElement>('[data-m="kind"]')?.value;
  return {
    agentId,
    ...(form.dataset.item ? { itemId: form.dataset.item } : {}),
    kind: (MEMORY_KINDS as readonly string[]).includes(kind ?? '') ? (kind as AgentMemoryKind) : 'decision',
    text: form.querySelector<HTMLInputElement>('[data-m="text"]')?.value ?? '',
  };
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
    instructionsFile: value('instructionsFile'),
  };
}

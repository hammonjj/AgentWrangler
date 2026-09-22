/**
 * What a session currently asks a human, projected for a remote surface.
 *
 * The sibling of `rowMenu.ts`, and deliberately shaped like it: a pure function
 * from a session to the choices currently legal on it. The dashboard row, the
 * conversation card and a Discord message are three renderings of one
 * interaction, and which choices exist is a fact about session state rather
 * than about any of the three.
 *
 * Nothing here is stored. A `RemoteAsk` is recomputed from the session every
 * time it is needed, exactly as `permissionRow` and `TranscriptSource.buildAsk`
 * recompute theirs — Agent Wrangler owns whether an ask exists, and the remote
 * layer owns only the mapping from one to a message it has posted.
 *
 * Pure, and in `shared/` so a webview could render the same thing later: no
 * `vscode`, Node or DOM imports.
 */
import type { DashboardAction } from './messages';
import { displayLabel, type PermissionAsk, type SessionDTO } from './model';

/**
 * One button on a remote surface.
 *
 * `action` is an existing Agent Wrangler action, not a remote-only verb: the
 * whole point is that pressing this invokes what the local UI would have
 * invoked. A transport renders the label and hands the action back; it never
 * invents one.
 */
export interface RemoteChoice {
  action: DashboardAction;
  label: string;
  /** What this choice costs beyond the obvious — where an "always" rule is saved. */
  detail?: string;
  /** A hint, not an instruction; a transport with no notion of tone ignores it. */
  tone?: 'primary' | 'danger';
}

/** Who and where, for the header. A projection, so no pid, cwd or transcript path leaks. */
export interface RemoteAskContext {
  agent: string;
  repository?: string;
  branch?: string;
  worktree?: string;
  model?: string;
}

/**
 * One Agent Wrangler interaction, ready to mirror.
 *
 * `askKey` is its identity and `requestId` is what makes it *this* ask rather
 * than the one that replaces it — the two together are what let a press arriving
 * minutes later be checked against live state before anything is applied.
 */
export interface RemoteAsk {
  /** `${sessionKey}#${requestId}`. Stable while the ask is open, gone when it is. */
  askKey: string;
  sessionKey: string;
  requestId: string;
  /** The seam for questions and plan approvals later; only permissions exist today. */
  kind: 'permission';
  /** One line, for a notification preview: who wants what. */
  title: string;
  toolName: string;
  /** Claude's own description and the literal thing that will happen. Reused as-is. */
  subject?: PermissionAsk;
  context: RemoteAskContext;
  choices: RemoteChoice[];
}

/**
 * Something that happened, told to the remote surface once.
 *
 * The opposite of a `RemoteAsk` in every way that matters: nothing is waiting on
 * it, so it has no identity, no lifecycle, no buttons and is never edited or
 * closed. Auto-pause is the first of these — the agents are already stopped by
 * the time it is sent, and there is nothing a phone could usefully press.
 *
 * It carries no session detail on purpose. A notice is about the machine, and
 * "which project" is exactly the sort of thing the redaction rules exist to keep
 * out of a channel that does not need it.
 */
export interface RemoteNotice {
  /** The preview line. */
  title: string;
  body?: string;
  /** A hint, not an instruction; a transport with no notion of tone ignores it. */
  tone?: 'info' | 'warn';
}

/**
 * Longest rule text inside an "always allow" label. Transports have their own,
 * tighter limits (a Discord button label caps at 80) and enforce them
 * themselves; this only keeps the label scannable rather than a paragraph.
 */
const MAX_RULE_LABEL = 48;

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The remote ask this session presents, or nothing.
 *
 * The conditions mirror what the dashboard already does, because a remote
 * surface must never offer a decision the local one would not:
 *
 * - `permissionRequestId` is the whole gate. The provider only sets it while
 *   the hook script's marker still exists, i.e. while a decision can still
 *   land, which is exactly when `permissionRow` renders buttons.
 * - **archived** sessions are skipped, matching the toast wiring: archived
 *   means "out of my way", and a channel message is the opposite of that.
 * - **paused** sessions are skipped, matching the status-bar bell: a frozen
 *   process cannot act on an answer until it is resumed, so offering one
 *   remotely would produce a button that appears to work and does nothing.
 *
 * Note what is *not* excluded: a session Agent Wrangler runs itself. Those
 * raise the same marker as any other (verified — see the plan's §0.1), and a
 * marker is answerable by any process on the machine, so they mirror like the
 * rest. `AskUserQuestion` and `ExitPlanMode` never reach `PermissionRequest`
 * and so never appear here at all, which is why questions and plans are out of
 * scope rather than explicitly filtered.
 */
export function remoteAskFor(s: SessionDTO): RemoteAsk | undefined {
  if (s.provider !== 'claude') return undefined;
  if (s.status !== 'blocked') return undefined;
  if (!s.permissionRequestId) return undefined;
  if (s.archived || s.paused) return undefined;

  const agent = displayLabel(s);
  const toolName = s.blockedReason ?? 'a tool';

  return {
    askKey: askKeyFor(s.key, s.permissionRequestId),
    sessionKey: s.key,
    requestId: s.permissionRequestId,
    kind: 'permission',
    title: `${agent} needs permission for ${toolName}`,
    toolName,
    subject: s.blockedAsk,
    context: {
      agent,
      repository: s.projectName,
      branch: s.gitBranch,
      worktree: s.worktree,
      model: s.model,
    },
    choices: choicesFor(s),
  };
}

/**
 * "That one is finished", as a notice — or nothing, if it is not news.
 *
 * Pure and here rather than in the app for the same reason `remoteAskFor` is:
 * what a remote surface is told about a session is a fact about the session,
 * and the wording is then testable without a store, a transport or a network.
 *
 * The exclusions match the permission card's, and for the same reasons:
 * **archived** means "out of my way", and a channel message is the opposite of
 * that. Unlike the card this is not Claude-only — a Codex session that has
 * stopped is exactly as finished, and there is no decision here that a provider
 * would have to be able to carry.
 *
 * It discloses the same things the card's header does — agent, repository,
 * branch — and nothing more. In particular no transcript content: that an agent
 * finished is the news, and what it said is on the machine where it is safe.
 */
export function doneNoticeFor(s: SessionDTO): RemoteNotice | undefined {
  if (s.status !== 'done') return undefined;
  if (s.archived) return undefined;

  const where = [s.projectName, s.gitBranch].filter(Boolean).join(' · ');
  return {
    title: `✅ ${displayLabel(s)} finished`,
    body: [where, 'It is idle until you send it something.'].filter(Boolean).join('\n'),
    tone: 'info',
  };
}

/** The identity of one interaction: which session, and which of its prompts. */
export function askKeyFor(sessionKey: string, requestId: string): string {
  return `${sessionKey}#${requestId}`;
}

/**
 * Allow, always-allow, deny — with the middle one present only when Agent
 * Wrangler itself is offering it.
 *
 * "Always allow" is Claude Code's own *don't ask again*, carried by the
 * prompt's `permission_suggestions`. With no suggestion there is no rule to
 * apply, and a button labelled for a rule that does not exist would be a
 * different promise from the one the dashboard makes. The label names the rule
 * and the detail names where it is saved, because agreeing to this from a
 * phone should not be vaguer than agreeing to it at the machine.
 */
function choicesFor(s: SessionDTO): RemoteChoice[] {
  const choices: RemoteChoice[] = [{ action: 'allow', label: 'Allow once', tone: 'primary' }];

  if (s.alwaysAllow && s.alwaysAllow.rules.length > 0) {
    const rules = ellipsize(s.alwaysAllow.rules.join(', '), MAX_RULE_LABEL);
    choices.push({
      action: 'always',
      label: `Always allow ${rules}`,
      detail: `Saved to ${s.alwaysAllow.destination}, exactly as Claude Code's own "don't ask again" would.`,
    });
  }

  choices.push({ action: 'deny', label: 'Deny', tone: 'danger' });
  return choices;
}

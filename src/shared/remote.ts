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
export interface RemoteChoice<A extends RemoteChoiceAction = RemoteChoiceAction> {
  action: A;
  label: string;
  /** What this choice costs beyond the obvious — where an "always" rule is saved. */
  detail?: string;
  /** A hint, not an instruction; a transport with no notion of tone ignores it. */
  tone?: 'primary' | 'danger';
}

/**
 * Everything a press can say.
 *
 * The permission verbs are `DashboardAction`s, unchanged. `approve` and
 * `opt<n>` are not remote-only inventions either, despite not appearing in that
 * union: `opt2` is an index into *this ask's own option list*, resolved locally
 * against state re-read at press time into the very `answers` record the
 * dashboard's own stepper posts. A transport still never invents one — it
 * hands back what it was given.
 */
export type RemoteChoiceAction = Extract<DashboardAction, 'allow' | 'deny' | 'always'> | 'approve' | `opt${number}`;

/**
 * Which sort of interaction a remote surface is showing.
 *
 * A permission is hook-backed and answerable by any process on the machine; a
 * question and a plan live in the heap of whichever process runs the session
 * and are answerable only there. The mirror map persists this, so a record
 * written by one build is still closeable by the next.
 */
export type RemoteAskKind = 'permission' | 'question' | 'plan';

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
interface RemoteAskBase {
  /** `${sessionKey}#${requestId}`. Stable while the ask is open, gone when it is. */
  askKey: string;
  sessionKey: string;
  requestId: string;
  /** One line, for a notification preview: who wants what. */
  title: string;
  toolName: string;
  context: RemoteAskContext;
  /**
   * What this card cannot do, in one line, when it cannot do everything the
   * local one can. Rendered plainly rather than as a disabled button: a greyed
   * *Request changes* says "you could have done this", which is a different and
   * more annoying lie than "do this at the machine".
   */
  note?: string;
}

/** A hook-backed permission prompt. Answerable from any process on the machine. */
export interface RemotePermissionAsk extends RemoteAskBase {
  kind: 'permission';
  /** Claude's own description and the literal thing that will happen. Reused as-is. */
  subject?: PermissionAsk;
  choices: RemoteChoice<'allow' | 'always' | 'deny'>[];
}

/**
 * An `AskUserQuestion`. In-process only, and mirrored with one button per
 * option — or with none at all, when the shape needs more than buttons offer.
 */
export interface RemoteQuestionAsk extends RemoteAskBase {
  kind: 'question';
  question: string;
  /** The model's own short label for the question ("Choice", "Database"). */
  header?: string;
  /** Kept whole even when unbuttonable, so the card can still say what is being asked. */
  options: { label: string; description?: string }[];
  /** True when the local form takes several answers, which buttons cannot express. */
  multiSelect?: boolean;
  choices: RemoteChoice<`opt${number}`>[];
}

/** An `ExitPlanMode`. In-process only, approvable remotely; rejection is not. */
export interface RemotePlanAsk extends RemoteAskBase {
  kind: 'plan';
  plan: string;
  /** Characters the block cap held back, so a truncated plan reads as truncated. */
  more?: number;
  choices: RemoteChoice<'approve'>[];
}

/**
 * One Agent Wrangler interaction, ready to mirror.
 *
 * `askKey` is its identity and `requestId` is what makes it *this* ask rather
 * than the one that replaces it — the two together are what let a press arriving
 * minutes later be checked against live state before anything is applied.
 *
 * A union rather than one shape with optional halves, so that the code applying
 * a press switches on `kind` and the compiler checks it reached every arm. The
 * three are genuinely different acts: one writes a decision file, one resolves
 * a promise with an answer, one resolves a promise with an approval.
 */
export type RemoteAsk = RemotePermissionAsk | RemoteQuestionAsk | RemotePlanAsk;

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

/** Longest question or option text kept in a card's own body. */
const MAX_QUESTION_LABEL = 300;
/** Discord caps a button label at 80; leave room for the transport's own clip. */
const MAX_OPTION_LABEL = 72;
/** More options than one Discord action row holds. */
const MAX_BUTTON_CHOICES = 5;

/**
 * The remote ask this session presents, or nothing.
 *
 * Three kinds, tried in the order a session could plausibly be parked on them.
 * A session is only ever waiting on one thing, so the order is a tiebreak that
 * should never fire rather than a priority worth arguing about.
 *
 * Two exclusions apply to all three, because a remote surface must never offer
 * a decision the local one would not:
 *
 * - **archived** sessions are skipped, matching the toast wiring: archived
 *   means "out of my way", and a channel message is the opposite of that.
 * - **paused** sessions are skipped, matching the status-bar bell: a frozen
 *   process cannot act on an answer until it is resumed, so offering one
 *   remotely would produce a button that appears to work and does nothing.
 */
export function remoteAskFor(s: SessionDTO): RemoteAsk | undefined {
  if (s.archived || s.paused) return undefined;
  return permissionAskFor(s) ?? questionAskFor(s) ?? planAskFor(s);
}

/**
 * A hook-backed permission prompt.
 *
 * `permissionRequestId` is the whole gate. The provider only sets it while the
 * hook script's marker still exists, i.e. while a decision can still land,
 * which is exactly when `permissionRow` renders buttons.
 *
 * Note what is *not* excluded: a session Agent Wrangler runs itself. Those
 * raise the same marker as any other, and a marker is answerable by any
 * process on the machine, so they mirror like the rest.
 */
function permissionAskFor(s: SessionDTO): RemotePermissionAsk | undefined {
  if (s.provider !== 'claude') return undefined;
  if (s.status !== 'blocked') return undefined;
  if (!s.permissionRequestId) return undefined;

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
    context: contextFor(s),
    choices: choicesFor(s),
  };
}

/**
 * An `AskUserQuestion` this window's own runner is parked on.
 *
 * `runnerOwned` is the gate, and it is a real one rather than a formality: a
 * question is settled by resolving a `canUseTool` promise, so only the process
 * holding that promise can answer it. Since the app holds a single-instance
 * lock, the process holding the transport is that process — which is why this
 * needs no lease and no cross-window call.
 *
 * Note there is no `status === 'blocked'` check. The pending ask *is* the
 * evidence, and it is better evidence than a status that a hook has to deliver:
 * a Codex question never touches the Claude hook log at all.
 */
function questionAskFor(s: SessionDTO): RemoteQuestionAsk | undefined {
  if (!s.runnerOwned) return undefined;
  const parked = s.pendingQuestion;
  if (!parked || parked.questions.length === 0) return undefined;

  const agent = displayLabel(s);
  const first = parked.questions[0];
  const question = ellipsize(first.question, MAX_QUESTION_LABEL);
  const options = first.options.map((o) => ({ label: o.label, description: o.description }));

  return {
    askKey: askKeyFor(s.key, parked.requestId),
    sessionKey: s.key,
    requestId: parked.requestId,
    kind: 'question',
    title: `${agent} is asking: ${question}`,
    toolName: 'AskUserQuestion',
    question,
    header: first.header,
    options,
    multiSelect: first.multiSelect,
    context: contextFor(s),
    ...answerableShape(parked.questions.length, first),
  };
}

/**
 * Which of a question's shapes this slice can put on buttons, and what to say
 * when it cannot.
 *
 * Buttons are one press, one answer. A multi-select form, a stepper of several
 * questions, or more options than an action row holds are all asking for
 * something a row of buttons cannot express, and guessing on the user's behalf
 * would be worse than pointing at the machine. The *Other* box is free text
 * and never becomes a button in this slice at all.
 *
 * The card is still published either way. Knowing an agent is waiting on you is
 * most of the value, and it is the half that does not need a button.
 */
function answerableShape(
  count: number,
  first: { options: { label: string }[]; multiSelect?: boolean },
): Pick<RemoteQuestionAsk, 'choices' | 'note'> {
  if (count > 1) {
    return { choices: [], note: 'Answer this in Agent Wrangler — there is more than one question here.' };
  }
  if (first.multiSelect) {
    return { choices: [], note: 'Answer this in Agent Wrangler — it takes more than one answer.' };
  }
  if (first.options.length === 0 || first.options.length > MAX_BUTTON_CHOICES) {
    return { choices: [], note: 'Answer this in Agent Wrangler — it has too many options for buttons.' };
  }
  return {
    choices: first.options.map((o, i) => ({
      action: `opt${i}` as const,
      label: ellipsize(o.label, MAX_OPTION_LABEL),
      tone: i === 0 ? ('primary' as const) : undefined,
    })),
  };
}

/**
 * An `ExitPlanMode` this window's own runner is parked on.
 *
 * **Approve only.** `decidePlan(requestId, false, feedback)` rejects *with a
 * message*, and a rejection carrying none tells the model it was turned down
 * and nothing about why — a worse act than the local button rather than a
 * smaller one. So there is no *Request changes* here, and the note says where
 * to find it.
 *
 * `more` travels with the plan because approving a plan is the one remote act
 * that turns on having read the thing: a card showing half a plan must say so.
 */
function planAskFor(s: SessionDTO): RemotePlanAsk | undefined {
  if (!s.runnerOwned) return undefined;
  const parked = s.pendingPlan;
  if (!parked) return undefined;

  const agent = displayLabel(s);
  return {
    askKey: askKeyFor(s.key, parked.requestId),
    sessionKey: s.key,
    requestId: parked.requestId,
    kind: 'plan',
    title: `${agent} wants to start on a plan`,
    toolName: 'ExitPlanMode',
    plan: parked.plan,
    more: parked.more,
    context: contextFor(s),
    choices: [{ action: 'approve', label: 'Approve plan', tone: 'primary' }],
    note: 'Request changes in Agent Wrangler; only approval can be given from here.',
  };
}

function contextFor(s: SessionDTO): RemoteAskContext {
  return {
    agent: displayLabel(s),
    repository: s.projectName,
    branch: s.gitBranch,
    worktree: s.worktree,
    model: s.model,
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
function choicesFor(s: SessionDTO): RemotePermissionAsk['choices'] {
  const choices: RemotePermissionAsk['choices'] = [{ action: 'allow', label: 'Allow once', tone: 'primary' }];

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

# Agent Wrangler — product context for an agent

Briefing document for a product-owner / planning agent that proposes features but does not
write the code. Everything here is fact as of 2026-09-23. `README.md` is the behavioural
source of truth; `docs/plans/*.md` holds the active and proposed designs. Where this file
and those disagree, they win.

---

## 1. What it is, in one paragraph

Agent Wrangler is a local macOS desktop app (Electron) that watches **every AI coding-agent
session on one machine** — Claude Code and Codex, started anywhere: a VSCode window, an iTerm
tab, another agent's subprocess, or the app itself — and puts them in a single window as a
live table beside a conversation view. It answers "who is waiting on me, who is busy, who is
stuck, who is done" without the user going and looking at each terminal, and then lets them
act on the answer in place: read the conversation, answer a permission prompt, type a reply,
pause the fleet, take a session over from the terminal that owns it.

## 2. The user and the problem

One user (James), one machine, **many concurrent agents** — typically five to fifteen Claude
Code and Codex sessions across several repos and git worktrees. The product exists because
that fleet has three failure modes, and all three are attention problems rather than agent
problems:

1. **Agents block silently.** A permission prompt is on screen in a window nobody is looking
   at, and the agent has been idle for twenty minutes for no reason.
2. **Attention thrash.** Checking on an agent used to mean jumping to its window, which loses
   the place in whatever was being done. The single hard rule of the UI is that *a click never
   moves the user between windows*.
3. **Budget.** A fleet burns a 5-hour or weekly usage window fast, and the moment that matters
   is the last 10% of it, when the useful question is "how many minutes do I have".

Read the product as a **fleet console for agents**, not as an IDE and not as a chat client.
Its competitor is a wall of terminal tabs.

## 3. Shape of the thing

- **One window, one tab, two panes, a draggable divider.** Left: the session table. Right: the
  conversation. They are one webview, deliberately, so neither can be closed or rearranged
  away from the other. An "own tab" escape hatch exists for watching one agent while browsing
  others.
- **Neither pane may assume it has the window.** The table folds columns below 720px measured
  *on the pane*; it is genuinely used at ~300px wide. Any feature proposal must survive a
  narrow pane.
- **Status has two tiers.** Hooks (installed into `~/.claude/settings.json`, opt-in) are
  ground truth — *Blocked on you* means a permission prompt genuinely exists. Transcript
  inference is the always-on fallback and renders with a hollow dot meaning *estimated*.
  Anything that claims certainty must say which tier it came from.
- **Sections.** The table groups rows: Pinned / Blocked on you / Waiting / Possibly stuck /
  Done / Busy / Paused / Ended / Archived, plus a second "sections" view for the user's own
  named groupings.

## 4. What exists today (capability inventory)

Use this to avoid proposing what already ships.

**Discovery and status** — Claude Code and Codex sessions, machine-wide, however started;
provider filter; hook-based exact status plus transcript fallback; per-turn ETA column
computed from the user's own turn-history percentiles; conversation Age (birth of the
conversation, across resumes); Model, Project, Worktree, Branch, PR columns; user-resizable
and hideable columns; empty (never-prompted) conversations hidden.

**Conversation** — live read of any session's transcript, markdown rendering, collapsed
thinking, per-tool cards, diffs with a real side-by-side diff editor, subagent sidecars,
backward paging, find-in-conversation, 6,000-char truncation with an explicit "show the rest".

**Interaction** — fully interactive sessions started in the app (Claude via the Agent SDK,
Codex via App Server), including a Global project for non-repo questions; a project dropdown
built from Claude Code's own `projects` map; type/interrupt/queue; streaming; slash commands;
permission-mode and model dropdowns sourced from the CLI's own model list; permission,
`AskUserQuestion` and plan cards answered in the pane; image paste; file drag-drop; `@`-file
mention from `git ls-files`; local dictation (ffmpeg + whisper.cpp, no audio leaves the box).

**Custody** — *Take over here* (ends the session's process elsewhere and resumes the same id
in the app), *Release* (hands it back to a terminal), *Close session* (ends the process,
parks the conversation), *Resume here* for ended sessions, auto-resume of the last session
after a reload.

**Budget** — pinned plan-usage cards (5-hour, 7-day, model-scoped week, extra credits) from
`GET /api/oauth/usage` with the Claude Code login token, polled every 60s and every 20s near
a limit, shared between windows via a cache file; **Pause all agents** via `SIGSTOP` to every
session on the machine, per-session pause from the row menu, pause state read from `ps` rather
than stored; auto-pause at a usage threshold (off by default, 98%).

**Organisation** — user nicknames (stored on our side, never written into Claude's files),
user-defined sections, pinning, archiving, hidden projects.

**Remote (experimental, off by default)** — Discord as a remote presentation layer only:
permission cards mirrored with Allow / Deny / Always-allow, "agent finished" notices,
auto-pause alerts. Redaction, an allowlist of Discord user IDs, an audit log, no inbound port,
and the agent never learns Discord exists. Questions and plan approvals are **not** mirrored
yet (`docs/plans/remote-questions-and-plans.md` is the proposal for that).

## 5. Design principles — the ones that decide arguments

These are the repo's actual precedents. A feature proposal that violates one needs to say so
explicitly and argue for it.

1. **Never steal attention.** No window jumps, no auto-focus, no auto-restart, no auto-reload.
   Quitting the app ends the live sessions it hosts, so the app never restarts itself; it says
   a restart is needed and leaves it to the user.
2. **Do not write into other tools' files.** Claude Code owns `~/.claude.json`,
   `~/.claude/sessions/*`, and the transcripts. Nicknames, removed projects and sections live
   on our side precisely because rewriting someone else's state to tidy our UI is not a trade
   worth making. The one exception is the hooks block in `settings.json`, which is merged,
   backed up, and removable.
3. **The conversation is the transcript.** That is why take-over, release and close are safe:
   ending a process parks a conversation rather than destroying it, and a resume appends to
   the same file under the same id.
4. **Never claim more certainty than the source gives.** Hollow dots for estimated status;
   "answered in Agent Wrangler" rather than guessing which way; a dash with a tooltip rather
   than a fake ETA.
5. **Never offer an action that cannot land.** Permission buttons render only while the
   request marker exists; remote buttons appear only for choices the local UI is already
   offering.
6. **Hiding information must not lose it.** A hidden column moves to the row's second line;
   truncated text gets a button, not an ellipsis.
7. **State that can be read from the OS is read, not stored.** Pause state is `ps` state `T`,
   which is why it is consistent across windows and needs no cleanup.
8. **The repo is public** (`hammonjj/AgentWrangler`). No real paths, prompts, session titles or
   transcript content in code, tests, fixtures, docs or commits.

## 6. Non-goals and standing constraints

- **No VSCode extension.** It existed and was deleted on 2026-09-22; the app is the only front
  end. Do not propose features that assume an editor host.
- **macOS only**, single machine, single user, single app instance. Multi-user, team,
  server-hosted or cloud-sync features are out of scope unless the scope itself is revisited.
- **Not an IDE.** File editing, terminal emulation and source control UI belong to the editor
  the user already has; Agent Wrangler opens a real diff editor and stops there.
- **No second permission system.** Remote control renders a decision the local UI already
  offers. Anything that would let something be approved remotely that is not approvable
  locally is out.
- **Local-first.** Dictation is local. The only outbound traffic is the usage endpoint and, if
  enabled, Discord.
- Providers are **Claude Code and Codex** behind one provider seam (`src/core/provider.ts`).
  A third provider is a plausible feature; provider-specific special cases in shared UI are not.

## 7. Known gaps and open threads (good places to look for features)

- Cross-session awareness: nothing today reasons about the fleet *as a fleet* — e.g. two agents
  editing the same repo or worktree, or one agent's PR conflicting with another's.
- History: ended sessions are windowed (48h, 50 sessions) and there is no search, analytics or
  retrospective across past conversations.
- Cost/usage is presented live but not attributed — no per-project or per-session spend.
- ETA and "possibly stuck" are the only progress signals; there is no notion of an agent's
  *goal* or how far through it is.
- Queueing/dispatch: the app can start a conversation in a project, but there is no backlog,
  no scheduling, no "run this when the usage window resets".
- Notification surface is toasts, the status bar bell and Discord; nothing on the phone
  natively, nothing summarised.

## 8. How to pitch a feature so it can be built here

A good proposal for this repo states, in order:

1. **The attention problem it removes** — what the user currently has to look at, remember or
   check by hand.
2. **Which status tier it depends on** (hooks / transcript inference / OS / our own state),
   and what it degrades to when that source is missing.
3. **Where it lives in the two-pane window**, and how it behaves in a 300px pane.
4. **Whose files it touches.** If the answer is Claude Code's or Codex's, expect a hard no
   unless it is additive and removable.
5. **What it does when it is wrong** — the repo consistently prefers erring toward "waiting"
   / "estimated" / "do nothing" over a confident mistake.
6. **Whether it can be off by default.** Anything reaching outside the machine, spending
   tokens, or acting on the fleet without a click should be.

Sizing note for planning: anything larger than one sitting gets its own git branch **and**
worktree, because several agents work this repo at once. That is a real constraint on how
features are sliced — prefer slices that land independently.

## 9. Vocabulary

*Session* — one agent conversation, identified by its transcript. *Provider* — Claude Code or
Codex. *Hook-backed* vs *estimated* — the two status tiers. *Runner-owned* — a session whose
process this app started or adopted (the app can type into it); everything else is read-only
plus hook-answerable. *Adopt / take over* — end a session's process elsewhere and resume the
same id here. *Release* — the reverse. *Blocked on you* — a permission prompt is genuinely
open. *Waiting* vs *Done* — both idle; Waiting means the last reply asked something.
*Pane* — either half of the workbench window. *Workbench* — the one shipped webview bundle.

# Agent Wrangler — product context for an agent

Briefing document for a product-owner / planning agent that proposes features but does not
write the code. Everything here is fact as of 2026-10-03 (browser-only architecture, epic #121). `README.md` is the behavioural
source of truth; `docs/plans/*.md` holds the active and proposed designs. Where this file
and those disagree, they win.

---

## 1. What it is, in one paragraph

Agent Wrangler is a background service on one Mac (the **core daemon**, a LaunchAgent) that
watches **every AI coding-agent session on that Mac** — Claude Code and Codex, started
anywhere: an editor, an iTerm tab, another agent's subprocess, or Agent Wrangler itself — and
serves a **web workbench**: a live table beside a conversation view, opened in a browser on the
Mac or on a paired phone or laptop on the home network. It answers "who is waiting on me, who
is busy, who is stuck, who is done" without the user going and looking at each terminal, and
then lets them act on the answer in place: read the conversation, answer a permission prompt,
type a reply, pause the fleet, take a session over from the terminal that owns it.

There is no desktop window: the VSCode extension went on 2026-09-22 and the Electron app in
#142. The Mac is the **execution host** (agents, tools, repositories and any app an agent
drives run there); browsers are **clients** that render and send commands and never run agent
work. Design: `docs/plans/browser-workbench.md`.

## 2. The user and the problem

One user (James), one machine, **many concurrent agents** — typically five to fifteen Claude
Code and Codex sessions across several repos and git worktrees. The product exists because
that fleet has three failure modes, and all three are attention problems rather than agent
problems:

1. **Agents block silently.** A permission prompt is on screen in a window nobody is looking
   at, and the agent has been idle for twenty minutes for no reason.
2. **Attention thrash.** Checking on an agent used to mean jumping to its window, which loses
   the place in whatever was being done. The single hard rule of the UI is that *a click never
   moves the user between windows*: it acts in the browser tab it was made in.
3. **Budget.** A fleet burns a 5-hour or weekly usage window fast, and the moment that matters
   is the last 10% of it, when the useful question is "how many minutes do I have".

Read the product as a **fleet console for agents**, not as an IDE and not as a chat client.
Its competitor is a wall of terminal tabs.

## 3. Shape of the thing

- **One page, two panes, a draggable divider.** Left: the session table. Right: the
  conversation. They are one web page, deliberately, so neither can be closed or rearranged
  away from the other. Routes in the page's bar: Agents, Missions, Analytics, Preferences. A
  second browser tab is the way to watch one agent while browsing others.
- **Phones are first-class.** Below a breakpoint the page shows one pane at a time with a Back
  button, 44px touch targets and long-press for row menus. Any feature proposal must work on a
  phone or say why it is Mac-only.
- **Neither pane may assume it has the page.** The table folds columns below 720px measured
  *on the pane*; it is genuinely used at ~300px wide. Any feature proposal must survive a
  narrow pane.
- **Several clients at once.** Two tabs, a phone, Discord and `aw` can all act on one session.
  Approvals go through one server-side path, the first answer wins, and a late one is told it
  was already answered. Prompts and navigation go to the client whose click caused them.
- **Status has two tiers.** Hooks (installed into `~/.claude/settings.json`, opt-in) are
  ground truth — a row shown as stopped at a permission prompt means one genuinely exists. Transcript
  inference is the always-on fallback and renders with a hollow dot meaning *estimated*.
  Anything that claims certainty must say which tier it came from.
- **Sections.** The table groups rows: Pinned / Waiting / Possibly stuck / Done / Busy /
  Paused / Ended / Archived, plus a second "sections" view for the user's own named
  groupings (everything starts in *Uncategorized*). *Waiting* holds both the `blocked`
  and `waiting` statuses — one instruction, one heading — with permission prompts sorted
  to the top of it.

## 4. What exists today (capability inventory)

Use this to avoid proposing what already ships.

**Discovery and status** — Claude Code and Codex sessions, machine-wide, however started;
provider filter; hook-based exact status plus transcript fallback; per-turn ETA column
computed from the user's own turn-history percentiles; conversation Age (birth of the
conversation, across resumes); Model, Project, Worktree, Branch, PR columns; user-resizable
and hideable columns; empty (never-prompted) conversations hidden.

**Conversation** — live read of any session's transcript, markdown rendering, collapsed
thinking, per-tool cards, edits as inline diffs, subagent sidecars,
backward paging, find-in-conversation, 6,000-char truncation with an explicit "show the rest".

**Interaction** — fully interactive sessions started in the app (Claude via the Agent SDK,
Codex via App Server), including a Global project for non-repo questions; a project dropdown
built from Claude Code's own `projects` map; type/interrupt/queue; streaming; slash commands;
permission-mode and model dropdowns sourced from the CLI's own model list; permission,
`AskUserQuestion` and plan cards answered in the pane; image paste; file attach and drop
(uploaded to the Mac from a remote device); `@`-file mention from `git ls-files`; a folder
browser of the Mac's folders; an in-browser file viewer with download; dictation recorded in
the browser and transcribed on the Mac with whisper.cpp (no audio leaves the user's devices).

**Custody** — *Take over here* (ends the session's process elsewhere and resumes the same id
in Agent Wrangler), *Release* (stops running it and shows the `claude --resume` command to run
in a terminal), *Close session* (ends the process, parks the conversation), *Resume here* for
ended sessions, auto-resume of the most recently interrupted session when the daemon starts.

**Lifecycle** — the core runs in the **core daemon** (`aw daemon start|stop|status`), which
keeps running with no browser open; closing every tab stops nothing. Claude conversations run
in **session hosts** (one small detached process each; since #122 the only way, with no
setting): they survive a daemon stop, a crash and a reinstall, reattach when the daemon starts,
move to the new build on their next idle message, and are parked after *End idle sessions with
no Agent Wrangler connected after* (default 24 h) while the daemon is stopped.
`aw daemon stop --all` ends them; a logout or reboot does too. Codex threads run in one
background `codex app-server` and survive the same way. A crashed host's orphaned `claude` is
found and ended before its session resumes. Security is same-user: hosts keep other users out
and make accidental use hard, but a process running as the user can drive them (README,
*Stopping and coming back*).

**Access** — loopback (`127.0.0.1:7391`) by default, with a single-use sign-in link
(`aw web open`); the home network only by opt-in, over HTTPS from a local CA, with each device
paired (`aw web pair`) and revocable. Never the internet: no public URL, port forwarding or
relay. One user (the `local-owner` principal); every action passes one `authorize()` check and
is audited by id. Accounts are a documented future, not built (plan §9).

**Budget** — pinned plan-usage cards (5-hour, 7-day, model-scoped week, extra credits) from
`GET /api/oauth/usage` with the Claude Code login token, polled every 60s and every 20s near
a limit, read once by the daemon for every client; **Pause all agents** via `SIGSTOP` to every
session on the machine, per-session pause from the row menu, pause state read from `ps` rather
than stored; auto-pause at a usage threshold (off by default, 98%).

**Organisation** — user nicknames (stored on our side, never written into Claude's files),
user-defined sections, pinning, archiving, hidden projects.

**Remote (experimental, off by default)** — Discord as a remote presentation layer only:
permission cards mirrored with Allow / Deny / Always-allow, "agent finished" notices,
auto-pause alerts, and questions and plan approvals for conversations Agent Wrangler runs.
Redaction, an allowlist of Discord user IDs, an audit log, no inbound port, and the agent
never learns Discord exists. It runs inside the core daemon, so it works after a reboot with no
browser open. Discord is the away-from-home channel; at home a paired phone has the whole
workbench.

## 5. Design principles — the ones that decide arguments

These are the repo's actual precedents. A feature proposal that violates one needs to say so
explicitly and argue for it.

1. **Never steal attention.** No window jumps, no auto-focus, no auto-restart. Agent
   Wrangler never restarts itself; it says a restart is needed and leaves it to the user (an
   install restarts the daemon onto the new build, and open tabs reload onto it). A restart is
   cheap, not forbidden: conversations in session hosts and Codex threads survive a daemon
   restart, a crash and a reinstall, so for them it costs a moment's reconnect. Principle 3 is
   why.
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
   which is why it survives restarts and needs no cleanup.
8. **Work runs on the execution host; clients only show and ask.** A path is a path on the Mac,
   an upload lands on the Mac, an app an agent drives stays on the Mac's screen. A browser
   client never executes agent work, and a paired device never acts on the Mac's desktop.
9. **Remote access is opt-in and local.** Loopback by default; the home network only after an
   explicit switch, over TLS, with per-device pairing; never the public internet.
10. **The repo is public** (`hammonjj/AgentWrangler`). No real paths, prompts, session titles or
    transcript content in code, tests, fixtures, docs or commits.

## 6. Non-goals and standing constraints

- **The browser workbench is the only front end.** The VSCode extension was deleted on
  2026-09-22 and the Electron app retired in #142. Do not propose features that assume an
  editor host, a native window, a menu bar or a Dock icon (a native helper was considered and
  dropped, decision D4).
- **macOS only**, one execution host, one user, one core daemon. Multi-user, team,
  multi-host, server-hosted or cloud-sync features are out of scope unless the scope itself is
  revisited (accounts are sketched as a future in `docs/plans/browser-workbench.md` §9).
- **No internet exposure.** No public URL, port forwarding, relay, native mobile app, or remote
  desktop / app streaming. Agents never run tools on client devices.
- **Not an IDE.** File editing, terminal emulation and source control UI belong to the editor
  the user already has; Agent Wrangler shows diffs and files and stops there.
- **No second permission system.** Remote control renders a decision the local UI already
  offers. Anything that would let something be approved remotely that is not approvable
  locally is out.
- **Local-first.** Dictation is transcribed on the Mac. The only outbound traffic is the usage
  endpoint and, if enabled, Discord.
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
- Notification surface is browser notifications in open tabs, a plain Mac notification when
  no tab is open (clicking it does nothing), and Discord. Nothing reaches an iPhone outside
  Discord (web notifications there need a Home Screen web app, not built), and nothing is
  summarised. The tab title does not carry an attention count yet (D4 planned one).
- Browser gaps left by the Electron retirement: no side-by-side diff view, no live dictation
  preview, no "conversation in its own tab", and no controls for refreshing, restarting the
  Codex server or removing hooks.

## 8. How to pitch a feature so it can be built here

A good proposal for this repo states, in order:

1. **The attention problem it removes** — what the user currently has to look at, remember or
   check by hand.
2. **Which status tier it depends on** (hooks / transcript inference / OS / our own state),
   and what it degrades to when that source is missing.
3. **Where it lives in the two-pane page**, how it behaves in a 300px pane and on a phone, and
   whether it needs the Mac itself (a loopback browser) or works from a paired device.
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
process Agent Wrangler started or adopted (it can type into it); everything else is read-only
plus hook-answerable. *Adopt / take over* — end a session's process elsewhere and resume the
same id here. *Release* — the reverse. *Blocked* — the internal status for "a permission
prompt is genuinely open"; on screen it reads *Waiting*, like the status of the same name.
*Waiting* vs *Done* — both idle; Waiting means the agent wants something from you.
*Pane* — either half of the workbench page. *Workbench* — the web page the core daemon serves
(the one shipped browser bundle). *Core daemon* — the LaunchAgent that owns all state.
*Execution host* — the Mac it runs on. *Client* — any browser showing the workbench, `aw`, or
Discord. *Device* — a browser holding a paired credential.

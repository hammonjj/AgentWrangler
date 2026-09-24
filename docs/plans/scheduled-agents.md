# Scheduled agents — research task

**Status:** proposed (2026-09-23). Research spike, not a build plan. The output of this task is a
recommendation (§5) and a sliced build plan that replaces this file. Nothing here is decided yet.

Fills the gap `product-context.md` §7 names: "there is no backlog, no scheduling, no 'run this
when the usage window resets'". Two concrete use cases drive it; the research should be judged on
whether it gets both of them running, not on how general the scheduler is.

---

## 1. The attention problem

Both use cases are things James currently has to *remember to do* at the start of the day:

- go and find the PRs that are waiting on his review, and then actually review them;
- piece the day together from a calendar, an inbox and a few other places, and not forget
  something that was mentioned once.

Today the app can start a conversation in a project when clicked. It cannot start one at a time,
on a trigger, or without James in front of it.

## 2. Use case A — morning PR review sweep

**Want:** early each weekday, an agent checks the two work repos (frontend and backend — repo list
is configuration, never hard-coded) for PRs where:

- James is a **requested reviewer** (personally — team requests are an open question, §4),
- he has **not yet reviewed** the current state of the PR,
- the PR is **open and not merged** (drafts: open question).

For each one, the agent performs the review. Then, **when the author responds** — pushes new
commits and/or re-requests review — the next sweep reviews it again, looking at what changed since
the last review rather than starting over.

What the research needs to pin down:

1. **Discovery.** The `gh` query that returns exactly this set (`review-requested:@me`,
   `is:open`, per repo), and how "not yet reviewed" is decided. Proposal to test: record the PR
   head SHA each review was done against; a PR needs review when it is requested of James and its
   head SHA differs from the last one reviewed, or when review is re-requested.
2. **Where that record lives.** Our side (app state dir), per the "do not write into other tools'
   files" principle — not a label or comment on the PR used as a database.
3. **The review itself.** Reuse the existing `code-review` skill rather than a new prompt. The
   work repos already have their own review conventions and a bot reviewer; the agent must follow
   the repo's process skill, not invent one.
4. **What lands on GitHub, and under whose name.** This is the product decision that matters most:
   a review posted by the agent appears as James to his colleagues. Options, from safest:
   (a) review is written locally and shown in the app, James posts it;
   (b) posted as a **pending/draft review** James submits;
   (c) posted as a comment-only review;
   (d) full review including approve / request-changes.
   Recommendation to argue for or against: default (b), never (d) without a click.
5. **Re-review scope.** Diff from the last-reviewed SHA to the new head, plus whether earlier
   comments were addressed.
6. **Runs in a worktree.** Each PR review checks out into its own worktree so it never touches a
   tree James or another agent is working in.

## 3. Use case B — daily brief

**Want:** each morning, an agent reads James's calendar, email and a short **whitelist** of other
sources, and delivers a **half page to one page** summary of the day so nothing is forgotten:
meetings (with what to prepare), things due, things people are waiting on him for, anything
flagged in mail.

What the research needs to pin down:

1. **Sources and how they are reached.** Calendar and mail via the claude.ai connectors (Google
   Calendar, Gmail, Microsoft 365 — which one is the real calendar/inbox?) or via local macOS
   data (Calendar.app / Mail.app). Candidate whitelist extras: Slack, meeting-notes tools, GitHub
   (open PRs / assigned issues, which overlaps use case A — the brief could include A's results).
2. **The whitelist mechanism.** An explicit allowlist of tools/connectors the brief agent may call,
   enforced by the permission layer (allowed tools list), not by the prompt asking nicely. Read-only
   tools only; the brief agent never sends mail, accepts invites or posts anything.
3. **Existing prior art.** There is already a `morning` skill that renders a morning brief and can
   set itself up as a recurring weekday task. Evaluate it first: if it covers the brief, this use
   case becomes "schedule and deliver it", not "build it".
4. **Delivery.** Where the page shows up: a pinned conversation in the app (the brief *is* the
   transcript — fits principle 3), a notification pointing at it, Discord (already wired, but
   redaction rules would gut a brief), a file, or email-to-self. Needs to be readable in a 300px pane.
5. **Length discipline.** How to hold it to one page — format spec and a hard word budget in the
   prompt, verified against a week of real days before shipping.

## 4. Cross-cutting questions — scheduling and agent calls

**Where the schedule runs** — the central research question. Candidates:

| Option | Runs when laptop is asleep / app closed? | Access to local repos, worktrees, local tools | Notes |
|---|---|---|---|
| In-app scheduler (timer in the main process, starts an Agent SDK / Codex session) | No — needs the app open and the machine awake | Yes | Session appears in the table natively; simplest to show and answer. |
| macOS `launchd` agent running headless `claude -p` / Agent SDK script | Can wake via `pmset` schedule; no app needed | Yes | App would discover the session like any other. Must not restart the app. |
| Claude Code cloud routines (`/schedule`, remote triggers) | Yes | No local tree; clones from GitHub; connectors available | Good fit for B and possibly A; results live outside the app. |

The research should answer, per use case, which one fits, and what happens on a missed run
(machine asleep at 6am): run on wake, skip, or run once late and say so.

**Agent calls.** How a scheduled job starts a session: reuse the existing runner path that the
"new conversation in project" action uses, with a stored prompt, model and permission mode. Which
permission mode a job with nobody watching runs in, and what happens when it hits a permission
prompt at 6am (it should wait visibly in *Waiting*, not be auto-approved).

**Budget.** A sweep that reviews six PRs is not free. Interaction with the usage cards and
auto-pause: skip or defer a run when the 5-hour window is above a threshold; never start a
scheduled job while the fleet is paused.

**Product rules that apply** (from `product-context.md` §5 and §8):

- Off by default; each job enabled explicitly.
- Anything leaving the machine (posting to GitHub, reading mail through a connector) is
  per-job opt-in and says so in the UI.
- Scheduled runs never focus the window or restart the app.
- Wrong should mean "did nothing and said so", not "posted something".
- Public repo: job prompts, repo names, and brief contents are user configuration and never
  land in code, fixtures or docs.

Open questions for James (answer before the build plan):

- A: team review requests too, or only personal? Drafts in or out? Which of 4(a)–(d)?
- A: what time, and weekdays only?
- B: which calendar and inbox are the real ones, and what else is on the whitelist?
- B: where do you want to read the brief — in the app, on the phone, or both?

## 5. Deliverable

A short write-up answering §2–§4, with a recommended scheduling option per use case, then a
replacement of this file with a build plan sliced so each slice lands independently, e.g.:

1. Job model + in-app scheduler + "run now" (no triggers beyond time).
2. Use case B on top of it (lowest risk: read-only).
3. Use case A in local-only mode (review shown in app, 4(a)).
4. Use case A posting pending reviews to GitHub, 4(b).

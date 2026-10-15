# Scheduled agents: build plan

**Status:** building, 2026-10-15 (epic #164). Slices 1 and 2 are in (`src/shared/scheduledJobs.ts`, `src/app/scheduledJobs.ts`, the Jobs view). Recommendation written 2026-10-14 (#3). Replaces the research brief. The open
product questions in §6 have a proposed default each; slices 1 and 2 do not depend on the answers.

Fills the gap `product-context.md` §7 names: "no scheduling". Two use cases drive it, and the plan
is judged on whether both run, not on how general the scheduler is:

- **A. Morning PR review sweep.** Early each weekday, review open PRs where the user is a requested
  reviewer and has not reviewed the current head; review again when the author responds.
- **B. Daily brief.** Each morning, read calendar, mail and a whitelist (read-only) and deliver a
  half-page to one-page summary.

## 1. Recommendation

| | Scheduling option | Why |
|---|---|---|
| Both | **In-app scheduler in the core daemon** | The core is already a LaunchAgent (`RunAtLoad`, `KeepAlive`) that is up whenever the user is logged in. It already has the runner path, worktrees, the table, approvals, usage cards, pause and a wake detector (`sleepWatcher.ts`). A job's session appears in the table like any other and its permission prompts wait in *Waiting*. |
| A | Same | Needs local repos, worktrees and the `code-review` skill; cloud routines have no local tree. |
| B | Same, with a later option to move to a cloud routine | Connectors are reachable from the local runner. A cloud routine would run while the Mac is off, but its result would live outside the app and could not use the app's approval path. Revisit only if "Mac asleep at 6am" turns out to matter. |

Rejected: a separate `launchd` calendar job running headless `claude -p`. It would bypass the
runner, the approval path (`approvals.ts`) and `authorize()`, and the session would only be
discovered as a foreign row. Cloud routines for A: no local tree, and posting would go around the
one approval path.

## 2. Missed runs and sleep

The daemon cannot run while the Mac sleeps, and the plan does not add a `pmset` wake (it would be a
system-level side effect the user did not ask for). Each job has a window, `time` plus `catchUpHours`
(default 4). On start or wake (`watchForSleep`), a job whose slot passed inside its window and has
not run today runs once, and the run is labelled "late" in the table. Outside the window the slot
is skipped and the job's history says "missed". Never run twice for one slot.

## 3. How a job starts a session

- A **job** is stored by the daemon (app state dir, not a project file): id, kind, cron-like
  weekday/time, enabled (default off), provider, model, effort, permission mode, folder, prompt
  template, allowed-tools list, per-job `leavesMachine` flags.
- A run goes through the same path as "new conversation in project" (`sessions.launch` with
  `LaunchDefaults.request`), with the job's overrides. It is a normal session: no window focus,
  no daemon restart.
- **Permission mode:** never bypass. Default is the app's `auto` mode with an explicit allowed-tools
  list for the job. A prompt that is not covered waits in *Waiting* and reaches the user through the
  existing notification channels; it is never auto-approved. Reaching a phone is the remote-control
  epic's job (#112); this plan only emits the same pending-action event.
- **Budget:** admission reuses the scheduler's rules (#45): skip a run when any usage window is
  above the job's threshold (default: the auto-pause percent), and never start while the fleet is
  paused. A skipped run is recorded with the reason, and a catch-up window can still pick it up
  later.
- **Visibility:** each run records slot, start, outcome (`ran`, `late`, `skipped:<reason>`,
  `missed`, `failed`) and the session id. "Wrong means did nothing and said so."

## 4. Use case A: PR sweep

- **Discovery:** `gh search prs --review-requested @me --state open` per configured repo (repo list
  is configuration), cross-checked with `gh api notifications` for team requests, as the user's
  `pr` skill does, because the search misses team-only requests.
- **Needs review when:** requested of the user and head SHA differs from the last reviewed SHA, or
  review was re-requested. The record (`prKey -> lastReviewedSha, reviewId`) lives in the daemon's
  state dir, not as a label or comment on the PR.
- **Review:** one session per PR, in its own worktree (`gh pr checkout` into `AgentWrangler.aw`-style
  tree, removed after), using the repo's own review process skill and the `code-review` skill. The
  re-review prompt carries the diff from the last reviewed SHA to the new head and asks whether
  earlier comments were addressed.
- **What lands on GitHub:** slice 3 writes the review locally and shows it in the app (option a).
  Slice 4 adds a **pending review** the user submits (option b). The agent never approves or
  requests changes; that stays a click. Posting is per-job opt-in and says so in the UI.

## 5. Use case B: daily brief

- The existing `morning` skill renders a brief as an HTML artifact and can set itself up as a
  weekday task. Evaluated: it covers composition, but its schedule runs in Claude's own task system
  and its output is not a session in the table. Reuse its prompt and format as the job's template,
  and let this scheduler run and deliver it.
- **Whitelist:** an allowed-tools list on the job, enforced by the permission layer: read-only
  calendar, mail and Slack tools plus read-only `gh`. No send, accept or post tool is on the list.
- **Delivery:** the brief is the transcript of a pinned conversation (readable in a 300px pane),
  plus a notification that points at it. Discord is out: the redaction rules would gut a brief.
- **Length:** a hard word budget and a fixed section order in the prompt, checked against a week of
  real runs before it is enabled by default.
- Brief can include A's results when both ran the same morning (later; not a slice).

## 6. Open product questions and proposed defaults

| Question | Default used by the slices |
|---|---|
| A: team requests, drafts? | Personal and team requests, labelled; drafts excluded |
| A: what posts under the user's name? | (a) local only, then (b) pending review; never approve or request changes |
| A: time, weekdays? | 07:30, Monday to Friday, `catchUpHours` 4 |
| B: which calendar and inbox? | Microsoft 365 (Outlook calendar and mail), answered 2026-10-15 |
| B: where to read? | In the app first; phone comes with #112 |

## 7. Slices

Each slice lands on its own. Tickets are filed under #164.

| # | Slice | Depends on |
|---|---|---|
| 1 | Job store, schedule evaluation (pure function with tables and a fake clock), runner hook, run history, catch-up on wake, "Run now". Off by default. | none |
| 2 | Jobs view in the workbench: list, enable, edit, history, and the allowed-tools editor | 1 |
| 3 | Daily brief job (use case B): template from the `morning` skill, whitelist, pinned conversation, notification | 1 |
| 4 | PR sweep discovery and the reviewed-SHA ledger (no review yet): shows what it would review | 1 |
| 5 | PR sweep review, local-only: worktree per PR, review shown in the app, re-review from the last SHA | 4 |
| 6 | PR sweep posts a pending review the user submits (per-job opt-in) | 5 |

Rules that apply to every slice: off by default; anything leaving the machine is a per-job opt-in;
no window focus and no restart; job prompts, repo names and brief contents are user configuration
and never land in code, fixtures or docs.

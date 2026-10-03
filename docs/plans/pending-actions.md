# Pending actions: Merge locally, and every other slow button

Date: 2026-10-02. Covers the Merge locally pending-state fix and an audit of every async action
button in the app. Merge permissions, verification, review gates and approval policy are
unchanged. This changes when a button is off and what it says, and it stops a click from running
twice. It does not change what any finish does.

## 1. What was wrong with Merge locally

- **The click showed nothing.** A gated merge (§13.3 step 5, #46) runs the repository's gate on
  the merged result before the base moves, so it can take minutes. For that whole time the
  mission stayed in `review` and all four finish buttons stayed enabled.
- **A second click was queued, not refused.** `TaskRunner.queue()` serialises work per mission.
  A second Merge, or a Discard confirmed meanwhile, therefore waited for the first. When the
  first had already merged, the second failed with "The mission is not waiting for review." The
  user saw a red error under a mission that had done what they asked.
- **A crash or fault lost the operation.** Nothing recorded that a finish had started. The
  dangerous window is after the base moved but before the result was recorded. A fault there
  left the mission in `review` with its buttons enabled, which invited a second merge.

## 2. The pattern

There are four layers. Each layer covers a gap the layer above it cannot.

| Layer | Where | What it does | Why the layer above is not enough |
|---|---|---|---|
| Pane | `PendingActions` (`src/shared/pendingActions.ts`), held in `MissionsUiState.pending` | On click, `begin(key, label)` returns a request id. If the same key is already in flight it returns `undefined`, and the click sends nothing. The button is drawn busy (`Merging…`, `aria-busy`), and the mission's other slow actions are blocked. | This layer is first, so it is the only one that responds before any message reaches the host. |
| Host acknowledgement | `mission{requestId}` → `DashboardHost.runMission` → `missionAck{requestId}` (and `missionError{requestId}`) | Every request that carries an id is answered once, however it ended. This includes a cancelled confirm dialog. The ack is sent after the snapshot that shows the outcome. | Without an answer, the pane could only guess when to re-enable a button. |
| Host state | `TaskRunner.finishingOf()` → `MissionView.finishing` | Every snapshot says whether a finish is under way (`{ how }`), or was cut off and has not been read back yet (`{ how, uncertain }`). | Pane state is lost on a pane reload and does not exist on another surface. Host state survives both. |
| Core | `TaskRunner.finishMission` and `pendingFinish` | Removes duplicates, writes a record before git runs, and reads the outcome back from git (§3). | A disabled button is a courtesy, not a guarantee. The core is the only layer every caller goes through. |

Rules:

- **The button stays focusable.** A busy or blocked button uses `aria-disabled="true"`, not
  `disabled`, so it keeps keyboard focus. `clickIntent` refuses an `aria-disabled` button.
- **Focus survives a repaint.** `paint()` puts focus back on the element with the same `data-fk`
  after each re-render.
- **Status is announced.** A `role="status" aria-live="polite"` line announces "Merging…".
  Failure and uncertain lines use `role="alert"`.
- **Narrow panes work.** The finish line is `flex-basis: 100%`, so at about 300 px it takes its
  own row under the wrapped buttons. The spinner stops under `prefers-reduced-motion`.
- **No button stays off on the pane's word alone.** The pane forgets a request the host never
  answered after 10 minutes. A finish that really is still running stays off anyway, because the
  host's `finishing` state keeps it off.
- **Scope of a pending key.** Keys are `mission:<id>:<action>`. While one is in flight, that
  mission's other slow actions are blocked. Other missions, the header toggle, opening a task's
  conversation, Open diff and Policy… stay usable.

## 3. Merge locally, step by step

1. **The click.** The pane marks `mission:<id>:finish:merge-local` busy and posts
   `mission{op: finish, requestId}`.
2. **The core registers the finish.** `finishMission` records the finish in the in-memory
   `finishing` map and fires a change straight away, before the mission's queue has started.
   Every surface now shows the mission as Merging.
3. **Repeated or conflicting requests.** These are decided before the queue:
   - The same finish again (double click, keyboard repeat, another surface, a replayed message)
     gets the **same promise**. At most one merge happens.
   - A different finish (Open a PR, Keep, Discard) is refused with "Merge is already under way
     for this mission".
   - The same finish after it completed gets the completed mission back, and nothing runs again.
4. **Write-ahead.** Inside the queue, before git is touched, the core saves `pendingFinish`:
   - `id`, `how`, `at`, `branch`;
   - `branchTip`, the tip of the branch being merged. Read-back needs it because a merge that
     went through deletes the branch during tidy-up;
   - `into` and `baseTip`, the base branch and its tip when the finish began.
5. **The finish runs** exactly as before. That is the plain `--no-ff` merge, or the gated merge
   with the repository's gate. Permissions, refusals and gates are untouched.
6. **The outcome.**

   | What happened | Record | Buttons | Shown |
   |---|---|---|---|
   | Success | `pendingFinish` cleared and the mission moved to `completed` in **one write** | Gone (mission finished) | The flash, plus "Merged at …" |
   | Refused or undone by the finisher (dirty checkout, wrong branch, conflict aborted, gate failed, base moved) | `pendingFinish` cleared; `finishFailure {how, why}` recorded | Back | "Merge locally did not go through. <reason>" (`role="alert"`), beside the buttons. It survives a restart and is cleared by the next finish. |
   | Any other error, including one after the base moved | Read back from git (step 7) | Depends on the read-back | Depends on the read-back |
   | Success, but the record could not be written | Read back from git. If it still cannot be written, the record on disk still says under way. | Off | Recovery completes it on the next start |

7. **Read-back** (`MissionFinisher.reconcileMerge`):
   1. First, put back anything AW left half-done:
      - abort a merge in the integration worktree and put that worktree back on the mission
        branch;
      - abort a merge in the primary checkout, but only when `MERGE_HEAD` is this branch's tip.
        Anything else in progress there belongs to the user.
   2. Then check whether `branchTip` is an ancestor of `into`:
      - **Yes:** the merge happened. The merge commit is the first-parent merge since `baseTip`
        whose parents include `branchTip`. The mission completes, with "(confirmed from git
        after an interruption)".
      - **No:** the merge did not happen. The record is cleared, the failure says it was
        interrupted, and the buttons come back.
      - **Cannot tell** (git would not run, or the branch is gone and no tip was recorded): the
        record stays, marked `uncertain`, and **the buttons stay off**. The mission shows
        "Could not confirm whether the merge went through: …" and a **Check again** button
        (`recheck-finish`). Its phase is `needs-you`.
   3. Open a PR is read back with `gh pr list --head <branch> --state all`. "Not opened" is
      returned only when `gh` actually answered.
   4. Keep and Discard touch nothing outside AW's own worktrees. When cut off, they are cleared
      and can be picked again.
8. **Restart.** `recoverMission` settles `pendingFinish` **before** the worktree pass. That pass
   would otherwise mark a gated merge's integration tree as missing, because the tree is left
   detached mid-merge. Until the record is settled, the view reads it from the record, so the
   buttons are off from the first paint.
9. **Phase.** While a finish is under way the mission's phase is `verifying` ("Merging…"). That
   is activity, so it is not counted as needing the user. An uncertain outcome is `needs-you`.

Regression tests:

- `test/orchestration/missionFinishPending.integration.test.ts` (real git) covers:
  - immediate core state;
  - joining a duplicate request and refusing a conflicting one;
  - write-ahead on disk before the base moves;
  - a replay after completion;
  - a refusal with its reason and the buttons back;
  - an error after the base moved (read back as merged, with no second merge);
  - a failed record write after the merge, then a restart (recovery completes it, with one merge
    commit);
  - a restart before the base moved (read back as not merged, tree put back, merge works once);
  - git unavailable (uncertain, everything refused, Check again settles it);
  - read-back of a half-made plain merge, of a merge whose branch was deleted, and of `gh`.
- `test/orchestration/finishPendingUi.test.ts` covers:
  - `PendingActions` and `pendingKeyOf`;
  - the busy, blocked and uncertain rendering, plus the failure rendering and the live region;
  - host state surviving the pane forgetting, and state read from the record after a restart;
  - other missions not being affected.

## 4. Audit: every async action button

Done read-only across `src/webview/**`, `src/ui/**` and `src/app/createApp.ts`, before this
change. "Now" is the verdict after it.

Column key:

- **Latency:** instant / <1s / s (seconds) / min (minutes).
- **Ack:** whether anything shows between the click and the host's reply.
- **Pending:** whether the button is off or relabelled while the action runs.
- **Dup:** what a second press does.
- **Truth:** what decides whether the button is enabled.

### 4.1 Missions view (`src/webview/dashboard/missions.ts`)

| Control | Latency | Ack | Pending | Dup | Feedback | Truth | Recovery | Was | Now |
|---|---|---|---|---|---|---|---|---|---|
| Merge locally | s–min (gate) | none | none | queued, then spurious "not waiting for review" | flash / `missionError` | `review.finishes` | click again | gap (large) | **fixed**: all four layers (§3) |
| Open a PR | s (push + `gh`) | none | none | as above | flash, opens URL | same | click again | gap (large) | **fixed**: same record, read back from `gh` |
| Keep / Discard | s (tidy) | Discard: modal | none | queued; Discard confirmable during a merge | flash | same | click again | gap (large) | **fixed**: blocked while any finish runs; core refuses a conflicting finish |
| Check again (new) | s | busy | busy | pane key + core joins the finish under way | flash / `missionError` | `finishing.uncertain` | click again | — | compliant |
| Approve and start / Run task | s (worktree + launch) | none | state flips at the end | refused in queue ("not waiting for approval") | flash | `canApprove`, `canRunProposal` | — | gap (small) | **fixed** (pane): "Starting…", siblings blocked until ack |
| Cancel mission | s | modal | none after confirm | modal blocks | — | `canCancel` | — | compliant | busy "Cancelling…" until ack |
| Pause / Pause now / Resume | <1s–s | none | state flip | refused | flash | `canPause`, `canResume` | — | compliant | busy until ack |
| Plan again… / Replan… / Write it myself | prompt, then the planner runs in the background | palette | `planning` text | refused | `mplanning` | `canPlanAgain`, `canReplan`, `canWritePlan` | — | compliant (a cancelled prompt had no signal) | busy until ack, which now also follows a cancelled prompt |
| Task Accept / Retry / Resume / Skip / Recreate worktree / Cancel | s–min (parallel accept integrates and verifies) | none | none | queued, then refused after success | `missionError` | `tasks[].actions` | — | gap (large) | **partly fixed**: pane busy plus siblings blocked until ack. Core dedupe is follow-up F1 |
| Task Open diff / Policy… | instant | editor / palette | n/a | opens twice | — | — | — | compliant | unchanged (never blocked) |
| Plan editor ↑ ↓ Split Delete + Add task, fields | <1s | none | none | Add and Split run twice | snapshot | `editable` | undo by editing | gap (small) | follow-up F7 |
| + New mission | palette | palette | `planning` | palette replaces itself | — | — | — | compliant | unchanged |

### 4.2 Conversation pane (`src/webview/conversation/main.ts`, `common/delegationOffer.ts`)

| Control | Latency | Ack | Pending | Dup | Feedback | Truth | Verdict |
|---|---|---|---|---|---|---|---|
| Send / Cancel queued send | s | "Cancel queued send", composer read-only, `sendResult{requestId}` | yes | pane `pendingSend` plus host "Another send is pending." | note; draft kept on error | `sendResult` | compliant |
| Stop (interrupt) | <1s–s | none | label stays "Stop" | harmless | composer push | `composer.busy` | gap (small), F8 |
| Take over / Resume here | s | modal | `disabled` is undone by the next session push | host `adopting` set ignores it silently | `dialogs.error` | caps | gap (small), F4 |
| Release | s | modal | none after confirm | second run finds no runner | `dialogs.error` | caps | gap (small), F4 |
| Install status hooks (banner) | s | modal | none after | a second modal can queue | dialogs | caps | gap (small), F8 |
| Permission Allow / Always / Deny; question Answer; plan Approve / Request changes | <1s | buttons disabled | yes | host stale or gone guard plus toast | patch | patch | compliant |
| Proposal card Run / Cancel task | s | `proposalBusy`: disabled, no relabel, 10 s timer | partial | 10 s pane guard only; host pre-check passes a duplicate, then the queue refuses it | toast / native `dialogs.error` | `proposalsFor` | gap (small), F3 |
| Delegation card Approve / Run as one task / Plan again… / Cancel | s; planner min | same 10 s pattern | partial | same; a cancelled Plan again sends no reply | toast / dialog | `delegationsFor` | gap (small), F3 |
| Delegate offer Delegate / Keep working / Dismiss | instant, then s | `settled` flag | yes | pane plus host ignore an unknown id | card hides | host | compliant |
| Task strip Accept / Resume / Retry / Skip / Cancel / Recreate / Open diff | s–min | none | none | queued, then refused as a native dialog | `dialogs.error` | task push | gap (large), F1 |
| Mic | <1s; s to transcribe | optimistic | `transcribing` | host rejects a second recorder | flash | `dictation` | compliant |
| Mode / Model / Effort selects | <1s | select value | n/a | n/a | an error is unhandled and nothing reverts | push | gap (small), F8 |
| Earlier subagent work | s | none | none | loads twice | note | `subagent{id}` | gap (small), F8 |

### 4.3 Table toolbar, rows and banner (`src/webview/dashboard/main.ts`)

| Control | Latency | Ack | Pending | Dup | Feedback | Verdict |
|---|---|---|---|---|---|---|
| + New | s (spawns an agent) | none | none | **starts two agents** | session shown / `dialogs.error` | gap (large), F2 |
| Tasks menu | palette | palette | n/a | palette replaces itself | — | compliant |
| Discord toggle | <1s | optimistic | n/a | idempotent | a snapshot reverts it on error | compliant |
| Pause all / Resume all | instant | modal (pause) | n/a | `confirmingPauseAll` | info box | compliant |
| Launcher selects, folder menu | instant | optimistic | n/a | idempotent | a snapshot reverts it | compliant |
| Install / Update hooks (banner) | s | modal | none after | a second modal can queue | banner follows hooks | gap (small), F8 |
| Permission row Allow / Always / Deny | <1s | "Allowing…" / "Denying…", disabled | yes | `requestId` stale guard | toast | compliant |
| Question Answer | <1s | "Answering…" | yes | stale guard | toast | compliant |
| Row menu Rename / Own tab / Copy id / Archive / Pause / Resume agent | instant | palette / toast | n/a | idempotent | snapshot | compliant |
| Row menu Resume here | s | menu closes; row unchanged | none | host ignores it silently | `dialogs.error` | gap (large), F4 |
| Row menu Close session…, row × | s (SIGTERM, then grace) | modal (Close) / none (×) | none | close re-runs; `dismissHide` archives twice | row moves to Ended | gap (large), F4 |
| Analytics Accept / Reject / Revoke | instant | none | n/a | mostly idempotent | an unsupported proposal is silently ignored | gap (small), F8 |

### 4.4 Preferences (`src/webview/preferences/*`)

| Control | Latency | Ack | Pending | Dup | Feedback | Verdict |
|---|---|---|---|---|---|---|
| Setting inputs, Reset | instant | optimistic | n/a | idempotent | **a rejected write is silent** | gap (small), F6 |
| Connect Discord… / Test connection / Disconnect | s; `fetch` has no timeout | `actionBusy` ("Working…", all three off) after one round trip | yes | a second click inside that round trip starts a second run | `actionResult` lines | compliant (best existing pattern), small gaps in F6 |
| Model tier / enabled / Reset | <1s | none | n/a | idempotent | re-push restores | compliant |
| Routing defaults | <1s | "Saving…" | yes | last write wins | inline errors | compliant |
| Add endpoint | s (write + probe) | none | none | "already registered"; the result line shows the last one | result line | gap (small), F5 |
| Endpoint On / My own machine | s (probe) | checkbox | n/a | idempotent | re-push | gap (small), F5 |
| Probe | 3–7 s | "Probing…" was drawn from `busy`, but the host did not push `busy` until the probe ended | effectively none | host joins the probe in flight | result line | **fixed**: `LocalEndpointService.probe` now fires a change when it starts and when it ends |
| Qualify Codex / Qualify tasks | min | "Qualifying…" / "Running tasks…" plus progress | yes | host "Already running." | result lines | compliant |
| Set key… / Remove key / Remove endpoint | instant | palette (Set key) | n/a | idempotent | result line; **Remove has no confirm** | gap (small), F5 |
| Palette pick / input | instant | `answered` guard | yes | host settles the older request | — | compliant |

There is no usage-refresh button. A host handler for `refresh` exists, but nothing posts it.

## 5. Fixed in this change

- **Merge locally, Open a PR, Keep, Discard:** core dedupe, write-ahead `pendingFinish`, git and
  `gh` read-back on fault and on restart, an uncertain state with Check again, a recorded
  `finishFailure`, and `MissionView.finishing`. The pane draws busy and blocked buttons
  accessibly.
- **Every other slow Missions view button** (Approve and start, Run task, Cancel, Pause, Pause
  now, Resume, Plan again, Write it myself, Replan, and the task row's Accept, Retry, Resume,
  Skip, Recreate worktree and Cancel): pane pending state through the same `PendingActions`,
  ended by `missionAck`. A double press sends nothing, and the mission's other slow actions are
  blocked until the host answers.
- **Preferences Probe:** the host now pushes `busy` when the probe starts, so "Probing…" shows.

## 6. Proposed follow-up issues

Each is larger than a pane-only fix, or needs a decision.

**F1. Core dedupe and host pending state for task actions.**

- *Repro:*
  1. On a non-parallel planned mission whose task needs you, press Retry in the conversation's
     task strip.
  2. Press it again before the tree restarts.
  3. The second press queues behind the first, then fails with a native "Agent Wrangler: … is
     not …" dialog after the first succeeded. Accept on a parallel mission does the same for the
     length of integration and verification.
- *Acceptance criteria:*
  - `TaskRunner` keeps an in-flight map per `(mission, task, action)`, like `finishing`. It
    exposes it as `MissionTaskView.busy` and in the conversation's task view.
  - A repeat joins the action under way; a conflicting action is refused before the queue.
  - Both the Missions row and the conversation task strip draw the busy state from the host.
  - The strip shows errors inline, not as a native box.
  - A test covers double dispatch through `queue()`.

**F2. "+ New" can start two agents.**

- *Repro:* with a project selected, double-click + New. Two conversations and two processes
  start.
- *Acceptance criteria:*
  - From the click until the host shows the session or reports an error, the button reads
    "Starting…" and is `aria-disabled`.
  - The host ignores a second start from the same launcher request id.
  - A failed start re-enables the button and shows why.
  - Tasks → Run a new task gets the same guard.

**F3. Proposal and delegation cards: relabel, and acknowledge instead of a 10 s timer.**

- *Repro:*
  1. Press Run on a proposal card whose start takes more than 10 s (a slow worktree setup).
  2. The buttons come back after 10 s, and a second Run is refused with a native dialog.
  3. Cancelling Plan again… on a delegation card leaves the card off for 10 s.
- *Acceptance criteria:*
  - `taskAction`, `proposalDecision` and `delegationAction` carry a request id.
  - The conversation host answers each one once, including a cancelled prompt.
  - The cards use `PendingActions` with labels ("Starting…", "Cancelling…") and `aria-busy`.
  - The timer is removed.
  - Errors are shown on the card, not in a native box.

**F4. Row-level session actions: Resume here, Close session…, row ×, conversation Take over and
Release.**

- *Repro:*
  1. Choose Resume here from a row's menu, or click × on a busy session that takes seconds to
     exit. The row does not change for seconds.
  2. Repeat it. The host ignores the repeat silently or runs the close again.
  3. Separately: in the conversation, press Take over. Its `disabled` is undone by the next
     session push.
- *Acceptance criteria:*
  - `SessionDTO` carries a host-set `pending?: 'adopting' | 'closing' | 'releasing'`.
  - The row shows a chip and its actions are off while that is set.
  - The conversation's Take over and Release buttons are drawn from that field, not from a
    one-off `disabled`.
  - A failure clears the chip and says why.

**F5. Local endpoints in Preferences.**

- *Repro:*
  1. Press Add endpoint twice quickly. The result line shows "already registered".
  2. Press Remove on an endpoint. It and its stored key go immediately, with no confirm.
- *Acceptance criteria:*
  - Add endpoint, On and My own machine use the `actionBusy` / `actionResult` pattern, with a
    request id.
  - Remove asks first, and says the stored key goes too.

**F6. Preferences writes and actions.**

- *Repro:*
  1. Make the settings file unwritable, then change a setting. Nothing says it failed.
  2. Point Discord at a host that never answers, then press Test connection. "Working…" never
     ends.
- *Acceptance criteria:*
  - A rejected `set` or `reset` is caught, reverts the field, and says why.
  - The Discord `fetch` calls have a timeout.
  - The pane disables action buttons on click rather than after the first `actionBusy`.
  - `runAction` refuses a second run of the same action while one runs.

**F7. Plan editor: Add task and Split run twice on a double click.**

- *Repro:* double-click + Add task in plan review. Two tasks are added.
- *Acceptance criteria:*
  - Plan edits carry the plan revision they were made against.
  - The core refuses an edit against an old revision.
  - The pane drops a second structural edit until the snapshot with the new revision arrives.

**F8. Small acknowledgement gaps.**

- *Repro:*
  - The conversation's Stop keeps saying "Stop" until the turn ends.
  - A hooks banner pressed twice queues two confirms.
  - Analytics Accept on a proposal that is no longer supported does nothing visible.
  - Earlier subagent work loads twice when pressed twice.
  - A failed Mode, Model or Effort change in the conversation is unhandled.
- *Acceptance criteria:*
  - Each uses `PendingActions` with a label ("Stopping…", "Installing…", "Loading…").
  - Each reports its refusal inline.

**Side findings to triage (not async-state bugs).**

- *Task-row Cancel ends the whole mission with no confirm.* Cancel in the task row and in the
  conversation strip goes to `runner.cancel(missionId)` with no confirm, while the footer's
  Cancel mission asks first.
- *Pause now reports a partial success as an error.* `pauseMission(now)` moves the mission to
  `paused` and then throws when there is no pause service. The message says so ("Nothing new
  will start, but …"), so this is probably deliberate. It still reaches the pane as a
  `missionError`, and the mission shows as paused.

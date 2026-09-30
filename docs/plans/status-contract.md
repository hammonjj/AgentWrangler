# Status contract: sessions, delegated work and waits

Issue: hammonjj/AgentWrangler#100 (investigation). Implemented by #101. Result handback and
closeout are #102's. Parent: #111. Date: 2026-09-30.

This is the contract #101 implements: what each status means, where the evidence for it comes
from and how sure it is, how a conversation that delegated work shows that work, and how every
state is grouped, counted, notified and drilled into. It also records the approval-gate audit
and where context is lost in the four reproductions from the issues.

## 0. The decision in one paragraph

Keep the six `SessionStatus` values. They answer "what is this conversation's own turn doing?"
and nothing else. Add two things beside them, never inside them:

- a **wait reason** with its evidence source and certainty, which says what a Waiting or Busy
  row is waiting for;
- a **linked-work summary**, one entry per mission id, computed from the mission record,
  which says what the work this conversation delegated is doing and whether it needs you.

The origin conversation's own status is never frozen, promoted or demoted because it delegated
something, with one exception: a Waiting that was only *read off its prose* (§5, rule W3) is
resolved when the linked record shows the ask it was about is gone. Historical assistant
messages are never rewritten.

## 1. What goes wrong today: the four reproductions

All four come down to the same fact. **Nothing connects an origin conversation's status to the
missions it delegated.** Status comes from the conversation's own turn (hooks, pid file,
transcript or rollout, then `finishedTurnStatus` in `src/core/needsReply.ts`). Mission state
reaches the conversation only as open cards, and the cards disappear the moment work starts.

| # | Observed | Where context is lost (file / function) | Contract rule that fixes it |
|---|---|---|---|
| 1 | The conversation card says *Delegated: deciding whether it is one task or several*, but the table shows the row only as **Busy**. | The origin is inside `aw delegate`, which `createApp.ts` `delegate()` holds for up to `DELEGATE_WAIT_MS` (100 s) while `delegationOutcome` is `planning`. Its own turn is a running Bash tool, so hooks correctly say `busy`. The delegation reaches only the conversation pane: `taskPanes.delegationsFor` → `conversationHost`. `dashboardHost` attaches `taskBadges` only, and those exist only for *attempt* sessions (`orchestration/view/taskViews.ts` `taskBadges`). `AgentSession` has no field for linked work, so `rowHtml`/`statusChip` in `webview/dashboard/main.ts` have nothing to draw. | **L1** (a linked-work summary on the origin row), **L2** (`planning` is an activity, not a wait), **P1** (the origin stays Busy: its own turn *is* working). The row reads *Busy · Delegated: planning*. |
| 2 | Mission **running**, *0/1 done · 1 running*, with a running attempt. The origin is **Waiting** and its last reply says the work is waiting for approval and has not started. | (a) The agent wrote that reply from `aw delegate`'s answer (`decision: single`/`multiple`), which was true when it was written. (b) `needsReply` matches the generic ask phrase "waiting for/on you", so `finishedTurnStatus` gives `waiting`. (c) The user then started the work from the card: `decideProposal` → `startProposed`, or `delegationAction('approve')` → `approvePlan`. (d) `isOpenProposal`/`isOpenDelegation` go false, so `proposalsFor`/`delegationsFor` drop the card and nothing in the conversation shows the new state. (e) The origin's status is never recomputed, because its transcript did not change. **This is stale prose plus a missing live summary, not an approval-gate defect.** Nothing but those two clicks, or `startAuto`, which delegation never uses, moves a delegated mission to running (§9). | **W3** (a prose-inferred wait keyed to a mission resolves when that mission leaves `awaiting-approval`), **L1/L3** (the summary persists after start: *running · 0/1 done*), **H1** (the old reply stays as written; the summary beside it is the current truth). |
| 3 | Mission **completed**, *1/1 done*, *merged into main*. The origin still says **Waiting** with the same reply. The child reads *done · ? unverified*, and the linked GitHub issue is still open. | Same as #2 for the origin. *merged into main* is `finishMission`'s `finishResult.note`, shown as the mission's `stateReason`. *? unverified* is `verificationViewOf` → `summariseVerification`, which says `unverified` when no required `command:` stage passed. That happens when the repo policy defines no `verification.commands` (the default), or when the user accepted the result (`accept()` sets `acceptedBy: 'user'`, and the attempt's verdict stays `unverified`). Nothing in the codebase closes an issue. There is no handback to the origin (#102). | **W3**, **L3** (terminal summary: *merged · unverified · issue not closed by Agent Wrangler*), **C1–C3** (integrated, verified and closed out are three separate facts). |
| 4 | One origin with two missions: a proposal-only one, then a corrective one. The Status tab shows the origin as the only row in Waiting, the header says Waiting, and the last reply says the corrective task awaits approval. Missions shows both completed. | Cards are keyed by mission id (`p:<id>`, `d:<id>`), so two open cards render side by side and neither overwrites the other. That part works. What is lost: (a) the origin's Waiting is one value per session, read from prose that names no mission id; (b) once started, neither mission is linked back to the origin row, and `missionViewOf` carries no `origin`; (c) `aw delegate` returns the `missionId` in `taskSummary`, but nothing records which turn of the origin it belonged to, so a later reply cannot be tied to the right mission. | **K1–K3** (waits keyed by `{missionId, planRunId?}`, resolved per key, never by a per-session counter), **L1** (one summary entry per mission id), **W3** applied per key. |

## 2. Primary status: unchanged

`SessionStatus` (`src/shared/model.ts`) stays at six values. Both `blocked` and `waiting` keep
the label *Waiting* and share one section. `blocked` means a verified prompt; `waiting` means a
finished turn that asked something.

| Status | Means (the conversation's own turn) | Label | Section |
|---|---|---|---|
| `blocked` | Stopped at a prompt the provider reported: permission, question, plan approval, elicitation. | Waiting | Waiting |
| `waiting` | Turn over, and the reply asks something, or the turn failed or was interrupted. | Waiting | Waiting |
| `done` | Turn over, and the reply reports without asking. | Done | Done |
| `busy` | Turn in progress, or over with background work it will resume on (#60). | Busy | Busy |
| `stuck` | Should be working, but no signal past `stuckThresholdSeconds`. | Possibly stuck | Possibly stuck |
| `ended` | Process gone, or the session ended. | Ended | Ended |

Why not add top-level statuses (such as `planning`, `awaiting-approval`, `awaiting-children`,
`verifying`)?

- They describe *delegated work* or *why* a row waits, not the turn.
- Putting them in the enum would make the origin's status depend on its missions. That is
  exactly the coupling #100 rules out: "a delegated origin conversation remains independent of
  the worker".
- `STATUS_RANK`, `sectionOf`, `menuBarCounts`, notifications and the Codex/Claude mappers would
  each need a case for states that no provider emits.
- Everything #101 needs fits in two fields beside the status (§3, §4).

## 3. Wait reason and activity (the "why")

A new optional field on `AgentSession`, `wait?: WaitInfo`, generalises what already exists
(`blockedReason`, `pendingQuestion`, `pendingPlan`, `backgroundTasks`, `rateLimit`):

```ts
type WaitReason =
  | 'permission' | 'user-question' | 'plan-approval'  // provider prompt (blocked)
  | 'user-reply'                                     // prose asked something (waiting)
  | 'awaiting-approval'                              // an Agent Wrangler proposal or plan
  | 'awaiting-children'                              // delegated work running, nothing for you
  | 'background'                                     // #60: its own background tasks
  | 'resource'                                       // #69: an exclusive lease
  | 'rate-limit'                                     // #75
  | 'queued' | 'dependency' | 'verifying' | 'planning'; // mission-side activity
interface WaitInfo {
  reason: WaitReason;
  certainty: 'verified' | 'inferred' | 'unknown';
  source: 'hook' | 'pid-file' | 'transcript' | 'sdk' | 'codex-app-server' | 'codex-rollout' | 'mission';
  since: number;
  ref?: { missionId: string; planRunId?: string; taskId?: string }; // K1
  detail?: string;                                    // e.g. the tool, the lease, the window
}
```

The reason is a projection of existing evidence. It never creates a status of its own. Which
statuses may carry which reasons:

| Primary | Reasons it may carry | Needs the user? |
|---|---|---|
| `blocked` | `permission`, `user-question`, `plan-approval` | yes |
| `waiting` | `user-reply`, `awaiting-approval` (ref required) | yes, while the reason stands (W3) |
| `busy` | `background`, `resource`, `rate-limit` (a wait inside a turn), `planning` (only as linked activity) | no |
| `done` | none of its own; linked activity only (`awaiting-children`, `verifying`, `queued`) | no |
| `stuck` | none; the tooltip names the last signal and its age | no, but look |
| `ended` | none | no |

## 4. Linked-work summary (the origin's live view of what it delegated)

`AgentSession.linked?: LinkedWork[]`. There is one entry per mission whose `origin` is this
session, ordered oldest first to match the cards. It is computed on demand from the mission
record and never persisted on the session.

| Mission record (`TaskRunner` states) | Phase | Needs you? | Row / summary text (≈300 px form) |
|---|---|---|---|
| `planning` (a planner run is `running`) | `planning` | no | *Delegated: planning* |
| `draft` with task `pending`/`ready`/`assessing` (a delegation kept as one task, being routed) | `planning` | no | *Delegated: routing* |
| open proposal (`isOpenProposal`: task `routed`/`needs-human`, no attempt) | `awaiting-approval` | **yes** | *Delegated: 1 task to start* |
| `plan-review` | `awaiting-approval` | **yes** | *Delegated: plan of N to approve* |
| `planning-failed` | `needs-you` | **yes** | *Delegated: could not be planned* |
| `running`, some task `needs-human` | `needs-you` | **yes** | *Delegated: t2 needs you* (task `stateReason` in the tooltip) |
| `running`, an attempt `waiting-human` | `awaiting-children` | no; the worker's own row asks (A3) | *Delegated: worker asks* |
| `running`/`finishing`, attempts `running`, none waiting | `running` | no | *Delegated: running · 0/1 done* |
| `running`, task `queued`/`blocked` with a scheduler wait | `queued` | no (yes if `blocked` on a failed upstream) | *Delegated: queued (reason)* |
| attempt `verifying`, or mission `finishing` | `verifying` | no | *Delegated: verifying* |
| `paused` | `paused` | no | *Delegated: paused* |
| `review` | `ready-for-review` | **yes** | *Delegated: ready to merge* |
| `completed` | `integrated` | no | *Delegated: merged · unverified* (C1–C3) |
| `failed` | `failed` | **yes**, once | *Delegated: failed* |
| `cancelled` | `cancelled` | no | *Delegated: cancelled* |

- **L1.** Every mission with `origin` is listed while it is not terminal, and for 24 h after it
  becomes terminal. It is always listed while its origin's current Waiting is keyed to it.
- **L2.** `planning`, `running`, `queued`, `verifying` and `awaiting-children` are *activity*.
  They never move the origin into Waiting and never count for attention.
- **L3.** The conversation pane shows the same entries as a *live delegated-work summary* strip
  under the header. It is not a message in the transcript. It replaces the open-cards-only rule:
  a started mission keeps a compact entry, with *Open in Missions*, instead of disappearing.
- **L4.** Mission progress counts only required tasks (`skipped` is excluded from the
  denominator), and uses the same `missionMetrics` the Missions tab uses. That way the table,
  the Missions tab and the conversation cannot disagree about a number.

## 5. Transitions and precedence

### 5.1 The origin row

This table is evaluated top to bottom, and the first matching row wins. Every row is derived
fresh from current evidence (§7), so there is no stored state to go stale.

| # | Condition | Primary | Wait reason | Certainty |
|---|---|---|---|---|
| P0 | paused (#pause service) | section Paused, status kept | — | verified (OS) |
| P1 | provider reports a prompt now (hook `PermissionRequest`/`Elicitation`/`AskUserQuestion`/`ExitPlanMode`, SDK `canUseTool`, Codex approval request), and the pid-file status stamped later has not cleared it | `blocked` | `permission` / `user-question` / `plan-approval` | verified |
| P2 | own turn in progress | `busy` | `resource`/`rate-limit` if one is known, else none; linked activity is shown beside it | verified (hooks/SDK/app-server) or inferred (transcript) |
| P3 | turn over, `background_tasks` not empty (#60) and the reply does not ask | `busy` | `background` | verified (Stop payload) or inferred (transcript) |
| P4 | busy, silent past threshold, nothing in flight | `stuck` | — | inferred |
| P5 | turn over and `needsReply(lastReply)`, *and* W3 does not resolve it | `waiting` | `user-reply`, or `awaiting-approval` with `ref` when K2 ties the turn to a delegation | inferred |
| P6 | turn over, reply reports, or W3 resolved the ask | `done` | — (linked activity shown) | inferred |
| P7 | pid gone / `SessionEnd` / Codex thread closed | `ended` | — | verified |

The rules the table uses:

- **W1.** A verified wait (P1) always beats an inferred one, and an inferred one never clears a
  verified one. This is the current `blockClearedByClaude` rule, kept: only a later-stamped
  pid-file status or a later event ends a block.
- **W2.** A resolved wait is cleared on the transition that resolves it, not on a timer. Its
  `since` never carries over to the next wait.
- **W3.** A prose-inferred Waiting whose turn is keyed (K2) to one or more missions is resolved
  when **every** keyed mission has left `awaiting-approval` and `needs-you` for a phase that
  needs nothing from the user. The row then shows `done`, with the linked summary saying what
  the work is doing. If a keyed mission is still awaiting approval, it stays Waiting with
  `awaiting-approval` and that mission's `ref`. A turn not keyed to any delegation keeps the
  current behaviour: its prose decides.
- **W4.** A new user prompt in the origin ends all of its prose-inferred waits. The next turn
  decides again.

### 5.2 Mission and task (unchanged machines, stated for the contract)

The machines in `orchestration/domain/lifecycles.ts` stay as they are. The gates that matter
for status:

| Transition | Guard (domain) | Status consequence |
|---|---|---|
| `draft → running` (single task) | `launchRefusal(m)` is undefined: a recorded `startApproval` (new, §9) | proposal leaves `awaiting-approval` |
| `plan-review → running` | `planApprovedAt` set | plan leaves `awaiting-approval` |
| `running → planning` (replan) | no live attempt; clears `planApprovedAt` | back to `planning`, then `awaiting-approval` |
| attempt `running → waiting-human` | a worker's ask | worker row is Waiting; origin summary `awaiting-children` |
| task `→ needs-human` | failure, cap refusal, unverified result | origin summary `needs-you` |
| `running → finishing → review` | every task `done`/`skipped` | `ready-for-review` |
| `review → completed` | a finish choice other than `discard` | `integrated` |

## 6. Parent / child aggregation and keying

- **K1. Keys.** A wait or a linked entry is keyed by `missionId`, and for a plan also by
  `planRunId`: a replan is a new approval, so an approval of run *n* is not an approval of run
  *n+1*. Task-level asks add `taskId`. Keys come from the mission record. They are never parsed
  from prose.
- **K2. Tying a turn to missions.** When `aw delegate`/`aw task` or the Delegate button creates
  a mission with an `origin`, it records `origin.turnStartedAt`: the origin's current turn start,
  from hook `UserPromptSubmit`, Codex `turn/started` or the runner, when known. A finished turn
  of the origin is *keyed* to every mission created between its start and its end, with no user
  prompt in between. If the turn start is unknown, as for a transcript-only session, the turn
  is keyed to missions created after the previous user line (inferred), and the tooltip says
  *estimated*.
- **K3. Resolution is per key and set-based.** The origin's waits are the set of keyed missions
  still needing the user. Resolving mission A never clears mission B. A duplicate or replayed
  event re-derives the same set, so nothing is double-counted or cleared twice.
- **A1. Origin independence.** The origin's primary status comes from its own turn only (§5.1),
  except W3. A busy worker never makes the origin Busy, and a waiting worker never makes the
  origin Waiting.
- **A2. Mission aggregate.** A mission is only as finished as its required tasks. `finishing`
  requires every task `done` or `skipped`, as the domain already enforces. Progress is
  `done / (tasks − skipped)`. A mission with any `needs-human` task, or in `plan-review`,
  `planning-failed` or `review`, needs the user. Otherwise it is activity.
- **A3. One ask, one count.** A worker's own prompt is counted on the worker's row (it is a
  session like any other). The mission and origin summaries point to it but do not count it
  again. An AW-level ask (proposal, plan, `needs-human`, review) is counted once, on the
  mission, and the origin row shows it without counting it again.
- **A4. Several missions.** The origin summary lists each mission. The row chip shows the most
  urgent one (needs-you before activity, then newest), plus *+N*.

## 7. Stale, duplicate, out-of-order, reconnect and restart

| Case | Rule |
|---|---|
| Duplicate hook line, rollout line or runner event | Status is recomputed from the latest evidence, not accumulated: a duplicate changes nothing. Keyed waits are a set (K3). |
| Out-of-order evidence | Every source carries a stamp: hook line order per pid shard, pid-file `statusUpdatedAt`, transcript line order, Codex notification order per thread. A stamp older than the current evidence is ignored (the existing `blockClearedByClaude` rule, generalised). Mission records have one writer (the per-mission queue in `TaskRunner`), so their order is total. |
| A mission record that changed while the origin's evidence did not | The summary is a pure function of (mission record, origin evidence), rebuilt on `tasks.onDidChange`. There is no cached copy to go stale (as `taskPanes` already does). |
| Reconnect (host or Codex app-server) | Until the handle is live again the row keeps its last status with `certainty: 'unknown'` and a *reconnecting* chip. It is not Waiting. An unreachable host (`hostSupervisor`) is shown as such and is never counted as needing the user. |
| Restart of the app | Missions reload from disk (write-ahead records) and `TaskRunner.recover()` re-derives attempts. Sessions are re-derived from their sources. Nothing about a wait is persisted on the session, so nothing needs clearing. Notifications are not re-sent for states that already hold at startup (as `becameWaiting` never fires on the first snapshot). Dedupe keys (N1) are in memory, which is safe because of that startup rule. |
| Stopped or ended record (#98) | `ended` wins over any inferred status. A stopped record never re-enters the stuck loop (the fix on `main`). |
| Quiet legitimate waits | `background`, `resource`, `rate-limit`, `queued`, `awaiting-children`, `planning` and `verifying` never become *Possibly stuck*, and never send a Done notification. |

## 8. Uncertainty markers

| Certainty | When | How it is shown |
|---|---|---|
| verified | A provider or AW record states it: hook payload, SDK message, app-server notification, mission record. | Solid status dot. The tooltip names the source. |
| inferred | Heuristic: reply text (`needsReply`), transcript silence, the 100%-used window reading, turn keying without a turn start. | Hollow dot (the existing `statusIsEstimated`). The label is prefixed `~` in the header. The tooltip says "estimated from …". |
| unknown | No signal can say, or the source is unreachable. | `?` chip (*status unknown*, *window unknown*). It is never rendered as a guess. |

Rule U1: a detail that no signal supports is shown as *unknown*, never filled in. For example,
the rate-limit window for a bare 429 (#75), whether an external session is at a permission
prompt without hooks, or the worker's intent from prose.

## 9. Approval gate audit (every launch path)

**Finding: one latent defect, fixed at the engine level. It is not the cause of reproductions 2
to 4.**

`retry()` accepted any task in `needs-human`. A proposal that waits for the user to pick a route
(`routeProposal` with verdict `needs-human`, or `reproposed` after a cap edit) is exactly that
state, with no attempt. `retry()` then launched it on `routeFor()`'s default route: a harness
session with no approval on record. Today the UI does not reach it: `actions()` offers `retry`
only when an attempt exists, and `runTaskAction` checks `actions()` when given a task id. But
the engine did not enforce the gate, and single-task proposals had no recorded approval at all.
Approval was implied by which function was called.

Fix (commit on this branch):

- `Mission.startApproval?: { at, by: 'user' | 'auto' }` is recorded **before** the launch it
  allows. `start()` records the user's direct start. `startProposed()` records the user's click.
  `startAuto()` records `auto` routing's start within its §27.3 gate.
- `launchRefusal(m)` in `orchestration/domain/lifecycles.ts` is the one gate. A planned mission
  needs `planApprovedAt`. An unplanned one needs `startApproval`, or an attempt already on
  record: a record from before this field that already launched was started then.
- It is enforced in `launch()`, which every path goes through, in `retry()` before anything is
  touched, and in the `draft → running` domain transition.

| Path | Before | After | Test |
|---|---|---|---|
| `startProposed` | Launch on the click, with no record of it. | Records `startApproval: user`, then launches. | `taskRunner.integration` "approval gate: … retried into running" |
| `startAuto` | Launched within the gate. | Records `startApproval: auto`. | "approval gate: auto routing records …" |
| `start` (direct) | The start is the approval. | Records `startApproval: user`. | same |
| `approvePlan` | Gated on `planApprovedAt` in `launch()` and `launchNext`. | Unchanged, now via `launchRefusal`. | existing plan tests |
| `delegate` / `delegateAsTask` / `planAgain` / `replan` | Route only, never launch. `replan`/`planAgain` clear `planApprovedAt`. | Unchanged. | existing |
| `retry` | **Could launch an unstarted `needs-human` proposal.** | Refused by `launchRefusal`, nothing changed. | "approval gate: … retried into running" (`harness.launches` stays 0) |
| `resume` | Needs an `interrupted` attempt, so it was approved before. | Unchanged. | same test asserts it refuses |
| scheduler `step`/`applyAction` | Skips planned missions without `planApprovedAt`. Unplanned drafts are not scheduled. | Unchanged, and `launch()` now gates it too. | existing |
| escalation / failover | Only after an attempt. `launch()` gate. | Unchanged. | existing |
| restart `recover()` | Routes a draft delegation. Launches only planned-and-approved. | Unchanged. | "approval gate: a restart launches no proposal nobody started" |
| `draft → running` transition | Any single unplanned task. | Needs `launchRefusal` to pass. | `lifecycles.test` "a proposal nobody started …" |

The races #100 asks about:

| Race | Outcome |
|---|---|
| Approval vs. worker launch | Approval is written before the launch, in the mission's queue. The launch cannot precede it. |
| Approval vs. the origin's final reply | The reply may be written before or after the approval. Either way it is prose (H1), and W3 resolves the wait from the record. |
| Several children | Each mission is keyed and resolved separately (K3). |
| Retries | Need an approved mission. |
| Cancellation | Ends the mission; its key leaves the set. |
| Errors | A launch refused after approval leaves the task `needs-human` with the reason, and approval stays on record. |
| Restart | Launches nothing unapproved (tested). |

## 10. Per-state presentation

This covers attention count (the tray badge `menuBarBadge`, and the Missions tab count),
notifications, and drill-down. "Row" is the Status/Project table. The ≈300 px form is the
second line of the narrow grid (`#app.narrow`).

| State | Section | Label · detail (full width) | ≈300 px | Attention count | Notification | Drill-down |
|---|---|---|---|---|---|---|
| `blocked` · permission | Waiting (top) | Waiting · *Needs permission: Bash* + ask card | *Needs Bash* | yes (session) | once per request id (existing *Needs your permission*) | conversation, ask card |
| `blocked` · question / plan-approval | Waiting | Waiting · *Needs an answer* / *Needs plan approval* | same | yes | once per request id | conversation |
| `waiting` · user-reply | Waiting | Waiting · last reply's first line | *Waiting* | yes | on becoming Waiting, 30 s cooldown (existing) | conversation |
| `waiting` · awaiting-approval (ref) | Waiting | Waiting · *Delegated: plan of 3 to approve* | *Plan to approve* | yes, **once**: counted on the mission, not also on the row (A3) | once per `missionId:planRunId` (`notifyDelegation`); the row's becameWaiting toast is suppressed for it | conversation card; *Open in Missions* |
| `busy` | Busy | Busy · tool and elapsed, todo bar | tool | no | none | conversation |
| `busy` · background (#60) | Busy | Busy · *N in background* (dashed) | same | no | none (never Done) | conversation |
| `busy` · resource (#69) | Busy | Busy · *waiting for lease K* | *lease K* | no | none | conversation; Release/Stop waiting per #69 |
| `busy`/`waiting` · rate-limit (#75) | as the primary | chip *ratelimit* with window, or *unknown* | chip | no | the existing rate-limit notice | conversation |
| linked `planning` | as the origin's primary | *· Delegated: planning* | *Delegating* | no | none | conversation card |
| linked `awaiting-approval` | origin in Waiting (W3/P5) | see above | | yes (once, on the mission) | once per key | card, else Missions |
| linked `running`/`queued`/`verifying`/`awaiting-children` | origin's own | *· Delegated: running · 0/1* | *Delegated · 0/1* | no | none | Missions → mission |
| linked `needs-you` | origin's own; Missions ranks it first | *· Delegated: t2 needs you* | *t2 needs you* | yes (mission) | once per `missionId:taskId:attemptId` (existing `notify('needs you')`) | Missions → task |
| linked `ready-for-review` | origin's own | *· Delegated: ready to merge* | *Ready to merge* | yes (mission) | once per mission (`is ready for review`) | Missions → finish buttons |
| linked `integrated` | origin's own | *· Delegated: merged · unverified* | *Merged* | no | once per mission, "merged; not verified; issue not closed" (#102 owns the handback) | Missions → mission footer |
| linked `failed` | origin's own | *· Delegated: failed* | *Failed* | yes, until opened | once per mission | Missions |
| `done` | Done | Done · tooltip "finished its turn without asking" | *Done* | no | *Done* (existing, opt-in); **not** for attempt sessions, which have mission notices instead | conversation |
| `stuck` | Possibly stuck | *No activity for X* | *Possibly stuck* | no | none | conversation |
| `ended` | Ended | — | — | no | none | conversation (history) |
| unknown / reconnecting | as the last status | `?` *reconnecting* | `?` | no | none | conversation |
| worker (attempt) session | by its own status | its own row, plus task chips (`taskBadges`) | chips fold | its own asks only | its own asks; no Done toast (N2) | conversation; chip → Missions task |

The notification rules:

- **N1.** Every notification has a dedupe key (shown above), held in memory. No notification is
  sent for a state that already held when the app started (§7).
- **N2.** Attempt sessions (`isOrchestrationOrigin`) send no *Done* toast. Today they do,
  through `store.onDidUpdate(becameWaiting)` in `createApp.ts`. The mission's own notices
  replace it.

Row example, full width:

```
● Busy   fix-login · proj           [claude] [Bash 0:42] [Delegated: planning]
○ Waiting refactor · proj           [codex]  [Delegated: plan of 3 to approve]
○ Done   triage · proj              [claude] [Delegated: merged · unverified] [+1]
```

At ≈300 px (two-line narrow grid):

```
● fix-login
  Busy · Delegating
○ refactor
  Plan to approve
○ triage
  Done · Merged +1
```

Each line answers the three questions: what is happening (primary and activity), what it is
waiting for (the reason), and whether you need to act (section and attention count).

## 11. Completed, verified and closed out are different facts

- **C1. Integrated.** The mission is `completed` with `finish` `merge-local`, `pull-request` or
  `keep`. The evidence is `finishResult.mergeCommit` or `pullRequestUrl`. It means the branch
  went where the user chose. It does **not** mean the work was checked.
- **C2. Verified.** Every required task's verdict is `passed` (`summariseVerification`). A task
  accepted by the user, or run in a repo with no `verification.commands`, is `unverified` and is
  shown as *? unverified*, even when merged. This is correct, not a bug: #35 made it so, and the
  label should add *no checks configured* when that is the reason.
- **C3. Closed out.** An external outcome such as the originating GitHub issue being closed.
  **Agent Wrangler closes no GitHub issue automatically, now or under this contract.** A
  worker finishing, a mission merging or a result verifying is neither permission nor evidence
  to close one. The summary may say *issue not closed by Agent Wrangler* when a linked issue is
  known. Authorised closeout is #102's to design.

The terminal summary names all three: *merged · unverified · closeout: yours*.

## 12. Historical prose is never rewritten

**H1.** An assistant message, once written, is shown as written: in the transcript, the
conversation pane and the remote mirror. When it has gone stale (*waiting for your approval;
nothing has started*), the current truth is shown **beside** it, as the live delegated-work
summary (L3) under the header and on the row. It is never an edit, a strikethrough or an
injected message in the transcript. A result handback into the conversation, as a new turn or a
card, is #102's. When it exists, it is a new message, never an amendment.

## 13. Provider / harness signal matrix

Verified means documented by the provider, pinned by a test or fixture in this repository, or
measured in a recorded spike. Inferred means a heuristic of ours. Unsupported means no signal
exists, so the contract shows *unknown*. Versions are the ones recorded in the README and the
spikes. Model source is not harness: a local or Qwen model run through Claude Code or Codex has
exactly that harness's signals, and the model supplies none of its own.

### 13.1 Claude Code: hooks, pid file, transcript (external and in-app sessions)

In-app Claude sessions, both in-process and hosted, run the real `claude` CLI through the Agent
SDK. So their row status comes from these same hooks and the same pid file. The runner adds
only the rows in §13.2.

| Signal | Source (file) | Produces | Class | Evidence / version |
|---|---|---|---|---|
| `SessionStart` | `claude/hookEvents.ts` `reduceHookEvent` | waiting, fresh (hidden without transcript) | verified | `test/hookEvents.test.ts`; event list checked 2.1.227, 2.1.266 |
| `UserPromptSubmit` | same | busy, turn clock starts (also for a queued / task-notification turn) | verified | tests; README |
| `PreToolUse` (any tool) | same | busy, `activeTool`, todo from `TodoWrite` | verified | tests |
| `PreToolUse` `AskUserQuestion` / `ExitPlanMode` | same | blocked · `user-question` / `plan-approval` | verified | tests |
| `PermissionRequest` (+ our `…PermissionPending` marker) | same, `hookLog.ts` | blocked · `permission`, Allow/Deny while the marker exists | verified | hook/dialog race read in the 2.1.267 binary; 2.1.278 spike |
| `PostToolUse` / `PostToolUseFailure` / `PostToolBatch` / `PermissionDenied` | same | busy, block cleared | verified | tests; `PermissionDenied` exists in 2.1.270 |
| `Elicitation` | same | blocked · `user-question` | inferred | reducer only; no recorded payload |
| `Notification` (permission / input / elicitation types) | same | blocked (keeps reason) | verified | tests |
| `Notification` `idle_prompt` | ignored | — | verified (ignored on purpose) | tests |
| `Stop` + `last_assistant_message` | same → `core/needsReply.ts` `finishedTurnStatus` | waiting · `user-reply` or done | **inferred** (the text split) | the heuristic is ours (`needsReply` header) |
| `Stop.background_tasks` (#60) | `claude/backgroundTasks.ts`, `status.ts` `holdForBackground` | busy · `background` | verified | shapes recorded 2.1.281–2.1.283 (`test/backgroundTasks.test.ts`) |
| `StopFailure` | same | waiting (failed turn); error type not read | verified (event) / unsupported (error type) | tests |
| `SessionEnd`, pid gone | same, `claude/registry.ts` | ended | verified | tests |
| pid file `status` + `statusUpdatedAt` | `claude/registry.ts`, `status.ts` `blockClearedByClaude` | ends a block only (busy / waiting) | verified | undocumented; measured 2.1.270 (~0.1 s) |
| pid file `waitingFor` | read, unused | — | unsupported (unused) | — |
| hook silence past `stuckThresholdSeconds` | `hookEvents.ts` `statusFromHookState` | stuck | inferred | README: 79–388 s silent gaps measured in one turn |
| transcript last line (`end_turn` / `tool_use` / user / queue-op) | `claude/transcriptTail.ts`, `status.ts` `deriveStatus` | done/waiting/busy, `statusIsEstimated` | inferred | README table; tests |
| transcript background launches / `<task-notification>` ends | `backgroundTasks.ts` | busy · `background` | verified shapes, inferred coverage (misses launches before first read) | 2.1.281–2.1.283 |
| transcript `result` with 429 | `claude/rateLimit.ts` | `rateLimit` · `unknown` window | inferred | most builds write no `result` line (README) |
| interrupt (Esc) in an external session | none | — | unsupported | — |
| resource lease wait (#69) | none yet (planned `PreToolUse` hook, spike F2) | — | unsupported | `spikes/f2-resource-leases.md` |
| endpoint down (local model) | none on the row | — | unsupported | orchestration reacts via `LocalEndpointService.onDown` only |

### 13.2 Claude Agent SDK runner (in-app sessions; SDK 0.3.268 pinned)

| Signal | Source | Produces | Class | Evidence |
|---|---|---|---|---|
| `system/init` | `claude/runner/claudeSdkSession.ts` | pane lifecycle starting → idle | verified | `conversation-pane.md` (2.1.270) |
| `canUseTool` | same → `runnerView.ts` `askBlock` | ask cards; hosted permission forces row `blocked` (`core/sessionView.ts` `withHostedPermission`) | verified | spike notes |
| `AskUserQuestion` / `ExitPlanMode` via `canUseTool` | same | `pendingQuestion` / `pendingPlan` on the row | verified (input shapes) | spike; ExitPlanMode deny-with-feedback wording unverified |
| `result` | same | pane idle; `queued_turn_count > 0` keeps running | verified | "the only reliable turn-complete signal" (`conversation-pane.md`) |
| `assistant`/`stream_event` while idle | same | pane running (a notification-started turn) | inferred | no spike cites it |
| `tool_result` for a pending ask | `settleAnsweredElsewhere` | ask settled elsewhere | verified | `remote-agent-control.md` |
| `rate_limit_event` | `claude/rateLimit.ts` `claudeRateLimitFromLatest` | `rateLimit` with window | **inferred**: undocumented by Anthropic, shape from the simulator; `status` field ignored and the cache is sticky (open question) | README #75 |
| `system/background_tasks_changed` | `sessionProtocol.ts` `latest` | host lifecycle policy only, not the row | verified name; not wired to `backgroundTasks` | `test/hostRecovery.test.ts` |
| `session_state_changed` | cached, unused | — | unsupported (unused) | "not seen in spike" |
| interrupt `result` | `runnerView.ts` 5 s watchdog | pane idle | inferred | "not documented" (code comment) |

### 13.3 Codex (app-server 0.155.0-alpha.16.3; rollouts for external threads)

| Signal | Source | Produces | Class | Evidence |
|---|---|---|---|---|
| `turn/started` | `codex/runner.ts` | busy | verified | `test/codexRunner.test.ts` |
| `turn/completed` (`status`, `error`) | same → `finishedTurnStatus` | waiting (failed / interrupted) or waiting/done from text | verified mechanism; shape inferred; text split inferred | tests; no spike cites the shape |
| `item/tool/requestUserInput` | same | blocked · `user-question` | verified | tests |
| `*requestApproval` (suffix match) | same | blocked · `permission` | verified handling; method naming inferred | tests |
| `serverRequest/resolved` | same | ask expired, block cleared | verified | `test/codexReconnect.test.ts` |
| reconnect: same server / restarted server | `appServer.ts`, `runner.ts` `serverRestarted` | asks re-sent with ids / cards expired, waiting | verified | `spikes/s4-codex-restart.md` |
| `thread/resume` status | `runner.ts` | busy if active | verified | s4 |
| `account/rateLimits/read` | `codex/usage.ts` | usage; "100% used = limited" | inferred (our reading) | README #75 |
| per-session Codex rate limit | classifier exists, no producer | — | unsupported | — |
| plan approval | `decidePlan` → unsupported | — | unsupported | — |
| background work | none | — | unsupported (none exists) | — |
| missed `turn/completed` | no watchdog | stays busy | unsupported (gap: no stuck for runner threads) | — |
| rollout `task_started` / `task_complete` | `codex/rollout.ts` `rolloutStatus` | busy/stuck, waiting/done from text; `statusIsEstimated` | inferred | tests (synthetic); no version recorded |
| rollout approval / question | none | external Codex never shows blocked (reads busy, then stuck) | unsupported | `docs/codex-and-electron.md` |
| AW-stopped record newer than rollout (#98) | `codex/stoppedStatus.ts` | ended | verified | `test/codexStoppedStatus.test.ts` |

### 13.4 Local and OpenAI-compatible endpoints (Qwen and others)

| Signal | Source | Produces | Class |
|---|---|---|---|
| session status | the harness (Claude Code on Messages, Codex on Responses) | as §13.1–13.3 | verified per harness; the model adds none |
| OpenAI API response state (`openaiWire.ts`) | probe / qualification / completions only | not a session status | n/a: API response state is not session state |
| endpoint health (`reachable/degraded/down/unknown`) | `LocalEndpointService` | fails an orchestrated attempt over; nothing on the row | verified (orchestration); unsupported on the row |
| rate limit | none for a local server | — | unsupported (not meaningful) |

### 13.5 Session hosts and Agent Wrangler's own records

| Signal | Source | Produces | Class |
|---|---|---|---|
| link `connecting` / `unreachable` | `core/session/hostClient.ts` | pane lifecycle; today the pane's fallback row maps `unreachable` to `stuck` (`conversationHost.ts` `liveSessionRow`), and the contract says unknown (§7) | verified (link), inferred (the stuck mapping) |
| host gone, tombstone | `hostClient.ts` `hostGone`, `core/session/recovery.ts` | record `interrupted` / `ended` / `failed` | verified (spikes S1, S2) |
| mission / task / attempt records | `orchestration/engine/taskRunner.ts` (one writer per mission) | linked-work phases (§4) | verified (AW is the source) |
| verification verdicts | `shared/orchestration/verification.ts` | verified / unverified (C2) | verified |
| finish result | `taskRunner.ts` `finishMission` | integrated (C1) | verified |
| GitHub issue state | none read | closeout (C3) shown as *yours* | unsupported (AW reads and writes none) |

## 14. Reuse of existing seams

| Seam | Reused as |
|---|---|
| #60 background work (`backgroundTasks`, `holdForBackground`) | wait reason `background` on `busy`. Behaviour unchanged: never Done, never stuck, no Done toast. |
| #69 resource leases (open; spike F2) | wait reason `resource`, with `detail` = lease key. #69 ships the chip and its buttons; this contract fixes only where it sits (Busy, not Waiting, no attention). |
| #75 rate-limit classification (`rateLimit: RateLimitStoppage`) | wait reason `rate-limit`, `detail` from the classification. `unknown` stays unknown (U1). |
| #98 stopped/stuck (fix on `main`) | `ended` beats inferred status (§7). The rule is kept as is. |
| `statusIsEstimated` | the `inferred` certainty marker. |
| `taskBadges` / `taskChips` (#34) | the worker row's chips, unchanged. |
| `missionMetrics` / `missionChips` | the only source of mission counts for the linked summary (L4). |
| `isOpenProposal` / `isOpenDelegation` / `delegationOutcome` | phase `awaiting-approval` / `planning`. They are not duplicated. |
| `notify` / `notifyDelegation` | the mission notices, with dedupe keys added (N1). |

## 15. Left for #102 (not in #101)

- Handback: delivering a structured result to the origin as a new turn or card, when the origin
  is idle, busy, ended or archived, idempotently.
- Ownership: whether the origin becomes an accountable orchestrator, and transferring or ending
  that.
- Authorised follow-through: closing an issue, opening follow-up tasks, re-verifying, with the
  evidence and permissions each needs.
- Hooks this contract leaves for it:
  - the `integrated` phase's notification body;
  - `LinkedWork` as the payload's mission and verification facts;
  - the `closeout` fact (C3), which #102 fills in;
  - K2's turn keying, which tells a handback which origin turn it answers.

## 16. What #101 changes (files)

| Area | Files |
|---|---|
| Model | `src/shared/model.ts` (`WaitInfo`, `LinkedWork` on `AgentSession`) |
| Summary builder, pure | `src/orchestration/view/missionViews.ts` or a new `linkedWork.ts` beside `proposalView.ts` |
| Store decoration | `src/ui/dashboardHost.ts` and `src/ui/conversation/conversationHost.ts` (attach `linked`) |
| W3 / K2 | `src/app/createApp.ts` (`delegate`, `proposeTask`: record `origin.turnStartedAt`); status derivation after `finishedTurnStatus` in `src/core/sessionStore.ts` `decorate` |
| Counts and toasts | `src/core/menuBar.ts` (attention), `createApp.ts` notifications (N1, N2) |
| UI | `src/webview/dashboard/main.ts` (`statusChip`, `rowTitle`), `missions.ts`, `src/webview/conversation/main.ts` (summary strip, `DELEGATION_HEAD`; `review` is overridden at render and can go) |
| Docs | README *How status is detected*: a *Delegated work* subsection |

Open questions, marked here and not guessed:

- Whether a Codex `turn/started` stamp is available for every origin (it is for app-server
  threads; for rollout-only sessions it is inferred).
- Whether the Missions tab count should include open single-task proposals. They are excluded
  from the Missions snapshot today. The contract says yes, once, per A3.
- Signal gaps found in the audit. Each is shown as *unknown* until it is fixed, never guessed:
  - `rate_limit_event` ignores `rate_limit_info.status`, and the cached event is sticky.
  - A hosted Claude session without hooks does not hold Done for background work.
    `background_tasks_changed` is not wired to `backgroundTasks`.
  - A runner-owned Codex thread that misses `turn/completed` stays Busy with no stuck timer.
  - An external Codex thread at an approval prompt reads Busy, then *Possibly stuck*.
  - `materialFingerprint` in `sessionStore.ts` omits several decorated fields: `rateLimit`,
    `pending*`, `paused`, `interrupted`, `task`. `linked` and `wait` must go into it, or
    change events will be missed.

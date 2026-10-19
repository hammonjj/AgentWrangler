# Delegation ownership and result-handback contract

Issue: hammonjj/AgentWrangler#102. Parent: #111 (orchestration epic #24). Builds on the status
contract (`docs/plans/status-contract.md`, #100/#101) and the bounded-assignments draft
(`docs/plans/bounded-assignments.md`, #47). Date: 2026-10-02.

This document finalizes what #102's research left open: who owns a delegated mission after the
worker finishes, what the origin conversation is told and when, what a versioned completion
payload looks like, and when Agent Wrangler may close a GitHub issue on the user's behalf. It is
the shared contract for #114 (ownership/result domain and store) and #105 (origin reconsumption),
and it records the decisions the user approved on 2026-10-01 (§3) and 2026-10-02 (§10).

Every factual claim below is marked **Observed** (with a file/function reference, read 2026-10-02
against the same commit lineage as #101/#102's research, `a67953e` and ancestors) or
**Hypothesis** (a reasoned expectation this repository does not yet prove). Nothing here is
**Decided** by implication; decisions are called out explicitly in §3 and §10.

---

## 1. The current completion/handback path

### 1.1 What happens when a worker finishes

**Observed.** A mission's lifecycle is entirely inside Agent Wrangler's own state, not the origin
conversation's. The path, task finishes → mission state advances → `Mission.updatedAt` bumps →
derived state recomputed → surfaces re-rendered:

1. The runner advances `Mission.state` through `running` → (`finishing` → `review`) → `completed`,
   and records `finish` / `finishResult` when the user picks how to finish (merge, PR, keep,
   discard) — `src/shared/orchestration/types.ts` `Mission`, `MissionFinish`.
2. `missionPhase(m)` (`src/shared/orchestration/delegatedState.ts:252`) turns that into one
   `LinkedPhase`; for a `completed` mission with a non-`discard` finish it is `integrated`, with an
   `outcome: LinkedOutcome` carrying C1 (`integrated`), C2 (`verification`), and a fixed C3
   (`closeout: 'yours'`, line 113 and 234).
3. `linkedWorkFor` (line 438) attaches that phase to every session whose `origin` names the
   mission's `origin` (`originKeyOf`, line 381), producing a `LinkedWork` entry.
4. `deriveSessionState` (line 554) folds the origin's `linked` entries into the row's `status` and
   `wait`. A keyed, needs-you entry can make the row `waiting`; a keyed entry that is terminal and
   needs nothing clears a stale `waiting` back to `done` (**W3**, line 604-605).
5. Separately, `linkedNotices` (line 684) emits one OS-level notification the first time a mission
   reaches `integrated`, worded `"Merged; not verified; issue not closed by Agent Wrangler."` This
   is a toast, not a conversation message.

**Observed — there is no step 6.** Nothing in `src/shared/orchestration/*`,
`src/orchestration/engine/*`, or `src/app/createApp.ts` writes a new assistant-visible message or
turn into the origin's transcript, resumes the origin's session, or asks the origin's harness to
do anything, when a mission finishes. `src/app/createApp.ts` around the linked-work wiring
(`store.linkedWorkApplied()`, the mission-notice `onClick`, roughly lines 1578-1620) only
re-derives the row/summary and fires the one toast; it never calls a `send`/`resume` on the
origin's runner. Status-contract §15 says this explicitly: "Left for #102 (not in #101): …
delivering a structured result to the origin as a new turn or card."

**Observed — the origin's own transcript is never touched.** H1 (status-contract §12) is upheld:
a stale assistant reply ("Waiting for your approval; implementation has not started") is shown
exactly as written. The *only* corrective information is the live derived summary rendered beside
it (the row's linked-work chip, the conversation header's delegated-work strip). If the user does
not look at that strip, or is looking at a different pane (Status vs. Missions vs. the
conversation), nothing tells them the picture changed.

### 1.2 Reproducing the 2026-09-29 10:57/10:58 PM screenshots

**Observed, reconstructed from the records above (not independently re-run — the issue itself
states "no live reproduction was performed" for its 2026-10-01 findings; this section traces the
same mechanism against current code).**

1. User delegates work from a Claude conversation (`aw delegate`); `Mission.origin` records
   `{provider: 'claude', sessionId, turnStartedAt}` (`types.ts:296`).
2. The mission runs to completion and is merged (`finish: 'merge-local'`); `missionPhase` yields
   `integrated`, text `"merged · unverified · closeout: yours"` (`delegatedState.ts:239-245`,
   confirmed against status-contract §11's "merged · unverified · closeout: yours" wording).
3. The Missions pane, reading the same `missionPhase`, shows the mission as `completed`, `1/1
   done`, with its expanded detail showing the `stateReason`/`finishResult.note` ("merged into
   main") — `src/orchestration/view/missionViews.ts` `missionChips`/`missionStateLabel` paths.
4. The child task's row reads `done · ? unverified`: `taskPhase` → `done` (`delegatedState.ts:354`)
   and the verification badge's `?` glyph for `unverified` (`verification.ts:783`, `GLYPH` map).
5. The origin conversation's header still says **Waiting**, and its last visible reply is the
   stale "Waiting for your approval…" message, because nothing wrote a new turn (§1.1) — the
   *transcript* is unchanged (H1 holds), and whether the *row/header* itself has cleared depends on
   W3's keying (§6, K2): if the origin session's `turnStartedAt`/`progress.startedAtMs` could not
   be read for this provider/session, `keying()` (`delegatedState.ts:411-416`) marks the mission's
   keying `estimated`, which still counts as `keyed`, so W3 **should** apply and clear a stale
   `waiting` once the mission is `integrated` and needs nothing. The issue's screenshot shows a
   row that still reads Waiting after the merge, which is either (a) a timing gap before
   re-derivation ran, (b) a repro taken on a build before #101 shipped this derivation, or (c) a
   live gap in provider turn-start signals this document cannot resolve by static reading alone.
   This is a **Hypothesis**: the static evidence explains *why a user could see* a stale Waiting
   header (nothing rewrites it, by design — H1), but does not by itself explain a *row* that fails
   to flip once a correct `LinkedWork` is keyed; that needs a live run, which is #118's job, not
   this document's.
6. The user reports the linked GitHub issue remains open — consistent with C3 (`closeout: 'yours'`
   is unconditional; `src/orchestration/**` and `src/shared/**` contain no GitHub client, confirmed
   by grep: no `octokit`/`gh issue` call anywhere under `src/`).

### 1.3 Reproducing the 2026-09-29 11:38 PM repro (two missions, one origin)

**Observed mechanism, same static method.**

1. A proposal-only mission (planned, kept as one task, never started —
   `isOpenProposal`/`isOpenDelegation`, `delegatedState.ts:167-179`) and a later corrective
   implementation mission both carry the *same* `origin` (`{provider: 'claude', sessionId}`).
2. `linkedWorkFor` lists **both** as separate `LinkedWork` entries keyed by `missionId`
   (`delegatedState.ts:438-459`); nothing merges or overwrites one mission's entry with another's
   — each is looked up and rendered by its own `missionId` (`MissionPhaseView.ref.missionId`,
   `WaitRef.missionId`). The issue's regression requirement ("multiple missions originating from
   one conversation must not overwrite or misassociate results") is **Confirmed as already true of
   the data model**: `latestMissions` (line 428) dedupes only by `m.id` (one record per mission id,
   keeping the newest write), it never collapses across different mission ids.
3. The row's single visible chip is the "headline" entry (`headlineOf`, line 462): needs-you first,
   then the newest. With the corrective mission `integrated` (terminal, no `needsYou`) and the
   proposal-only mission still `awaiting-approval` (`needsYou: true`), the *proposal* would in fact
   rank first by `headlineOf`'s own rule (`needsYou` beats everything), which **could explain**
   part of the screenshot: the user sees a Waiting/approval chip for the *older, unrelated*
   proposal mission even though the *newer* corrective mission already finished — the two are
   correctly kept apart as records, but the *single-chip summary* surfaces the one that still
   needs a decision, which may not be the one the user is currently thinking about. This is
   **Hypothesis**: it is consistent with the repro but not proven by a live run.
4. Whether the origin's own primary `status`/wait (not just the linked-work chip) correctly
   resolves to "nothing outstanding for *this* reply" once the corrective mission integrates is the
   same W3/K2 question as §1.2 point 5, and is equally unresolved by static reading alone.
5. **Confirmed against the issue's static finding:** "Linked terminal summaries expire after 24
   hours" — `LINKED_TERMINAL_WINDOW_MS = 24 * 3_600_000` and `listed()` (`delegatedState.ts:93,
   419-421`) drop a terminal mission from the summary a day after its last write. A user who looks
   later than that sees neither mission's outcome in the summary at all, though the mission record
   itself is retained (`MissionStore.list()` still returns it; only the *linked summary* window
   expires).
6. **Confirmed:** "`MissionStore.loadActive` excludes terminal records" (`missionStore.ts:95-96`,
   comment "Every mission not yet in a terminal state, for recovery"). **Confirmed:** this means
   `TaskRunner.recover()` (`taskRunner.ts:2718` `recover()`) never re-touches a `completed` mission
   after a restart — recovery exists to finish *unfinished* work, not to re-deliver *finished*
   results. Combined with the 24-hour window, a restart that happens more than a day after a
   mission finished, with the user never having seen the result, currently has **no path** back to
   that result for the origin conversation (the mission record itself is still readable from
   Missions, which does not apply the 24-hour window — `MissionsSnapshot` in
   `src/shared/orchestration/missionView.ts` is driven by `tasks.list()`, not `linkedWorkFor`).

### 1.4 Issue's static findings, checked against current code

| # | Issue's claim (2026-10-01 note) | Verdict | Where checked |
|---|---|---|---|
| 1 | "mission finish -> persisted state/change event -> origin index/status/card/notice" | **Confirmed** | `delegatedState.ts` `missionPhase`/`linkedWorkFor`/`deriveSessionState`; `createApp.ts` linked-work wiring |
| 2 | "No durable parent result consumption or closeout controller exists" | **Confirmed** | No file under `src/orchestration/**` or `src/app/**` sends a message into an origin session on mission completion; no GitHub client anywhere in `src/` |
| 3 | "`MissionStore.loadActive` excludes terminal records; `TaskRunner.recover`/`list` therefore omit completed records after restart" | **Confirmed**, with a correction: `TaskRunner.list()` (`taskRunner.ts:452`) returns **every** mission including terminal ones (it is `loadActive` specifically, used for *recovery*, that excludes them) — Missions and the linked-work summary both still see terminal missions (subject to the 24h window for the latter) | `missionStore.ts:95-96`, `taskRunner.ts:452` |
| 4 | "Linked terminal summaries expire after 24 hours" | **Confirmed** | `LINKED_TERMINAL_WINDOW_MS`, `listed()` |
| 5 | "closeout is fixed to yours" | **Confirmed** | `LinkedOutcome.closeout: 'yours'` is a literal type with one value; `outcomeOf()` always sets it |
| 6 | "The integrated boolean includes kept branches and opened PRs" | **Confirmed** | `outcomeOf`: `integrated = m.state === 'completed' && m.finish !== undefined && m.finish !== 'discard'` — true for `merge-local`, `pull-request`, and `keep` alike |
| 7 | "Final Git/PR effects precede final finish persistence" | **Confirmed as an ordering risk, not a bug demonstrated live**: `MissionFinisher.mergeLocal`/the PR path (`engine/missionFinish.ts`) runs `git merge`/`gh pr create` and returns a result that the *caller* then persists into `Mission.finish`/`finishResult`/`state: 'completed'`. A crash between the external effect and the persistence write would leave a merged branch or opened PR with no mission record saying so. §23.2's write-ahead discipline (`docs/plans/intelligent-orchestration.md` §23.2/§23.3) covers the *mission-branch* integration path (`pendingMerge`) but this document found no equivalent write-ahead for the *finish* (merge-to-base / PR) step itself — **Hypothesis**, worth a #115/#117 recovery check, not refuted by this reading | `missionFinish.ts`, `types.ts` `Mission.finish`/`finishResult` |
| 8 | "Session send IDs exist, but provider-specific receipt/deduplication guarantees require testing" | **Confirmed as an open question** | `ExecutionAttempt.sentIds`, `AttemptContext` exist (`types.ts:782-785`); no test in `test/` asserts provider-level dedupe of a delivered result message (distinct from a *prompt* send) because no such delivery exists yet to test |

---

## 2. Four approaches, compared

| | **Permanent supervisor** | **Worker-owned closeout** | **Poll-only status** | **Hybrid (recommended)** |
|---|---|---|---|---|
| What it is | A long-running lead agent/session watches every delegated mission and decides what to do about results, continuously | The child task's own agent is trusted to merge, verify and close the GitHub issue itself when it finishes | AW never pushes anything into a conversation; the user must open Missions/Status to see outcomes, as today plus better labels | AW's own state (not a model) persists ownership, results and action obligations; the *existing* origin session is resumed for a bounded, event-triggered follow-up turn; external actions require deterministic evidence/authorization gates |
| UX | One conversation to watch, in principle — but needs a live session running at all times to "supervise", which this app does not keep around for idle origins | Feels fast when it works, but the user never agreed to let a worker close their issue, and a worker that merges *and* closes on its own authority removes the one check the whole contract exists to keep (C1≠C2≠C3) | Correct and honest about what AW knows, but reproduces exactly the screenshot problem: the user has to go find out, in a different pane, that is the complaint #102 opened to fix | The user's own conversation gets the result where they are, without AW inventing a new "mode" or a standing process |
| Cost | A kept-alive model turn per mission, running even when nothing changed, to "watch" — the opposite of event-triggered | None extra (the worker already ran) | None extra | One bounded follow-up turn per mission-completion event, only when something meaningful happened |
| Reliability | A supervisor that is itself a model can misreport, hallucinate a closeout, or stall; it is one more component with its own crash/restart story | Reliable at merging, unreliable at judging whether *closing an issue* was authorized — the worker's job was the code, not the accountability decision | Fully reliable (it does nothing), unhelpfully so | AW's deterministic state is the single source of truth for *whether* a follow-up is owed; the model turn only explains it in words, it does not decide policy |
| Context | A supervisor needs the full history of every mission it watches, which grows without bound | None needed beyond the one mission | None | The origin's own existing context, plus a small structured payload (§4) — no new context store |
| Harness support | Requires a harness capability ("keep a session alive and polling") neither Claude Code nor Codex is documented to offer outside an active turn | Requires granting a worker credentials/scopes (gh auth, issue-close rights) that today's permission posture (`intelligent-orchestration.md` §24.1) explicitly does not extend to attempts | Needs nothing from the harness | Uses the harness capability that *already exists* for both providers: resuming an idle session and sending it a new prompt (`runners.resume`, `src/orchestration/harness/*`), which is exactly what escalation's `continue` and reuse's `reuse` already do for worker sessions — not a new capability, a new *trigger* for an existing one |
| Broadens worker authority? | N/A (the supervisor is new infrastructure, not the worker) | **Yes** — explicitly what the issue says not to do ("Do not broaden worker authority simply to fix handback") | No | **No** — the follow-up runs in the *origin's* session under the *origin's* existing permission posture, which the user already trusts with GitHub access if they ever gave it any; the worker's own authority is untouched |

**Recommendation: the hybrid.** It is the only option that:

- needs no new standing process (no permanent supervisor to crash, restart, or burn tokens while
  idle);
- does not move authority onto the worker (closing-out stays something only an *origin*
  conversation or the user does, never the attempt that produced the code);
- reuses infrastructure that is already built and tested (`reuse`/`continue` assignment modes,
  §22.1 of `intelligent-orchestration.md`; resumable sessions, status-contract §13.1-13.3) rather
  than inventing a new orchestration mode;
- keeps AW's own records, not model memory, as the durable fact of what is owed (the issue's own
  requirement: "Model memory alone must not be the only record of mission ownership").

---

## 3. Decisions (2026-10-01, DECIDED — not open questions)

These three were approved by the user on 2026-10-01 and are not revisited here; they are recorded
as settled inputs to the design below, matching the issue's product questions 1 and 4 and its
2026-10-01 research note:

- **D1 (issue product question 1).** Any ordinary conversation keeps accountable ownership when
  it delegates. There is no separate "orchestrator mode" to opt into; every `aw delegate`/`aw
  task` origin is, from the moment it delegates, the conversation accountable for that mission's
  outcome, exactly as it is today for its *own* unfinished replies.
- **D2 (issue product question 4, part 1).** A meaningful result (defined in §4 below as a
  terminal mission state the user has not yet seen) automatically triggers a bounded parent
  follow-up turn in the origin session, and updates the origin's live card immediately — the
  derived-state chip already does this (§1.1 step 3-4); the follow-up turn is new.
- **D3 (issue product question 4, part 2).** While the origin is busy (mid-turn), the follow-up is
  queued rather than interrupting it or being dropped; it runs once the origin's current turn
  ends. An origin that cannot be resumed at all — unsupported harness, archived, ended, or
  deleted — keeps a **visible obligation**: the result is not silently lost, it is shown wherever
  the user can still find it (Missions, and a standing "needs a home" indicator; §6).

---

## 4. Lifecycle and ownership transitions

Four facts, never collapsed into one "done" (status-contract §11's C1-C3, extended here with the
fourth, user-facing fact this issue adds):

| Step | Who decided it | Owner from here | What is now allowed | What is still not allowed |
|---|---|---|---|---|
| **Worker done** | Verification (`summariseVerification`) or the user (`acceptedBy: 'user'`) | The mission's origin conversation (D1) | Integrate (merge/PR/keep) or discard | Close the GitHub issue; the task's own agent authorizing anything past its worktree |
| **Mission integrated** (C1) | The user's finish choice (`finish`) | Origin conversation | Report the result to the origin (D2); request further review | Treat "merged" as "verified" or "closed"; auto-close an issue off a merge alone |
| **Verified** (C2) | Required checks (`summariseVerification`) or explicit user acceptance | Origin conversation | Use "verified" as one input to a closeout decision | Substitute `noChecks` unverified for a pass |
| **Outcome closed** (new, this document's C4) | The user, or AW acting on an explicit, evidenced authorization the user gave for *this* objective (§7) | Nobody further — terminal | Record the closeout and its evidence | Retroactively authorize a closeout the user did not grant for this mission |

A mission can sit at "integrated" indefinitely with C4 never reached — that is a completely valid
end state (most delegated missions probably end there: merged, verified, and the user closes the
ticket by hand or decides the ticket is still open on purpose, e.g. this very issue). The contract
exists to make that state **visible and owned**, not to force every mission to reach C4
automatically.

---

## 5. The completion payload

**Reuse before invention.** The fields below are drawn from records that already exist; only
`DelegationOutcome` (the envelope) and its `obligation`/`delivery` sub-fields are new.

| Field | Source (reused) | New? |
|---|---|---|
| `missionId`, `title` | `Mission.id`, `Mission.title` | no |
| `origin` (`provider`, `sessionId`, `turnStartedAt`) | `Mission.origin` | no |
| `outcome.integrated`, `.finish`, `.mergeCommit`, `.pullRequestUrl` | `LinkedOutcome` (C1), `missionview`/`delegatedState.ts` | no |
| `outcome.verification`, `.noChecks` | `LinkedOutcome` (C2) | no |
| `outcome.closeout` | `LinkedOutcome` (C3) — widened from the literal `'yours'` to the richer `CloseoutState` below | widened |
| `remainingWork` | derived from `missionTaskCounts`/task states not `done`/`skipped` | no (assembled from existing fields) |
| `linkedIssue` | **new** — the repo/issue reference the objective named, if any (today nowhere persisted: `Mission.source: { kind: 'issue', ref? }` exists but `ref` is optional and unvalidated) | partly new (formalizes an existing but unused field) |
| `commits`/`pullRequestUrl` | `Mission.finishResult` | no |
| `verificationEvidence` | `ExecutionAttempt.verification: VerificationResult[]` summarised via `summariseVerification` | no |

```ts
/** v1. Versioned: a consumer reads `v` before anything else; unknown versions are shown as unknown, never guessed (U1). */
export interface DelegationOutcome {
  v: 1;
  missionId: string;
  title: string;
  origin: { provider: 'claude' | 'codex'; sessionId: string; turnStartedAt?: number };
  outcome: LinkedOutcome;              // C1, C2 — unchanged shape
  closeout: CloseoutState;             // C3/C4 — see §7; replaces the literal 'yours'
  remainingWork: { taskId: string; key: string; title: string; state: TaskState }[];
  linkedIssue?: { repo: string; number: number; url: string };
  evidence: {
    commits?: string[];
    pullRequestUrl?: string;
    verification: { strategy: string; outcome: VerificationOutcomeKind; summary?: string }[];
  };
  /** D2/D3: what AW still owes the origin for this outcome. */
  obligation: FollowUpObligation;
  createdAt: number;
}

/** D2/D3 delivery bookkeeping — durable, not model memory. */
export interface FollowUpObligation {
  state: 'pending' | 'delivered' | 'queued' | 'undeliverable';
  /** Why `undeliverable`: 'unsupported-harness' | 'archived' | 'ended' | 'deleted' | 'no-signal' | 'user-released' (§10, Q5). */
  reason?: string;
  deliveredAt?: number;
  /** The origin turn this answers (K2, status-contract §6), when known. */
  answersTurnStartedAt?: number;
}
```

`outcome` keeps `LinkedOutcome`'s exact shape (no breaking change to #101's consumers); `closeout`
is a new top-level field rather than widening `LinkedOutcome.closeout` in place, so existing
derived-state consumers that read the `'yours'` literal are untouched, and `#114` can introduce
`CloseoutState` without a migration of `delegatedState.ts`.

This is the shared contract: **#114** builds the domain/store half (`DelegationOutcome`,
`FollowUpObligation`, persisted per mission, durable across restart); **#105** is the origin-side
consumer that turns a `DelegationOutcome` with `obligation.state === 'pending'` into the bounded
follow-up turn (D2/D3) and marks it `delivered`.

---

## 6. Durable ownership and idempotent delivery

| Case | Fallback |
|---|---|
| **Duplicate delivery** (the same mission-completion event processed twice, e.g. after a restart) | `DelegationOutcome` is written once per `missionId` (one record, like `Mission` itself — one writer, "load, replace one", `intelligent-orchestration.md` §23.1). `obligation.state` is the single source of truth: a second attempt to deliver sees `delivered` already and no-ops. Same pattern as `latestMissions`' id-keyed dedupe (`delegatedState.ts:428`). |
| **Out-of-order events** (a later mission's completion observed before an earlier one's) | Each `DelegationOutcome` is independent, keyed by its own `missionId`; nothing here requires processing order, matching the existing rule that `linkedWorkFor` keeps the newest write *per mission id* and never compares across ids. |
| **Restart mid-delivery** | `obligation.state` starts `pending`, flips to `delivered` only after the origin's follow-up turn is confirmed ended (the same turn-completion signal `TurnRecord`/`turn/completed` already provides, status-contract §13.1-13.3). A crash between "mission finished" and "turn delivered" leaves `pending`; recovery (§23.3, extended by #116) retries exactly once more, the same one-shot discipline `autoRecover` already uses for interrupted attempts (`intelligent-orchestration.md` §23.3, "one automatic resume … never after a host crash" is the wrong precedent to copy literally — here recovery *should* retry across a crash, since nothing destructive happens by re-delivering a `pending` obligation; the idempotency is in `obligation.state`, not in refusing to retry). |
| **Origin archived/ended/deleted** | `obligation.state = 'undeliverable'`, `reason` set. The outcome is not lost: it stays attached to its `missionId` and surfaces in Missions and the "needs a home" indicator (§3, D3) regardless of the origin's fate — ownership of the *record* is AW's store, not the conversation's liveness. |
| **Several missions per one origin** | Each gets its own `DelegationOutcome`; D2/D3's queue (below) holds as many pending follow-ups as there are missions. The headline/row chip still shows one summary (`headlineOf`, unchanged), but the queue itself has one entry per mission, not one slot total. |
| **Busy origin** | D3: the follow-up is appended to a per-origin FIFO queue, delivered as separate bounded turns once the origin is idle, oldest-pending-mission first (matching `linkedWorkFor`'s existing oldest-first ordering, line 458). No turn is ever injected mid-turn. |
| **Retries** | A follow-up turn that itself fails to send (harness error, not a content problem) is retried with the same backoff discipline escalation already uses (`EscalationDecision.notBefore`, `intelligent-orchestration.md` §15.2) — reusing the ladder's timing concept, not its model-escalation actions. |
| **Cancellation** | If the user cancels/archives the origin conversation before its follow-up queue drains, every `pending`/`queued` obligation for that origin flips to `undeliverable` (`reason: 'archived'`); nothing is sent into a conversation the user has put away. |

---

## 7. GitHub closeout policy

**Agent Wrangler closes no GitHub issue by default** (status-contract C3, unconditional today).
This document defines the only path by which that becomes conditional, without broadening *worker*
authority:

```ts
export type CloseoutState =
  | { kind: 'yours' }                                                  // default, unconditional today
  | { kind: 'permitted'; evidence: CloseoutEvidence }                  // conditions below all hold
  | { kind: 'deferred'; missing: string[] }                            // conditions partially hold
  | { kind: 'refused'; reason: string };                               // conditions cannot hold

export interface CloseoutEvidence {
  linkedIssue: { repo: string; number: number };
  integrated: true;                 // C1
  verification: 'verified';         // C2, strict — 'unverified' never qualifies, `noChecks` included
  authorizedBy: 'objective';        // the *objective the user gave this mission* named closing the issue — never inferred
  mergeCommitOrPr: string;
  auditedAt: number;
}
```

**Permitted** only when **all** of:

1. The mission's objective (the user's own words, `Mission.objective`/`delegation.acceptanceCriteria`)
   explicitly named closing this GitHub issue as part of the outcome — never inferred from a
   linked issue merely existing. This is the same rule status-contract §11 already states for C3
   ("A worker finishing, a mission merging or a result verifying is neither permission nor evidence
   to close one") extended with the one case that *does* count: the user asked for it, in this
   mission's own objective.
2. C1 holds (`integrated: true`) and C2 is strictly `'verified'` (never `'unverified'`, including
   the `noChecks` case — a repository with no configured checks can never authorize a closeout by
   itself).
3. A linked issue reference exists and resolves (repo + number the objective named, or a
   `Mission.source.ref` the user supplied when delegating from an issue) — a closeout with no
   addressable issue is `refused`, not silently skipped.
4. `gh`/the stored credential actually has close permission on that repo — a capability check, not
   an assumption; missing or refused permission is `deferred`, with the specific missing condition
   named (`missing: ['credential']`), never silently downgraded to `yours`.

**Deferred** when 1-3 hold but 4 does not (or evidence is present but incomplete, e.g. verification
is still running): left open, the obligation (§5) says what's missing, and the user can retry once
it's fixed.

**Refused** when the objective never authorized closeout, or no issue reference exists: this is not
an error state, it is the common case: most objectives never ask AW to close anything.

**Audit trail.** Every `permitted` or attempted closeout writes an `IntegrationRecord`-shaped
telemetry entry (reusing `intelligent-orchestration.md` §16.2's existing telemetry discipline:
metadata only, an id, idempotent) recording `missionId`, the evidence snapshot above, and the
`gh`/API call's own result — success, or the specific rejection. This is the retry path: a
`deferred` or failed closeout is retried by the same obligation-queue mechanism as §6, never
auto-retried silently in the background without the user having asked once.

**Workers get no extra authority.** None of the four conditions, nor the capability check, nor the
audit write, run inside an attempt's worktree or session. They run in AW's own core, against AW's
own stored mission record, exactly where C1-C3 are already decided today. A task's own agent is
never granted `gh issue close` scope by this document, matching the issue's explicit instruction
not to broaden worker authority to fix handback, and matching the existing permission posture
(`intelligent-orchestration.md` §24.1: attempts never inherit a broader mode than their ceiling).

---

## 8. Status-only vs. orchestration work

| Area | Owner | What it covers |
|---|---|---|
| **#100/#101 (status-only, shipped)** | Status contract | What a row/mission/task *currently is* — primary status, wait reason, linked-work phase, the C1-C3 facts as read-only labels. No delivery, no ownership, no closeout logic: purely a derivation of existing records, recomputed on every read, nothing persisted that didn't exist before. |
| **#102/#111 (orchestration, this document)** | This contract | Whether and how a *result reaches the origin as a new turn* (not just a label update), what AW durably owes an origin after delegating, and the one conditional path to GitHub closeout. Adds new persisted state (`DelegationOutcome`, `FollowUpObligation`) and a new triggered behavior (bounded follow-up turns) that #100/#101 deliberately left out. |

The boundary: #101 answers "what does the user see right now if they look," passively; #102
answers "does AW ever act on their behalf to make sure they see it, and what is AW allowed to then
do about it."

---

## 9. Implementation slices (#114-#118)

| Slice | Scope | Acceptance criteria | Depends on |
|---|---|---|---|
| **#114** — ownership and versioned result domain/store | `DelegationOutcome`, `FollowUpObligation`, `CloseoutState` types (§5, §7); a store keyed by `missionId`, one writer, atomic write, restart-durable (same discipline as `MissionStore`) | A mission reaching a terminal state (integrated/failed/cancelled) produces exactly one `DelegationOutcome` record, idempotently, surviving a restart; `#105` and `#117` can read it without reaching into `Mission` internals | #101 (derived phases), `intelligent-orchestration.md` §23.1 persistence pattern |
| **#115** — terminal recovery, persistent cards and outstanding-work fallback | Fix the gap in §1.3 point 6: expose terminal missions (and their `DelegationOutcome`) to recovery and to a persistent "needs a home" card that does not expire with the 24h linked-work window | A mission that finished more than 24h ago, or across a restart, is still discoverable from the origin's row/Missions with its outcome intact; recovery (§23.3) re-checks `pending` obligations once | #114 |
| **#116** — durable delivery and automatic bounded parent continuation | The D2/D3 behavior: resume the origin (idle) or queue (busy) and deliver a bounded follow-up turn carrying the `DelegationOutcome`; mark `delivered`; handle `undeliverable` (§6) | A terminal, unseen mission produces exactly one delivered follow-up turn per origin turn-start boundary (K2), queued correctly under a busy origin, marked `undeliverable` for an archived/ended/deleted origin, with no duplicate turns across a restart | #114, the `reuse`/`continue` resume capability (§22.1), status-contract K2 |
| **#117** — authorized evidence-gated GitHub closeout | The §7 state machine and its capability check, audit telemetry, and the retry path | A closeout only ever reaches `permitted` when all four §7 conditions hold, verified by tests for each condition failing individually (never defaults to permitted); every attempted closeout, success or not, is audited | #114, #116 (closeout often rides the same follow-up turn that reports the result) |
| **#118** — cross-component failure simulations and end-to-end UX validation | The live screenshot-journey demonstration: proposal-only mission → corrective mission → approval → execution → merge → origin reconciliation, across Status/Missions, surviving a restart, with the two/four repros from §1.2-§1.3 run live, not just read statically | The exact sequence in the issue's "Regression requirements" passes live, including the switching-between-Status/Missions and restart-recovery cases; **this is validation of #114-#117** — #102 itself closes on its documentation deliverables (this document and the §10 decisions, complete 2026-10-02), per the issue's own instruction; the live demonstration is owned here |

---

## 10. Product questions 2, 3, 5, 6, 7 (DECIDED 2026-10-02)

Pulled directly from the issue's "Product questions to answer with the user" (1 and 4 were
decided on 2026-10-01, §3). The user accepted each recommendation below as written on
2026-10-02; these are now settled inputs for #114-#118, not open questions.

| # | Question | Decision |
|---|---|---|
| **2** | What does the parent own after delegation: summarize, validate evidence, request review, integrate, close issues, propose further tasks? Which are deterministic and which warrant another model turn? | **Decided.** Summarizing the result and validating evidence against §7's conditions are **deterministic** (AW's own code, no model call — matches "deterministic evidence/authorization gates" from the issue's own research note). Requesting review, drafting a closeout comment, and proposing further tasks are **model-turn** work (the bounded follow-up turn of §6/#116), because they involve judgment and natural language the user reads. Integration (merge/PR) stays exactly where it is today — a user click on a `MissionOp` (`finish`), never automatic. |
| **3** | What should the user see when code is merged but verification or external closeout remains outstanding? | **Decided.** The existing C1-C3 text (status-contract §11, unchanged) *plus* the `DelegationOutcome`/`obligation` surfaced as a persistent card (not just a toast) in the origin and in Missions, worded as a to-do, e.g. "Merged · unverified (no checks configured) · closing the issue needs your say-so" — rather than inventing new status vocabulary. |
| **5** | How are multiple missions represented without overwhelming the conversation, and how does the user transfer or end ownership? | **Decided.** Keep the existing single-headline-chip-plus-"+N" pattern (`headlineOf`, unchanged) for the row; the conversation's own delegated-work strip lists every `LinkedWork` (already built). To end ownership: a single explicit action on a `LinkedWork` entry — "Stop tracking" — that sets `FollowUpObligation.state: 'undeliverable'` with `reason: 'user-released'` (added to §5's reason list) rather than silent abandonment. No transfer between conversations, since nothing in this codebase has a notion of "the other conversation" to transfer to. |
| **6** | When issue closure was part of the authorized objective, can the parent perform it automatically once its conditions are met? What should happen when permissions, credentials or evidence are missing? | **Decided: §7 as written.** Automatic only when all four conditions hold (objective said so, C1+strict C2, a resolved issue reference, and a working credential); missing permissions/credentials/evidence always produce `deferred` with the specific gap named, never a silent `refused`-as-`yours` downgrade. |
| **7** | What notification should appear, and where, if the origin is unavailable or follow-through fails? | **Decided.** Reuse the existing OS notification mechanism (`linkedNotices`, N1 dedupe) for the *first* occurrence of `undeliverable`, worded "Delegated work finished, but its conversation is gone — see Missions"; subsequent occurrences (e.g. repeated restarts) do not re-notify (N1's existing dedupe-by-key discipline), relying instead on the persistent card in Missions (#115) as the durable record so the user is never notification-spammed for one stuck obligation. |

---

## 11. Summary for #114/#105

#114 owns: `DelegationOutcome`, `FollowUpObligation`, `CloseoutState` (§5, §7), their persisted
store (one record per mission, restart-durable, idempotent by `missionId`), and the state
transitions in §6. #105 owns: turning a `pending` `DelegationOutcome` into the bounded,
event-triggered follow-up turn in the origin session (§4 D2/D3, §6's queueing/busy/undeliverable
handling), reusing the existing `reuse`/`continue` resume capability rather than any new harness
feature. Neither creates a permanent supervisor, and neither broadens what a worker attempt is
authorized to do (§7's closing sentence; status-contract §24.1 is unchanged by this document).

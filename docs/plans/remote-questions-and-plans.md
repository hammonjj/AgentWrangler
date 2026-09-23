# Mirroring questions and plan approvals

**Status:** proposed. Sibling of `remote-agent-control.md`, which built the permission mirror and
deferred this ("§6 — when questions and plan approvals are supported"). Read that first; this plan
assumes its vocabulary (`RemoteAsk`, `remoteAskFor`, the reconciler, the mirror map) and changes
only what it has to.

**Scope of this slice:** buttons only, no free text. A runner-owned `AskUserQuestion` whose shape
fits buttons is answerable from Discord; an `ExitPlanMode` is approvable from Discord. Everything
that needs typing — the *Other* box, multi-select, plan feedback — is **mirrored read-only** with a
line saying to answer at the machine. Select menus and modals are a later slice and no part of the
design here forecloses them.

---

## 0. What changed since the deferral

The plan deferred this on one argument (`remote-agent-control.md` §6): a question lives in one
process's heap with no marker, so only the owning window can invoke it, and therefore mirroring it
needs "a lease or a small IPC". That argument is now mostly spent, for two reasons.

**There is one process.** The VSCode extension is gone and the app holds a single-instance lock.
The process that owns every `RunnerSession` is the process that holds the Discord transport. The
cross-window story the deferral was waiting on is not a story any more — it is an invariant, and
`AgentSession.runnerOwned` is the predicate that states it. The lease stays cut; §6's "if that
changes, this is where it hooks in" is still the right note to leave.

**Half of it was built for the dashboard.** `AgentSession.pendingQuestion` already exists —
`{requestId, questions: QuestionView[]}`, decorated in `DashboardHost` from
`RunnerOwnership.pendingQuestion(sessionId)` — and the dashboard row already answers it in place
through `{type:'answerQuestion'}` → `runners.answer(...)`. The question is already a projected,
wire-safe value; it simply never reaches the remote layer.

So what is left is smaller than the deferral implies: get the runner's pending asks in front of the
reconciler, widen `RemoteAsk` from one kind to three, and route a press to the right resolver.

---

## 1. Four defects this has to fix first ✅ done

Landed on `main`. `src/core/sessionView.ts` (`decorateSession`, `DecoratedSessions`) with
`test/sessionView.test.ts`; `Mirror.kind` with its load-time migration; the `CHOICE_ID` alphabet.

These are all pre-existing, all in the path this work walks through, and all are cheaper to fix
before the widening than after. **They land first, on `main`, as their own change** — the same
discipline `remote-agent-control.md` §7 used.

### 1.1 The remote service never sees `archived` or `paused` ✅

`remoteAskFor` documents two exclusions at length:

> **archived** sessions are skipped … **paused** sessions are skipped, matching the status-bar bell:
> a frozen process cannot act on an answer until it is resumed.

Both are dead code. `RemoteControlService` is constructed over `store` (`createApp.ts:1135`), and
`SessionStore.decorate` (`sessionStore.ts:112`) applies only the nickname and the Codex live-session
overlay. `archived` and `paused` are decorated in `DashboardHost.pushSnapshot`
(`dashboardHost.ts:171-186`), which the remote layer does not go through. **Today, pausing every
agent on the machine still leaves their permission prompts live in Discord, with buttons that
resolve into a stopped process.** That is exactly the failure the comment says it prevents.

The fix is the same object this feature needs anyway (§2): one decorated snapshot, shared.
Built as `DecoratedSessions` in `src/core/sessionView.ts`, subscribed to the archive and the pause
service as well as the store, so pausing an agent closes its mirrored prompt at once.

### 1.2 `useLiveSessions` covers Codex runners but not Claude ones — noted, not fixed

`store.useLiveSessions` (`createApp.ts:197`) returns a live session only for
`provider === 'codex'`. A Claude `RunnerSession`'s state reaches the dashboard through
`DashboardHost`'s own decoration instead. Not a bug on its own, but it means there is no single
place where "what the runner currently knows" is true, which is why 1.1 exists. Worth noting rather
than fixing: §2 adds the missing place without moving the Codex overlay.

### 1.3 The mirror map does not remember what kind of ask it was ✅

`closeMirror` renders the closing message from `placeholderAsk(mirror)`, which hard-codes
`kind: 'permission'` because there is nothing else it could be. With three kinds, a closed question
that says "✅ Allowed" is wrong. `Mirror` must persist `kind` (and, for a question, the label that
was chosen) — and `MirrorStore.load` must tolerate records written by an older build that have
neither. It is a cache under `~/.cache/agent-wrangler/remote/`, so "treat a record with no `kind` as
a permission" is a sufficient migration.

### 1.4 `CHOICE_ID` has no digits ✅

`ids.ts:25` — `/^[a-z][a-z-]{0,23}$/`. Option choice ids want an index (`opt3`). Widen to
`/^[a-z][a-z0-9-]{0,23}$/`, which keeps the property the comment cares about (bounded, lowercase, no
separator that could impersonate the three-field shape) and is still not a place authority can hide.

---

## 2. The one thing that actually unblocks this: a decorated snapshot

`RemoteControlService` takes a `SessionSnapshot` — `{ sessions, onDidUpdate }` — and that interface
is already exactly right. It just gets handed the wrong object.

Add, in `createApp.ts`, next to where `remoteControl` is built:

```ts
/**
 * The store's sessions, plus the decorations a remote surface must respect:
 * whether the user has shoved a session aside, whether its process is frozen,
 * and what this window's runners are currently waiting on. The dashboard
 * decorates its own snapshots the same way; this is the second consumer, and
 * the reason the fields exist on the DTO at all.
 */
function decoratedSnapshot(...): SessionSnapshot
```

which yields, per session: `archived`, `paused`, `runnerOwned`, `pendingQuestion`, `pendingPlan`
(§3), and fires `onDidUpdate` on **both** `store.onDidUpdate` and `runnerOwnership.onDidChange`.

That second subscription is load-bearing and easy to miss. A question appearing in a runner does not
touch the store: it is not part of `materialFingerprint`, and `SessionStore` never learns about it.
Without forwarding `runners.onDidChange`, a mirrored question would publish only when something
*else* moved the session. `DashboardHost` already has this wiring; the remote layer needs its own.

**Liveness comes free.** The permission path needs `pendingRequestExists` to know the hook script is
still waiting, because the marker is the only evidence. A runner ask needs nothing equivalent: the
decorator re-reads `runner.pendingQuestion` on every snapshot, and the moment `settle()` runs — from
Discord, from the pane, from the SDK's own abort — it is gone. The ask leaves the desired set and
the reconciler closes the message. That is a *stronger* guarantee than the permission path has, and
it means no new liveness concept is introduced.

**No `pendingPlan` on `SessionDTO` yet.** `RunnerSession` has `get pendingQuestion()`; it needs the
symmetric `get pendingPlan()` over `{kind:'plan', state:'pending'}` blocks, `RunnerOwnership` needs
`pendingPlan?(sessionId)` and `decidePlan?(sessionId, requestId, approve, feedback?)`, and
`AgentSession` needs `pendingPlan?: {requestId, plan, more?}`. `RunnerSession.decidePlan` already
exists (`runnerSession.ts:441`); nothing new is invented below it. Codex has no plan concept, so its
accessor returns `undefined` and the dashboard gains the same card for free.

---

## 3. `RemoteAsk` becomes a union

Today `kind: 'permission'` is a literal with a comment calling itself the seam. Cash it in.

```ts
export type RemoteAsk = RemotePermissionAsk | RemoteQuestionAsk | RemotePlanAsk;
```

All three keep `askKey`, `sessionKey`, `requestId`, `title`, `context`, `choices` and gain
`note?: string` — one line rendered in the embed for what this card *cannot* do. Each narrows
`choices[].action` to its own verbs:

| kind | `requestId` is | choice actions | `subject` / body shown |
|---|---|---|---|
| `permission` | the hook marker id (`<ppid>-<pid>`) | `allow` · `always` · `deny` | `PermissionAsk`, unchanged |
| `question` | the SDK `options.requestId` | `opt0`…`opt4`, or none | the question text and the option descriptions |
| `plan` | the SDK `options.requestId` | `approve`, or none | the plan markdown, capped |

`askKey` stays `${sessionKey}#${requestId}`. The two id spaces cannot collide — a marker id is
`\d+-\d+` and an SDK request id is not — and even if they could, `sessionKey` disambiguates and the
kind is re-derived from live state on every press.

`RemoteChoice.action` is currently typed `DashboardAction` with a comment insisting a transport
"never invents a verb". That principle survives: `opt2` is not a remote-only verb, it is an index
into the ask's own option list, resolved locally to the same `answers` record the dashboard's
stepper posts. Type it as a union per kind, not as `string`, so `applyInvocation`'s switch is
exhaustive.

### 3.1 When a question is mirrored with buttons

`remoteQuestionAskFor` offers buttons only when every one of these holds:

- `runnerOwned` — this process can resolve it (§0);
- exactly one entry in `questions[]` — the pane renders several as a stepper, and a stepper is not
  a thing a static message can be;
- `multiSelect` is not set;
- `options.length <= 5` — Discord's action-row limit, and our own maximum is already three.

Otherwise the card is still published, with `choices: []` and
`note: 'Answer this one in Agent Wrangler — it needs more than buttons can offer.'` `format.ts`
already returns `components: []` for an empty choice list, so nothing there has to learn a new case.

Publishing a read-only card rather than skipping it is the deliberate half of this choice. The point
of the mirror is to know an agent is waiting on you; a question you have to walk to the machine for
is still something you want to be told about. `RemoteNotice` is the wrong shape for it — a notice
has no lifecycle, and this one must close when the question is answered.

**The *Other* box never becomes a button.** `QuestionView` options are the model's own suggestions;
*Other* is free text, and a slice that does not do free text does not do *Other*. A question that
has options still mirrors — the note only appears for the shapes above.

### 3.2 When a plan is mirrored

Same `runnerOwned` gate. One button, `Approve`, tone `primary`. **No "Request changes" button**:
`RunnerSession.decidePlan(requestId, false, feedback)` denies with a message, and a denial carrying
no message is a different act from the one the pane's button performs — it tells the model it was
rejected and nothing about why. Rather than send a worse version of the local action, the card says
`note: 'Request changes in Agent Wrangler; only approval can be given from here.'`

This is the part of the slice to be least comfortable with, and it should be said plainly in the
README: **approving a plan from a phone means approving a plan you have read in a Discord embed**,
which caps at 1200 characters through `redactForDisplay`. The card must show how much was cut (the
`more` count the pane already tracks for "Show the rest") so a truncated plan is obviously
truncated. If that reads badly in practice, the honest answer is to demote plans to read-only too —
the structure here supports that as a one-line change to `choicesFor`.

### 3.3 Privacy

New ground, and worth stating before it is crossed. The permission mirror publishes a command and
Claude's one-line reason. A question publishes the model's question text and option labels; a plan
publishes model-authored prose about the codebase. Both are closer to transcript content than
anything Remote Control has sent so far, and the README's promise about `doneNoticeFor` — "what it
said is on the machine where it is safe" — does not cover them.

Rules, then: everything on its way out goes through `redactForDisplay` with the existing home-dir
folding and caps (question text at `MAX_SUMMARY_CHARS`, plan body at `MAX_BODY_CHARS`); the audit
log keeps carrying ids and tool names only, never question or plan text; and the README's "What it
does not do yet" paragraph is replaced by one that says what it *does* send. This is a real change
in what leaves the machine and should be a conscious yes, not a side effect.

---

## 4. The press path

`applyInvocation`'s five checks (scope, known mirror, authorised actor, still-the-same-ask,
offered-choice) are unchanged and re-run identically — they are checks about the mirror, not about
permissions. Only step 6 splits:

```ts
switch (ask.kind) {
  case 'permission': outcome = await actions.decidePermission(ask.sessionKey, behavior, {expectedRequestId});
  case 'question':   outcome = await actions.answerQuestion(ask.sessionKey, ask.requestId, answersFor(ask, choice));
  case 'plan':       outcome = await actions.decidePlan(ask.sessionKey, ask.requestId, true);
}
```

`PermissionActions` (`Pick<SessionActions, 'decidePermission'>`, named for when it was the only one)
becomes `RemoteActions = Pick<SessionActions, 'decidePermission' | 'answerQuestion' | 'decidePlan'>`
— still narrow, still "this may answer prompts and nothing else".

Which means **`answerQuestion` and `decidePlan` must become `SessionActions`**. Today answering a
question is `DashboardHost.answerQuestion` calling `runners.answer` directly
(`dashboardHost.ts:319`), and the conversation pane goes through `ConversationSource.answer`. That
is two write paths already; the remote layer must not be a third. Put both on `SessionActions` in
`createApp`, as `decidePermission` is, have them return the same `PermissionDecisionOutcome` union
(`applied` | `stale` | `gone` | `unsupported`), and re-point `DashboardHost` at them. The pane's
source keeps its own methods — it is talking to a runner it holds directly — but the guard now lives
in one place.

`answersFor(ask, choice)` maps `opt2` back to `{[question.question]: options[2].label}` — the exact
record `runner.answer` expects (verified contract, `conversation-pane.md` §132-134). It is derived
from the ask that was **re-fetched from live state**, never from the message, which is what makes an
index safe to put in a `custom_id`.

---

## 5. Closing the message

`RemoteClose.outcome` is `'allowed' | 'denied' | 'answered-locally' | 'cancelled'`, and
`closedPayload` renders "✅ Allowed by X" / "❌ Denied by X". Add `'answered'`, carrying the label,
so a question closes as **"✅ James chose *Use Postgres*"** and a plan as **"✅ Approved by James"**.

`outcomeFor(mirror)` picks it from `mirror.kind` plus `mirror.lastPress`. When there is no press the
existing behaviour is right and needs no new wording: the ask left the desired set because it was
settled at the machine, and `answered-locally` already says exactly that.

---

## 6. What must be true when this is done

- A `runnerOwned` session asking a single-select question with ≤5 options posts **one** Discord card
  with one button per option; pressing one answers the question in the app, and the local card
  updates to *answered* without a second press.
- The same question answered in the app closes the Discord card as *answered in Agent Wrangler*.
- A multi-select question, a >5-option question, a multi-question stepper and a plan all post a card
  that says where to answer it, and close the same way.
- A plan posts with **Approve** only, its body visibly truncated when it is truncated.
- A session that is **paused** or **archived** mirrors nothing at all — including its permission
  prompts, which is the §1.1 fix and is observable today as a regression test.
- A press on a question whose session has since moved on is refused, audited `refused-stale`, and
  the card is closed — the same path as a stale permission.
- Nothing published, replied or audited contains question or plan text beyond the redacted,
  capped card body.
- A mirror record written before this change still loads, and closes as a permission.

## 7. Order of work

1. ~~**The four defects** (§1), on `main`, with the paused/archived regression test.~~ **Done.**
2. `decoratedSnapshot` (§2), plus `pendingPlan` down the runner → `RunnerOwnership` → DTO path. The
   dashboard gains a plan card as a side effect; that is a feature, not scope creep, and it is where
   the plan rendering gets its first eyes.
3. `SessionActions.answerQuestion` / `.decidePlan` (§4), with `DashboardHost` re-pointed.
4. The `RemoteAsk` union (§3) — pure, testable on its own, and the largest single diff.
5. Transport and format: the union's rendering, `note`, `'answered'`, `Mirror.kind`.
6. README: replace "What it does not do yet" with what it now does and does not send (§3.3).

Steps 2-6 are more than one sitting, so they get a worktree: `feat/remote-asks`.

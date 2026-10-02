# Bounded assignments contract: isolation, lifecycle, and scheduling

Status: design, 2026-09-30. Planning and seam inventory only; no implementation.

Scope: the boundaries between parent orchestration (tasks, missions) and worker agents
(hosted sessions running attempts), including what isolation rules enforce, how assignments
are durable across restarts, when child results deliver to the parent, and how parent/child
budget and scope are capped.

Tracking: epic [#47](https://github.com/hammonjj/AgentWrangler/issues/47) (Orchestration:
task scheduler and assignment); related issues [#102](https://github.com/hammonjj/AgentWrangler/issues/102)
(ownership/handback contract) and [#104](https://github.com/hammonjj/AgentWrangler/issues/104)
(eligibility findings).

**Prerequisite and related reads:**
- `docs/plans/intelligent-orchestration.md` §7 (domain model: Mission, Task, ExecutionAttempt,
  AgentAssignment, WorktreeAssignment)
- `docs/plans/session-lifecycle-architecture.md` (session hosts, process topology, recovery)
- `src/shared/orchestration/` (types)
- This doc defines what assignments need from #102 and #104 (§9).

---

## 0. Read this first

**This is a design only.** It inventories existing seams for reference, defines minimum contracts,
and stops before implementation. It builds on #4 (session lifecycle) and feeds into #33 (orchestration
engine phases 1–5).

1. **An assignment is a child task's durable record**, not the session itself. The session runs in
   a host and is a normal row in the table (hook-backed status, conversation readable from the pane,
   stop/send/answer reachable through `SessionActions`). The assignment is state in the mission
   store, which records what was planned, what was attempted, what happened, and when child work
   can safely touch what.

2. **Parent and child are separate writers.** A parent (the orchestrator in the core) writes the
   plan, approves attempts, and waits. A child (a hosted agent session) writes tool results,
   questions, and done signals. The contract keeps them from stepping on each other: the parent
   sees mutations made before the child starts, and the child sees the assignment plan before
   sending the first tool call.

3. **Isolation is about scope and permissions, not processes.** A worktree is either owned by one
   attempt (exclusive) or read-only to all others. A tool or file path is allowed or forbidden at
   assignment-time, not enforced by the CLI. The host does not decide; the core hands launch
   options down. A child that tries to edit an exclusive-to-another path fails in the tool itself,
   not in the host.

4. **Durable state is written before launch.** An attempt's assignment is stored before the session
   starts, so a host crash or core restart finds it (§6). Recovery re-reads the plan, deduplicates
   events, reconnects the attempt to its session, and the parent picks up where it left off.

5. **Result delivery queues when the parent is mid-turn.** A parent in a subagent or on Discord
   cannot synchronously answer an attempt's done signal. The result waits in the mission store
   (`resultReady` signal + `resultDeliveryAt` timestamp, §7.4) until the parent idle-checks
   (§23.4).

6. **Concurrency policy is stated not executed.** The assignment records who may run in parallel
   (`parallelWith: TaskKey[]`) and the scheduler checks it before starting. The two never run
   together on the same paths: the scheduler enforces it with exclusive worktrees, or by capping
   read access when they share one (§4.2). A collision is a bug to instrument and report, not
   recover from.

---

## 1. Existing seams and file:line inventory

### 1.1 Session execution and ownership

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **SessionHandle** | `src/core/session/sessionHandle.ts` | :1–150 | Provider-agnostic session interface: launch, observe, send, end. The one seam an assignment uses to run a child. |
| **SessionExecutors** | `src/core/session/sessionExecutors.ts` | :1–100 | Lookup and launch bridge for both Claude and Codex runners. |
| **SessionRegistry** | `src/core/session/sessionRegistry.ts` | :1–250 | Durable record of every AW-owned session: launch options, state, repoRoot, worktree, branch. Used for recovery. |
| **SessionRegistry.RegistryRecord** | `src/core/session/sessionRegistry.ts` | :50–120 | Fields: `id`, `state`, `endedReason`, `cwd`, `repoRoot`, `branch`, `launch` (model, effort, mode, origin), `startedAt`, `endedAt`. |
| **SessionRegistry.launch.origin** | `src/core/session/sessionRegistry.ts` | :65 | Opaque origin: e.g. `{kind: 'orchestration', missionId, taskId, attemptId}` — let the record find its attempt. |
| **HostSupervisor** | `src/core/session/hostSupervisor.ts` | :1–200 | Manages hosts: startup scan, adopt, orphan sweep, version migration, idle parking. |
| **RunnerView** (Claude) | `src/claude/runner/runnerView.ts` | :1–300 | Translation from SDK stream to `ConvBlock`, holds live ask resolvers. |
| **CodexRunner** | `src/codex/runner.ts` | :1–350 | Translation from Codex JSON-RPC to `ConvBlock`. |

### 1.2 Session state and recovery

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **SessionHandle.snapshot** | `src/core/session/sessionHandle.ts` | :80–120 | Cached view: `state`, `status`, latest blocks, pending asks, background task count. |
| **SeqLog** | `src/core/session/seqLog.ts` | :1–150 | Ordered ring of raw SDK messages with sequence number and uuid. Used to bridge gaps after disconnect. |
| **Recovery pipeline** | `src/core/session/recovery.ts` | :1–250 | Load history, replay seqLog to reconstruct state, check for orphans, reconnect to host. |
| **SessionView.subscription** | `src/core/sessionView.ts` | :200–280 | Live subscription API: `subscribe(fromSeq)` receives deltas from the ring. |

### 1.3 Permissions and tool control

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **HookLog** | `src/claude/hookLog.ts` | :1–150 | File-based permission marker store. Accessible to any process. |
| **PermissionDetail** | `src/claude/permissionDetail.ts` | :1–100 | Parsed tool name, input schema, suggestions. Shown in permission cards. |
| **SessionActions** | `src/ui/actions.ts` | :80–180 | Single funnel for mutations: decidePermission, answerQuestion, stop, send. |
| **LaunchPolicy** | `src/shared/orchestration/policy.ts` | :1–80 | Tool rules (allow/deny lists), limits (maxTurns, maxBudgetUsd), fallback options. Sent to host on launch. |
| **canUseTool** (Claude SDK) | — | — | Promise in runner heap; assignment does not touch this, host infrastructure answers it. |

### 1.4 Worktrees and git

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **worktreeFor** | `src/core/worktree.ts` | :86–150 | Detection: read `.git` file to find worktree name. |
| **gitBranch** | Various providers | — | Last known branch from CLI or transcript metadata. |
| **WorktreeManager** (planned, #4 scope) | — | — | Create, set up, track branches for assignments. Not yet in code. |

### 1.5 Missions and tasks (sketch)

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **Mission** (planned, #24) | `src/orchestration/engine/missionService.ts` (not yet) | — | User objective, policy, plan, task graph, state machine. |
| **Task** (planned, #24) | `src/orchestration/domain/task.ts` (not yet) | — | Objective, acceptance criteria, dependencies, route history. |
| **TaskRunner** (planned, #24) | `src/orchestration/engine/taskRunner.ts` (not yet) | — | Owns one task's attempt loop: assess, route, schedule, execute, verify, escalate. |

### 1.6 Telemetry and result recording

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **TurnStats** | `src/core/turnStats.ts` | :1–150 | Local percentiles (p50/p75/p90) of turn durations. Used by ETA column. Pattern for orchestration telemetry. |
| **TelemetryLog** (planned, #24) | — | — | Append-only JSONL per-turn and per-attempt records (usage, model, duration, tool calls, verification). |

### 1.7 Configuration and policy

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **ExecutionPolicy** (planned, #24) | `src/shared/orchestration/policy.ts` | :1–200 | Routing mode, pins, tier caps, autonomy flags, per-scope (global, repo, mission). |
| **CapabilityCatalog** | `src/core/capabilityCatalog.ts` | :1–250 | Model/harness capabilities, tiers, effort maps, health. Built from reports + policy. |

### 1.8 Concurrency and leases

| Concept | File | Lines | Purpose |
|---|---|---|---|
| **LeaseService** (planned, #68) | — | — | Exclusive resource holds: acquire (never waits), bind once session exists. #23 spike in `docs/plans/spikes/f2-resource-leases.md`. |
| **Checkout-sharing warning** (#22, done) | `src/ui/dashboardHost.ts` | :173 | Warning when two live sessions share a checkout. Scheduler uses this to detect conflict. |

---

## 2. Minimum assignment contract

An **assignment** is the parent's handoff to a child: *"here is what I need, what you can do, and how I will measure success"*. It is durable state that survives the child session's restart and the parent's core restart.

### 2.1 Assignment identity and parent link

```ts
interface AgentAssignment {
  // Unique within its mission
  id: ULID;
  
  // Back-reference to parent
  missionId: ULID;
  taskId: TaskKey;          // e.g., 't1'
  
  // Which session runs this attempt (one of four modes; see §2.5)
  mode: 'fresh' | 'continue' | 'reuse' | 'fork';
  sessionId?: string;       // set only for 'continue' / 'reuse' / 'fork'
}
```

### 2.2 Objective and scope

```ts
interface AssignmentObjective {
  // Task's objective (from Mission.tasks[].objective)
  objective: string;
  
  // What success looks like (from Mission.tasks[].acceptanceCriteria[])
  acceptanceCriteria: string[];
  
  // Paths this attempt may touch (read or write)
  // Entries: glob patterns or absolute paths
  scope: {
    // Paths the attempt may read (includes write paths)
    read: string[];
    
    // Paths the attempt may write; read is implied
    write: string[];
    
    // Conflict rule: is this path exclusive to this task?
    exclusive?: boolean;
  };
  
  // Maximum scope cap imposed by the parent and repo policy
  // (actual scope is the intersection of what the task asks and what is allowed)
  scopeCap?: {
    read: string[];
    write: string[];
  };
}
```

### 2.3 Route and budget

```ts
interface AssignmentRoute {
  // From RouterOutput (orchestration.md §9.3)
  // The harness that will run this (claude-code, codex, later a local server)
  harness: HarnessId;
  
  // The minimum tier needed (basic < standard < expert < frontier)
  minTier: TierName;
  
  // Effort level (low, medium, high, max)
  effort: EffortLevel;
  
  // Hard requirements (tool constraints, vision, etc.)
  // Checked by resolver before binding to a model
  constraints: string[];
  
  // What tier + effort was actually chosen (from resolver)
  // Set at assignment-creation time; immutable in this attempt
  resolved: {
    harness: HarnessId;
    modelSource: ModelSourceId;
    model: string;          // the wire id
    effortNative: string;   // native effort level, or 'none'
    catalogVersion: string; // 'cat-<fnv1a>' for replay
  };
  
  // Budget for this attempt, capped by parent mission budget
  budget: {
    // Max turns this attempt is allowed
    maxTurns?: number;
    
    // Max USD spend (estimate for hosted, unused for local)
    maxBudgetUsd?: number;
    
    // When budget runs out, what to do: 'fail' (default), 'escalate', 'ask'
    onBudgetReached: 'fail' | 'escalate' | 'ask';
  };
}
```

### 2.4 Tool access and permission mode

```ts
interface AssignmentLaunchPolicy {
  // Permission mode from launcher: auto, manual, allow-all, deny-all
  permissionMode: PermissionMode;
  
  // Tool allow/deny rules (from #71 LaunchPolicy)
  tools?: {
    allow?: string[];      // tool names, or '*' for all
    deny?: string[];       // tool names to exclude
    allowAskFallback?: boolean;  // when denied, ask instead of auto-deny
  };
  
  // Codex sandbox/approval settings (from #71)
  codexPolicy?: {
    sandbox?: boolean;
    approvalPolicy?: unknown;
    developerInstructions?: string;
  };
  
  // Which LLM can be spoken to (typically the resolved model + optional fallback)
  modelAccess: {
    primary: string;       // the resolved model
    fallback?: string[];   // from ExecutionPolicy.fallbackModels
  };
  
  // Output format constraint (from policy or task request)
  outputFormat?: 'markdown' | 'json_schema';
  outputSchema?: object;   // JSON schema if outputFormat is 'json_schema'
}
```

### 2.5 Worktree and branch assignment

```ts
interface WorktreeAssignment {
  // AW-created and -owned worktree for this task
  worktreeId: ULID;         // unique within the mission
  worktreePath: string;     // absolute path: /repo/AgentWrangler-<missionId>-<taskId>
  
  // Branch this attempt works on (created from mission.base.ref)
  branch: string;           // e.g., 'task-t1/<object-summary>'
  branchBase: string;       // what it branches from (usually mission.base.ref)
  
  // Integration worktree (shared by the integrator): set only on mission.integration
  integrationWorktreeId?: ULID;
  integrationBranch?: string;
  
  // Status: not persisted per-attempt, but queried from git
  // (git branch -vv, git status, git diff --stat)
}
```

### 2.6 Session and verification

```ts
interface AssignmentSession {
  // Which session runs this attempt (set when session starts)
  sessionId?: string;
  sessionKey?: string;      // provider:sessionId
  
  // The session's origin, stored in the registry for recovery
  origin: {
    kind: 'orchestration';
    missionId: ULID;
    taskId: TaskKey;
    attemptId: ULID;
  };
  
  // Verification plan: ordered strategies to run on the result
  verification: VerificationPlan;
  
  // Human accept/reject signal (recorded for telemetry)
  humanLabel?: 'accepted' | 'rejected' | null;
}
```

### 2.7 Assignment mode: session reuse strategy

Four modes decide whether a new session or continuing/forked session runs the attempt:

| Mode | When | Why | Constraints |
|---|---|---|---|
| **fresh** | Default; first attempt or escalation from another model | No prior session | None |
| **continue** | Same model, retry/escalate within session | Keep prompt cache warm | Only when harness supports resume |
| **reuse** | Parallel attempt, same model, same repo branch (§4.2) | Sessions are expensive | Must check no concurrent writes |
| **fork** | Subagent or child mission | Inherit history to a new tree | Only when harness supports fork |

The scheduler (§4.3) picks the mode based on task dependencies, parallel-with rules, and
available sessions.

---

## 3. Isolation rules

Isolation prevents parent and child from stepping on each other, and child-child from
interfering. Three dimensions:

### 3.1 Read-only may skip a worktree; editing needs exclusive or isolated paths

**Rule 1: Read paths are shared; write paths are exclusive unless explicitly parallel.**

- A read-only attempt can touch any path in the repo and see what other attempts wrote to the shared
  base branch.
- An attempt that writes (edits files, commits) **either gets an exclusive worktree, or**
  `parallelWith: [TaskKey[]]` explicitly permits it to run alongside named peers on the same
  branch, with file-level locks (§3.4).

**Rule 2: One worktree per task by default.**

- The scheduler creates a new worktree (`git worktree add <repo>/<mission-id>-<task-id> -b
  <task-branch>`) unless the assignment explicitly asks to reuse or fork into a prior
  attempt's tree.
- Two tasks never write to the same branch unless `parallelWith` says they can, and even then
  they own disjoint path sets (§3.4).

**Rule 3: The parent never mutates a child's paths while the child is running.**

- The parent (orchestrator) must not commit, merge, or rebase a task's branch while its
  assignment is `live`. The parent may:
  - Read the branch to see what the child wrote (before integration).
  - Read and modify the *mission* branch (`mission.integration.branch`), which is separate.
  - Commit to the base branch (another task's work, or a planner's edits).

**Rule 4: Editing requires an agreed scope at launch.**

- Before a session starts, the assignment lists what paths it may write (§2.2). The core enforces
  this by passing it as `LaunchPolicy` to the host. A tool call that tries to edit a forbidden
  path is rejected by the CLI itself (the file tool, shell subprocess, etc.), not by the host.
- The assignment does not enumerate every file (infeasible). It names directories or glob patterns
  (e.g., `/test/**` for a test task, `**/pyproject.toml` for a config task). Exact scope is a
  resolver question (§9 in orchestration.md).

### 3.2 Parent and child mutations never overlap

**Rule 5: Parent waits until child is idle before touching child's tree.**

- The parent (orchestrator core) does not merge a task's branch or rebase it until the attempt is
  `done` or `failed`. If the parent needs to integrate, it does so on a separate worktree
  (the mission's integration worktree, `mission.integration`), on the mission branch.

**Rule 6: No prompt-level enforcement of file ownership. Scope is data.**

- The assignment does not ask the CLI to deny paths or refuse edits. The parent cannot enforce
  in-session scope because the CLI does not know assignment boundaries. Instead:
  - The `LaunchPolicy` is shown to the user when reviewing a task (§11.3 in orchestration.md).
  - Tool denials or custom paths are recorded as evidence (§16 in orchestration.md).
  - A collision (parent writes while child is running, or child writes to a forbidden path)
    becomes observable evidence for the telemetry system.

### 3.3 Prompts and instructions do not provide isolation

**Rule 7: Prompts alone are not isolation.**

- The assignment does not hand the child a prompt saying "edit src/, not docs/". Prompts are
  advice; they are always subject to the agent's judgment. A parent that depends on isolation
  must use:
  - Exclusive worktrees (the child's tree, the parent waits).
  - File-level scope assertions in the assignment (edge cases only).
  - Verifiers that reject bad edits (the primary tool).

---

## 4. Scheduling and concurrency

### 4.1 Scheduler owns "when" and "how many"

The **Scheduler** (component of TaskRunner, §5.2 in orchestration.md) decides:
1. **When** a task can start: all dependencies done, budget available, no exclusive conflicts.
2. **How** it starts: which session mode (fresh/continue/reuse/fork), which worktree.

The scheduler runs between the Router (which says "this task needs standard tier") and the
Resolver (which picks a model). It checks:

- Task dependencies: are all upstream tasks done?
- Budget: does the parent mission have usage window headroom?
- Contention: are paths I need exclusive? Occupied? Can I run parallel?

### 4.2 Parallel-with rules and path exclusivity

**Rule 8: Parallelism is explicit and conservative.**

If a task asks `parallelWith: [t2, t3]`, the scheduler checks:
- t2 and t3 are both ready and in the queue.
- Their scope `write` paths are disjoint (no file edited by both).
- Both fit in the model's concurrency budget (`maxConcurrency` in the catalog).
- The parent mission's budget allows parallel turns.

If any check fails, the task waits. Two tasks never run concurrently unless the assignment
says they can *and* their path sets do not collide.

**How it works:** The scheduler builds a resource map per worktree:
```
<repo>/<mission-id>-<task-id>:
  owner: TaskKey
  paths_writing: glob[]
  started_at: ms
  expected_done_at: ms
```

Before starting a task, it checks:
```
for each path in task.write:
  if any other_task writes to path:
    if other_task not in parallelWith:
      → BLOCKED until other task is done
```

### 4.3 Session reuse (mode = 'reuse')

**Rule 9: Reuse shares a worktree and session, with exclusive scope.**

When `mode: 'reuse'` and the prior attempt is the same harness + model:
- Same worktree (no `git worktree add`; the session is already there).
- Same branch (the child's branch from the prior attempt).
- New session process, resumed on the old `sessionId`, replays history (§6.2).

Preconditions:
- Prior attempt is `done` or `failed` and its session still lives in the registry.
- Same `harness` and `model` (otherwise a `fresh` or `continue` attempt).
- Reuse is requested explicitly in the task dependency or the route.

Isolation: the parent waits until the prior attempt is `idle` before reading the result and
queuing the next attempt. Only one writer per session.

---

## 5. Durable lifecycle

An assignment is persistent state written to the mission store before any session starts. It
survives host restarts, core restarts, and parent/worker cancellation. Recovery is idempotent.

### 5.1 Assignment lifecycle: states and transitions

```
[Created]
   ↓ (persisted to store before launch, then session.launch is called)
[Pending] → [Launched] → [Idle / Busy] → [Done / Failed / Cancelled]
            (session started,         (child processing)
             sessionId set)
```

| State | Meaning | Parent action | Child capability |
|---|---|---|---|
| **Created** | Plan approved; not yet sent to launch | Persist to store, then call `launch()` | N/A |
| **Pending** | Persisted; waiting to be launched (depends on budget, contention) | Monitor for launch readiness | N/A |
| **Launched** | Session process has started; session id assigned | Subscribe to status | Begin reading assignment, send first tool call |
| **Idle** | Session is waiting (on a permission prompt, a question, or done with turn) | Read result queue, prepare next turn if needed | Answer permission/question, send next prompt, or wait |
| **Busy** | Session is working (tool calls in flight) | Monitor ETA, check for timeout | Working; parent cannot interrupt synchronously |
| **Done** | Task completed successfully (verified) | Read final result, mark complete, trigger next tasks | N/A |
| **Failed** | Task failed (bad result, escalation exhausted) | Record failure, trigger escalation or mark failed | N/A |
| **Cancelled** | Parent asked to stop | Graceful shutdown | N/A |

### 5.2 Persistence: before launch and during execution

**When created (before launch):**
1. Assignment record is built (objective, scope, route, verification plan).
2. Written to mission store (`missions.json`, under `mission.tasks[taskId].attempts[]`).
3. Indexed under `mission.state.nextAttemptId` (ULID sequence).
4. Commit: atomic write of the whole mission record (§23.2 in orchestration.md).

**After launch:**
1. Session starts; `sessionId` is assigned by the provider and stored in the assignment.
2. Session registry record is created with `origin` back-link to the assignment.
3. If host crashes: the assignment record still has the `sessionId`; recovery finds it via
   `SessionRegistry.findByOrigin()`.

**During execution:**
1. Assignment state is read-only to the child (child cannot mutate its own assignment; only
   set `resultReady` and write result summary).
2. Parent does not mutate the assignment while the child is `live`. The parent may:
   - Write `resultDeliveryAt` when result is ready to be consumed.
   - Write `escalationDecision` when escalation is needed.
   - Write `cancelledAt` when cancelling the task.

### 5.3 Idempotency and deduplication

**Rule 10: All events are idempotent.**

An assignment's result is determined by:
1. The `resolved` route (§2.3): immutable, set at assignment creation.
2. The session's transcript (deterministic replay from the SeqLog).
3. Tool calls and their inputs (from the SDK message log, deduplicated by `uuid`).

If recovery replays from a checkpoint (e.g., after a host restart):
- Replayed SDK messages use the same `uuid`; the session deduplicates.
- Replayed tool results are from the same `uuid`; the SDK does not re-send.
- A child that sends the same message twice is idempotent because the transcript is append-only.

**Duplicate event handling:**
- Parent receives a `resultReady` signal: check if `result` is already stored. If yes, this is
  a replay; acknowledge and do not re-queue the next task.
- Parent receives the same result via multiple paths (e.g., host reconnect + late message): last
  write wins, with a timestamp check. Telemetry records the collision.

### 5.4 Restart and reconnect

**Core restart (Electron app quits and relaunches):**

1. On startup, `SessionRegistry.startup()` recovers all open sessions.
2. `recovery.ts` rebuilds each session's state from SeqLog and transcript.
3. For each registry record with `origin.kind = 'orchestration'`, find its assignment.
4. If assignment is `launched` or `busy`: reattach to the host. If the host is gone, mark
   `interrupted` (§1.5 of session-lifecycle.md).
5. If assignment is `idle`: parent resumes its turn by checking `resultReady` and advancing.

**Host restart (session host process dies, not the core):**

1. HostSupervisor detects the dead host process.
2. If the session is still in the registry (orphan sweep has not collected it), the session is
   marked `interrupted` with reason `host lost`.
3. The assignment record keeps `sessionId` and is not modified.
4. Parent receives a `sessionInterrupted` event via `SessionHandle.onStatusChange()`.
5. Parent can:
   - Resume the session (a new host, continues with the same `sessionId`, same transcript).
   - Escalate (fail this attempt, try a stronger model).
   - Cancel (mark failed, clean up).

**Parent cancellation (mission cancelled by user or escalation backoff):**

1. Parent writes `assignment.cancelledAt = now()` to the store.
2. Parent calls `session.end(graceful)` (wait up to 10 s for the turn to finish).
3. Session is recorded as `stopped` with reason `agent error` or `user stopped`.
4. Assignment state becomes `cancelled`.

### 5.5 Result delivery and buffering

**Rule 11: Result delivery queues when the parent is mid-turn.**

A child's done signal (§7.4) does not synchronously advance the parent. The parent may be:
- In a subagent turn (answering a question asked to the orchestrator).
- Waiting on Discord (answering a permission prompt through Discord).
- Between turns (idle but not yet polling results).

When the child finishes:
1. Write `assignment.resultReady = true` and `assignment.resultDeliveryAt = <timestamp>` to the
   store.
2. Signal the parent through `MissionService.onAssignmentDone(id)` (evented).
3. Parent polls for ready results on every idle check (once per second, capped by EventBus rate).
4. When polled, parent reads the result, validates it, runs verification, and marks `done` or
   `failed`.

No attempt marks the parent done until the parent acknowledges the result. This prevents a child
from orphaning the parent in mid-thought.

---

## 6. Open dependencies on #102 and #104

### 6.1 #102: Ownership and handback contract

Finalized by `docs/plans/delegation-ownership-contract.md` (#102, 2026-10-02). That document's
ownership model is at the *mission/origin-conversation* level (who the origin is accountable for,
and when a result is handed back to it); this section's table is at the *assignment/attempt*
level (parent-core vs. child-session mutation boundaries) and is a different, narrower scope that
#102 does not re-litigate — the two are complementary, not overlapping: §7 of the contract
document is explicit that none of its closeout or follow-up machinery runs inside an attempt's
worktree or session, which is exactly the boundary this table already draws.

**What this doc needs from #102:**

An assignment needs a clear, explicit contract for what the parent owns and what the child owns,
and when ownership changes hands.

| Resource | Owned by | Mutated by | Handoff |
|---|---|---|---|
| Assignment record | Parent core | Child writes `resultReady` field | Before launch: parent owns; child appends result |
| Session and transcript | Child session (host) | CLI, tool results | N/A; transcript is append-only |
| Worktree and branch | Parent core | Child edits in working tree; parent merges | During execution: child exclusive; post-done: parent integrates |
| Scope assertion (allowed paths) | Parent core | Child obeys (not enforced, observed) | Before launch: parent declares; child promises |
| Verification | Parent core | Child none; parent runs verifiers | After done: parent verifies |
| Budget consumption | Child (reports usage) | Parent (records, capped) | During: child reports per turn; parent caps |

**Current state:** §1.3 lists existing tool control surfaces (HookLog, PermissionDetail, LaunchPolicy).
Neither addresses the durable, per-attempt handoff. **#102 must define:**

- Where does the assignment handoff happen? (Store write, then session launch, or simultaneous?)
- What happens if the child process dies mid-handoff? (Is there a race?)
- Who resolves conflicts (parent wrote while child was writing)?
- What are the idempotent checkpoints?

**#102's scope:** The ownership contract itself. Not implementation details of the session host,
but the boundaries it enforces.

### 6.2 #104: Eligibility findings

**What this doc needs from #104:**

An assignment's eligibility depends on three checks done at different times:

1. **Pre-launch eligibility** (router + scheduler): Can this task run at all right now?
   - Dependencies satisfied?
   - Budget available?
   - Model available and reachable?

2. **Launch-time eligibility** (resolver): Does the chosen model + harness combo actually exist?
   - Is the model in the catalog?
   - Is the harness reachable (host running, token valid)?
   - Is there concurrency headroom?

3. **Post-done eligibility** (verifier): Did the result actually meet acceptance criteria?
   - Did tests pass?
   - Did files change as expected?
   - Did the child write to forbidden paths (collision detected)?

**Current state:** The router produces a `RouteRequirement` (orchestration.md §9.3); the resolver
binds it (§9.4). Neither persists eligibility findings or re-checks them on restart.

**#104's scope:** Where to record eligibility checks, so that:
- A restarted parent can see "why was this task eligible when it launched?"
- A verifier can see "the child did write to paths, and here is the evidence."
- A collision detector can see "here is what this task owns; here is what it actually touched."

This is telemetry and evidence, not the contract itself. But the contract must reserve a place
for these findings in the assignment record.

### 6.3 Proposed assignment fields for #102 and #104

To unblock #47 (this task), reserve these fields in the assignment:

```ts
interface ExecutionAttempt {
  // ... (fields from §2.1–§2.6) ...
  
  // #102: Ownership and handoff telemetry
  handoff?: {
    // When did the parent hand off scope to the child?
    handoffAt?: number;     // ms epoch
    
    // What was the agreed scope? (what the assignment declared)
    scopeAgreed?: AssignmentScope;
    
    // Did the parent mutate the child's branch while it was running?
    parentMutationDetected?: boolean;
    parentMutationAt?: number;
    
    // Did ownership transfer correctly, or was there a race?
    handoffSuccessful?: boolean;
  };
  
  // #104: Eligibility and collision findings
  findings?: {
    // Pre-launch eligibility: why was this task deemed eligible?
    prelaunchEligibility?: {
      deps_met: boolean;
      budget_available: boolean;
      model_available: boolean;
      reasons: string[];
    };
    
    // Launch-time eligibility: which model was chosen?
    launchEligibility?: {
      model_chosen: string;
      harness_reachable: boolean;
      concurrency_slots_available: number;
    };
    
    // Post-done collision: what did the child actually write?
    collisionFindings?: {
      paths_touched: string[];
      paths_forbidden: string[];
      forbidden_paths_written: string[];  // collision! evidence
      exclusive_to_others: string[];      // data for scheduler
    };
  };
}
```

These fields are empty until #102 and #104 define what goes in them. Assignment creation (§7)
and storage (§23) leave room for them. #102's own new types (`DelegationOutcome`,
`FollowUpObligation`, `CloseoutState`) live at the mission level, not inside `ExecutionAttempt`;
they do not fill the `handoff`/`findings` fields sketched above, which remain #104's (eligibility
and collision evidence) and a narrower #102 follow-up (parent/child mutation races within one
attempt) if that scope is still wanted once #114-#118 ship.

---

## 7. Implementation slices and acceptance criteria

### 7.1 Phase: Slice A — Bounded-assignment schema and storage

**Goal:** Define and persist assignment records; no execution yet.

**Scope:**
1. TypeScript types for `ExecutionAttempt`, `AgentAssignment`, `WorktreeAssignment` (§2).
2. Mission store record structure: `mission.tasks[taskId].attempts[]`.
3. Store write: atomic mission update (existing JsonStore machinery).
4. Store read: query all attempts in a mission; filter by state.

**Files changed:**
- `src/shared/orchestration/` (new or expanded): `assignment.ts` (types).
- `src/orchestration/domain/` (new): `assignment.ts`, `executionAttempt.ts` (state machines, helpers).
- `src/orchestration/store/` (new): `missionStore.ts` (read/write attempts).

**Acceptance criteria:**
- [ ] Assignment types are defined and exported.
- [ ] Attempt state machine enforces valid transitions (Created → Pending → Launched → Done/Failed).
- [ ] Mission store can persist and load attempts without data loss.
- [ ] Attempts are indexed by id and taskId for fast lookup.
- [ ] Atomic writes: a mission update includes tasks, attempts, and metadata in one document.

**Test plan:**
1. **State machine tests:** Create → Persisted → Launched → Idle → Done. Check preconditions.
2. **Store tests:** Round-trip: create, write, read, verify fields match.
3. **Concurrency:** Two mock stores writing the same mission; last write wins, no data corruption.
4. **Simulated: collisions:** Create two attempts on the same task; second one is pending until first is done.

### 7.2 Phase: Slice B — Isolation rules and scope assertion

**Goal:** Define scope at assignment creation; no enforcement yet.

**Scope:**
1. Assignment.scope (read, write, exclusive) structured.
2. Scope capping: intersection of task scope + policy + repo policy (read from ExecutionPolicy).
3. Scope validation: no overlaps within a task, no forbidden paths (e.g., `.git/`).

**Files changed:**
- `src/shared/orchestration/policy.ts` (expanded): `AssignmentScope`, `scopeUnion`, `scopeIntersection`.
- `src/orchestration/domain/` (new): `isolation.ts` (scope checks, collision detection).

**Acceptance criteria:**
- [ ] Scope is normalized: glob patterns are canonical, duplicates removed.
- [ ] Scope cap is read from ExecutionPolicy and mission policy.
- [ ] Scope intersection is computed without false collisions (e.g., `src/**` and `src/foo.ts` do not conflict).
- [ ] Forbidden paths are detected (e.g., a write to `.git/` is rejected).
- [ ] Two tasks with overlapping write paths and no `parallelWith` permission are detected.

**Test plan:**
1. **Scope tests:** Union, intersection, subtraction. Edge cases: empty scopes, root, globs.
2. **Collision tests:** Same path vs glob overlap; disjoint scopes; exclusive + parallel = error.
3. **Cap tests:** Task asks for `src/**`, policy allows `src/ui/**`; scope becomes `src/ui/**`.
4. **Simulated: forbidden paths:** Try to read `.git`, `.env`; validation rejects.

### 7.3 Phase: Slice C — Scheduler eligibility and mode selection

**Goal:** Scheduler decides when an assignment can start and in what mode.

**Scope:**
1. Pre-launch eligibility check: deps, budget, model availability.
2. Mode selection: fresh / continue / reuse / fork.
3. Worktree allocation: create new, or reuse prior.
4. Contention check: path overlap with in-flight tasks.

**Files changed:**
- `src/orchestration/engine/` (new): `scheduler.ts` (step function, eligibility).
- `src/orchestration/engine/` (new): `contention.ts` (collision detection, resource map).

**Acceptance criteria:**
- [ ] Scheduler waits for all task dependencies to be done.
- [ ] Scheduler checks parent mission budget before launching.
- [ ] Scheduler rejects a task if a non-parallel task owns the same write path.
- [ ] Mode is selected correctly: fresh → new session; continue → same session if alive.
- [ ] Worktree is created and tracked; cleanup happens on task end.

**Test plan:**
1. **Eligibility tests:** Task with unsatisfied deps; mode stays Pending. After deps done, mode → Launched.
2. **Budget tests:** Mission at 95% usage; launch is rejected. After window resets, accepted.
3. **Contention tests:** Two tasks, same write path, no `parallelWith`; second waits until first is done.
4. **Mode tests:** Attempt 1 fresh → new session. Attempt 2 same task, escalate → continue on attempt 1's session.
5. **Simulated: collision during parallel:** Two tasks run parallel-with permission; one writes `src/foo.ts`, the other `src/foo.ts`; error recorded.

### 7.4 Phase: Slice D — Assignment result delivery and buffering

**Goal:** Child result does not synchronously wake the parent; parent polls on idle.

**Scope:**
1. Assignment.resultReady and resultDeliveryAt fields.
2. Child writes result to assignment; waits for parent to acknowledge.
3. Parent polls MissionService for ready results.
4. Result event propagates to TaskRunner for verification.

**Files changed:**
- `src/orchestration/engine/` (new): `resultDelivery.ts` (queue, polling).
- `src/orchestration/engine/` (expanded): `taskRunner.ts` (poll loop).

**Acceptance criteria:**
- [ ] Child can set resultReady without blocking.
- [ ] Parent does not mark task done until it reads the result.
- [ ] Parent polls every idle-check interval (≥1 s).
- [ ] Duplicate result deliveries are idempotent (timestamp check).
- [ ] Parent is never marked done while a subagent is awaiting approval.

**Test plan:**
1. **Buffering tests:** Child finishes, parent is mid-turn; result waits in queue. Parent polls; accepts.
2. **Duplicate tests:** Child sends result twice; parent sees both, keeps one.
3. **Mid-turn tests:** Parent is in a subagent ask; child finishes. Result is buffered; parent wakes up after subagent answers.
4. **Simulated: missed polls:** Core restarts; parent resumes with old pending result in queue. Parent polls; finds and processes it.

### 7.5 Phase: Slice E — Recovery: restart and reconnect

**Goal:** Host restart, core restart, and parent cancellation all reconnect correctly.

**Scope:**
1. Registry recovery with assignment lookups (SessionRegistry.findByOrigin).
2. ReattachHandle: rebuild session state from SeqLog + assignment.
3. Reconnect: resume on the same sessionId, deduplicate replayed events.
4. Cancellation: graceful shutdown of a running assignment.

**Files changed:**
- `src/orchestration/engine/` (new): `recovery.ts` (assignment lookup, reconnect).
- `src/core/session/recovery.ts` (expanded): integration with assignment origin.

**Acceptance criteria:**
- [ ] Core restart: all in-flight assignments find their sessions by origin.
- [ ] Host crash: session marked interrupted; assignment marked waiting-for-reconnect.
- [ ] Reconnect: state is rebuilt; no duplicate tool calls.
- [ ] Cancel: assignment receives stop signal; session is marked stopped; worktree is cleaned up.
- [ ] Orphaned assignment (session gone, no registry record): marked failed with reason.

**Test plan:**
1. **Core restart tests:** Assignment in Launched state; core restarts. On startup, assignment is found and reattached.
2. **Host crash tests:** Host dies; session marked interrupted. Parent sees the signal; can resume or escalate.
3. **Dedup tests:** SeqLog has messages from seq 100–150; transcript has seq 100–140. Reconnect replays 141–150 only.
4. **Cancel tests:** Parent calls cancel on running assignment. Session receives stop; assignment marked cancelled.
5. **Simulated: orphan detection:** Registry capped, assignment lost. Recovery detects and marks failed.

### 7.6 Integration test: Simulated missions with collisions, busy parent, concurrent attempts, failure paths

**Goal:** End-to-end behavior under realistic conditions, without running actual agents.

**Test scenario:**

```
Mission: Refactor a codebase (3 tasks)
  t1: Fix lint errors (write: src/**, effort: low)
  t2: Add tests for new functions (write: test/**, depend on t1)
  t3: Update docs (write: docs/**, parallel-with: [t1])

Execution sequence:
  - t1 and t3 start in parallel (different paths).
  - t2 waits for t1 (dependency).
  - Parent receives a question from another agent mid-turn.
  - t3 finishes; parent is busy answering the question.
  - Result for t3 waits in queue.
  - Parent finishes subagent turn; polls; finds t3 result.
  - Verification runs; passes; t2 is unblocked.
  - t1 is still busy.
  - Core restarts.
  - On startup: t1 and t2 are reattached; t3 is done and cleaned up.
  - t1 continues; finishes; t2 starts.
  - t2 fails verification (bad test); escalation policy says retry.
  - t2 restarts with a higher effort level.
  - t2 passes; mission is done.
```

**Test assertions:**

1. **Concurrency:** t1 and t3 run in parallel; no file conflicts detected.
2. **Buffering:** t3 result is buffered; parent polls and finds it while busy.
3. **Dependencies:** t2 does not start until t1 is done.
4. **Recovery:** Core restart reconnects t1 and t2; t3 is done.
5. **Escalation:** t2 fails; retry with higher effort is issued.
6. **State consistency:** After recovery, attempts have the same id, sessionId, and result.

---

## 8. Conclusion and next steps

This design provides:

1. **Clear contracts** (§2): assignments define objective, scope, route, budget, and verification.
2. **Isolation rules** (§3): worktrees are exclusive unless explicitly parallel; parent/child don't
   mutate each other's paths.
3. **Durable lifecycle** (§5): assignments are persisted before launch; recovery is idempotent
   and restarts are transparent.
4. **Scheduled concurrency** (§4): scheduler owns contention and mode selection; no collisions.
5. **Buffered delivery** (§5.5): results queue when parent is mid-turn; parent polls on idle.

It depends on (§6):
- **#102** to define the ownership handoff (when does the parent hand scope to the child?).
- **#104** to specify how eligibility and collision findings are recorded (evidence for telemetry).

**Blockers for Phase 1 (§33.1 of orchestration.md):**
- #4 must land (session hosts, recovery, registry).
- #26 must land (LaunchDefaults, launch policy through one path).
- #102 and #104 must define their contracts so assignments can reference them.

**Next: Phase 1 implementation** will tackle Slices A–E above, then feed into TaskRunner (§5.2
of orchestration.md) and MissionService phases 1–5 (§33 of orchestration.md).

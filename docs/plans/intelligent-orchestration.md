# Agent Wrangler intelligent orchestration: architecture and roadmap

Status: proposed, 2026-09-24. Planning only; nothing here is built.
Scope: turning a mission into tasks, assessing them, choosing agent + model + effort, running
them safely in parallel, verifying the results, escalating when they fail, and recording enough
telemetry that routing can one day learn from it.
Tracking: epic [#24](https://github.com/hammonjj/AgentWrangler/issues/24) in the GitHub Project
"Agent Wrangler" (§30).
**Prerequisite: the session-lifecycle epic [#4](https://github.com/hammonjj/AgentWrangler/issues/4)
is completed first.** Nothing in this plan starts until #4 has landed; §1 says what that buys and
what this plan asks of it.

---

## 0. Read this first

1. **Orchestration lives in the core, on top of #4's session layer.** It is a set of services in
   the Electron main process (the "core" of #4 §5) that launch ordinary AW-hosted sessions through
   #4's `SessionExecutor`, record them in #4's `SessionRegistry`, and observe them through
   `SessionHandle`. It is not a new process, not a new provider, and not a second agent loop.
   Hosts stay policy-free (#4 §6). An orchestrated task is a normal row in the table.
2. **Four decisions, four owners.** *What* (Task + acceptance criteria: planner or user) ·
   *how hard the work is* (TaskAssessment: assessor) · *what the work needs* (RouteRequirement:
   capability tier + effort + hard constraints: router) · *who runs it* (ExecutionTarget =
   harness + model + native effort: resolver, then AgentAssignment: scheduler). Tasks never name
   a model. Routing decisions snapshot the model they resolved to, as history.
3. **Tier and effort are separate axes.** Tier is a property AW assigns to a model in an
   editable catalog; effort is a per-attempt request mapped to each model's native levels. The
   router computes them from different assessment dimensions, so Sonnet + low, Sonnet + high and
   Opus + medium all arise naturally (§9.3).
4. **"Provider" is two things, and the code already shows it.** AW says `claude`/`codex` for
   sessions and `anthropic`/`openai` for models (§2.2). Those are the *harness* (Claude Code,
   Codex: the agent loop, tools, permissions) and the *model source* (Anthropic, OpenAI, later a
   local server). The design keeps them apart, which is what lets a local model run inside an
   existing harness later without touching tasks (§6, §19).
5. **Start cheap only where verification can catch the mistake.** The one routing principle that
   decides most thresholds: under-routing is safe when a verifier will reject bad work, and
   dangerous when it will not (§9.2).
6. **Verify before trust, observe before intelligence.** The roadmap puts telemetry, single-task
   execution in its own worktree, and verification *before* any automatic routing, and puts
   automatic routing before decomposition. A planner that multiplies tasks is only safe once each
   task is verified and bounded (§28).
7. **Shadow mode is always on.** From the phase where the router exists, it records what it
   *would* have chosen next to what actually ran. Automatic routing is switched on only when the
   evaluation corpus and the shadow record say it is ready (§27).
8. **Adaptive routing proposes; deterministic policy disposes.** When history exists, it suggests
   rule changes that a human accepts. Routing stays a pure, explainable function (§20).
9. **Budget here is mostly plan usage, not dollars.** AW runs Claude on the subscription login
   (`apiKeySource: "none"`), so `total_cost_usd` is an API-equivalent estimate and the real
   constraint is the 5-hour/7-day usage window the Budget cards already show. Budget policy is
   written against both (§21).

---

## 1. Prerequisite: what #4 delivers, and what this plan asks of it

### 1.1 What orchestration stands on

This plan assumes every stage of #4 has landed (Stages 1–6; Stages 7 and 8 are optional). The
things it uses, with their #4 playbook sections (`docs/plans/session-lifecycle-architecture.md`):

| #4 deliverable | Issue | Why orchestration needs it |
|---|---|---|
| `SessionExecutor` / `SessionHandle`: one provider-agnostic way to start, observe, send to and end a session; Claude execution split from translation | #12 | The only execution seam an orchestrator should call. Today there is none (§2.1): `RunnerService` and `CodexRunnerService` share no type, and `createApp` holds the launch logic as closures. |
| `SessionRegistry` (`sessions.json`): every AW-owned session with launch options (model, permission mode, effort), `repoRoot`, worktree, branch at start, state | #13 | An ExecutionAttempt references a registry session id. The registry is the durable answer to "what happened to that attempt's process" after any restart. |
| Explicit lifecycle states (`launching`, `live`, `stopping`, `stopped`, `ended`, `failed`, `lost`, `interrupted`; link states `connecting`, `unreachable`) and "Interrupted — Resume" for every session | #13, #15 | The attempt state machine (§7.5) maps onto these, so orchestration does not invent a second process model. |
| Survivable session hosts, reattach after core restart, orphan sweep, bounded version drift | #14, #15 | **The reason #4 comes first.** In this repo the app is reinstalled many times a day, and today every install kills every hosted agent. A mission of five parallel tasks that dies on every `app:install` is unusable. With hosts, in-flight attempts survive the core restarting and the orchestrator reattaches. |
| Codex threads survive restarts | #17 | Codex is a routing target; its attempts need the same survival. |
| Windowless core, OS notifications, menu-bar counts | #18 | Missions run for hours with the window closed; "task needs you" must reach James without the window. |
| Exclusive resource leases (Unity Editor) | #23 (a spike) | #23 decides *how* a lease is acquired; #4 §6.1 describes the core `LeaseService` it leads to, which has no issue yet. The scheduler's exclusive-resource constraint (§13.5) needs that service. If none exists when #47 starts, #47 builds the minimal one #4 describes. |
| Checkout-sharing warning | #22 | Same `repoRoot`/worktree data the scheduler uses for contention (§13.4). |
| Core control socket + `aw` CLI | #21 (optional) | A later `aw mission` / `aw task` surface. Not required. |
| Host-first permission routing; hosted sessions approvable only through AW | #15 | Orchestrated attempts ask permission like any hosted session; nothing new is needed, and an agent cannot approve its own prompt. |

### 1.2 Principles inherited from #4, unchanged

- **The host has no policy.** Orchestration policy (routing, escalation, scheduling) is core-side.
- **The conversation is the transcript.** An attempt's conversation is its session's transcript;
  AW does not persist event history for conversations.
- **No silent resume after a crash.** #4 never auto-resumes after a host crash, and auto-resumes
  after a restart only the newest session, only behind `runner.autoResumeLastOnStartup`. An
  interrupted attempt is not resumed silently either (§23.3), and ask A6 keeps #4's newest-session
  auto-resume away from orchestrated sessions, whose recovery the orchestrator owns.
- **JSON via `JsonStore`, no SQLite** — with #4's own revisit trigger ("persists event history,
  several writers, or fleet-level queries"), which orchestration analytics eventually hits
  (§23.1, Phase 10).
- **Discord reaches only `SessionActions`.** Orchestration adds no remote control surface in the
  first phases.

### 1.3 Forward-compatibility asks for #4

Small things that are cheap while #4 is being built and expensive to retrofit. Posted as comments
on the named issues (A1–A2 on #12, A3, A4 and A6 on #13, A5 on #23); none changes #4's scope or
order.

| Ask | Issue | Detail |
|---|---|---|
| A1. `SessionExecutor.start` takes a launch request object | #12 | `{provider, cwd, model?, effort?, permissionMode?, sessionId?, resume?, initialPrompt?, origin?}` rather than positional arguments, so orchestration adds fields without touching every call site. |
| A2. `SessionHandle` exposes turn completion with the raw result | #12 | An event carrying the provider's turn-end payload (Claude `result`: `usage`, `modelUsage`, `total_cost_usd`, `num_turns`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `terminal_reason`, `api_error_status`, `permission_denials`; Codex: turn completion + token usage). Telemetry (§16) reads this and never reaches into `RunnerView`. |
| A3. Registry records carry an optional opaque `origin` | #13 | e.g. `{kind: "orchestration", missionId, taskId, attemptId}`. The registry does not interpret it; recovery (§23.3) uses it to reconnect attempts to sessions. |
| A4. Registry keeps requested *and* applied model/effort | #13 | `launch.effort` is what AW asked for. The applied effort can differ (the CLI silently downgrades for models without that level); Claude reports it in tool-context hook payloads (`effort.level`) and, on some hosts, in `system/init`. Keep a slot for `applied`. |
| A5. Leases can be held by the scheduler, not only requested by an agent | #23 | Orchestration acquires a lease *before* starting an attempt (`holder: attemptId`), then hands it to the session. The spike should keep that shape possible. |
| A6. Newest-session auto-resume skips orchestrated sessions | #13 | `runner.autoResumeLastOnStartup` resumes the newest interrupted session. For a session with `origin.kind = orchestration` the orchestrator owns recovery (§23.3), so #4's auto-resume should leave it alone. |

---

## 2. Current architecture (evidence, 2026-09-24)

This section describes the repo as it is on `main` today, then notes where #4 changes it. File
references are to `main` at `7948980`.

### 2.1 Concept inventory

| Concept | Today | After #4 | What orchestration needs |
|---|---|---|---|
| **Session / agent** | `AgentSession` (`src/shared/model.ts:79`) is the one row type, identified by `key = provider:sessionId`. `SessionStatus` (`blocked, waiting, done, busy, stuck, ended`) is a *display* status recomputed on every scan from hooks or transcript inference, not a transition model. | Adds `SessionRegistry` records with a real lifecycle, and `SessionHandle` for AW-owned sessions. | Attempts refer to sessions by registry id. Orchestrated sessions stay ordinary rows, decorated with mission/task/route chips through the existing `DecoratedSessions` layer (`src/core/sessionView.ts`). |
| **Process / runtime** | Claude: `RunnerSession` (`src/claude/runner/runnerSession.ts`, 697 lines) wraps the Agent SDK `query()` and fuses execution with translation. Codex: `CodexAppServer` (transport) + `CodexRunner` (translation) over one shared `codex app-server --stdio`. All children of the Electron main process. | Thin detached hosts per Claude session; one AW-owned Codex server; core reattaches. | Nothing directly. Orchestration never touches processes, only `SessionExecutor`. |
| **Permissions** | Three paths: hook marker files (every Claude session), `canUseTool` promises (Claude runner), Codex JSON-RPC requests. All answered through `SessionActions` (`src/ui/actions.ts:82`), which is also what Discord calls. | Host-first routing; hosted sessions approvable only through AW. | Unchanged. Orchestrated attempts' asks appear in *Waiting* like any other. Orchestration never answers permissions itself. |
| **Providers / harnesses** | `AgentProvider` (`src/core/provider.ts:13`) is monitoring only (`scan`, `start`, `refresh`). No execution interface; `RunnerOwnership` (`src/app/createApp.ts:279`) is a hand-built facade. `AgentSession.provider` is a bare `string`. | `SessionExecutor` + `SessionHandle`, provider-agnostic. | An `AgentHarness` descriptor on top: what a harness can do, which models it can reach (§6). |
| **Models** | `ModelChoice {provider: 'anthropic'\|'openai', value, label, resolved?, effortLevels?}` (`src/shared/conversation.ts:262`). Claude asks `supportedModels()`, Codex asks `model/list`; `ModelCatalogService` (`src/core/modelCatalog.ts`) remembers the last list so the launcher can offer it. Transcript model shown via `modelLabel` (`src/shared/modelName.ts`). | Registry records launch model. | The catalog grows into a `CapabilityCatalog`: descriptors, tiers, effort maps, health (§6.3). The discovery half already exists. |
| **Reasoning effort** | Launcher and composer dropdowns; `runner.effort` / `codexRunner.effort` settings read ad hoc from `HostSettings` in `createApp.ts` (`:385, :658, :676`), not through `WranglerConfig` (`src/core/config.ts`). Claude: the SDK `effort` option at start only; later changes send the CLI's `/effort <level>` (`runnerSession.ts:338`). Codex: `config.model_reasoning_effort` on `thread/start` (`src/codex/runner.ts:293`). Levels are per model (`supportedEffortLevels`, `supportedReasoningEfforts`). | Registry records launch effort. | Effort as an AW-level ordinal mapped per model (§6.4); requested/native/applied recorded separately. |
| **Worktrees / branches** | Detection only: `worktreeFor` (`src/core/worktree.ts:86`) reads `.git` files; `gitBranch` is whatever the CLI wrote into its transcript. The only `git` subprocess is `git ls-files` for `@`-mentions (`src/core/fileSuggest.ts:83`). Keeping agents apart is procedure (CLAUDE.md, "Branches and worktrees"). | Registry records `repoRoot`, worktree, branch at start; #22 warns on shared checkouts. | Real git plumbing: create, set up, merge and remove worktrees and branches (§13). None exists. |
| **Tasks / jobs** | None. `docs/plans/scheduled-agents.md` is a research spike; `adoptQueue.ts` and `InputQueue` are unrelated plumbing. | — | Everything in §7. |
| **Repository ownership** | None. Projects are a derived list (`ProjectsService`). | `repoRoot` in the registry. | Per-repo policy (§13.6) and contention (§13.4), still without a project entity. |
| **Persistence** | Flat JSON with atomic writes: `settings.json`, `state.json` (archive, pins, nicknames, columns, turn stats, model catalog), `surface.json` (runner resume hint), `window.json`, `secrets.json` (safeStorage), `cache/usage*.json`; remote mirrors and audit log under `~/.cache/agent-wrangler/remote/`. `HostStorage`/`HostSettings` are the seam. | `sessions.json`, host manifests under `run/`. | A mission store beside `sessions.json`, plus append-only telemetry logs (§23). |
| **GitHub** | None functionally. `PrLink` is parsed out of transcripts; AW never calls GitHub. | — | Optional and explicit only: "open a PR for this mission" through the user's `gh` (§13.3), later "import a mission from an issue" (§24). |
| **UI state** | One workbench webview, dashboard + conversation panes (`src/webview/dashboard/main.ts` 1638 lines, `conversation/main.ts` 1986 lines). Wire protocol in `src/shared/messages.ts`. The table has a status-sections view and a user-sections view. | Interrupted rows, host badges. | A Missions view in the table pane and a task detail in the conversation pane (§18). |
| **Logging / telemetry** | `agent-wrangler.log` (unrotated), the hook event log, the remote audit log. `TurnStats` keeps p50/p75/p90 of turn durations for the ETA column (`src/core/turnStats.ts`). Per-runner `costUsd` and context tokens live only in the live `ComposerState` (Claude only; nothing for Codex) and are never persisted. No analytics SDK, nothing leaves the machine. | Host logs; audit `by` fields. | Durable per-turn and per-attempt records (§16). The ETA percentiles are the precedent: local statistics, computed from our own records. |
| **Budget** | Plan usage windows from `/api/oauth/usage` (Claude) and `account/rateLimits/read` (Codex), polled by `UsageService`; `PauseService` (SIGSTOP); auto-pause at a threshold. | Auto-pause inactive while the core is down (accepted risk). | Admission control reads the same windows (§12.4, §21). |

### 2.2 Where the code assumes a specific provider

From a repo-wide grep; these are the places orchestration must not copy and should not grow:

- `createApp.ts`: `useLiveSessions` (`:198`), close-dialog copy (`:426`), `newConversation` split
  (`:718`), `adopt` split (`:1004, :1009`), and separate `startConversation` /
  `startCodexConversation` closures (`:643, :665`).
- `src/ui/conversation/conversationHost.ts`: eight `provider === 'claude' | 'codex'` branches
  deciding capabilities (`:190, :271, :295–302, :321, :626`). `src/ui/dashboardHost.ts:173`,
  `src/ui/openTarget.ts:25`.
- Webviews: `conversation/main.ts` (`:428, :967, :1018, :1147`) and `dashboard/main.ts`
  (`:583, :623, :739`) branch on the provider string instead of a capability object.
- **Two vocabularies:** `AgentSession.provider` is `'claude' | 'codex'` in practice;
  `ModelChoice.provider` and the launcher's `provider` field are `'anthropic' | 'openai'`
  (`src/shared/conversation.ts:264`, `src/shared/messages.ts:52`). This looks like an
  inconsistency, and it is really two concepts that happen to pair one-to-one today: the harness
  and the model source. §6 names them.
- Telemetry asymmetry: Claude reports `total_cost_usd` and context usage; the Codex runner reports
  neither today.

### 2.3 Boundaries that already suit orchestration

- **`SessionStore` + `DecoratedSessions`**: every surface reads sessions from one place; the
  decoration layer is where mission/task chips go.
- **`SessionActions`**: the single funnel for mutations, already shared by the table, the pane,
  the palette and Discord. Orchestration's "stop attempt", "answer" and "take over" go through it.
- **`HostServices`**: the platform seam (settings, storage, dialogs, secrets) proven by the
  VSCode → Electron move.
- **Injected fakes are the house style.** `RunnerSession` takes an injected `query` (tested with
  `fakeQuery()`), Codex tests use a `FakeServer`, remote control uses a `FakeTransport`. A
  simulated harness (§26.3) is the same idea one level up.
- **The Codex split** (`CodexAppServer` = execution, `CodexRunner` = translation) is the template
  #4 generalises; orchestration sits above both.
- **`ModelCatalogService`** already persists what each CLI says it can run, including effort
  levels per model, and refuses to let a stale or empty answer erase a good list.
- **`TurnStats`** shows the local-statistics pattern: percentiles from our own records, shown as
  estimates.

### 2.4 What must change before orchestration can be added safely

1. **#4 in full** (§1). Without an execution seam and survivable sessions there is nothing safe
   to orchestrate.
2. **Launch options through one typed path.** `runner.model`, `runner.effort`,
   `codexRunner.*` and the default permission mode are read ad hoc in `createApp`. Orchestration
   needs one `LaunchDefaults` it can override per attempt (Phase 0, §29).
3. **Harness vs model source typed apart**, and `AgentSession.provider` narrowed to a union
   (Phase 2).
4. **Turn-end telemetry for Codex** (token usage notifications) to reach parity with Claude
   (Phase 1).
5. **Git plumbing** (Phase 3). There is none.
6. **Composition outside `createApp`.** `createApp.ts` is 1540 lines of closures. Orchestration
   is built by `createOrchestration(deps)` in `src/orchestration/`, taking narrow interfaces
   (`SessionExecutor`, `SessionRegistry`, `SessionActions`, `UsageService`, `PauseService`,
   `LeaseService`, storage), and `createApp` calls it once.
7. **No new provider conditionals in UI.** Orchestration UI reads capabilities from the host,
   never `provider === …`.

---

## 3. External research

The full notes, with sources and what could not be verified, are in
`docs/plans/intelligent-orchestration-research.md`. Summary:

### 3.1 Maestro AI

The closest published analogue: a TypeScript router in front of Ollama and LiteLLM with heuristic
task analysis, four tiers (`local_fast`, `local_strong`, `hosted_oss`, `premium`), a layered
routing pipeline, workload roles, routing modes, budget and privacy guardrails, workflow DAGs,
response evaluation with retry-vs-escalate, telemetry with human accept/reject, and learned hints
from success rates. **Maturity**: created July 2026, last pushed August 2026, one author, 5 stars, no issues or
forks.
An idea source, not validated practice. Its main gaps are this plan's main requirements:
**no crash recovery** (DAG state is an in-memory map), **no effort axis** (tier stands in for
it), no capability discovery, and learned thresholds (n ≥ 5/10/20) too coarse for one user's
volume.

### 3.2 Others

- **Claude Code / Agent SDK**: effort is already a separate axis (`low … max`, per-model
  levels, applied level reported in hooks); `fallbackModel`, `maxTurns`, `maxBudgetUsd`,
  `outputFormat: json_schema` and pre-assigned `sessionId` are usable directly; `opusplan` shows
  phase-split routing; Agent Teams shows a dependency-gated task list, with documented limits
  (no resumption, no nesting, linear token cost, 3–5 teammates suggested).
- **Anthropic's engineering posts**: the workflow vocabulary (routing, orchestrator-workers,
  evaluator-optimizer), multi-agent runs costing ~15× the tokens of a chat turn, self-contained
  task descriptions, and a separate verification pass.
- **Codex**: per-turn `model` and `effort`; OpenAI-compatible and local model providers
  (`model_providers`, `--oss`, built-in `ollama`/`lmstudio`); cumulative token usage per thread;
  rate-limit windows; no USD cost.
- **RouteLLM, NotDiamond, Martian**: learned or hosted routers that need preference data or send
  prompts out. RouteLLM's "calibrate to a target share of expensive calls" is a possible later
  budget strategy.
- **Aider architect/editor**: benchmarked evidence for plan-with-strong, apply-with-cheap.
- **OpenHands, SWE-agent**: hard iteration caps, no retrying into quota walls, a failing test
  before the fix.
- **Claude Squad, uzi, Conductor, Sculptor, Vibe Kanban**: one worktree per unit everywhere;
  conflicts found at merge time and merged one branch at a time; **no tool schedules around
  predicted overlap**.
- **Temporal, LangGraph**: event-sourced replay vs state snapshots. At this scale, snapshots with
  write-ahead intents are enough.
- **Local servers** (Ollama, llama.cpp, vLLM, LM Studio, MLX): each describes itself differently,
  and MLX servers barely at all. Capability facts need per-runtime probes plus user
  declarations (§19).

### 3.3 What was borrowed, and what was not

| Idea | Problem it solves | Their approach | Fit here | Verdict |
|---|---|---|---|---|
| Layered, tightening routing | one opaque decision cannot be explained or tested | Maestro: overrides → analysis → tool floor → prefs → policy → role → mode → budget → guardrails → hints | each layer adds a reason; pure functions | **Adopt** (§9.3) |
| Heuristics first, LLM for the rest, shadow first | paying an LLM to decide whether to pay an LLM | Maestro: LLM only when heuristics are unsure; `shadow` logs agreement | AW's deterministic signals (paths, policy, configured verification) are stronger than keywords | **Adapt** (§8.3) |
| Clamp what an LLM alone can change | an unverified signal promoting a task | Maestro: LLM alone cannot make a task `hard` (cost guard) | here the dangerous error is under-routing | **Adapt, inverted**: the model cannot lower risk below a rule floor or send a task to `basic` alone (§9.3) |
| Four location-flavoured tiers | pick a class of model | Maestro tiers, tier = effort | conflates location and effort with capability | **Reject**; capability tiers as data (three routable + an escalation-only `frontier`) + location + effort axes (§6.3) |
| Workload roles (floors/caps by role) | structural importance not visible in prompt text | Maestro roles; Claude subagent model pinning | `kind` floors and ceilings | **Adopt** (§9.3) |
| Named modes | a coarse user dial | Maestro `local-only`, `cheapest`, `fastest`, `best-quality`, `private` | maps to budget strategies and exclusions | **Adopt**, mostly later (§21) |
| Budget downgrade ladder | running out of money | Maestro: cap tier as budget shrinks | would route below need; budget here is usage windows | **Adapt**: caps + admission control, never below the required tier (§12.4, §21) |
| Retry vs escalate | not every failure needs a bigger model | Maestro evaluator; OpenHands quota classifier | clean mapping to categories | **Adopt** (§15.2) |
| Hard caps, fail fast on quota | runaway loops | OpenHands, SWE-agent | required | **Adopt** (§15.3) |
| Test fails before, passes after | "fixed" without proof | SWE-agent discipline | a verification strategy for bug fixes | **Adopt** (§14.1) |
| Separate verification pass | self-assessment is unreliable | Anthropic research system | core principle | **Adopt** (§14) |
| Human accept/reject in telemetry | automated pass ≠ useful | Maestro `userAccepted`, `userRating` | the label adaptive routing will need | **Adopt** (§16.2) |
| In-memory workflow state | — | Maestro | AW restarts many times a day | **Reject** (§23) |
| Snapshots + write-ahead + history log | crash recovery without a replay engine | LangGraph checkpoints; Temporal (too heavy) | one writer, commit-shaped side effects | **Adopt** (§23) |
| Serialised merges | compounding conflicts | Conductor practice | the Integrator merges one branch at a time | **Adopt** (§13.3) |
| Overlap-aware scheduling | conflicts found too late | nobody does it | a heuristic; measure it | **Build and measure** (§13.4) |
| Learned strong/weak routers | routing from preference data | RouteLLM MF/BERT | no data volume; model-roster churn | **Defer** (§20) |
| Hosted routers | — | NotDiamond, Martian | prompts leave the machine | **Reject** |
| Flat evidence thresholds | when to trust history | Maestro n ≥ 5/10/20 | too coarse for one user | **Adapt**: Beta-binomial bounds + proposals (§20) |
| Random exploration | learning cheaper routes | bandits / Thompson sampling | experiments on real work | **Reject** (§20.4) |
| Phase-split routes | plan and execute need different strengths | `opusplan`; Aider architect/editor | promising, not needed first | **Defer** (§32) |
| Cache stickiness | tier-hopping wastes prompt cache | Maestro sticky tier | continue-session retries keep the cache | **Adopt** (§15.2) |
| Capability discovery | knowing what a local model can do | none of the routers do it | per-runtime probes with provenance | **Adopt** (§19) |

---

## 4. Principles and the four separate decisions

The brief's principles are adopted as written: observable before intelligent, deterministic
before learned, verify before trust, capabilities before model names, local and hosted as peers,
model and effort independent, user in control, explain decisions, fail safely, architecture
before autonomy, gather evidence. Two are added from this repo's own precedents
(`docs/product-context.md` §5):

- **Never claim more certainty than the source gives.** Every assessment dimension carries its
  confidence and where it came from. A cost is labelled "estimate" when it is one. A metric that
  cannot be collected reliably is not shown.
- **Off by default, and wrong means "did nothing and said so".** Orchestration is behind a
  setting. Automatic routing, automatic retry and automatic integration are each separately
  opt-in. A failure stops and surfaces rather than guessing.

The decisions, and who makes each:

| Question | Answered by | Output | Never contains |
|---|---|---|---|
| What needs to be done? | the user, or the planner with the user's approval | `Task` (objective, acceptance criteria, likely scope, dependencies) | a model, a provider, an effort |
| What is the work like? | the assessor | `TaskAssessment` (ordinal dimensions + confidence) | a model, a tier |
| What does the work need? | the router (pure policy) | `RouteRequirement` (minimum tier, effort, hard needs, gates) + reasons | a model name |
| Which concrete thing runs it? | the resolver (catalog + availability + preferences) | `ExecutionTarget` (harness, model source, model, native effort) + rejected candidates | — |
| Which session, in which tree? | the scheduler | `AgentAssignment` + `WorktreeAssignment` | — |

The only place a model name is stored is the `ExecutionTarget` inside a `RoutingDecision`, as a
historical fact, and in a user's explicit pin (§10), as the user's instruction.

---

## 5. Proposed architecture

### 5.1 The brief's pipeline, evaluated

The brief sketches *Mission Planner → Task DAG → Task Assessment → Intelligence Router → Agent
Scheduler → Execution Runtime → Verification → retry/escalate*. Against this repo:

| Brief component | Keep? | Change |
|---|---|---|
| Mission Planner | keep | It is an **agent attempt** like any other (read-only, structured output), routed and recorded the same way. Its output is always reviewed by the user before anything runs (§11). |
| Task / Dependency Graph | keep | Part of the Mission record, validated as a DAG on every edit. |
| Task Assessment | keep, move | Runs **when a task becomes ready**, not only at plan time: upstream results change what a task touches. Plan-time assessment is shown in plan review as a preview. |
| Intelligence Router | **split** | *Router* (pure: assessment + policy → requirement + reasons) and *Resolver* (requirement + catalog + live availability → target). The requirement is stable and reviewable; the binding to a model is made at start time because availability changes by the minute (usage windows, rate limits, a local server going away). One component doing both could not be explained or tested. |
| Agent Scheduler | keep | Owns dependencies, capacity, contention, leases and budget admission. It runs **between** router and resolver: it decides *when* a requirement can start, then asks the resolver *what* to bind. |
| Execution Runtime | **reuse #4** | `SessionExecutor` + hosts. Orchestration adds no runtime. |
| Verification | keep | Pluggable strategies (§14), run by the core in the task's worktree, never by the agent. |
| retry / escalate | keep, split | An *outcome classifier* (deterministic) feeds an *escalation policy* (deterministic, capped). Escalation changes the requirement; it never re-assesses to get a different answer. |
| — | **add: Integration** | Merging a verified task branch into the mission branch, then verifying the mission branch. This is where parallel work actually meets; the brief has no stage for it (§13.3). |
| — | **add: Telemetry sink** | Cross-cutting, not a stage. Every component emits records (§16). |

### 5.2 Component diagram

```text
 user ─► Mission (objective, repo, policy)                                    [MissionService]
           │ planner attempt (read-only, structured plan)                      Phase 8
           ▼
         Plan = Tasks + Dependencies ──► plan review by the user (always) ──► running
           │
  ┌────────┴────────────── for each task, when its dependencies are done ─────────────────────┐
  │ Assessor ─► TaskAssessment         heuristics + one structured LLM call, cached by inputs  │
  │ Router   ─► RouteRequirement       pure policy rules → tier, effort, needs, gates, reasons │
  │ Scheduler: admit?                  deps · concurrency · contention · leases · budget       │
  │ Resolver ─► ExecutionTarget        catalog · health · capacity · prefs · caps              │
  │ Worktree ─► WorktreeAssignment     branch from the mission branch head                     │
  │ SessionExecutor.start (#4) ─► ExecutionAttempt, running in a host                         │
  │   turn results ─► Telemetry                                                                │
  │ Verifier ─► VerificationResult     strategies from repo policy                             │
  │ Outcome classifier ─► EscalationPolicy ─► done │ retry │ escalate │ wait │ needs human     │
  └────────────────────────────────────────────────────────────────────────────────────────────┘
           ▼
         Integrator: merge task branch → mission branch → mission-level verification
           ▼
         Mission review (user): merge locally · push + open PR · discard
```

Everything in the box runs in the core. Hosts run the agents; the core runs `git`, the verifiers
and all policy.

### 5.3 Where it lives in the code

```text
src/shared/orchestration/   pure types and formatters the webviews need (no Node, no DOM)
src/orchestration/
  domain/        state machines and invariants                        pure
  policy/        assessment heuristics, router rules, resolver,
                 escalation policy, scheduler step                    pure, injected clock
  catalog/       CapabilityCatalog, effort maps, health and capacity
  harness/       AgentHarness, adapters over SessionExecutor, SimulatedHarness
  completion/    StructuredCompletion (harness no-tools mode now; local endpoints later)
  git/           WorktreeManager and Integrator (injected exec)
  verify/        strategies and the verification runner
  engine/        MissionService, TaskRunner, Scheduler loop, Recovery
  store/         MissionStore (JsonStore), TelemetryLog (JSONL)
  index.ts       createOrchestration(deps)
src/ui/orchestration/        pane hosts: missions view, task detail
src/webview/dashboard/missions.ts, src/webview/conversation/taskDetail.ts   (inside the workbench bundle)
```

`domain/` and `policy/` are pure in the sense `src/claude/status.ts` is pure: no I/O, a clock
passed in, table-driven tests. That is most of the decision logic, which is what makes routing
explainable and testable without an agent.

### 5.4 Relationship to what exists

- **Sessions stay the unit of display.** An attempt's session is a normal row (hook-backed status,
  conversation, permission cards). `DecoratedSessions` adds a mission/task chip and a route chip.
- **`SessionActions` stays the unit of mutation.** Stop, answer, take over and release an
  orchestrated session exactly like any other. If the user takes over or types into an attempt's
  session, the attempt records `userIntervened` (§16).
- **No new `AgentProvider`.** Orchestration launches sessions; the existing providers already see
  them.
- **Scheduled agents** (`docs/plans/scheduled-agents.md`, #3) become a trigger that creates a
  mission or task on a schedule, rather than a parallel launch path. Both go through
  `SessionExecutor`.

---

## 6. Harness, model source and model: the provider abstraction

### 6.1 Four concepts where the code has one word

| Concept | Meaning | Today | Examples |
|---|---|---|---|
| **Harness** | An agent loop that works in a directory: tools, file edits, shell, its own permission prompts, its own transcript | `claude` / `codex` (`AgentSession.provider`) | Claude Code (Agent SDK), Codex (`app-server`); later any CLI behind #4's host protocol |
| **Model source** | Where inference runs and how it is limited or billed | `anthropic` / `openai` (`ModelChoice.provider`) | Anthropic via the Claude Code login; OpenAI via the Codex login; later `local:<name>` for an OpenAI-compatible server |
| **Model** | One model id at one source, with capabilities | `ModelChoice` | whatever `supportedModels()` / `model/list` return |
| **Execution target** | harness × source × model × native effort: the thing that actually runs | implicit in the launcher dropdowns | Claude Code × Anthropic × `sonnet` × `high` |

Not every combination is valid. Claude Code reaches Anthropic models. Codex reaches OpenAI models
and, through its `model_providers` configuration, OpenAI-compatible servers, including local ones
(§3, §19). The catalog records which harnesses can reach which models; the resolver only builds
valid targets.

A fifth, smaller concept: **structured completion**, a single non-agentic call that returns JSON
matching a schema. The assessor, the plan validator's repair step and the review verifier use it.
AW holds no API key (Claude runs on the subscription login), so today a completion is served by a
harness in no-tools mode: an Agent SDK query with no tools, `maxTurns: 1` and
`outputFormat: {type: 'json_schema', schema}`, whose `result` carries `structured_output`. Later a
local endpoint can serve the same interface directly (§19). Completions are routed like tasks,
normally to the `basic` tier at `low` effort.

### 6.2 Interfaces

Conceptual TypeScript; names are proposals for Phase 2.

```ts
type HarnessId = 'claude-code' | 'codex' | (string & {});
type ModelSourceId = 'anthropic' | 'openai' | `local:${string}` | (string & {});
type EffortLevel = 'low' | 'medium' | 'high' | 'max';     // AW's ordinal, §6.4
type TierName = string;                                    // ordered by the catalog, §6.3

/** A capability value always says where it came from, or that nobody knows. */
type Known<T> = { value: T; from: 'reported' | 'probed' | 'declared' | 'measured' } | { unknown: true };

interface ModelDescriptor {
  source: ModelSourceId;
  modelId: string;               // what the harness is called with (often an alias)
  resolvedId?: string;           // the wire id it resolves to
  label: string;
  location: 'hosted' | 'local';
  contextWindow: Known<number>;
  maxOutputTokens: Known<number>;
  toolCalling: Known<'reliable' | 'basic' | 'none'>;
  structuredOutput: Known<'schema' | 'json' | 'none'>;
  vision: Known<boolean>;
  streaming: Known<boolean>;
  nativeEffort: Known<string[]>;     // e.g. ['low','medium','high','xhigh','max'], or [] for none
  maxConcurrency: Known<number>;     // local servers: slots; hosted: unknown
  throughput: Known<{ outTokPerSec: number; ttftMs: number }>;   // measured from telemetry
  costBasis: 'plan-window' | 'api-price' | 'none';
  price?: { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number };  // for estimates only
  hardware?: { device?: string; memoryGb?: number };               // local only, optional
}

interface CatalogEntry {
  descriptor: ModelDescriptor;
  harnesses: HarnessId[];          // which harnesses can drive it
  tier?: TierName;                 // AW policy; absent = not routable automatically
  enabled: boolean;
  effortMap?: Partial<Record<EffortLevel, string>>;   // AW level → native level
}

interface HarnessCapabilities {
  tools: ('edit' | 'shell' | 'web' | 'mcp' | 'vision-input')[];
  permissionModes: string[];
  preassignedSessionId: boolean;   // Claude: SDK `sessionId` option; Codex: no (id after thread/start)
  resume: boolean; fork: boolean;
  midSessionModelChange: boolean;  // Claude setModel; Codex per-turn `model`
  midSessionEffortChange: 'native' | 'slash-command' | 'per-turn' | 'none';
  structuredFinalOutput: boolean;
  budgetLimits: ('maxTurns' | 'maxBudgetUsd')[];
  reportsCost: boolean; reportsTokens: boolean; reportsAppliedEffort: 'hook' | 'init' | 'none';
}

interface AgentHarness {
  readonly id: HarnessId;
  capabilities(): HarnessCapabilities;
  models(): Promise<ModelDescriptor[]>;           // supportedModels() / model/list, merged into the catalog
  launch(req: AttemptLaunch): Promise<SessionHandle>;  // → #4 SessionExecutor.start
}

interface ModelSource {
  readonly id: ModelSourceId;
  readonly location: 'hosted' | 'local';
  health(): Health;                  // reachable, degraded, down, with a reason and timestamp
  capacity(): Capacity;              // usage-window %, rate-limit backoff until, free slots
}

interface StructuredCompletion {
  complete<T>(req: { schema: object; instructions: string; input: string;
                     requirement: RouteRequirement }): Promise<CompletionResult<T>>;
}
```

The router never sees any of these; it produces a `RouteRequirement`. Only the resolver reads the
catalog, and only the harness adapters touch `SessionExecutor`.

### 6.3 The capability catalog, and why tiers are data

`ModelCatalogService` grows into `CapabilityCatalog`. Each field has a source:

- **reported** by the harness: `supportedModels()` gives display name, description,
  `supportsEffort`, `supportedEffortLevels`, adaptive thinking; Codex `model/list` gives
  `supportedReasoningEfforts`. Claude `modelUsage` reports `contextWindow` and `maxOutputTokens`
  per model after first use.
- **declared** by the user in Preferences: tier, enabled, price table overrides.
- **measured** from telemetry: throughput, time to first token, and later (#52) success rates.
- **probed** from a local server (§19).

**Tiers.** Default ordered tiers: `basic < standard < expert < frontier`. Not the brief's four
(`local-fast`, `local-capable`, `standard`, `expert`), because two of the brief's four encode
*location*, and location is a separate axis here (§0 point 4): a strong local coder is a
`standard` model that happens to be local. The tier list is ordered data, so another tier can be
inserted later without touching task records.

**`frontier` is escalation-only** (decided 2026-09-24, §34). Each tier carries a
`reachableBy: 'route' | 'escalation'` flag; `frontier` ships as `escalation`. The router (§9.3)
never produces it as `minTier`; the resolver (§9.4) never upgrades into it for availability. It is
reached only by (a) the escalation ladder's "raise tier" step from `expert` (§15.2), and only when
the mission's `maxTier` allows it, which by default it does not, or (b) an explicit pin. The
mission creation form shows a "Frontier allowed" checkbox, off by default. Rationale: its models
cost a multiple of `expert` per token and burn the usage window accordingly; they exist for the
rare task that really needs them, not as a routing target.

**Tier assignment is AW policy, stored in settings, not a model property.** Shipped defaults match
the *resolved* model (so the `default` and `opus[1m]` aliases tier as the Opus they resolve to), by
family (`modelName.ts` already knows `haiku`, `sonnet`, `opus`, …). Defaults as decided
(2026-09-24, from the harness-reported catalogs of that date):

| Tier | Claude Code | Codex |
|---|---|---|
| `basic` | Haiku-class (Haiku 4.5) | `gpt-6-luna`, `gpt-reserve` |
| `standard` | Sonnet-class (Sonnet 5) | `gpt-6-sol` |
| `expert` | Opus-class (Opus 5.5) | `gpt-6-astra` |
| `frontier` (escalation-only) | Fable-class (Fable 5.1) | — |
| unassigned | — | superseded generations (`gpt-5.6-*`, `gpt-5.5`); `codex-auto-review` is excluded outright (not a coding model) |

Codex defaults follow Codex's own `model/list` descriptions ("fast and affordable" → `basic`,
"workhorse for coding" → `standard`, "frontier intelligence" → `expert`) and only the newest
generation is assigned: when a newer generation covers a tier, the older one is not routed to.
**A model no default matches is unassigned and cannot be routed to automatically** until the user
assigns it a tier in Preferences. That is how a new model, or a local one, enters the pool: one
setting, no migration, no code.

Because tasks store assessments and routing decisions store the tier *as it was* plus a catalog
version, changing a model's tier changes future routing only.

### 6.4 Effort, independent of the model

- AW's own scale is four ordinals: `low`, `medium`, `high`, `max`. The router produces one.
- Each catalog entry maps them onto its native levels. Default mapping: `low → low`,
  `medium → medium`, `high → high`, `max →` the highest native level *below* a
  session-scoped or extra-cost level (for Claude that is `xhigh` when offered; `max` is reachable
  only by an explicit pin). Codex's `minimal` is reachable only by a pin.
- A model with no effort control records `effortNative: none`. The requested level is still
  recorded, and the resolver prefers a model that supports effort when the requirement is `high` or
  above, as a soft preference only.
- Three values are recorded per attempt: **requested** (AW level), **native** (what was sent) and
  **applied** (what the harness says it used). Claude reports the applied level in tool-context
  hook payloads (`effort.level`, after any silent downgrade) and on some hosts in `system/init`;
  where nothing reports it, `applied` is unknown, not assumed.
- Changing effort mid-session: Claude has no SDK call; AW sends `/effort <level>` (the existing
  `RunnerSession.setEffort`). Codex takes effort per turn. `HarnessCapabilities` says which, so
  escalation (§15) knows whether "raise effort" can continue the session or needs a new one.

Nothing in routing ever infers effort from tier or tier from effort.

---

## 7. Domain model

### 7.1 Entities

Deliberately small. Ownership is the service that is the only writer.

| Entity | Purpose | Owner | Persisted | Notes |
|---|---|---|---|---|
| **Mission** | A user's objective in one repository, with policy and a plan | MissionService | MissionStore | A single task started directly is a one-task mission with no planner and no mission branch |
| **Task** | One coherent unit of work one session can do in one worktree | MissionService | inside its Mission | Holds objective, acceptance criteria, likely scope, dependencies, user overrides |
| **TaskDependency** | "B needs A's result" | MissionService | inside Task (`dependsOn`) | Not a separate record |
| **TaskAssessment** | What the work is like | Assessor | inside its Mission | Immutable; a new one when inputs change |
| **RoutingDecision** | Requirement, reasons, resolution, shadow recommendation | Router + Resolver | inside its Mission | Immutable; one per attempt |
| **ExecutionAttempt** | One try at a task: a session in a worktree | TaskRunner | inside its Mission | Includes the `AgentAssignment` |
| **AgentAssignment** | Which session runs the attempt: `fresh` or `continue` | Scheduler | inside Attempt | Named separately so session reuse (§22) is a new mode, not a refactor |
| **WorktreeAssignment** | A worktree and branch AW created, and its state | WorktreeManager | inside its Mission | Also the mission branch's integration worktree |
| **VerificationPlan** | Ordered stages to run on a result | Verifier | inside Task (derived, persisted for reproducibility) | Stages name strategies from repo policy |
| **VerificationResult** | One stage's outcome with evidence | Verifier | inside Attempt | Logs on disk, only summaries in state |
| **EscalationDecision** | What happened after a failed attempt, and why | EscalationPolicy | inside Task | Records blocked escalations too ("capped at standard") |
| **ExecutionPolicy** (incl. budget) | Routing mode, pins, caps, preferences, limits, autonomy | user, per scope | settings (global), repo policy file, Mission (frozen snapshot + change log), Task (overrides) | §10 |
| Catalog entries | Model / source / harness capabilities | CapabilityCatalog | settings + cache | Not domain state: config and observations |

The brief's *ModelCapability*, *ProviderCapability* and *AgentCapability* become `CatalogEntry` /
`ModelDescriptor`, `ModelSource.health/capacity` and `HarnessCapabilities`: configuration and
live observation, not durable domain state. *BudgetPolicy* is part of `ExecutionPolicy`.

**Not modelled, on purpose:** a Plan entity with versions (edits bump a task's `revision`), an
Agent entity (a session is the agent), a Project entity (`repoRoot` is a string, as #4 decided), a
cost ledger (sums of attempts), a domain-level Turn (turns are telemetry), and agent reputation.

### 7.2 Fields and invariants

**Mission**
- Fields: `id` (ULID), `v`, `title`, `objective` (user text, local only), `repoRoot`,
  `base {ref, commit}`, `integration: {branch, worktreeId} | 'none'`, `policy` (effective snapshot)
  + `policyChanges[]`, `state`, `stateReason`, `plannerAttemptId?`, `tasks[]`,
  `source {kind: 'user' | 'issue' | 'schedule', ref?, trusted}`, `createdAt`, `updatedAt`.
- Invariants: one repository; the task graph is acyclic; at most `policy.maxTasks` tasks (hard
  cap 12 at first); `running` only after a user approved the plan; `completed` only after a user
  chose merge, PR or keep.
- Failure states: `planning-failed` (no valid plan after one repair round, §11.2), `failed`
  (integration impossible and the user gave up), `cancelled`.

**Task**
- Fields: `id`, `key` (`t1`…), `title`, `objective`, `acceptanceCriteria[]`,
  `scope {paths: glob[], subsystems[], confidence}`, `kindHint?`, `dependsOn[] {taskId, kind:
  'code' | 'order'}`, `overrides?`, `verification` (plan), `revision`, `state`, `stateReason`,
  `assessmentIds[]`, `attemptIds[]`, `escalations[]`, `result? {branch, commit, acceptedBy:
  'verification' | 'user'}`, `createdBy: 'user' | 'planner'`.
- Invariants: never `running` unless every `code` dependency is `done` and integrated; at most one
  active attempt; `done` requires a passed verification plan **or** an explicit user acceptance
  (recorded as such); a task never stores a model except inside `overrides` as a user pin.
- Failure states: `blocked` (upstream failed, capacity, lease or budget unavailable), `needs-human`
  (escalation exhausted, unverifiable, conflict), `failed` (user gave up), `cancelled`, `skipped`.

**TaskAssessment**: `id`, `taskId`, `taskRevision`, `inputsHash`, `assessorVersion`,
`dimensions` (§8), `kind`, `domains[]`, `requires[]`, `confidence`, `evidence[]`, `llm?
{completionId, model}`, `createdAt`. Invariant: immutable. Failure: an invalid LLM answer yields a
heuristics-only assessment at low confidence; assessment never blocks a task.

**RoutingDecision**: `id`, `taskId`, `attemptN`, `mode` (`manual | assisted | auto`),
`assessmentId`, `policyVersion`, `requirement {minTier, maxTier, effort, needs, prefer, gates}`,
`reasons[] {ruleId, text, inputs}`, `overrides[]`, `resolution {target, candidates[] {target,
verdict, reason}, catalogVersion}`, `shadow? {requirement, target, reasons}`, `decidedBy: 'router'
| 'user'`, `decidedAt`. Invariant: immutable; `target.tier ≤ requirement.maxTier` always.

**ExecutionAttempt**: `id`, `taskId`, `n`, `routingDecisionId`, `assignment {mode: 'fresh' |
'continue', sessionId, harness}`, `worktreeId`, `state`, `launchedAt`, `endedAt`, `outcome?
{status, category, signature}`, `git {baseCommit, headCommit, commits, filesChanged, insertions,
deletions}`, `verification[]`, `usage` summary (§16), `flags {userIntervened, userEditedBranch,
tookOver}`. Invariants: persisted as `launching` **before** `SessionExecutor.start` is called;
never reopened after it ends; `interrupted` means its session was lost (host or agent gone,
machine down), whether that is seen live or by recovery at startup.

**WorktreeAssignment**: `id`, `purpose: 'task' | 'integration'`, `taskId?`, `path`, `branch`,
`baseCommit`, `state: creating | ready | in-use | retained | removed | missing`, `createdAt`,
`removedAt?`. Invariant: AW only ever removes worktrees it created, and never one that is dirty,
unmerged or in use, and never forces a removal.

**EscalationDecision**: `id`, `taskId`, `afterAttemptId`, `evidence {category, signature,
repeats}`, `action`, `delta {tier?, effort?, harness?}`, `blockedBy? 'cap' | 'pin' | 'limit'`,
`reason`, `decidedAt`.

### 7.3 Durable, runtime and reconstructible state

| Kind | What | Where |
|---|---|---|
| Durable, orchestration | missions, tasks, dependencies, assessments, routing decisions, attempts (incl. assignment), verification results, escalations, worktree assignments, policy snapshots | MissionStore: `orchestration/missions/<id>.json` via `JsonStore` |
| Durable, owned by #4 | session records, launch options, `origin` tags, lifecycle | `sessions.json` (`SessionRegistry`) |
| Durable, owned by #23 | resource leases | registry |
| Durable, owned by the CLIs | conversations | transcripts |
| Durable, append-only | telemetry, mission event history | `orchestration/telemetry/*.jsonl`, `orchestration/missions/<id>.events.jsonl` |
| Runtime | scheduler queue and timers, handle subscriptions, running verifier processes, catalog health, capacity snapshots | core heap |
| Reconstructible | ready set, contention map, cost and token aggregates, UI projections, the catalog itself (from CLIs + settings) | recomputed on start |

### 7.4 Mission lifecycle

```text
draft ─► planning ─► plan-review ─► running ⇄ paused ─► finishing ─► review ─► completed
```

| From | To | When |
|---|---|---|
| `draft` | `planning` | the user asks for a plan |
| `draft` | `plan-review` | the user wrote the tasks |
| `draft` | `running` | a single task started directly (no plan, no review) |
| `planning` | `plan-review` / `planning-failed` | a valid plan / no valid plan after one repair round |
| `planning-failed` | `planning` / `plan-review` | retry the planner / the user writes the plan |
| `plan-review` | `running` / `planning` | approved / replan requested |
| `running` | `paused` ⇄ `running` | the user pauses or resumes |
| `running` | `planning` | replan requested (§11.4); done tasks are kept, the result goes through `plan-review` |
| `running` | `finishing` | every task `done` or `skipped` |
| `running` | `failed` | the user gives up on a task that cannot be completed |
| `finishing` | `review` / `running` | the mission branch verifies / it fails and a task is sent back (§13.3) |
| `review` | `completed` / `cancelled` | merge, PR or keep / discard |
| any non-terminal | `cancelled` | the user cancels |

### 7.5 Task and attempt lifecycles

**Task:**

```text
pending ─► ready ─► assessing ─► routed ─► queued ─► running ─► verifying ─► integrating ─► done
```

| From | To | When |
|---|---|---|
| `pending` | `ready` / `blocked` | dependencies satisfied (§12.3) / an upstream failed |
| `blocked` | `pending` / `ready` / `queued` | the cause cleared (upstream recovered; capacity, lease or budget available) |
| `ready` | `assessing` → `routed` | always |
| `routed` | `queued` / `needs-human` | a requirement within caps / floor above a cap, nothing allowed by policy, or a `plan-first` gate (§9.3) |
| `queued` | `running` / `blocked` | an attempt launched / capacity, lease or budget unavailable (§12.3) |
| `running` | `verifying` | the attempt finished its work |
| `running` | `queued` / `needs-human` | the attempt failed and escalation retries / escalation says human (§15.2) |
| `verifying` | `integrating` / `done` | passed, with / without a mission branch |
| `verifying` | `queued` / `needs-human` | failed and escalation retries / exhausted or unverified (§14.3) |
| `integrating` | `done` | merged, and the mission branch verifies |
| `integrating` | `queued` / `needs-human` | a conflict-resolution attempt, or a revert that sends it back (§13.3) / conflict unresolved |
| `needs-human` | `queued` / `done` / `failed` | the user retries (possibly re-routed) / accepts / gives up |
| `done` | `ready` | only when an integrated upstream is later rejected or reverted **and** the user confirms a rerun (flag `invalidated`) |
| any non-terminal | `cancelled` / `skipped` | the user |

`invalidated` (task) and `staleBase` (attempt) are flags, not states.

**Attempt:**

```text
created ─► launching ─► running ⇄ waiting-human ─► finishing ─► verifying ─► succeeded | failed
```

| From | To | When |
|---|---|---|
| `launching`, `running`, `waiting-human`, `finishing` | `failed` | an error, with a category (§15.1) |
| `launching`, `running`, `waiting-human`, `finishing` | `cancelled` | the user or a mission cancel |
| `launching`, `running`, `waiting-human`, `finishing` | `interrupted` | its session was lost, seen live or at recovery (§23.3) |
| `verifying` | `verifying` | a verifier interrupted by a core restart is re-run (§23.3) |

`waiting-human` mirrors the session's pending ask (permission, question, plan). The attempt's
active-time clock stops while it waits (§16.3).

---

## 8. Task assessment

### 8.1 What the assessor answers

The assessor describes the work, never the model. It answers "what is this work like", not "which
model should run this". Asking a classifier directly for a model couples its output to today's
model names and makes every model launch a retraining event. That is the failure mode the brief
warns about, and it is also what the external routers that learn model choice directly need large
preference datasets to do well (§3).

### 8.2 Dimensions

Six ordinal dimensions on a 0–3 scale with named levels, one categorical, and two sets. Each value
carries `{value, confidence: low | medium | high, from: rule | model | planner | user, evidence}`.

| Dimension | Levels (0→3) | Drives | Deterministic signals | Needs the LLM |
|---|---|---|---|---|
| `complexity`: depth of reasoning | trivial · routine · involved · hard | tier, effort | kind hints from the objective; docs-only scope → trivial | yes, mainly |
| `breadth`: how much of the repo | single-file · few-files · subsystem · cross-cutting | tier, contention | count and spread of `scope.paths`; subsystems touched | only when scope is empty |
| `risk`: cost of an undetected mistake | low · moderate · high · critical | tier floor | **path rules** from repo policy (protocol files, persisted formats, migrations, auth/permission code, dependency manifests, CI); deletions | yes, for semantic risk |
| `ambiguity`: how underspecified | clear · minor-gaps · underspecified · open-ended | effort, gates | number and testability of acceptance criteria | yes |
| `verifiability`: can a machine check it | none · weak · partial · strong | tier ceiling for cheap routes | verification commands configured in repo policy; tests exist near `scope.paths`; docs with no configured check → weak, with a configured docs check (lint, link check) → partial | refines |
| `contextLoad`: how much must be read | small · medium · large · very-large (≈ <30k, <100k, <250k, >250k tokens) | hard constraint on context window | sizes of files in scope + a fixed allowance | no |
| `kind` (categorical) | docs, test, bugfix, feature, refactor, migration, architecture, investigation, review, chore, conflict-resolution, plan (the planner's own task, §11.1) | cohort key, floors | path patterns, verbs | yes when unclear |
| `domains` (set of tags) | e.g. `typescript`, `ui`, `unity`, `shader`, `db`, `git` | cohort key, special constraints | file extensions, repo policy tags | refines |
| `requires` (set) | `edit`, `shell`, `network`, `vision`, `browser`, `exclusive:<resource>` | hard constraints | repo policy (Unity → `exclusive:unity-editor:<project>`), kind | refines |

**Considered and not used for routing:**

- *Expected duration*: an outcome, predicted later from telemetry cohorts rather than asked for.
- *Parallelizability*: a property of the graph, not of a task.
- *Tool intensity*: folded into `kind` and `breadth`, and measured after the fact (tool-call
  count).
- *Specialization*: represented by `domains`.

**Why ordinals with named levels, not normalised 0–1 scores?** Self-reported probabilities from
LLMs are poorly calibrated. Four named levels are what a human can check in plan review, what
a rule can be written against, and what the evaluation corpus can label. Calibration comes later,
from telemetry (§20).

**Why categorical confidence?** It drives exactly three behaviours (§9.2): high confidence →
use the value; medium → use it, and bias towards the safer side if it decides the tier; low →
the router adds one tier and never routes to `basic` (§9.3 rule 5). More resolution would not change a
decision.

### 8.3 How it runs

1. **Deterministic pass** (always, instant, free): path rules, scope statistics, configured
   verification, file sizes, kind hints. It produces floors (e.g. `risk ≥ high` because a path rule
   matched) and hard facts (`contextLoad`).
2. **One structured completion** (§6.1) at `basic` tier and `low` effort, given: the objective,
   the acceptance criteria, the scope globs and the deterministic facts. **Not** the code: a
   classifier reading the repository costs more than the task it is classifying. It returns the
   dimensions with a confidence and one line of evidence each, validated against a JSON schema.
3. **Combine.** Risk = max(rule floor, model). Verifiability = min(what is configured, model),
   because a verifier that does not exist cannot be imagined into existence. Other dimensions take
   the model's value unless a rule or the user set them. A user edit in plan review wins and is
   recorded as `from: user`.
4. **Cache** by `inputsHash` (objective, criteria, scope, upstream results, assessor version).
   Re-assess when a task becomes ready and its upstream changed what it touches.

If the completion fails or returns invalid output twice, the task keeps the deterministic
assessment at `confidence: low`, which routes conservatively. Assessment never blocks a task.

### 8.4 What each signal costs

| Signal | Cost | Reliability |
|---|---|---|
| Path rules, scope statistics, file sizes | ~0 | high where the repo policy is good |
| Configured verification | ~0 | high |
| LLM dimensions | one `basic`/`low` call; a few thousand tokens | medium; this is what the evaluation corpus (§27) and shadow mode measure |
| Planner-supplied hints | free (already paid for in planning) | medium; shown in plan review |

---

## 9. Routing

### 9.1 Router, then resolver

```text
TaskAssessment + ExecutionPolicy ─► Router (pure) ─► RouteRequirement + reasons[]
RouteRequirement + Catalog + health + capacity + preferences ─► Resolver ─► ExecutionTarget
                                                                         + candidates[] (with why not)
```

The router is a pure function of the assessment and policy, so the same inputs always give the
same requirement and the same explanation. The resolver is also a function, of the requirement
and an explicit *snapshot* of the catalog, health and capacity, so a decision can be replayed in a
test and explained after the fact.

### 9.2 The routing principle that sets the thresholds

**Under-routing is cheap when verification will catch it, and expensive when it will not.** A
`basic` model that fails a strong test suite costs one cheap attempt and an escalation. A `basic`
model that produces a plausible, wrong change with no verifier costs a human finding it later, or
nobody finding it. Over-routing costs money or usage window, which is visible and bounded. So:

- the cheapest tier is allowed only where verifiability is at least `partial` and risk at most
  `moderate`;
- risk sets floors; complexity sets the base;
- low confidence pushes towards the safer side;
- effort is driven by complexity, ambiguity and weak verification, which buy more deliberation
  from the same model, and never by tier.

### 9.3 Initial policy

Rules are data (TypeScript objects with an id, a predicate over the assessment, an effect and a
reason template), evaluated in a fixed order. Every rule that changes the result adds a reason.
These are **starting values**, justified by §9.2, to be calibrated against the evaluation corpus
(§27) and the shadow record before automatic routing is switched on.

**Tier.**

1. `score = complexity (0–3)`; `+1` if `breadth ≥ subsystem`; `+1` if `risk ≥ high`.
2. `score 0 → basic`, `1–2 → standard`, `≥ 3 → expert`.
3. Floors: `risk = critical → expert`; `kind ∈ {architecture, plan}` → `expert` (a bad plan
   multiplies every downstream cost); `kind = migration → standard`. Kind ceilings: `kind ∈ {docs, chore}` → at most `standard`
   unless `risk ≥ high`. Floors and ceilings by kind are Maestro's "workload roles" idea (§3.3).
4. Guard: `basic` requires `verifiability ≥ partial` and `risk ≤ moderate`, otherwise `standard`.
   The verifiability used here is the *configured* one (§8.3), so the model's answer alone can
   never send a task to `basic`. Neither can it lower risk below a rule's floor.
5. Low confidence on `complexity` or `risk` → `+1` tier, never below `standard`.
6. Ceilings: the user's caps (§10) — **a cap is never exceeded; if the floor is above the cap, the
   task goes to `needs-human` with both reasons**, instead of silently running under-powered or
   over the cap.
7. The result is clamped to the highest tier with `reachableBy: route` (today `expert`). No rule
   produces `frontier` (§6.3).

**Effort (independent of tier).**

1. `effort index = complexity`, i.e. trivial → `low`, routine → `medium`, involved → `high`,
   hard → `high`.
2. `+1` if `verifiability ≤ weak` and `complexity ≥ routine` (the agent must check its own
   work, and there is something to check), `+1` if `ambiguity ≥ underspecified`; the result is
   capped at `high`.
3. `max` only when `complexity = hard` **and** (`ambiguity ≥ underspecified` or
   `verifiability ≤ weak`), or by an explicit pin or escalation.

**Gates.** `ambiguity = open-ended` adds `plan-first`: the task needs clarification or a planning
step before an agent edits anything (the planner, or a question to the user). `risk = critical` adds
`human-review`: verification passing is not enough to integrate.

**Hard needs** come from `requires` and `contextLoad`: tools, vision, and a context window of at
least the estimate × 1.5 headroom.

Worked examples (tier/effort; concrete targets are illustrative, from today's catalog):

| Task | Assessment | Requirement | Could resolve to |
|---|---|---|---|
| Fix a typo in the README | trivial, single-file, low risk, verifiability weak | `basic` guard fails (weak) → `standard` / `low` | Sonnet · low |
| Rename a helper across the repo, typecheck + tests | routine, cross-cutting, moderate, strong | score 2 → `standard` / `medium` | Sonnet · medium, or a Codex standard model |
| Add a unit test for a pure function | routine, single-file, low, strong | score 1 → `standard` / `medium` | Sonnet · medium |
| Tricky off-by-one in one parser file, weak tests | involved, single-file, moderate, weak | score 2 → `standard`; effort 2+1 → `high` | Sonnet · high |
| Bump a dependency pinned by the host protocol | routine, few-files, **critical** (path rule), strong | floor → `expert`; effort `medium`; gate `human-review` | Opus · medium |
| Redesign the session registry format | hard, subsystem, high, partial, architecture | score 5 → `expert` / `high` | Opus · high |
| Update docs for a shipped feature (a docs lint configured; local model enabled) | trivial, few-files, low, partial | `basic` / `low` | Haiku · low, or a local model · low |

This table is where "Sonnet + low, Sonnet + high, Opus + medium" come from: the axes are fed by
different dimensions.

### 9.4 The resolver

1. **Candidates**: every enabled catalog entry with a tier, whose harness can do the task's hard
   needs (agentic tools, vision), whose context window is known and large enough, and whose source
   is allowed by policy (source, harness and location allow/deny lists, local on or off).
2. **Tier fit** (under the default *balanced* strategy, §21): prefer exactly `minTier`. A higher tier is used only if no candidate at `minTier`
   is available *and* it is within `maxTier`. The decision records "upgraded: no standard model
   available (usage window 97%)". An availability upgrade never enters an escalation-only tier.
3. **Availability**: source health up; capacity free (usage window below the admission threshold,
   no rate-limit backoff, a free slot for local servers).
4. **Rank** within the fit: user preferences (preferred harness or source, prefer local), then
   lower estimated cost for the budget strategy (§21), then stable ordering by catalog position.
   Session stickiness is a later rank key (§22).
5. **Output**: the target, the ordered fallbacks for escalation and failover (a Claude attempt
   may pass a same-tier fallback as the SDK's `fallbackModel` for overload failover, never a
   model of another tier), and every rejected candidate with its reason ("Opus: above mission cap `standard`", "local:qwen: context 32k <
   needed 60k", "Codex model X: usage window 99%").

If there are no candidates, the task goes to `blocked` with the reason if capacity will free up
(a usage window resets), or to `needs-human` if policy excludes everything.

### 9.5 Explaining a decision

The user can ask "why is this running on an expensive model?" of any attempt, and the answer is
assembled from the stored decision, not regenerated:

> **Opus · high** (expert tier). Expert because *risk = critical* (rule `risk.path`: touches
> `src/shared/sessionProtocol.ts`, listed as protocol-critical in this repo's policy) and
> *kind = architecture* (rule `floor.architecture`). High effort because *complexity = hard*.
> Cheaper candidates: Sonnet (standard) is below the required tier. Mode: automatic. Assessment
> confidence: high (rules + model agreed).

Rendered in the task detail (§18) and as the tooltip of the route chip.

---

## 10. Routing modes, overrides and trust

### 10.1 Modes

| Mode | Who picks the route | Router's role | When |
|---|---|---|---|
| `manual` | the user, per task or from mission defaults (today's launcher dropdowns) | shadow: records what it would have picked | from Phase 3 |
| `assisted` | the router proposes; the user accepts or changes it in one click | proposes; the user's change is recorded as a labelled disagreement | from Phase 5 |
| `auto` | the router, within caps | decides | from Phase 7, opt-in per mission |

`assisted` is the bridge: it is useful immediately (no dropdown fiddling), and every accept or
override is labelled data about routing quality at no extra cost.

### 10.2 Controls

Four kinds of control, at four scopes. The more specific scope wins, except that **caps only ever
tighten**:

| Control | Examples | Global prefs | Repo policy | Mission | Task |
|---|---|---|---|---|---|
| **Pin** (fix a dimension) | force harness, force model, force effort | ✔ default route for manual | ✔ | ✔ | ✔ |
| **Cap** (hard limit) | max tier, max effort, max attempts, max concurrent agents, max estimated hosted spend, max usage-window %, local-only, hosted-only | ✔ | ✔ | ✔ | ✔ |
| **Preference** (ranking) | prefer local, prefer a harness or source, budget strategy | ✔ | ✔ | ✔ | ✔ |
| **Exclusion** | disable local models, exclude a source or harness | ✔ | ✔ | ✔ | ✔ |

Rules:

- A pin that violates a cap is a **validation error at the time it is set** ("this task pins Opus;
  the mission is capped at standard"), never resolved silently in either direction.
- A pin freezes that dimension for escalation: a pinned model is never switched, a pinned effort
  is never raised. If escalation has nothing left to move, the task goes to `needs-human` and says
  which pin or cap stopped it (the brief's example: a mission capped at `standard` never jumps to
  `expert` by itself).
- A mission's effective policy is frozen when it starts. A later change applies to attempts not
  yet started, is recorded as a policy-change event, and is shown in the mission header. Running
  attempts are not restarted.

### 10.3 Trust

- Every automatic choice is inspectable (§9.5) and can be overridden before or after it runs.
- Expensive routes are visible without looking (§18): the route chip is emphasised for the
  `expert` tier and for `max` effort.
- Automation is layered and each layer is separately opt-in: assisted routing → automatic routing
  → automatic retry → automatic escalation of tier → automatic integration into the mission branch.
  Merging into the base branch or pushing is never automatic (§13.3).

---

## 11. Mission planning and decomposition

### 11.1 The planner is an attempt

The planner is an ExecutionAttempt of a special task (`kind: plan`), routed like any other
(normally `expert`/`high`: a bad plan multiplies every downstream cost), run **read-only**
(`permissionMode: plan`, no edit tools) in the mission's base checkout, with a structured final
output. It reads the repository the way an agent does, which is the only way it can name likely
scope honestly. Its conversation is a normal session the user can read.

Its output schema, per task: `title`, `objective`, `acceptanceCriteria[]` (each testable),
`scope {paths[], subsystems[]}`, `dependsOn[]` (by key, with `code` or `order`),
`verification` (names of repo-policy strategies, never commands), `assessmentHints`, and
`whySeparate` (one line: why this is not part of a neighbouring task). Plus mission-level
`decomposition: single | multiple` and `risks[]`.

### 11.2 Validation, then the user

Deterministic checks on the planner's JSON, before the user sees it:

- the schema; at most `maxTasks` (default 8, hard cap 12);
- the graph is acyclic, with no dangling or self references;
- every task has at least one acceptance criterion;
- every named verification strategy exists in repo policy;
- paths are inside the repository;
- **overlap**: two tasks with no dependency between them whose scopes overlap are flagged
  (merge them, or add an ordering edge).

One repair round is allowed: the failures go back to the planner session as a follow-up turn.
A second failure → `planning-failed`, with the planner's conversation available.

Then **plan review, always**, in every mode including `auto`. The user can edit, merge, split,
reorder or delete tasks, change dependencies, set pins and caps, and see each task's preview
assessment and route requirement. Nothing runs until the user approves. This is the main
safeguard against a planner that decomposes badly, and against model-generated work in general
(§24).

### 11.3 When not to decompose

The planner is told, and the validator enforces, that **one task is the default**. A split has to
pay for itself. Rules given to the planner and checked where they can be:

- Split only along a boundary that lets the parts be **verified independently** (each has its own
  acceptance criteria that a machine can check) *or* run in parallel on **disjoint files**.
- Do not split work that edits the same files; that is one task, or a chain.
- A task should be worth an agent's start-up: roughly, more than one focused sitting of work for
  the task's tier. Anything smaller folds into a neighbour.
- Mechanical follow-ups (docs, changelog) belong to the task that makes them necessary.
- A chain of strictly sequential tasks on one subsystem is usually better as one task with a
  longer session: context carries over, and there are no merge points.

What decomposition buys and costs, which the planner prompt spells out:

| Force | Favours splitting | Favours one task |
|---|---|---|
| Independent execution / parallelism | disjoint scopes | shared files |
| Context sharing | — | a sequence on one subsystem |
| Coordination overhead | — | always a cost: planning, integration, re-verification |
| Merge risk | — | overlapping scopes |
| Verification | parts independently checkable | only the whole is checkable |
| Agent start-up | — | small parts; each costs a session, context loading and a worktree |
| Routing | parts of very different difficulty (a trivial part can run cheaply) | uniform difficulty |

The last row is where orchestration earns money: a mission with one hard part and four routine
parts can run the routine parts on `standard` models in parallel.

### 11.4 Replanning

Replanning is explicit, by the user, or proposed by escalation when a task fails as "too large"
(context overflow twice, or `split-task`, §15). A replan runs the planner with the current state
(done tasks, failed tasks and their evidence) and produces a *diff* to the plan, which goes
through the same review. Done tasks are never replanned away.

---

## 12. Dependency graph and scheduler

### 12.1 The graph

- Edges: `code` (B needs A's result in its tree, i.e. A integrated into the mission branch
  before B's worktree is cut) and `order` (B starts after A finishes; no code carried).
- `A → B`, `A → C`, `B + C → D`: B and C start when A is integrated; D's worktree is cut from the
  mission branch after both B and C are integrated.
- The graph is validated on every edit: acyclic (Kahn's algorithm), no dangling edges, no edge
  into a `done` task from a non-done one.
- Editing is allowed while the mission is `plan-review` or `paused`, and for tasks not yet started.
  Changing a running task's upstream marks its attempt `stale-base`: it must pass a merge check
  against the new base before integration.

### 12.2 The scheduler is a pure step function

```ts
schedule(state: MissionsSnapshot, capacity: CapacitySnapshot, now: number): SchedulerAction[]
// actions: start(taskId, requirement) · wait(taskId, reason, until?) · block(taskId, reason)
//          · unblock(taskId) · integrate(taskId) · finish(missionId)
```

The engine calls it on every relevant event: an attempt ended, a verification finished, a merge
finished, the user acted, capacity changed, a usage window moved, the fleet was paused or resumed.
The engine then executes the actions. Being pure, it is tested with tables and in simulation
(§26.3).

### 12.3 What it considers

| Concern | Rule |
|---|---|
| Dependency completion | `ready` when every `code` dependency is integrated and every `order` dependency is `done` |
| Failed dependency | downstream → `blocked (upstream t2 failed)`; unblocks if the upstream is later recovered |
| Invalid upstream | if an integrated upstream is later rejected or reverted by the user, downstream attempts that started from it are marked `invalidated` and their tasks return to `ready` after the user confirms |
| Cancellation | mission cancel → end running attempts through `SessionActions` (graceful), stop verifiers, keep branches and worktrees for inspection until cleanup |
| Retries | a retry is a new attempt through the same admission path |
| Pause / resume | mission pause = start nothing new; running attempts continue. "Pause now" additionally pauses their sessions with the existing `PauseService` (SIGSTOP), which #4 targets at the agent pid |
| Priority | longest remaining downstream path first (critical path), then mission priority, then age |
| Concurrency | global max concurrent attempts (default 3), per repository (default 2), per harness and per source (from capacity), per local endpoint (its slot count) |
| Verification concurrency | one verification per repository at a time by default (test suites contend for CPU, ports and caches), configurable |
| Repository contention | two tasks whose `scope.paths` overlap never run at the same time unless the mission allows it (§13.4) |
| Exclusive resources | a task that `requires exclusive:<resource>` starts only after its lease is acquired (#23) |
| Agent availability | `blocked (capacity)` rather than failed; waits |
| Model availability | the resolver finds no candidate → wait if capacity will return, else `needs-human` |
| Provider rate limits | a 429 or rate-limit error sets a backoff on the source; the scheduler holds new work for it |
| Fleet pause | while `PauseService` says the fleet is paused, nothing starts |
| Budget | admission is refused when a cap would be exceeded or a usage window is above the admission threshold (default 85%, below the existing auto-pause at 98%) |

### 12.4 Admission control and the usage windows

The existing Budget feature is the real constraint on this machine. Admission reads the same
`UsageService` snapshots: no new attempt on a source whose window is above the admission threshold,
and mission caps expressed as "stop starting work when the 5-hour window reaches N%". This keeps
orchestration from being the thing that pushes the fleet into auto-pause.

---

## 13. Git, worktrees and exclusive resources

### 13.1 Rules

1. **Every attempt that edits runs in a worktree AW created for it** (or, for a sequential P8 mission, for its mission; never shared by two running attempts). Never in the user's primary
   checkout, never in another task's tree. This is CLAUDE.md's rule, enforced by construction.
2. **AW does the git work, not the agent.** Creating, setting up, merging and removing worktrees
   and branches are core operations (`WorktreeManager`, `Integrator`) with an injected `exec`,
   tested against real temporary repositories. Agents commit on their own branch inside their own
   tree, which is what they already do.
3. **Nothing reaches the base branch or the remote without a click.** AW merges task branches into
   the *mission* branch. Merging the mission branch into `main`, pushing, and opening a PR are
   explicit user actions in mission review.

### 13.2 Layout and naming

```text
<repo>                                   primary checkout — untouched
<repo>.aw/<mission-slug>/_integration    mission branch  aw/<mission-slug>/mission
<repo>.aw/<mission-slug>/t1              task branch     aw/<mission-slug>/t1
<repo>.aw/<mission-slug>/t2-a2           a fresh retry   aw/<mission-slug>/t2-a2
```

(The mission branch is `…/mission`, not `aw/<mission-slug>` itself: git cannot have a branch that
is also a directory of branches.) A fresh retry gets its own branch and worktree (`-a<n>`); the
failed attempt's branch and tree are kept, unchanged, for comparison until the mission is cleaned
up.

- Siblings of the repository, as CLAUDE.md does by hand, grouped under one `<repo>.aw/`
  directory so they are easy to find and never inside the primary checkout's file watchers.
  Configurable per repository.
- The mission branch is cut from `base.commit` (recorded when the mission starts). A task branch
  is cut from the mission branch's head when the task starts, so it contains every integrated
  upstream.
- **Setup** after creation comes from repo policy as structured steps (symlink a directory from
  the primary checkout, copy an ignored file, run an allowlisted command). This repo's policy
  would link `node_modules`, as CLAUDE.md does by hand.
- A single-task mission has no mission branch; its task branch is the result.

### 13.3 Integration

1. Verification passes (§14) on the task branch.
2. The Integrator merges the task branch into the mission branch in the integration worktree
   (`git merge --no-ff`), recording the pre-merge head first. **Merges are serialised per
   mission**: one branch at a time, each followed by its mission-level verification, even when
   the tasks ran in parallel. That is the practice parallel-agent tools converge on (§3.2).
3. **Conflict** → abort the merge, task → `integrating: conflict`. Options, by policy: create a
   `conflict-resolution` attempt (a task of that kind, routed normally, in the task's worktree:
   merge the mission branch into the task branch, resolve, re-verify), or `needs-human`. Bounded
   by the task's attempt limit.
4. After each merge, run the mission-level verification on the mission branch (by default the
   repository's full check). This is what catches two changes that pass alone and break together
   (semantic conflicts: no textual conflict, but the combination is broken). A failure there blames the last
   merge, reverts it on the mission branch (a new revert commit, never a history rewrite), and
   sends that task back with the evidence.
5. When every task is integrated and the mission branch verifies: mission `review`. The user
   chooses: merge into the base locally (`--no-ff`, as this repo does), push the branch and open a
   PR with `gh` (as other repos do), keep it, or discard it. Per-repo policy sets the default
   button. **Merge-locally is gated** (decided for this repository, §34): the merge into the base
   is first made in the integration worktree, the repository's full check (typecheck, tests,
   build) runs on that merged result, and the base branch moves only if it passes. The bar is
   "the base stays usable for daily work": a mission may finish with part of a feature
   incomplete, provided that part is behind a setting that is off by default. Finishing never
   runs `app:install`; it reports that an install is needed.

**Rebases** are never done by AW on a branch an agent is using. Keeping a task current is done by
merging the mission branch into the task branch, and only when the task needs it (stale base or
conflict).

### 13.4 Contention before it becomes a conflict

- Before starting a task, the scheduler compares its `scope.paths` and `subsystems` with every
  running task in the same repository. An overlap serialises them (the later one waits with the
  reason shown) unless the mission sets `allowOverlap`.
- Scope is a prediction. After each attempt, the actual changed files are compared with the
  predicted scope and recorded (`scopeAccuracy`, §16). A task that wrote well outside its scope is
  flagged in review, and the measurement tells us whether scope prediction is good enough to rely
  on.
- #22's checkout-sharing warning covers the other half: a session (orchestrated or not) that is
  started in a tree another live session is using.

### 13.5 Exclusive resources beyond git

Git isolation separates files. It does not separate things a repository uses *outside* its files:

- **Unity**: the Editor locks a project directory (one Editor per project path); each worktree
  needs its own `Library/` import, which is slow and large; PlayMode and EditMode tests need the
  Editor or a batch-mode Editor on that path; licences may limit concurrent Editors. Unity tasks
  therefore declare `requires: exclusive:unity-editor:<project>` (from repo policy), are serialised
  per project by lease, and, per repo policy, may share one long-lived Unity worktree per mission
  instead of one per task, to avoid repeated imports.
- **Other examples**: a local database, a fixed port, a simulator, a hardware device, and in this
  repository `/Applications/Agent Wrangler.app` (CLAUDE.md: "Only one agent runs
  `npm run app:install` at a time" is an exclusive resource written as prose).

Leases come from the core `LeaseService` that #23 leads to (§1.1). Orchestration acquires one
**held by the attempt** before starting it (§1.3 A5; a Codex session has no id until
`thread/start`), binds it to the session's registry id once that exists, and releases it when the
attempt ends or is lost.
A lease the scheduler cannot get means `blocked (waiting for unity-editor)`, never a parallel start.

### 13.6 Per-repository policy

One file per repository, owned by the user, holding what orchestration must not guess:

```jsonc
{
  "worktrees": { "root": "../<repo>.aw", "setup": [{ "link": "node_modules" }] },
  "verification": {
    "typecheck": { "run": ["npm", "run", "typecheck"], "timeoutSec": 300 },
    "unit":      { "run": ["npm", "test"],             "timeoutSec": 900 },
    "missionDefault": ["typecheck", "unit"]
  },
  "risk": [
    { "paths": ["src/shared/sessionProtocol.ts", "src/shared/messages.ts"], "level": "critical", "why": "wire protocol" },
    { "paths": ["src/claude/hookInstall.ts"], "level": "high", "why": "writes into ~/.claude/settings.json" }
  ],
  "exclusive": [],
  "finish": { "default": "merge-local" }
}
```

**Where it lives (decided 2026-09-24, §34): on AW's side only.** Orchestration writes nothing
into the repository. The file is `<userData>/repos/<repo-id>.json`, where `repo-id` is derived
from the repository's git common directory (`git rev-parse --git-common-dir`), so the primary
checkout and every worktree of a repository resolve to the same policy. It is edited in
Preferences (a per-repository page), with the same schema as above. Rejected alternatives: a
committed `.agentwrangler/policy.json` (modifies the repo); a gitignored or
`.git/info/exclude`d file in the primary checkout (untracked files do not appear in new
worktrees, so every attempt would have to reach back into the primary tree anyway). A repository
with no policy file gets no automatic verification, which by §9.3 rule 4 keeps it off `basic`.

---

## 14. Verification

### 14.1 Strategies

```ts
interface VerificationStrategy {
  readonly id: string;                                        // 'command', 'diff-sanity', 'review', …
  applies(task: Task, policy: RepoPolicy): boolean;
  run(ctx: VerifyContext): Promise<VerificationOutcome>;       // ctx: worktree, base/head commits, task, limits, log sink
}
type VerificationOutcome = {
  outcome: 'passed' | 'failed' | 'inconclusive' | 'unavailable' | 'error';
  summary: string; evidence: { exitCode?: number; logPath?: string; failing?: string[]; signature?: string };
  flaky?: boolean; preExisting?: boolean; durationMs: number;
};
```

| Strategy | What it checks | Phase |
|---|---|---|
| `command` | any repo-policy command: compile, typecheck, unit/integration tests, lint, static analysis, Unity batch-mode EditMode/PlayMode runs, screenshot comparison scripts | 4 |
| `diff-sanity` | the diff is non-empty when the kind expects changes; no files outside the repository; changes outside predicted scope (warning); deleted or skipped tests (warning); obvious secrets; conflict markers | 4 |
| `regression-test` | for bug fixes: the tests the attempt added or changed **fail on the base commit and pass on the head** (SWE-agent's discipline, §3.3) | 4 |
| `architecture` | repo-policy constraints expressed as checks, e.g. this repo's import rules (`src/webview/**` imports only `src/shared/**` and `src/webview/common/**`) as a command | 4 (as `command`) |
| `review` | a **read-only reviewer attempt** routed as `kind: review`, given the objective, acceptance criteria and diff, returning a structured verdict per criterion (`met`, `unmet`, `unclear`) plus concerns | 4, advisory at first |
| `acceptance` | each acceptance criterion mapped to a check (a named command, or the reviewer's verdict for it) | 4 |
| `human` | an explicit approval in the task detail | 4 |
| `visual` | screenshot/visual regression via a repo command | when a repo configures one |

### 14.2 Verification plans

A task's plan is built from repo policy (defaults per kind), the planner's named suggestions and the
user's edits: ordered stages, each `required` or `advisory`, each with a timeout. Cheap
deterministic stages run first (`diff-sanity`, typecheck), then tests, then `review`. A required
stage failing stops the plan.

The core runs verifiers as child processes in the task's worktree, with an explicit environment
(the same `ELECTRON_*` / `AW_*` stripping #4 applies to hosts), a timeout, and output to
`orchestration/logs/<attempt>/<stage>.log`. State keeps the exit code, a short summary, the failing
test names and a failure signature. **Commands come only from repo policy**, which the user wrote;
a model can name a strategy but never supply a command.

### 14.3 When verification is not a clean pass

| Situation | Handling |
|---|---|
| **Unavailable** (no strategy applies, or the repo has no commands) | Task result `unverified`. It can only become `done` by explicit user acceptance. The router already treats `verifiability: none` as a reason not to go cheap. |
| **Inconclusive** (e.g. the review verdict is `unclear`, a visual diff is borderline) | Treated as not passed for a required stage; shown to the user with the evidence. |
| **Flaky** (fails, then passes on an unchanged tree) | A failing test stage is re-run once on the same commit. Pass on re-run → `passed, flaky: true`, recorded in telemetry and shown; the signature is remembered so repeated flakes on the same test are visible. |
| **Pre-existing failure** | A failure is checked against the task's base commit (cached per base commit). If it fails there too → `preExisting: true`, the stage is `inconclusive`, not blamed on the agent, and the user is told the base is red. |
| **Partial** (some required stages pass, one fails) | Failed. Advisory stages failing → passed with warnings. |
| **Verifier crashed or timed out** | `error`: an infrastructure failure, not a quality verdict. Retried once; then `needs-human`. Never counted as the agent's failure in telemetry. |
| **Agent claims success with no meaningful diff** | `diff-sanity` fails (`no-diff`) for kinds that expect changes. |

### 14.4 Mission-level verification

After each integration, and before mission review, `missionDefault` runs on the mission branch
(§13.3). Its result is part of the mission's health indicator.

---

## 15. Retry and escalation

### 15.1 Classify first, then decide

After an attempt ends, a deterministic **outcome classifier** turns structured evidence into a
category, and the **escalation policy** maps the category plus history to one action. No LLM is
involved in the MVP. An optional LLM diagnosis step can be added later, as advisory text for the
human.

Evidence available without guessing: Claude `result.subtype`, `is_error`, `terminal_reason`
(`prompt_too_long`, `max_turns`, `budget_exhausted`, `api_error`, `model_error`, …),
`api_error_status` (e.g. 429), `permission_denials`; Codex turn status and errors; #4 session
states (`failed`, `lost`); verification outcomes and signatures; git diff statistics; whether the
session ended with a pending question.

### 15.2 The ladder

| Category | Evidence | Action |
|---|---|---|
| `infra` | API 5xx or a dropped stream inside a live session | retry the **same route in the same session** after backoff (not counted against quality limits, up to 2); then fail over to another harness at the same tier if allowed; then `needs-human` |
| `lost` | the session itself is gone (host or agent crash, machine down): attempt `interrupted` | **Resume attempt** / **Retry fresh** offered to the user; automatic only with the mission's `autoRecover` (one resume), matching #4's no-auto-resume rule (§23.3) |
| `capacity` | 429, rate limit, usage window over threshold | `wait` until capacity returns (the scheduler holds it); fail over to another source only if the policy allows; **never** raises the tier |
| `context` | `prompt_too_long`, context overflow | a same-tier model with a larger window; else propose `split-task` (replan); else `needs-human` |
| `quality-new` | verification failed with a signature not seen before on this task | retry **continuing the same session** with the failure evidence as the next message (cheap, and the context is warm) |
| `quality-repeat` | the same signature as the previous attempt | move one step along the ladder: raise effort → raise tier → switch harness → `needs-human`, skipping any step a pin or cap forbids |
| `empty` | no diff, or "done" with nothing done | one retry with an explicit instruction; then `needs-human` |
| `ambiguity` | the agent asked a question, or the task has the `plan-first` gate | `needs-human` (the question is already a Waiting row); nothing automatic |
| `policy` | repeated permission denials | `needs-human` |
| `stuck` | no progress past the attempt's wall-clock limit | interrupt, then one retry, then `needs-human` |
| `budget` | a cap would be exceeded | stop; `needs-human` with the numbers |

"Raise tier" from `expert` to `frontier` happens only when the mission allows `frontier`
(off by default, §6.3); otherwise that step is skipped with the reason recorded ("would raise to
frontier; not allowed for this mission"), and the task moves to the next axis or `needs-human`.
"Raise effort" continues the session where the harness supports changing effort mid-session
(§6.4). "Raise tier" and "switch harness" start a fresh session in a fresh worktree from the same
base, on a new `-a<n>` branch (§13.2); the failed attempt's branch is kept for comparison.

### 15.3 Limits that prevent runaway loops

| Limit | Default | Notes |
|---|---|---|
| Attempts per task (quality) | 3 | infra retries counted separately (max 2) |
| Tier steps per task | 1 | in `auto`; 0 in `manual` unless the user allows it |
| Effort steps per task | 1 | |
| Same signature | 2 in a row → next ladder axis; 3 → `needs-human` | the signature normalises paths, line numbers, timestamps, and test ordering |
| Attempt wall clock | 45 min (per kind in repo policy) | active time, excluding time waiting on the human |
| Task estimated cost | mission policy | API-equivalent estimate; `budget` category when hit |
| Mission estimated cost / usage-window share | mission policy | admission control stops new work |
| Concurrent attempts, tasks per mission | §12.3, §11.2 | hard caps |

Every decision, including a blocked one ("would raise tier to expert; mission capped at
standard"), is an `EscalationDecision` and a telemetry event (§16). The task detail shows the
ladder as it was walked.

---

## 16. Telemetry

### 16.1 Rules

- **Local only.** Nothing leaves the machine, as today. No analytics SDK.
- **Metadata, not content.** Records hold ids, enums, counts, durations, token numbers and hashes.
  Never prompt text, objectives, file contents or transcript excerpts. The mission store holds
  the user's objective; telemetry refers to it by id. Test fixtures are synthetic (public repo).
- **Say what is not known.** A field the source did not report is absent, never zero. Costs carry
  their basis.
- **Two layers.** Phase 1 records *every AW-hosted session's turns*, orchestrated or not, because
  that is useful immediately (per-session attribution is a known gap, `product-context.md` §7)
  and is the baseline dataset for shadow mode. Phase 3 onward adds attempt, routing, verification
  and escalation records.

### 16.2 Records

Append-only JSONL, monthly files under `orchestration/telemetry/`. Each line has `v`, `type`,
`at`, `id`.

**`turn`**: one per completed turn of an AW-hosted session.
`sessionId`, `harness`, `source`, `modelsUsed {model: {in, out, cacheRead, cacheWrite, thinking,
costUsd?}}`, `effort {requested?, applied?}`, `permissionMode`, `durationMs`, `apiMs?`, `ttftMs?`,
`numTurns` (model round trips), `toolCalls {byTool}`, `permissionAsks`, `waitedOnHumanMs`,
`terminalReason?`, `isError`, `apiErrorStatus?`, `contextTokensPeak?`, `attemptId?`.

**`attempt`**: written when an attempt ends (and a partial record on `interrupted`).
`missionId`, `taskId`, `attemptId`, `n`, `mode`, `routingConfidence`, `assessment` (dimension
values + confidences + assessor version), `requirement {tier, effort}`, `target {harness, source,
model, resolvedModel, tier, effortRequested, effortNative, effortApplied?, location}`,
`shadow? {tier, effort, target}`, `agreement? (assisted: accepted | changed-tier | changed-effort |
changed-model)`, `queuedAt`, `startedAt`, `endedAt`, `activeMs`, `queueMs`, `waitedOnHumanMs`,
`usage` (sum of its turns, per model), `cost {usd?, basis: 'harness-estimate' | 'price-table' |
'none'}`, `turns`, `toolCalls`, `permissionAsks`, `outcome`, `category`, `signature?`,
`escalationStep`, `git {filesChanged, insertions, deletions, commits}`, `scopeAccuracy`
(fraction of changed files inside predicted scope), `verification [{strategy, outcome, flaky,
preExisting, durationMs}]`, `flags {userIntervened, tookOver, userEditedBranch}`.

**`routing`**, **`escalation`**, **`verification`**, **`integration`** (merged, conflict,
mission-verification outcome), **`override`** (who changed what, from what, at which scope),
**`policy-change`**, **`task-final`** (the task's end: `done | failed | cancelled`,
`acceptedBy: verification | user`, `attempts`, total cost, first-attempt pass) and
**`task-later`** (a user rejects or reverts a result after it was `done`).

The mission's own `events.jsonl` holds the same routing, escalation and state-change events for
that mission, for its history view. Telemetry files are the cross-mission copy. Both are
idempotent by event id.

### 16.3 How the numbers are computed

- **Claude tokens and cost** come from the `result` message: `modelUsage` is per model, includes
  subagents, compaction and other pipeline calls, and is **cumulative per `query()` call**.
  `total_cost_usd` is cumulative too; `usage` covers the main loop only. So per-turn values are
  **differences of consecutive cumulative totals within one query lifetime**. A new segment starts
  on resume (totals restart), on `/clear` (they reset), and on host migration (#4 §7.4). An
  attempt's usage is the sum over its segments. A crashed session's final `result` may carry
  zeroed totals: a total lower than the previous one without a known reset is treated as "no
  data" for that turn, never subtracted. This is the part of Phase 1 most worth unit testing.
- **Claude applied effort**: from tool-context hook payloads (`effort.level`), which AW's hooks
  already receive, and from `system/init` where the host publishes it.
- **Codex tokens**: from `thread/tokenUsage/updated`, which is cumulative per thread, so the
  same differencing applies, including on resumed threads. No cost is reported, so cost is either
  computed from a user-editable price table (`basis: price-table`) or absent.
- **Active time**: turn durations minus time with a pending ask. **Queue time**: from `queued` to
  `launching`. **Waiting on the human**: the sum of pending-ask intervals.
- **Git numbers**: `git diff --numstat base..head` in the task worktree. Deterministic.
- **User intervention**: a send, take-over or answer from the user into the attempt's session
  (known from `SessionActions` call sites); `userEditedBranch`: commits on the task branch outside
  any attempt's lifetime.
- **Reverted later**: a revert commit of the integration merge on the base branch, checked when
  the mission view is opened. Best-effort, and labelled so.

### 16.4 Provider gaps

| Field | Claude Code | Codex | Local (future) |
|---|---|---|---|
| Tokens in/out | ✔ per model (`modelUsage`) | ✔ (token usage notifications) | server-reported, if any |
| Cache read/write | ✔ | cached input only (§3) | usually none |
| Thinking tokens | ✔ where the CLI records them | reasoning tokens (§3) | varies |
| Cost | estimate (`costUSD`, `total_cost_usd`; "not a billing statement"); on the subscription it is API-equivalent | none; price table | none (`$0 API cost`) |
| Applied effort | hook payload; `init` on some hosts | echo of the requested config | n/a or `reasoning_effort` echo |
| Time to first token | `ttft_ms` on `result` | not reported (compute from notifications) | server timings |
| Tool calls | from our reducer | from our reducer | from the harness |
| Rate limits | `/api/oauth/usage` windows | `account/rateLimits/read` | slots / queue |
| Subagent usage | included in `modelUsage` | separate threads | n/a |

Metrics that depend on a missing field are shown as "not reported by <harness>", never as zero.

---

## 17. Metrics

| Question | Metric | Needs | When |
|---|---|---|---|
| **Quality** | | | |
| First-attempt success | tasks `done` via verification on attempt 1 / tasks finished | attempts, task-final | Phase 4 |
| Eventual success | tasks `done` / tasks finished | task-final | Phase 4 |
| Verification rejection | failed required verifications / verified attempts | verification | Phase 4 |
| User rejection / rework | `task-later` rejections + tasks the user edited after `done` / tasks `done` | task-later, flags | Phase 8 |
| **Routing quality** | | | |
| Escalation rate | tasks with ≥1 tier or effort step / tasks | escalation | Phase 6 |
| Under-routing (by kind, complexity) | tasks that needed a tier/effort step or a human rescue to pass | escalation, task-final | Phase 10 |
| Over-routing (candidates) | `expert` tasks with complexity ≤ routine that passed first time with small diffs, and shadow disagreements where the router wanted cheaper | attempt, shadow | Phase 10; labelled as a *heuristic* because the counterfactual is never observed |
| Assessment accuracy | agreement of assessments with user edits in plan review and with corpus labels; `scopeAccuracy` | assessment, overrides, corpus | Phase 5 |
| Assisted agreement | accepted / proposed, by dimension changed | attempt `agreement` | Phase 5 |
| **Cost** | | | |
| Cost per successful task | Σ estimated cost / tasks `done`, by basis | attempt | Phase 3 |
| Cost per mission; escalation cost | Σ, and Σ of attempts after the first | attempt | Phase 6 |
| Tokens per successful task | Σ tokens / done | turn, attempt | Phase 3 |
| Usage-window share | Δ of the 5-hour window during the mission (approximate: other sessions share it) | usage snapshots | Phase 9 |
| Saved by cheaper or local routes | estimated cost of the shadow `expert`/hosted alternative minus actual | shadow, price table | Phase 10, labelled estimate |
| **Speed** | | | |
| Mission wall clock; active agent time; queue time | | attempt | Phase 9 |
| Parallelism benefit | Σ attempt active time / mission wall clock | attempt | Phase 9 |
| **Reliability** | | | |
| Retry rate; crashes; provider failures; worktree failures; merge conflicts; stuck tasks | counts per category | attempt, integration | Phase 6–9 |
| **User interaction** | | | |
| Manual overrides; routing overrides; permission interruptions; human rescue rate | | override, turn, task-final | Phase 5–9 |

**MVP set** (Phases 1–4): per-session and per-task tokens and estimated cost, model and effort
distribution, first-attempt and eventual success, verification rejection, active /
queue / waiting-on-human time. Everything else is Phase 5 and later.

---

## 18. User-facing observability

All of this must work in a 300 px pane (`#app.narrow`): chips fold to the row's second line, and
nothing is hidden without a way to reach it (`product-context.md` §5, principle 6).

### 18.1 In the session table (every orchestrated session)

- A **task chip** (`M3 · t2`) and a **route chip** (`Sonnet · high`, or `local:qwen · low`), with
  `auto` / `assisted` / `manual` shown as a small marker. The `expert` tier and `max` effort render
  emphasised, so expensive work is visible without opening anything.
- Clicking the route chip shows the explanation (§9.5).

### 18.2 Missions view (a third view of the table pane)

The table already switches between status sections and user sections; Missions is a third view.

- **Mission header row**: title, state, `done / running / blocked / failed` counts, active
  agents, elapsed time, estimated cost (with basis), usage-window share, escalations, a
  verification-health dot, and a compact model distribution (`Sonnet 4 · Opus 1 · local 2`). A
  "local vs hosted" split appears once local models exist.
- **Task rows** under it: status dot, title, route chip, attempt `2/3`, verification badge
  (`✓`, `✗`, `~ flaky`, `? unverified`), duration, tokens, cost, worktree/branch on the second
  line. Dependencies as a short "after t1, t2" line; a graph drawing is offered only when the pane
  is wide.
- Clicking a task opens its **current attempt's conversation** in the right pane: the existing
  conversation view, with a task strip above it. It never switches windows.

### 18.3 Task detail (the task strip, expandable)

- **Route**: requirement, target, mode, confidence, reasons (§9.5), overrides applied, shadow vs
  actual, rejected candidates.
- **Attempts**: one line each (route, duration, tokens, cost, outcome, category), each opening
  that attempt's session.
- **Escalations**: from → to, evidence, rule, and blocked steps with the cap that blocked them.
- **Verification**: stages with outcome, duration, flaky and pre-existing markers, the log tail,
  "open log".
- **Worktree**: path, branch, base, diff stat, "open diff" (the existing diff editor).
- Actions: accept unverified, retry, retry with a different route (pre-filled), skip, cancel,
  edit and re-run.

### 18.4 Mission creation and review

- **New mission** beside **New** in the launcher: objective, repository, base branch, mode,
  caps (max tier, max concurrency, budget), then **Plan**. The planner's conversation streams in
  the right pane. The plan review appears in the left pane: an editable task list with preview
  requirements, and **Approve and start**.
- **Mission review**: the mission branch diff stat, per-task results, verification health, and the
  finish buttons (merge locally, open a PR, keep, discard).

### 18.5 Attention

- "Task needs you", "plan ready", "conflict", "budget reached" and "mission done" use the Waiting
  section semantics and #18's OS notifications. They never take focus.
- Discord: no new surface in the first phases. The existing permission cards already cover
  orchestrated sessions. "Mission needs attention / done" notices are a later option.

### 18.6 Preferences → Orchestration

On/off (off by default), default mode, default caps, the **tier map** (every catalog model with
its tier, enabled flag and price basis; unassigned models listed first), verification defaults,
and, later, local endpoints.

---

## 19. Local models: supported by design, not implemented

There is no local inference on this machine, and nothing in this plan installs or configures
any. What the plan does is make sure a local model can join later as configuration plus an
adapter, with no change to tasks, assessments, rules or stores.

### 19.1 Two ways a local model does work

1. **Inside an agentic harness** (for coding tasks). A local model has no tool loop, sandbox or
   permission system of its own, and AW will not build one (that would be a second agent, a large
   security surface, and against "not an IDE"). The realistic paths:
   - **Codex** with a model provider pointing at a local OpenAI-compatible server
     (`model_providers`, `--oss`, built-in `ollama` and `lmstudio` providers). AW already drives
     Codex through `app-server`, so a local model becomes a Codex thread with a different
     provider configuration. Open question for #50: which wire protocol Codex requires of the
     server (one source says the Responses API only).
   - **Claude Code** against an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`). Some local
     servers offer one (e.g. mlx-omni-server). Whether tool use holds up is the open question.
2. **Directly, for structured completions** (assessment, plan repair, review verdicts): an
   OpenAI-compatible `chat/completions` call with JSON-schema or grammar-constrained output,
   behind `StructuredCompletion`. No tools, no files, no agent loop.

### 19.2 What a local source advertises

A local source is a `ModelSource` with `location: 'local'`, and its models are ordinary
`ModelDescriptor`s. Probing fills what each runtime can say; the user declares the rest; unknown
stays unknown:

| Field | Ollama | llama.cpp server | vLLM | LM Studio | MLX servers |
|---|---|---|---|---|---|
| model id | `/api/tags` | `/v1/models` | `/v1/models` | `/api/v0/models` | `/v1/models` |
| context size | `/api/show` `model_info[<arch>.context_length]` | `/props` | launch flag (probe unverified) | `max_context_length` | declared |
| tool calling | `capabilities` includes `tools` | template caps (indirect) | per model | declared | declared |
| structured output | JSON schema format | JSON schema / grammar | guided JSON | JSON schema | declared |
| vision | `capabilities` includes `vision` | `modalities` | per model | `type: vlm` | declared |
| reasoning control | `think` | `--reasoning` | `reasoning_effort` | `reasoning.effort` | declared |
| max concurrency | declared (`OLLAMA_NUM_PARALLEL` not queryable) | `total_slots` | declared | declared | declared |
| health | listing responds | `/health` | listing responds | `state` | listing responds |
| throughput | `eval_count` / `eval_duration` | `timings.predicted_per_second` | response usage | — | — |

"Declared" means the user states it in Preferences, and the descriptor records `from: declared`.
The resolver trusts `reported`/`probed` over `declared`, and treats `unknown` as "cannot satisfy
a hard need". A local model with unknown tool calling is never given an agentic coding task.

Other fields: **hardware location** (`localhost`; a LAN host is treated as external, §24),
**estimated cost** (`basis: none`), **availability** (health + free slots), and optional
**hardware** (device, memory) for display only. The initial abstraction requires no hardware
metrics.

### 19.3 How a local model earns a place in routing

1. The user adds an endpoint (off by default). AW probes it; its models appear in the tier map
   as **unassigned** (§6.3).
2. Optionally, the model runs a small **qualification set** of verifiable tasks on scratch
   repositories (a subset of the corpus with real checks), and the result is shown next to the
   tier choice.
3. The user assigns a tier. From then on the resolver can pick it like any other candidate,
   under the same caps, and "prefer local" or "disable local" steer it.

### 19.4 Local observability

Recorded per attempt and aggregated in the analytics view (#49): executions; tokens in and out;
tokens per second and time to first token (from server timings, when reported); total runtime;
context size used; machine/device; queue delay (waiting for a slot); success rate;
**escalation-from-local rate**; RAM/VRAM only if the server reports it. Cost is shown as `$0 API
cost`, and optionally "API-equivalent avoided" as a labelled estimate: the estimated cost of the
hosted route the router would otherwise have picked. That gives the dashboard in the brief:

```text
Hosted
  Claude Sonnet    18 tasks   $6.42 est.
  Claude Opus       3 tasks   $4.83 est.
Local
  qwen-coder       27 tasks   $0 API cost · 93% verified first time · 14% escalated · 41 tok/s
```

### 19.5 Where local-model work sits

Phase 2 (#29) gets the abstraction right: the harness vs source split, `Known<>` provenance,
unassigned-until-tiered, and `location` as an axis. Everything else waits for the gate in #50:
a local server exists and James wants it used. #51 then builds endpoint registry, probing,
health, completions and routing on top.

---

## 20. Historical and adaptive routing (design only; not built)

### 20.1 Shape: learned proposes, deterministic disposes

Adaptive routing does **not** replace the router with a model. It reads telemetry and proposes
**policy changes** that a human accepts: "for `kind = test`, `complexity ≤ routine`, strong
verification in this repository, `basic` passed first time 23 of 25 times; lower the tier
floor?". An accepted proposal becomes a rule with its evidence attached. Routing stays a pure,
explainable function. This keeps every principle intact and makes a bad proposal cheap to undo.

A later, optional step allows *bounded automatic* adjustment inside a cohort (at most one tier step,
never for `risk ≥ high`, never past a cap), still recorded as a rule firing with its statistics.

### 20.2 Cohorts

`kind × complexity bucket (trivial–routine | involved–hard) × verifiability bucket (none–weak |
partial–strong) × repository (optional) × domain (optional)`, crossed with `tier × effort`
(and model, for per-model questions). Repository and domain are refinements: estimates are pooled
upward (repository → all repositories, domain → no domain) until a cohort has enough data.

### 20.3 Success, and how much data is enough

- A success is: verified on the first attempt, no human rescue, and not rejected or reverted
  within 14 days.
- Each cohort × route keeps a Beta-binomial posterior, starting from a weak prior centred on what
  the deterministic policy expects (a prior worth ~4 observations), so tiny samples cannot swing
  it.
- **Downgrade proposals** need the posterior lower bound (90%) of the cheaper route's success at or
  above the target (default 0.80) **and** at least 20 observations of the cheaper route in that
  cohort, **and** `risk ≤ moderate`, **and** `verifiability ≥ partial`.
- **Upgrade proposals** need the current route's upper bound under 0.60 with at least 10
  observations.
- Sparse data (below the thresholds) → no proposal, and the deterministic rule applies. That is the
  fallback, not an exception.
- Proposals are re-checked against the evaluation corpus (§27): a proposal that makes a corpus
  case egregious is refused.

### 20.4 What the volume means in practice

Roughly 20 cohorts that matter × 2–3 routes × 20 observations ≈ 1,000 attempts before most
cohorts can produce a proposal. At the tens of orchestrated tasks a week this machine is likely
to run, that is months. That is why this is Future work (#52) and why shadow mode (which starts
accumulating data in Phase 5 without spending anything extra) matters. There is **no random
exploration** on real work. Where cheaper evidence is wanted, a later option is to *shadow-run* a
cheaper route on a copy of a low-risk task, deliberately and within a budget.

### 20.5 Overfitting guards

Pooling upward; priors; minimum counts; one-step changes; the corpus veto; proposals expire if the
cohort's recent success drops; and every accepted proposal records the data window it was based on
so it can be re-evaluated.

---

## 21. Budget-aware routing (design; mostly deferred)

**Where it lives:** the router says what the work *needs* and is budget-blind. Budget acts in two
places only: the **resolver** (ranking among candidates that already satisfy the requirement) and
**scheduler admission** (whether to start now). This keeps "cheaper" from ever meaning "under the
required tier", unless the user deliberately caps the tier.

| Strategy | Resolver ranking | Admission |
|---|---|---|
| Balanced (default) | the required tier, cheapest estimated route | standard thresholds |
| Maximum quality | the highest tier within the cap, ties to higher effort | standard |
| Lowest cost | the required tier's cheapest route, local first when enabled; accepts slower | stricter usage-window thresholds |
| Fastest completion | the highest throughput and most parallelism within caps | looser concurrency within caps |
| Prefer local | local candidates first when they satisfy the requirement | local capacity first |

Mission constraints (maximum estimated hosted spend, maximum concurrent agents, maximum tier,
local-only, hosted-only, preferred sources) are the caps and exclusions of §10.2.

**On this machine, the budget is the usage window.** Claude runs on the subscription, so dollar
figures are API-equivalent estimates and the binding limit is the 5-hour and 7-day window (the
existing Budget cards). Codex has its own plan windows. Budget policy is therefore written in both
units: "keep this mission under 15% of the 5-hour window" and, for API-key users, "under $N". The
MVP ships caps and admission thresholds (Phase 9); the strategies above are Future work (#53).

---

## 22. Session specialization and hierarchical orchestration (design; deferred)

### 22.1 Specialization

The separation that makes this possible later is already in the model: `RoutingDecision` says what
the work needs; `AgentAssignment` says which session does it. Today's assignment modes are `fresh`
and `continue` (the retry-with-feedback of §15 is already session reuse). Later modes:

- `reuse(sessionId)`: an idle AW session with warm context in the **same worktree lineage**. A
  session's cwd is fixed, so reuse applies to sequential tasks on one branch, not to parallel
  tasks in different trees.
- `fork(sessionId)`: a new session forked from an upstream task's conversation into a new
  worktree, so B starts with A's context. Whether a fork can change working directory is unknown
  (transcripts are stored per project directory); it is a question to settle at the start of #54.

The scheduler would rank "a warm session that satisfies the requirement" above "a new session".
Nothing is recorded about agents as reputations. History is per cohort and route (§20), not per
session.

### 22.2 Hierarchy

The harnesses already do hierarchy inside a session: Claude Code subagents and workflows, and Codex
subagents. AW treats that as opaque inside an attempt, and `modelUsage` attributes its cost. AW's
own hierarchy is planner → tasks. A lead agent that supervises workers and replans continuously is
deferred behind a gate: only if telemetry shows that missions fail because plans cannot adapt, and
that replanning by the user (§11.4) is the bottleneck.

---

## 23. Persistence and crash recovery

### 23.1 Stores

- **MissionStore**: one JSON file per mission (`orchestration/missions/<id>.json`) via `JsonStore`
  (atomic tmp + rename), plus a small index. This follows #4's persistence decision. Records are
  few (missions × tasks × attempts), there is one writer, and access is "load, replace one".
- **Event and telemetry logs**: append-only JSONL, idempotent by event id. They are *history*, not
  the source of truth. The snapshot is the truth. That is simpler than event sourcing, and enough
  with one writer.
- **SQLite: not yet.** #4 recorded the trigger for revisiting it: persisting event history, several
  writers, or fleet-level queries. Routing analytics (Phase 10) is the first real fleet-level
  query. The Phase 10 issue includes the decision: keep scanning JSONL (probably fine for years at
  this volume) or adopt `node:sqlite` if it is stable in Electron's Node by then.

### 23.2 Write-ahead discipline

Every side effect that is hard to undo is preceded by a persisted intent:

| Step | Persisted first | Why |
|---|---|---|
| Start an attempt | attempt `launching` with a pre-assigned session id (Claude: the SDK `sessionId` option, which #4 already passes) or a launch nonce (Codex: the thread id is known only after `thread/start`, so it is matched by the registry `origin` tag, §1.3 A3) | a crash between "decided" and "started" leaves a findable record, never an unowned session |
| Create a worktree | `WorktreeAssignment creating` with path and branch | a half-created worktree is found and finished or cleaned |
| Merge into the mission branch | `integrating` with the pre-merge head | a crash mid-merge is detected (`MERGE_HEAD`) and redone from a known state |
| Run a verifier | stage `running` | re-run on recovery; verification is repeatable |

### 23.3 Recovery on core start

Runs **after** #4's startup reconciliation (manifests → registry states), never before, so it
sees true session states.

1. Load missions that are not in a terminal state.
2. For each attempt in `launching | running | finishing`, look up its session in `SessionRegistry`
   (by id, or by `origin.attemptId`):
   - `live` → keep it `running`; subscribe to the handle again. **This is the common case after
     `app:install` once #4 is done.**
   - `ended` cleanly after its last turn → continue to `finishing` (collect the diff, verify).
   - `interrupted | lost | failed` → attempt `interrupted`; the task goes to `needs-human` with
     **Resume attempt** (resume the same session id, #4's Resume) and **Retry fresh**. No automatic
     resume, as #4 decided for hosts, because crash loops are worse than a click. A mission
     setting `autoRecover` (off by default) allows one automatic resume per attempt.
   - no session found for a `launching` attempt → `interrupted`; nothing ran.
3. Verification stages that were `running` → re-run (their processes were children of the old
   core).
4. Merges in progress → abort (`git merge --abort`) and redo from the recorded pre-merge head.
5. Worktrees: check each assignment's path and branch still exist (`git worktree list
   --porcelain`). Missing → `missing`; the task goes to `needs-human` with "recreate from branch"
   if the branch survives.
6. Rebuild the reconstructible state (§7.3), then let the scheduler take one step.

### 23.4 Versioning

Mission files carry `v` and are migrated on load by pure functions with fixture tests. Routing
decisions record `policyVersion`, `assessorVersion` and `catalogVersion`, so old decisions stay
explainable after the rules change.

---

## 24. Security and trust boundaries

The threat model is #4's (§12 there): single user; keep other users out; make accidental,
over-eager or prompt-injected actions hard; a malicious same-user process cannot be stopped. What
orchestration adds:

| Risk | New with orchestration | Safeguard |
|---|---|---|
| **Arbitrary agent spawning** | AW starts agents without a click per agent | hard caps (concurrent attempts, tasks per mission, attempts per task, missions running); missions are created only by the user in the UI, or through the CLI (#21) with a confirmation in the UI; **agents cannot create missions** |
| **Model-generated tasks** | the planner's output drives what runs | output is data, schema-validated and size-limited; it cannot set permission modes, tools, binaries, environment, commands or paths outside the repo; verification is named, never supplied; plan review is mandatory |
| **Shell access / verification commands** | the core runs commands in worktrees | commands come only from repo policy the user wrote; run with an explicit environment and timeouts; output to logs |
| **Permissions** | more agents means more prompts | the unattended-attempt posture in §24.1: `auto` mode for Claude, a worktree sandbox for Codex, one mission-scoped approval queue, and hard denies enforced in every mode; never `bypassPermissions` (`allowDangerouslySkipPermissions` stays unset); hosted sessions are approvable only through AW (#15) |
| **Automatic escalation** | could raise cost or capability without asking | bounded (§15.3), capped, pins respected, every step recorded; escalation never changes permission mode or tools |
| **Repository permissions** | AW writes branches and merges | only in worktrees it created; only into the mission branch; never pushes or merges into the base without a click; never removes a dirty, unmerged or in-use tree |
| **Provider credentials** | none new for Claude or Codex | they keep their own logins; AW never reads them |
| **Local inference servers** (future) | a new endpoint AW talks to | loopback is `local`; any other host is treated as **hosted/external**, off by default and labelled "data leaves this machine" (local-first principle); optional API keys in `safeStorage`, never in agent environments unless the harness requires it, and then only for that session |
| **GitHub** | issue import (later), PR creation (on click) | opening a PR uses the user's `gh`, on click. **Issue text is untrusted input**: this repo is public, so anyone can file an issue. An imported mission shows its author, is marked untrusted, can never skip plan review, and is never started automatically from a non-owner's issue |
| **External services** | none in the MVP | orchestration adds no outbound traffic of its own |
| **Telemetry privacy** | a new local dataset | metadata only, local only; an export redacts paths |

**Before high autonomy** (auto routing + auto retry + auto integration, unattended, e.g.
triggered by a schedule): #18's notifications working, budget caps set, verification configured for
the repository, a kill switch ("stop all missions" beside ⌥⌘Q's "stop all agents"), and at least
one month of shadow and assisted data (§27).

### 24.1 Permission posture for orchestrated attempts (decided 2026-09-24)

Attempts do **not** inherit the launching session's permission mode. That mode fits a session the
user is watching; an attempt runs unattended in a throwaway worktree, and with several running at
once, per-command prompts become constant. The parent's mode is instead a **ceiling**: an attempt
is never more permissive than the app's default mode.

- **Claude Code attempts: `auto` mode.** Not `acceptEdits`: it still prompts for every shell
  command, including the repository's own checks and `git`, which is the prompt volume this is
  meant to remove. AW adds allow rules for the verification commands named in the repo policy
  (§13.6) and for `git` subcommands that stay inside the worktree.
- **Codex attempts: `workspace-write` sandbox** (writes confined to the worktree, no network),
  approval policy `on-request`, so only a step outside the sandbox asks. Exact parameter names
  are verified at the #25 gate against the app-server protocol as #4 ships it.
- **One approval queue per mission.** Whatever still needs a human appears once in AW, grouped
  by mission, with "allow for this mission": the answer applies to the same request from every
  attempt in that mission and expires with it. N attempts asking the same thing is one prompt.
- **Hard denies, enforced by AW in every mode** (a pre-tool-use check on Claude sessions, the
  sandbox plus approval handling on Codex): `git push`; writes outside the attempt's worktree;
  any change to the primary checkout; `npm run app:install` except through the exclusive lease
  (§13.5). A denial is a `policy` outcome (§15.2), not a prompt.
- **Never `bypassPermissions`**, and escalation never changes permission mode (above).

---

## 25. Failure modes

P = prevent, D = detect, R = recover, H = surface to the human.

| # | Failure | P | D | R | H |
|---|---|---|---|---|---|
| 1 | Planner creates circular dependencies | schema + DAG check | validator | one repair round | `planning-failed` with the cycle |
| 2 | Planner decomposes too aggressively | single-task default, split rules, task cap | overlap and size checks; plan review | merge suggestions | plan review |
| 3 | Planner does not decompose enough | — | context overflow, timeouts, `split-task` escalation | replan proposal | review of the proposal |
| 4 | Router picks an unavailable model | resolver filters on health and capacity | — | next candidate, or wait | `blocked` with the reason |
| 5 | Provider disconnects mid-attempt | — | session error / host events | `infra` retry, same route | after 2 |
| 6 | Local inference server disappears | health checks | failed request / health | fail over within tier if allowed | after failover fails |
| 7 | Context window insufficient | `contextLoad` hard constraint | `prompt_too_long` | larger window, same tier; else split | if neither |
| 8 | Provider does not support the requested effort | effort map per model | resolver | nearest supported level, recorded | shown in the route |
| 9 | Provider lacks tool calls | agentic harness required for edit tasks | catalog | excluded | — |
| 10 | Rate limit | admission thresholds | 429 / rate-limit signals | wait, backoff; failover if allowed | if prolonged |
| 11 | Agent process crash | — | #4 session `failed` / `lost` | `infra` retry | after 2 |
| 12 | Agent Wrangler restart | #4 hosts | recovery pass | reattach live attempts | interrupted ones |
| 13 | Partial task completion | acceptance criteria | verification / review | `quality` retry continuing the session | after limit |
| 14 | Verification process crashes | timeouts | exit status | re-run once | then `needs-human` |
| 15 | Flaky tests | — | re-run on unchanged tree | `passed, flaky` | flagged, trended |
| 16 | Claims success, no meaningful diff | — | `diff-sanity` | one retry | then `needs-human` |
| 17 | Duplicate agent work | overlap check in plan and scheduler | — | — | plan review |
| 18 | Two tasks edit the same file | scope overlap serialisation | merge conflict | conflict-resolution attempt | if unresolved |
| 19 | Dependency changes during execution | edits only when paused/not started | `stale-base` | merge check before integration | if it fails |
| 20 | Downstream started from an invalid upstream | start only from integrated, verified upstream | upstream rejected/reverted | `invalidated` → rerun on confirm | confirmation |
| 21 | Escalation repeats the same failure | signatures | repeat count | next ladder axis | at 3 |
| 22 | Cost limit exceeded | admission control | running totals | stop starting work | `budget` |
| 23 | User changes routing policy mid-mission | frozen snapshot | policy-change event | applies to new attempts | shown in header |
| 24 | User cancels the mission | — | — | graceful end of attempts, keep trees | cleanup view |
| 25 | User edits a task branch by hand | — | commits outside attempts | re-verify before integration | flagged |
| 26 | Merge conflict | overlap serialisation | merge result | conflict-resolution attempt | if unresolved |
| 27 | Worktree deleted externally | — | recovery / pre-start check | recreate from branch | if branch gone |
| 28 | Local model far slower than predicted | throughput measured | attempt wall clock | `stuck` → retry elsewhere | if repeated |
| 29 | Local model emits invalid structured output | schema validation | parse failure | one retry; then a hosted completion if allowed | if both fail |
| 30 | Capability discovered missing at runtime | catalog provenance | harness error | mark `unknown → false`, re-resolve | once |
| 31 | Two AW cores (impossible today) | single-instance lock (#4) | — | — | — |
| 32 | Mission state file corrupt | atomic writes | parse failure on load | keep a `.bak` of the last good write | mission marked `failed: unreadable` |

---

## 26. Testing strategy

Levels extend #4 §16 (U, I, L, M) with S for simulation: **U** unit (pure, vitest), **I** process integration (real git, real
child processes, fakes for agents), **S** simulation (whole missions on a fake clock), **L** live
(opt-in, self-skipping, output never pasted), **M** manual (recorded once per phase in merge
notes).

### 26.1 Unit

- Assessment heuristics (path rules, scope statistics, the combine step).
- Router rules: a table of assessments → requirements + reason ids; includes every worked example
  in §9.3.
- Resolver: candidate filtering and ranking against fixture catalogs and capacity snapshots.
- Effort mapping per model; requested/native/applied bookkeeping.
- DAG validation (cycles, dangling edges, self edges, overlap detection).
- Scheduler step: tables of snapshot → actions (deps, concurrency, contention, leases, pause,
  budget).
- Outcome classifier and escalation policy: evidence → category → action, including every blocked
  path (pins, caps, limits).
- Failure signature normalisation.
- **Telemetry deltas**: cumulative `modelUsage` → per-turn values, across resume, `/clear` and
  host migration.
- Overrides precedence and cap validation.
- State machines: every illegal transition is rejected.
- Mission-file migrations.

### 26.2 Integration

- `WorktreeManager` / `Integrator` against real temporary repositories: create, set up, commit,
  merge, conflict, abort, remove refusals (dirty, unmerged, in use), externally deleted worktree.
- The verification runner with real scripts: pass, fail, timeout, flaky (fails then passes),
  pre-existing failure on the base.
- MissionStore crash safety: injected write failures; `.bak` recovery.
- Recovery: a store fixture + a registry fixture (`live`, `interrupted`, missing) → the expected
  attempt states.
- Harness adapters against #4's fakes (`fakeQuery`, `FakeServer`) through `SessionExecutor`.

### 26.3 Simulation: the simulated harness

**Essential, and part of #30 in Phase 2.** A `SimulatedHarness` implements
`AgentHarness`, launches through the same `SessionExecutor` seam with a scripted fake session (#4
already plans `AW_SESSION_HOST_FAKE=1` for hosts), and writes real files into the task's real
worktree. Scenarios are data:

```jsonc
{ "task": "t2", "attempts": [
  { "behaviour": "edit", "files": {"src/a.ts": "…"}, "turns": 3, "usage": {"in": 12000, "out": 900} },
  { "behaviour": "fail-verification", "signature": "test:parser off-by-one" },
  { "behaviour": "rate-limit", "status": 429, "retryAfterSec": 30 }
]}
```

Behaviours: success with a diff; failure; timeout (no result); rate limit; bad structured output;
slow output (tokens per second); context overflow (`prompt_too_long`); tool failure; verification
failure (writes code that fails the repo's test script); no-diff "success"; crash mid-attempt;
asks a question; permission prompt. A `SimulatedCompletion` does the same for assessment and
planning.

Simulation runs whole missions on a fake clock and asserts final states, attempt counts, the
escalation path taken, the telemetry records written, and **invariants on every step**: no task
starts before its dependencies are integrated; attempts never exceed caps; two overlapping tasks
never run at once; every escalation has an event; no escalation passes a cap. A seeded random
generator (random DAGs × random failure injection) runs the same invariants over hundreds of
missions in one test file, without a new dependency.

This is what answers "can we test orchestration without spending API credits" (yes) and "can we
simulate provider failures" (yes, all of them in the brief's list).

### 26.4 End to end

- **L**: `AW_LIVE_ORCH=1` runs a three-task mission on a scratch repository created in a temp
  directory, cheapest route (`basic`/`low`), real harnesses, real verification. Self-skips
  without credentials; output never pasted anywhere.
- **M**, per phase: a docs-only task; a single-file bug with a failing test; a three-task feature
  with one dependency and one parallel pair; a mission that hits a conflict; a mission killed by
  `app:install` mid-attempt (the #4 gating scenario, one level up).

---

## 27. Routing evaluation and shadow mode

### 27.1 The corpus

`test/fixtures/routing-corpus/*.json`: synthetic, public-safe task cards, each with an objective,
acceptance criteria, scope hints, repository facts (languages, verification configured, risk
paths) and **expectations**, not a single answer:

```jsonc
{ "id": "unity-shader-tweak",
  "card": { "objective": "…", "scope": ["Assets/Shaders/Water.shader"], "repo": {"unity": true, "verification": ["editmode"]} },
  "labels":  { "complexity": "involved", "risk": "moderate", "verifiability": "weak", "kind": "feature", "domains": ["unity", "shader"] },
  "expect":  { "tierIn": ["standard", "expert"], "effortIn": ["medium", "high"],
               "requires": ["exclusive:unity-editor"], "never": [{"tier": "basic"}] } }
```

Coverage starts with the brief's list: small typo, single-file bug, test generation, multi-file
feature, large refactor, architecture change, database migration, Unity UI, Unity shader,
documentation, git conflict resolution. It adds: dependency bump on a protocol path, flaky test fix,
performance investigation, security fix, CI configuration, a vague request ("make it better"),
a trivial-but-critical change, and a large-but-mechanical rename. About 30 cards at first.

### 27.2 Two evaluations

- **Deterministic, in `npm test`**: labelled assessments → router → requirement. Every card must
  satisfy `tierIn`/`effortIn`/`requires`, and **no egregious misroute** is allowed (`docs → expert +
  high`, `architecture → basic + low`, anything `critical` below `expert`). This guards every rule
  change forever.
- **Assessor evaluation, opt-in and live** (it spends tokens): the cards' text → the real assessor
  → dimension agreement with the labels (exact and within one level), plus the downstream
  requirement check. Results are summarised as numbers only; recorded assessor outputs can be
  replayed deterministically in tests.

Real tasks never enter the committed corpus (public repo). A local-only extension of the corpus
from James's own shadow data is possible and stays on the machine.

### 27.3 Shadow mode: where and how

- **Phase 5**, together with the router: in `manual` mode, every attempt records the router's
  requirement and resolved target next to what the user chose. In `assisted`, the proposal *is*
  the shadow, and the user's changes are labelled disagreements.
- **Comparison report** (Phase 7): for each attempt, predicted vs actual route vs outcome. For
  example: "router wanted cheaper, user went expensive, passed first time" (possible
  over-routing by the user); "router wanted more, user went cheaper, needed escalation" (the
  router was right); disagreement by dimension and kind.
- **Gate for automatic routing** (Phase 7). Starting criteria, revisable with evidence:
  - the corpus is green with zero egregious misroutes;
  - at least 30 shadow or assisted decisions;
  - assisted acceptance of at least 70% without a tier change;
  - no task kind where the router recommended a cheaper route than the one that ran, and the
    route that ran still needed escalation. That pattern is evidence the router under-routes
    that kind.

  Automatic routing is then opt-in per mission, starting with low-risk missions.

---

## 28. Roadmap

### 28.1 Sequence

```text
#4 complete ─► P0 Foundations ─► P1 Telemetry ─┐
                              └► P2 Capabilities ┴► P3 Tasks (manual, one worktree each)
                                                    ─► P4 Verification
                                                    ─► P5 Assessment + router in shadow + corpus
                                                    ─► P6 Pins/caps + retry & escalation
                                                    ─► P7 Automatic routing (gated)
                                                    ─► P8 Missions + planner
                                                    ─► P9 Scheduler, integration, contention
                                                    ─► P10 Routing analytics
Future (each behind its own gate): local models · adaptive routing · budget strategies ·
                                   session reuse · hierarchical orchestration
```

P1 and P2 can run in parallel after P0. Inside P3, the worktree manager and the repo policy can
run in parallel with each other and with P1/P2.

### 28.2 Deviations from the brief's order, and why

| Brief | Here | Why |
|---|---|---|
| 0 Domain, 1 Telemetry, 2 Capabilities | P0, P1, P2 | as proposed; P0 also includes the #4 gate |
| 3 Manual routing | **P3 Tasks**, with worktrees | a task needs a tree of its own from the first run; "manual routing" alone has nothing to route |
| 4 Assessment, 5 Deterministic routing | **P5** (router in shadow), **P7** (on) | the router runs in shadow first; switching it on waits for escalation and evidence |
| 9 Verification | **moved to P4** | "Verify before trust". Every later phase needs a pass/fail signal, and telemetry needs outcome labels before routing can be judged |
| 10 Retry/escalation | **moved to P6** | automatic routing without escalation is under-routing with no recovery |
| 6 Planner, 7 DAG | **P8, P9**, after single-task routing works | decomposition multiplies every routing and verification error; prove one task first |
| 8 Worktree-aware parallel | split: worktrees in **P3**, contention and parallelism in **P9** | isolation is needed from the start; parallelism is not |
| 11 Analytics | P10 | as proposed; shadow comparison ships earlier with P7 |
| 12 Local models | Future, **spike first**, gated on local inference existing | no local runtime exists here; P2's abstraction is what must be right now |
| 13 Adaptive, 14 Budget, 15 Specialization, 16 Hierarchy | Future | budget *caps and admission* move up into P9; strategies stay later |

### 28.3 Soon and later

- **Soon after #4** (P0–P4): per-session model, effort, tokens and cost; "run this as a task in its
  own worktree, verify it, show me the diff". Useful on its own even if orchestration stopped
  there.
- **Next** (P5–P7): assisted routing, bounded escalation, then automatic routing for missions that
  opt in.
- **Later** (P8–P10): multi-task missions, parallel execution, analytics.
- **Much later, gated** (Future): local models when a local server exists; adaptive suggestions
  when about 1,000 attempts exist; budget strategies; session reuse; hierarchy.

Every phase leaves the app shippable: orchestration is behind `orchestration.enabled` (off by
default) from P3 on. P1's telemetry is local, on by default and can be turned off. Each phase's
features are usable without the next phase.

---

## 29. Phases, with exit criteria

Issue numbers are in §30.

### P0: Foundations and the #4 gate

- **Objective**: confirm #4 as built still fits this plan; put the domain types, state machines and
  mission store in place; give launch options one typed path.
- **Architectural changes**: `src/shared/orchestration/` types; `src/orchestration/domain/` state
  machines; `MissionStore`; `LaunchDefaults` replacing ad hoc `runner.*` / `codexRunner.*` reads in
  `createApp`; `createOrchestration(deps)` skeleton wired but inert.
- **Implementation**: #25 gate (review against #4's final `SessionExecutor`, registry and host
  protocol; amend this document and the issues); #26 domain model and store.
- **Tests**: state machine transition tables; store round trip, atomicity and migration fixtures;
  `LaunchDefaults` equals the old behaviour.
- **Observability**: none user-visible.
- **Migration**: none. `LaunchDefaults` reads the same settings keys.
- **Deferred**: everything else.
- **Acceptance criteria**: this plan updated after the gate with any changes from #4 as built;
  typecheck and tests green; no behaviour change (manual smoke: start Claude and Codex
  conversations from the launcher with a chosen model and effort).
- **Non-goals**: UI; routing; git.
- **Prerequisite for next**: the gate's sign-off; the store exists.

### P1: Execution telemetry

- **Objective**: know exactly what every AW-hosted session does: models, effort, tokens, cost
  estimate, time, tool calls, permission waits.
- **Architectural changes**: a telemetry sink subscribed to `SessionHandle` turn completions
  (§1.3 A2); the delta computation (§16.3); Codex token usage parity; JSONL logs with rotation.
- **Implementation**: #27 recording; #28 display (a Usage column or second-line item in the
  table; a per-session summary in the conversation header; the session's cost basis always
  shown).
- **Tests**: delta computation across resume, `/clear` and host migration; Codex notification
  fixtures; JSONL writer; formatter at narrow widths.
- **Observability**: this *is* the observability.
- **Migration**: none; new files.
- **Deferred**: telemetry for external (terminal) sessions. Transcripts carry per-message usage, so
  it is possible later, but it is out of scope here.
- **Acceptance criteria**: after a day of normal use, every hosted session has turn records; for
  one Claude and one Codex session, totals match what the CLI reports (`/cost`-style or the final
  `result`) within rounding; nothing contains prompt or file content (checked by a test that
  scans records for fixture strings); the table shows per-session tokens and estimated cost at
  300 px.
- **Non-goals**: attempts, routing.
- **Prerequisite for next**: records exist that P3 can attach attempts to.

### P2: Capabilities and the harness seam

- **Objective**: describe models by capability; separate harness from model source; make every
  later phase testable without an agent.
- **Architectural changes**: `CapabilityCatalog` (grows from `ModelCatalogService`); tier map in
  settings; effort maps; `ModelSource` health and capacity (from `UsageService` and errors);
  `AgentHarness` adapters for Claude Code and Codex over `SessionExecutor`; `SimulatedHarness` and
  `SimulatedCompletion`; `StructuredCompletion` via a harness in no-tools mode;
  `AgentSession.provider` narrowed and the `anthropic/openai` vs `claude/codex` vocabularies named
  (`source` vs `harness`).
- **Implementation**: #29 catalog + tier map in Preferences; #30 harness seam + simulation.
- **Tests**: catalog merging with provenance; family-based tier defaults; unassigned models not
  routable; effort maps; a simulated attempt end to end through `SessionExecutor`; structured
  completion schema validation and retry.
- **Observability**: Preferences → Orchestration → tier map.
- **Migration**: the model catalog storage key is read and upgraded once.
- **Deferred**: local sources (Future).
- **Acceptance criteria**: every model the CLIs report appears with its capabilities and tier (or
  "unassigned"); a structured completion returns schema-valid JSON on the cheapest model; a
  simulated attempt runs through the same launch path as a real one, in tests, with no network.
- **Non-goals**: routing decisions.
- **Prerequisite for next**: a target can be expressed as harness × source × model × effort.

### P3: Tasks with manual routing, each in its own worktree

- **Objective**: "run this as a task": an objective, acceptance criteria and a route the user
  picks → a new worktree and branch → an attempt in a host → the result as a branch with a diff.
  Survives `app:install`.
- **Architectural changes**: `WorktreeManager`; per-repo policy (§13.6); `TaskRunner` with the
  write-ahead discipline and recovery (§23); `origin` tags on sessions; single-task missions;
  task and route chips; the task strip in the conversation pane.
- **Implementation**: #31 worktrees; #32 repo policy; #33 task runner + recovery; #34 UI.
- **Tests**: temp-repo integration for worktrees; recovery fixtures (live, interrupted, missing
  worktree); UI formatters; manual: a task survives `app:install` mid-attempt.
- **Observability**: attempt records; task rows; route chip (manual).
- **Migration**: none.
- **Deferred**: verification (P4), routing (P5).
- **Acceptance criteria**: a task started from the launcher creates `<repo>.aw/<slug>/t1` on its
  own branch with repo-policy setup applied, runs there, and ends with a diff the user can open;
  quitting or reinstalling the app mid-attempt leaves the attempt running and the task reattached
  on relaunch; a host killed while the app is quit yields an interrupted attempt with Resume and Retry; removing the task
  refuses a dirty or unmerged tree.
- **Non-goals**: parallel tasks, missions with several tasks, automatic anything.
- **Prerequisite for next**: attempts with results to verify.

### P4: Verification

- **Objective**: a task is `done` because checks passed (or the user accepted it), not because an
  agent stopped.
- **Architectural changes**: strategy interface; verification runner; `command`, `diff-sanity`,
  `acceptance`, `human`; flaky re-run; pre-existing check on the base; the advisory `review`
  strategy.
- **Implementation**: #35 framework + deterministic strategies; #36 review verifier.
- **Tests**: runner integration with scripted pass, fail, timeout, flaky and pre-existing
  failures; signature normalisation; review verdict schema.
- **Observability**: verification badges and stage detail; verification telemetry.
- **Migration**: none.
- **Deferred**: visual regression (a repo-command concern); Unity-specific strategies beyond
  `command`.
- **Acceptance criteria**: a task whose tests fail is shown failed with the failing test names and
  a log link; a task whose failure also fails on the base is shown as "base is red", not blamed;
  a flaky test is marked flaky; an empty diff fails `diff-sanity`; a repo with no verification
  gives `unverified` and needs an explicit accept.
- **Non-goals**: retries (P6).
- **Prerequisite for next**: outcome labels that telemetry and escalation can trust.

### P5: Assessment, router in shadow, evaluation corpus

- **Objective**: every task gets an assessment and a route recommendation with reasons; nothing
  automatic yet except in `assisted`, where the user confirms.
- **Architectural changes**: assessor (rules + one completion); router rules; resolver; routing
  decisions with shadow; `assisted` mode; the explanation UI; the corpus and its deterministic
  evaluation in `npm test`.
- **Implementation**: #37 assessment; #38 router + resolver + shadow/assisted + explanations;
  #39 corpus and harness.
- **Tests**: rule tables incl. §9.3's examples; resolver fixtures; the corpus in CI with zero
  egregious misroutes; recorded-assessor replay.
- **Observability**: the "why" panel; shadow fields in attempt telemetry; assisted agreement.
- **Migration**: none.
- **Deferred**: automatic routing (P7).
- **Acceptance criteria**: every task shows its assessment with confidences, a requirement and a
  target with reasons; in `manual`, the shadow recommendation is recorded on every attempt; in
  `assisted`, one click accepts the recommendation and a change is recorded as a disagreement; the
  corpus runs in `npm test`.
- **Non-goals**: escalation, missions.
- **Prerequisite for next**: routes the system can reason about and change.

### P6: Pins, caps, retry and escalation

- **Objective**: failures are handled by rule, within hard limits, and never past a user's cap.
- **Architectural changes**: policy scopes and precedence (§10.2); the outcome classifier; the
  escalation policy; retry-continuing-session and fresh-retry paths; limits (§15.3).
- **Implementation**: #40 pins and caps; #41 retry and escalation.
- **Tests**: escalation tables for every category, including blocked paths; limits; simulated
  runs where each failure type appears (via #30's simulated harness).
- **Observability**: escalation ladder in the task detail; escalation telemetry.
- **Migration**: none.
- **Deferred**: LLM diagnosis.
- **Acceptance criteria**: in simulation, no task exceeds its attempt, tier or effort limits under
  any injected failure sequence; a mission capped at `standard` never runs `expert`, and says so;
  a rate limit waits instead of escalating; a repeated identical failure moves along the ladder and
  stops at `needs-human`.
- **Non-goals**: automatic routing.
- **Prerequisite for next**: a safety net for under-routing.

### P7: Automatic routing, gated

- **Objective**: missions can opt into `auto` routing, once the evidence supports it.
- **Architectural changes**: `auto` mode; the shadow comparison report; the gate check (§27.3)
  shown in Preferences with its numbers.
- **Implementation**: #42.
- **Tests**: the gate's criteria as a pure function over telemetry fixtures; mode switching.
- **Observability**: the comparison report; `auto` markers on route chips.
- **Migration**: none.
- **Deferred**: adaptive changes to rules (Future).
- **Acceptance criteria**: `auto` cannot be enabled while the gate is unmet unless the user
  overrides with the numbers shown; with `auto` on, every decision still shows its reasons; the report lists disagreements by kind and dimension.
- **Non-goals**: learning.
- **Prerequisite for next**: trusted single-task routing.

### P8: Missions and planning

- **Objective**: a broad objective becomes a reviewed plan of a few verifiable tasks.
- **Architectural changes**: multi-task missions; the Missions view; plan review; the planner
  attempt with structured output; validation and repair; replanning as a diff.
- **Implementation**: #43 missions and plan review (user-authored plans first); #44 planner.
- **Tests**: plan validation tables (cycles, overlap, caps, unknown strategies); simulated planner
  outputs (valid, cyclic, over-decomposed, invalid JSON); the single-task default.
- **Observability**: mission header metrics; the planner's conversation.
- **Migration**: single-task missions display in the new view unchanged.
- **Deferred**: parallel execution (P9). In P8 a mission's tasks run one at a time, in
  dependency order, **in one mission worktree on the mission branch**: each task's attempt starts
  from the previous task's verified head, so `code` dependencies hold without any merge. A fresh
  retry resets to the pre-task commit on a new `-a<n>` branch. Per-task worktrees and the
  Integrator arrive with parallelism in P9.
- **Acceptance criteria**: a mission can be written by hand or planned; nothing runs before
  approval; the planner produces one task for a single-scope objective in the corpus's
  "should not split" cases; a cyclic plan is refused with the cycle shown.
- **Non-goals**: hierarchical planning.
- **Prerequisite for next**: missions with graphs to schedule.

### P9: Scheduling, integration and contention

- **Objective**: independent tasks run at the same time, safely, and their results meet on a
  mission branch that is verified as a whole.
- **Architectural changes**: the scheduler step function and loop; the Integrator and mission
  branch; conflict-resolution attempts; overlap serialisation; leases (#23); admission control on
  usage windows and caps; the mission simulation suite.
- **Implementation**: #45 scheduler; #46 integration; #47 contention and leases; #48
  simulation suite.
- **Tests**: scheduler tables; temp-repo merges and conflicts; invariant checks over random
  missions; lease acquisition and release across restart.
- **Observability**: parallelism benefit; queue times; conflict counts; mission verification
  health.
- **Migration**: none.
- **Deferred**: budget strategies (Future).
- **Acceptance criteria**: `A → B, A → C, B + C → D` runs B and C together and D after both are
  integrated; two overlapping tasks never run together; a Unity task waits for its lease; a merge
  conflict produces a conflict-resolution attempt or a clear `needs-human`; the mission branch is
  verified after each merge; mission review offers merge, PR, keep and discard; a mission survives
  `app:install` mid-run.
- **Non-goals**: cross-repository missions.
- **Prerequisite for next**: enough missions to analyse.

### P10: Routing analytics

- **Objective**: answer §17's questions from data.
- **Architectural changes**: an analytics view (by kind, tier, effort, model, repository); the
  calibration report; the JSONL vs SQLite decision.
- **Implementation**: #49.
- **Tests**: aggregations over fixture telemetry; the "not reported by <harness>" rendering.
- **Observability**: this is it.
- **Migration**: if SQLite is adopted, a one-way import of the JSONL history.
- **Deferred**: adaptive proposals.
- **Acceptance criteria**: the view shows first-attempt and eventual success, escalation rate,
  cost per successful task and model distribution, each filterable by kind and repository, with
  missing provider fields labelled; the calibration report lists under- and over-routing
  candidates with the evidence behind each.
- **Non-goals**: automated changes.

### Future (each behind a gate)

| Item | Gate | Issue |
|---|---|---|
| Local-model runtime spike | a local inference server exists on this machine and James wants it used | #50 |
| Local-model provider | the spike's recommendation | #51 |
| Historical routing suggestions | ~1,000 attempts, or enough in the cohorts that matter (§20.4) | #52 |
| Budget strategies | P9 and P10 done; evidence that caps are not enough | #53 |
| Session reuse | P9 done; evidence that start-up context is a significant cost | #54 |
| Hierarchical orchestration | evidence that static plans are the bottleneck (§22.2) | #55 |

---

## 30. GitHub Project structure

Conventions are the Project's existing ones (`.claude/agents/product-manager.md`, and the #4
playbook §17), extended where this initiative needed it:

- **One epic** with every issue attached as a native **sub-issue**, and blockers as native
  **issue dependencies** (blocked-by). The epic is labelled `feature` (it is a new capability,
  where #4 was `tech-debt`).
- **Phase-level tracking: milestones**, one per phase (`Orchestration P0 · Foundations` …
  `Orchestration P10 · Analytics`, plus `Orchestration · Future`). Each milestone's description
  holds the phase objective and exit criteria. Milestones show per-phase progress without adding
  a tracking card per phase to the Board. The Project's `Milestone` field can group the Board by
  phase.
- **Exactly one type label per issue**, as before (`feature`, `tech-debt`, `testing`, `spike`,
  `documentation`).
- **New topic labels**, since nothing equivalent existed (the brief's `architecture`, `research`,
  `provider` and `testing` map onto `tech-debt`, `spike`, the `Providers/Runner` Area and
  `testing`):
  - `orchestration`: every issue in this initiative.
  - `telemetry`: execution telemetry and analytics.
  - `local-model`: future local inference work.
  - `future`: explicitly deferred behind a gate; not to be groomed into Ready until the gate is met.
- **Project fields**: Status **Inbox** for everything. Nothing can start until #4 is done, so
  none of it is Ready, and a Blocked column holding thirty cards would bury the Blocked items that
  need James now. The blocked-by links carry the ordering. Priority P2 for P0–P7 (except the optional review verifier #36, P3), P3 for P8
  onward and Future. Effort per issue. Area **Automation** (scheduling, dispatch) by default;
  **Providers/Runner** for the session-level and provider work (#27, #29, #30, #50, #51),
  **Table** for #28 and **Budget** for #53.
- Every issue body follows the brief's template: Objective, Context, Scope, Non-goals,
  Architectural constraints, Acceptance criteria, Tests / validation, Telemetry, Dependencies,
  Suggested coding agent, Future considerations. Each ends with its phase and a pointer to this
  document.

### 30.1 Issues

Created 2026-09-24. All are sub-issues of the epic [#24](https://github.com/hammonjj/AgentWrangler/issues/24),
in the Project with Status Inbox, labelled `orchestration` plus the type shown.

| Phase | Issue | Title | Type | Pri · Effort · Area | Blocked by |
|---|---|---|---|---|---|
| — | #24 | Orchestrate engineering missions across agents: plan, route, verify and escalate (epic) | feature | P2 · XL · Automation | #4 |
| P0 | #25 | Architecture gate: confirm the orchestration plan against #4 as built | documentation | P2 · XS · Automation | #4 |
| P0 | #26 | Add the orchestration domain model, mission store and one typed launch path | tech-debt | P2 · M · Automation | #25 |
| P1 | #27 | Record per-turn telemetry for every session Agent Wrangler hosts | feature, telemetry | P2 · M · Providers/Runner | #26 |
| P1 | #28 | Show model, effort, tokens and estimated cost for each hosted session | feature, telemetry | P2 · S · Table | #27 |
| P2 | #29 | Describe models by capability: a catalog with tiers and effort maps | feature | P2 · M · Providers/Runner | #26 |
| P2 | #30 | Add a harness seam over the session executor, with a simulated harness for tests | tech-debt | P2 · M · Providers/Runner | #26 |
| P3 | #31 | Create, set up and clean up task worktrees and branches | feature | P2 · M · Automation | #26 |
| P3 | #32 | Read a per-repository orchestration policy | feature | P2 · S · Automation | #26 |
| P3 | #33 | Run a task in its own worktree with a chosen route, surviving restarts | feature | P2 · L · Automation | #27, #29, #30, #31, #32 |
| P3 | #34 | Show tasks and their attempts in the table and conversation panes | feature | P2 · M · Automation | #33 |
| P4 | #35 | Verify task results with repo-defined checks before calling them done | feature | P2 · M · Automation | #33 |
| P4 | #36 | Add an advisory review-agent verifier for acceptance criteria | feature | P3 · S · Automation | #35 |
| P5 | #37 | Assess tasks with deterministic rules plus one structured model call | feature | P2 · M · Automation | #33, #30, #32 |
| P5 | #38 | Recommend a route for every task, with reasons, in shadow and assisted modes | feature | P2 · L · Automation | #37, #29, #34 |
| P5 | #39 | Build a routing evaluation corpus that runs in the test suite | testing | P2 · M · Automation | #37 |
| P6 | #40 | Enforce routing pins and caps at global, repository, mission and task scope | feature | P2 · M · Automation | #38 |
| P6 | #41 | Retry and escalate failed attempts within hard limits | feature | P2 · L · Automation | #35, #40 |
| P7 | #42 | Let missions opt into automatic routing once the shadow record supports it | feature | P2 · M · Automation | #39, #41 |
| P8 | #43 | Create multi-task missions with a plan the user reviews before anything runs | feature | P3 · L · Automation | #34, #35 |
| P8 | #44 | Decompose a mission into tasks with a read-only planner | feature | P3 · L · Automation | #43, #37 |
| P9 | #45 | Schedule mission tasks by dependency, capacity and usage budget | feature | P3 · L · Automation | #43, #41 |
| P9 | #46 | Integrate verified task branches into a verified mission branch | feature | P3 · L · Automation | #45, #35 |
| P9 | #47 | Keep overlapping tasks and exclusive resources from running at once | feature | P3 · M · Automation | #45, #23 |
| P9 | #48 | Simulate whole missions under injected failures | testing | P3 · M · Automation | #45, #30 |
| P10 | #49 | Show routing analytics and a calibration report | feature, telemetry | P3 · M · Automation | #42, #46 |
| Future | #50 | Spike: how local models could run behind Codex and Claude Code | spike, local-model, future | P3 · S · Providers/Runner | #29 + gate |
| Future | #51 | Route to local models: endpoint discovery, capability probing and health | feature, local-model, future | P3 · L · Providers/Runner | #50 |
| Future | #52 | Propose routing-policy changes from historical outcomes | feature, telemetry, future | P3 · L · Automation | #49 + gate |
| Future | #53 | Add budget-aware routing strategies | feature, future | P3 · M · Budget | #45, #49 |
| Future | #54 | Reuse warm sessions for follow-on tasks | feature, future | P3 · M · Automation | #45 |
| Future | #55 | Spike: decide whether hierarchical orchestration earns its cost | spike, future | P3 · S · Automation | #46, #49 |

Forward-compatibility asks A1–A5 (§1.3) were posted as comments on #12, #13 and #23.

### 30.2 Dependency order

```text
#4 ─► #25 gate ─► #26 foundations ─┬─► #27 telemetry ─► #28 usage UI
                                   ├─► #29 catalog ─────────────┐
                                   ├─► #30 harness + simulation ┤
                                   ├─► #31 worktrees ───────────┤
                                   └─► #32 repo policy ─────────┤
                        #27 ────────────────────────────────────┴─► #33 run a task ─► #34 task UI
#33 ─► #35 verification ─► #36 review verifier
#33 + #30 + #32 ─► #37 assessment ─┬─► #38 router (+#29, #34) ─► #40 pins/caps ─┐
                                   └─► #39 corpus ─────────────┐                │
#35 + #40 ─► #41 escalation ◄──────────────────────────────────┼────────────────┘
#41 + #39 ─► #42 automatic routing ◄───────────────────────────┘
#34 + #35 ─► #43 missions ─► #44 planner (+#37)
#43 + #41 ─► #45 scheduler ─┬─► #46 integration (+#35)
                            ├─► #47 contention (+#23)
                            └─► #48 simulation suite (+#30)
#42 + #46 ─► #49 analytics
Future: #29 ─► #50 local spike ─► #51 local provider · #49 ─► #52 adaptive
        #45 + #49 ─► #53 budget · #45 ─► #54 session reuse · #46 + #49 ─► #55 hierarchy
```

---

## 31. Model and effort for each issue

Planning guidance for the coding agent that picks the issue up, **not** part of the architecture.
Classes follow §6.3 (`basic`, `standard`, `expert`); efforts are the CLI's levels. The concrete
models are what is available on 2026-09-24 (Opus 5.5 for expert, Sonnet for standard); re-map by
class if names change.

| Issue | Class / effort | Why | Escalate when |
|---|---|---|---|
| #25 gate | Expert / xhigh | architecture review against #4 as built; decides amendments | — |
| #26 foundations | Expert / high | types and state machines outlive every phase | invariants will not settle → xhigh |
| #27 telemetry | Standard / high | well-specified; the cumulative-delta logic needs care | delta tests disagree with the CLI → Expert / high |
| #28 usage UI | Standard / medium | UI over settled data; narrow-pane rules | — |
| #29 catalog | Expert / high | the capability abstraction is the keystone for local models | — |
| #30 harness + simulation | Expert / high | the seam every later test depends on | — |
| #31 worktrees | Standard / high | git edge cases, well-bounded | refusal rules ambiguous → Expert / high |
| #32 repo policy | Standard / medium | schema + loader + validation | — |
| #33 run a task | Expert / high | lifecycle, write-ahead, recovery against #4 | recovery cases multiply → xhigh |
| #34 task UI | Standard / high | two panes, 300 px, CSP | — |
| #35 verification | Standard / high | runner + strategies; flaky and pre-existing logic | — |
| #36 review verifier | Standard / medium | one strategy over the framework | — |
| #37 assessment | Expert / high | dimension design, schema, prompt, combination rules | — |
| #38 router | Expert / high | rules, resolver, explanations, shadow | — |
| #39 corpus | Standard / high | labelling judgment and a harness | labels disputed → Expert review |
| #40 pins and caps | Standard / high | precedence rules, validation | — |
| #41 escalation | Expert / xhigh | runaway-loop safety, caps, many paths | — |
| #42 automatic routing | Expert / high | gate logic and trust | — |
| #43 missions | Standard / high | entity + plan review UI | — |
| #44 planner | Expert / high | prompt, schema, validation, repair | — |
| #45 scheduler | Expert / xhigh | concurrency, capacity, invariants | — |
| #46 integration | Expert / high | merges, conflicts, reverts, recovery | — |
| #47 contention | Expert / high | overlap prediction and leases | — |
| #48 simulation suite | Standard / high | test code over specified behaviour | flaky simulations → Expert / high |
| #49 analytics | Standard / high | aggregation and UI; one storage decision | storage decision contested → Expert |
| #50 local spike | Expert / high | research across runtimes and harnesses | — |
| #51 local provider | Standard / high | an adapter over a settled design | — |
| #52 adaptive | Expert / xhigh | statistics and safety | — |
| #53 budget | Expert / high | policy design | — |
| #54 session reuse | Expert / high | assignment semantics; fork behaviour | — |
| #55 hierarchy | Expert / xhigh | a decision gate | — |

No issue is recommended for the `basic` class: each one moves an interface or a policy. Pieces
of them (fixture authoring, formatter tests, docs updates) can be handed to a `basic`/`low`
subagent by whoever runs the issue.

---

## 32. Deferred roadmap

| Area | What would be built | What is already in place so it needs no rewrite |
|---|---|---|
| **Local models** | endpoint registry; discovery and probing; health; OpenAI-compatible completions; local models inside Codex via its model-provider configuration; local observability | harness vs source split (§6.1); `Known<>` capability provenance; tiers as data; `location` as an axis; unassigned-until-tiered; `StructuredCompletion` interface |
| **Adaptive routing** | cohort statistics; proposals; the acceptance UI; bounded automatic adjustment | telemetry with assessment snapshots and outcomes from P1/P3; shadow data from P5; the corpus veto |
| **Budget optimisation** | strategies (§21); usage-window-aware scheduling across missions | budget-blind router; resolver ranking hook; admission control (P9) |
| **Specialization** | `reuse` and `fork` assignments; warm-session ranking | `AgentAssignment` separate from `RoutingDecision`; `continue` mode already exists |
| **Hierarchical orchestration** | a lead agent that supervises and replans | the planner is an attempt; replanning is a plan diff |
| **Phase-split routes** | one task planned on one tier and executed on another (Claude Code's `opusplan`, Aider's architect/editor) | `RouteRequirement` is a value object that can gain a `planning` part; the `plan-first` gate already marks candidates |

---

## 33. Architecture review

The brief's fifteen questions, answered against this plan.

| # | Question | Answer |
|---|---|---|
| 1 | Are tasks coupled to Claude/Codex? | No. Tasks hold objectives, criteria, scope and assessments. Models appear only in `ExecutionTarget` (history) and user pins (instructions). Harness-specific behaviour is behind `AgentHarness` and `HarnessCapabilities`. The UI reads capabilities, not provider strings (§2.4.7). |
| 2 | Can a local OpenAI-compatible provider be added without redesign? | Yes: a `ModelSource` + catalog entries + (for agentic work) a harness that can reach it, which Codex's model-provider configuration provides; for completions, a direct client behind `StructuredCompletion`. No task, rule or store change (§19). |
| 3 | Are model and effort independent? | Yes. Tier and effort come from different assessment dimensions (§9.3); effort maps per model; requested, native and applied are recorded separately (§6.4). |
| 4 | Can capabilities change without task-data migrations? | Yes. Tiers and capabilities are catalog data; decisions snapshot them with a catalog version (§6.3, §23.4). |
| 5 | Can every routing decision be explained? | Yes. Pure router, reasons recorded at decision time, resolver candidates with rejection reasons, rendered from the stored decision (§9.5). |
| 6 | Can orchestration be tested without API credits? | Yes. `SimulatedHarness` and `SimulatedCompletion` through the real launch seam; the deterministic corpus in `npm test` (§26.3, §27). |
| 7 | Can provider/model failures be simulated? | Yes: every failure in the brief's list is a scenario behaviour (§26.3). |
| 8 | Can orchestration state be recovered after a restart? | Yes. The mission store is durable with write-ahead intents; attempts map onto #4's registry; live attempts reattach; interrupted ones are offered, not auto-resumed (§23). |
| 9 | Can concurrency corrupt repositories? | Not by construction. One worktree per attempt; AW-owned git operations; merges only into a mission branch; scope-overlap serialisation; leases for non-git resources; never touches the primary checkout; refuses to remove dirty or unmerged trees (§13). |
| 10 | Can retries or escalations run away? | No. Hard limits per task and mission, signature-based repeat detection, caps that only tighten, pins that freeze, invariants checked in simulation (§15.3, §26.3). |
| 11 | Are metrics sufficient to judge cost, speed and quality? | For cost, speed and first-attempt quality, yes. Routing quality is only *partly* observable (the counterfactual is never seen), which is why shadow mode and assisted agreement are collected, and why over-routing is labelled a heuristic (§17). |
| 12 | Is the telemetry adaptive routing needs being gathered? | Yes, from P1 (turns) and P3 (attempts with assessment snapshots, routes, outcomes), with shadow recommendations from P5 (§16, §20). |
| 13 | Has adaptive routing been avoided prematurely? | Yes. It is Future, gated on volume, and designed to propose rule changes rather than route (§20). |
| 14 | Does every phase leave the app releasable? | Yes. Behind `orchestration.enabled`; each phase is useful on its own; P1 is independently useful telemetry (§28.3). |
| 15 | Are the GitHub tasks sized and ordered? | 31 issues + the epic, each one coherent unit landing in one branch; blocked-by links as in §30.2; phases as milestones. |

---

## 34. Decisions (settled 2026-09-24)

All seven were open when the plan was written; James decided them on 2026-09-24. The sections
named carry the detail.

1. **Per-repo policy lives on AW's side only** (§13.6): `<userData>/repos/<repo-id>.json`, keyed
   by the git common directory, edited in Preferences. Nothing is written into the repository.
2. **This repository finishes by merging locally** (§13.3), gated: the merged result must pass
   typecheck, tests and build before `main` moves, so `main` stays usable for daily work;
   unfinished parts of a feature ship behind a setting that is off by default. The PR-based workflow
   once proposed on a `chore/worktree-workflow` branch was dropped (branch deleted 2026-09-24).
3. **Tier defaults** (§6.3): Haiku / `gpt-6-luna`, `gpt-reserve` → `basic`; Sonnet /
   `gpt-6-sol` → `standard`; Opus / `gpt-6-astra` → `expert`; Fable → a fourth tier,
   `frontier`, **escalation-only** and off per mission by default (kept for the rare task that
   really needs it). Superseded Codex generations are unassigned.
4. **Permission posture** (§24.1): attempts do not inherit the parent's mode, which is a ceiling
   instead. Claude `auto` plus allow rules for repo checks; Codex `workspace-write` +
   `on-request`; one mission-scoped approval queue; hard denies in every mode; never
   `bypassPermissions`.
5. **Telemetry on by default** (local, metadata only, deletable), with a setting to turn it off.
6. **Mission size caps**: default 8 tasks, hard cap 12, three concurrent attempts.
7. **Strictly after #4.** The pure pieces could start earlier, but do not; #25's gate runs once
   #4 lands.


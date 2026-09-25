# Intelligent orchestration: external research notes

Companion to `docs/plans/intelligent-orchestration.md` (§3 there is the summary). Collected
2026-09-24 from project READMEs, source files, official documentation and published write-ups.
Where a claim comes from a search summary rather than a primary source, or could not be checked,
it says **unverified**. Everything about local inference servers should be re-checked against a
running server before code depends on it (issue #50).

For each idea, the question is the same: what problem it solves, how the other system does it,
whether it fits a single-user, local, desktop orchestrator of CLI coding agents, and the verdict.

---

## 1. Maestro AI (github.com/David-J-Shibley/maestro-ai)

**What it is.** A TypeScript library, MCP server and CLI that sits in front of Ollama (local) and
LiteLLM (hosted) and routes each LLM call from a coding harness to one of four tiers, runs
multi-step workflows as DAGs, verifies outputs, escalates on failure and logs telemetry that can
nudge later routing. It is the closest published analogue to this plan's shape.

**Maturity** (GitHub API, 2026-09-24): created 2026-07-11, last push 2026-08-18, 5 stars, 0 forks,
0 issues, MIT, v1.9.6, dependencies `@modelcontextprotocol/server` and `zod` only. About 100
source files (`src/routing/`, `src/router/`, `src/analyzer/`, `src/workflow/`, `src/telemetry/`,
`src/evaluator/`, `src/proxy/`) and 40+ test files, including golden routing tests. A
well-decomposed solo project with no evidence of outside use: an idea source, not a validated
design. `docs/VISION.md` is ahead of the code in places (it says "seven routing modes"; the code
has six).

| Area | How Maestro does it | Fit here | Verdict |
|---|---|---|---|
| **Task analysis** (`src/analyzer/task-analyzer.ts`) | Heuristic by default, no LLM: regex and keyword scoring into `taskType`, `difficulty` (easy/medium/hard), `riskLevel` (low/medium/high), `requiresToolUse` + additive `toolNeedScore` (threshold 0.55), `requiresCodeReasoning`, `requiresLongContext`, `requiresStructuredOutput`, `confidence`, `signals[]` | The layering (cheap deterministic first, evidence trail) is right. Its keyword lists are specific to chat prompts; AW has richer deterministic signals (paths, repo policy, configured verification) | **Adapt**: rules first, with evidence per value (§8) |
| **LLM classifier** (`src/analyzer/llm-classify.ts`) | Only when heuristic confidence < 0.65, type unknown, or tool need borderline. Modes `off` / `shadow` (logs agreement, heuristic wins) / `on`. **Anti-gaming clamp**: an LLM alone cannot promote a task to `hard` | The shadow mode is real and worth copying. The clamp protects cost. Here the costly error is *under*-routing, so the clamp is inverted: the model cannot lower risk below a rule's floor or route to `basic` on its own | **Adapt** (§8.3, §9.3) |
| **Tiers** (`src/config/tier-config.ts`) | `local_fast`, `local_strong`, `hosted_oss`, `premium`. Tier doubles as effort, since there is no separate effort knob | Encodes location in the tier; conflates effort | **Reject the tier names; keep tiers as data** (§6.3) |
| **Layered routing** (`src/router/model-router.ts`) | Overrides → baseline from analysis → tool-use floor → preferences/stickiness/`maxTier` → policy rules → workload role → mode → budget → guardrails → learned hint. Each layer a small function that tightens | Exactly the explainable shape wanted: each layer can add a reason | **Adopt** (§9.3 ordering) |
| **Workload roles** (`src/routing/workload.ts`) | Six roles (orchestrator, research, coder, formatter, critic, extractor) with tier floors and caps | AW's `kind` plays this role: floors (architecture, migration) and ceilings (docs, chore) independent of prompt text | **Adopt** as kind floors/ceilings (§9.3) |
| **Routing modes** (`src/routing/modes.ts`) | `balanced`, `local-only`, `cheapest`, `fastest` (no same-tier retries), `best-quality`, `private` (localhost only) | A coarse, explainable dial above per-task routing | **Adopt** as budget strategies and exclusions (§10.2, §21); `private` becomes a local-only exclusion once local models exist |
| **Budget** (`src/routing/budget.ts`) | Session USD budget; downgrade ladder as it runs out; never blocks entirely (local remains); `canEscalateWithinBudget` guards escalation | For a subscription user the budget is a usage window, not dollars. "Guard escalation against budget" is right. "Downgrade below need to save money" is not | **Adapt**: caps and admission control, never below the required tier (§12.4, §21) |
| **Guardrails** (`src/routing/guardrails.ts`) | Budget, privacy (keyword detection → cap to local or block cloud), latency; structured `allow/warn/cap/block` results for an explanation card | Privacy caps matter once local models exist; latency targets matter less for asynchronous tasks | **Defer** privacy to local-model work; **reject** latency |
| **DAG** (`src/workflow/dag.ts`, `executor.ts`) | Steps with `dependsOn`, `runOnFailure`, `optional`, `parallelizable`; level-by-level ready sets; `Promise.all` within a level | Fine for in-process LLM calls; AW's steps are hours-long sessions with git side effects | **Adapt** (§12) |
| **Crash recovery** | **None**: progress is an in-memory map; a crash loses the run | Unacceptable here: AW restarts many times a day | **Reject**: durable store with write-ahead intents (§23) |
| **Workflow patterns** (`src/workflow/patterns.ts`) | Templates: single-shot, plan-execute-validate, parallel-synthesis, critique-revise, implement-test-fix, extract-normalize-validate | `implement-test-fix` is close to a single AW task with verification and escalation. Templates could seed the planner | **Defer**: planner prompt hints (§11) |
| **Verification** (`src/evaluator/response-evaluator.ts`) | Non-empty, integrity, refusal, JSON schema, format, required files, tool-call validity, truncation, optional `runTests`/`runBuild`. **Retry** for request problems, **escalate** for capability problems; truncation → retry with more output tokens | The retry-vs-escalate split is the key idea. AW's verification is repo commands in a worktree, which is stronger | **Adopt the split** (§15) |
| **Context overflow** (`src/proxy/context-retry.ts`) | Detects native overflow; retries once with tools stripped | A same-tier fix before escalation | **Adapt** (`context` category, §15.2) |
| **Telemetry** (`src/telemetry/records.ts`) | `promptHash` (not the prompt), full task analysis, tier and model, latency, tokens, estimated cost, success, escalated, fallback, per-attempt `attemptLog`, `userRating` (1–5), `userAccepted`, `sessionId` | Close to AW's attempt record. The explicit human accept/reject signal is the most undervalued field | **Adopt** (§16.2 `task-final`, `task-later`) |
| **Learned hints** (`src/routing/learned.ts`) | Success rate by bucket; confidence high if n ≥ 20 and rate ≥ 0.85 or ≤ 0.5, medium n ≥ 10, low n ≥ 5; applied if ≥ medium, rate ≥ 0.7, within 2 tiers. "Online bandits / weight training remain future work" | The shape (gate on evidence) is right; flat thresholds behave badly at the small counts one user produces | **Adapt**: Beta-binomial bounds, proposals a human accepts (§20) |
| **Stickiness** | Keep later calls on the same tier to benefit from prompt caching | Continuing a session on retry keeps its cache; a tier change breaks it and is priced in | **Adopt** (§15.2, resolver ranking later) |
| **Capability discovery** | None; models are pre-configured | AW needs probing for local servers | **Gap**: AW goes further (§19) |

---

## 2. Learned model routers

| System | How | Evidence volume | Verdict |
|---|---|---|---|
| **RouteLLM** (github.com/lm-sys/RouteLLM; arXiv 2406.18665) | Learned strong-vs-weak routers: matrix factorisation (recommended), BERT classifier, causal-LLM classifier, similarity-weighted Elo, random baseline; trained on preference pairs. **Threshold calibration** to a target share of strong-model calls (`calibrate_threshold --strong-model-pct 50`). Reported ~95% of GPT-4 quality at a fraction of GPT-4 calls on MT-Bench | Large preference datasets | **Defer**. The "calibrate to a target share of expensive calls" idea is a possible budget strategy later (§21) |
| **NotDiamond** (docs.notdiamond.ai) | Hosted `modelSelect` API: candidates + a cost/latency/quality trade-off → recommendation; feedback personalises; custom routers from eval data. Internals unpublished | Their training data | **Reject** as a dependency (hosted, sends prompts out); the trade-off knob matches §21 |
| **Martian** (docs.withmartian.com; RouterBench) | Hosted gateway with "willingness to pay" routing and failover; routing method unpublished (**unverified** claims). RouterBench is an open benchmark for routers | — | **Reject** as a dependency; RouterBench is a possible later reference for evaluation |

The lesson from all three is §8.1's: asking a classifier for a model directly needs a lot of
labelled preference data and is invalidated when the model roster changes. AW classifies the
work and keeps model choice in policy and the catalog.

---

## 3. Coding-agent harnesses and orchestration

### 3.1 Claude Code and the Agent SDK

- **Subagents** (code.claude.com/docs/en/sub-agents): per-subagent `model` (`sonnet`, `opus`,
  `haiku`, `fable`, a full id, or `inherit`), tools, permission mode, `maxTurns`, `background`,
  `isolation: worktree`. Model resolution: invocation → frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL`
  → session model. Defaults: up to 20 concurrent subagents, nesting depth 3. Role-based model
  pinning inside one session. **Fit**: opaque inside an attempt; its cost is attributed via
  `modelUsage` (§22.2).
- **`opusplan`**: Opus for plan mode, Sonnet for execution. Aider's architect/editor split (§3.3)
  is the same idea. **Fit**: a *phase-split route* (a planning tier and an execution tier for one
  task). **Deferred**, recorded in §32; the requirement type can carry it later.
- **Effort** (code.claude.com/docs/en/model-config): `low | medium | high | xhigh | max`, set
  by `/effort`, `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, per-model settings; `ultracode` = `xhigh`
  plus orchestrated workflows. The local SDK types confirm `effort` on `Options`, per-model
  `supportedEffortLevels`, `maxEffortLevel` caps in settings, and applied effort in hook payloads
  (`effort.level`) and on some `system/init` frames. **Fit**: effort is a separate axis in the
  harness itself, which validates §6.4.
- **SDK options**: `model`, `fallbackModel`, `effort`, `thinking`, `maxTurns`, `maxBudgetUsd`,
  `outputFormat: {type: 'json_schema'}` → `structured_output` on `result`, `sessionId` for a
  pre-assigned id, `forkSession`. **Fit**: `fallbackModel` is usable for capacity failover **only
  with a model of the same tier** (otherwise it would silently cross a cap). `maxBudgetUsd` and
  `maxTurns` are per-attempt backstops. `outputFormat` is how structured completions work without
  an API key (§6.1).
- **Agent Teams** (code.claude.com/docs/en/agent-teams, experimental): a shared task list
  (pending / in progress / completed) with dependencies, file-lock-based claiming, per-teammate
  models, quality-gate hooks (`TaskCreated`, `TaskCompleted`, `TeammateIdle`). Documented limits:
  no resumption of in-process teammates, no nested teams, token cost linear in teammates, 3–5
  teammates suggested. **Fit**: confirms the dependency-gated task list; its limits are the
  failure modes this plan designs past (§23). The 3–5 guidance matches the default of 3 concurrent
  attempts.
- **"Building effective agents"** (anthropic.com/engineering/building-effective-agents): prompt
  chaining with gates, routing (easy to small models, hard to capable ones), parallelisation
  (sectioning; voting), orchestrator-workers, evaluator-optimizer. **Fit**: the vocabulary this
  plan uses. Planner = orchestrator-workers with a human gate; verification + escalation =
  evaluator-optimizer with deterministic evaluators first.
- **Multi-agent research system** (anthropic.com/engineering/multi-agent-research-system;
  details via search summary, **unverified** in specifics): multi-agent runs used ~15× the tokens
  of a chat turn; token usage explained most performance variance; lessons: self-contained task
  descriptions, externalise state, a **separate verification pass** for high-stakes output.
  **Fit**: supports the one-task default (§11.3), self-contained task objectives with acceptance
  criteria, and verification by something other than the generating agent.

### 3.2 Codex CLI and app-server

- `model_reasoning_effort` in `config.toml`: `minimal | low | medium | high | xhigh`; the
  app-server's `thread/start` also takes `none`. `turn/start` takes **per-turn** `model` and
  `effort` overrides. AW already passes `config.model_reasoning_effort` on `thread/start`.
- **Local and custom providers**: `[model_providers.<id>]` with `base_url`, `wire_api`, `env_key`,
  headers, retries; built-in `ollama` and `lmstudio` providers; `--oss` runs against a local
  provider. `wire_api = "responses"` is the only supported wire protocol (**verified** in
  0.155 by #50: `"chat"` is rejected; plan §19.6).
- **Usage**: `thread/tokenUsage/updated` per model response, **cumulative per thread**, so
  consumers must difference it (a known pitfall on resumed threads). Rate limits via
  `account/rateLimits/read` and `/updated` (5-hour and weekly windows as percentages; AW already
  reads them). **No USD cost** in the protocol; credits are shown in the TUI only.
- **Fit**: Codex is the most direct path for local models into an agentic harness (§19), and
  already treats effort as independent of model.

### 3.3 Aider architect/editor (aider.chat/2024/09/26/architect.html)

A strong reasoning model describes the change and a cheaper editor model applies it in the
structured edit format. Reported benchmark gains, and lower cost than the strong model alone.
**Fit**: evidence for phase-split routes (deferred, §32). Not reusable as code.

### 3.4 OpenHands and SWE-agent (via documentation and search summaries)

- OpenHands: a hard iteration cap per run (`MaxIterationsReached`), a condenser that summarises
  history near the context limit, and a hard-quota classifier that **skips retries** on quota
  errors.
- SWE-agent: a constrained agent-computer interface; instructions to reproduce a bug and write a
  test that fails before the fix; bounded retries with backoff and an iteration ceiling.
- **Fit**: adopt hard caps and "don't retry into a quota wall" (§15.2 `capacity`). Adopt
  **fails-before / passes-after** as a verification strategy for bug fixes (§14.1
  `regression-test`). Context condensing is the harness's job (Claude Code compacts).

### 3.5 Parallel coding-agent tools

Claude Squad (tmux, one worktree per agent), uzi (worktree + branch + dev port per agent,
one-command merge), Conductor (macOS app, a worktree and branch per workspace, review diffs, open
PRs; treats conflicts as expected and recommends **merging one branch at a time**), Sculptor
(containers instead of worktrees), Crystal/Nimbalyst and Vibe Kanban (board UX over worktrees).

**Fit**: one worktree per parallel unit is the universal answer, which matches this repo's
convention. **Integration is serialised** here too (§13.3). **None of them schedules around
predicted file overlap before starting work**; they discover conflicts at merge time. The
scope-overlap check (§13.4) is a gap in the field, and it is a heuristic here too, measured by
`scopeAccuracy`.

### 3.6 Durable execution

- **Temporal**: an append-only event history, replayed deterministically after a crash;
  side-effecting activities retried with idempotency. Correct and heavy: a separate service and a
  replay engine.
- **LangGraph**: a snapshot of the whole graph state after every node, keyed by thread; resume
  from the latest checkpoint; interrupts for human-in-the-loop; in-memory saver not durable,
  SQLite/Postgres savers are.
- **Fit**: AW's steps are sessions whose side effects are commits on their own branch (naturally
  close to idempotent), there is one writer, and #4 already rejected running a separate service.
  So: **snapshot state after every transition, plus write-ahead intents before irreversible side
  effects, plus an append-only event log for history**, in `JsonStore` (§23). The research agent
  suggested SQLite; #4's persistence decision stands until analytics needs queries (#49).

---

## 4. Local inference: what each server can tell AW

| Server | Model listing | Context length | Tools / vision / thinking | Structured output | Effort / reasoning | Health / concurrency | Timing metrics |
|---|---|---|---|---|---|---|---|
| **Ollama** | `GET /api/tags` (`details`: family, parameter size, quantisation) | `POST /api/show` → `model_info["<arch>.context_length"]`, keyed by `general.architecture` (no flat field) | `/api/show` → `capabilities: ["completion","tools","thinking","vision"]` | JSON / schema `format` | `think` for thinking models | no health endpoint beyond listing; `OLLAMA_NUM_PARALLEL` not queryable | `eval_count`, `eval_duration` (ns), `prompt_eval_count`, `load_duration` |
| **llama.cpp server** | `GET /v1/models` (id = file path or `--alias`) | `/props` (`default_generation_settings`) | `/props` → `modalities`, `chat_template_caps` (tool support only indirectly) | `--json-schema`, GBNF grammar | `--reasoning`, `reasoning_format` | `GET /health` (503 while loading); `/props` `total_slots`; `/slots` live state | `timings`: `prompt_n`, `prompt_per_second`, `predicted_n`, `predicted_per_second`, `cache_n` |
| **vLLM** | `GET /v1/models` | `--max-model-len` (whether the listing reports it is **unverified**) | model-dependent | guided decoding (`guided_json`) | `reasoning_effort` (OpenAI-style) | server flags | usage in responses |
| **LM Studio** | `/v1/models` (OpenAI shape, no metadata); native `/api/v0/models` | `max_context_length` | `type: llm \| vlm`; no documented tool flag (**unverified**) | JSON schema | `reasoning.effort` for reasoning models | `state: loaded \| not-loaded` | — |
| **MLX** (`mlx_lm.server`; mlx-omni-server; mlx-openai-server) | `/v1/models` (ids only) | launch flag only | `mlx_lm.server` 0.31.3 parses tool calls from the chat template (**measured** by #50; it depends on the model); mlx-omni-server also serves an **Anthropic-compatible** endpoint | `mlx_lm.server`: none, `response_format` ignored (measured) | `mlx_lm.server`: `enable_thinking` on/off only | `mlx_lm.server`: `/health` | `mlx_lm.server`: none |

Measured facts for `mlx_lm.server`, and the harness paths, are in plan §19.6 (#50, 2026-09-25).
Codex 0.155 requires `wire_api = "responses"` (**verified**: `"chat"` is rejected).

**Consequences for the design** (§19):

1. Discovery needs per-runtime probes, and some facts can only be *declared* by the user. That is
   why every capability is `Known<T>` with provenance, and why an unknown stays unknown.
2. MLX servers describe themselves least; expect declared context and tool support, verified by
   a small qualification run.
3. Two agentic paths exist: Codex's model providers (OpenAI-compatible, possibly Responses-only)
   and Claude Code against an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`), which a few
   local servers offer. Tool-call reliability on local models is the open question for #50.

---

## 5. Telemetry fields

- **Claude Agent SDK `result`** (local `sdk.d.ts`, SDK 0.3.x, and the cost-tracking docs):
  `total_cost_usd` (cumulative per `query()`, an estimate, "not a billing statement"), `usage`
  (**main loop only**, per turn in streaming sessions), `modelUsage` (per model, **includes
  subagents and internal pipeline calls**, cumulative; fields `inputTokens`, `outputTokens`,
  `thinkingTokens?`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `webSearchRequests`,
  `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel?`, `provider?`, pricing basis),
  `num_turns`, `duration_ms`, `duration_api_ms`, `ttft_ms`, `terminal_reason`,
  `api_error_status`, `permission_denials`, `structured_output`. Resumed sessions start the totals
  fresh; `/clear` resets them; crash results may carry zeroed values; per-message `output_tokens`
  on assistant messages is a placeholder. → §16.3's segment-and-difference rule, and "never
  subtract a zeroed crash total".
- **Codex app-server**: cumulative `thread/tokenUsage/updated`; rate-limit windows; no USD. → a
  user-editable price table, `basis: price-table`, or "not reported".

---

## 6. Shadow mode and small-sample statistics

- **Shadow mode** is standard practice in ML deployment: the candidate decides on every request,
  its decision is logged, and production behaviour is unchanged. Maestro implements it for
  classification. This plan extends it to the routing decision itself (§27.3).
- **Wilson score interval**: a binomial confidence interval that behaves at small n and at 0% or
  100%. **Beta-binomial**: a posterior per cohort × route with a weak prior, which stays wide
  (and so defers to the rules) when data is thin. **Thompson sampling** would explore
  under-sampled routes, and is **rejected** for real work (§20.4).
- No surveyed system combines shadow routing with interval-gated policy changes for coding
  agents. The closest is Maestro's learned hints, with flat thresholds.

---

## 7. Verdicts at a glance

| Idea | Source | Verdict | Where |
|---|---|---|---|
| Layered, tightening router with reasons | Maestro | Adopt | §9.3 |
| Tier independent of effort | Claude Code, Codex, Aider | Adopt (Maestro lacks it) | §6.4 |
| Deterministic-first assessment, LLM for the rest, shadow first | Maestro | Adapt | §8 |
| Clamp what an LLM alone can change | Maestro | Adapt (inverted: the model can't *lower* risk or pick `basic` alone) | §8.3, §9.3 |
| Kind floors and ceilings | Maestro workload roles, Claude subagent pinning | Adopt | §9.3 |
| Named modes | Maestro | Adopt as strategies and exclusions | §10.2, §21 |
| Retry vs escalate | Maestro, OpenHands | Adopt | §15 |
| Hard caps; no retries into a quota wall | OpenHands, SWE-agent | Adopt | §15.3 |
| Fails-before / passes-after tests | SWE-agent | Adopt | §14.1 |
| Separate verification pass | Anthropic research post | Adopt | §14 |
| Human accept/reject in telemetry | Maestro | Adopt | §16.2 |
| In-memory DAG state | Maestro | Reject | §23 |
| Snapshot + write-ahead + event log | LangGraph, Temporal (lightly) | Adopt | §23 |
| Serialised integration | Conductor practice | Adopt | §13.3 |
| Scope-overlap scheduling | none (a gap) | Build, and measure | §13.4 |
| Learned strong/weak routers | RouteLLM | Defer | §20, §21 |
| Hosted routers as dependencies | NotDiamond, Martian | Reject | — |
| Beta-binomial / Wilson gating | statistics | Adopt for later | §20 |
| Random exploration | bandits | Reject on real work | §20.4 |
| Phase-split routes | `opusplan`, Aider | Defer | §32 |
| Session stickiness | Maestro | Adopt (continue-session retries) | §15.2 |
| Per-runtime capability probing with provenance | the local-server survey | Adopt | §19 |

# Qwen local model eligibility: Codex and Claude Code routing, 2026-09-30

Status: audit findings for #103/#104. As-built snapshot: probed and qualification-measured facts for Qwen2.5-Coder-7B and Qwen3.5-4B on Apple Silicon via `mlx_lm.server`, tested through Codex (Responses wire; Claude Code path not built, §19.6). This document records empirical eligibility and distinct routing rejection reasons for both models, separates what is fixed by configuration from product gaps, and defines whole-task vs assignment-level routing. Reference: `docs/plans/intelligent-orchestration.md` §19.

---

## Executive summary

- **Qwen3.5-4B** qualifies for agentic routing through Codex once a context window is declared (measured 32,768). Completes deterministic code work, passes structured-output tests, and works through deterministic edit tasks, given enough working space. Tool calling: reliable (measured 10/10); structured output: JSON 20/20. Suitable for read-only analysis, structured edit tasks on bounded files, and tests that verify by output. **Not suitable:** tasks with iterative exploration, wide scope, or human feedback loops (permission requests hang the agent).
- **Qwen2.5-Coder-7B** does not qualify for agentic Codex routing: tool calls fail (measured 0/10, writes as text `<tools>…</tools>` instead of JSON). Suitable for **structured completions only** (`chat/completions` over `RoutedCompletion`): assessment, verification verdicts, code review, plan repair. Faster than Claude on local hardware (~25 tok/s vs 54 for the 4B); never blocks, so preferred for completions. **Not suitable:** agent loop work.

---

## Eligibility matrix

Each row is a (model, harness, workload) combination. "Measured" facts come from `mlx_lm.server` 0.31.3 on Apple M5 Pro (§19.6, §19.7.1 live check setup). Route: expected choice when eligible and other policies allow. Blocker codes: routing rejection reason (`src/orchestration/policy/resolver.ts` hardFilter).

### Qwen3.5-4B on Codex (/v1/responses)

| Workload | Suitable | Route | Evidence | Blockers if not | Notes |
|---|---|---|---|---|---|
| Read-only evidence gathering | Yes | local:qwen / codex / standard | 10 tool calls (get_weather) 10/10; round trips 10/10 (read_file) | `unqualified-harness` if not qualified; `unhealthy-endpoint` if down | Probe-bounded: 5 calls, then continues; no edit risk |
| Structured analysis (JSON schema) | Yes | local:qwen / codex / standard | 20 JSON outputs 20/20, strict JSON schema pass | `unknown-capability` if structuredOutput not measured | Single-turn queries; no tools needed once output schema proven |
| Deterministic edits (fixes, refactors) | Yes | local:qwen / codex / standard | Qualification fixture: 4-bug fix 6/6 pass (§19.6, §19.7.1); tests untouched; diff in allowed paths | `missing-context` if scope > window (32k measured); `unqualified-harness` if probed but not measured agentic | Context window is hard floor; multi-file edits must fit. Tests must be verifiable without agent re-reads. |
| Test writing / code generation | Yes (bounded) | local:qwen / codex / standard | Fixture verifies by running `node test.js`; output parsing works | `missing-context`; `policy-cap-tier` if capped below standard | Verifiability: deterministic output, not agent judgment. Scope must be <6k tokens per file. |
| Documentation updates | Yes (bounded) | local:qwen / codex / basic | Tool calls work; schema validation works; throughput ~54 tok/s | `unknown-capability` if vision needed (declared unknown) | Markdown, config, CHANGELOG OK. No loops; verification by parse only. |
| **Not suitable** | — | — | — | — | Requires permission requests (agent hangs, permission hook fires but has nowhere to route); iterative search or user feedback. |

### Qwen2.5-Coder-7B: completion-only (chat/completions)

| Workload | Suitable | Route | Evidence | Blockers if not | Notes |
|---|---|---|---|---|---|
| Read-only analysis | Yes (completion) | local:qwen / completion / basic | Tool call test: 0/10 parseable; reverted to JSON instruction + validation | Agentic: `unqualified-harness` (tool-calling 'none'); completion: always admitted | Instruction-based JSON (§19.6 measured 20/20 on Qwen3.5-4B, not separately tested on 7B; assume similar). |
| Structured assessment (JSON) | Yes (completion) | local:qwen / completion / basic | No agentic qualification, but `RoutedCompletion` falls back to instruction + validation; `response_format: json_schema` not supported by this runtime | Agentic: `unqualified-harness`; completion: ok if no schema | `LocalStructuredCompletion` validates against schema if `response_format` fails. |
| Verification verdict (review) | Yes (completion) | local:qwen / completion / basic | Read-only model input; no tool calls; prompt instructs binary judgment | N/A: completions never blocked for capability | Typical use: assessor, plan validator, review verdict. |
| Plan repair | Yes (completion) | local:qwen / completion / basic | Deterministic JSON repair of planner output; no file edits | N/A | One-shot instruction-and-validate, never a loop. |
| **Code generation / fixes** | No | — | Tool calls fail (text output, not JSON); agent loop needed | `unqualified-harness` / agent attempt | No agentic path exists; RoutedCompletion offers completion fallback. |

---

## Configuration-only remedies

These changes are in `orchestration.localEndpoints` and `orchestration.models[<source>:<id>]` settings, no code changes needed.

| Problem | Symptom | Remedy |
|---|---|---|
| **Unknown context window** | Resolver rejects: "local context window is unknown; probe or declare it" (blocker: `unknown-capability`) | Declare in Preferences → Orchestration → [endpoint] → [model], `contextWindow: 32768`. Probe again if available (Settings → Probe). |
| **Unknown tool calling** | Resolver rejects: "tool calling not measured yet; run its qualification" (blocker: `unknown-capability`) | Run Preferences → Orchestration → [endpoint] → [model] → Qualify (stage 1). Probes 10 tool calls, 10 round trips, 20 JSON. |
| **Tool calling measured `none` (completion-only)** | Resolver rejects agentic: "its tool calls do not parse (completion only)" (blocker: `unqualified-harness`); completion OK | This is correct per §19.6: the model cannot do agentic work. Use `RoutedCompletion` for assessment/review/plan-repair tasks instead. |
| **No `/v1/responses` endpoint** | Resolver rejects Codex: "codex needs its native endpoint route" (blocker: `policy-pin`? or not-qualified) | **Product gap** (§19.6): the runtime does not serve `/v1/responses`. Only completions available. See next section. |
| **No `/v1/messages` endpoint** | Resolver rejects Claude Code: "claude needs its native endpoint route" | **Not built** (§19.6): Claude Code path requires per-process `ANTHROPIC_BASE_URL` env and reports false cost/window. Incomplete. |

---

## Blocker codes for routing audit

Each rejection carries a distinct blocker code (`ResolverCandidate.blocker`) for programmatic filtering and audit:

| Blocker | Meaning | Example rejection | Remedy |
|---|---|---|---|
| `missing-context` | Context window (known) is too small for the task | "coder · Box: context 32k < needed 100k" | Break task into smaller scopes, or use a larger model |
| `unknown-capability` | Capability unknown: not reported, not probed, not declared | "coder · Box: tool calling not measured yet" | Probe or declare the capability in Preferences |
| `unhealthy-endpoint` | Endpoint down, no response, or no free slots | "coder · Box: endpoint stopped" or "every server slot is busy" | Restart endpoint, or wait for a slot to free |
| `unqualified-harness` | Model qualified for a different harness, not this one | "coder · Box on codex: has not qualified through codex" | Run qualification for this harness, or use a model that qualifies |
| `policy-pin` | User pinned a different dimension (harness, source, model) | "coder · Box: the harness is pinned to claude-code" | Change the pin, or remove it |
| `policy-exclusion` | Source, harness, or local models excluded by policy | "coder · Box: local models are off" | Enable local models, or un-exclude the source |
| `policy-cap-tier` | Model tier exceeds the mission/task cap | "coder · Box: standard is above the basic cap" | Raise the cap, or use a lower-tier model |
| `policy-cap-usage-window` | Usage window at or above admission threshold | "claude · Opus: usage window 97% (admits below 95%)" | Wait for the usage window to reset (cannot run) |
| `tier-mismatch` | Model tier is above/below the assessed need | "coder · Box: standard is below the required expert" | Upgrade to a higher-tier model, or accept the model |
| `unsupported-location` | External (non-loopback) endpoint in local-only mission | "hosted-coder: the mission is local-only" | Change mission cap to allow hosted, or use a local model |

---

## Whole-task vs assignment-level eligibility

### Whole-task routing

A task is routed end-to-end by the resolver: task → assessment → route requirement → catalog + health snapshot → ExecutionTarget (harness × model × effort).

**Where eligibility is checked:**
1. **Router** (pure): reads assessment + policy, emits `minTier`, `maxTier`, `effort`, hard `needs` (e.g., tools, vision, context). Policy: pins, caps, preferences, exclusions.
2. **Resolver** (pure, with snapshot): filters candidates by hard needs (tool calling, context, health, qualification), ranks by tier fit + preferences, picks the best.
3. **Verification guards** (after start): gates like `plan-first` (e.g., for `open-ended` ambiguity) or `human-review` (for critical risk). These block a task *before* assessment, not *after*.

Outcome: `resolved` (target chosen), `blocked` (capacity will free up), `needs-human` (policy allows nothing).

### Assignment-level routing (future, #105/#106)

An attempt on a task may split into smaller assignments (substeps, subtasks) whose eligibility must be checked independently, since each brings:
- Its own context stack (inherited from parent's context + turn history)
- Its own subset of tools (e.g., edit only, no shell)
- Its own parallelism slot

**What an assignment resolver would need:**

| Input | Rationale |
|---|---|
| Parent task's `RouteRequirement` | Base: tier, effort, hard needs (tools, vision), gates |
| Assignment's incremental context | Estimate how much working memory this step uses (docstring, code excerpt, edits-so-far); may differ from whole task |
| Assignment's tools subset | E.g., `['edit']` not `['edit', 'shell']`; check harness supports them; check model qualifies for each tool if local |
| Parent task's `ExecutionPolicy` (pins, caps, preferences, exclusions) | Inherited and frozen; pins never change; caps only tighten |
| Parent task's `CatalogSnapshot` | Same as the task's, recorded at routing time; no re-probing |
| Current endpoint health + slots | Recheck at assignment time: endpoint may have gone down, or slots freed |

**Distinct eligibility checks:**

1. **Hard needs:** Does the harness support all tools the assignment uses? Does the model qualify (via measured probe or declaration)?
2. **Context fit:** Given assignment's context need (estimated from scope), is the window known and large enough? (No assumption for local models.)
3. **Availability now:** Is the endpoint still reachable? Are there free slots?
4. **Policy compliance:** Do the parent task's pins and caps still hold? (Always yes unless the parent's policy changed, which frozen snapshots prevent.)

**Proposed outcome:**

- `can-assign`: target is still eligible; the assignment can start on it.
- `blocked`: target was eligible but is now down or out of slots; wait for capacity.
- `needs-parent`: the assignment cannot proceed without the parent's policy changing (e.g., the pin is no longer suitable, or a new harness capability is needed).
- `needs-split`: the assignment's context exceeds the window; split further.

---

## Product gaps and dependencies

### Claude Code path (#51, not built; §19.6)

**Status:** Prototype on `spike/local-models` branch (2026-09-25) works (5/5 qualification), but:
- Requires per-process env `ANTHROPIC_BASE_URL`, not session-scoped. Session hosts make this hard: each host would need its own env.
- Invented cost ($0.08–$0.43/run, priced as hosted). Telemetry would mislead.
- ~13× slower per-call latency than Codex on this hardware (21 s median vs 1.6 s).

**Unblock:** Wait for a local runtime serving `/v1/messages` natively with prefix-cache persistence across turns (§19.6 point 2). Current workarounds (translator between `chat/completions` and Messages) add fidelity risk.

### `/v1/responses` unavailable on the runtime

**Status:** Both MLX and vLLM lack the Responses wire. Codex works through Responses only.

**Workaround:** Use completions-only path for assessment, review, planning. Agentic work waits.

**Fix:** Negotiate support with runtime projects, or build a thin Responses → `chat/completions` adapter (not AW's responsibility, per §19.6 point 2).

### Qualification stage 2 (task fixtures, §19.6, #104)

**Status:** Built, in `LocalEndpointService.qualifyTasks`. Runs 3–5 scratch repos with seeded bugs (k=3 times each), measures pass rate and tokens.

**Caveat:** These are *measured facts*, not *proof of general competence*. A model that passes 3-fixture qualification can do *those* fixtures. Tier assignment is still the user's choice. (§6.3: tier is policy, not a model property.)

---

## Verification and calibration

### Test fixtures

| Fixture | Purpose | Pass criteria |
|---|---|---|
| Qualification stage 1 (probe): 10 tool calls | Tool calling works? | 10/10 calls match the schema |
| Qualification stage 1 (probe): 10 round trips | Tool result handling works? | 10/10 responses include expected value from tool result |
| Qualification stage 1 (probe): 20 JSON | Structured output works? | 20/20 validate against provided schema |
| Qualification stage 2 (tasks): 4-bug fix | Can it edit code and verify? | `node test.js` exits 0; test file untouched; diff in allowed paths |

### What qualification does **not** measure

- Reasoning quality (does it understand *why* a fix is correct?)
- Generalization (does it transfer to unfamiliar code?)
- Iterative debugging (can it understand a test failure and recover?)
- Context reuse (does it remember earlier edits in the same task?)
- Perplexity or code smell detection (subjective model judgment)

Use qualification to answer: *"Can this model execute its harness's tools correctly?"* Not: *"Is this model a good coder?"*

---

## Routing decisions: recorded and explainable

Each `RouteRecommendation` captures the full decision:

```ts
{
  requirement:       { minTier, maxTier, effort, needs, gates },
  reasons:           [{ id: 'rule-name', at: 'tier'|'effort', text }],
  verdict:           'route' | 'blocked' | 'needs-human',
  resolution: {
    target:          { harness, source, model, tier, effortNative, location },
    candidates: [
      { target, verdict: 'chosen'|'fallback'|'rejected', reason, blocker? }
    ]
  }
}
```

For Qwen models:

| Decision | Target | Reason | Blocker if rejected |
|---|---|---|---|
| Use Qwen3.5-4B for edits | `codex / local:qwen / standard` | "best fit; context window..." | `missing-context`, `unqualified-harness`, `unhealthy-endpoint`, `policy-*` |
| Use Qwen2.5-Coder-7B for review | `completion / local:qwen / basic` | "best fit; fastest completion" | `unhealthy-endpoint` (completions rarely blocked) |
| Fall back to Sonnet | `codex / anthropic / standard` | "no local model available (no /v1/responses endpoint)" | `unqualified-harness` (Qwen2.5 is completion-only) |

**Why each blocker matters:**

- `unqualified-harness`: Configuration gap (probe/declare). Actionable: run qualification.
- `missing-context`: Scope issue. Actionable: narrow scope or ask for a larger model.
- `unhealthy-endpoint`: Transient. Actionable: restart endpoint or wait.
- `policy-*`: User's call. Actionable: relax cap/pin/exclusion.

---

## Summary for #103/#104 acceptance

1. ✅ **Eligibility matrix:** Qwen3.5-4B qualified for Codex; Qwen2.5-Coder-7B completion-only. Per model, per harness, per workload.
2. ✅ **Admission/rejection reasons:** Distinct blocker codes for programmatic routing audit.
3. ✅ **Qualification caveat:** Tool/protocol qualification is not general competence.
4. ✅ **Configuration remedies:** Separate section; live settings not modified.
5. ✅ **Whole-task vs assignment:** Defined; assignment resolver inputs listed for #105/#106.
6. ✅ **No secrets or real paths:** Fixture directory names redacted; device names generic.

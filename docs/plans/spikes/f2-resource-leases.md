# Spike F2: how an agent acquires an exclusive resource lease

Issue: hammonjj/AgentWrangler#23. Playbook refs: `session-lifecycle-architecture.md` §6, §6.1,
§13 follow-up F2. Orchestration refs: `intelligent-orchestration.md` §1.3 (ask A5), §13.5.
Date: 2026-09-24.

## Verdict

**Go, with the hook as the request surface. No MCP tool yet, and no convention.**

- **The agent does not ask for a lease; its tool call is the request.** A resource is declared
  once, as "tool calls that match these patterns need lease *K*". An AW `PreToolUse` hook
  acquires *K* before a matching call runs, waits a bounded time if another session holds it,
  and denies the call with a readable reason if the wait runs out. It never needs the agent to
  remember anything, and it covers every Claude session on the machine: terminal, in-process
  and hosted.
- **The lock of record is a lease file, not a registry field.** It is created atomically, so
  the hook can grant and refuse while the core is down. That is a normal state now (⌘Q leaves
  agents running), and for one of the two motivating resources it is the *only* state that
  matters: `npm run app:install` quits the core, so the core is down for exactly the stretch
  the lease has to protect.
- **The core's `LeaseService` owns policy, not the lock.** It declares the resources, reaps
  leases whose holder is gone, releases them on registry transitions, shows the chips, lets
  James force a release, and lets the orchestration scheduler hold a lease *before* a session
  exists (ask A5).
- **An AW MCP tool is deferred.** Its one real advantage, a lease the agent holds across turns
  on purpose, is not needed by either motivating case, and it costs a host→core call path, a
  core socket that does not exist yet (#21), and it only works while the core is up.
- **A convention is rejected as a mechanism.** CLAUDE.md's "only one agent runs
  `npm run app:install` at a time" *is* the convention, and it cannot be seen, checked or
  cleaned up after a crash.

## Method

Claude Code 2.1.236 (`/opt/homebrew/bin/claude`), `haiku`, a throwaway project under `/tmp` with
a project `settings.json` that registers a probe script on `PreToolUse`, `PostToolUse`,
`PostToolUseFailure` and `Stop` (matcher `Bash`, timeout 3 s). The probe logs each payload, its
`$PPID` and the parent's command name, and behaves according to a marker in the command: sleep
past its timeout, deny, or pass. Codex facts come from
`codex app-server generate-json-schema` on the bundled 26.917 binary. Code facts come from this
tree at `37ea48b`.

## Evidence

1. **A `PreToolUse` hook that times out lets the tool run.** The probe slept 10 s against a
   3 s timeout; the command ran (its marker file exists) and the agent saw normal output. So a
   waiting hook must **deny before its own timeout**, never rely on the timeout to block. A lease
   hook that is killed for any reason fails *open*; this is accepted below.
2. **A deny is clean and readable.** Printing
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
   stopped the command; the agent reported the reason verbatim and carried on. **A denied call
   gets no `PostToolUse` or `PostToolUseFailure`,** so a refused acquire leaves nothing to
   release.
3. **`$PPID` is the `claude` process** (`ps -o comm=` → `claude`), for every hook event, and
   every payload has `session_id`. `PreToolUse` and `PostToolUse` share `tool_use_id`, so a
   release can be matched to its acquire exactly.
4. **Background commands release too early.** With `run_in_background: true`, `PostToolUse`
   fired the same second the command was launched, and `Stop` fired two seconds later while the
   command still had 18 s to run. Neither `PostToolUse` nor `Stop` can end a lease for a
   backgrounded command. The hook therefore **refuses to run a leased command in the
   background** (§Hook, step 3).
5. **Hooks already reach every AW session.** SDK-driven sessions run the user's hooks
   (`agentwrangler-data-sources`, 2026-09-11 spike), and hosted sessions are marked with
   `AGENTWRANGLER_HOSTED=1` (`hookInstall.ts`). AW's installer already merges one entry per
   event into `~/.claude/settings.json` by marker, so a second `PreToolUse` entry is the same
   code path.
6. **The host has no request path to the core.** Protocol v1 is core→host methods plus
   host→core notifications (§9.4–9.5). An SDK MCP server (`createSdkMcpServer`) in the host
   would need a new "host asks core, holds the call across a core restart" path, the way asks
   work. Possible additively, but it is new protocol for a feature that does not need it.
7. **Codex has the same hook events.** The app-server schema's `HookEventName` includes
   `preToolUse`, `postToolUse`, `stop` and `sessionStart`; `thread/start` takes a `config`
   override (MCP servers could be passed there too). Payload compatibility with Claude's is
   **not verified**; see the Codex issue below.

## Options compared

| | **A. AW MCP tool** (`aw_lease_acquire` / `release`) | **B. `PreToolUse` hook** on declared resources | **C. Convention** (CLAUDE.md prose, maybe `mkdir` by hand) |
|---|---|---|---|
| Needs the agent to cooperate | yes: it must call acquire first | **no**: the call itself is intercepted | yes, and nothing checks |
| Terminal sessions | only if James adds the server to his MCP config | **yes** (global hooks) | yes |
| In-process / hosted sessions | needs a stdio server + core socket, or a new host→core call | **yes**, same hook | yes |
| Codex | via `config.mcp_servers` | likely (same event names; payload unverified) | yes |
| Works while the core is down (⌘Q, every `app:install`) | **no** | **yes** (lease files) | yes |
| Lease scope it can express | any, including "the rest of the session" | one command, or one turn | whatever the agent intends |
| Contention UX | tool result: wait or "busy" | bounded wait, then a deny with a reason; visible in AW | none |
| Cleanup after a crash | core reaper | core reaper, plus the hook's own stale-holder check | none: a stale lock blocks forever |
| New surface to build | MCP server, host protocol or core socket | one sh script and one installer entry | none |
| Main risk | an agent that forgets is unprotected | pattern misses an indirect invocation; fails open if the hook is killed | everything |

The hook wins on the two things that matter most here: it does not depend on the agent, and it
works when the app is not running. Its gap, a lease wider than one turn, is covered by the
scheduler holding leases for orchestrated attempts (A5), which is the one caller that needs it.

## Recommended design

### Resources are declared, not requested

```ts
// src/shared/leases.ts (pure types)
export interface LeaseResource {
  /** Stable id: 'aw-app', 'unity-editor'. [a-z0-9-]+ */
  key: string;
  /** What needs it. Anchored-anywhere ERE, matched against the tool input as the hook sees it. */
  match: { bash?: string[]; tools?: string[] };
  /** How the lease key is qualified: one machine-wide lease, one per repository, one per cwd. */
  keyBy: 'global' | 'repo' | 'cwd';
  /** 'command': held for the call. 'turn': held until the session's turn ends (Stop/StopFailure). */
  scope: 'command' | 'turn';
  /** How long a waiting call waits before it is denied. Default 900. */
  waitSec?: number;
  /** Shown in chips and deny messages. */
  label?: string;
}
```

Declared in a global setting (`leases.resources`), and later also per repository in the
orchestration policy's `exclusive` list (`intelligent-orchestration.md` §13.6). Both compile to
the same file the hook reads. This repository's entry, and a Unity one:

```jsonc
[
  { "key": "aw-app", "label": "the installed app", "keyBy": "global", "scope": "command",
    "match": { "bash": ["npm run app:install", "install-app\\.sh", "quit app \"Agent Wrangler\""] } },
  { "key": "unity-editor", "label": "Unity Editor", "keyBy": "repo", "scope": "turn",
    "match": { "bash": ["Unity.*-projectPath"], "tools": ["^mcp__unity"] } }
]
```

`scope: 'turn'` is what makes the Unity case work without a request tool: a run of MCP calls
against one Editor (enter Play Mode, read the console, stop) is one critical section, and no
other session's call can land between them. `mode: 'shared'` (many readers, one writer) is left
out of v1; the type gains it only when a resource needs it.

### The lock of record: lease files

```text
~/.claude/agentwrangler/leases/
  resources.tsv              compiled by the core: key, keyBy, scope, waitSec, kind, pattern
  <key>[@<qualifier>]/       the lease; mkdir(2) is the atomic acquire
    holder.json              {v:1, sessionId?, attemptId?, pid, pidStart, cwd, scope, since, uses?}
    uses/<tool_use_id>       one per running command-scoped call (parallel tool calls)
  <key>[@<qualifier>].reap/  held by whoever is reaping a stale lease
```

- **Next to the hook script**, in the same directory the hook log already uses, so the hook
  needs no configuration beyond `dirname "$0"`.
- **Not `sessions.json`**, although the issue suggested it: `sessions.json` has exactly one
  writer, the core (§10), and the hook must write without it. The registry stays the source of
  truth for *session state*; the reaper reads it. Leases still **key on the session id**
  (`holder.sessionId`), so they survive core restarts and host reattach unchanged.
- The qualifier for `keyBy: 'repo'` is a short hash of `git rev-parse --git-common-dir` for the
  payload's `cwd` (so every worktree of one repository shares the lease); for `cwd`, a hash of
  the path. Computed only after a pattern matched, so ordinary calls never run `git`.
- **Holder liveness** is `pid` + `pidStart` (`ps -o lstart=`), exactly the orphan-sweep rule
  (§7.3): a lease whose pid is dead, or alive with another start time, is stale.
- **Stale reaping** takes `<lease>.reap/` (mkdir), re-reads `holder.json`, and removes the lease
  only if it still names the same dead holder, then removes `.reap/`. Nobody else can replace a
  lease while it exists, so the check under the reap lock cannot be overtaken. A `.reap/` older
  than 30 s is itself stale.

### The hook (`lease-hook.sh`, POSIX sh like `permission-hook.sh`)

Installed as its own `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop` and `StopFailure`
entries (marker `agentwrangler`, no matcher), with `PreToolUse` timeout `max(waitSec) + 60`.

On `PreToolUse`:

1. If `resources.tsv` is missing or empty, exit 0. This is the path almost every call takes,
   and it must stay a few milliseconds.
2. Match `tool_name` against `tools` patterns and, for `Bash`, the `command` against `bash`
   patterns. No match: exit 0.
3. If the call is `Bash` with `run_in_background: true`: **deny** ("Run commands that use
   *label* in the foreground, so the lease ends when they do.") (evidence 4).
4. If the lease exists and `holder.sessionId` is this `session_id`: add `uses/<tool_use_id>`
   (command scope), exit 0. Re-entrant, and it covers parallel tool calls.
5. Otherwise `mkdir` the lease. Success: write `holder.json` (`pid=$PPID`), add `uses/…`, log
   a synthetic `AgentWranglerLeaseAcquired` line to `$PPID.jsonl`, exit 0.
6. Held by someone else: if stale, reap and go to 5. If live, log `AgentWranglerLeaseWaiting`
   once, then poll every 0.5 s for up to `waitSec`.
7. Out of time: log `AgentWranglerLeaseDenied`, **deny** with the holder and how long it has
   held it: "*Label* is in use by another agent session (for 6 min). Do other work and try
   again later, or ask the user." The agent reads the reason and decides (evidence 2).

**It never prints `allow`.** An allow would skip the permission prompt, turning a coordination
hook into a permission bypass. A granted lease exits 0 with no output, and the normal
permission flow runs afterwards; so James is never asked to approve a command that then waits
for a lease.

On `PostToolUse` / `PostToolUseFailure`: remove `uses/<tool_use_id>`; if the lease is
command-scoped, held by this session, and `uses/` is empty, remove it and log
`AgentWranglerLeaseReleased`. On `Stop` / `StopFailure`: release every lease this session holds
with `scope: 'turn'` (and any command-scoped one whose `uses/` is empty).

### Contention: wait, then fail, with James able to intervene

- **Default: wait, bounded.** The turn stalls inside the hook, which is what "one at a time"
  means; `waitSec` bounds it (default 15 min, `aw-app` could be 10).
- **Then fail with a reason**, not silently and not with a modal. A denied agent can do other
  work and retry, or tell James.
- **Ask the user = visible state, not a dialog.** The waiting row shows "Waiting for *label*
  (held by *holder's nickname*)"; the holder's row shows a lease chip. The chip's menu offers
  **Release** (force: the core removes the lease; the holder's command keeps running, and its
  later release is a no-op because the holder no longer matches). The waiting row offers
  **Stop waiting** (the core drops a `cancel` marker the hook polls; it denies at once). No
  modal: a prompt that appears whenever two agents collide would train James to click through
  it.
- **Orchestration:** a lease the scheduler cannot get means the task is `blocked (waiting for
  …)`, never a parallel start (§13.5). The scheduler does not poll the hook; it calls
  `LeaseService.acquire` and gets `held-by`.

### `LeaseService` (core)

```ts
// src/core/leases/leaseService.ts
export type LeaseHolder =
  | { kind: 'session'; sessionId: string }
  | { kind: 'attempt'; attemptId: string; sessionId?: string }; // A5: bound once the session exists

export interface Lease {
  key: string;                 // qualified: 'unity-editor@3f9a1c'
  resource: string;            // 'unity-editor'
  holder: LeaseHolder;
  scope: 'command' | 'turn' | 'session';
  since: number;
  pid?: number; pidStart?: string;
}

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; heldBy: Lease };

export interface LeaseService {
  /** Resources as declared (setting + repo policies), compiled to resources.tsv on change. */
  resources(): LeaseResource[];
  list(): Lease[];
  /**
   * Core-side acquire: never waits. 'session' scope is only reachable from here
   * (the hook grants 'command' and 'turn'). Used by the scheduler before it
   * starts an attempt (holder kind 'attempt', pid = the core's own).
   */
  acquire(resourceKey: string, holder: LeaseHolder, opts?: { scope?: 'session'; cwd?: string }): AcquireResult;
  /** A5: the attempt's session exists now. Rewrites holder.sessionId and pid to the agent's. */
  bind(key: string, attemptId: string, sessionId: string, agentPid?: number): void;
  release(key: string, why: 'holder' | 'session-ended' | 'stale' | 'forced'): void;
  /** James's Release button. */
  forceRelease(key: string): void;
  cancelWait(sessionId: string, key: string): void;
  onDidChange: Event<void>;
}
```

- The files are read with the existing `JsonStore`-style tolerant parsing and watched like the
  hook log; `list()` is a cache.
- **Reaper**, on startup (after the manifest pass in §7.3, so surviving hosts are known) and on
  every registry transition: release the leases of sessions that become `stopped`, `ended`,
  `failed` or `interrupted`, and any lease whose pid is stale. `session` scope ends only here.
- **Unbound attempt leases** carry the core's pid, so a core that dies before binding leaves a
  lease the hook will find stale. A `bindBy` deadline (default 10 min) releases an attempt that
  never produced a session.
- **Chips** come from `list()` joined to rows by `holder.sessionId`; waiting comes from the
  synthetic hook log lines, which the existing tailer already delivers per session.

### What survives what

| | core restart / ⌘Q | `app:install` | host crash | agent exits | logout |
|---|---|---|---|---|---|
| Lease held by a live agent | ✔ (file + live pid) | ✔ | released: stale pid, then reaper | released at PostToolUse / Stop, else stale pid | released: stale pid |
| Waiting call | keeps waiting (the hook needs no core) | keeps waiting | — | — | — |
| Chip | back on relaunch | back on relaunch | gone | gone | gone |

### Security

A lease grants nothing: the hook never allows, it only delays or denies. A same-user process
that forges a lease file can make an agent wait, which it could already do by holding the
Unity project open; it cannot make anything run. So the file channel is acceptable here, unlike
the hosted-session permission decisions, which are deliberately not answerable through files
(§12). The directory is 0700 like the rest of `~/.claude/agentwrangler/`.

### Known gaps, accepted

- **Indirect invocations.** A script that runs `Unity` internally does not match `bash`
  patterns. Declare the script too; the chip makes a missed pattern visible the first time two
  sessions collide.
- **Fails open if the hook is killed** (timeout, crash). The script denies well before its
  timeout, so only a crash reaches this.
- **Sessions started before the hook was installed** are not gated: Claude snapshots hooks at
  session start (existing note in `hookInstall.ts`).
- **No FIFO fairness.** Waiters race on `mkdir` every 0.5 s. With a handful of agents that is
  fine; tickets can be added if starvation is ever seen.

## When to build the MCP tool after all

Build `aw_lease_acquire` / `aw_lease_release` / `aw_lease_status` only if one of these shows
up in practice:

- turn scope is too short: an agent's use of a resource legitimately spans turns (the Editor
  stays in Play Mode while it waits for James);
- agents need to *ask* whether a resource is free before planning around it;
- a resource has no tool-call signature to match.

It would sit on the same `LeaseService` with `scope: 'session'`, and would need a host→core
call path for hosted sessions (evidence 6) and the core socket (#21) for the others.

## Implementation issues

Created 2026-09-24 as #68, #69 and #70.

1. **#68 Exclusive resource leases: lease files, `LeaseService`, and the `PreToolUse` hook.**
   `src/shared/leases.ts`, `src/core/leases/*` (pure: resource compile, file format, stale and
   reap rules, reaper decisions, all unit-tested), `lease-hook.sh` written and versioned like
   `permission-hook.sh`, installer entries, `leases.resources` setting with the `aw-app`
   default off. Includes the `acquire` / `bind` API for A5 with tests, but no scheduler.
2. **#69 Show leases in the table: chips, "waiting for", Release and Stop waiting.** Depends on 1.
3. **#70 Codex: apply the lease hook to Codex threads.** Verify Codex's `preToolUse` payload,
   `postToolUse` pairing and deny output against Claude's; reuse the script if they match.
   Depends on 1.

#47 (overlapping tasks and exclusive resources) consumes issue 1's `acquire` / `bind` and does
not build its own service.

# Agent Wrangler session lifecycle: architecture and migration playbook

Status: proposed 2026-09-23; Stage 0 done and the architecture confirmed at CP0 on 2026-09-24
(§15.1). Stage 1 onwards is not built yet.
Scope: how AW launches, owns, loses and recovers the agent sessions it runs, and how to change
that one stage at a time, keeping the app shippable after every stage.
Tracking: epic [#4](https://github.com/hammonjj/AgentWrangler/issues/4) in the GitHub Project
"Agent Wrangler". Stage 0 issues are #5–#11 (§17).

**Read this first.** The brief assumes PTYs. **AW has no PTY anywhere.** It drives Claude Code
over the Agent SDK's stream-json stdio protocol and Codex over `app-server` JSON-RPC stdio.
Terminal sessions belong to Terminal.app or VSCode, and AW only observes them. The reattachment
question is therefore not "who owns the pseudo-terminal". It is "who holds the pipes and the
SDK's control-protocol state" (§11).

---

## 1. Current architecture

### 1.1 Process topology (observed live with `ps`)

```text
launchd (pid 1)
├─ Agent Wrangler.app  (Electron main; process-group leader)        ← createApp() lives here
│  ├─ renderer: workbench window (dashboard + conversation panes)   ← sandboxed, contextIsolation
│  ├─ renderer: palette, preferences
│  ├─ claude --input-format stream-json --output-format stream-json [--resume <id>]   × N
│  │     (spawned by @anthropic-ai/claude-agent-sdk query(); same process group as the app)
│  ├─ codex app-server --stdio                                          × 1 (all AW Codex threads)
│  ├─ ffmpeg / whisper (dictation, while recording)
│  └─ ps (short-lived: pause state, process table)
└─ Terminal / VSCode … → claude (interactive TUI)       ← external; AW only observes
                           └─ permission-hook.sh (child of claude, polls a decision file)
```

A live `ps` during this investigation showed the app as the direct parent, and the process-group
leader, of four `claude` stream-json children and one `codex app-server`. The `claude` children
used ~120–400 MB RSS each.

### 1.2 Startup: `src/electron/main.ts`

- `app.setName`, `registerBundleScheme()`, `installContextMenuEverywhere()`, then
  `app.requestSingleInstanceLock()`. A second copy quits, because two processes resuming one
  session id corrupt its transcript.
- `whenReady` runs `createElectronHost(...)` (`src/electron/electronHost.ts`), then
  `createApp(host)` (`src/app/createApp.ts`), then `new WorkbenchWindow`,
  `wrangler.attachSurface(window)`, the palette and preferences windows, and the menu. After
  that come `window.open()` and `wrangler.start()`.
- `createApp.start()` starts the usage pollers, registers the Claude and Codex providers, checks
  hook health and syncs the Discord transport. Two seconds later, `resumeLastRunner()` resumes
  **the single most recent** runner session from `RunnerRegistry` (`surface.json`), within 8 h
  and with guards.

### 1.3 Shutdown and cleanup

- `window-all-closed` is **deliberately empty**. Closing the window never quits the app. The
  core keeps running, Dock `activate` reopens the window, and there is no tray.
- `before-quit` is the only teardown: it disposes the windows, then `wrangler.dispose()`, then
  `host.disposeAll()`. There is **no confirmation** when agents are running, no `will-quit`, and
  no `process.on('exit' | 'SIGTERM' | 'uncaughtException')`. (S2: Electron already turns
  SIGTERM into a graceful quit that runs `before-quit`, so the missing SIGTERM handler is not a
  gap in itself; see §11.10.)
- `RunnerService.dispose()` (`src/claude/runner/runnerService.ts`) runs `void s.end()`. That is
  **not awaited**, so the 5 s graceful-exit budget in `RunnerSession.end()` never gets its
  chance on quit. The backstop is the SDK's `process.on('exit')` handler, which SIGTERMs every
  tracked child (verified in the SDK bundle), plus stdin EOF when the parent's pipe ends close.
  **S1 correction:** stdin EOF is a backstop only at idle. Mid-turn the CLI finishes the turn
  first, so a crash or SIGKILL of Electron main leaves the current turn running headless (§11.5).
- `CodexRunnerService.dispose()` runs `CodexAppServer.dispose()`, which is `child.kill()`. That
  ends every Codex thread AW runs.
- `scripts/install-app.sh`, which CLAUDE.md says to run after **every** code change, does three
  things: `osascript -e 'quit app "Agent Wrangler"'`, `sleep 2`, then `rm -rf` on the bundle and
  `cp -R`. **Every install kills every hosted session.** There were ~119 commits in September
  across several agents, so this happens many times a day. An agent hosted by AW that runs the
  install kills itself.

### 1.4 Agent process creation and ownership

| Concern | Claude runner | Codex runner | External sessions |
|---|---|---|---|
| Created by | `RunnerService.start` → `RunnerSession.start` → SDK `query({prompt: InputQueue, options})` | `CodexRunnerService.start/resume/fork` → JSON-RPC `thread/*` on one `CodexAppServer` (`src/codex/appServer.ts`, `runner.ts`) | Terminal / VSCode |
| Spawn | SDK `spawn(binary, args, {stdio: pipes})`. **Not detached**, same process group; `process.on('exit')` → SIGTERM | `spawn(codex, ['app-server','--stdio'], {stdio: pipes})` | n/a |
| Binary | `resolveClaudeBinary`: setting → newest VSCode-bundled → `PATH` (`src/claude/binary.ts`) | `resolveCodexBinary`: setting → newest `openai.chatgpt-*` bundle (`src/codex/binary.ts`) | n/a |
| Ownership record | in-memory `Set<RunnerSession>`, plus `RunnerRegistry` in `surface.json` `{sessionId, cwd, lastShownAt}` | in-memory `Map<threadId, CodexRunner>` only | none; ownership is decided by session id, never by pid |
| Input | `InputQueue<SDKUserMessage>` → stdin NDJSON | `turn/start` | n/a |
| Output | SDK iterator → `reduceRunnerMessage` → `ConvBlock` append/patch | notifications → `CodexRunner.onNotification` → blocks | transcript tail (`TranscriptSource`) |

Note the existing split in Codex. `CodexAppServer` is pure execution and transport, and
`CodexRunner` is pure translation. Claude's `RunnerSession` fuses the two. §5 builds on that
observation.

### 1.5 Session state and persistence

- **Live, in the heap of the Electron main process:** `RunnerSession.blocks` (≤2000), `composer`,
  `pending` asks (the `canUseTool` resolvers), history, interrupt timers, the SDK `Query`.
  `CodexRunner` holds blocks plus `pendingApprovals` and `pendingQuestions` keyed to RPC ids.
- **Durable, owned by the providers:** transcripts (`~/.claude/projects/…jsonl`, Codex rollouts).
  *A conversation is its transcript* (`docs/product-context.md` §5, principle 3), so resuming the
  same id continues it (verified, `docs/plans/conversation-pane.md` §2.2).
- **Durable, owned by AW, under `~/Library/Application Support/Agent Wrangler/`, all JSON via
  `JsonStore` with atomic writes:** `settings.json`, `state.json` (archive, sections, pins,
  nicknames, columns, turn stats, hidden projects), `surface.json` (the runner registry),
  `window.json`, `secrets.json` (safeStorage ciphertext, 0600) and `cache/usage*.json`.
- **Durable, for remote control:** `~/.cache/agent-wrangler/remote/mirrors.json` and `audit.log`.
- **Hook rendezvous:** `~/.claude/agentwrangler/<pid>.jsonl`, `requests/<id>`,
  `decisions/<id>.json`.

### 1.6 Projects, worktrees, git

- **Projects** are a derived list (`src/claude/projects.ts` `ProjectsService`). A project is not
  an entity with an owner.
- **Worktrees:** detection only (`src/core/worktree.ts` `worktreeFor`), shown as a column. AW does
  no git coordination. Keeping agents from committing each other's work is procedural: CLAUDE.md
  ("Branches and worktrees") and `AGENTS.md`, which points non-Claude agents at it.
  `docs/product-context.md` §7 lists "cross-session awareness" as a known gap.
- **Unity / resource leasing:** does not exist anywhere in the repo.

### 1.7 Providers and adapters

- `AgentProvider` (`src/core/provider.ts`) is **monitoring only**. `ClaudeProvider` reads the
  registry (`~/.claude/sessions/<pid>.json`, including SDK sessions with `entrypoint: "sdk-ts"`),
  hook logs (`HookLog`) and transcript tails. `CodexProvider` reads rollouts. **All of this is
  process-independent.**
- The execution side has no common interface. The only shared pieces are the pane-facing
  `ConversationSource` (`src/ui/conversation/source.ts`) and the `RunnerOwnership` facade built
  in `createApp`.

### 1.8 Permissions: three independent paths

1. **Hook marker.** Covers every Claude session, external and runner. `permission-hook.sh`
   (`src/claude/hookInstall.ts`) is a child of `claude`, **not of AW**. It writes
   `requests/<ppid>-<pid>` and polls `decisions/<id>.json` for ~28 min. `HookLog.decide` writes
   that file, and any process can do it. A hook decision beats a pending `canUseTool` (verified,
   `docs/plans/remote-agent-control.md` §0.1). **This path already survives AW restarts.** The
   dashboard and Discord answer *every* Claude permission this way today
   (`actions.decidePermission` → `provider.decidePermission`), runner sessions included.
2. **`canUseTool`** (Claude runner only). Permissions, `AskUserQuestion` and `ExitPlanMode`
   resolve a promise in `RunnerSession`'s heap. Questions and plans have **no file path**.
   Known latent bug #1: a permission answered through the hook leaves the `canUseTool` card
   showing "pending" (`remote-agent-control.md` §0.1).
3. **Codex server requests.** `*requestApproval` and `item/tool/requestUserInput` are JSON-RPC
   requests from `app-server`, answered by RPC id.

### 1.9 Notifications and remote control

- In-app only: `dialogs.info` message boxes for waiting, done and blocked (`notifyOnWaiting`), and
  `flash` toasts. There is no Electron `Notification`, tray or dock badge. *(Superseded by
  Stage 6, #18: `HostServices.notify` → Electron `Notification`, and `src/electron/tray.ts`.)*
- `RemoteControlService` (`src/remote/service.ts`) is a **reconciler** over a decorated snapshot
  (`DecoratedSessions`, `src/core/sessionView.ts`). It persists only the mirror map
  (`src/remote/mirrorStore.ts`) and an audit log. It can call only `decidePermission`,
  `answerQuestion` and `decidePlan`. Discord code stays under `src/remote/discord/**`. The token
  lives in Electron `safeStorage` (`src/electron/secrets.ts`), which works **only inside an
  Electron app process**.
- The leader lease was cut because the single-instance lock makes contention unreachable
  (`remote-agent-control.md` §6). §6 also records where it hooks back in: `service.setTransport`.

### 1.10 IPC in use today

| Link | Mechanism |
|---|---|
| renderer ↔ main | `ipcMain`/`ipcRenderer` envelopes `{pane, body}` (`src/electron/channels.ts`, `preload.ts`); messages in `src/shared/messages.ts`. The conversation gets an `init` snapshot, then `append`/`patch` deltas. `EnvelopeTransport` (`src/ui/paneChannel.ts`) is already structural. |
| main ↔ claude | SDK stream-json over stdio (NDJSON messages, `can_use_tool` control requests, keep-alives) |
| main ↔ codex | JSON-RPC 2.0 NDJSON over stdio |
| claude ↔ AW (hooks) | filesystem rendezvous (`~/.claude/agentwrangler`) |
| main ↔ Discord | gateway WebSocket + REST, outbound only |

### 1.11 UI assumptions that require same-process agents

- `RunnerSource` (`src/ui/conversation/runnerSource.ts`) holds a live `RunnerSession` and
  subscribes to its `Emitter`s. Its getters (`canSend`, `composer`, `blocks`) are synchronous.
- `RunnerOwnership.owns / pendingQuestion / pendingPlan` are **synchronous** and are called
  inside `DecoratedSessions` and `remoteAskFor` (`src/shared/remote.ts`).
- `SessionActions.answerQuestion` and `decidePlan` say that only the process holding the promise
  can answer (`src/ui/actions.ts`).
- `createApp`'s `adoptSession`, `confirmAndCloseSession`, `release` and `resumeLastRunner`
  construct and end `RunnerSession`s directly.
- `ConversationHost.swapSource` (`conversationHost.ts`) picks its binding with an in-process
  `runners.get(sessionId)`.
- `adoptSession` would `endProcess` any live pid it does not `own`. After a restart, that
  includes AW's own surviving sessions, which is the hazard §7.3 closes.

### 1.12 Crash recovery today

Recovery is kill + `--resume`, and **only the newest** runner session auto-resumes
(`RunnerRegistry.resumable()`). Every other session shows as Ended and has to be taken over by
hand. The following are always lost:

- in-flight turns;
- running tool subprocesses;
- CLI background tasks and session crons (`background_tasks` and `session_crons` in the SDK Stop
  hook input);
- pending questions and plans.

The 90 s transcript-mtime guard in `resumeLastRunner` is a heuristic, not a lock.

### 1.13 macOS specifics in play

- There is no parent-death signal, and orphans reparent to launchd.
- Children that are not detached share the app's process group.
- Ad-hoc signing (`identity: "-"`) gives a new cdhash every build.
- There is no LaunchAgent, login item or auto-update.
- Logout ends every user process, and sleep suspends every process.
- The hook script's 28-minute budget counts poll iterations, so it pauses during sleep.
- The macOS socket path limit (`sun_path`) is 104 bytes.

---

## 2. Current lifecycle and ownership diagram

```text
                 owns / lifetime-bound-to  ───►
Application (Electron main)  ◄── launchd; dies on Cmd-Q, crash, app:install
 ├─► Window/UI (renderer)          window close ≠ quit (intentional); renderer crash: no handler
 ├─► Session [AW-run]              in-memory RunnerService Set / CodexRunnerService Map  ◄ ACCIDENTAL
 │     ├─► Agent process (claude)  child, same pgid, stdio pipes, SDK exit-kill       ◄ ACCIDENTAL
 │     ├─► Permission / question / plan ask   heap promise                             ◄ ACCIDENTAL
 │     └─► Conversation (transcript) owned by the CLI; survives everything             ◄ INTENTIONAL
 ├─► codex app-server (all AW Codex threads)                                           ◄ ACCIDENTAL
 ├─► Project list   derived, no owner                                                  (n/a)
 └─► Worktree info  detected only; the worktree is owned by git and the user           (n/a)
PTY                 none in AW. Terminal sessions' PTYs belong to Terminal/VSCode
Agent process [external]    owned by its terminal/editor; AW may signal it (pause/close/adopt)
Permission ask [hook]       permission-hook.sh (child of claude) + marker files         ◄ INTENTIONAL
Discord mirror              mirror file + reconciler; survives restarts                  ◄ INTENTIONAL
```

| Entity | Owner today | Ends when | What survives | Coupling |
|---|---|---|---|---|
| Application | launchd / user | quit, crash, install | JSON state files | — |
| Window/UI | Electron main | close (hidden), quit | `window.json` | **Intentional**: close ≠ quit |
| AW-run session | Electron main heap | app exit | transcript + one `surface.json` record | **Accidental** |
| Agent process | Electron main (child) | app exit | nothing | **Accidental** (SDK default spawn) |
| codex app-server | Electron main (child) | app exit | rollouts | **Accidental** |
| PTY | — | — | — | none exists |
| Project | derived | — | Claude history, hidden list | none |
| Git worktree | git / user | user removes it | everything | none (detection only) |
| Permission ask (hook) | claude → hook script | answered, or ~28 min | marker files | **Intentional**: already decoupled |
| Question / plan / canUseTool ask | `RunnerSession` heap | app exit | nothing | **Accidental** |
| Single-instance lock | Electron | quit | — | **Intentional**: one writer per transcript |

---

## 3. Problems with the current coupling

1. **Every install kills every hosted agent.** Development of AW interrupts the agents developing
   AW, including the one running the install.
2. **An app crash is a fleet crash.** There are no crash or signal handlers, and the children
   are not detached.
3. **Recovery is partial.** Only the newest session auto-resumes. In-flight turns, tool
   subprocesses, CLI background tasks and pending questions and plans are always lost.
4. **Quit is silent and not actually graceful.** There is no prompt, and `void s.end()` skips
   the flush.
5. **Asymmetry.** Hook-backed permissions survive restarts. Runner questions and plans do not.
6. **Codex is a single point of failure.** One child serves every AW thread.
7. **The UX principle is shaped by the defect.** "Quitting ends the live sessions it hosts, so
   the app never restarts itself" (`product-context.md` §5, principle 1).
8. **Orchestration cannot run without the Electron app.** This is acceptable only because
   closing the window does not quit.

**Preserve these:**

- window close ≠ quit;
- the renderer isolated from main;
- the single-instance lock;
- conversation = transcript;
- the file-based hook path;
- reconcile-from-live-state remote control;
- Discord reaching only `SessionActions`.

---

## 4. Candidate architectures

- **A. Current.** Electron main owns everything.
- **B. Persistent daemon.** A headless daemon owns orchestration *and* the agent processes.
  The UI is a client.
- **C. Daemon + per-session hosts.** A daemon orchestrates. Small host processes each own one
  agent and outlive the daemon.
- **D. Thin hosts + Electron core (recommended).** Survivable per-session hosts own *execution
  only*. The Electron main process stays the orchestrator ("core") and learns to run windowless.
  A separate UI/core process split is gated and probably never needed.
- **E. First-party supervisors.** Codex's `codex app-server daemon` (with `--listen unix://`,
  `proxy --sock`), and Claude's `--bg` background agents (`claude agents`). AW would be a client
  of each.
- **F. PTY multiplexer (tmux/screen) around TUIs.** Rejected. It discards the structured
  protocols that permissions, questions, plans and blocks depend on, and needs screen-scraping.

### 4.1 Comparison

| Criterion | A current | B daemon owns agents | C daemon + hosts | D thin hosts + Electron core | E first-party |
|---|---|---|---|---|---|
| Crash isolation | none | UI isolated; a daemon crash kills all | per-session | per-session; a core crash kills none | per provider |
| Update behaviour | every install kills all | **daemon updates kill all**, and the daemon holds the most-churned code | core updates free | core updates free; the host is thin, so drift is small | vendor-controlled (`daemon update` "may interrupt running work") |
| Session recovery | kill + resume newest | reattach after UI restart only | reattach after any core restart | same as C | depends on the protocol (spike) |
| Pipe ownership | app | daemon | host | host | vendor |
| Buffering, no client | n/a | daemon | host | host (raw SDK messages, byte-bounded) | vendor |
| Permissions | heap + hook | daemon heap + hook | host heap + hook | host holds resolvers; the core decides | vendor |
| Impl. complexity | — | high (headless host, secrets, UI RPC) | highest (two boundaries) | medium (one boundary; core untouched) | low for Codex, unknown for Claude |
| Debugging | easy | medium | hard | medium (one hop, NDJSON) | opaque |
| Orphans | none | few | hosts can orphan | same as C; GC + orphan-claude sweep | vendor |
| macOS | trivial | LaunchAgent; safeStorage lost | as B + hosts | detached hosts; safeStorage kept | depends |
| Windows/Linux | same | UDS → named pipe | same | same | vendor |
| CLI | no | natural | natural | core socket in Electron main | partial |
| Discord while "UI closed" | yes (window closed) | yes, even fully quit | yes | yes while the core runs; windowless mode makes that the norm | unchanged |
| Testing | unit | + RPC | + RPC + processes | + host process tests | vendor |
| Packaging | done | new entry + LaunchAgent | new entries | one esbuild entry + runtime clone | none |
| Back-compat | — | big bang | big bang | incremental, behind a setting | per provider |

### 4.2 Why not B or C first

- **B moves the problem instead of solving it.** `app:install` restarts whatever process holds
  the changed code, and the code that changes is core and UI (`createApp.ts`: 22 September
  commits; `src/ui`: 50; `src/webview`: 64). A daemon holding that code restarts just as often.
- **Only runner heaps can't survive a restart.** Everything else in `createApp` already does:
  mirrors are on disk, pause state is OS process state, usage is file-cached, hooks are files.
- **The Electron main process already behaves like a daemon** relative to its windows.
- **C adds a second boundary for two benefits:** "orchestration while fully quit" and "a CLI with
  no app". A windowless Electron core (Stage 6) gives most of the first, and a core socket
  served by Electron main gives the second. Both keep `safeStorage`.

---

## 5. Recommended architecture

**D: thin, survivable per-session hosts that speak the provider's native protocol. The core
(Electron main) owns all translation and policy, and learns to run windowless. Codex gets an
AW-owned, detached, shared `app-server` listening on a Unix socket (S4 ruled out Codex's own
daemon). A separate UI/core process split is a gated Stage 7 that may never be needed.**

**Confirmed at CP0 (2026-09-24), with amendments; see §15.1.**

```text
             ┌──────────── Agent Wrangler.app — Electron main = AW Core (windowless-capable) ───────────┐
 renderer ◄─►│ SessionStore · providers · HostSupervisor · SessionRegistry · RunnerView reducers        │
 windows     │ RemoteControl/Discord · PauseService · usage · projects · notifications · leases (later)  │
 (ipcMain)   └──────┬───────────────────────┬──────────────────────────┬─────────────────────────────────┘
                    │ UDS NDJSON JSON-RPC   │ (SDK-native messages)    │ WebSocket over UDS, JSON-RPC (Codex-native)
                    ▼                       ▼                          ▼
          aw host (session A)      aw host (session B)       codex app-server --listen unix://…
          SDK Query + asks +        SDK Query + asks +        (all AW Codex threads; AW-owned,
          raw message ring          raw message ring           detached, pinned binary copy)
            └─ claude (stdio)         └─ claude (stdio)
  Every host is detached (own session and pgid, parent = launchd) and runs from a cloned runtime,
  not from /Applications.
```

### 5.1 The key design decision: the host is thin

- **Wrong:** move `RunnerSession` into the host unchanged. `RunnerSession`, `runnerBlocks`,
  `capBlock`, `permissionDetail` and the `ConvBlock` shapes are among the most-changed code:
  `runnerSession.ts` or `src/shared/conversation.ts` changed on 9 of the 11 days with commits
  since 2026-09-10. Hosts live for days. Hosts that rendered blocks would ship stale reducers
  and freeze `ConvBlock` into a cross-version wire type.
- **Right:** the host owns only four things:
  - the SDK `Query` and `InputQueue`;
  - the `canUseTool` resolvers (the pending asks, as raw `{requestId, toolName, input,
    suggestions, title, description}`);
  - a byte-bounded ring of **raw SDK messages** with `seq`;
  - a control passthrough (`interrupt`, `setModel`, `setPermissionMode`, `supportedModels`,
    `supportedCommands`, `getContextUsage`).
- The host answers asks with a raw `PermissionResult` that the core builds.
- The core keeps `reduceRunnerMessage`, history, capping, question and plan parsing, and the
  decide/answer/decidePlan logic, in a core-side `RunnerView`.
- This is **exactly the split Codex already has**. `CodexAppServer` is execution and transport
  and `CodexRunner` is translation. The rule becomes: **a host speaks its provider's native
  protocol, and translation happens in the core.** The wire payload is then Anthropic's SDK
  message schema, which grows additively, not AW's fast-moving `ConvBlock`.
- **Reattach** = transcript (`loadResumeHistory`, which the core already does) + the ring's
  messages not yet in the transcript (deduplicated by message `uuid`, which the SDK documents as
  transcript chain-entry uuids) + the pending asks. **S1 confirmed it** for `assistant` and `user`
  messages; everything else on the stream is ring-only, ordered by `seq`, and the host sets
  `uuid` on every message it sends (§11.5).

### 5.2 Why this fits this repository

1. **The seam already exists twice.** `RunnerSession` gets `query` injected and exposes events +
   commands. `CodexAppServer` / `CodexRunner` is already split along the host / core line.
2. **The pane protocol is already snapshot + deltas.** Reattach is "rebuild, then keep
   streaming".
3. **The hook path proves the survivable pattern.** A helper independent of AW with a
   rendezvous AW can re-find.
4. **Stable host, churning core.** Every restart-triggering change lands in the core. The host
   is ~300–400 lines around a vendor SDK.
5. **`createApp` is already host-agnostic** (`HostServices`), and `EnvelopeTransport` is
   structural. A later UI/core split stays possible without rewriting.
6. **Window close ≠ quit is already policy.** Making the core windowless (Stage 6) turns the
   Electron app itself into the "daemon", with `safeStorage` intact.

### 5.3 Are per-session hosts warranted?

**Yes for Claude, no for Codex.**

- Claude runs one CLI per session, and its pipes and `Query` state must outlive the core (§11).
  Per-session hosts also mean **new sessions get new host code**, which bounds drift.
- The cost is one Node process (estimated ~40–70 MB; S2 measures it) next to a `claude` using
  ~120–400 MB.
- Codex multiplexes every thread in one `app-server`, so its host is shared by construction.
- The host abstraction is therefore provider-shaped: a host serves one or more sessions.

### 5.4 Should hosts survive core failure? Yes, from the first host stage

The core restarts several times a day, on every `app:install`. A host that dies with the core
buys nothing `--resume` doesn't. The adoption protocol stays small:

- manifest;
- socket;
- `hello` + token;
- snapshot;
- subscribe-from-seq.

There is no consensus, no lease between cores (the single-instance lock still holds), and no
host-to-host traffic.

### 5.5 The "daemon" question, answered

For this repo, **the daemon is the Electron main process running windowless**:

- the Dock icon is hidden when the last window closes;
- a menu-bar item shows live counts;
- OS notifications replace in-app message boxes;
- there is an optional login item.

Split the UI into its own process (Stage 7) only when a front end that is not Electron must work
while the app is fully quit. Otherwise, never.

---

## 6. Component responsibility matrix

| Responsibility | UI (renderer + window code) | Core (Electron main) | Session host | Agent adapter (core-side) | Persistent store |
|---|---|---|---|---|---|
| Render table and conversation, composer, drafts | ✔ | | | | `window.json` |
| Dialogs, pickers, clipboard, dictation (microphone) | ✔ | requests them via `HostServices` | | | |
| Authoritative registry of AW-owned sessions | | ✔ `SessionRegistry` | reports its identity | | `sessions.json` |
| Spawn, adopt, stop hosts; reattach; GC | | ✔ `HostSupervisor` | | | manifests |
| Own agent process, stdio, SDK `Query` / Codex server | | | ✔ | | |
| Hold `canUseTool` resolvers; settle exactly once | | | ✔ | | |
| Raw-message ring, seq, snapshot | | | ✔ | | |
| Translate native protocol → blocks, asks, composer | | runs it | never | ✔ `RunnerView` (+`runnerBlocks`), `CodexRunner` | |
| Build `PermissionResult` (allow/deny/always, answers, plan) | | ✔ | executes it | ✔ helpers | |
| Monitoring (registry, hooks, transcripts, rollouts) | | ✔ providers | | | provider files |
| Permission routing (host first, then hook file) | buttons | ✔ `SessionActions` | | | audit |
| Discord / remote control | | ✔ only here | never | | mirrors, audit |
| Notifications (decide / display) | display | ✔ | | | |
| Pause (SIGSTOP/SIGCONT the **agent** pid) | | ✔ `PauseService` | reports agent pid | | none (process state) |
| Take over / release / close / resume | buttons | ✔ | executes `end` | | registry |
| Projects, worktree association at launch | | ✔ | | | registry |
| Resource leases (worktree, Unity), later | chip | ✔ `LeaseService` | | | registry |
| Secrets (Discord token; host tokens) | | ✔ (Discord: safeStorage; hosts: 0600 file, S2) | receives only its own token, once | | `secrets.json`; `run/<id>.token` |
| Usage, auto-pause | cards | ✔ | | | cache |
| Crash-recovery policy | shows it | ✔ | exits cleanly, leaves a tombstone | | registry + manifests |

Rule: **the host has no policy and no AW domain model.** It never decides to allow, deny,
resume, notify or render. Everything with a "should" in it is in the core.

### 6.1 Fit with existing concepts

- **Many simultaneous agents.** One host per Claude session and one shared Codex host. The core's
  `SessionStore` still merges AW-owned and external sessions exactly as today.
- **Worktrees and cross-agent commits.** The registry records `repoRoot`, `worktree` and
  `branchAtStart` at launch. An early, independent win (F1): warn when two live sessions share
  one checkout root. That is exactly the "`M` next to your file isn't your diff" hazard in
  CLAUDE.md. Enforcement stays opt-in.
- **Project coordination.** Stays derived. `repoRoot` enables "sessions per repo" without a new
  entity.
- **Permissions and Discord.** The core stays the only thing Discord reaches, through
  `SessionActions`. For hosted sessions, `decidePermission` goes to the **host first** (its ask
  lives for days, while the hook gives up after ~28 min), and falls back to the hook file. The
  hook file also still works while the core is down. `remoteAskFor` and `DecoratedSessions` keep
  reading synchronous state, now from `RemoteSessionHandle`'s cache. AW stays the middleman, and
  hosts never see Discord.
- **Exclusive resources (Unity Editor, the installed app).** Decided by spike F2 (#23,
  `spikes/f2-resource-leases.md`): the agent does not request a lease, its tool call does.
  Resources are declared as tool-call patterns; an AW `PreToolUse` hook acquires the lease before
  a matching call, waits a bounded time, then denies with a reason, and never prints `allow`.
  The lock of record is an atomically created lease file next to the hook log, not a
  `sessions.json` field, because the hook must grant and refuse while the core is down (every
  `app:install`). The core `LeaseService` declares resources, reaps stale holders, releases on
  registry transitions, shows chips, offers force release, and lets the orchestration scheduler
  hold a lease before a session exists (`acquire` + `bind`). Leases key on the registry session
  id, so they survive core restarts and host reattach. An AW MCP tool is deferred until turn
  scope proves too short.
- **Scheduled agents** (`docs/plans/scheduled-agents.md`). That research weighs an in-app
  scheduler against launchd and cloud routines, and marks the in-app option down because it
  "needs the app open".
  - This design strengthens the in-app option. A windowless core with an opt-in login item
    (Stage 6) is "the app open" without a window.
  - A scheduled job that starts through the same executor runs in a host, so it survives the
    next `app:install`.
  - A 06:00 permission prompt waits in the host indefinitely (§7.5), "visibly in *Waiting*",
    without being auto-approved.
  - Scheduled jobs should launch through `SessionExecutor` (Stage 1) rather than a parallel
    path.

---

## 7. Process and session lifecycle semantics

### 7.1 States

**AW session** (core registry, one per AW-owned conversation):

```text
launching ─► live ─┬─► stopping ─► stopped        (explicit Stop / Close / Release)
                   ├─► ended                      (agent exited on its own, cleanly)
                   ├─► failed                     (agent exited with an error; stderr tail kept)
                   └─► lost ──► interrupted       (host vanished without an exit record, or the
                                                   machine went down; transcript intact)
live ⇄ connecting ⇄ unreachable                   (core ↔ host link; see §7.3)
interrupted / stopped / ended ─► Resume ─► launching (same session id, new host)
```

The live sub-states come from the core's `RunnerView`: `starting | idle | running |
awaiting-ask | ending`.

**Host:**

```text
spawning ─► ready(no client) ⇄ attached(≥1 client) ─► draining ─► exited
```

- **The host never exits because no client is connected.**
- It exits in exactly three cases:
  - the agent has exited and the final messages are drained (a client acknowledged them, or
    60 s passed with the exit record written);
  - an explicit `end`;
  - the idle-orphan rule (§7.5).
- It handles `SIGTERM`, `SIGINT` and `SIGHUP` by **SIGTERMing its `claude` at once**, waiting
  ≤5 s, then SIGKILL, then exiting. Node emits no `exit` event on signals, so the SDK's own
  kill-on-exit does not cover them. Logout sends SIGTERM. (Not stdin close: S1 showed that
  mid-turn the CLI ignores EOF until the turn ends, up to a whole long Bash command.)
- **Ending an agent (`end`, and every stop in §7.2, decided at CP0).** If a turn is running,
  `interrupt` first and wait up to `graceMs` (default 5 s) for its `result`; then close stdin;
  then SIGTERM if it has not exited within ~1 s; then SIGKILL 3 s later. Interrupt-first is what
  keeps the in-flight assistant message: S1 saw SIGTERM mid-stream drop it from the transcript.
  SIGTERM also kills `run_in_background` shells at once, where EOF waits ~5 s and a shell
  finishing inside that window starts a new turn.

**Session id changes.** `/clear` changes the id mid-life (`runnerSession.ts` `onMessage`). The
host rewrites its manifest atomically, and `hello` always reports the current id. For fresh
sessions, the core passes the SDK's `sessionId` option, so the id is known before the first
turn.

### 7.2 User-level commands

| Command | Semantics |
|---|---|
| Close window | UI only. With the Stage 6 windowless mode, the Dock icon hides and the menu-bar item stays. |
| **Quit (⌘Q, menu)** | With hosts: quits the core, **agents keep running**. A one-line notification: "3 agents keep running. ⌥⌘Q quits and stops them." Setting `lifecycle.onQuit = leaveRunning \| ask \| stopAgents` (default `leaveRunning`, decided §22). Before hosts exist (Stage 2): if agents are live, a confirm dialog "Quit and stop N agents?". |
| **Quit and Stop All Agents (⌥⌘Q)** | `preventDefault` → `end` every session, awaited and bounded (10 s) → exit. |
| Non-menu quit (Apple Event from `osascript`, logout, `powerMonitor` shutdown, SIGTERM) | **Never a dialog.** Before hosts: graceful bounded stop. With hosts: leave running. The menu item sets a `quitSource` flag, and a quit without the flag is non-interactive. `install-app.sh` polls until the main process has exited instead of `sleep 2`, and matches the main executable's exact path. |
| Stop agent / Close session | Core → host `end` (interrupt → grace → stdin close → SIGTERM → SIGKILL; §7.1). Registry `stopped`. Transcript kept. |
| Stop all | `end` to every host, in parallel, bounded. |
| Pause / resume | Unchanged: SIGSTOP/SIGCONT the **agent** pid the host reports, never the host. |
| Take over (external → AW) | Unchanged kill-then-verify (`endProcess`), then spawn a host with `resume`. |
| Release (AW → terminal) | `end`, wait for `exited`, then `resumeInTerminal`. |
| Resume (interrupted / stopped / ended) | New host with `resume: sessionId`, lazily on first send, like today's adopt-on-send. |

### 7.3 Core startup: manifests before anything else

1. **Before** the providers' first scan and before any auto-resume, read every `run/*.json`
   manifest. Register every session whose host pid is alive (with a matching start time) as
   **owned, state `connecting`**. This closes the double-owner race: without it, `adoptSession`
   could `endProcess` AW's own surviving `claude`, or `resumeLastRunner` could start a second
   process on its transcript.
2. For each manifest:
   - **Host alive + socket connects + `hello` + token OK** → `live`. Snapshot, then subscribe
     from `seq`.
   - **Host alive but unreachable, or an incompatible protocol** → `unreachable`. This **blocks
     every resume and adopt of that id.** The UI says "held by an unreachable host" and offers
     Stop host (start-time-checked `endProcess`) or Leave.
   - **Host dead, with an exit record** → `ended` / `failed`, then GC the manifest.
   - **Host dead, no exit record** → `lost` → `interrupted`, after the orphan sweep below.
3. Registry `live` records with no manifest (reboot or logout) → `interrupted`.
4. **Offer every interrupted session, not just the newest.** Rows get "Interrupted — Resume".
   Auto-resume (`runner.autoResumeLastOnStartup`) still applies to the newest only.

**The orphan sweep (amended at CP0 from S1).** The CLI has no single-owner lock: a second
process resuming a live id succeeds and silently forks the transcript. The sweep is the only
guard, so:

1. **It runs before every resume or adopt of an id**, not only at startup: a host exit the
   supervisor sees while the core is up, `resumeLastRunner`, `adoptAndSend`, the Resume button,
   and a §7.4 migration.
2. **What counts as an orphan:** an entry in `~/.claude/sessions/<pid>.json` whose `sessionId`
   matches, whose pid is alive **and** whose start time matches the entry's `procStart`, whose
   parent is launchd (ppid 1), and which is not the `agentPid` of any live manifest. A matching
   process with any other parent is a live owner (a terminal, another app), not an orphan: that
   goes through the existing take-over path, with its confirmation, never a silent kill.
3. **End it and wait:** SIGTERM, poll up to ~5 s, then SIGKILL; only then load history and
   resume. Until it has exited it may still be writing, and its tail is legitimate conversation.
4. **Tolerate stale entries:** a `sessions/<pid>.json` whose pid is dead, or alive with a
   different start time, is ignored (a SIGKILLed or OOM'd CLI cannot remove its own file).

Today's `resumeLastRunner` already refuses when the id is live in the Claude registry
(`shouldAutoResume`'s `running-elsewhere`), and adopting a live external session already goes
through take-over, so the in-process app is covered until Stage 2 adds a Resume button; that
button must keep the same guard.

### 7.4 Bounded version drift

A host runs the build it was spawned with. When a host's `hostBuild` ≠ the core's build and the
session is **idle, with no pending ask and no background shells or tasks running**, the next
`send` migrates it: `end` → `resume` the same id on a fresh host, carrying model, permission
mode and effort. That reuses the adopt-on-send path (`actions.adoptAndSend`), with the §7.1
end sequence (never bare stdin EOF) and the §7.3 sweep before the resume. Ending the CLI kills
its `run_in_background` shells, which is why busy sessions are never migrated. The result
is that a live host is at most "one busy stretch" old.

### 7.5 Idle-orphan rule

If no client has connected for `lifecycle.orphanIdleHours` (a Preferences setting; default 24,
where 0 = never), the
agent is idle, and there is no pending ask, the host ends its session gracefully and exits. This
is parking, not loss. **Never** end a busy or asking session automatically. Pending asks with no
client are **held indefinitely**, because an auto-deny derails the agent. Any timer uses a
monotonic clock so sleep does not trip it.

---

## 8. Failure and recovery model

Each row gives the target semantics once Stage 4 is done. [Brackets] show today's behaviour.

| Scenario | Agents | Pending asks | Discord / notifications | Recovery | User sees |
|---|---|---|---|---|---|
| **Renderer crashes** | unaffected [same] | unaffected | unaffected | new `render-process-gone` handler reloads; panes re-`init` [no handler: blank window] | a flash, then the same state |
| **Window closed** | continue [same] | held; answerable from Discord | live [same] | reopen from Dock or menu bar | menu-bar counts (Stage 6) |
| **⌘Q (leave running)** | continue in hosts [killed] | held in hosts, indefinitely | **down** until relaunch; the channel's buttons are dead, the mirror file persists | relaunch → reattach → reconciler re-converges | quit notification; everything live on relaunch; `claude agents --json` also lists them |
| **⌥⌘Q (stop all)** | graceful `end`, awaited, ≤10 s [`void end()`] | expired ("session closed") | cards closed as cancelled | Resume later (same id) | explicit |
| **Core crashes** | continue [killed] | held | down until relaunch | manual relaunch (never auto-restart) → reattach | banner: "reconnected to N agents after an unexpected exit" |
| **Host crashes** (SIGKILL, OOM) | `claude` gets stdin EOF and is reparented to launchd. It exits at once if idle, otherwise **after finishing its current turn** (S1, §11.5) | lost (heap gone) | card expires | core sees socket close + host dead, no exit record → `lost` → **orphan-claude sweep** → `interrupted`; one-click Resume, **no auto-resume** (crash loops) | "Interrupted — host exited unexpectedly" |
| **Agent process dies** | — | host settles them as expired | closed | host emits `exit {code, signal, stderrTail}`, writes an exit record, drains, exits; registry `ended`/`failed` | "Ended" or "Failed: <reason>" + Resume |
| **Machine sleeps** | suspended; on wake, API streams may error → CLI retries or the turn fails as an error note [same] | held | new `powerMonitor` `resume` handler reconnects the Discord gateway at once (today it waits for the ~41 s heartbeat) | heartbeat miss counters reset on resume; one fresh ping decides | nothing, or an error note |
| **Logout** | launchd SIGTERM → hosts end their agents gracefully (their SIGTERM handler) → transcripts flushed | lost | lost | next login: manifests dead, no live pid → `interrupted`; **all** offered | "Interrupted" rows; newest auto-resumed if enabled |
| **Reboot** | as logout; a hard power-off skips the graceful part | lost | mirrors closed as expired on the first reconcile | as logout | as logout |
| **AW update** (`app:install`) | continue on old-build hosts [killed] | held | gap during install | new core reattaches. Old hosts keep their build and migrate on the next idle send (§7.4) | "on an older host build" badge until migrated |
| **New core, old hosts** | continue | held | — | `hello` negotiates. v1 is frozen and additive; capabilities gate new features. Unknown major → `unreachable` (blocks resume), offer Stop | badge + action |

**Gating acceptance test.** This is the scenario the whole initiative exists for. An AW-hosted
agent runs `npm run app:install` **mid-turn**. The turn keeps going, the new core reattaches
while it is still streaming, and a pending ask survives and can be answered from the pane and
from Discord.

### 8.1 What survives what

| Survives → | renderer crash | window close | ⌘Q (leave) | core crash | host crash | logout / reboot |
|---|---|---|---|---|---|---|
| Agent + in-flight turn | ✔ | ✔ | ✔ | ✔ | ✘ | ✘ |
| Tool subprocesses, CLI background tasks / crons | ✔ | ✔ | ✔ | ✔ | ✘ | ✘ |
| Pending question / plan / permission (host) | ✔ | ✔ | ✔ | ✔ | ✘ | ✘ |
| Pending hook permission (file path) | ✔ | ✔ | ✔ (≤28 min) | ✔ (≤28 min) | while claude lives | ✘ |
| Conversation (transcript) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| AW metadata (registry, launch options, worktree, nickname, leases) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Discord live buttons | ✔ | ✔ | ✘ until relaunch | ✘ until relaunch | card expires | ✘ |
| Auto-pause enforcement | ✔ | ✔ | ✘ | ✘ | n/a | ✘ |

**Accepted risk:** while the core is fully down, the usage-cap auto-pause does not run. The quit
notification says so when auto-pause is enabled.

---

## 9. IPC and protocol design

### 9.1 Transport: Unix domain sockets, NDJSON, JSON-RPC 2.0

- **Why.**
  - Same-machine only, and filesystem permissions do the gatekeeping.
  - No ports.
  - Node's built-in `net`, so no dependencies.
  - The same framing Codex `app-server --stdio` already speaks, so there is one codec
    (extracted from `CodexAppServer` into `src/core/rpc/ndjsonPeer.ts`). Codex's `--listen
    unix://` speaks WebSocket instead (S4), so from Stage 5 the Codex hop uses a small WebSocket
    client; `ndjsonPeer` serves the Claude hosts and the Codex `--stdio` fallback.
  - Debuggable with `nc -U` or `socat`.
  - The same `net` API takes `\\.\pipe\…` on Windows if that ever matters.
- **Rejected alternatives.**
  - *localhost TCP*: reachable by any local process and other users, so it needs a token and
    ports.
  - *WebSocket*: browser framing nobody here needs.
  - *gRPC*: codegen, protobuf, large dependencies.
  - *Electron IPC*: needs a shared Electron parent.
  - *stdio to the core*: dies with the core, which is the problem itself.
- **Direction.** The host listens and the core connects: the long-lived party is the server.
  A future CLI connects to a **core** socket (`run/core.sock`, served by Electron main), never
  to hosts.
- **Paths.**
  - `~/Library/Application Support/Agent Wrangler/run/` at 0700, sockets at 0600, files named
    `<8-char base32 hostId>.sock`.
  - The directory prefix alone is ~67 bytes for a typical username, so a UUID file name would
    exceed macOS's 104-byte `sun_path`.
  - The supervisor checks the length and falls back to `~/.agentwrangler/run/` (0700). It does
    **not** fall back to `$TMPDIR`, which macOS cleans while hosts may live for days.
  - **Confirmed in S3:** a 104-byte path bound and 105 failed with `EINVAL`. With a 60-char
    username the primary path is 128 bytes and the fallback 100, so the fallback is necessary and
    sufficient. Check `Buffer.byteLength(path) <= 103` **before** `bind()`; `EINVAL` is not
    specific enough to catch and retry on.
  - The same limit applies to Codex's `--listen unix://`.

### 9.2 Framing

- One JSON object per line, UTF-8, `\n`-terminated.
- Maximum line 16 MiB, because images travel inline as base64. Larger lines are rejected, never
  partially applied.
- Requests carry `id`, and notifications do not.
- Host events carry a per-host monotonic `seq`.

### 9.3 Handshake

```jsonc
// core → host (the only method accepted before authentication)
{"jsonrpc":"2.0","id":1,"method":"hello","params":{
  "client":{"role":"core","build":"<buildId>","pid":1234},
  "protocol":{"min":1,"max":1},
  "token":"<256-bit base64url>"}}
// host → core
{"jsonrpc":"2.0","id":1,"result":{
  "hostId":"k3q9x2mz","protocol":1,"hostBuild":"<buildId>","provider":"claude",
  "sdkVersion":"0.3.268","cliVersion":"2.1.x","agentPid":5678,"agentStartTime":"…",
  "sessionId":"<current>","cwd":"…","state":"idle","seq":4812,
  "capabilities":["images","control.getContextUsage"]}}
```

### 9.4 Methods (protocol v1, frozen at CP2 on 2026-09-24; see §15.2)

The authoritative statement is the wire comment in `src/shared/sessionProtocol.ts`; this table
summarizes it.

| Method | Params | Result |
|---|---|---|
| `hello` | above, plus optional `client.capabilities` | above, plus `hostPid`, `agentStartTime`. An unsupported range → `-32003 protocol mismatch` with `data: {min, max}`; a bad token → `-32001`. A role other than `core` is an observer |
| `snapshot` | `{}` | `{epoch, seq, state, sessionId, pendingAsks[], ring:{fromSeq, truncated}, exit?, latest?, controls?}`. `epoch` identifies this host instance's event stream: seqs compare only within one epoch. `latest` is the last raw message of each level-type kind (`system/init`, `background_tasks_changed`, `session_state_changed`, …), which the ring may have evicted; `controls` are the model and permission mode last set through `control` |
| `events` | `{fromSeq, maxBytes, epoch?}` | `{events:[HostEvent], nextSeq, done}`, a paged replay of every held event (renamed from `messages` at CP2: it returns every event type). `nextSeq` is **where this page stopped**, not the host's live seq, and the client loops until `done`. A page never exceeds 1 MiB whatever `maxBytes` asks, well under the 4 MiB client queue (S3) |
| `subscribe` | `{fromSeq, epoch?}` | `{ok}`. The held backlog after `fromSeq` is sent **before** the response, then live events. An evicted `fromSeq`, another epoch, or a backlog that overflows the queue → `-32010 resync`, and nothing is streamed. For small gaps only: page a large one with `events` first |
| `send` | `{message: SDKUserMessage}` (client sets `uuid`) | `{accepted, duplicate}`. **Idempotent on `uuid`**, so a core that crashed mid-send can check the snapshot |
| `respondAsk` | `{requestId, result: PermissionResult}` | `{outcome: applied \| stale \| gone}` |
| `control` | `{op: interrupt \| setModel \| setPermissionMode \| supportedModels \| supportedCommands \| getContextUsage, args}` | `{result}`. An op the host does not have → `-32601`; the ops it has are advertised as `control.<op>` capabilities |
| `end` | `{graceMs}` | resolves after the agent has exited |
| `ping` | `{}` | `{seq, now}` |
| `configure` (Stage 4, additive) | `{orphanIdleHours?}` | `{ok}`. Core only. Sent only to a host advertising `configure.orphanIdleHours`; an older host answers `-32601`. Fields a host does not know are ignored |

Stage 4 also added, additively, `HostExit.trigger` (`'idleTimeout'` when the idle-orphan rule
ended the session) and `HostBoot.orphanIdleHours`.

There is deliberately **no** method to spawn, exec, read files or change the binary, cwd, env or
the `allowDangerouslySkipPermissions` option. A host drives only the session it was started
with.

### 9.5 Events (host → core notifications, all with `seq`)

There are two notifications. **`event {event}`** carries every `HostEvent` in seq order, and
**`resync {}`** belongs to one connection and has no seq. One `event` notification rather than
one per type (a CP2 decision) means a new event type is additive: readers ignore types, fields,
states and reasons they don't know. The `HostEvent` types:

- `message {msg}`: every raw SDK message, `stream_event` partials included. Base64 images over
  32 KiB are replaced by a stub on the wire (capability `wire.largeImagesOmitted`); the
  transcript has the original. This settles S3's large-frame question: no multi-MiB frame
  reaches the main thread. Any frame still over 16 MiB is replaced by a stub, never sent.
- `ask {ask}` / `askSettled {requestId, reason: responded | aborted | answeredElsewhere | agentExited}`.
  `ask` carries the SDK's `canUseTool` options as-is, minus `signal`.
- `state {state}`: the host's minimal lifecycle (`starting | idle | running | ending | exited`).
  **This is authoritative** for the view (the CP1 carry-over).
- `sessionId {sessionId}`.
- `exit {exit}`: `{reason: ended | stopped | signal | error | crashed, error?, code?, signal?,
  hostSignal?, stderrTail?}`. `code` and `signal` are the agent process's own; `hostSignal` is
  what the host was sent (logout, `kill`). An unknown reason reads as `error`. `lost` is
  never on the wire or in a manifest: it is the core's conclusion that a host died silently.

The core's `RemoteSessionHandle` feeds these to `RunnerView`, which is today's reducer, and
answers the synchronous getters (`canSend`, `composer`, `pendingQuestion`, `pendingPlan`) from
its state. It adds `connecting` and `unreachable`, which `RunnerLifecycle` lacks.
`fullBlockText` stays core-side, because the core holds the full text it reduced.

### 9.6 Versioning

- The major version lives in `hello`. **v1 is frozen at CP2.** Within a major, changes are
  additive only: unknown fields are ignored, unknown methods return `-32601`, and new features
  are `capabilities`.
- Drift is bounded by §7.4 migration, not by the core carrying adapters forever. A host older
  than one busy stretch is rare.
- A major bump means the core keeps the old client until no manifest reports it.
- Types live in `src/shared/sessionProtocol.ts` (pure types), with wire fixtures pinned in
  tests. Payloads are SDK types, so the SDK version pin (`package.json`, exact) is part of the
  compatibility story. `hello` reports `sdkVersion`.

### 9.7 Backpressure and slow clients

- **The host drains the SDK iterator at full speed, always.** If it stopped, `claude`'s ~64 KB
  stdout pipe would fill and the agent would stall.
- Per client there is a **byte-bounded** outbound queue (4 MiB). On overflow the host drops the
  queue, sends `resync`, and the client re-snapshots and pages `events` from the snapshot.
- Under pressure, `stream_event` deltas for the same content block are coalesced.
- The ring is sized in bytes (default 16 MiB). The transcript covers anything older.
- A `fromSeq` is stale only once the ring has **evicted past it** (track an `evictedThrough`
  mark). "Older than the oldest entry held" is not enough: early in a host's life that gives a
  false `resync`.
- **Measured in S3** (`spikes/s3-socket-protocol.md`, synthetic SDK-shaped traffic over a real
  UDS): 2,000 deltas/s delivered at p50 0 ms / p99 28 ms, and one client tops out at ~33–40k/s.
  A reader paused 5 s never stalled the producer. The 4 MiB queue overflowed once, and one resync
  plus seven 1 MiB pages caught up. Resume from `seq` was gap-free when the ring covered the gap,
  with one resync when it did not. **The 4 MiB queue and 16 MiB ring defaults stand.**
- A 16 MiB frame round-trips intact and a larger line is rejected, but parsing one took 2–3 s. The
  core must not `JSON.parse` frames that large on the Electron main thread in the same tick as UI
  work. **Stage 3 decided: don't send large images inline** (§9.5), so no off-thread parser.

### 9.8 Heartbeats and reconnects

- The core pings every 10 s and declares a host unreachable after 3 misses on a monotonic clock.
  The counters reset on `powerMonitor` `resume`, and one fresh ping decides.
- Reconnect uses exponential backoff up to 30 s while the host pid is alive. After the host dies,
  §7.3 classification takes over.
- Hosts don't ping; a socket close is enough for them.
- **Measured in S3:** freezing the core, the host, or both with SIGSTOP for 4 s was always read as a
  resume, with zero misses counted. A killed host was declared unreachable after exactly 3 misses.
  Schedule pings with a recursive `setTimeout`, not `setInterval`, so a wake doesn't fire a burst
  of missed ticks. The elapsed-time check (`gap > interval × 3` ⇒ resume) is a useful cross-check
  alongside `powerMonitor` `resume`, but only for a frozen process: a real sleep leaves almost no
  gap, because the monotonic clock stops too (S2 M2, §11.10). `resume` is the wake signal.

### 9.9 Multiple clients

- Hosts accept several authenticated connections, for example a new core overlapping a
  half-dead old one. Only `role: core` may call `send`, `respondAsk`, `control` or `end`.
  `observer` (debugging) gets snapshots and events.
- Asks settle exactly once. The second answer gets `stale`.
- The UI and the CLI never connect to hosts. They go through the core, which keeps AW
  authoritative.

### 9.10 Core control socket (Stage 8) and UI split (Stage 7, gated)

- **`run/core.sock`** (served by Electron main) uses the same codec. It exposes a narrow RPC
  set: `status`, `sessions`, `session`, `subscribe` (read-only event stream), `send`, `stop`,
  `projects`. Every one routes through `SessionActions` / `createApp`, exactly like the menu.
- **A UI/core process split, if it ever happens,** carries `src/shared/messages.ts` payloads
  over the same envelope. `EnvelopeTransport` is already structural.

---

## 10. Persistence model

| Kind | Where | Survives | Writer | Notes |
|---|---|---|---|---|
| Live process state (SDK `Query`, resolvers, input queue) | host heap | host lifetime | host | never persisted |
| Raw-message ring (seq) | host heap | host lifetime | host | reconnect only; the transcript is the history |
| **Host manifest** `{v, hostId, provider, sessionId, cwd, hostPid, hostStartTime, agentPid, agentStartTime, socketPath, protocol, hostBuild, runtimeDir, sdkVersion, cliVersion, startedAt}` | `run/<hostId>.json` (0600) | host lifetime + tombstone | host (atomic tmp+rename; rewritten when the id changes) | written only after `listen` succeeds |
| **Exit record / tombstone** `{exit:{code, signal, reason, at, lastSeq}}` | merged into the manifest | until core GC | host | how the core tells `ended` from `lost` |
| **AW session registry** (replaces `RunnerRegistry`) `{sessionId, provider, cwd, repoRoot?, worktree?, branchAtStart?, launch:{model, permissionMode, effort, binary, cliVersion}, hostId?, state, endedReason?, createdAt, lastShownAt}` | `sessions.json` via `JsonStore` | everything | core only | the per-window scoping of `surface.json` was a VSCode-era need. Migrate once, and keep the old key readable for one release |
| Host capability tokens | `run/<hostId>.token`, 0600, in the 0700 `run/` dir, never inside the manifest | host lifetime | core | **Decided by S2:** after every ad-hoc rebuild the first safeStorage call blocks the main thread on a Keychain dialog, during exactly the startup that readopts hosts. A same-uid reader of the file could reach the socket anyway (§12) |
| Conversation / event history | provider transcripts | everything | the CLI | **AW does not persist event history** |
| Terminal scrollback | — | — | — | no PTY; the transcript is the equivalent |
| Permissions | hook markers/decisions (existing); host pending asks (snapshot) | as noted | claude hook / host | settle events record `by: ui \| discord \| hook \| cli` for the audit |
| Project / worktree association | registry (captured at launch via `worktreeFor`) | everything | core | project list stays derived |
| Runtimes | `runtimes/<buildId>/` (APFS clone) | while any manifest references it | core | GC on startup |
| Discord mirrors, audit | unchanged | everything | core | |

**SQLite: no.** There are fewer than 100 records and one writer. Access is "load all, replace
one", and the repo has a tested atomic-JSON discipline (`JsonStore`, `FileUsageCache`,
`MirrorStore`, `HookLog.decide`). `better-sqlite3` means a native module against the Electron ABI
plus asar unpacking, and `node:sqlite` is still in active development in Node 24.
`docs/codex-and-electron.md` already declines SQLite. Revisit if AW ever persists event history,
gets several writers, or needs fleet-level queries.

---

## 11. PTY and process ownership findings

1. **There is no PTY.** Claude runs over SDK stream-json and Codex over JSON-RPC, both on pipes.
   The only terminal integration is `resumeInTerminal` (AppleScript), which is a handoff, not
   hosting. **Do not introduce PTYs.** A future TUI-only provider would get its own adapter
   behind the same host protocol, and that is out of scope.
2. **A pid gives liveness, signals and a registry lookup. Nothing else.** Pipe fds exist only in
   the processes holding them. macOS has no `/proc/<pid>/fd`. `SCM_RIGHTS` needs a cooperating
   live sender, and Node exposes it only for its own IPC channel. **After the holder dies,
   reattaching to an agent's stdio is impossible.**
3. **What must stay alive for Claude:** the pipe holder **and** the SDK `Query` state (the
   `initialize` handshake already done, `can_use_tool` request ids and resolvers, hook callbacks,
   in-process MCP servers).
   - **The `spawnClaudeCodeProcess` relay is rejected.** It keeps the pipes in a dumb host and
     the `Query` in the core, so the `Query` dies with the core, and core death is the
     `app:install` case.
   - A new `Query` would re-send `initialize` to an already-initialised CLI, would not know the
     in-flight request ids, and would try to pass fresh `--resume` args.
   - Faking it means replaying undocumented control frames that change with every CLI update.
     **So the `Query` lives in the host.**
4. **What a host buys over kill + `--resume`:**
   - the in-flight turn;
   - running tool subprocesses and `run_in_background` shells;
   - CLI background tasks and session crons;
   - pending asks.

   Conversation continuity is already free.
5. **Child death today, and after a host crash.**
   - The SDK spawns without `detached` and SIGTERMs its children on `process.on('exit')`, which
     does not run on signals, SIGKILL or OOM.
   - The CLI exits on stdin EOF **only at idle** (about 0.7 s). **Measured in S1**
     (`spikes/s1-runner-death.md`): mid-turn, EOF lets the turn run to its end: about 19 s for a
     streamed reply, the whole of a 120 s Bash command plus another model call, 6–14 s after a
     pending ask fails. So the SDK exit handler is the only prompt path, and any death that skips
     it (SIGKILL, crash, OOM, Node's default SIGTERM) leaves `claude` as a launchd orphan
     (ppid 1 within ~55 ms) **for the rest of its turn**.
   - The orphan is not wedged on EPIPE. It keeps working: it holds the session id, writes the
     transcript, spends tokens, runs every auto-allowed tool, and a background task finishing
     inside the ~5 s shell grace starts a new turn. It always exited cleanly on its own once the
     turn was over (`sessions/<pid>.json` removed, `SessionEnd` run).
   - **The CLI has no single-owner lock.** A second `Query` with `resume: <id>` succeeds while the
     first CLI is alive, and the transcript silently forks (two entries share a `parentUuid`).
   - stdin EOF during a pending `can_use_tool` resolves within ~5 ms as a tool error ("Tool
     permission stream closed before response"). The turn continues and later permission checks
     fail instantly. The host's `AbortSignal` fires only when the child exits.
   - Transcript lines were never torn in ~35 runs. Damage is semantic: SIGTERM mid-stream drops the
     in-flight assistant message, and a killed ask leaves a `tool_use` with no `tool_result`.
   - **§7.3's orphan sweep is mandatory and sufficient, with four amendments** (folded into
     §7.3 at CP0, which also pins down what counts as an orphan):
     1. sweep before **every** resume or adopt of an id (supervisor-seen host exit,
        `resumeLastRunner`, `adoptAndSend`), not only on startup;
     2. SIGTERM, wait ~5 s, SIGKILL, and only then load history and resume;
     3. check pid identity against `procStart` in `sessions/<pid>.json`, and tolerate a stale file;
     4. the host handles SIGTERM by SIGTERMing its `claude` (the SDK installs no handler).
   - Migrations should end a CLI with `interrupt` or SIGTERM, not stdin EOF: SIGTERM kills
     background shells at once, EOF waits ~5 s first.
   - **Decided at CP0, not a blocker:** with AW's `PermissionRequest` hook installed (1800 s
     timeout), a mid-ask orphan may wait on the hook instead of failing at once (S1 ran with
     hooks isolated). Until Stage 4 that is benign: the ask shows in AW through the hook marker
     and can be answered there, and the sweep ends the orphan before any resume. From Stage 4,
     `AGENTWRANGLER_HOSTED=1` makes the hook return at once for hosted sessions. Stage 3's live
     test checks it once with the hook installed.
   - **uuid dedupe (U2) works.** SDK `assistant`/`user` uuids are the transcript uuids, and a
     `uuid` the host sets on a message it sends is kept. `stream_event`, `system/*` and `result`
     never reach the transcript, so they are ring-only, ordered by `seq`. The ring must not
     assume "yielded ⇒ on disk", and the host sets `uuid` on every send.
   - The SDK `sessionId` option works for fresh ids; an id that already has a transcript is
     refused ("already in use") even with no live process. Continuing an id is always `resume`.
6. **The host process.**
   - `spawn(runtimeExe, [hostJs], {detached: true, stdio: ['pipe', logFd, logFd]})`. The token
     is the first stdin line, then stdin is destroyed.
   - stdout and stderr go to `logs/host-<id>.log`, **never pipes to the core** (they would EPIPE
     when the core dies). Then `unref()`.
   - The SDK builds `claude`'s env from `process.env`, minus `NODE_OPTIONS`. The host **must
     pass an explicit `env` that strips `ELECTRON_*`, `AW_*`, `__CFBundleIdentifier` and
     `XPC_SERVICE_NAME`** (the last two come from the LaunchServices launch; S2). Otherwise
     `ELECTRON_RUN_AS_NODE=1` reaches `claude` and every Bash or npm command it runs (S2 saw it
     on a host spawned without an explicit env). That is the same bug `env -u ELECTRON_RUN_AS_NODE`
     in `package.json` already works around.
   - libuv marks its fds close-on-exec, so the socket and log fds don't leak into `claude`.
     **Confirmed by `lsof` in S2:** no leak into `claude`, and the host inherited none of the
     core's 55 fds.
   - A host handles SIGTERM by SIGTERMing `claude`, waiting ≤5 s, then SIGKILL, then exiting
     (§7.1; amended at CP0). S2's host ended its input instead and measured 0.8–1.3 s to a clean
     exit, but its agents were idle; mid-turn, S1 showed EOF is ignored until the turn ends,
     while SIGTERM ends a busy CLI in ~2.7 s.
   - **Host RSS (S2): 22–64 MB** (~60 MB after spawn and a first turn, 22–31 MB idle). `claude`
     itself is 140–355 MB. §5.3's estimate holds.
7. **Runtime location.**
   - At core start, **APFS-clone** the running bundle (`cp -c -R`, close to free) into
     `runtimes/<buildId>/`, rename the executable (for example "Agent Wrangler Host"), and spawn
     hosts from there.
   - **S2 decided: cloned runtime, but for different reasons.** (`spikes/s2-detached-host.md`.)
     A control host running from the installed bundle itself **also survived** `rm -rf` +
     `cp -R`, because deleted files stay open through their inodes. The clone is still right:
     - `pgrep -f <bundle exe path>` and `pgrep -x <exe name>` (the install script's guard and the
       `killall` pattern) matched the uncloned host and neither clone;
     - a host lives for days, and anything it lazily opens from a deleted bundle would fail;
     - the clone keeps the build's cdhash, which is the identity TCC uses once the core is gone.
   - The clone takes ~89 ms. As S2 ran it (no re-sign, no `Info.plist` edit) it runs under the
     ad-hoc signature because the Mach-O's embedded code directory is unchanged, **but it fails
     `codesign --verify`** (CFBundleExecutable names the old executable). With the stable
     certificate the clone is re-signed instead (below), which fixes that; the unmodified clone
     is the fallback, and for it nothing may verify a runtime statically.
   - `lsappinfo` lists no host as an app, so `osascript quit app` never reaches one.
   - **TCC:** a host and its `claude` count as the core while it lives, then as themselves (the
     old build). `~/Documents` access kept working after the bundle was replaced. A new build's
     own first `~/Documents` access took 13.5 s, which fits a TCC consent re-prompt per ad-hoc
     cdhash (to confirm, S2 procedure M4).
   - GC every runtime no manifest references.
   - Record in the build config that Electron's `RunAsNode` fuse must stay enabled.
   - **Signing changed after S2 (#56, CP0 amendment).** S2 measured ad-hoc builds. Builds are now
     signed with a stable local certificate, so TCC grants and the Keychain ACL follow "this
     bundle id, signed by this certificate" instead of each build's cdhash. That removes the
     Keychain dialog after every rebuild and, most likely, the 13.5 s `~/Documents` re-prompt.
     It also makes a clean clone possible: after the rename, set `CFBundleExecutable` in the
     clone's `Info.plist` and re-sign it with the same certificate and entitlements (~0.6 s in
     S2). Its cdhash changes but its designated requirement does not, and `codesign --verify`
     passes. **Stage 3 does that by default** and repeats S2's install scenario (7) and a
     `~/Documents` read once on the certificate-signed build before relying on it. If re-signing
     fails, the unmodified clone S2 measured is the fallback. Host tokens stay in 0600 files
     regardless (§10): keeping the Keychain off the startup path that readopts hosts costs
     nothing, since a same-uid reader could reach the socket anyway.
8. **Codex.**
   - One `app-server` holds every AW Codex thread's in-flight turn.
   - **Chosen (S4, confirmed at CP0):** an AW-owned, detached `codex app-server --listen
     unix://<path>` from a pinned copy of the binary, treated as a shared host with a manifest.
     AW controls its lifetime and version.
   - **Rejected:** Codex's machine-wide `app-server daemon`. AW does not control its restarts
     (`daemon update may interrupt running work`), and the VS Code extension and AW can run
     **different** Codex binary versions from different extension directories, as they did
     during this investigation.
   - Record the server version (from `initialize.userAgent`) in the manifest. AW's client must
     speak that server's protocol. (S4: `proxy` is a byte pipe, so the old "never proxy newer
     into older" rule is moot.)
   - **S4 decided (a)** (`spikes/s4-codex-restart.md`). The daemon runs the same server
     underneath, so reconnects behave identically, and what it adds is harmful: it will not start
     from the extension's binaries, it is shared machine-wide (the `codex` TUI attaches by
     default), and any `daemon restart`/`update` drains ~60 s, kills pending asks, then injects
     a "server restarted… continue" turn that can repeat actions.
   - **The socket speaks WebSocket, not NDJSON** (one JSON-RPC message per text frame). The real
     socket lives in `/tmp/codex-daemon-<uid>/` and the requested path is a symlink to it.
   - **Pending requests survive a client drop.** The turn keeps running with nobody attached.
     After `thread/resume` on a new connection, `requestApproval`/`requestUserInput` are
     **re-sent with their original ids**, answerable there, and never time out (still pending
     after 120 s unattended). Streamed deltas from the gap are not replayed; `item/completed`
     carries the whole item. With two subscribers the first answer wins, and the other gets
     `serverRequest/resolved`. Everything in flight is lost only if the server process dies.
   - Request ids are per server process: they count across threads and restart at 0 when the
     server restarts. Any connection can answer any pending id; the 0600 socket is the only guard.
   - `SIGTERM` exits an idle server in ~0.1 s but waits indefinitely on a pending turn; `SIGINT`
     exits at once and marks the turn `interrupted`.
   - **The writer lock works across processes and versions.** `thread/resume` of a thread another
     app-server holds fails with "already has an active writer", so there is no silent fork
     (unlike Claude, §11.5). The lock frees only when the thread unloads, ~60 s after it goes
     idle with no subscribers; a thread waiting on an approval never unloads.
   - `requestUserInput` reaches the client only in plan mode, and a thread with no turns yet
     cannot be resumed from another connection.
9. **Claude background agents** (`claude --bg`, `claude agents --json`) are a first-party
   detached-session feature. `claude agents --json` already lists SDK sessions with pid and
   status. **S5 verdict: no, they cannot replace the AW Claude host** (`spikes/s5-bg-agents.md`).
   - `--bg` and `--print`/stream-json are mutually exclusive at the CLI's argument parser.
   - A bg agent is hosted by a per-user `claude daemon run` → `claude bg-pty-host` →
     `claude --bg-spare` tree that AW does not own. It does survive its launcher.
   - `claude logs` and `claude attach` replay raw terminal bytes. The agent's private sockets
     answer nothing documented.
   - Permission prompts really block, and resolve only through the existing
     `PermissionRequest` hook or a PTY attach. There is no `canUseTool` equivalent.

   The stdio + stream-json thin host in §5 stands. The provider-shaped host keeps the door open
   if Anthropic ever adds a structured channel to bg agents.
10. **macOS facts relied on:**
    - no parent-death signal;
    - orphans reparent to launchd;
    - `detached` → `setsid` puts the host outside the app's process group;
    - logout SIGTERMs every user process (hosts handle it);
    - sleep suspends everything.

    App Nap can throttle a *windowless* Electron core, which would delay the Discord heartbeat,
    so use `powerSaveBlocker('prevent-app-suspension')` while agents are busy. **S2 saw no
    throttling** in 150 s runs with a window, windowless with the Dock icon hidden, or with the
    blocker on. The blocker also shows up as a `NoIdleSleep` assertion, so it stops idle system
    sleep too: hold it only while an agent is busy. Much longer idle periods and battery power
    are untested.

    **Survival (S2):** hosts spawned detached from the cloned runtime survived window close, a
    menu quit, an `osascript` quit, SIGTERM, `kill -9` and a crash of the core, and a full
    install (quit, `rm -rf`, `cp -R` of a new build). The new build reattached with the token
    and ran turns on the same `claude`. One host survived nine core deaths across two builds.
    **Manual procedures, run 2026-09-24:**
    - **M1 passed.** A real ⌘Q logged `source=menu` and Dock → Quit logged `UNFLAGGED`; the host
      survived both (reparented to launchd) and answered a turn.
    - **M2 passed.** Across ~100 s of sleep, `powerMonitor` logged `suspend` then `resume`, and
      the core, host and `claude` all survived and answered a turn. **Finding:** the host's
      longest 1 s-timer gap was ~31 s, not the ~100 s asleep. Node's monotonic clock does not
      advance during sleep, so a timer gap cannot detect a sleep. That is right for idle
      timers (§7.5) and heartbeat misses (§9.8), but wake detection must use `powerMonitor`
      `resume`; the `gap > interval × 3` heuristic is only a cross-check for a frozen process.
      A turn in flight across the sleep was not tested.
    - **M3 (logout) deferred.** James could not log out; assumed to behave as the SIGTERM proxy
      measured (graceful host exit, `claude` gone in ~0.8–1.3 s). Revisit if a logout ever leaves
      an orphan or an unexpected Interrupted row.
    - The procedure must create `/tmp/aw-spike-s2/proj` before `spawnHost`. Without it the SDK
      reports "native binary … failed to launch"; the real cause is the missing cwd. Worth
      remembering for the host: a missing `cwd` surfaces as a misleading binary error.

    **Quit source (S2, U4).** Electron 44 gives no reason on `before-quit`/`will-quit`/`quit`.
    - **Electron turns SIGTERM into a graceful quit itself**, so `before-quit` teardown already
      runs on SIGTERM. A `process.on('SIGTERM')` registered at module load is overridden and
      **never fires**. Registered inside `whenReady`, it fires and can flag the quit.
    - A custom Quit menu item (not `role: 'quit'`, which bypasses the handler) with
      `CmdOrCtrl+Q` flags `menu`.
    - Anything unflagged is external: `osascript`, Dock → Quit, logout.
    - `install-app.sh` should announce itself (a `run/quit-intent` marker, later a core-socket
      call) rather than be inferred.
    - Telling logout from `osascript` via `powerMonitor` `'shutdown'` is unverified (M3,
      deferred).
    - With detached hosts no quit source kills a hosted session. The source only decides the UI.

---

## 12. Security model

The model is proportional to a single-user local developer tool:

- **Other local users:** kept out.
- **Accidental, over-eager or prompt-injected use, and stale endpoints:** made hard.
- **A deliberately malicious process running as the same user:** *cannot* be stopped by AW. That
  includes an agent with a free shell, which could just as well edit the hook script or
  `settings.json`.

State this plainly in the README.

**What the socket would add** relative to today (the bar to beat):

- **Today.** Any same-user process can write `~/.claude/agentwrangler/decisions/<id>.json`, where
  the id is `$PPID-$$` and is listed in `requests/`. That approves any hook-gated permission,
  because a hook decision beats `canUseTool`.
- **New with an unauthenticated socket:**
  - answering `AskUserQuestion`;
  - approving `ExitPlanMode` (escaping plan mode);
  - `setPermissionMode` (for example to `acceptEdits` or `auto`; `bypassPermissions` stays
    impossible while `allowDangerouslySkipPermissions` is unset, and it must stay unset);
  - **`send` into another session**, where one agent injects a prompt into a more-privileged
    session.
- This matters here. Agents that work on this repo will have the protocol source in context, and
  new conversations default to **`auto`** permission mode (commit `95daa10`), so a classifier,
  not the user, reviews a `nc -U …`.

| Topic | Design |
|---|---|
| Who can connect | Owner only: `run/` is 0700, sockets 0600. The core refuses to start hosts if `run/` has the wrong owner or mode. |
| Capability token | 256-bit, per host, generated by the core, delivered as the **first stdin line** and then stdin is destroyed. **Never argv** (`ps` shows it) and **never env** (inherited by `claude` and every Bash tool). Required by every method but `hello`. Stored in a 0600 `run/<hostId>.token` file (S2: safeStorage blocks core startup on a Keychain dialog after every ad-hoc rebuild). The host keeps its copy in memory only. |
| Hosted sessions approvable only with the token (Stage 4; on by default, decided §22) | The host sets `AGENTWRANGLER_HOSTED=1` in `claude`'s env. The permission hook script (bump `PERMISSION_SCRIPT_VERSION`) then logs the pending marker for status but **doesn't poll for a decision** for hosted sessions. An agent can't change its parent's env. This depends on the host-first routing in §6.1. |
| Audit | The host logs every `send`, `respondAsk` and `control` (op name, requestId, never content). Core settle events carry `by`. |
| Arbitrary command execution | Hosts expose no spawn, exec, file, cwd, env or binary method. The core builds host argv from settings plus validated registry fields. The core socket's `start` takes `{provider, cwd, model, permissionMode, effort, resume}`, never a binary or arguments. |
| Environment | Explicit env for `claude`: the host's env minus `ELECTRON_*`, `AW_*`, `__CFBundleIdentifier` and `XPC_SERVICE_NAME` (S2). The Discord token is never in env. |
| Filesystem | Unchanged: agents have what the user granted Claude Code or Codex. |
| Discord boundary | Unchanged. Only `RemoteControlService` → `PermissionActions` (three methods), in the core. Hosts never talk to Discord. The token never leaves the core. |
| Stale endpoints | The manifest has `hostId` + pid + start time. `hello` must match `hostId`. A socket is unlinked only when its pid is dead or its start time differs. |
| Session impersonation | The host's claimed `sessionId` is cross-checked against `~/.claude/sessions/<agentPid>.json`. |
| PID reuse | Every signal to a host or agent pid is preceded by a start-time comparison (`ps -o lstart= -p`). `endProcess` gains that guard. |
| Skipped, deliberately | Peer-pid checks (macOS `LOCAL_PEERPID` needs a native addon), per-message MACs, TLS, identity systems. |
| Future remote clients | Only via the core, never to hosts. Anything beyond same-machine needs real authentication and is out of scope (§21). |

---

## 13. Migration plan

The ordering principle is to put the boundary in place in-process first, then make it durable,
and only then move it out of process. Every stage leaves the app installable and usable, and
Stages 1–2 change no process topology.

Every stage uses its own worktree and branch (`feat/<topic>`, per CLAUDE.md), is merged
`--no-ff`, and ends with `app:install` plus "restart needed". "Own PR" means one branch and
merge. Opening a GitHub PR for review is optional in this repo.

### Stage 0: Characterize and de-risk

- **Goal.** Replace the riskiest assumptions with measurements before any interface is frozen.
- **Change.** None to the product.
  - Spikes S1–S5 (§19) are throwaway prototypes under `spikes/` on their own branches, **never
    merged**. Their findings are merged into §11 and §19 of this document.
  - Characterization tests do merge.
- **Characterization tests:**
  - `RunnerService.dispose` ends every session (and doesn't await);
  - `RunnerRegistry.resumable` gives newest-only within 8 h;
  - the `resumeLastRunner` guards;
  - `endProcess` escalation (`test/adopt.test.ts` exists);
  - `CodexAppServer.dispose` kills its child.
- **Files.** `test/runnerService.test.ts` (new), `test/runnerRegistry.test.ts`,
  `test/codexAppServer.test.ts` (new, with an injected `spawnProcess`). Also extract the inline
  resume guard into a pure `shouldAutoResume(...)` in `src/core/session/resumePolicy.ts`, which
  is the one tiny refactor.
- **Completion.**
  - S1–S5 have verdicts in §19.
  - The tests are green.
  - **CP0** has confirmed or amended §5, and this document is updated.
- **Rollback.** n/a.
- **Commits.** One per spike write-up, and one for the tests.
- **PR.** Tests are their own PR. Findings are docs commits.

```text
Recommended model: Opus (S1, S2, S4) · Sonnet (S3, S5, characterization tests)
Recommended effort: High (spikes) · Medium (tests)
Why: experiments are mechanical, but interpreting OS/CLI process behaviour decides the architecture.
When to escalate: any result contradicting §11 → Opus Extra High for the gate.
Review checkpoint: CP0 (Opus Extra High) after S1–S4 (S5 non-blocking), before Stage 1.
```

### Stage 1: Split execution from translation, behind one session interface (in-process)

- **Goal.** Nothing outside the executor holds a `RunnerSession` or `CodexRunner`. Claude's
  execution and translation are separated the way Codex's already are. Behaviour is unchanged.
- **Change.**
  - Split `RunnerSession` into:
    - `ClaudeSdkSession`, **the future host core**: `Query`, `InputQueue`, the raw ask records
      and their resolvers, the raw-message emitter with `seq`, the control passthrough, `end`,
      and an idempotent send by `uuid`. `end` implements the §7.1 sequence (interrupt first,
      never bare stdin EOF), and every send carries a `uuid` (CP0).
    - `RunnerView`, which **stays in the core**: `reduceRunnerMessage`, blocks, composer,
      history, capping, `askBlock`, building the `PermissionResult`.
  - Introduce `SessionHandle` / `SessionExecutor` (provider-agnostic):
    - identity;
    - a cached synchronous view (`lifecycle`, incl. `connecting`/`unreachable`, `composer`,
      `pendingQuestion`, `pendingPlan`, `canSend`);
    - `snapshot()`;
    - `subscribe(fromSeq)`;
    - async commands returning `{outcome}`.
  - `LocalClaudeHandle` = `RunnerView` over an in-process `ClaudeSdkSession`.
    `LocalCodexHandle` = `CodexRunner` over `CodexAppServer`.
  - Fold in **F3**: settle a hook-answered permission card when the next
    `PreToolUse`/`PermissionDenied` for that tool arrives, or when the SDK aborts the signal.
- **Files.**
  - New: `src/claude/runner/claudeSdkSession.ts`, `src/claude/runner/runnerView.ts`,
    `src/core/session/sessionHandle.ts`, `src/core/session/localClaudeHandle.ts`,
    `src/codex/codexHandle.ts`, `src/shared/sessionProtocol.ts`.
  - Modified: `runnerSession.ts` (split, then removed), `runnerService.ts`, `src/codex/runner.ts`,
    `src/ui/conversation/runnerSource.ts`, `conversationHost.ts` (the `runner`/`codex-runner`
    bindings become `live`), `src/app/createApp.ts` (`runnerOwnership`, `adoptSession`,
    `confirmAndCloseSession`, `release`, `startConversation`, `resumeLastRunner`, `actions.*`),
    `src/ui/dashboardHost.ts`, `src/host/hostServices.ts` + `src/electron/workbenchWindow.ts`
    (`showRunner`/`showCodexRunner` → `showSession(handle)`).
- **Migration.** Mechanical. `send` becomes async; `RunnerSource.send` already returns a Promise.
- **Tests.**
  - `test/runnerSession.test.ts` is split into `claudeSdkSession.test.ts` (fake `query`: seq,
    asks, settle-once, idempotent send) and `runnerView.test.ts` (existing reducer expectations
    unchanged).
  - `sessionHandle.test.ts`: snapshot equals the replay of events.
  - `codexRunner.test.ts` adapted.
  - Remote tests unchanged, which proves the facade.
- **Manual.** Start, send, interrupt, a permission, a question and a plan (pane + Discord), take
  over, release, close.
- **Risks.** The sync→async ripple in `conversationHost`. Hidden reliance on synchronous
  `runner.blocks`. The history/ring dedupe design is only exercised in Stage 3.
- **Completion.**
  - `grep -rn "RunnerSession\b" src` finds nothing outside tests.
  - Typecheck and tests are green, `app:install` is done, and manual passes.
- **Rollback.** Revert the merge. No persisted format changes.
- **Commits.**
  1. `sessionProtocol` types
  2. `ClaudeSdkSession` + tests
  3. `RunnerView` + tests
  4. handles + executors
  5. UI/`createApp` call sites
  6. F3
- **PR.** Own PR.

```text
Recommended model: Opus
Recommended effort: High
Why: cross-cutting refactor; ClaudeSdkSession's surface becomes the wire protocol in Stage 3.
When to escalate: if the execution/translation seam or snapshot/seq semantics won't settle → Extra High.
Review checkpoint: CP1 (Opus Extra High) on ClaudeSdkSession + sessionProtocol types before merge.
```

### Stage 2: Session registry and explicit lifecycle (still in-process)

- **Goal.** AW knows every session it owns, can say what happened to each one after any restart,
  and quit is explicit and non-blocking for scripts.
- **Change.**
  - `SessionRegistry` replaces `RunnerRegistry`, covering Claude and Codex with launch options,
    repo, worktree and state (§10).
  - Previously-live records become **Interrupted** rows with Resume, for **all** of them.
    Newest-only auto-resume stays behind its setting. **Resume keeps today's
    `running-elsewhere` guard:** if the id is live in the Claude registry it goes through
    take-over, never a second process on the transcript (the CLI has no lock; S1, §7.3).
  - Quit:
    - the menu ⌘Q item sets `quitSource = 'menu'`. It must be a **custom item** with
      `accelerator: 'CmdOrCtrl+Q'`, not `role: 'quit'`, which bypasses the click handler (S2);
    - with live agents it shows "Quit and stop N agents?";
    - **non-menu quits never show a dialog** and do an awaited, bounded (≤10 s) graceful end;
    - `before-quit` → `preventDefault` → end → `app.exit()`.
  - A SIGTERM handler (non-interactive) that flags `quitSource = 'signal'`, **registered inside
    `whenReady`**: one registered at module load is replaced by Electron's own handler and never
    runs (S2). Electron already turns SIGTERM into a graceful quit, so the handler only labels it.
  - `render-process-gone` reloads the workbench.
  - `install-app.sh` polls for exit (not `sleep 2`), matches the exact main-executable path, and
    writes `run/quit-intent` (`install`) before it quits the app, so the core can tell an install
    from any other external quit.
- **Files.**
  - New: `src/core/session/sessionRegistry.ts`, `src/core/session/recovery.ts` (pure
    classification), `src/core/session/quitPolicy.ts` (pure).
  - Modified: `src/claude/runner/runnerRegistry.ts` (a migration shim, then deletion),
    `src/app/createApp.ts`, `src/electron/main.ts`, `src/electron/menu.ts`,
    `src/electron/workbenchWindow.ts`, `scripts/install-app.sh`, `src/shared/model.ts`
    (`interrupted?`), `src/shared/rowMenu.ts` + `src/webview/dashboard/main.ts` (Resume),
    `src/shared/settings.ts`, README.
- **Tests.** Registry transitions and migration, the `recovery` classification table,
  `quitPolicy`.
- **Manual.**
  - 3 runners → ⌘Q → dialog → Stop → relaunch → 3 Interrupted rows → Resume one.
  - `app:install` → no dialog, and no `rm -rf` of a running app.
  - Renderer `process.crash()` → reload.
- **Risks.** `preventDefault` loops. Menu vs Apple Event quit detection (S2 verifies).
- **Completion.** No session disappears silently on any restart. The install never blocks.
- **Rollback.** Old key readable for one release.
- **Commits.**
  1. registry + migration
  2. Interrupted rows
  3. quit policy + awaited shutdown
  4. non-interactive quit + install script
  5. renderer reload
- **PR.** Own PR.

```text
Recommended model: Opus
Recommended effort: High
Why: Electron quit sequencing is subtle; recovery semantics defined here carry into Stage 4.
When to escalate: quit-source detection or SIGTERM handling misbehaves → Extra High.
```

### Stage 3: The Claude session host (out-of-process, behind a setting)

- **Goal.** A Claude session AW starts outlives the core, and the core reattaches.
- **Change.**
  - A `dist/sessionHost/main.js` esbuild entry. The host:
    - wraps **`ClaudeSdkSession`** (from Stage 1) and serves protocol v1 (§9) on a UDS;
    - is spawned detached from the cloned runtime;
    - gets its token over stdin, logs to a file, writes its manifest after `listen`;
    - handles SIGTERM/SIGINT/SIGHUP by SIGTERMing `claude` at once (§7.1);
    - passes an explicit env to `claude` (minus `ELECTRON_*`, `AW_*`, `__CFBundleIdentifier`,
      `XPC_SERVICE_NAME`).
  - `HostSupervisor` in the core: runtime clone + GC, spawn, connect, `hello`, snapshot,
    subscribe, reattach. The clone is re-signed with the stable certificate after the rename
    (§11.7), and **before relying on it**, S2's install scenario (quit, `rm -rf`, `cp -R` of a new
    build, relaunch, reattach) plus a `~/Documents` read from the host's `claude` are run once on
    a certificate-signed build and recorded in the merge notes.
  - Large frames: no `JSON.parse` of a multi-MiB frame on the main thread in the same tick as UI
    work (S3: 2–3 s for 16 MiB); decide here between off-thread parsing and not inlining large
    images.
  - `RemoteClaudeHandle` = `RunnerView` fed by the socket.
  - Manifests are scanned **before** the first provider scan (§7.3 step 1).
  - Permission routing is host-first for hosted sessions.
  - The ndjson peer is extracted from `CodexAppServer`.
  - Setting `experimental.sessionHosts` (default **off**). With it on, ⌘Q leaves hosts running
    and ⌥⌘Q stops them. Happy-path reattach. Everything else is classified `unreachable` or
    `interrupted`, conservatively.
- **Files.**
  - New: `src/sessionHost/main.ts`, `server.ts`, `ring.ts`, `manifest.ts`, `env.ts`;
    `src/core/rpc/ndjsonPeer.ts`; `src/core/session/hostSupervisor.ts`, `runtimeClone.ts`,
    `remoteClaudeHandle.ts`.
  - Modified: `src/codex/appServer.ts`, `esbuild.mjs`, `electron-builder.yml`,
    `src/app/createApp.ts`, `src/shared/settings.ts`, `src/electron/menu.ts` (⌥⌘Q).
- **Tests.**
  - Codec and framing (partial lines, 16 MiB).
  - Server over an in-memory duplex: `hello`/token, snapshot, subscribe, resync, overflow,
    settle-once, idempotent send.
  - **Process integration** (vitest, real UDS, real detached processes; `AW_SESSION_HOST_FAKE=1`
    swaps in a fake `QueryFn` that spawns a dummy child and scripts messages and asks):
    - the supervisor disposes and the host survives;
    - a new supervisor reattaches from the manifest;
    - an ask is answered after reattach;
    - `end` leaves no process.
  - A live test gated by `AW_LIVE_CLAUDE=1` (a tiny turn; output never pasted anywhere). Once,
    with AW's `PermissionRequest` hook installed, it records what a mid-ask orphan does
    (§11.5).
- **Manual.**
  - Setting on: two conversations, one mid-turn → ⌘Q → wait → relaunch → both live, and the
    mid-turn one finished meanwhile.
  - `kill -9` the core → reattach.
  - `app:install` mid-turn → reattach.
- **Risks.** Token-handoff races. Runtime clone correctness. Env leakage. The history/ring uuid
  dedupe.
- **Carried from the Stage 1 CP1 review, to settle before CP2 freezes v1:**
  - **One source of lifecycle.** `RunnerView` derives its lifecycle from the SDK messages it
    reduces and ignores the host's `state` events. In-process they agree; a view rebuilt from a
    snapshot after a `resync` has no messages to derive from and would sit in `starting`. Make the
    host's `state` (which already counts queued turns) authoritative and seed the view from
    `snapshot().state`.
  - **Identity over the wire.** `ClaudeExecution` reads `cwd` and `startedAt` off the execution
    object. Over a socket they come from `hello` (and belong in the manifest), not from properties.
  - The in-process rings are 1 MiB (`localClaudeHandle.ts`); the host uses the 16 MiB default.
- **Outcome of the carry-overs (2026-09-24).**
  - Lifecycle: the host's `state` is authoritative except while the view is ending, ended or
    failed. Every catch-up ends by reconciling with the snapshot: its state, its pending asks
    (synthetic `ask` / `askSettled` for any that were evicted), and its exit.
  - Identity: `cwd`, `startedAt` and the pids come from `hello` and the manifest.
  - Rings: 1 MiB in-process, 16 MiB in the host, as planned.
- **What else Stage 3 settled.**
  - Adopt dedupe is **by position**: every `assistant`/`user` message up to and including the
    last ring message whose uuid is in the transcript read is dropped. A uuid set alone missed
    older ring messages outside the 512 KiB transcript tail (CP2 B2). Messages from another
    `session_id` (a `/clear` inside the ring) are dropped too.
  - Start times are read with `ps -o lstart` under `TZ=UTC LC_ALL=C`, so a time-zone or
    locale change never makes a live host look dead (CP2).
  - The client stops retrying on an unauthorized or protocol-mismatch `hello` and shows the
    session unreachable. Calls wait for the link for a bounded time, and transport errors
    propagate, so a card stays answerable. `end` falls back to a start-time-checked SIGTERM
    of the host.
  - A dead host with no exit record keeps its manifest for 7 days (it names the agent pid the
    Stage 4 sweep needs). A live host whose manifest version this build does not know is
    *foreign*: its session counts as held, it is never adopted, and its files are never
    collected.
  - Dead hosts at startup: `ended` → ended; `stopped` / `signal` → interrupted (resumable);
    anything else → failed.
  - The live test (`AW_LIVE_CLAUDE=1`) passed. A mid-ask orphan with AW's
    `PermissionRequest` hook installed: **the agent exited within 10 s** of its host being
    killed, so it doesn't sit waiting on the hook (§11.5).
  - The re-signed clone verifies with `codesign --verify`, and a host runs from inside its
    `app.asar` (manifest, `hello`, `ping`, SIGTERM exit recorded). The install-survival and
    `~/Documents` read are in James's manual matrix below.
  - `electron-builder.yml` records that the RunAsNode fuse must stay on (§11.7).
  - `runtimes/` and `run/` are shared with the Codex server (Stage 5). Runtime GC removes only
    directories holding `Agent Wrangler Host.app`, never `codex-*`, and the manifest scan
    ignores `codex-host.json` (it has no `hostId`).
- **Completion.** The manual matrix passes 3× in a row, there are no orphan processes after ⌥⌘Q,
  and typecheck and tests are green.
- **Rollback.** Setting off means the Stage 1 in-process executor. Running hosts stay stoppable
  from a host list.
- **Commits.**
  1. ndjson peer (+ Codex refactor)
  2. protocol types + wire fixtures
  3. host server
  4. host entry, manifest, env, signals
  5. runtime clone
  6. supervisor + remote handle
  7. `createApp` wiring, routing, setting
  8. integration tests
- **PR.** Own PR. Possibly split into (1)–(2) and then the rest.

```text
Recommended model: Opus
Recommended effort: Extra High
Why: new process boundary, IPC, detached spawn, token handoff, reattach — the heart of the initiative.
When to escalate: already max; add a second review if the certificate-signed clone check fails.
Review checkpoint: CP2 (Opus Extra High) freezes protocol v1 + manifest v1 before the host server merges.
```

### Stage 4: Recovery, orphans, drift; hosts on by default

- **Goal.** Every row of §8 behaves as specified. The gating acceptance test passes.
- **Change.**
  - §7.3 cases 2–4.
  - Start-time guards (`endProcess`, supervisor).
  - The orphan-`claude` sweep, as amended in §7.3: before every resume or adopt, with the
    ppid/`procStart`/manifest identity check and wait-for-exit.
  - S2's manual procedures: M1 and M2 passed on 2026-09-24 (§11.10). M3 (logout) is deferred;
    run it once on the real hosts during the soak if a logout can be spared, otherwise watch
    for orphans or unexpected Interrupted rows after logouts.
  - Exit records, drain and tombstone GC.
  - The idle-orphan rule.
  - Bounded-drift migration on idle send (§7.4).
  - Incompatible-major handling.
  - `powerMonitor` resume (heartbeats + Discord reconnect).
  - `powerSaveBlocker` while busy.
  - The `AGENTWRANGLER_HOSTED` hook behaviour, on by default (decided §22).
  - Docs:
    - README (quitting, security note);
    - `product-context.md` §5 principle 1;
    - CLAUDE.md's "Never restart the app automatically" / "quitting ends every session". After
      this stage a restart no longer ends sessions. Relaxing the rule is the maintainer's call.
  - A one-week dogfood soak, then flip `experimental.sessionHosts` on, then remove the setting.
- **Files.** `src/core/session/hostSupervisor.ts`, `recovery.ts`, `src/claude/runner/adopt.ts`,
  `src/core/procTree.ts` (`lstart`), `src/sessionHost/*`, `src/claude/hookInstall.ts`,
  `src/remote/discord/gateway.ts` (resume hook), `scripts/install-app.sh`, docs.
- **Tests.** The §16 lifecycle suite.
- **Manual.** The §16 manual rows, including sleep/wake, logout, and the gating acceptance test.
- **Risks.** GC deleting a live manifest. The orphan rule ending a wanted session. The migration
  killing a background shell (guarded).
- **Completion.** Every automated §16 row is green, and the manual rows are recorded once in the
  merge notes.
- **Rollback.** The default flip is its own commit and merge.
- **Commits.**
  1. start-time guard
  2. classification
  3. exit/drain/GC
  4. orphan sweep + idle rule
  5. drift migration
  6. power handling
  7. hook `HOSTED` mode
  8. suite
  9. docs
  10. default flip, separately
- **PR.** Own PR, and the default flip after the soak.
- **Outcome (2026-09-24, #15; the soak, CP3 and the flip are still to come).**
  - **Start-time guards.** `endProcess` takes the start time the caller knows (Claude Code's
    `procStart`, a manifest's `hostStartTime`) and never signals a pid it cannot prove is that
    process: a reused pid is "already gone", an unreadable start time is "refused". Take-over,
    Close and Stop host all pass one.
  - **Classification.** Dead hosts' exit records are read *before* the interrupted list is built
    (`outcomesFromDeadHosts` → `classifyOnStartup`), so auto-resume can no longer pick a session
    whose host ended, failed or was parked while the app was away. No record → `interrupted`
    with reason `host lost`, which is offered on the row but never auto-resumed. A record the
    app had already stopped (Close) keeps its own state. A live host this build cannot follow
    (foreign manifest) holds its session: take-over and resume are refused and **Stop host**
    (start-time-checked SIGTERM of the host, which ends its agent gracefully) is offered;
    Close does the same.
  - **The sweep** (`orphanSweep.ts`) runs, one at a time per id, at startup for every dead host
    with no exit record (its manifest is forgotten once the id is clear), when a host is lost
    while the core is up, and before every resume: `RunnerService.resume` is the one way to
    resume a Claude id (take-over and Resume here, auto-resume, a migration), and a terminal
    resume sweeps too. An entry with no `procStart`, or one whose start time cannot be read, is
    treated as an owner: never killed, and it blocks the resume.
  - **GC.** Besides manifests (with an exit record at once, without one once swept or after 7
    days) and runtimes: host logs 14 days after their host has no manifest, and tokens with no
    manifest after a day (a host that never came up). An answered `end` counts as delivery of
    the exit, so a migrated host exits at once instead of after the 60 s drain.
  - **Idle-orphan rule** in the host (`idleRule.ts`): `process.hrtime` (stands still in sleep),
    checked every minute; clients are authenticated connections. The hours come from the boot
    line and `configure`, pushed on every connect and when the setting changes.
  - **Drift.** `RunnerView` swaps its execution in place: on an idle send (host state idle, no
    pending ask, no background tasks in `latest`) to an outdated host it stops listening to the
    old host, ends it (§7.1), sweeps, spawns a host of this build resuming the same id with the
    view's current model, mode and effort, and sends there. The pane never rebinds. A failure
    leaves a note and an ended, resumable session. No "older build" badge yet.
  - **Power.** `powerMonitor` `resume` → every `HostClient` forgets missed pings and pings now,
    and the Discord gateway drops its socket and resumes at once. `powerSaveBlocker` is #18's
    (`shouldPreventAppSuspension`: working, or holding a permission ask).
  - **Permissions.** Hook script v2 exits after logging when `AGENTWRANGLER_HOSTED=1`; the app
    rewrites an installed older script at startup (it is AW's own file). Host-held permission
    asks are put on the row and the remote by `withHostedPermission`, keyed by the host's
    request id, and `decidePermission` answers that id through the host.
  - **Tests.** `orphanSweep`, `hostRecovery` (classification, idle rule, GC, hosted
    permissions), `adopt` (pid reuse), the hook script end to end in hosted mode, gateway wake,
    and `sessionHostRecovery.integration`: a SIGKILLed host's real orphan swept and a resume
    left alone on the id; a drift migration in one view; a busy session not migrated; the idle
    rule parking only once nothing is connected, with its hours set through `configure`.
  - **Second read (Opus, before merge).** Fixed: a hosted row now shows the host's ask, not the
    hook's copy of another prompt; `end` and a migration wait for the old host (and so its
    agent) to be gone before sweeping; Release sweeps before the terminal resumes; a dead host
    older than the record's `liveSince` no longer decides it; a host SIGTERMed by Stop host gets
    10 s (it gives its agent 5); Stop host refuses without a recorded start time; ambient tasks do not count; the script refresh never downgrades; a
    recordless host the machine has booted since is a restart (auto-resumable), not a crash; a
    Close or quit during a migration ends or lets go of the new host. Left for the soak/CP3:
    `AGENTWRANGLER_HOSTED` is inherited by everything a hosted agent runs (a nested `claude`
    loses the file path; not a way in); the sweep's ppid-1 rule would also end a deliberately
    headless `claude` on the same id (a lost manifest's `agentPid` could prove ownership); an
    unreachable host during an answer reads as "no longer waiting"; #18's power block counts a
    parked permission ask, so one left overnight holds off idle sleep.
  - **Not done here:** the §16 manual rows and the gating acceptance test (James's, during the
    soak); M3 (logout); CP3; the default flip and removing the setting; staggering the replay of
    several busy hosts at startup (§15.2 open item).

```text
Recommended model: Opus
Recommended effort: Extra High
Why: failure recovery, pid reuse, GC and version drift are where subtle systemic bugs live.
Review checkpoint: CP3 (Opus Extra High) — failure-matrix review after the soak, before the default flip;
                   plus a second Opus Extra High read of the GC/classification code.
```

### Stage 5: Codex execution decoupled

- **Goal.** AW-run Codex threads, including in-flight turns and pending approvals and
  questions, survive core restarts.
- **Change (amended by S4, `spikes/s4-codex-restart.md`).**
  - The supervisor launches **one** detached `codex app-server --listen unix://<path>` (it
    creates its real socket, mode 0600, under `/tmp/codex-daemon-<uid>/`, and `<path>` becomes
    a symlink). It launches from a **pinned copy** of the extension's `bin/<platform>/`
    directory under `runtimes/codex-<version>/`, never from the live extension directory,
    which VS Code prunes. The manifest holds pid, socket path, binary path and the version
    from `initialize.userAgent`. `stdout`/`stderr` go to a log file, never to a pipe.
  - **The transport is WebSocket over the Unix socket** (one JSON-RPC message per text frame).
    `CodexAppServer` gets a small in-repo RFC 6455 client (about 100 lines; see
    `spikes/s4/wsUnix.ts` on the spike branch), with no new dependency. `ndjsonPeer` is not
    reused for this hop, and `proxy` is not used.
  - **On reconnect:** run `thread/loaded/list`, then `thread/resume` every registry-live
    Codex thread that is still loaded (or on disk). Rebuild pending cards from the
    `*requestApproval` / `requestUserInput` requests the server **re-sends after each resume,
    with their original ids.** Dedupe by `(server instance, id)`, since ids restart at 0 when
    the server restarts. Rebuild the transcript from `thread/turns/list` or `thread/items/list`
    (`excludeTurns: true`, since full hydration is deprecated). Expect no replay of the gap's
    deltas: create an item's block from its `item/completed` when no `item/started` was seen.
  - **Handle `serverRequest/resolved`**, which `runner.ts` ignores today: another subscriber
    (a second window, Discord, or a pre-restart core) may have answered first.
  - **`already has an active writer` on resume** means the thread is open in another
    app-server, usually the VS Code extension. Mark it "open elsewhere", read-only, and do not
    retry. The lock frees about 60 s after the other side goes idle with no subscribers.
  - **Host stop:** `SIGTERM` drains without limit while a turn is pending. The supervisor sends
    `SIGTERM` only when no thread is `active`, and otherwise uses `SIGINT` (this interrupts
    turns; say so in the UI). A **Codex version change** means a host restart, which loses
    in-flight turns and pending asks. Do it only when idle, or on the user's command, and never
    automatically mid-turn.
  - A Codex conversation with no turns yet cannot be resumed after a restart. Drop it from the
    registry instead of showing an error.
  - **Not** the machine-wide `codex app-server daemon`. It cannot run from the extension's
    binaries, the `codex` TUI attaches to it by default, anyone can restart or update it, and
    each restart injects a recovery turn.
  - Codex sessions are already in `SessionRegistry` from Stage 2.
  - **What users are told:** Codex approvals and questions survive an Agent Wrangler restart.
    Updating Codex restarts the host, which ends the running turn, and they re-send.
- **Files.** `src/codex/appServer.ts` (transport seam: stdio | ws-unix), `src/codex/wsClient.ts`
  (new), `runner.ts` (replayed requests, `serverRequest/resolved`, completed-only items),
  `codexHandle.ts`, `binary.ts` (copy and pin, version from `initialize`),
  `src/core/session/hostSupervisor.ts`, `createApp.ts`, settings.
- **Tests.** Reconnect with an injected transport; a resume-replay fixture (the request re-sent
  with the same id after resume, then answered on the new connection); `serverRequest/resolved`
  clears a card; the writer-lock error maps to "open elsewhere"; id dedupe across a server
  restart.
- **Manual.**
  - Codex mid-stream → ⌘Q → relaunch → live, with the reply completing.
  - Codex waiting on approval → ⌘Q → relaunch → the same card, still answerable.
  - The same thread opened in the VS Code extension while AW's host has it loaded → "open
    elsewhere", and after about 60 s idle it is resumable in VS Code.
- **Risks.** Protocol drift between the pinned server and AW's client; the server version is
  recorded in the manifest. An undrainable `SIGTERM`. The same-uid socket can answer any
  approval (§12).
- **Open (not blocking).** Whether `thread/read` works on a thread another app-server holds;
  whether AW's host should lower `thread_unload_delay_secs` to hand threads back to VS Code
  sooner (a product choice).
- **Rollback.** A setting to go back to `--stdio`.
- **PR.** Own PR. Can run in parallel with Stages 3–4 once Stages 1–2 have landed.
- **As built (#17, 2026-09-24).**
  - The supervisor is `src/codex/codexHost.ts` (`CodexHost`), not
    `src/core/session/hostSupervisor.ts`. It is Codex-specific, and keeping it apart keeps it
    out of Stage 3's way. The manifest is `run/codex-host.json` and the socket path is
    `run/codex-app-server.sock`, both under the app's data directory (`HostServices.dataDir`,
    new). A reused pid is caught by comparing `ps -o lstart=`.
  - Only a binary inside an `openai.chatgpt-*/bin/<platform>/` bundle is pinned (APFS clone,
    `fs.cpSync` with `COPYFILE_FICLONE`). An explicit path elsewhere (Homebrew) runs in place,
    since copying its directory would copy `/opt/homebrew/bin`. Old `runtimes/codex-*` are
    removed at the next launch.
  - The transport seam is `CodexConnector` (`stdioConnector` | `hostConnector`) in
    `appServer.ts`. Every connection after the first fires `onReconnect {restarted}`, with
    `restarted` meaning a different server process. The stdio child now gets this too: a
    crashed child is relaunched on the next request, and its threads are resumed.
  - At startup every Codex record the restart interrupted is resumed, not only the loaded
    ones. An idle thread unloads about 60 s after the last client leaves, so after a quit
    `thread/loaded/list` holds only the threads that were running or waiting. Loading the rest
    again from disk costs nothing, and none of them had anything in flight.
  - Card ids carry the server instance (`codex-approval:<pid>@<startedAt>:<id>`). A re-sent
    request whose card exists keeps that card. One this side answered but whose answer never
    arrived goes back to pending.
  - Requests that arrive before their runner exists are held by the service and handed over
    when the runner is tracked. The server sends re-sent asks in the same breath as the resume
    response.
  - The history after a reconnect is re-read from the rollout at `thread.path`
    (`readRolloutBlocks`), not from `thread/turns/list`. It is the reader adoption already
    uses. The pane re-reads on `reset`.
  - Version change: `CodexHost.outdated()` compares the resolved binary's `--version` with
    the server's. At startup, an outdated server with no active thread is sent `SIGTERM`, and
    the connection relaunches it on the new binary. **Agents → Restart Codex Server…** does it on
    demand, and asks first when it would interrupt anything (`SIGINT`).
  - Setting `codexRunner.keepAcrossRestarts` (default on; read at startup). When it is off, a
    background server left from before is stopped if it is idle, and otherwise left running.
  - Checked against the real `0.155.0-alpha.16.3` with an isolated `CODEX_HOME`: pinned
    launch, WebSocket `initialize`, the server surviving the client, and the exact
    `no rollout found` text. **The three manual acceptance checks passed on 2026-09-24**
    (installed build): mid-turn ⌘Q, pending approval across ⌘Q, and the VS Code writer lock.
  - Not done: lowering `thread_unload_delay_secs` (still the default 60 s), and any idle-exit
    rule for the server (it runs until stopped; it holds nothing when idle).

```text
Recommended model: Opus
Recommended effort: High
Why: reconnect semantics against a third-party protocol; well-specified once S4 is done.
When to escalate: approval re-delivery is ambiguous → Extra High.
```

### Stage 6: Windowless core (the "daemon" this repo actually needs)

- **Goal.** "UI closed, agents running" is visible and useful without a window.
- **Change.**
  - Hide the Dock icon when the last window closes (`app.dock.hide()`), and show it on reopen.
  - A `Tray` menu-bar item: counts (busy, waiting, blocked), the host list with Stop, Open,
    ⌥⌘Q.
  - Electron `Notification` for waiting, blocked and done, where a click opens the session.
  - An opt-in login item (`setLoginItemSettings`). That is not an auto-restart.
- **Files.** `src/electron/tray.ts` (new), `main.ts`, `electronHost.ts`, `workbenchWindow.ts`,
  `src/shared/settings.ts`, preferences.
- **Tests.** Pure label formatter. The rest is manual.
- **Completion.** With the window closed, a permission ask gives a clickable notification plus a
  tray badge, and Discord answers it.
- **PR.** Own PR. Parallel with Stages 4–5; useful as soon as Stage 2 lands. Also unblocks the
  in-app option in `scheduled-agents.md`.

```text
Recommended model: Sonnet
Recommended effort: High (Medium for notification wiring)
Why: UI/shell wiring over settled core state.
When to escalate: App Nap / power / dock-hide interactions misbehave → Opus High.
```

### Stage 7: UI/core process split (decision gate; likely never)

- **Gate.** Proceed only if a front end that is not Electron must orchestrate while the app is
  **fully quit**, or if launch-at-login without an Electron process becomes a requirement.
- **If proceeding:**
  - a headless `HostServices`, with dialogs becoming client RPC with non-interactive defaults;
  - a secrets decision (an Electron-windowless daemon vs Keychain);
  - the single-instance lock moves to the daemon (pidfile + socket probe);
  - the leader lease from `remote-agent-control.md` §6 returns if two cores are possible;
  - `DashboardHost`/`ConversationHost` over `EnvelopeTransport` across `run/core.sock`.

```text
Recommended model: Opus
Recommended effort: Extra High
Review checkpoint: CP4 (Opus Extra High) at the gate.
```

### Stage 8: The `aw` CLI (a client, never a supervisor)

- **Goal.** `aw status | sessions | session <id> | attach <id> | send <id> <text> | stop <id> |
  projects`.
- **Change.**
  - The core serves `run/core.sock` (§9.10). It is served by Electron main, so the CLI needs the
    app running.
  - `aw status` / `aw sessions` fall back to reading manifests and the registry **read-only**
    when the core is down, which answers "what is still running?" after a quit.
  - `attach` is a read-only event stream, rendered by the CLI with the core's `RunnerView`
    output.
  - `send` and `stop` go through `SessionActions`.
- **Files.** `src/cli/main.ts` (new), `src/core/controlSocket.ts` (new), `bin/aw` shim.
- **Tests.** Parsing and formatter fixtures.
- **PR.** Own PR.

```text
Recommended model: Sonnet
Recommended effort: High (Medium for later commands)
Review checkpoint: Opus High review of the control-socket API (it is forever, like §9).
```

**Outcome (2026-09-25, #21).** Built ahead of Stage 4's default flip: the CLI depends on the
manifests, registry and recovery code that merged in 257a119, not on the flip.

- **Files as built.** `src/core/control/{protocol,server,paths}.ts` (wire types, server,
  socket and token paths), `src/app/controlBackend.ts` (the methods over the app's services),
  `src/cli/*` (args, client, formatters, attach renderer, offline reader), `bin/aw`,
  `scripts/install-cli.sh` (`npm run cli:install`).
- **Auth.** Same shape as a host: 0600 socket in the 0700 `run/`, and a 256-bit token in
  `run/core.token` (0600), new at every launch, presented in `hello`. If `run/core.sock` is over
  the 103-byte limit, the socket falls back to `~/.agentwrangler/run/`, like host sockets do.
- **What is frozen in control protocol v1.** Method names and params, the listed result fields,
  the error codes (`-32004` not found, `-32005` ambiguous with `data.matches`, `-32006`
  unsupported, plus the host protocol's), and the `session.event` / `session.closed` envelopes,
  which carry the session `key` so a later version can allow more than one subscription. Additions
  within v1 go through `hello.capabilities`, which is empty today. Enumerations may grow, as in
  §9.5, and readers show unknown values as-is. The wire declares its own status, lifecycle and
  outcome unions, and the backend checks at compile time that the UI's unions fit inside them.
  `subscribe` returns at most `maxBlocks` blocks (default 50, cap 200).
  **Not frozen:** the `ConvBlock` / `SessionViewEvent` payloads inside `subscribe`. Only the
  same-bundle CLI may parse them. The CLI ships in the app bundle and runs on the app's own binary (`ELECTRON_RUN_AS_NODE`,
  `exec -a aw`, so `install-app.sh`'s `pgrep` never takes it for the app), and `hello` reports
  the app's build so a mismatch is flagged.
- **`send`** goes to the session's handle, as the pane's composer does. It is only for sessions AW
  runs; for anything else it answers `-32006` and does not adopt. **`stop`** is the menu's
  Stop… minus the dialog: `confirmAndCloseSession` was split so that both call
  `closeSessionNow`. A session mid-turn is left alone unless `--force`. The app flashes a notice
  on every `send` and `stop`, and logs the method and session, never the content.
- **§12's injection concern.** The CLI refuses `send` and `stop` when its environment shows it is
  running under an agent (`AGENTWRANGLER_HOSTED`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
  `CODEX_SANDBOX*`, `CODEX_THREAD_ID`). This is a speed bump for the over-eager or injected
  agent, not a wall: the token file is readable by the same user, as host tokens are. The CLI
  strips control characters from everything it prints, because agent-written text reaching the
  terminal is an injection path of its own (OSC 52 writes the clipboard).
- **Opus High review (CP for Stage 8), 2026-09-25.** Verdict: sound, and no easier for one
  agent to drive another than before. Fixed from it:
  - `attach` reported `gone` after a compaction, because it looked the handle up by its old id;
  - the wire unions and forward-compat fields above;
  - escape stripping;
  - an `'error'` listener on the server, so an accept failure can't crash the main process;
  - `send`/`stop` refused once a quit is committed;
  - the client's name and pid in the audit log, and `subscribe` logged too;
  - `runBy: hosted` for held-but-unfollowed hosts;
  - owner and mode checked on the fallback socket directory;
  - stray arguments rejected (`aw stop x -f` no longer stops without force).

### Follow-ups (outside the critical path)

- **F1 (feature):** warn when two live sessions share one checkout. Any time, and better after
  Stage 2.
- **F2 (spike, done 2026-09-24, #23):** how agents acquire exclusive resource leases (Unity
  Editor). Verdict: a `PreToolUse` hook on declared resources, lease files as the lock of
  record, a core `LeaseService` for policy (`spikes/f2-resource-leases.md`, §6.1).
- **F3 (bug):** the runner card stays pending when a permission is answered through the hook.
  Folded into Stage 1.

---

## 14. Per-stage model and effort recommendations

| Stage | Model | Effort | Why | Escalate when |
|---|---|---|---|---|
| S0 spikes S1, S2, S4 | Opus | High | OS and CLI process behaviour decides the architecture | a result contradicts §11 → Extra High gate |
| S0 spikes S3, S5; characterization tests | Sonnet | High / Medium | bounded measurements; tests over existing code | n/a |
| 1 execution/translation split + `SessionHandle` | Opus | High | its surface becomes wire protocol v1 | the seam or seq semantics won't settle |
| 2 registry + explicit lifecycle | Opus | High | Electron quit sequencing; recovery semantics | quit detection misbehaves |
| 3 Claude session host | Opus | **Extra High** | IPC, detached spawn, tokens, reattach | — |
| 4 recovery, orphans, drift, default-on | Opus | **Extra High** | failure recovery, pid reuse, GC | — |
| 5 Codex decoupled | Opus | High | third-party reconnect semantics | approval re-delivery ambiguous |
| 6 windowless core | Sonnet | High (Medium for wiring) | UI/shell on settled state | App Nap/power issues → Opus High |
| 7 UI/core split (gate) | Opus | **Extra High** | second boundary, secrets, single-instance | — |
| 8 `aw` CLI | Sonnet | High (Medium later) | client over a settled socket | API design → Opus High review |
| Lifecycle integration suite | Sonnet | High | test code over specified behaviour | flaky process tests → Opus High |
| Docs updates | Sonnet | Medium | mechanical | n/a |
| F1 checkout warning | Sonnet | Medium | small feature | n/a |
| F2 lease spike | Opus | High | new orchestration concept | n/a |

These are the models available on 2026-09-23 (Opus 5.5, Sonnet). Re-map by capability tier if
the names change.

---

## 15. Architecture review checkpoints

Switch to **Opus, Extra High** for these, even when the surrounding work runs on Sonnet:

- **CP0, Architecture gate** (after S1–S4). Confirm or amend §5. Specifically: thin-host
  feasibility (uuid dedupe), the runtime clone, the Codex host choice, orphan behaviour. Update
  this document before Stage 1 starts. **Passed 2026-09-24; see §15.1.**
- **CP1, before Stage 1 merges.** `ClaudeSdkSession` and `sessionProtocol` types: serializable,
  provider-native, no `ConvBlock` in the host surface, seq and snapshot semantics.
- **CP2, before the Stage 3 host server merges.** Freeze protocol v1 and manifest v1. Every
  method is forever. **Passed 2026-09-24 after one round of fixes; see §15.2.**
- **CP3, after the Stage 4 soak, before the default flip.** Walk the §8 matrix against real
  behaviour, and give GC and classification a second read.
- **CP4, the Stage 7 gate.**
- **Standing rule.** Any change to `src/shared/sessionProtocol.ts`, the manifest format, or the
  Stage 8 control-socket API gets an Opus High review (Extra High if it is a major bump).

### 15.1 CP0 verdict (2026-09-24, #11)

**§5 is confirmed. Stage 1 may start.** No spike result argues for a different architecture:
thin, detached, per-session Claude hosts that speak the SDK's own protocol, a shared AW-owned
Codex `app-server`, translation and policy in the core, and hosts that survive the core from the
first host stage. The amendments below change how pieces behave, not what the pieces are. They
are already written into the sections named.

| Question | Evidence | Verdict |
|---|---|---|
| Thin host feasible? (uuid dedupe, U2) | S1: SDK `assistant`/`user` uuids are the transcript uuids; a host-set `uuid` is kept | **Yes.** Dedupe `assistant`/`user` only; the rest is ring-only by `seq`; never assume "yielded ⇒ on disk" (§5.1, §11.5) |
| Can a new `Query` attach to a live CLI? | S1: no; `resume` succeeds and silently forks the transcript | The `Query` lives in the host (§11.3 stands). The **orphan sweep is the only double-owner guard**: before every resume or adopt, orphan = ppid 1 + `procStart` match + no live manifest (§7.3) |
| How to stop an agent | S1: EOF is ignored mid-turn; SIGTERM drops the in-flight message; SIGTERM kills bg shells at once | **Interrupt → grace → stdin close → SIGTERM → SIGKILL** for `end`; SIGTERM `claude` at once on host signals (§7.1). Resolves a contradiction between §7.1, §11.6 and S1 |
| Detached host survives quit, crash, install? (U3) | S2: all unattended scenarios, nine core deaths, two builds | **Yes.** Cloned runtime kept, for name matching, lazy loads and identity (§11.7) |
| Signing, TCC, safeStorage (U5) | S2 measured ad-hoc; #56 has since moved builds to a stable certificate | **Re-sign the clone** with the stable certificate by default, and re-run S2 scenario 7 once on it in Stage 3. Host tokens stay in 0600 files (§10, §11.7) |
| Quit source (U4) | S2: no reason in Electron 44; SIGTERM already becomes a graceful quit; a module-load SIGTERM handler never fires | Flag menu (custom Quit item, not `role: 'quit'`) and signal (handler inside `whenReady`); install announces itself; the rest is external (§11.10). Applies to Stage 2 |
| Transport sizing (U6) | S3 | **§9 stands.** 4 MiB queue, 16 MiB ring, 10 s × 3 heartbeat; `messages` pages well under the queue, `nextSeq` = where the page stopped |
| Codex host (U7) | S4 | **Option (a)**, WebSocket over UDS, pinned binary copy; pending asks re-sent with the same id after `thread/resume`; writer lock → "open elsewhere" (§11.8, Stage 5) |
| Claude bg agents (U8) | S5: PTY-only, no structured channel | **No.** §5 unchanged |
| App Nap (U9) | S2: none in 150 s | Not a blocker; `powerSaveBlocker` only while busy |
| `PermissionRequest` hook and a mid-ask orphan (S1 open item) | not measured | **Not a blocker** (§11.5): visible and answerable until Stage 4, then `AGENTWRANGLER_HOSTED` removes it; Stage 3's live test checks it once |

**Still unmeasured, and where each is due:**

- S2 manual procedures: **M1 (real ⌘Q, Dock Quit) and M2 (sleep/wake) passed on 2026-09-24**
  (§11.10). M3 (logout) is deferred and assumed to match the SIGTERM proxy; revisit at CP3 or if
  a logout misbehaves. M4 (the TCC dialog) is moot on certificate-signed builds; the
  Stage 3 re-run replaces it.
- A certificate-signed clone surviving an install with `~/Documents` access intact: Stage 3.
  The clone verifies and runs a host (2026-09-24); the install run is in Stage 3's manual matrix.
- A `thread/read` across the Codex writer lock, and `thread_unload_delay_secs`: Stage 5, non-blocking.

**Stage consequences** (the issue bodies are edited to match):

- **Stage 1 (#12):** `ClaudeSdkSession.end` implements the §7.1 sequence and sets `uuid` on
  every send. The in-process app benefits at once: today `RunnerService.dispose` does
  `void s.end()` and relies on the SDK's exit handler, which SIGTERMs mid-stream.
- **Stage 2 (#13):** the Resume button on Interrupted rows keeps today's `running-elsewhere`
  guard and uses take-over for a live owner; the SIGTERM handler goes inside `whenReady`; the
  Quit item is a custom item with `CmdOrCtrl+Q`; `install-app.sh` writes `run/quit-intent`
  before quitting.
- **Stage 3 (#14):** host signal handling and `end` per §7.1; env strips `__CFBundleIdentifier`
  and `XPC_SERVICE_NAME` too; clone re-signed; the signed-clone survival check; no large-frame
  `JSON.parse` on the main thread in the same tick as UI work.
- **Stage 4 (#15):** the sweep per §7.3, at every resume or adopt; M3 if a logout can be spared.
  Wake detection uses `powerMonitor` `resume` (M2: a sleep leaves no timer gap).
- **Stage 5 (#17):** rewritten from S4 (it predated it).

### 15.2 CP2 verdict (2026-09-24, #14)

**Protocol v1 and manifest v1 are frozen** as stated in `src/shared/sessionProtocol.ts` (§9.4,
§9.5). The first review found the shape sound but not ready to freeze: five surface gaps and five
correctness bugs. All ten are fixed, and so are most of the "later" items.

| Area | Finding | Resolution |
|---|---|---|
| Exit record | `signal` meant two things; no `reason`, `code` or `stderrTail` | `reason` enum; the agent's `code`/`signal`; `hostSignal`; a 2000-char `stderrTail` on failures |
| Start times | `ps -o lstart` varies with TZ and locale | Pinned: `TZ=UTC LC_ALL=C` |
| Fail-open | Unknown `control` op succeeded; unknown role was `core` | `-32601` plus `control.<op>` capabilities; unknown role is an observer |
| Versions | Mismatch looked like bad params; foreign manifests were invisible | `-32003` with `{min, max}`. `v`, `hostId`, `hostPid`, `hostStartTime`, `sessionId` and `protocol` keep their meaning in every manifest version; an unknown `v` with a live pid means "held" |
| `subscribe` | An overflowing backlog lost events silently | `RPC_RESYNC` and no stream; semantics pinned in the wire comment |
| Future-proofing | `RawAsk` dropped fields; host-only state was evictable | `ask.options` passthrough; `snapshot.latest` and `snapshot.controls` |
| Small | — | `messages` → `events`; `epoch` on `subscribe`/`events`; client capabilities; `agentStartTime`; `launch` in the manifest; `lost` off the wire |
| B1 | Reconnect storm (~33k `hello`/s) | Link set only after the handshake; fatal errors stop retries |
| B2 | Old turns duplicated after restart | Positional dedupe |
| B3 | Host state not authoritative | Snapshot reconcile at the end of every catch-up |
| B4 | Calls could hang; a transient error expired a card | Bounded wait; errors propagate; SIGTERM fallback for `end` |
| B5 | Gaps weren't reconciled | Synthetic `ask` / `askSettled` / `state` / `exit` from the snapshot |

Not frozen: `HostBoot` (a core only boots a host of its own build).

The "later" items that were fixed: a host never exits with its agent alive; `close` ends sockets
rather than destroying them; the tombstone decides `lost`; a no-exit manifest survives for the
sweep; oversize frames are stubbed; the peer buffers linearly (and Codex no longer uses it: Stage 5
gave `CodexAppServer` its own transports, so the Codex refactor was dropped at merge); a late
host is killed; the exit is delivered once; the quit count excludes errored Codex sessions; the
audit log and the fuse note are in.

**Open, for Stage 4:** adopting several busy hosts replays up to 16 MiB each on the main thread
at startup; and a fake agent that spawns a real child, to test orphan handling.

---

## 16. Testing strategy

Levels:

- **U**: vitest, pure or fake-injected.
- **I**: vitest process integration with real UDS and real detached processes, a fake agent
  (`AW_SESSION_HOST_FAKE=1`: injected `QueryFn` + a dummy child pid), `afterEach` kills by
  manifest, macOS/Linux only.
- **L**: live, opt-in (`AW_LIVE_CLAUDE=1`), self-skipping like `live.integration.test.ts`, output
  never pasted.
- **M**: manual, recorded once per stage in the merge notes.

**The I rows (#16)** are `test/sessionHost.integration.test.ts` (the Stage 3 basics) and
`test/sessionLifecycle.integration.test.ts` (the rest), on the harness in `test/support/`. Both
run in `npm test` (about 35 s, which is most of it) and alone as `npm run test:integration`. A
test fails if it leaves a process behind that it did not declare, and cleanup only signals a
pid whose start time still matches. The fake
agent (`src/sessionHost/fakeQuery.ts`) spawns a real dummy child through the host's
`spawnClaudeCodeProcess`. That child is what makes env hygiene, orphaning, the §7.1 escalation
and "the agent never stalls" real. The orphan-sweep rows are `it.todo` until Stage 4 (#15)
adds the sweep. The suite found that `snapshot.latest` never kept `result`: every result has a
subtype, and `latestKindOf` matched only `type/subtype`. Fixed with #16.

| Scenario | Level | How | Stage |
|---|---|---|---|
| UI closes while agent idle | U + M | executor untouched by window close; manual | 2 |
| UI closes while agent generating | I + M | host keeps streaming with no client; ring grows within bytes | 3 |
| UI (renderer) crashes | M | `process.crash()` in DevTools → reload, panes re-init | 2 |
| UI restarts and reconnects | I | new supervisor instance reattaches from manifests; seq resume | 3 |
| Core ("daemon") crashes | I + M | SIGKILL the test core; hosts survive; new core adopts; manual `kill -9` | 3–4 |
| Core restarts | I | manifest scan before provider scan; `connecting` → `live` | 3–4 |
| Session host crashes | I + L + M | SIGKILL host → `lost` → orphan sweep → `interrupted`; live: real claude mid-tool (S1 regression) | 4 |
| Agent CLI crashes | I | fake agent exits non-zero → exit record, drain, `failed` | 3–4 |
| Permission request while UI closed | I | pending ask with no client; connect → snapshot has it → `respondAsk` applies | 3 |
| Discord response while UI closed | U + M | window closed, core up: remote service → host-first routing. **Core fully quit is not supported until Stage 7 (documented)** | 3 |
| Multiple clients attach | I | two connections: both get events; second answer `stale`; observer can't command | 3 |
| Large output | I | 10 MB tool result + 16 MiB image frame limits; `capBlock` in core | 3 |
| Slow client / backpressure | I | paused reader → queue overflow → `resync` → re-snapshot; agent never stalls (dummy child keeps writing) | 3–4 |
| Machine sleep / wake | U + M | heartbeat logic with a fake monotonic clock + resume event; manual `pmset sleepnow` | 4 |
| AW update / restart | I + M | old-build host + new core fixtures; drift migration on idle send; **gating acceptance test** (§8) | 4 |
| Intentional Stop agent | I | `end` → exit record → registry `stopped`, no process left | 3 |
| Intentional Quit UI (⌘Q) | U + M | `quitPolicy` table; manual both modes | 2–3 |
| Intentional Stop all (⌥⌘Q) | I + M | parallel bounded end; no orphans | 3 |
| Git worktree stays associated | U | registry record keeps `repoRoot`/`worktree` across reattach, resume, drift migration | 2–4 |
| Unity lease stays associated | U (future) | `LeaseService` keyed by session id survives reattach; released on stop/lost | F2 |
| PID reuse | U | injected start times: mismatched pid is never signalled | 4 |
| Stale socket / manifest | I | dead pid → unlink + classify; live pid + dead socket → `unreachable` blocks resume | 4 |
| Protocol mismatch | U | `hello` fixtures for v1 / unknown major | 3–4 |
| Token mismatch | I | wrong token → error + close; nothing readable | 3 |
| Socket path length | U | long-username path → fallback dir | 3 |
| Env hygiene | I | fake agent child dumps env; no `ELECTRON_*`/`AW_*`/token | 3 |
| Double-owner race at startup | I | alive host + stale registry → no `endProcess`, no second resume | 3–4 |
| Logout / reboot | M | once per Stage 4: manifests → `interrupted`, all offered | 4 |

---

## 17. GitHub Project and issue plan

**Conventions used.** These are the existing Project "Agent Wrangler" conventions: the
[Project](https://github.com/users/hammonjj/projects/4) itself, its README, and
`.claude/agents/product-manager.md`. No parallel system was invented.

- Plain, outcome-oriented titles.
- **Exactly one type label**: `bug`, `feature`, `improvement`, `tech-debt`, `chore`,
  `documentation`, plus `needs-info`. This initiative added two labels the brief asked for:
  **`spike`** (a time-boxed investigation whose output is a decision) and **`testing`** (test
  coverage or infrastructure, with no behaviour change).
- Body templates from the product-manager agent: *Problem or opportunity / Desired outcome /
  Scope / Acceptance criteria / Open questions*. Spikes put *Method / Timebox / Output* under
  Scope.
- **Project fields:**
  - Status: Inbox, Ready, In Progress, Blocked, Done.
  - Priority: P0 — Critical, P1 — High, P2 — Medium, P3 — Low.
  - Effort: XS–XL.
  - Area: this initiative is `Providers/Runner`, apart from Stage 6, which is `Other`, and
    Stage 8, which is `Tools/Build`.
- **No Stage field was added.** The stage is stated in each issue body, and ordering comes from
  the epic.
- **The epic** is labelled `tech-debt` (architecture and migration). Every stage issue is
  attached to it as a GitHub **sub-issue**. There is no separate epic label.
- **No milestones.** If they are wanted later: "Survivable sessions" (S0–S4) and "Beyond the
  window" (S5–S8).
- **Follow-up:** the product-manager agent's classification list does not yet mention `spike`
  and `testing`.

**Order and dependencies.**

```text
S1 ─┐
S2 ─┼─► CP0 gate ─► Stage 1 ─► Stage 2 ─┬─► Stage 3 ─► Stage 4 ─┬─► Stage 7 gate
S3 ─┤   (S5 feeds, non-blocking)        │   (+ suite, docs)     └─► Stage 8
S4 ─┘                                   ├─► Stage 5 (needs S4)
T0 (characterization tests) ─► Stage 1  ├─► Stage 6
                                        └─► F1, F2
F3 folded into Stage 1
```

**Created 2026-09-24:** the epic and the seven Stage 0 issues, all independent of unresolved
assumptions:

| Key | Issue | Label | Status | Priority | Effort |
|---|---|---|---|---|---|
| E | [#4](https://github.com/hammonjj/AgentWrangler/issues/4) Decouple agent session lifetime from the Agent Wrangler app | `tech-debt` | Inbox | P1 | XL |
| S1 | [#5](https://github.com/hammonjj/AgentWrangler/issues/5) Measure what happens to a Claude runner when the process holding it dies | `spike` | Ready | P1 | S |
| S2 | [#6](https://github.com/hammonjj/AgentWrangler/issues/6) Prove a detached session host survives app quit, crash and reinstall on macOS | `spike` | Ready | P1 | M |
| S3 | [#7](https://github.com/hammonjj/AgentWrangler/issues/7) Prototype the session-host socket protocol: throughput, backpressure, reconnect | `spike` | Ready | P2 | S |
| S4 | [#8](https://github.com/hammonjj/AgentWrangler/issues/8) Find out whether Codex threads can survive Agent Wrangler restarts | `spike` | Ready | P2 | S |
| S5 | [#9](https://github.com/hammonjj/AgentWrangler/issues/9) Check whether Claude background agents can be driven by Agent Wrangler | `spike` | Ready | P3 | XS |
| T0 | [#10](https://github.com/hammonjj/AgentWrangler/issues/10) Pin today's runner lifecycle behaviour in tests | `testing` | Ready | P2 | S |
| G0 | [#11](https://github.com/hammonjj/AgentWrangler/issues/11) Architecture gate: confirm the session-host design after the spikes | `documentation` | Inbox | P1 | XS |

Issues #5–#11 are sub-issues of #4.

**Implementation issues:** #12–#23, created up front and starting Blocked (§18). G0 (#11)
rewords them if the spikes change the plan.

---

## 18. GitHub issue creation manifest

Every issue ends with: "Playbook: `docs/plans/session-lifecycle-architecture.md` §<n>." The
Area values below were written before the Project's Area options were known. §17 has the actual
mapping, which is `Providers/Runner` for almost everything.

### Create now (done: #4–#11, see §17)

**E. Decouple agent session lifetime from the Agent Wrangler app**
- Type: `tech-debt` (epic, via sub-issues) · Stage: all · Priority P1 · Effort XL · Status Inbox
- Scope: the initiative. It links the playbook and holds every other issue as a sub-issue. The
  body holds a checklist of the stages.
- Acceptance criteria: the gating acceptance test (§8) passes with hosts on by default; the
  Stage 4 docs are updated; the Stage 7 gate is decided.
- Depends on: — · Parallel with: — · PR boundary: none (tracking only) · **Create now**

**S1. Measure what happens to a Claude runner when the process holding it dies**
- Type: `spike` · Stage: S0 · P1 · Effort S · Area Sessions & hosts · Status Ready
- Scope: using the SDK and the bundled binary in a throwaway script, kill the parent (SIGKILL,
  SIGTERM, clean exit) while the agent is idle, streaming, waiting on `canUseTool`, running a
  120 s Bash command, and holding a `run_in_background` shell. Record:
  - whether and when `claude` exits, and whether it orphans;
  - transcript integrity (complete last line), and registry cleanup;
  - background-shell fate.

  Also confirm three things:
  - a new `Query` cannot attach to a live CLI;
  - SDK message `uuid`s match transcript entries (for reattach dedupe);
  - the `sessionId` option for fresh sessions works.
- Acceptance criteria:
  - [ ] a results table in playbook §11/§19;
  - [ ] a verdict on the orphan risk;
  - [ ] a uuid-dedupe verdict;
  - [ ] the script stays on the spike branch only.
- Depends on: — · Parallel with: S2–S5, T0 · PR boundary: docs commit only · **Create now**

**S2. Prove a detached session host survives app quit, crash and reinstall on macOS**
- Type: `spike` · Stage: S0 · P1 · Effort M · Area Sessions & hosts · Status Ready
- Scope: a prototype host (`ELECTRON_RUN_AS_NODE`, detached, token over stdin, UDS, running one
  real SDK session) spawned from an APFS-cloned, renamed runtime of a **copy** of the packaged
  app (never `/Applications`). Survive and measure each of these:
  - window close, menu quit, `osascript` quit, SIGTERM and `kill -9` of the app;
  - `rm -rf` + `cp -R` of the original bundle;
  - sleep/wake;
  - logout (once, expected death, with the SIGTERM handler flushing).

  Also verify:
  - menu-vs-Apple-Event quit detection;
  - the renamed executable under the ad-hoc signature;
  - TCC access to a repo under `~/Documents` after the bundle is replaced;
  - whether safeStorage Keychain re-prompts after a rebuild;
  - App Nap on a windowless core, and `powerSaveBlocker`;
  - fd leakage (`lsof`);
  - the host's RSS.
- Acceptance criteria:
  - [ ] a survival table;
  - [ ] a runtime-location decision;
  - [ ] a token-storage decision;
  - [ ] a quit-detection decision;
  - [ ] measured host RSS.
- Depends on: — (informed by S1) · Parallel with: S1, S3–S5 · PR boundary: docs commit ·
  **Create now**

**S3. Prototype the session-host socket protocol: throughput, backpressure, reconnect**
- Type: `spike` · Stage: S0 · P2 · Effort S · Area Sessions & hosts · Status Ready
- Scope: UDS NDJSON JSON-RPC between two Node processes. Measure:
  - relay throughput of `stream_event` deltas (2k/s);
  - 16 MiB frames;
  - a slow reader with a byte-bounded queue, then `resync`;
  - reconnect-from-seq;
  - heartbeat across sleep;
  - path length with a long username, and the fallback.
- Acceptance criteria:
  - [ ] numbers recorded;
  - [ ] queue and ring sizes chosen;
  - [ ] a go/no-go on UDS + NDJSON.
- Depends on: — · Parallel with: all · PR boundary: docs commit · **Create now**

**S4. Find out whether Codex threads can survive Agent Wrangler restarts**
- Type: `spike` · Stage: S0 · P2 · Effort S · Area Providers · Status Ready
- Scope: compare (a) an AW-launched detached `codex app-server --listen unix://<short>` with
  (b) `codex app-server daemon` + `proxy`. For each:
  - start a thread, drop the client mid-turn, reconnect, `thread/resume`;
  - do notifications resume;
  - are pending `requestApproval`/`requestUserInput` requests re-sent, lost or declined;
  - the writer conflict with the VS Code extension;
  - two binary versions on one machine;
  - daemon update behaviour.
- Acceptance criteria:
  - [ ] a recommendation (a) or (b);
  - [ ] approval-survival semantics documented;
  - [ ] the Stage 5 plan confirmed or amended.
- Depends on: — · Parallel with: all · PR boundary: docs commit · **Create now**

**S5. Check whether Claude background agents can be driven by Agent Wrangler**
- Type: `spike` · Stage: S0 · P3 · Effort XS · Area Providers · Status Ready
- Scope, timeboxed at half a day:
  - `claude --bg` / `claude agents`: which process hosts a bg agent;
  - does it survive its launcher;
  - can it be attached with stream-json + `canUseTool`;
  - how do permissions and questions surface.

  Clean up every bg agent afterwards.
- Acceptance criteria:
  - [ ] a yes/no on "could replace the AW Claude host", with evidence.
- Depends on: — · Parallel with: all · PR boundary: docs commit · **Create now** (non-blocking
  for CP0)

**T0. Pin today's runner lifecycle behaviour in tests**
- Type: `testing` · Stage: S0 · P2 · Effort S · Area Sessions & hosts · Status Ready
- Scope: the Stage 0 characterization tests, plus extracting the pure `shouldAutoResume`.
- Acceptance criteria:
  - [ ] the tests listed in Stage 0 are green;
  - [ ] no behaviour change;
  - [ ] typecheck green;
  - [ ] `app:install` done.
- Depends on: — · Parallel with: S1–S5 · PR boundary: 1 PR · **Create now**

**G0. Architecture gate: confirm the session-host design after the spikes**
- Type: `documentation` · Stage: S0 · P1 · Effort XS · Area Docs · Status Inbox
- Scope: an Opus Extra High review of the S1–S4 results against §5, §9 and §11. Amend the
  playbook, then review and edit the implementation issues #12–#23 below.
- Acceptance criteria:
  - [ ] playbook updated;
  - [ ] §5 confirmed or changed with a reason;
  - [ ] #12–#23 reviewed and edited where the spikes changed the plan.
- Depends on: S1, S2, S3, S4 · Parallel with: T0 · PR boundary: docs commit · **Create now**

### Implementation issues (created 2026-09-24, #12–#23)

These were created up front at the maintainer's request, not held until the gate. They start
Blocked. The gate (#11) now reviews and edits them against the spike results instead of creating
them. **Done at CP0 (2026-09-24):** #12, #13, #14, #15, #16 and #17 were edited per §15.1 (#17
rewritten from S4), and #12 is no longer blocked (#10 and #11 are closed); the spike blockers on
#14 and #17 are satisfied. Blockers are native GitHub issue dependencies, and every issue body carries its scope,
acceptance criteria, blockers, and recommended model and effort.

| Issue | Title | Type | Stage | Priority · Effort · Area | Blocked by |
|---|---|---|---|---|---|
| [#12](https://github.com/hammonjj/AgentWrangler/issues/12) | Split Claude execution from translation behind one session interface | `tech-debt` | 1 (incl. F3) | P1 · L · Providers/Runner | #11, #10 |
| [#13](https://github.com/hammonjj/AgentWrangler/issues/13) | Keep a registry of the sessions Agent Wrangler runs, and make quitting explicit | `feature` | 2 | P1 · M · Providers/Runner | #12 |
| [#14](https://github.com/hammonjj/AgentWrangler/issues/14) | Run each Claude conversation in a session host that outlives the app | `feature` | 3 | P1 · L · Providers/Runner | #13, #5, #6, #7 |
| [#15](https://github.com/hammonjj/AgentWrangler/issues/15) | Make session hosts survive crashes, reinstalls and version drift, then turn them on | `feature` | 4 | P1 · L · Providers/Runner | #14 |
| [#16](https://github.com/hammonjj/AgentWrangler/issues/16) | Add a session lifecycle integration suite for session hosts | `testing` | 3–4 | P1 · M · Providers/Runner | #14 |
| [#17](https://github.com/hammonjj/AgentWrangler/issues/17) | Keep Agent Wrangler's Codex threads alive across restarts | `feature` | 5 | P2 · M · Providers/Runner | #13, #8 |
| [#18](https://github.com/hammonjj/AgentWrangler/issues/18) | Run Agent Wrangler without a window: menu bar, notifications, open at login | `feature` | 6 | P2 · M · Other | #13 |
| [#19](https://github.com/hammonjj/AgentWrangler/issues/19) | Update README, product context and CLAUDE.md for survivable sessions | `documentation` | 4 | P2 · S · Providers/Runner | #15 |
| [#20](https://github.com/hammonjj/AgentWrangler/issues/20) | Decide whether the core ever needs to leave the Electron process | `spike` | 7 | P3 · S · Providers/Runner | #15, #18 |
| [#21](https://github.com/hammonjj/AgentWrangler/issues/21) | Add an aw command-line client | `feature` | 8 | P3 · M · Tools/Build | #15 |
| [#22](https://github.com/hammonjj/AgentWrangler/issues/22) | Warn when two live sessions share one checkout | `feature` | F1 | P2 · S · Table | #13 |
| [#23](https://github.com/hammonjj/AgentWrangler/issues/23) | Decide how an agent acquires an exclusive resource lease (Unity Editor) | `spike` | F2 | P3 · S · Providers/Runner | #13 |

The gate #11 is itself blocked by #5–#8.

---

## 19. Risks, unknowns and required spikes

| # | Unknown | Why it matters | Spike | Blocking? | Result (2026-09-24) |
|---|---|---|---|---|---|
| U1 | Does `claude` exit promptly on stdin EOF mid-tool, mid-ask, with background shells? Can it orphan? | Orphans hold the session id and corrupt resumes | S1 | yes (CP0) | **Answered: it orphans for the rest of its turn**, and the CLI allows a second owner (silent transcript fork). Sweep is sufficient with four amendments (§11.5). Follow-up: the `PermissionRequest` hook's effect on a mid-ask orphan. `spikes/s1-runner-death.md` |
| U2 | Do SDK message `uuid`s match transcript entries? | Thin-host reattach dedupe | S1 | yes | **Yes** for `assistant`/`user`, one direction only; host sets `uuid` on sends (§11.5) |
| U3 | Does a detached host from an APFS-cloned, renamed runtime survive bundle replacement? TCC? Code signature? | Update survivability | S2 | yes | **Go.** Survived every unattended scenario including a full install; TCC access kept; runs ad-hoc but fails static `codesign --verify` (§11.7). Sleep/wake passed (M2); logout deferred (M3). `spikes/s2-detached-host.md` |
| U4 | Can a menu quit be told apart from an Apple Event quit and SIGTERM in Electron 44? | Non-blocking installs, logout | S2 | yes (for Stage 2) | **Yes, by flagging:** custom Quit item → `menu`; SIGTERM handler installed in `whenReady` → `signal`; unflagged → external; install script announces itself (§11.10). Real ⌘Q and Dock Quit confirmed (M1, 2026-09-24) |
| U5 | Does safeStorage re-prompt after an ad-hoc rebuild? | Token storage choice | S2 | no (fallback exists) | **Yes, and it blocks the main thread.** Host tokens go in 0600 files (§10, §12). The Discord token has the same problem |
| U6 | UDS throughput and backpressure behaviour at streaming rates | Protocol sizing | S3 | no | **Go.** 4 MiB queue / 16 MiB ring / 10 s × 3 heartbeat stand; `messages` paging rules added (§9.4, §9.7, §9.8). `spikes/s3-socket-protocol.md` |
| U7 | Codex pending approvals after a client disconnect | Codex survivability claims | S4 | for Stage 5 only | **Answered: they survive.** Held server-side with no timeout, re-sent with the same id after `thread/resume`; lost only if the server dies. Option (a) chosen; transport is WebSocket over UDS; Stage 5 amended (§11.8, §13). `spikes/s4-codex-restart.md` |
| U8 | Can Claude bg agents be driven programmatically? | Could replace AW hosts | S5 | no | **No** (§11.9). `spikes/s5-bg-agents.md` |
| U9 | App Nap and timers in a windowless core | Discord heartbeat reliability | S2 | for Stage 6 | **Not a blocker:** no throttling in 150 s runs; blocker only while busy (it also stops idle sleep). Long idle and battery untested |
| U10 | How agents request resource leases | Unity and exclusive tools | F2 | no | not started |

**Standing risks:**

- **Complexity creep.** Hold the "host has no policy" rule, and keep v1 at ~9 methods.
- **Silent orphans.** The orphan sweep, the idle rule and the host list.
- **The version-coupled SDK.** The exact pin stays, and `hello` reports `sdkVersion`/`cliVersion`.
- **The same-uid threat.** It is documented, not solved.
- **Auto-pause is inactive while the core is down.** Documented.
- **A regression in the currently-working flows.** Every stage keeps the in-process path until
  Stage 4's default flip.

---

## 20. Future CLI implications

The architecture supports a CLI naturally, and the CLI stays a **client**:

- It talks to `run/core.sock`. The core serves it from Electron main today, and from a daemon
  only if Stage 7 ever happens.
- It **never** talks to hosts, so AW stays the one authority that routes `send`, `stop` and
  answers through `SessionActions`, the same path as the menu and Discord.
- `aw status` / `aw sessions` can fall back to a **read-only** view of manifests and the registry
  when the core is down. That answers "what did I leave running?" after a ⌘Q without granting any
  control.
- `aw attach <id>` = snapshot + event stream, with an optional `send`.
- Nothing about the CLI changes process ownership. Building it does not require the Stage 7
  split.

---

## 21. Explicit non-goals

- PTY hosting or terminal emulation, including for today's providers.
- Multi-user, multi-machine, cloud or remote hosts. Remote clients other than Discord.
- An enterprise-grade identity system, or defence against a malicious same-uid process.
- Persisting event history or scrollback (the transcript is the history), and SQLite.
- Auto-restarting the app, or auto-resuming after a host crash.
- A second permission system. Remote still offers only what the local UI offers.
- Migrating live sessions between machines, or changing a live agent's binary in place.
- Building the Stage 7 split or the CLI as part of Stages 0–6.
- Windows or Linux support work (the design keeps it possible: UDS ↔ named pipes).

---

## 22. Recommended first implementation stage

**First do Stage 0.** Run spikes S1–S4 (plus S5, timeboxed) and T0 in parallel, then pass CP0.
None of it touches product code except the tests.

**The first implementation stage is Stage 1: split Claude's execution from its translation,
behind one session interface.**

- **Why first:**
  - It is the prerequisite of every non-A architecture.
  - It changes no behaviour and no persisted format.
  - It fixes latent bug F3.
  - It turns the host's surface into something reviewable (CP1) before any process boundary
    exists.
- **Model / effort:** **Opus, High.** Use Opus Extra High for the CP1 review before merge.

**Decisions (maintainer, 2026-09-24).** These supersede "open decision" and "optional" wording
elsewhere in this document.

1. **⌘Q quits and leaves agents running**, with a notification saying so. **Quit and Stop All
   Agents (⌥⌘Q)** stops them and quits. `lifecycle.onQuit` defaults to `leaveRunning`. See #14.
2. **Relax the CLAUDE.md rule "Never restart the app automatically"** once Stage 4 makes restarts
   safe. See #19.
3. **The idle-host timeout is a Preferences setting**, `lifecycle.orphanIdleHours`, **default
   24 h** (0 = never). It ends only idle sessions with nothing pending. See #15.
4. **`AGENTWRANGLER_HOSTED` mode is on by default, with no setting.** Hosted sessions can be
   approved only through AW's token-gated host. The permission hook ignores decision files for
   them, and external sessions keep the file path. See #15.

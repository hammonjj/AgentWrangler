# Agent Wrangler session lifecycle: architecture and migration playbook

Status: proposed, 2026-09-23. Investigation only; nothing here is built.
Scope: how AW launches, owns, loses and recovers the agent sessions it runs, and how to change
that one stage at a time, keeping the app shippable after every stage.
Tracking: the GitHub Project "Agent Wrangler", epic and issues in §18.

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
  no `process.on('exit' | 'SIGTERM' | 'uncaughtException')`.
- `RunnerService.dispose()` (`src/claude/runner/runnerService.ts`) runs `void s.end()`. That is
  **not awaited**, so the 5 s graceful-exit budget in `RunnerSession.end()` never gets its
  chance on quit. The backstop is the SDK's `process.on('exit')` handler, which SIGTERMs every
  tracked child (verified in the SDK bundle), plus stdin EOF when the parent's pipe ends close.
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
  no git coordination. Keeping agents from committing each other's work is procedural: CLAUDE.md,
  plus `docs/worktrees.md` and `scripts/wt.sh` on `chore/worktree-workflow`.
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
  `flash` toasts. There is no Electron `Notification`, tray or dock badge.
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
AW-owned shared `app-server` listening on a Unix socket, or Codex's own daemon if Spike S4 shows
it is safe. A separate UI/core process split is a gated Stage 7 that may never be needed.**

```text
             ┌──────────── Agent Wrangler.app — Electron main = AW Core (windowless-capable) ───────────┐
 renderer ◄─►│ SessionStore · providers · HostSupervisor · SessionRegistry · RunnerView reducers        │
 windows     │ RemoteControl/Discord · PauseService · usage · projects · notifications · leases (later)  │
 (ipcMain)   └──────┬───────────────────────┬──────────────────────────┬─────────────────────────────────┘
                    │ UDS NDJSON JSON-RPC   │ (SDK-native messages)    │ UDS JSON-RPC (Codex-native)
                    ▼                       ▼                          ▼
          aw host (session A)      aw host (session B)       codex app-server --listen unix://…
          SDK Query + asks +        SDK Query + asks +        (all AW Codex threads; AW-owned,
          raw message ring          raw message ring           detached; or Codex's daemon)
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
  transcript chain-entry uuids) + the pending asks. S1 verifies the uuid correspondence.

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
| Secrets (Discord token, host tokens) | | ✔ (safeStorage) | receives only its own token, once | | `secrets.json` |
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
- **Exclusive resources (Unity Editor).** A future core `LeaseService`: `acquire(resourceKey,
  sessionId, mode)`, persisted in the registry, released when the session stops, ends or is lost,
  and shown as a chip. How an agent *requests* one (an AW MCP tool, or a `PreToolUse` hook check)
  is spike F2. Leases key on the registry session id, so they survive core restarts and host
  reattach.
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
- It handles `SIGTERM`, `SIGINT` and `SIGHUP` by ending its agent gracefully (stdin close,
  5 s grace, force) and then exiting. Node emits no `exit` event on signals, so the SDK's own
  kill-on-exit does not cover them. Logout sends SIGTERM.

**Session id changes.** `/clear` changes the id mid-life (`runnerSession.ts` `onMessage`). The
host rewrites its manifest atomically, and `hello` always reports the current id. For fresh
sessions, the core passes the SDK's `sessionId` option, so the id is known before the first
turn.

### 7.2 User-level commands

| Command | Semantics |
|---|---|
| Close window | UI only. With the Stage 6 windowless mode, the Dock icon hides and the menu-bar item stays. |
| **Quit (⌘Q, menu)** | With hosts: quits the core, **agents keep running**. A one-line notification: "3 agents keep running. ⌥⌘Q quits and stops them." Setting `lifecycle.onQuit = leaveRunning \| ask \| stopAgents` (default: open decision, §22). Before hosts exist (Stage 2): if agents are live, a confirm dialog "Quit and stop N agents?". |
| **Quit and Stop All Agents (⌥⌘Q)** | `preventDefault` → `end` every session, awaited and bounded (10 s) → exit. |
| Non-menu quit (Apple Event from `osascript`, logout, `powerMonitor` shutdown, SIGTERM) | **Never a dialog.** Before hosts: graceful bounded stop. With hosts: leave running. The menu item sets a `quitSource` flag, and a quit without the flag is non-interactive. `install-app.sh` polls until the main process has exited instead of `sleep 2`, and matches the main executable's exact path. |
| Stop agent / Close session | Core → host `end` (stdin close → grace → force). Registry `stopped`. Transcript kept. |
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
   - **Host dead, no exit record** → `lost` → `interrupted`. First, **sweep for an orphan
     `claude`**: an entry in `~/.claude/sessions/*.json` whose `sessionId` matches and whose pid
     is alive. End it with `endProcess` before offering Resume.
3. Registry `live` records with no manifest (reboot or logout) → `interrupted`.
4. **Offer every interrupted session, not just the newest.** Rows get "Interrupted — Resume".
   Auto-resume (`runner.autoResumeLastOnStartup`) still applies to the newest only.

### 7.4 Bounded version drift

A host runs the build it was spawned with. When a host's `hostBuild` ≠ the core's build and the
session is **idle, with no pending ask and no background shells or tasks running**, the next
`send` migrates it: `end` → `resume` the same id on a fresh host, carrying model, permission
mode and effort. That reuses the adopt-on-send path (`actions.adoptAndSend`). Ending the CLI
kills its `run_in_background` shells, which is why busy sessions are never migrated. The result
is that a live host is at most "one busy stretch" old.

### 7.5 Idle-orphan rule

If no client has connected for `lifecycle.orphanIdleHours` (default 24, where 0 = never), the
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
| **Host crashes** (SIGKILL, OOM) | `claude` gets stdin EOF. It *may* not exit promptly mid-tool or mid-ask (S1), and could be reparented to launchd | lost (heap gone) | card expires | core sees socket close + host dead, no exit record → `lost` → **orphan-claude sweep** → `interrupted`; one-click Resume, **no auto-resume** (crash loops) | "Interrupted — host exited unexpectedly" |
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
  - The same framing Codex `app-server` already speaks, so there is one codec (extracted from
    `CodexAppServer` into `src/core/rpc/ndjsonPeer.ts`).
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

### 9.4 Methods (protocol v1, frozen at CP2; about ten)

| Method | Params | Result |
|---|---|---|
| `hello` | above | above |
| `snapshot` | `{}` | `{seq, state, sessionId, pendingAsks[], ring:{fromSeq, truncated}, exit?}` |
| `subscribe` | `{fromSeq}` | `{ok}`, then notifications. `fromSeq` older than the ring → error `-32010 resync` |
| `messages` | `{fromSeq, maxBytes}` | `{messages:[{seq, msg}], nextSeq}` (paged replay of raw SDK messages) |
| `send` | `{message: SDKUserMessage}` (client sets `uuid`) | `{accepted, duplicate}`. **Idempotent on `uuid`**, so a core that crashed mid-send can check the snapshot |
| `respondAsk` | `{requestId, result: PermissionResult}` | `{outcome: applied \| stale \| gone}` |
| `control` | `{op: interrupt \| setModel \| setPermissionMode \| supportedModels \| supportedCommands \| getContextUsage, args}` | op result |
| `end` | `{graceMs}` | resolves after the agent has exited |
| `ping` | `{}` | `{seq, now}` |

There is deliberately **no** method to spawn, exec, read files or change the binary, cwd, env or
the `allowDangerouslySkipPermissions` option. A host drives only the session it was started
with.

### 9.5 Events (host → core notifications, all with `seq`)

- `message {msg}`: every raw SDK message, `stream_event` partials included.
- `ask {ask}` / `askSettled {requestId, reason: responded | aborted | agentExited}`.
- `state {state}`: the host's minimal lifecycle (`starting | idle | running | ending`, derived
  from `system/init` and `result`, used only for the idle rule).
- `sessionId {sessionId}`.
- `exit {code, signal, stderrTail}`.
- `resync {}`.

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
  queue, sends `resync`, and the client re-snapshots and pages `messages` from the snapshot.
- Under pressure, `stream_event` deltas for the same content block are coalesced.
- The ring is sized in bytes (default 16 MiB). The transcript covers anything older.

### 9.8 Heartbeats and reconnects

- The core pings every 10 s and declares a host unreachable after 3 misses on a monotonic clock.
  The counters reset on `powerMonitor` `resume`, and one fresh ping decides.
- Reconnect uses exponential backoff up to 30 s while the host pid is alive. After the host dies,
  §7.3 classification takes over.
- Hosts don't ping; a socket close is enough for them.

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
| Host capability tokens | `secrets.json` via `ElectronSecrets` (safeStorage), keyed by hostId | host lifetime | core | if S2 shows ad-hoc rebuilds make Keychain re-prompt, fall back to a 0600 `hosts.json` and document that it only stops accidental access |
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
   - The CLI exits on stdin EOF at idle (verified, `conversation-pane.md` §2.1). Behaviour
     **mid-tool, mid-ask and with background shells is unmeasured.**
   - An EPIPE on stdout does not guarantee an exit.
   - So a `claude` can plausibly survive its host as an orphan still holding the session id.
     §7.3's orphan sweep (via `~/.claude/sessions`) is mandatory, and S1 measures it.
6. **The host process.**
   - `spawn(runtimeExe, [hostJs], {detached: true, stdio: ['pipe', logFd, logFd]})`. The token
     is the first stdin line, then stdin is destroyed.
   - stdout and stderr go to `logs/host-<id>.log`, **never pipes to the core** (they would EPIPE
     when the core dies). Then `unref()`.
   - The SDK builds `claude`'s env from `process.env`, minus `NODE_OPTIONS`. The host **must
     pass an explicit `env` that strips `ELECTRON_*` and `AW_*`**. Otherwise
     `ELECTRON_RUN_AS_NODE=1` reaches `claude` and every Bash or npm command it runs. That is the
     same bug `env -u ELECTRON_RUN_AS_NODE` in `package.json` already works around.
   - libuv marks its fds close-on-exec, so the socket and log fds don't leak into `claude`.
     Verify with `lsof` in S2.
7. **Runtime location.**
   - At core start, **APFS-clone** the running bundle (`cp -c -R`, close to free) into
     `runtimes/<buildId>/`, rename the executable (for example "Agent Wrangler Host"), and spawn
     hosts from there.
   - `app:install`'s `rm -rf` of `/Applications/Agent Wrangler.app` then never touches a running
     host.
   - `pgrep`, `killall "Agent Wrangler"` and `osascript quit app` no longer match hosts.
   - GC every runtime no manifest references.
   - Record in the build config that Electron's `RunAsNode` fuse must stay enabled.
   - S2 verifies that the renamed executable still runs with the ad-hoc signature, and checks TCC
     (repos under the protected `~/Documents`) after the original bundle is replaced.
8. **Codex.**
   - One `app-server` holds every AW Codex thread's in-flight turn.
   - **Preferred:** an AW-owned, detached `codex app-server --listen unix://<short path>` treated
     as a shared host with a manifest. AW controls its lifetime and version.
   - **Alternative:** Codex's machine-wide `app-server daemon`. AW does not control its restarts
     (`daemon update may interrupt running work`), and the VS Code extension and AW can run
     **different** Codex binary versions from different extension directories, as they did
     during this investigation.
   - Record the binary version in the manifest, and never `proxy` from a newer binary into an
     older server.
   - **Gating unknown (S4):** what happens to server-to-client requests (`requestApproval`,
     `requestUserInput`) when the client connection drops. Are they re-sent after `thread/resume`
     on a new connection, or declined?
9. **Claude background agents** (`claude --bg`, `claude agents --json`) are a first-party
   detached-session feature. `claude agents --json` already lists SDK sessions with pid and
   status. Whether a bg agent can be driven with stream-json + `canUseTool` is unknown, so S5 is
   a timeboxed look. If it can, it could replace the AW Claude host later, and the
   provider-shaped host keeps that door open.
10. **macOS facts relied on:**
    - no parent-death signal;
    - orphans reparent to launchd;
    - `detached` → `setsid` puts the host outside the app's process group;
    - logout SIGTERMs every user process (hosts handle it);
    - sleep suspends everything.

    App Nap can throttle a *windowless* Electron core, which would delay the Discord heartbeat,
    so use `powerSaveBlocker('prevent-app-suspension')` while agents are busy (S2 verifies).
    `SIGTERM` to Electron main, and whether a menu quit can be told apart from an Apple Event
    quit, are verified in S2.

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
| Capability token | 256-bit, per host, generated by the core, delivered as the **first stdin line** and then stdin is destroyed. **Never argv** (`ps` shows it) and **never env** (inherited by `claude` and every Bash tool). Required by every method but `hello`. Stored in safeStorage (Keychain-backed; a same-user read triggers a visible prompt). |
| Hosted sessions approvable only with the token (optional, after Stage 4) | The host sets `AGENTWRANGLER_HOSTED=1` in `claude`'s env. The permission hook script (bump `PERMISSION_SCRIPT_VERSION`) then logs the pending marker for status but **doesn't poll for a decision** for hosted sessions. An agent can't change its parent's env. This depends on the host-first routing in §6.1. |
| Audit | The host logs every `send`, `respondAsk` and `control` (op name, requestId, never content). Core settle events carry `by`. |
| Arbitrary command execution | Hosts expose no spawn, exec, file, cwd, env or binary method. The core builds host argv from settings plus validated registry fields. The core socket's `start` takes `{provider, cwd, model, permissionMode, effort, resume}`, never a binary or arguments. |
| Environment | Explicit env for `claude`: the host's env minus `ELECTRON_*` and `AW_*`. The Discord token is never in env. |
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
      and an idempotent send by `uuid`.
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
    Newest-only auto-resume stays behind its setting.
  - Quit:
    - the menu ⌘Q item sets `quitSource = 'menu'`;
    - with live agents it shows "Quit and stop N agents?";
    - **non-menu quits never show a dialog** and do an awaited, bounded (≤10 s) graceful end;
    - `before-quit` → `preventDefault` → end → `app.exit()`.
  - A SIGTERM handler (non-interactive).
  - `render-process-gone` reloads the workbench.
  - `install-app.sh` polls for exit (not `sleep 2`) and matches the exact main-executable path.
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
    - handles SIGTERM/SIGINT/SIGHUP;
    - passes an explicit env to `claude`.
  - `HostSupervisor` in the core: runtime clone + GC, spawn, connect, `hello`, snapshot,
    subscribe, reattach.
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
  - A live test gated by `AW_LIVE_CLAUDE=1` (a tiny turn; output never pasted anywhere).
- **Manual.**
  - Setting on: two conversations, one mid-turn → ⌘Q → wait → relaunch → both live, and the
    mid-turn one finished meanwhile.
  - `kill -9` the core → reattach.
  - `app:install` mid-turn → reattach.
- **Risks.** Token-handoff races. Runtime clone correctness. Env leakage. The history/ring uuid
  dedupe.
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
When to escalate: already max; add a second review if S2 found runtime or TCC problems.
Review checkpoint: CP2 (Opus Extra High) freezes protocol v1 + manifest v1 before the host server merges.
```

### Stage 4: Recovery, orphans, drift; hosts on by default

- **Goal.** Every row of §8 behaves as specified. The gating acceptance test passes.
- **Change.**
  - §7.3 cases 2–4.
  - Start-time guards (`endProcess`, supervisor).
  - The orphan-`claude` sweep.
  - Exit records, drain and tombstone GC.
  - The idle-orphan rule.
  - Bounded-drift migration on idle send (§7.4).
  - Incompatible-major handling.
  - `powerMonitor` resume (heartbeats + Discord reconnect).
  - `powerSaveBlocker` while busy.
  - The optional `AGENTWRANGLER_HOSTED` hook behaviour.
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

```text
Recommended model: Opus
Recommended effort: Extra High
Why: failure recovery, pid reuse, GC and version drift are where subtle systemic bugs live.
Review checkpoint: CP3 (Opus Extra High) — failure-matrix review after the soak, before the default flip;
                   plus a second Opus Extra High read of the GC/classification code.
```

### Stage 5: Codex execution decoupled

- **Goal.** AW-run Codex threads survive core restarts.
- **Change (per S4).**
  - **Preferred:** the supervisor launches one detached `codex app-server --listen unix://…`
    from the pinned binary as a shared host with a manifest, and `CodexAppServer` connects
    through `ndjsonPeer`.
  - **Alternative:** Codex's daemon plus `proxy`.
  - On reconnect, `thread/resume` every registry-live Codex thread, and rebuild pending
    approvals the way S4 found them re-delivered. If they are *declined* on disconnect, the UI
    says Codex asks do not survive a core restart.
  - Codex sessions are already in `SessionRegistry` from Stage 2.
- **Files.** `src/codex/appServer.ts`, `runner.ts`, `codexHandle.ts`, `binary.ts` (version
  pinning), `src/core/session/hostSupervisor.ts`, `createApp.ts`, settings.
- **Tests.** Reconnect with an injected transport, and a thread-resume replay fixture.
- **Manual.** Codex mid-turn → ⌘Q → relaunch → live. The VS Code extension on the same thread
  behaves as S4 documented.
- **Risks.** Binary version drift. The approval semantics after a disconnect.
- **Rollback.** A setting to go back to `--stdio`.
- **PR.** Own PR. Can run in parallel with Stages 3–4 once Stages 1–2 have landed.

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

### Follow-ups (outside the critical path)

- **F1 (feature):** warn when two live sessions share one checkout. Any time, and better after
  Stage 2.
- **F2 (spike):** how agents acquire exclusive resource leases (Unity Editor): MCP tool vs
  `PreToolUse` check. Then a core `LeaseService`. After Stage 2.
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
  this document before Stage 1 starts.
- **CP1, before Stage 1 merges.** `ClaudeSdkSession` and `sessionProtocol` types: serializable,
  provider-native, no `ConvBlock` in the host surface, seq and snapshot semantics.
- **CP2, before the Stage 3 host server merges.** Freeze protocol v1 and manifest v1. Every
  method is forever.
- **CP3, after the Stage 4 soak, before the default flip.** Walk the §8 matrix against real
  behaviour, and give GC and classification a second read.
- **CP4, the Stage 7 gate.**
- **Standing rule.** Any change to `src/shared/sessionProtocol.ts`, the manifest format, or the
  Stage 8 control-socket API gets an Opus High review (Extra High if it is a major bump).

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

**Starting state (2026-09-23).** `hammonjj/AgentWrangler` had no issues, only GitHub's default
labels, no milestones and no linked Project.

**Convention: mirror the maintainer's other GitHub Projects.**

- Plain descriptive titles, with no "FEATURE:" prefixes.
- Type as a **label**.
- Body sections: *Problem or opportunity / Desired outcome / Acceptance criteria (checkboxes) /
  Open questions*. Spikes add *Method / Timebox / Output*.
- A closing line points at this playbook.

**Setup.**

1. **Labels.** `feature`, `tech-debt`, `spike`, `testing`, `epic`, `chore`, `needs-info`, plus
   the existing `bug` and `documentation` (the name used for docs).
2. **Project.** "Agent Wrangler" (user-owned), with the repo linked.
3. **Fields.**
   - **Status**: Inbox, Ready, In Progress, Blocked, Done.
   - **Priority**: P0 — Critical, P1 — High, P2 — Medium, P3 — Low.
   - **Effort**: XS, S, M, L, XL.
   - **Area**: Sessions & hosts, Core, UI, Remote, Providers, Tooling & build, Docs.
   - **Stage**: S0 … S8, Follow-up.
4. **Epic.** One `epic` issue is the parent of every stage issue through GitHub **sub-issues**.
5. **Grouping.** Use the **Stage** field, and create no milestones. If milestones are wanted
   later: "Survivable sessions" (S0–S4) and "Beyond the window" (S5–S8).

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

**Created now:** the epic, S1–S5, T0 and the CP0 gate. That is 8 issues, all independent of
unresolved assumptions.

**Deferred:** every stage issue and follow-up, until CP0 closes. They may be reworded then.

---

## 18. GitHub issue creation manifest

Every issue ends with: "Playbook: `docs/plans/session-lifecycle-architecture.md` §<n>."

### Create now

**E. Decouple agent session lifetime from the Agent Wrangler app**
- Type: `epic` · Stage: all · Priority P1 · Effort XL · Area Sessions & hosts · Status Ready
- Scope: the initiative. It links the playbook and holds every other issue as a sub-issue. The
  body holds a checklist of the stages.
- Acceptance criteria: the gating acceptance test (§8) passes with hosts on by default; the
  Stage 4 docs are updated; the Stage 7 gate is decided.
- Depends on: — · Parallel with: — · PR boundary: none (tracking only) · **Create now**

**S1. Measure what happens to a Claude runner when its host process dies**
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

**S3. Prototype the host socket protocol: throughput, backpressure, reconnect**
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
  playbook, then reword and create the deferred issues below.
- Acceptance criteria:
  - [ ] playbook updated;
  - [ ] §5 confirmed or changed with a reason;
  - [ ] deferred issues created.
- Depends on: S1, S2, S3, S4 · Parallel with: T0 · PR boundary: docs commit · **Create now**

### Defer (create at G0)

| # | Title | Type | Stage | Scope (short) | Acceptance (short) | Depends on | Parallel with | PR |
|---|---|---|---|---|---|---|---|---|
| 1 | Split Claude execution from translation behind one session interface | `tech-debt` | 1 | §13 Stage 1 incl. F3 | no `RunnerSession` outside tests; behaviour unchanged; CP1 passed | G0, T0 | — | 1 |
| 2 | Keep a registry of AW-run sessions and make quitting explicit | `feature` | 2 | §13 Stage 2 | interrupted rows for all; non-blocking install; renderer reload | 1 | 6 | 1 |
| 3 | Run each Claude conversation in a session host that outlives the app | `feature` | 3 | §13 Stage 3, behind a setting | manual matrix 3×; no orphans; CP2 passed | 2, S1–S3 | 5, 6 | 1–2 |
| 4 | Make session hosts survive crashes, reinstalls and version drift, then turn them on | `feature` | 4 | §13 Stage 4 | §8 rows + gating test; CP3; default on | 3 | 5, 6 | 1 + flip |
| 5 | Session lifecycle integration suite | `testing` | 3–4 | §16 I-level rows + fake-agent harness | all I rows green locally | starts with 3 | 4 | 1–2 |
| 6 | Keep Agent Wrangler's Codex threads alive across restarts | `feature` | 5 | §13 Stage 5 | Codex manual matrix; approval semantics shown | 2, S4 | 3, 4 | 1 |
| 7 | Run Agent Wrangler without a window: menu bar, notifications, login item | `feature` | 6 | §13 Stage 6 | window closed → clickable notification + badge | 2 | 3–5 | 1 |
| 8 | Update README, product context and CLAUDE.md for survivable sessions | `documentation` | 4 | quit, restart and security wording | maintainer signs off on the CLAUDE.md rule change | 4 | — | with 4 |
| 9 | Decide whether the core ever needs to leave the Electron process | `spike` | 7 | Stage 7 gate | decision recorded (go or no-go) | 4, 7 | 10 | docs |
| 10 | Add an `aw` command-line client | `feature` | 8 | §13 Stage 8 | commands listed; read-only fallback when core down | 4 | 9 | 1 |
| 11 | Warn when two live sessions share one checkout | `feature` | F1 | chip + optional launch refusal | warning shown; unit tests | 2 (or none) | any | 1 |
| 12 | How should an agent acquire an exclusive resource lease (Unity Editor)? | `spike` | F2 | MCP tool vs hook check; `LeaseService` sketch | decision + interface | 2 | any | docs |

---

## 19. Risks, unknowns and required spikes

| # | Unknown | Why it matters | Spike | Blocking? |
|---|---|---|---|---|
| U1 | Does `claude` exit promptly on stdin EOF mid-tool, mid-ask, with background shells? Can it orphan? | Orphans hold the session id and corrupt resumes | S1 | yes (CP0) |
| U2 | Do SDK message `uuid`s match transcript entries? | Thin-host reattach dedupe | S1 | yes |
| U3 | Does a detached host from an APFS-cloned, renamed runtime survive bundle replacement? TCC? Code signature? | Update survivability | S2 | yes |
| U4 | Can a menu quit be told apart from an Apple Event quit and SIGTERM in Electron 44? | Non-blocking installs, logout | S2 | yes (for Stage 2) |
| U5 | Does safeStorage re-prompt after an ad-hoc rebuild? | Token storage choice | S2 | no (fallback exists) |
| U6 | UDS throughput and backpressure behaviour at streaming rates | Protocol sizing | S3 | no |
| U7 | Codex pending approvals after a client disconnect | Codex survivability claims | S4 | for Stage 5 only |
| U8 | Can Claude bg agents be driven programmatically? | Could replace AW hosts | S5 | no |
| U9 | App Nap and timers in a windowless core | Discord heartbeat reliability | S2 | for Stage 6 |
| U10 | How agents request resource leases | Unity and exclusive tools | F2 | no |

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

**Open decisions for the maintainer** (defaults assumed in this document):

1. **What ⌘Q does once hosts exist:** `leaveRunning` (proposed, with a notification and ⌥⌘Q for
   stop-all), or `ask`?
2. **The CLAUDE.md rule "Never restart the app automatically":** relax it after Stage 4, when
   restarts no longer end sessions, or keep it?
3. **Idle-orphan default:** 24 h, or never?
4. **Whether to adopt the optional `AGENTWRANGLER_HOSTED` mode**, which makes hosted sessions
   approvable only through AW's token-gated host. It closes the decision-file self-approval path
   for hosted sessions.

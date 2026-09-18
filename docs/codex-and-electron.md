# Codex integration and Electron boundary

## Runtime shape

The shared `AgentProvider` contract feeds `SessionStore` with provider-qualified keys. `ClaudeProvider` and `CodexProvider` own their native discovery formats; UI code receives only `AgentSession` values. Codex discovery scans recent rollout files using bounded head/tail reads and reparses only files whose modification time changed. SQLite is deliberately not a dependency because its schema is an implementation detail and may be locked by another client.

External Codex sessions remain observational. Their rollout lifecycle gives Busy, Possibly stuck, Waiting, and Done estimates, while their conversation pane follows the rollout file. Agent Wrangler never resumes an external thread merely to inspect it and never sends a process signal to a shared Codex host.

Wrangler-owned Codex conversations use `codex app-server --stdio`. `CodexAppServer` contains the JSON-RPC transport and `CodexRunner` reduces thread, turn, item, streaming, and approval events into the same block/composer contracts used by the existing pane. A pane subscription is disposable independently of the runner, so closing a view does not end work.

Codex plan limits come from App Server's `account/rateLimits/read` method and use the existing cached polling service. The dashboard shows the matching provider's cards when filtered and labels both providers in the combined view. Claude's process-level auto-pause remains Claude-specific because an external Codex rollout does not identify a safe process to suspend.

## Main conversations and subagents

Codex rows default to main conversations only. The column menu's **Show internal/subagent sessions** checkbox (also `agentWrangler.showCodexSubagents` in settings) exposes child and internal sessions for diagnostics. This is a display filter, not a change to Codex execution or history.

The **Subagents** column summarizes working, needs-attention, and completed workers, including nested workers linked by explicit `source.subagent.thread_spawn.parent_thread_id` metadata. Guardian reviews and their descendants are excluded. Missing parents, unlinked children, and cyclic ancestry are not assigned to a conversation. Counts cover transcripts in the configured discovery window, not just the latest turn; they may omit older or unavailable children. The main conversation's status remains independent. Worker statuses are transcript estimates, so this column is not a complete approval monitor. In narrow dashboards the summary moves to the row's second line.

Injected environment, plugin, and AGENTS.md setup messages are skipped when selecting Codex conversation titles.

## Electron seam

The browser bundles reach the host through `createWebviewBridge`, called in exactly one
place: `src/webview/common/paneApi.ts`. It prefers a preload-injected `agentWranglerHost`
and falls back to `acquireVsCodeApi`. It is centralised there because `acquireVsCodeApi`
may only be called once per webview, so a second call site is not a style question — it
throws and kills a pane. Keep the renderer sandboxed, context isolated, and without Node
integration. Filesystem access, process discovery, binary spawning, credentials, and App
Server must remain in the main/backend process.

**Theming is the largest mechanical item in the port, and it is not a seam.** The three
webview stylesheets use **56 distinct `var(--vscode-*)` custom properties** — button,
dropdown, badge, charts, editor, list, input, panel and statusBar families. VSCode injects
those values into every webview and tracks the user's theme. Nothing defines them outside
VSCode, so a desktop shell renders the UI unstyled until someone authors light and dark
values for all 56. Budget this before anything else on this page.

The remaining VSCode host APIs should move behind adapters before packaging Electron. The
dependency is shallow and concentrated — 14 of 86 source files import `vscode`, and more
than half the call sites are in `extension.ts`, which is mostly activation wiring, dialogs
and command registration. Ranked by what the work actually is:

- **Swaps, not design.** `globalState` is six preference services (turn stats, archive, pins,
  nicknames, column prefs, hidden projects) and `workspaceState` is one (`RunnerRegistry`);
  both `ArchiveService` and `RunnerRegistry` already take a structural `{get, update}`
  rather than `vscode.Memento`, so the store is a constructor argument. `globalStorageUri`,
  `extensionUri`, clipboard, `openExternal`, `revealFileInOS` and the folder pickers all have
  direct equivalents. `asWebviewUri` and `cspSource` mostly disappear under `loadFile`; the
  nonce logic survives unchanged.
- **Real UI to build.** Roughly twenty `showInformationMessage`/`showWarningMessage`/
  `showErrorMessage` sites (several modal, with `detail` and custom buttons), the two
  `showQuickPick`s and the `showInputBox`, `withProgress` with its cancellation token, the
  15 registered commands and the command palette that invokes them, and webview-panel
  serialisation.
- **No equivalent at all.** `vscode.diff` plus the `TextDocumentContentProvider` behind it —
  replacing it honestly means bundling Monaco's diff editor. The status bar item, whose
  `MarkdownString` tooltip and `ThemeColor` background have no analogue; a tray icon or badge
  is the nearest thing. `openTextDocument`, which presumes an editor exists. And the tab UX
  itself — a workbench tab beside your code, a pinned conversation in another tab — because
  windows are not tabs. That last one is a product decision, not a porting task.
- **Cheaper than it looks.** Workspace discovery: `workspace.workspaceFolders` has two live
  uses, one of them dev-only, and the launcher already merges Claude Code history and running
  sessions. The app is machine-wide by design, so "no workspace" costs almost nothing.
- **Terminal handoff** (*Release*, and the dictation setup's `brew install` helper) types a
  command into an integrated terminal. There is no `sendText` equivalent; this needs
  `node-pty` with xterm.js, or a shell-out to the platform terminal.
- **Dictation** already records in the extension host via `ffmpeg` and `whisper-cli` child
  processes rather than the webview, so it moves largely intact — `webkitSpeechRecognition`
  was ruled out long ago and fails in any Electron-based webview, VSCode's included. The
  work there is the macOS microphone entitlement, not the capture path.

The Electron application should run one backend per OS login, with renderer windows subscribing to snapshots. Runner ownership must use leases keyed by provider and thread so the VSCode extension and desktop app cannot both control one conversation. A renderer reload only reconnects. Surviving full application exit requires a separate daemon and is intentionally a later feature.

## Packaging hazards

- Resolve `claude` and `codex` from explicit settings plus platform locations; a binary inside a VSCode extension is not a durable desktop dependency.
- Keep spawned binaries and hook helpers outside ASAR. Re-test the Claude SDK ESM/CJS bundle under Electron.
- Store hook helpers in stable user data so an app update does not leave configuration pointing into an old versioned bundle.
- Migrate preferences, pins, nicknames, and local archives with a versioned schema. Do not migrate credentials or stale process ownership.
- macOS is the current process-control baseline. Windows, WSL, containers, SSH workspaces, signing, notarization, updates, tray behavior, and microphone entitlements need separate acceptance passes.
- Validate IPC senders and payloads. Do not expose raw IPC, filesystem, shell, or process APIs through the preload bridge.

## Compatibility behavior

Unknown rollout records are ignored, malformed lines do not abort a scan, and missing Codex directories produce an empty provider. If App Server cannot start, monitoring continues and only the new interactive thread fails with a visible error. Provider capabilities determine which actions appear; unsupported pause, resume, handoff, and external approval actions stay unavailable rather than targeting the wrong process.

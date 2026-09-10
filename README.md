# Agent Wrangler

Local VSCode extension that monitors every AI agent session on this machine — who is **waiting on you**, who is busy, who looks stuck, and who is done — in one live dashboard.

v1 supports **Claude Code** (all sessions across all VSCode windows and terminals). The data layer is provider-based so Codex can be added later.

Status comes from Claude Code's own hooks when they're installed, so *Blocked on you* means a permission prompt is genuinely on screen — not a guess from a quiet transcript.

## Run it

```bash
npm install
```

Then open this folder in VSCode and press **F5** (Run Agent Wrangler). A new Extension Development Host window opens with:

- **Agent Wrangler dashboard**, opened for you at startup as an editor tab in the main editor area: all sessions grouped *Waiting on you → Possibly stuck → Busy → Ended*. Set `agentWrangler.dashboardLocation` to `panel` to dock it in the bottom panel next to Terminal instead, or turn `agentWrangler.openOnStartup` off to open it yourself.
- **Status bar bell**: `$(bell-dot) N waiting` when agents are blocked on you; click to open the dashboard.

## Install it for real (dogfooding)

F5 only loads the extension into a dev-host window, so the cross-window relay can't see your normal windows. To run it in every window:

```bash
npm run install-local    # build → package .vsix → code --install-extension --force
```

Then **Cmd+Shift+P → Developer: Reload Window** in each open window (or restart VSCode) to pick up the new build. Repeat the same command after every change — `--force` reinstalls over the same version, so no version bump is needed.

The VSCode CLI is assumed to live in `/Applications/Visual Studio Code.app`; override with `VSCODE_CLI=/path/to/code npm run install-local`. To go back to F5-only iteration: `code --uninstall-extension local.agent-wrangler`.

## Behavior

- The dashboard is a column-aligned table with collapsible sections (*Blocked on you / Waiting on you / Possibly stuck / Busy / Ended / Archived*); collapse state is remembered.
- **Click a session belonging to this window's workspace** → opens it in the official Claude Code panel (`claude-vscode.editor.open <sessionId>`), revealing the existing panel or resuming with `--resume=<id>` — fully interactive immediately.
- **Click a live panel session owned by another window** → cross-window relay: a note is written to a shared mailbox (extension globalStorage) watched by every Agent Wrangler instance, and the owning window is focused via VSCode's own CLI; that window's instance opens the conversation in its Claude panel. If the project isn't open anywhere, a new window opens and claims the note on activation. (Requires the extension to be running in the target window — during F5-only iteration that means only dev-host windows participate; other windows still get focused.)
- **Click anything else from another project/window** → ended: terminal at the project folder running `claude --resume <id>`; live terminal sessions: read-only viewer.
- The eye button opens the read-only viewer for any session with a transcript.
- Row buttons: view transcript (ended sessions) and **archive** — archived sessions move to the always-last Archived section (collapsed by default), stop counting toward the status-bar bell, and never toast. The same button unarchives.
- Command palette: `Agent Wrangler: …` commands (dashboard, refresh, viewer, resume, copy id, reveal transcript, install/remove status hooks).

## How status is detected

Two sources, in priority order. Hooks are ground truth; the transcript is a fallback.

### 1. Hooks (exact, opt-in)

Run **`Agent Wrangler: Install Status Hooks…`**. It merges a block into `~/.claude/settings.json` in which every hook appends its stdin payload to `~/.claude/agentwrangler/$PPID.jsonl`; the extension tails those logs.

| Signal | Meaning |
|---|---|
| `PermissionRequest` · `Elicitation` · `Notification`/`agent_needs_input` | **Blocked on you** (row names the tool) |
| `Stop` · `StopFailure` | **Waiting on you** |
| `UserPromptSubmit` · `PreToolUse` · `PostToolUse`/`PostToolBatch` | **Busy** (row shows the in-flight tool and its elapsed time) |
| no events at all past `stuckThresholdSeconds`, nothing in flight | **Possibly stuck** |
| `SessionEnd`, or pid gone | **Ended** |

Notes on the install, all verified against the shipped Claude Code:

- **Your existing hooks are preserved.** The installer merges and backs `settings.json` up first; uninstall removes exactly its own entries. Unparseable settings abort rather than being overwritten.
- **Only new sessions report.** Claude Code snapshots hook config when a session starts, so editing settings does nothing to sessions already running.
- **Overhead is a shell append**, no interpreter startup. The log is sharded by the Claude pid because `cat >>` is only atomic while a payload fits in one write: measured here, 30 concurrent appends stay intact at 20 KB each but corrupt 6 of 30 lines at 64 KB and most at 128 KB. A `tool_input` holding a large `Write` reaches that easily; sharded, the same test is clean at 1 MB.
- Hooks can be silently suppressed by `disableAllHooks`, safe mode, an org policy allowing only managed hooks, or unaccepted workspace trust. The extension warns rather than leaving you to wonder.

### 2. Transcript inference (fallback, always on)

Sessions with no hook data — anything started before installing them — are derived from the registry plus the transcript tail, exactly as before, and rendered with a **hollow status dot** meaning *estimated*.

| Signal | Meaning |
|---|---|
| `~/.claude/sessions/<pid>.json` + pid alive | session is live (registry gives cwd + friendly name) |
| last transcript line: assistant `stop_reason: end_turn` | **Waiting on you** |
| last transcript line: assistant `tool_use` / user / queue-op | **Busy** |
| busy but transcript silent > `stuckThresholdSeconds` | **Possibly stuck** |
| pid gone | **Ended** |

Inference cannot distinguish a permission prompt from a long tool call from a wedged session — all three look like a silent transcript. That limitation is the reason hooks exist; without them, *Possibly stuck* is a guess.

Transcripts and hook logs are both read incrementally (bounded tail reads with a per-file byte offset) — large files are never loaded whole.

## Settings

`agentWrangler.dashboardLocation` (`editor` — or `panel` for the bottom panel) · `openOnStartup` (true) · `claudeBinaryPath` · `stuckThresholdSeconds` (60) · `endedWindowHours` (48) · `maxEndedSessions` (50) · `notifyOnWaiting` (false — toast when an agent flips to waiting or blocked) · `pollIntervalSeconds` (5)

## Development

```bash
npm run watch      # esbuild watch (also started automatically by F5)
npm run typecheck  # tsc --noEmit
npm test           # vitest: tail parser, status table, live ~/.claude smoke test
```

Source layout: `src/claude/*` (registry reader, incremental tail parser, status derivation, hook event reducer + log tailer + settings installer, provider), `src/core/*` (provider-agnostic store), `src/ui/*` (dashboard host + its two shells — editor tab and panel view, viewer panels, status bar, terminal resume), `src/webview/*` (browser bundles). Webview code may only import from `src/shared/*`.

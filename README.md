# Agent Wrangler

Local VSCode extension that monitors every AI agent session on this machine — who is **waiting on you**, who is busy, who looks stuck, and who is done — in one live dashboard.

v1 supports **Claude Code** (all sessions across all VSCode windows and terminals). The data layer is provider-based so Codex can be added later.

## Run it

```bash
npm install
```

Then open this folder in VSCode and press **F5** (Run Agent Wrangler). A new Extension Development Host window opens with:

- **Agent Wrangler panel** (bottom panel area, next to Terminal): all sessions grouped *Waiting on you → Possibly stuck → Busy → Ended*.
- **Status bar bell**: `$(bell-dot) N waiting` when agents are blocked on you; click to open the panel.

## Install it for real (dogfooding)

F5 only loads the extension into a dev-host window, so the cross-window relay can't see your normal windows. To run it in every window:

```bash
npm run install-local    # build → package .vsix → code --install-extension --force
```

Then **Cmd+Shift+P → Developer: Reload Window** in each open window (or restart VSCode) to pick up the new build. Repeat the same command after every change — `--force` reinstalls over the same version, so no version bump is needed.

The VSCode CLI is assumed to live in `/Applications/Visual Studio Code.app`; override with `VSCODE_CLI=/path/to/code npm run install-local`. To go back to F5-only iteration: `code --uninstall-extension local.agent-wrangler`.

## Behavior

- The dashboard is a column-aligned table with collapsible sections (*Waiting on you / Possibly stuck / Busy / Ended / Archived*); collapse state is remembered.
- **Click a session belonging to this window's workspace** → opens it in the official Claude Code panel (`claude-vscode.editor.open <sessionId>`), revealing the existing panel or resuming with `--resume=<id>` — fully interactive immediately.
- **Click a live panel session owned by another window** → cross-window relay: a note is written to a shared mailbox (extension globalStorage) watched by every Agent Wrangler instance, and the owning window is focused via VSCode's own CLI; that window's instance opens the conversation in its Claude panel. If the project isn't open anywhere, a new window opens and claims the note on activation. (Requires the extension to be running in the target window — during F5-only iteration that means only dev-host windows participate; other windows still get focused.)
- **Click anything else from another project/window** → ended: terminal at the project folder running `claude --resume <id>`; live terminal sessions: read-only viewer.
- The eye button opens the read-only viewer for any session with a transcript.
- Row buttons: view transcript (ended sessions) and **archive** — archived sessions move to the always-last Archived section (collapsed by default), stop counting toward the status-bar bell, and never toast. The same button unarchives.
- Command palette: `Agent Wrangler: …` commands (dashboard, refresh, viewer, resume, copy id, reveal transcript).

## How status is detected (passive — nothing is written to your Claude config)

| Signal | Meaning |
|---|---|
| `~/.claude/sessions/<pid>.json` + pid alive | session is live (registry gives cwd + friendly name) |
| last transcript line: assistant `stop_reason: end_turn` | **Waiting on you** |
| last transcript line: assistant `tool_use` / user / queue-op | **Busy** |
| busy but transcript silent > `stuckThresholdSeconds` | **Possibly stuck** (permission prompt or long tool) |
| pid gone | **Ended** |

Transcripts are read incrementally (bounded tail reads with a per-file byte offset) — large files are never loaded whole.

## Settings

`agentWrangler.claudeBinaryPath` · `stuckThresholdSeconds` (60) · `endedWindowHours` (48) · `maxEndedSessions` (50) · `notifyOnWaiting` (false — toast when an agent flips to waiting) · `pollIntervalSeconds` (5)

## Development

```bash
npm run watch      # esbuild watch (also started automatically by F5)
npm run typecheck  # tsc --noEmit
npm test           # vitest: tail parser, status table, live ~/.claude smoke test
```

Source layout: `src/claude/*` (registry reader, incremental tail parser, status derivation, provider), `src/core/*` (provider-agnostic store), `src/ui/*` (dashboard view, viewer panels, status bar, terminal resume), `src/webview/*` (browser bundles). Webview code may only import from `src/shared/*`.

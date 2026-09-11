# Conversation pane: work every Claude Code session from one window

Status: **approved plan, not yet implemented.** Branch: `feat/conversation-pane`, which has
its own worktree at `../AgentWrangler-conversation-pane` — work there, never in the primary
checkout, which stays on `main`.
Written 2026-09-11 after a design discussion and a live spike; the implementing agent
should treat every "Verified" item below as fact and every "Unverified" item as something
to confirm in the first task that touches it.

---

## 0. Read this first

### The goal in one paragraph

Clicking a session row in the Agent Wrangler dashboard today *goes to wherever the session
lives*: the Claude Code panel, an integrated terminal, or (worst) another VSCode window via
the cross-window relay. James works from one VSCode window and hates the attention snap.
The fix is a **Conversation pane inside this extension**: a webview panel that opens beside
the dashboard, renders the clicked session's conversation properly (markdown, tool calls,
results, thinking, permissions), lets him **answer permission prompts** there, and, for
sessions this extension runs itself, lets him **type**. A row click must never focus another
window again. "Go to its window" survives only as a secondary button.

### Decisions already made (do not re-litigate)

1. **Two conversation sources, one renderer.** A `TranscriptSource` tails the JSONL
   transcript (works for every session, anywhere, read-only + hook-based permissions). A
   `RunnerSource` drives a Claude Code process the extension owns through the official
   **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, full duplex). Both emit the same
   block model, so the webview does not know which one it is looking at.
2. **Use the SDK, not the raw stream-json control protocol.** The raw protocol is only typed
   in the SDK's `.d.ts`, not documented. The SDK is bundled into `dist/extension.js` with an
   esbuild `define`/`banner` for `import.meta.url` (see §2.5; verified to load).
3. **Always pass `pathToClaudeCodeExecutable`.** Never rely on the SDK's bundled platform
   binary package. Resolve the binary as described in §3.7.
4. **Adopting a session = end its process, then resume the same id in our runner.** Only
   offered when the session is idle (`waiting`, `done`) or `ended`. Never while `busy`, `stuck`
   or `blocked`: that would abort the in-flight turn. Resume keeps the same session id and
   appends to the same transcript (verified), so an idle session loses nothing.
5. **One reusable pane** (`agentWrangler.conversation`) that swaps sessions on row click with
   `preserveFocus`, plus a **pin** action that opens a dedicated per-session panel. The
   existing read-only viewer becomes the pinned panel's basis and is otherwise retired.
6. **Markdown via `markdown-it` with `html: false`** (raw HTML escaped, so no sanitizer
   needed). No inline styles (webview CSP forbids them); classes only.
7. **Phases ship independently.** Phase 1 alone already fixes the attention snap. Do not
   start Phase 2 until Phase 1 is installed and used for a day.
8. **Runner sessions are keyed by session id, never by pid.** The SDK does not expose the
   child pid, and the process is a descendant of *our* extension host, so
   `SessionLocator` would misreport it as a Claude Code panel session.

### How to work in this repo

- Build/typecheck/test: `npm run build`, `npm run typecheck`, `npm test` (vitest, pure
  functions; `test/live.integration.test.ts` reads the real `~/.claude` and self-skips when
  absent).
- **After every code change run `npm run install-local` yourself.** It builds, packages
  the `.vsix`, and installs it over the current version. **Never reload a VSCode window
  automatically** and never run `npm run install-local:reload`: *Developer: Reload Window*
  kills every Claude Code session in that window. Say "a reload is needed" and stop.
- The repo is **public** (`hammonjj/AgentWrangler`). No real project paths, session titles,
  prompts or transcript content in code, tests, fixtures, docs or commit messages. Test
  fixtures use `/Users/test/proj`-style paths (see `test/fixtures.ts`).
- Webview code (`src/webview/**`) may import **only** from `src/shared/**`. `src/shared/**`
  must stay free of `vscode`, Node and DOM imports (it is bundled into both worlds).
- The dashboard is used **narrow** (300–370 CSS px). The conversation pane will usually be
  wider, but must degrade to ~400 px.
- Several agents work this repo at once. `CLAUDE.md` has the rules; the ones that bite here:
  commit **by path**, never `git commit -a` or a blind `git add -A`; never `git checkout` in a
  tree you did not create; say which tree you installed from, because `install-local` installs
  whichever tree it ran in and the last one wins.
- This worktree's `node_modules` is a **symlink to the primary tree's**. Phase 2 adds
  dependencies, so that `npm i` writes into the shared directory and the primary tree sees
  them before the merge. Harmless, but say so rather than letting it surprise anyone.
- Commit messages: imperative summary line, body explains *why*. Keep the co-author trailer
  the harness gives you.

---

## 1. What exists today (read these files before designing anything)

| Concern | Where | Notes |
|---|---|---|
| Row click routing | `src/ui/openTarget.ts`, `src/ui/sessionLocator.ts`, `src/extension.ts` (`actions.smartOpen`) | `openTargetFor(session, locationKind, inWorkspace)` → `'panel' \| 'terminal' \| 'window' \| 'resume' \| 'viewer'`. Pure; tests in `test/openTarget.test.ts`. |
| Cross-window relay (the thing being demoted) | `src/ui/relay.ts` | Writes a note into globalStorage and focuses the owning window with the `code` CLI. Keep it; it becomes the "Focus its window" secondary action. |
| Read-only viewer | `src/ui/viewerPanel.ts`, `src/webview/viewer/main.ts`, `src/webview/viewer/viewer.css`, `src/claude/transcriptRender.ts` | Incremental tail (`readRange` + `splitCompleteLines` from `transcriptTail.ts`), `linesToBlocks` → `ViewerBlock[]` (user/assistant/tool only, thinking and tool results dropped, text capped at 6000 chars), 2 s follow poll while busy, stick-to-bottom scrolling. Reuse the tailing; replace the block model and renderer. |
| Permission Allow/Deny from the dashboard | `src/claude/hookLog.ts` (`HookLog.decide`, `pendingRequestExists`), `src/claude/claudeProvider.ts` (`decidePermission`), `src/extension.ts` (`actions.decidePermission`), README "Allow / Deny from the dashboard" | Works for any session with hooks installed: the PermissionRequest hook script polls for `~/.claude/agentwrangler/decisions/<id>.json`; Claude Code races the hook against its own dialog. `AgentSession.permissionRequestId` is set only while the decision can still land. `AskUserQuestion` and `ExitPlanMode` **ignore** hook decisions. |
| What a permission is for | `src/claude/permissionDetail.ts` | One-line subject from `tool_input`. Reuse in permission cards. |
| Session model + wire protocol | `src/shared/model.ts` (`AgentSession`, `SessionStatus`, `ViewerBlock`), `src/shared/messages.ts` | Host↔webview messages are discriminated unions; add new ones here. |
| Store / provider | `src/core/sessionStore.ts`, `src/core/provider.ts`, `src/claude/claudeProvider.ts`, `src/claude/registry.ts` | Sessions come from `~/.claude/sessions/<pid>.json` (live) + transcript index (ended). Key is `claude:<sessionId lower-case>`. Store fires only on material change (`materialFingerprint`). |
| Dashboard host + webview | `src/ui/dashboardHost.ts`, `src/ui/dashboardPanel.ts`, `src/ui/dashboardView.ts`, `src/webview/dashboard/main.ts` | Host decorates `openTarget` per snapshot (`pushSnapshotAsync`); webview posts `rowClick` / `action`. `clickHint()` is the row tooltip. `DashboardPanelManager` is the model for a single reusable panel with a serializer. |
| Webview HTML shell | `src/ui/html.ts` | Strict CSP: `default-src 'none'; style-src <cspSource>; script-src 'nonce-…'; img-src <cspSource> data:`. One CSS + one JS bundle per webview from `dist/webview/<name>.{js,css}`; `bundleName` is a string union to extend. |
| Build | `esbuild.mjs` | Host bundle: cjs/node20, `external: ['vscode']`. Web bundles: iife/browser, `entryNames: '[dir]'`, one entry per `src/webview/<name>/main.ts`. |
| Terminal resume | `src/ui/terminal.ts` | `claude --resume <id>` in a new integrated terminal at `session.cwd`. Reuse for "Release to terminal". |
| Config | `src/core/config.ts` + `package.json` `contributes.configuration` | Add new settings in both places and in `getConfig` in `extension.ts`. |

---

## 2. Verified facts (2026-09-11, this machine)

Everything in this section was observed, not assumed. Versions: Claude Code binary
**2.1.267** (the one bundled with the VSCode extension at
`~/.vscode/extensions/anthropic.claude-code-2.1.267-darwin-arm64/resources/native-binary/claude`),
Agent SDK **0.3.268**, Node 26 in the shell (the extension host runs VSCode's Node).

### 2.1 Headless sessions behave like real sessions

Running `claude -p --input-format stream-json --output-format stream-json --verbose` with no
prompt yet:

- Writes `~/.claude/sessions/<pid>.json` immediately with `kind: "interactive"`, `sessionId`,
  `cwd`, `startedAt`, `messagingSocketPath`, a derived `name`. The existing provider therefore
  lists runner sessions automatically. The entry disappears on exit.
- Runs the user's hooks: `SessionStart` was logged to `~/.claude/agentwrangler/<pid>.jsonl`.
  **So the Agent Wrangler PermissionRequest hook also fires for runner sessions** (see §5.3).
- Creates no transcript file until the first prompt (same as the TUI).
- The stream carries `system` messages before any turn (`hook_started` / `hook_response`).
- The process exits when stdin closes.

### 2.2 The SDK spike (4 haiku turns in a scratch cwd)

`query({ prompt: <async iterable of user messages>, options: { pathToClaudeCodeExecutable,
cwd, model: 'claude-haiku-4-5-20251001', includePartialMessages: true, canUseTool,
onUserDialog, supportedDialogKinds: [], permissionMode: 'default' } })`:

| Observation | Detail |
|---|---|
| Auth | `system/init` had `apiKeySource: "none"` — the OAuth claude.ai login is used; no API key involved. Cost fields are estimates, not a bill. (Whether Anthropic's consumer terms are happy with a third-party frontend is a policy question, not a technical one; this *is* Claude Code's own binary and SDK.) |
| Turn lifecycle | `system/init` is re-emitted at the start of **every** turn (carries `permissionMode`, `model`, `slash_commands`, `tools`, `capabilities`). `system/status` with `status: 'requesting' \| 'compacting' \| null` and sometimes `permissionMode`. Exactly one `result` per turn = turn complete (`is_error`, `result` text, cumulative `total_cost_usd`, `permission_denials`, `queued_turn_count`). |
| Streaming | With `includePartialMessages`, `stream_event` messages carry raw Messages-API events (`content_block_start/delta/stop`, `message_start/delta/stop`); the complete `assistant` message follows anyway. 135 events over 3 short turns. |
| Assistant messages | `assistant.message.content` blocks: `thinking`, `text`, `tool_use` (one block per SDK message while streaming; `stop_reason` null on those). |
| Tool results | Arrive as `user` messages with `message.content = [{type:'tool_result', tool_use_id, content, is_error?}]` **and** a structured `tool_use_result` sibling (e.g. Bash: `{stdout, stderr, interrupted, isImage, noOutputExpected}`; Write: `{type, filePath, content, structuredPatch, originalFile, userModified}`). |
| Permission prompt | `canUseTool(toolName, input, options)` fired for `AskUserQuestion` and `ExitPlanMode`. `options` had `toolUseID`, `displayName`, `suggestions` (empty here), and may carry `title`, `description`, `decisionReason`, `blockedPath`, `signal`, `requestId`. A plain `Bash echo` did **not** prompt because the user's own permission rules allowed it — the runner inherits the exact permission behaviour of the TUI. |
| AskUserQuestion | Input `{questions: [{question, header, options: [{label, description, preview?}], multiSelect?}]}`. Answer with `{behavior:'allow', updatedInput: {...input, answers: { [question.question]: label }}}` (multi-select answers comma-separated). The tool_result then read "Your questions have been answered…". |
| ExitPlanMode | Input `{plan: string, planFilePath: string}` (plan file under `~/.claude/plans/`). `{behavior:'allow', updatedInput: input}` approved it: the CLI switched `permissionMode` back to `default` and emitted `system/status {permissionMode:'default'}`; tool_result "User has approved your plan…". A deny with `message` is how to send feedback (Unverified: exact wording the CLI expects; use `{behavior:'deny', message: <feedback>}`). |
| Mode switch | `query.setPermissionMode('plan')` mid-session worked and was reflected in the next `init`. |
| Resume | A second `query({ options: { resume: <id>, cwd } })` kept the **same session id**, appended to the **same** JSONL (67 → 76 lines, still one file), fired `SessionStart` with `source: resume`, and the model remembered the earlier turn. |
| Other message types seen | `system/thinking_tokens`, `rate_limit_event`. Treat unknown `type`/`subtype` as ignorable (log at debug). |

### 2.3 SDK API surface used (from `sdk.d.ts`, v0.3.268)

```ts
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage,
         type CanUseTool, type PermissionResult, type PermissionMode } from '@anthropic-ai/claude-agent-sdk';

query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query
// Query extends AsyncGenerator<SDKMessage, void> and adds:
//   interrupt(): Promise<…>            setPermissionMode(mode): Promise<void>
//   setModel(model?): Promise<void>    supportedCommands(): Promise<SlashCommand[]>
//   supportedModels(): Promise<ModelInfo[]>   initializationResult(): Promise<…>
//   streamInput(stream): Promise<void>  backgroundTasks(toolUseId?): Promise<boolean>
//   close(): void   // force-kill the subprocess

// Options fields used: abortController, cwd, resume, sessionId, forkSession, model,
//   permissionMode, canUseTool, onUserDialog, supportedDialogKinds, includePartialMessages,
//   includeHookEvents, pathToClaudeCodeExecutable, stderr, env, settingSources, extraArgs,
//   persistSession (leave default true), title.

type SDKUserMessage = { type: 'user'; message: { role: 'user'; content: string | ContentBlock[] };
                        parent_tool_use_id: string | null; uuid?: string; session_id?: string; shouldQuery?: boolean };

type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal; toolUseID: string; requestId: string;
  suggestions?: PermissionUpdate[]; blockedPath?: string; decisionReason?: string;
  title?: string; displayName?: string; description?: string;
  defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean; agentID?: string;
}) => Promise<PermissionResult | null>;   // NEVER return null (fail-closed: tool blocks forever)

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

"Always allow" = return `updatedPermissions: options.suggestions` with the allow (that is
what the TUI's "don't ask again" does). Omit when `suppressAlwaysAllowRule` is true.

`onUserDialog` + `supportedDialogKinds: []` means the CLI emits no dialogs and degrades to
its no-dialog behaviour. That is fine for v1; the only known kind is
`'refusal_fallback_prompt'`.

### 2.4 Message shapes on the wire (subset)

```ts
{ type:'system', subtype:'init', session_id, model, permissionMode, cwd, tools:string[],
  slash_commands:string[], terminal_slash_commands?:string[], capabilities?:string[], apiKeySource, claude_code_version }
{ type:'system', subtype:'status', status:'requesting'|'compacting'|null, permissionMode? }
{ type:'system', subtype:'compact_boundary', compact_metadata:{trigger, pre_tokens, post_tokens?} }
{ type:'system', subtype:'permission_denied', tool_name, tool_use_id, decision_reason? }
{ type:'system', subtype:'notification', key, text, priority }
{ type:'system', subtype:'task_notification', task_id, status, summary }
{ type:'system', subtype:'session_state_changed', state:'idle'|'running'|'requires_action' }  // not seen in spike; handle if present
{ type:'assistant', message:{ id, model, content:Block[], stop_reason }, parent_tool_use_id, uuid, error?, aborted? }
{ type:'user', message:{ role:'user', content }, parent_tool_use_id, tool_use_result?, uuid? }
{ type:'stream_event', event: RawMessageStreamEvent, parent_tool_use_id, uuid }
{ type:'result', subtype:'success'|<error subtypes>, is_error, result:string, total_cost_usd, num_turns, permission_denials, queued_turn_count? }
{ type:'tool_progress', tool_use_id, tool_name, elapsed_time_seconds }
{ type:'tool_use_summary', summary, preceding_tool_use_ids }
{ type:'rate_limit_event', ... }
```

`parent_tool_use_id !== null` means the message belongs to a subagent; collapse those under
the parent `Agent` tool block.

### 2.5 Bundling the SDK into the extension (verified)

`sdk.mjs` imports only Node built-ins (its declared peer deps `zod`, `@anthropic-ai/sdk`,
`@modelcontextprotocol/sdk` are type-only). A plain esbuild CJS bundle **crashes at load**
because the module calls `createRequire(import.meta.url)` at top level and `import.meta.url`
is empty in CJS. Fix, verified to build and load:

```js
// esbuild.mjs, host config
define: { 'import.meta.url': '__aw_import_meta_url' },
banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
```

Bundle grows by ~1.6 MB. `npm run typecheck` passes with `skipLibCheck` and no peer deps
installed; add `@anthropic-ai/sdk` as a devDependency only if you want real types for
`MessageParam` / `BetaMessage` instead of `any`. Pin the SDK to an exact version
(`"@anthropic-ai/claude-agent-sdk": "0.3.268"`): the wire protocol is version-coupled.
`.vscodeignore` already excludes `node_modules/**`, so the `.vsix` stays small.

### 2.6 CLI flags (for reference; the SDK sets them)

`-p/--print`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`,
`--include-partial-messages`, `--resume <id>`, `--session-id <uuid>`, `--fork-session`,
`--permission-mode <mode>`, `--model <m>`, `--setting-sources`, `--replay-user-messages`,
`--no-session-persistence`.

### 2.7 What is *not* possible

There is no documented way to type into a running **interactive** (TUI) session from another
process. Remote Control is human-only; the per-process socket in `/tmp/cc-socks/` is
undocumented and keyed by a secret. `vscode.Terminal.sendText` works only for terminals in
this window and only for single-line text (a newline submits). Do not build on either.

---

## 3. Architecture

```
 ┌──────────────── dashboard (existing) ────────────────┐      row click ──► ConversationPanelManager.show(key)
 │ rows … [Blocked] [Allow] [Deny] … (+) new session    │
 └──────────────────────────────────────────────────────┘
                                                              ┌──────────── Conversation pane (webview) ────────────┐
 SessionStore ──► AgentSession (status, pid, cwd, …)  ───────►│ header: title · status · project · branch · model     │
                                                              │         [Go to window/terminal/panel] [Adopt] [Pin]   │
 ConversationHost ◄── ConversationSource ◄── one of:          │ blocks: user / assistant(md) / thinking▸ / tool ▸ …   │
      │                 ├─ TranscriptSource (tail JSONL)      │         permission card [Allow][Always][Deny]         │
      │                 │    permissions via HookLog.decide   │         question card / plan card                     │
      │                 └─ RunnerSource (RunnerSession)       │ composer: [mode ▾][model ▾] textarea [Send][Stop]     │
      ▼                        ▲                              └───────────────────────────────────────────────────────┘
 HostToConversation msgs       │
                        RunnerService ── query() ── claude (child process, cwd = session.cwd)
                               │
                        globalState: runner-owned session ids (re-adopt after reload)
```

### 3.1 Block model (`src/shared/conversation.ts`, new)

Both sources produce these. Every block has a stable `id` so the host can `patch` it.

```ts
export type ConvBlock =
  | { kind: 'user'; id: string; ts?: string; text: string; imageCount?: number }
  | { kind: 'assistant'; id: string; ts?: string; msgId?: string; text: string; streaming?: boolean; model?: string }
  | { kind: 'thinking'; id: string; ts?: string; text: string; streaming?: boolean }          // collapsed by default
  | { kind: 'tool'; id: string; ts?: string; toolUseId: string; name: string; inputPreview: string;
      input?: unknown; result?: ToolResultView; state: 'running' | 'done' | 'error'; parentToolUseId?: string }
  | { kind: 'permission'; id: string; requestId: string; toolName: string; title?: string; description?: string;
      detail?: string; input?: unknown; canAlwaysAllow: boolean; state: AskState }
  | { kind: 'question'; id: string; requestId: string; questions: QuestionView[]; state: AskState; answers?: Record<string, string> }
  | { kind: 'plan'; id: string; requestId: string; plan: string; planFilePath?: string; state: AskState }
  | { kind: 'note'; id: string; ts?: string; tone: 'info' | 'warn' | 'error'; text: string };  // compaction, errors, adopted/released, ended

export type AskState = 'pending' | 'allowed' | 'denied' | 'expired';
export interface ToolResultView { text: string; isError: boolean; truncated: boolean; diff?: { file: string; patch: string } }
export interface QuestionView { question: string; header: string; multiSelect?: boolean; options: { label: string; description: string }[] }
```

Caps: keep the existing 6000-char text cap per block, 220 DOM blocks in the webview, and a
`truncated` flag on init. Tool results are capped at ~4000 chars in the host with a
"show full" that asks the host for the rest (`requestToolResult`), so large outputs never
cross the wire unasked.

### 3.2 Wire protocol (`src/shared/messages.ts`, add)

```ts
export interface ConversationCapabilities {
  canSend: boolean;            // runner-owned
  canInterrupt: boolean;
  canAdopt: boolean;           // idle/ended, not runner-owned, has cwd on disk
  canRelease: boolean;         // runner-owned
  goTo?: { label: string; target: 'panel' | 'terminal' | 'window' };   // the old smartOpen, demoted
  estimated: boolean;          // statusIsEstimated (no hooks) → banner
}
export interface ComposerState { permissionMode: PermissionModeName; model?: string; slashCommands: string[];
                                 busy: boolean; queued: number; }

export type HostToConversation =
  | { type: 'init'; session: SessionDTO; blocks: ConvBlock[]; truncated: boolean; caps: ConversationCapabilities; composer?: ComposerState }
  | { type: 'append'; blocks: ConvBlock[] }
  | { type: 'patch'; id: string; block: Partial<ConvBlock> }      // streaming text, tool results, ask state
  | { type: 'session'; session: SessionDTO; caps: ConversationCapabilities }
  | { type: 'composer'; composer: ComposerState }
  | { type: 'toolResult'; id: string; text: string }              // answer to requestToolResult
  | { type: 'error'; text: string };

export type ConversationToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'interrupt' }
  | { type: 'decide'; requestId: string; decision: 'allow' | 'always' | 'deny'; message?: string }
  | { type: 'answer'; requestId: string; answers: Record<string, string> }
  | { type: 'plan'; requestId: string; decision: 'approve' | 'deny'; feedback?: string }
  | { type: 'setPermissionMode'; mode: PermissionModeName }
  | { type: 'setModel'; model?: string }
  | { type: 'adopt' } | { type: 'release' } | { type: 'goTo' } | { type: 'pin' } | { type: 'resumeHere' }
  | { type: 'requestToolResult'; id: string }
  | { type: 'openExternal'; url: string } | { type: 'openFile'; path: string };
```

`PermissionModeName` lives in `src/shared` as a string union mirroring the SDK's
`PermissionMode` (shared code must not import the SDK).

### 3.3 `ConversationSource` (`src/ui/conversation/source.ts`, new)

```ts
export interface ConversationSource extends Disposable {
  readonly kind: 'transcript' | 'runner';
  init(): Promise<{ blocks: ConvBlock[]; truncated: boolean }>;
  onAppend(listener: (blocks: ConvBlock[]) => void): Disposable;
  onPatch(listener: (id: string, block: Partial<ConvBlock>) => void): Disposable;
  onComposer?(listener: (c: ComposerState) => void): Disposable;
  decide?(requestId: string, decision: 'allow' | 'always' | 'deny', message?: string): Promise<boolean>;
  answer?(requestId: string, answers: Record<string, string>): Promise<boolean>;
  decidePlan?(requestId: string, approve: boolean, feedback?: string): Promise<boolean>;
  send?(text: string): Promise<void>;
  interrupt?(): Promise<void>;
  setPermissionMode?(mode: PermissionModeName): Promise<void>;
  setModel?(model?: string): Promise<void>;
  fullToolResult?(id: string): string | undefined;
}
```

**`TranscriptSource`** wraps the existing tailing from `viewerPanel.ts` (`INIT_TAIL_BYTES`,
`readRange`, `splitCompleteLines`, the 2 s follow poll while busy, `onTranscriptAppended`)
and a new pure `transcriptBlocks.ts` (successor of `transcriptRender.linesToBlocks`) that
also emits `thinking`, pairs `tool_result` lines to their `tool_use` (by `tool_use_id`),
collapses `isSidechain` lines under the parent tool, and turns `toolUseResult.structuredPatch`
into a diff view when present. Its permission card comes from the store: when
`session.status === 'blocked'` and `permissionRequestId` is set, emit/patch one `permission`
block (detail from `blockedDetail`, `canAlwaysAllow: false`); `decide` calls
`provider.decidePermission`. When `permissionRequestId` disappears, patch state to
`expired` (answered in Claude Code) unless we answered it.

**`RunnerSource`** adapts a `RunnerSession` (below): its `blocks` array is authoritative and
persists while the pane is closed, so reopening re-inits from memory.

### 3.4 `RunnerService` / `RunnerSession` (`src/core/runner/`, new; no `vscode` imports so it is testable)

```ts
export class RunnerService implements Disposable {
  constructor(deps: { binary: () => string; log; state: RunnerStateStore /* globalState adapter */ });
  start(opts: { cwd: string; resume?: string; permissionMode?: PermissionModeName; model?: string }): RunnerSession;
  get(sessionId: string): RunnerSession | undefined;
  owns(sessionId: string): boolean;
  list(): RunnerSession[];
  onDidChange(listener): Disposable;          // start/init/state/end
  dispose(): void;                            // end() every session, then close() stragglers after 3 s
}

export class RunnerSession {
  readonly cwd: string;
  sessionId?: string;                         // known after the first system/init (or from opts.resume)
  state: 'starting' | 'idle' | 'running' | 'ending' | 'ended' | 'error';
  composer: ComposerState;                    // permissionMode/model/slashCommands from init; busy/queued from turn tracking
  readonly blocks: ConvBlock[];               // bounded (drop oldest past ~2000; keep pending asks)
  readonly pending: Map<string, PendingAsk>;  // requestId → resolver + block id
  send(text: string): void;                   // pushes an SDKUserMessage; CLI queues if a turn is running
  interrupt(): Promise<void>;
  setPermissionMode(mode): Promise<void>;  setModel(model?): Promise<void>;
  decide(requestId, decision, message?): boolean;  answer(requestId, answers): boolean;  decidePlan(requestId, approve, feedback?): boolean;
  end(): Promise<void>;                       // close stdin iterable → graceful exit; force close() after 5 s
  onAppend / onPatch / onStateChange / onComposer
}
```

Implementation notes:

- Input is a push-based `AsyncIterable<SDKUserMessage>` (queue + resolver; see the spike
  pattern). `send` pushes `{ type:'user', message:{ role:'user', content: text }, parent_tool_use_id: null }`.
  Ending = mark closed and wake the iterator; the CLI exits on stdin EOF.
- `canUseTool` creates a `PendingAsk` and returns its promise. Route by `toolName`:
  `AskUserQuestion` → `question` block; `ExitPlanMode` → `plan` block; everything else →
  `permission` block (detail via `permissionDetail(toolName, input, cwd)`, prefer
  `options.title`/`description` when present, `canAlwaysAllow = !!options.suggestions?.length && !options.suppressAlwaysAllowRule`).
  Resolve with the shapes in §2.2/§2.3. On `options.signal` abort (answered elsewhere, e.g.
  the dashboard's hook path, or the turn was interrupted) patch the block to `expired` and
  drop the pending entry; the SDK ignores a late response, but still resolve the promise
  (deny) so nothing leaks.
- Reduce SDK messages into blocks in a **pure** `runnerBlocks.ts` (`reduce(state, msg) →
  { state, appends, patches }`) so it is unit-testable with synthetic messages:
  - `stream_event`: `content_block_start(text|thinking)` opens a streaming block;
    `content_block_delta` appends `text_delta` / `thinking_delta`; `content_block_stop` ends
    streaming. Ignore `tool_use` deltas (the complete `assistant` message carries them).
  - `assistant`: for each content block — `text`/`thinking`: replace the streaming block's
    text (dedupe by the streaming block opened for this message, else append); `tool_use`:
    append a `tool` block `state:'running'` keyed by `tool_use_id`. `parent_tool_use_id` set →
    attach to the parent tool block instead (subagent).
  - `user` with `tool_result` blocks: patch the matching tool block (`state` from `is_error`,
    text from `content`, diff from `tool_use_result.structuredPatch` when the tool is
    Edit/Write/MultiEdit). Plain `user` text from the CLI (e.g. slash-command expansions)
    → `user` block only if it is not a tool result and not `isSynthetic`.
  - `system/init` → composer (mode, model, slash commands). `system/status` → `busy`
    (`requesting`/`compacting`) and `permissionMode` when present. `compact_boundary` →
    `note`. `permission_denied` → patch that tool block to `error` + note. `notification`
    → `note`. `result` → `busy=false`, `queued = queued_turn_count ?? 0`; `is_error` → `note`
    tone `error` with `result` text.
  - Anything else: ignore.
- `state` machine: `starting` → (`init`) `idle`; `send` → `running`; `result` → `idle`
  (or `running` if `queued_turn_count > 0`); generator returns → `ended`; generator throws
  → `error` + `note`.
- Persist `{ sessionId, cwd, lastShownAt }` per runner session in globalState (through a
  small adapter interface so core stays vscode-free). Remove on clean `end()`. Whatever is
  left at activation was killed by a reload or quit: §4 Phase 3 turns that into "Resume here".
- `stderr` → the Output channel at debug verbosity (the binary is chatty).
- `env`: pass `{ ...process.env }`; do not set `ANTHROPIC_API_KEY`.

### 3.5 Panel management (`src/ui/conversation/conversationPanel.ts`, new)

Mirror `DashboardPanelManager`: one `WebviewPanel` of type `agentWrangler.conversation`,
`retainContextWhenHidden`, serializer so VSCode restores it on reload, `show(key, {preserveFocus:true})`
creates or reveals it (`ViewColumn.Beside` on first creation, configurable to `Active`) and
swaps the `ConversationHost` to the new session. `pin(key)` opens a second, per-session panel
(the successor of `ViewerPanelManager`) that is never swapped.

`ConversationHost` (`src/ui/conversation/conversationHost.ts`) owns: the current
`ConversationSource`, the store subscription (title/status/caps changes), message dispatch,
and the `goTo`/`adopt`/`release` actions through a `ConversationActions` interface added to
`src/ui/actions.ts`.

### 3.6 Click routing (`src/ui/openTarget.ts`, rewrite)

- `openTargetFor` now returns `'conversation'` for every Claude session (live or ended) when
  `agentWrangler.rowClickOpens === 'conversation'` (new setting, default). The old behaviour
  stays reachable as `'wherever-it-runs'` for one release as a safety net.
- New pure `secondaryActionFor(session, location, inWorkspace, ownedByRunner)` →
  `'reveal-panel' | 'show-terminal' | 'focus-window' | 'adopt' | 'release' | 'resume-here' | undefined`.
  `adopt` only when `status ∈ {waiting, done}` and not `ownedByRunner` and `cwd` exists;
  `resume-here` when `status === 'ended'`; `release` when `ownedByRunner`.
- `LocationKind` gains `'runner'`; `dashboardHost.pushSnapshotAsync` asks
  `RunnerService.owns(sessionId)` **before** the locator (the locator would say `panel`).
- Dashboard: `clickHint()` says "Click to open the conversation"; rows owned by the runner
  get a small "here" chip; the title bar gets a `+` (new session) button.

### 3.7 Binary resolution (`src/claude/binary.ts`, new)

Order: `agentWrangler.claudeBinaryPath` if it is not the default `'claude'` → newest
`~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude` that exists
(sort by version, `fs.existsSync`) → `'claude'` on PATH. Log which one was picked once. Use it
for both the runner and `resumeInTerminal`. (Today PATH has 2.1.236 and the extension bundles
2.1.267; the bundled one is what the Claude Code panel runs.)

### 3.8 Settings to add

| Setting | Default | Meaning |
|---|---|---|
| `agentWrangler.rowClickOpens` | `"conversation"` | `"conversation"` \| `"wherever-it-runs"` (old behaviour). |
| `agentWrangler.conversation.openBeside` | `true` | First open uses `ViewColumn.Beside`; `false` → `Active`. |
| `agentWrangler.runner.defaultPermissionMode` | `"default"` | Mode for sessions started here. |
| `agentWrangler.runner.model` | `""` | Empty = Claude Code's default. |
| `agentWrangler.runner.autoResumeLastOnStartup` | `true` | Re-adopt the session the pane was showing when the window died. |

Add each to `package.json` `contributes.configuration`, `WranglerConfig` + `DEFAULT_CONFIG`
in `src/core/config.ts`, and `getConfig` in `src/extension.ts`.

---

## 4. Phases

Each phase ends with: `npm run typecheck && npm test` green, `npm run install-local` run,
README updated for the behaviour that changed, and a note to James that a reload is needed.

### Phase 1 — The pane replaces window-jumping (read + permissions, no typing) — **SHIPPED 2026-09-11**

Outcome: clicking any row opens the Conversation pane beside the dashboard with a proper
rendering of the session, permission prompts can be answered from it, and nothing ever
focuses another window.

**What shipped, and where it differs from the plan below.** Read these before phase 2; the
task list that follows is the original plan, kept for context.

- Files landed as planned, plus `src/shared/markdown.ts` — the `markdown-it` instance moved
  into `shared` so the `html: false` escaping could be tested without a DOM
  (`test/markdown.test.ts`). `markdown-it` is therefore a phase 1 dependency, not phase 2.
- `secondaryActionFor` does **not** take `ownedByRunner` and does not return `adopt` /
  `release` yet. There is no runner to adopt into, and a button that cannot work is worse
  than no button. Phase 3 adds the parameter and those two results.
- **Subagent lines are skipped, not nested.** The plan said to collapse `isSidechain` lines
  under their parent tool. The transcript does not stamp them with the `tool_use_id` of the
  Agent call that spawned them, so there is nothing reliable to nest them under; the parent
  Agent block still shows the call and its report. Revisit only if a linking field appears.
- **`fullToolResult` is not implemented for the transcript source.** Results are capped at
  `MAX_TOOL_RESULT_CHARS` in the reducer and the card says the output was truncated. The
  `requestToolResult` message exists in the protocol for the runner, which holds the full
  text in memory; the transcript source would have to re-read and re-parse the file for it.
- `docs/**` was added to `.vscodeignore`: this plan was shipping inside the `.vsix`.
- The old viewer is gone (`viewerPanel.ts`, `transcriptRender.ts`, `src/webview/viewer/*`,
  `ViewerBlock`, `HostToViewer`/`ViewerToHost`). `agentWrangler.openViewer` became
  `agentWrangler.openConversation`, plus `pinConversation` and `goToSession`.
- Tests: 255 pass. New files are `test/transcriptBlocks.test.ts` (18 cases),
  `test/markdown.test.ts` (6), and a rewritten `test/openTarget.test.ts` (13).

Tasks:

1. `src/shared/conversation.ts` (block model), `src/shared/messages.ts` additions, `PermissionModeName`.
2. `src/claude/transcriptBlocks.ts`: pure JSONL → `ConvBlock[]` with thinking, tool/result pairing,
   sidechain collapsing, `structuredPatch` diff, `isMeta` skipping, 6000-char cap. Port
   `toolInputPreview`. Keep `transcriptRender.ts` until the old viewer is deleted, then remove.
3. `src/ui/conversation/{source.ts, transcriptSource.ts, conversationHost.ts, conversationPanel.ts}`.
   `TranscriptSource` reuses the tail/poll logic from `viewerPanel.ts` verbatim where possible.
4. `src/webview/conversation/{main.ts, conversation.css}` + `esbuild.mjs` entry +
   `html.ts` `bundleName` union. Renderer: `markdown-it` (`html:false, linkify:true`), code
   blocks with a copy button, collapsed thinking, tool cards (name + preview; click expands
   input and result; diff rendered as a simple +/- block), permission/question/plan cards
   (Phase 1 wires only the permission card's Allow/Deny), status pill, estimated banner,
   stick-to-bottom + "N new" jump (port from viewer). Header actions: Go-to (secondary),
   Pin. Composer area is present but disabled with the text "Read-only: this session runs
   in <location>. Adopt it to type here." (Adopt itself arrives in Phase 3; render the
   sentence without the button until then.)
5. `openTarget.ts` rewrite + `secondaryActionFor` + `rowClickOpens` setting; `extension.ts`
   `smartOpen` → `conversationPanel.show(key)`; `goTo` runs the old `smartOpen` body.
6. Dashboard: tooltip text, `+` button placeholder hidden until Phase 3, eye button now
   means Pin.
7. Retire `ViewerPanelManager`: pinned conversation panels replace it (`agentWrangler.openViewer`
   command now pins). Delete `src/webview/viewer/*` and `viewerPanel.ts` once nothing imports them.

Tests: `test/transcriptBlocks.test.ts` (build lines with `test/fixtures.ts`: text, tool_use +
tool_result pairing, thinking, sidechain, isMeta, structuredPatch, cap), `test/openTarget.test.ts`
rewritten for `'conversation'` + `secondaryActionFor` matrix, a markdown safety test on the
shared render helper (`<script>` and `<img onerror>` come out escaped).

Manual acceptance (James, after reload): click a session in another window → pane opens
here, that window does not come to front; blocked session → Allow from the pane works and
the card flips to *allowed*; answer in Claude Code instead → card flips to *expired*; ended
session → pane shows it with a "Resume in terminal" secondary action; pane at 400 px is
usable; dashboard at 300 px unchanged.

### Phase 2 — The runner: start a session here and talk to it

Outcome: "New conversation" starts a Claude Code session inside the extension for a chosen
project folder; the pane streams its output, shows permission/question/plan cards from
`canUseTool`, and the composer sends messages, interrupts, and switches permission mode.

Tasks:

1. `npm i -E @anthropic-ai/claude-agent-sdk@0.3.268 markdown-it` (+ `-D @types/markdown-it`);
   esbuild `define`/`banner` from §2.5. Confirm `npm run build && node -e "require('./dist/extension.js')"`
   fails only on the missing `vscode` module (i.e. the SDK loaded).
2. `src/claude/binary.ts` (§3.7); switch `resumeInTerminal` to it.
3. `src/core/runner/{runnerService.ts, runnerSession.ts, runnerBlocks.ts, inputQueue.ts, stateStore.ts}` (§3.4).
4. `src/ui/conversation/runnerSource.ts`; host picks `RunnerSource` when `runner.owns(sessionId)`.
5. Composer in the webview: textarea (Enter sends, Shift+Enter newline), Send/Stop, permission
   mode dropdown, model dropdown (from `supportedModels()`; fall back to a free-text field),
   slash-command autocomplete from `composer.slashCommands` (typed `/x` is sent as plain
   text — Unverified: that `/compact` etc. execute in stream-json mode; test with `/compact`
   on the first real session and, if they do not, hide the autocomplete), "queued N" chip.
6. Cards: question (radio/checkbox per `multiSelect`, free-text "Other"), plan (markdown
   plan, Approve / Request changes with feedback → deny with `message`), permission
   (Allow / Always allow when `canAlwaysAllow` / Deny with optional reason).
7. `agentWrangler.newConversation` command + dashboard `+`: quick pick of folders = distinct
   `cwd`s of store sessions ∪ workspace folders ∪ "Browse…" (`showOpenDialog`). Starts the
   runner and shows the pane.
8. Status: runner-owned sessions still get hook-based status through the existing pipeline
   (hooks fire), so no store changes are required. The pane's own `busy` comes from the
   stream and is authoritative for the composer.
9. `deactivate`/dispose: `RunnerService.dispose()` ends sessions gracefully.

Tests: `test/runnerBlocks.test.ts` with synthetic SDK messages following §2.2 shapes (init,
stream deltas → streaming text → complete assistant message dedupe, tool_use → tool_result
patch incl. `is_error`, Write `structuredPatch` → diff, result → idle/queued, compact
boundary, subagent nesting via `parent_tool_use_id`); `test/inputQueue.test.ts`;
`test/runnerSession.test.ts` with a fake `query` (inject the SDK `query` function via the
constructor so tests never spawn a process) covering `canUseTool` → pending ask → decide →
`PermissionResult` shapes for permission/question/plan, abort signal → expired, `end()`
closes the iterable. Optional live test `test/runner.live.test.ts` gated on
`AW_LIVE_RUNNER=1` (spends real usage; never in CI).

Manual acceptance: start a session in a real project; ask it to edit a file → permission
card → Allow → diff shows in the tool card; ask a question via AskUserQuestion → answer →
it continues; `/plan`-style flow: switch mode to plan, ask for a plan → plan card → Approve
→ mode returns to default; press Stop mid-turn → turn ends with a note; send two messages
quickly → second shows as queued and runs after; usage cards move after a few turns
(subscription is being used).

### Phase 3 — Adopt, release, survive reloads

Outcome: any idle session anywhere can be pulled into this window; a runner session can be
handed back to a terminal or the Claude Code panel; a window reload does not lose runner
sessions beyond the turn in flight.

Tasks:

1. **Adopt** (`ConversationActions.adopt(key)`): guard `secondaryActionFor === 'adopt'`;
   modal confirm "End the process running *X* in <location> and continue it here? Its
   terminal or panel will show the session as ended."; `process.kill(pid, 'SIGTERM')`; poll
   `isPidAlive` every 100 ms up to 5 s, then `SIGKILL` and wait 2 s more; then
   `runner.start({ cwd, resume: sessionId })`; pane switches source to the runner. If the
   store's status changes to `busy` between the click and the confirm, abort with a message.
   Ended sessions skip the kill and go straight to resume (`resume-here`).
2. **Release** (`ConversationActions.release(key)`): quick pick "Terminal" / "Claude Code
   panel (this workspace only)"; `runnerSession.end()` and wait for `ended`; then
   `resumeInTerminal` or `claude-vscode.editor.open <id>`.
3. **Re-adopt on activate**: read the persisted runner list; sessions found there but with
   no live registry entry get `resume-here` in the pane and a `note` "This session was
   running here before the window reloaded." If `autoResumeLastOnStartup`, resume the one
   with the newest `lastShownAt` automatically and show it.
4. Dashboard chip "here" for runner-owned rows; `LocationKind 'runner'` wiring in
   `dashboardHost.pushSnapshotAsync`; `secondaryActionFor` matrix complete.
5. README: rewrite "Clicking a row goes to wherever the session actually lives" into the
   new behaviour; document adopt/release and the reload story.

Tests: `secondaryActionFor` for adopt/release/resume-here; a `killAndWait` helper with an
injected `isAlive`; state-store round trip.

Manual acceptance: idle session in another window → Adopt → that window's panel/terminal
shows it ended, the pane here becomes interactive, sending a message continues the
conversation with context intact; Release to terminal → terminal opens with the session
resumed and the pane goes read-only; reload the window → the last shown session comes back
by itself, others offer Resume here.

### Phase 4 — Later, only if wanted

- A detached broker process owning runner children so a reload loses nothing at all.
- Image paste into the composer (content block `{type:'image', source:{type:'base64', media_type, data}}`).
- File `@` mentions via the SDK's file-suggestion control request; open tool-result diffs in
  VSCode's diff editor; `supportedDialogKinds: ['refusal_fallback_prompt']` with a dialog card.
- Terminal-in-this-window sessions: `terminal.sendText` for single-line messages (explicitly
  labelled "typed into the terminal").

---

## 5. Gotchas and traps

1. **`canUseTool` must always resolve.** Returning `null` or never resolving blocks the tool
   forever (fail-closed by design). Pending asks live in `RunnerSession`, not in the webview,
   so closing the pane must not orphan them.
2. **Runner children look like panel sessions to `SessionLocator`** (they are descendants
   of our extension host). Check `RunnerService.owns(sessionId)` first, always.
3. **Two permission surfaces for runner sessions.** The Agent Wrangler PermissionRequest hook
   fires for runner sessions too, so the dashboard's Allow/Deny (hook path) and the pane's
   card (`canUseTool`) coexist. Whichever answers first wins; handle `options.signal` abort
   in `canUseTool`, and expect the hook script to exit on the next `PreToolUse` event as it
   does today.
4. **`init` arrives every turn.** Treat it as a state update, not a "session started" event.
5. **Streaming dedupe.** With `includePartialMessages` a text block arrives as deltas *and*
   as a complete `assistant` message. Replace, do not append.
6. **`result` is the only reliable turn-complete signal.** `session_state_changed` was not
   observed in the spike; do not depend on it.
7. **Killing a process is the adopt mechanism, and it is visible.** The old terminal shows a
   dead prompt; the old Claude Code panel shows the session ended. Say so in the confirm.
8. **Never resume a session whose process is still alive.** Two writers interleave in one
   JSONL. `adopt` must wait for the pid to be gone before `resume`.
9. **Sessions with no transcript yet** (fresh runner before the first prompt) are hidden by
   the dashboard on purpose; the pane must render from the runner, not from the store.
10. **`cwd` must exist** (`fs.existsSync`) before spawning; `resumeInTerminal` already checks.
11. **Webview CSP**: no inline `style=`, no inline scripts; `markdown-it` output is fine, a
    hand-rolled renderer that sets `style` is not. Images only via `data:` or webview URIs.
12. **The store key is lower-cased** (`claude:<id>`); session ids from the SDK are lower-case
    UUIDs already, but normalise anyway.
13. **`vsce` packaging**: keep bundling everything; do not add `node_modules` to the `.vsix`.
14. **Public repo**: the spike used a scratch cwd for a reason. Fixtures must be synthetic.
15. **Do not reload windows.** Ever. Say it needs a reload.

---

## 6. Open questions and how to settle them

| Question | How to settle | Fallback |
|---|---|---|
| Do slash commands (`/compact`, `/clear`, `/model`) execute when sent as user text in stream-json mode? | Send `/compact` on the first real runner session; watch for `compact_boundary`. | Hide autocomplete; document "use the terminal for slash commands". |
| Exact plan-rejection contract for `ExitPlanMode`. | Deny with `message: <feedback>`; observe whether the model receives the feedback and stays in plan mode. | Approve-only UI plus a normal user message with feedback. |
| Does `query.interrupt()` produce a `result` (which subtype)? | Interrupt a long turn; log the result message. | Treat generator silence > 5 s after interrupt as idle. |
| Does the SDK set a distinct `entrypoint` in the registry (`sdk-ts`?) | Look at `~/.claude/sessions/<pid>.json` for a runner session. | Irrelevant: ownership is by session id. |
| Memory per runner child (each is a full Claude Code process). | Check Activity Monitor with three runner sessions open. | Cap concurrent runner sessions (setting) and end idle ones on request. |

---

## 7. Out of scope

Rebuilding the TUI's vim mode, `/config` screens, MCP management, keybinding customisation,
autocomplete for `@` files (Phase 4 at most), Codex sessions (the block model is
provider-neutral on purpose; a Codex source is a later provider), anything that types into a
TUI running in another window (impossible without undocumented internals).

---

## Appendix A — Transcript JSONL shapes the renderer needs

Lines are JSON objects; the fields used (see `src/claude/transcriptRender.ts`,
`transcriptTail.ts`, `test/fixtures.ts`):

- Common: `type`, `uuid`, `parentUuid`, `timestamp` (ISO), `sessionId`, `cwd`, `gitBranch`,
  `isSidechain` (subagent lines), `isMeta` (injected context; skip), `version`, `slug`.
- `type:'user'`: `message.content` is a string or an array of blocks: `{type:'text',text}`,
  `{type:'tool_result', tool_use_id, content: string | [{type:'text',text}], is_error?}`,
  `{type:'image', source}`. Tool-result lines usually also carry a top-level `toolUseResult`
  with the structured output (e.g. `structuredPatch` for edits). Slash-command expansions
  and system reminders appear as user text; render them as `note` when they start with a
  `<` tag or are `isMeta`.
- `type:'assistant'`: `message.id`, `message.model`, `message.stop_reason`
  (`end_turn` | `tool_use` | …), `message.content` blocks `{type:'text',text}`,
  `{type:'thinking', thinking}`, `{type:'tool_use', id, name, input}`. One API message is
  usually split over several lines sharing `message.id`; merge consecutive text blocks by
  `msgId` as the old renderer does.
- Other line types exist (`summary`, `ai-title`, `attachment`, `queue-operation`, …) and are
  not conversation content; `ai-title` is already used for the session title.

## Appendix B — The spike, for re-running

A throwaway script drove the SDK exactly as described in §2.2 (push-based input iterable,
`canUseTool` router, `onUserDialog` stub, haiku model, scratch cwd, then a second `query`
with `resume`). It is not in the repo because it hard-codes scratch paths; re-create it from
§2.2/§3.4 if a fact needs re-checking, always in a scratch cwd, and delete the scratch
project dir under `~/.claude/projects/` and any `~/.claude/plans/*.md` it leaves behind.

# Remote Agent Control

Answer a permission prompt from your phone, without opening a port, running a server, or building
a second permission system.

**What this is.** Remote Agent Control is a *remote presentation and input layer* for Agent
Wrangler. Discord does not talk to Claude Code or Codex, does not hold permission state, and does
not implement any agent semantics. It renders an interaction Agent Wrangler already has, and it
sends back a choice that Agent Wrangler maps to an action it already exposes. The agent never
learns Discord exists.

```
Agent
  │  existing provider/session interaction
  ▼
Agent Wrangler ──────────► local UI (dashboard row, conversation card)
  │
  └──────────────────────► remote mirror ──► Discord
                                               │ button press
                           remote mirror ◄─────┘
                                 │
                                 ▼
                          Agent Wrangler ── existing action ──► Agent
```

The hard constraint, applied throughout:

> Remote Agent Control owns only the state necessary to mirror Agent Wrangler interactions onto
> remote UI transports. It does not own the underlying agent interaction.

v1 is one vertical slice: a hook-backed Claude permission prompt is mirrored to a Discord channel
with **Allow once / Always allow ‹rule› / Deny**; an authorised press invokes exactly the same
`SessionActions.decidePermission` call the dashboard button makes; the message is then closed.

---

## 0. Note on this revision

The first version of this document (2026-09-20) got the Discord research right and the
architecture wrong. It modelled Remote Control as a system that *manages* permission requests: a
six-state `RemoteInteraction` machine, a `PermissionRequested`/`PermissionResolved` event pair, a
bespoke `PermissionResolver` port, a TTL clock, and a persisted copy of each interaction's state.
Every one of those duplicates state Agent Wrangler already owns and already recomputes from disk
on every scan. §12 lists exactly what was deleted, simplified and retained.

Two repository facts drive the rewrite, neither of which the first version used:

1. **`rowMenuItems(s: SessionDTO): RowMenuItem[]`** (`src/shared/rowMenu.ts:70`) is already this
   repo's pure, tested, shared-layer function from *a session* to *the actions currently legal on
   it*. That is the abstraction the first plan was about to reinvent. The remote ask should be its
   sibling, not a new concept.
2. **The `notifyOnWaiting` toast wiring** (`src/app/createApp.ts:809-831`) is already
   *store update → is this notable? → show a human a message with choices → route the chosen one
   back into `actions`*. Remote Control is that wiring with Discord as the dialog. Its shape also
   shows the convention: the pure decision lives in `src/shared`/`src/core`, the side-effecting
   closure lives in `createApp`.

---

## 0.1 Verified facts

Measured on this machine, 2026-09-21, against Claude Code 2.1.278 and Agent SDK 0.3.268. The
spike scripts are throwaway (`/tmp/aw-spike/`), not committed.

**A hook decision settles an SDK-driven ask, and it beats a pending `canUseTool`.** This was the
open question that gated everything, and the answer is better than the plan assumed.

Reproduction: an SDK `query` with `canUseTool` supplied — exactly what `RunnerSession` does, same
binary, same option — prompted to `Write` a file (`Bash(echo …)` is useless for this: the
machine's own `allow-readonly.py` PreToolUse hook auto-approves it, and then *neither*
`canUseTool` nor `PermissionRequest` fires at all).

1. **Both mechanisms fire.** `canUseTool` was called *and* the `PermissionRequest` hook ran,
   dropping marker `requests/<claudePid>-<shellPid>` and logging `PermissionRequest` +
   `AgentWranglerPermissionPending` to the pid log. The full event sequence for one gated Write:
   `SessionStart · UserPromptSubmit · PreToolUse(Write) · PermissionRequest(Write) ·
   AgentWranglerPermissionPending · PostToolUse(Write) · PostToolBatch · Stop · SessionEnd`.
2. **The decision file wins the race.** With `canUseTool` deliberately hung for 30 s and then
   answering *deny*, an `allow` written to `decisions/<id>.json` at t=4.3 s caused the tool to run
   and the turn to finish at **t=5.9 s** — 28 seconds before the SDK callback answered at all. The
   file was written with the content the prompt asked for. The SDK callback's eventual `deny` was
   simply discarded.

**What this changes.** The plan assumed the hook path covered only *external* sessions and that
conversations Agent Wrangler runs itself would need cross-window RPC. They do not, for
permissions: a runner-owned session raises a marker like any other, and any process on the
machine can settle it with a file write. **One mechanism covers every Claude permission prompt on
the machine**, which is what makes the leader design in §6 sufficient rather than a stopgap.
§1.1, §6 and §13 are amended accordingly.

`AskUserQuestion` and `ExitPlanMode` are still runner-only — they never reach
`PermissionRequest` — so the questions/plans deferral stands unchanged.

**A latent bug this exposes, which predates Remote Control.** For a runner-owned session,
answering through the hook (today: the dashboard's Allow button; tomorrow: Discord) settles the
*agent's* ask but leaves the SDK's `canUseTool` promise pending, so the conversation pane's card
stays `pending` for a tool that has already run. Worth confirming and fixing separately —
`RunnerSession` would need to settle its `pending` entry when the session leaves `blocked`.
Filed here rather than fixed, because it is not Remote Control's to fix.

**Also observed:** `permission_suggestions` for a gated `Write` is
`[{type:'setMode', mode:'acceptEdits', destination:'session'}]`. `parsePermissionSuggestions`
keeps only `addRules`/`addDirectories`, so `alwaysAllow` is correctly absent and such a prompt
mirrors with two buttons, not three. The rule in §3.1 needs no special case.

### The Discord half

Run against a real bot in a private test guild, 2026-09-21. The whole round trip — post, press,
acknowledge, edit — completed in **11.7 s**, from a laptop with no inbound port, no public URL, no
tunnel and no hosted backend.

| Claim | Verified |
|---|---|
| A bot with **no Interactions Endpoint URL** receives component presses over the gateway | Yes. `GET /applications/@me` reports `interactions_endpoint_url: null`, and the press arrived as a gateway dispatch. **Check this over the API, not by eye** — it is the single setting that silently breaks the whole design. |
| `IDENTIFY` with **`intents: 0`** still receives them | Yes. `READY` at 3.3 s, `INTERACTION_CREATE` at 11.0 s. Interactions are not gated by intents, so the bot needs no privileged intent and reads no message content. |
| The press is `type: 3` (MESSAGE_COMPONENT), `data.component_type: 2` | Yes. |
| The actor is at **`member.user`** in a guild | Yes — `member.user.id` matched the configured allowlist id exactly. `user` (no member) is the DM shape; read `member?.user ?? user`. |
| `guild_id` and `channel_id` ride on the interaction | Yes, both present and matching — so scope can be checked before any lookup. |
| `message.id` identifies which card was pressed | Yes, matched the posted message. |
| A **type-6** (DEFERRED_UPDATE_MESSAGE) ACK is accepted | Yes: `HTTP 204` in **158 ms**, comfortably inside the 3 s budget. |
| The message can then be edited with the **bot token**, not the interaction token | Yes: `PATCH /channels/{id}/messages/{id}` → `HTTP 200`. This is the path that must be used, since a prompt can outlive the interaction token's 15 minutes. |
| `components: []` removes the buttons | Yes, confirmed on the returned message. |

Other facts worth keeping: `heartbeat_interval` was 41250 ms; `READY` supplies a
`resume_gateway_url` distinct from the connect URL (`gateway-us-east1-d.discord.gg`), so a resume
must use it; the interaction token is 214 chars; `GET /gateway/bot` reported 1000 session starts
remaining, so reconnect churn during development is a non-issue.

**A private channel needs the bot added explicitly.** The test channel denied `VIEW_CHANNEL`
(`1024`) to `@everyone`, and the bot was in the guild but got `403 Missing Access` on the channel
until it was granted View Channel / Send Messages / Embed Links there. A private channel is the
right home for approvals, so *Test Remote Control* (§11) must check channel reachability
specifically and say this — the guild check passes while the channel fails.

### `ws` is not needed

The plan assumed the extension host was Node 20, which has no global `WebSocket`. Measured here:

- VSCode extension host: **Node 24.18.1** (Electron 42.10.0) — `WebSocket` is a function
- The Electron app: **Node 24.21.0** — likewise

So both front ends can use the built-in `WebSocket` and the transport needs **no new dependency**.
The caveat is `engines.vscode: ^1.90.0`, which is a floor this repo never actually tested; VSCode
1.90 shipped Electron 29 / Node 20 and would not have it. Since the extension is `private: true`
and installed only from source, the honest fix is to raise that floor to a version that ships
Node 22+ rather than carry `ws` for a configuration nobody runs. Decide at phase 4; either way
`esbuild.mjs`'s `target: node20` should move up to match reality.

---

## 1. Existing Agent Wrangler interaction architecture

### 1.1 Where actionable interactions originate

| Origin | Mechanism | Identity | Answerable from |
|---|---|---|---|
| **Hook-backed Claude permission** | `permission-hook.sh` drops marker `requests/<ppid>-<pid>`, polls `decisions/<id>.json` for ~28 min (`src/claude/hookInstall.ts:67`) | `AgentSession.permissionRequestId` | **any process on the machine** — it is a file write into `~/.claude/agentwrangler/` |
| Runner ask — **permission** | SDK `canUseTool` *and*, as §0.1 establishes, the same hook marker as any other session | both; the marker is what matters | **any process on the machine** |
| Runner ask — question / plan | SDK `canUseTool` only; `RunnerSession.pending: Map<requestId, PendingAsk>` (`src/claude/runner/runnerSession.ts:486`) | SDK `options.requestId` | only the process that owns the runner |
| Codex approval / question | App Server JSON-RPC; `CodexRunner.pendingApprovals` (`src/codex/runner.ts:82`) | RPC id | only the process that owns the runner |

**Every Claude *permission* prompt is remotely actionable** — external sessions and ones Agent
Wrangler runs itself alike — because all of them raise a marker, and a marker is answered by a
file write into a directory every process shares. That single fact is what lets v1 work with no
cross-window RPC.

What confines v1 is therefore not "hook-backed sessions" but **hook-backed *interactions***:
questions and plan approvals never reach `PermissionRequest`, so they remain in-process and out of
scope. Codex likewise has no marker.

### 1.2 The permission lifecycle

1. **Hook fires.** `installHooks()` writes an Agent Wrangler block into `~/.claude/settings.json`.
   Every event appends its payload to `~/.claude/agentwrangler/<claude-pid>.jsonl`;
   `PermissionRequest` instead runs `permission-hook.sh`, which appends the payload, creates the
   marker, logs a synthetic `AgentWranglerPermissionPending` line naming the request id, and polls
   for `decisions/<id>.json` every 0.5 s for ~28 minutes. Finding the file, it `cat`s it to stdout
   and exits; Claude Code reads the decision there. If the *marker* disappears first it exits
   quietly.
2. **Log is read.** `HookLog` (`src/claude/hookLog.ts`) tails those files with a byte cursor and
   folds lines through the pure `reduceHookEvent` (`src/claude/hookEvents.ts:270`) into
   `HookSessionState`: `status:'blocked'`, `blockedReason`, `blockedDetail`,
   `permissionRequestId`, `permissionSuggestions`.
3. **Ask is described.** `permissionDetail(toolName, tool_input, cwd)`
   (`src/claude/permissionDetail.ts`) reduces the payload to `{summary, body, isCommand}` — summary
   capped at 200 chars, body at 2000. `parsePermissionSuggestions` keeps only *allow* rules and
   directory grants; `suggestionLabels` renders `Bash(npm test:*)`; `suggestionDestination` renders
   "your user settings".
4. **Reaches the model.** `ClaudeProvider.buildSession` (`src/claude/claudeProvider.ts:179`) sets
   `permissionRequestId` **only if** `this.hooks.pendingRequestExists(...)` — i.e. the marker still
   exists, i.e. the hook script is provably still waiting. **That boolean is the repo's existing
   liveness signal and the remote layer uses exactly it.**
5. **Reaches the store.** `SessionStore.applySnapshot` diffs on `materialFingerprint`
   (`src/core/sessionStore.ts:24`), which already includes `status`, `blockedReason`,
   `blockedAsk.summary`, `blockedAsk.body`, `permissionRequestId` and `alwaysAllow.rules`. A prompt
   appearing or being answered is therefore already a material store update.
6. **Answer goes back.** `SessionActions.decidePermission` → `ClaudeProvider.decidePermission` →
   `HookLog.decide`, which writes `decisions/<id>.json` (tmp + rename) containing
   `permissionDecisionJson(behavior, suggestions)` — Claude Code's own decision shape, with
   `updatedPermissions` on an `always`. It returns `false` when there is nothing left to answer.
7. **Answered in Claude Code instead.** No hook reports that. `blockClearedByClaude`
   (`src/claude/status.ts:73`) reads `status`/`statusUpdatedAt` from
   `~/.claude/sessions/<pid>.json` and ends the block; `HookLog.applyLines` then releases the
   marker. **There is no `PermissionGranted` event**, so after the fact Agent Wrangler cannot tell
   *which* answer was given — only that one was. This shapes the remote close text (§4).

### 1.3 How the local UI represents an ask

Two renderings, both **pure functions of the `AgentSession`**:

- **Dashboard row** — `permissionRow()` (`src/webview/dashboard/main.ts:280-321`). Renders when
  `status === 'blocked' && (blockedAsk || permissionRequestId)`; renders **buttons** only when
  `pending = s.permissionRequestId !== undefined`; renders *Always allow* only when
  `pending && s.alwaysAllow`.
- **Conversation pane card** — `TranscriptSource.buildAsk()`
  (`src/ui/conversation/transcriptSource.ts:121-140`), a `ConvBlock` of `kind:'permission'` with
  `requestId = s.permissionRequestId` and `state: AskState`
  (`'pending' | 'allowed' | 'denied' | 'expired'`, `src/shared/conversation.ts:29`).

**Nothing about a permission prompt is stored anywhere in Agent Wrangler.** It is recomputed on
every scan from `HookLog` state plus the marker file. The remote mirror must preserve that
property rather than break it.

### 1.4 How local UI actions enter the application

```
dashboard webview  ─ post {type:'action', key, action:'allow'|'deny'|'always'}
                   → DashboardHost.onMessage             src/ui/dashboardHost.ts:226-228
                   → actions.decidePermission(key, behavior)      ← APPLICATION SEAM
                   → provider.decidePermission(sessionId, …)      src/app/createApp.ts:777
                   → HookLog.decide(sessionId, …)                 src/claude/claudeProvider.ts:251
                   → write decisions/<id>.json                    src/claude/hookLog.ts:147-151

conversation pane  ─ post {type:'decide', requestId, decision}
                   → ConversationHost.onMessage          src/ui/conversation/conversationHost.ts:334
                   → ConversationSource.decide(requestId, …)
                   → TranscriptSource.decide             transcriptSource.ts:98
                   → injected DecidePermission(sessionId, …)      ← BYPASSES THE SEAM
                   → provider.decidePermission(…)        conversationHost.ts:190
```

### 1.5 Where provider-specific handling begins

At `createApp.ts:776` — `if (!s || s.provider !== 'claude') return;`. Above that line everything is
`AgentSession` / `key` / `DashboardAction`; below it everything is Claude hooks. `decidePermission`
is deliberately **not** on `AgentProvider` (`src/core/provider.ts:13-26`); it is a Claude extension
surfaced through `ConversationProvider` (`conversationHost.ts:57-60`).

### 1.6 The seam Remote Control invokes

**`SessionActions` (`src/ui/actions.ts`).** Its own doc comment states what it is: *"Session
actions shared by the dashboard webview, conversation panes, and palette commands."* It is keyed by
store `key`, provider-agnostic at the signature level, and `createApp` is where it becomes
Claude-specific. Remote Control is a fourth consumer of the same interface — dashboard, pane,
palette, Discord.

Two adjustments are needed, both small and both landing before Remote Control (§7):

- `decidePermission` returns `void`, so a caller cannot learn whether the decision landed. Widen it.
- It takes no request id, so it answers *whatever prompt the session currently has*. Add one.

**Do not build a `PermissionResolver` port.** `SessionActions` already is one.

---

## 2. Who owns what

| State | Owner | Where it lives | Persisted? |
|---|---|---|---|
| Whether a permission prompt exists and can still be answered | **Claude Code**, observed by Agent Wrangler | `requests/<id>` marker → `HookLog` → `AgentSession.permissionRequestId` | No — recomputed every scan |
| What the prompt is for | Agent Wrangler | `blockedAsk`, `blockedReason`, `alwaysAllow` | No |
| Which choices are legal right now | Agent Wrangler | pure `remoteAskFor(session)` | No |
| How a decision is applied | Agent Wrangler | `actions.decidePermission` → provider → `HookLog.decide` | n/a |
| Session / agent status | Agent Wrangler | `SessionStore` | No |
| **Which Discord message mirrors which Agent Wrangler ask** | **Remote Control** | `~/.cache/agent-wrangler/remote/mirrors.json` | **Yes** (§5) |
| Who pressed what, in the remote UI | **Remote Control** | same record, `lastPress` | Yes |
| Which process owns the Discord connection | **Remote Control** | `~/.cache/agent-wrangler/remote/leader.json` | Yes (a lease) |
| Gateway session id, seq, resume URL, rate-limit buckets | **Discord transport** | memory | No |
| Message text, colour, button labels | **Discord transport** | Discord's servers | No |

No row is shared. The remote layer holds **one** thing: a mapping, plus a note of the last remote
press. Everything else it re-derives from the store at the moment it needs it.

---

## 3. Abstractions

Five types, two services, a flat directory.

```
src/shared/remote.ts             RemoteAsk, RemoteChoice, remoteAskFor()   — pure, shared layer
src/remote/redact.ts             redactForDisplay()                        — pure
src/remote/transport.ts          RemoteTransport, RemoteMessageRef, RemoteActor, RemoteInvocation
src/remote/mirrorStore.ts        the persisted mapping
src/remote/leader.ts             LeaderLease
src/remote/audit.ts              append-only log
src/remote/service.ts            RemoteControlService — the reconciler
src/remote/discord/ids.ts        custom_id codec                           (pure)
src/remote/discord/format.ts     RemoteAsk → Discord message payload       (pure)
src/remote/discord/rest.ts       REST + rate limiting
src/remote/discord/gateway.ts    WebSocket
src/remote/discord/transport.ts  DiscordTransport implements RemoteTransport
```

### 3.1 The mirrored ask — `src/shared/remote.ts`

In `src/shared/` beside `rowMenu.ts`, because it is the same kind of thing: a pure function from a
`SessionDTO` to what a human may currently do about it.

```ts
/** A choice on a remote surface. Mirrors RowMenuItem; `action` is the existing AW action. */
export interface RemoteChoice {
  action: DashboardAction;      // 'allow' | 'always' | 'deny' in v1
  label: string;                // "Allow once" / "Always allow Bash(npm test:*)" / "Deny"
  tone?: 'primary' | 'danger';
}

/**
 * One Agent Wrangler ask, projected for a remote surface. Derived on demand from the
 * session; never stored. `requestId` is what makes it *this* ask rather than the next one.
 */
export interface RemoteAsk {
  askKey: string;               // `${sessionKey}#${requestId}` — the interaction's identity
  sessionKey: string;
  requestId: string;
  kind: 'permission';           // the seam for questions/plans later
  title: string;                // displayLabel(s) + the tool
  subject?: PermissionAsk;      // reused as-is: {summary, body, isCommand}
  context: { repository?: string; branch?: string; worktree?: string; model?: string };
  choices: RemoteChoice[];
}

/** The remote ask this session currently presents, or none. Pure. Sibling of rowMenuItems. */
export function remoteAskFor(s: SessionDTO): RemoteAsk | undefined;
```

Returns `undefined` unless `provider === 'claude'`, `status === 'blocked'`,
`permissionRequestId !== undefined`, `!archived`, `!paused`. The last two match existing behaviour:
archived sessions are already skipped by the toast wiring (`createApp.ts:816`), and a paused
session is already excluded from the bell because a frozen agent cannot act on an answer. `choices`
is `[allow, deny]` plus `always` **only when `s.alwaysAllow` exists** — the same condition
`permissionRow` uses — labelled with the real rule and destination.

### 3.2 Transport — `src/remote/transport.ts`

```ts
export interface RemoteMessageRef { channelId: string; messageId: string }
export interface RemoteActor { id: string; displayName: string }   // id is the stable snowflake

export interface RemoteInvocation {
  interactionId: string;        // the opaque id we minted
  choiceId: string;             // a DashboardAction — client-supplied, unvalidated
  actor: RemoteActor;
  scope: { guildId?: string; channelId?: string };
}

export interface RemoteTransport extends Disposable {
  readonly id: string;                                   // 'discord'
  readonly connected: boolean;
  onDidInvoke(l: (i: RemoteInvocation) => void): Disposable;
  onDidChangeConnection(l: () => void): Disposable;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(interactionId: string, ask: RemoteAsk): Promise<RemoteMessageRef>;
  update(ref: RemoteMessageRef, ask: RemoteAsk): Promise<void>;
  close(ref: RemoteMessageRef, outcome: RemoteClose): Promise<void>;  // final text, no buttons
  reply(i: RemoteInvocation, text: string): Promise<void>;            // private to the presser
}
```

The transport is handed a `RemoteAsk` and an opaque id. It is never told what a hook is, what a
`permissionRequestId` means, or how a decision is applied.

### 3.3 `RemoteControlService` — a reconciler, not a state machine

```ts
constructor(
  private sessions: SessionSnapshot,   // narrow: { sessions(): SessionDTO[]; onDidUpdate(fn) }
  private actions: Pick<SessionActions, 'decidePermission'>,
  private mirrors: MirrorStore,
  private config: () => RemoteConfig,
  private audit: AuditLog,
  private log: (m: string) => void,
) {}
setTransport(t: RemoteTransport | undefined): void   // only the leader ever sets one
```

`sessions` is a narrow structural interface, following `adoptQueue.ts`'s `SessionUpdates`
(`src/core/adoptQueue.ts:4-7`) — that is what makes the service testable against a nine-line fake.

The whole coordination logic:

```
reconcile():
  if (!enabled || !transport?.connected) return
  desired = sessions().map(remoteAskFor).filter(Boolean)          keyed by askKey
  for (askKey, ask) of desired:
     mirror = mirrors.get(askKey)
     if (!mirror)                        publish(ask)
     else if (mirror.renderHash != hash) update(mirror.ref, ask)
  for (askKey, mirror) of mirrors:
     if (!desired.has(askKey))           close(mirror)            // AW says it is over
```

Declarative, idempotent, and self-healing after a restart or a leader change: a new process reads
the mirror file, recomputes `desired` from its own store, and converges.

---

## 4. Permission flow

**[existing]** = unchanged code. **[new]** = this feature.

1. **[existing]** The agent hits a permission prompt. `permission-hook.sh` appends the payload,
   drops marker `requests/4711-8123`, logs the pending line, polls. Claude Code's own dialog opens
   at the same time.
2. **[existing]** Every window's `HookLog` reads the appended bytes (~120 ms debounce);
   `reduceHookEvent` sets `blocked`, `permissionRequestId`, `blockedDetail`, suggestions.
3. **[existing]** `buildSession` gates `permissionRequestId` on `pendingRequestExists()`;
   `SessionStore` fires. The dashboard row grows its card, an open pane grows its block. **The
   local UI is fully actionable and behaves exactly as it does today.**
4. **[new]** `RemoteControlService.reconcile()` runs on the same store update and computes
   `desired`. Followers and disabled instances return immediately.
5. **[new]** The `askKey` is desired but unmirrored → mint an `interactionId`
   (`crypto.randomBytes(16)`, base64url), `transport.publish(...)`, persist the mirror.
6. **[new]** An authorised user presses **Allow once**.
7. **[new]** `DiscordTransport` ACKs with callback type 6 inside the 3-second budget, decodes the
   `custom_id`, emits a `RemoteInvocation`.
8. **[new]** `RemoteControlService.onInvoke` validates in order, stopping at the first failure with
   an ephemeral reply:
   - scope — `guildId` / `channelId` match settings;
   - `interactionId` is a known mirror;
   - `actor.id` is in the allowlist (audited either way);
   - **the ask is still current** — re-derive `remoteAskFor(store.get(mirror.sessionKey))` *now* and
     require `ask.askKey === mirror.askKey`;
   - `choiceId` is one of `ask.choices`.
9. **[new → existing]**
   `await actions.decidePermission(ask.sessionKey, choiceId, { expectedRequestId: ask.requestId })`
   — the identical call the dashboard button makes.
10. **[existing]** `provider.decidePermission` → `HookLog.decide` → `decisions/4711-8123.json`. The
    hook script reads it within 0.5 s, prints it, removes marker and decision, exits. Claude Code
    applies it. The agent continues, having never heard of Discord.
11. **[existing]** The marker is gone, so `pendingRequestExists()` is false, so
    `permissionRequestId` drops off the session, so the store fires — and every dashboard row,
    every pane card and the status-bar bell in every window update, exactly as today.
12. **[new]** The same store update re-runs `reconcile()`; the `askKey` is no longer desired, so the
    mirror is closed — message edited, `components: []`, record dropped.

**Local-first resolution is the same loop with steps 6-9 absent.** Because `lastPress` is unset the
close text is *"Answered in Agent Wrangler"* — honest, because §1.2(7) means the hook path cannot
tell allow from deny after the fact.

---

## 5. Mirror persistence

One file, `~/.cache/agent-wrangler/remote/mirrors.json`, written with the `FileUsageCache` pattern
(`src/core/usageCache.ts`): pid-qualified tmp + rename, corrupt file read as empty.

```ts
interface Mirror {
  interactionId: string;     // opaque; what the custom_id carries
  askKey: string;            // `${sessionKey}#${requestId}` — the AW interaction identity
  sessionKey: string;
  requestId: string;
  ref: RemoteMessageRef;     // { channelId, messageId }
  renderHash: string;        // idempotent edits after a failover
  publishedAtMs: number;
  lastPress?: { actorId: string; actorName: string; choiceId: string; atMs: number };
}
```

**Why anything is persisted at all:** so a process that did not post a message can still edit it.
Without the file, a window reload orphans live buttons in the channel — a new leader would not know
they exist and every press would answer "unknown interaction" forever. That is the entire
justification, and it bounds the record to identity, address, and what the remote UI has been told.

**Deliberately not persisted:** whether the permission is pending or answered, the command text,
the session status, the choices, any deadline. All recomputed.

**No TTL.** The marker file *is* the expiry: when the hook script gives up at ~28 minutes it removes
its own marker (`hookInstall.ts:93`), the session stops advertising `permissionRequestId`, and the
reconciler closes the message on the next update. A clock could only ever disagree with the
authority.

Cleanup: a mirror whose `ref` 404s on edit is dropped; a mirror older than 2 hours still in the file
is dropped on load.

---

## 6. Multi-window

Every VSCode window runs a whole `createApp`; five windows are five `HookLog`s tailing the same
files. Left alone that is five bots and five messages for one prompt.

**This is a bet on the extension, and the extension is being retired.** As of 2026-09-21 the
VSCode extension is no longer used and is slated for removal (see
`electron-app-migration.md` → *Backlog: retire the VSCode extension*). One app is one process,
so the contention this section solves mostly disappears with it — at which point the lease could
shrink to a guard against a second copy of the app, or go entirely. Build it anyway: until the
extension is actually gone the contention is real, and a dev `npm run electron` running beside
the installed app reproduces it exactly. It is ~60 lines and it is the difference between one
Discord message and five.

**A leader lease, narrowed to the transport only.** `~/.cache/agent-wrangler/remote/leader.json`
holds `{pid, acquiredAtMs, heartbeatAtMs}`. Acquire with `open(..., 'wx')`; on `EEXIST`, steal if
the heartbeat is older than 30 s **or** the pid is dead (`isPidAlive`, `src/claude/registry.ts`).
The leader heartbeats every 10 s and releases on dispose; followers retry every 15 s. A fixed
machine path, not `host.storageDir` — the extension's globalStorage and the app's userData differ,
and both front ends must contend for the same lease.

The leader owns exactly three things: **the Discord connection, publishing, and receiving
invocations.** It is the authority for nothing about sessions or permissions; it reads its own
`SessionStore` like every other window.

**Why a leader in window A can answer a prompt raised in window B:** it does not reach window B at
all. The decision is a file written into `~/.claude/agentwrangler/decisions/`, and window A's own
`HookLog` has already read the same marker id from the same shared log. Any window can answer any
hook-backed prompt today. Remote Control adds no cross-window RPC and needs none.

This holds for **runner-owned sessions too** (§0.1): a conversation Agent Wrangler started raises
the same marker, and the leader settles it the same way, whichever window is running it. So
`remoteAskFor` needs no "is this mine?" predicate in v1 and the leader needs no IPC.

**When questions and plan approvals are supported**, that changes: those live in one process's
heap with no marker, so only the owning window can invoke them. `remoteAskFor` is the gate — it
will then need a "can this process act on it?" predicate, and the owning window will have to take
the lease or be handed a small IPC. Keep `remoteAskFor` the single place that decides what is
mirrorable; build none of the rest now.

---

## 7. Correctness issues in Agent Wrangler itself

These are Agent Wrangler bugs, not Discord concerns. **They land as a standalone PR on `main`
before the Remote Control branch starts**, so the remote work is purely additive and the local UI
gets the fix immediately.

### 7.1 A decision can be applied to the wrong prompt

No caller passes a request id. `DashboardHost` posts `{type:'action', key, action}` with no id
(`dashboardHost.ts:226`); the dashboard webview never puts the id in the DOM (`main.ts:1306-1314`);
`TranscriptSource.decide` validates against its own cached `this.ask.requestId` and then **drops
it**, calling `decidePermission(session.sessionId, decision)` (`transcriptSource.ts:98-100`);
`HookLog.decide` answers whatever prompt the session currently has (`hookLog.ts:142-145`).

Today this is nearly harmless — the card re-renders within a poll. With a Discord message that can
sit in a channel for half an hour it is a live hazard: prompt A is published, resolved locally,
prompt B opens, and a late press on A's message allows B.

**Fix, four small edits:**

```
hookLog.ts:142         decide(sessionId, behavior, expectedRequestId?)
                       + if (expectedRequestId !== undefined && id !== expectedRequestId) return false;
claudeProvider.ts:250  decidePermission(sessionId, behavior, expectedRequestId?)   — pass through
actions.ts:63          decidePermission(key, behavior, opts?: { expectedRequestId?: string })
                         : Promise<'applied' | 'stale' | 'gone' | 'unsupported'>
createApp.ts:774       thread it; return the outcome; keep the existing flashes
```

`HookLog.decide` keeps returning `boolean` (a mismatch reads as "nothing to answer"), so its six
existing test call sites are untouched. The richer outcome is computed in `createApp` from the store
snapshot, purely to pick the right flash text. Widening `void` → `Promise<…>` is source-compatible
with the one existing caller, which calls it as a statement.

Then supply the id from both local UIs:

- `src/shared/messages.ts` — `{ type:'action'; key: string; action: DashboardAction; requestId?: string }`
- `src/webview/dashboard/main.ts` — `permissionRow` already has `s.permissionRequestId`; put it on
  the `<tr>` as `data-request` and include it in the `post()` at line 1311
- `src/ui/dashboardHost.ts:227` — pass `{ expectedRequestId: m.requestId }`

### 7.2 Two local paths answer one interaction; unify them

`conversationHost.ts:190` injects `(id, behavior) => this.provider.decidePermission(id, behavior)` —
the parameter is named `id` but receives `session.sessionId`. Re-point it:

```ts
new TranscriptSource(session, this.provider, (requestId, behavior) =>
  this.actions
    .decidePermission(session.key, behavior, { expectedRequestId: requestId })
    .then((r) => r === 'applied'))
```

and change `DecidePermission` (`transcriptSource.ts:31`) to `(requestId, behavior) => Promise<boolean>`,
passing `this.ask.requestId` at line 100. `ConversationHost` already holds `this.actions`.

After this, **one application-level action answers a hook-backed permission from all four
surfaces** — dashboard, pane, palette, Discord — and all four get the stale guard. This is what
makes "invoke the same action the local UI would have invoked" literally true.

### 7.3 Two processes deciding at once can tear the decision file

`hookLog.ts:150` writes `${target}.tmp` with a **fixed** name. Two windows deciding the same request
interleave writes to one path and both rename it — a torn JSON file handed to the hook script. The
repo already knows the fix: `FileUsageCache` pid-qualifies its tmp (`${this.file}.${process.pid}.tmp`)
for exactly this reason. **Fix: pid-qualify the tmp name.** One line.

### 7.4 Simultaneous local and remote answers — analysis

- **Same process** (dashboard and Discord in one window): already correct. The first `decide` clears
  `permissionRequestId` in its own `HookLog` state (`hookLog.ts:156`), so the second returns `false`.
- **Different processes** (a local window and the remote leader): both see the marker, both write.
  With 7.3 fixed each write is atomic; last rename wins and both callers get `true`. If the two
  answers differ, the agent gets whichever landed last.
- This is *already* the repo's documented semantics for the analogous race — Claude Code runs its
  own dialog concurrently and "whichever is answered first wins" (README). A remote input does not
  introduce a new class of race.

**Recommendation: fix 7.3 and stop.** Deterministic first-writer-wins is available (exclusive-create
a `decisions/<id>.lock` with `wx`; the loser returns false) but it needs two humans racing inside
~500 ms, and it would make the *local* button lose to a remote press that arrived first — arguably
the wrong outcome. Document it as a known bounded race. **Never arbitrate it inside Discord.**

---

## 8. Discord adapter

Verified against Discord's developer documentation (Interactions → Receiving and Responding),
September 2026. All of this stays below the transport boundary.

- **Gateway and the HTTP Interactions Endpoint URL are mutually exclusive.** *"These two methods are
  mutually exclusive; you can only receive Interactions one of the two ways."* With no endpoint URL
  configured, component presses arrive as `INTERACTION_CREATE` on the bot's outbound WebSocket.
  **No inbound port, no public URL, no tunnel, no hosted backend.** Setup docs must say: leave the
  Interactions Endpoint URL blank.
- **3 seconds to acknowledge**, or the token is invalidated and Discord shows "interaction failed".
  The transport therefore ACKs with callback type **6** (DEFERRED_UPDATE_MESSAGE) *before* any Agent
  Wrangler work, then emits the invocation.
- **The interaction token expires after 15 minutes**, but a prompt can live ~28. So every edit goes
  through the bot token: `PATCH /channels/{channelId}/messages/{messageId}`, which has no time
  limit. This is why `RemoteMessageRef` holds a channel + message id and never a token, and why
  `update`/`close` are one code path for both remote and local resolution.
- **Ephemeral flag 64** for refusals — no litter in the channel.
- **Gateway:** `GET /gateway/bot`; `?v=10&encoding=json`; no compression; op 10 HELLO → jittered
  heartbeat; IDENTIFY with `intents: 0` (interactions are delivered regardless of intents — confirm
  in the phase-0b spike); keep `session_id` + `resume_gateway_url` from READY; op 7 and close
  4000-4009 → RESUME; op 9 → re-IDENTIFY after 1-5 s; backoff 1→60 s with ±20 % jitter, reset on
  READY. **Close 4004 is terminal** — bad token, surface once, never retry.
- **Library: none.** Write ~350 lines rather than take `discord.js`, which drags in a REST layer, a
  WS layer, `undici`, optional natives and a cache for a feature that sends one message shape and
  reads one dispatch type. And §0.1 removes the one dependency the plan did expect: both hosts run
  Node 24 and have a global `WebSocket`, so `ws` is not needed either. The adapter is `fetch` plus
  `WebSocket`, both built in.
- **`custom_id` = `aw:<interactionId>:<choiceId>`**, ≤100 chars, strict parser, unknown → ephemeral
  reply. **No session id, no marker id, no path, no tool name** — it comes back client-supplied and
  must carry no authority.
- **Rate limits:** per-route bucket from `X-RateLimit-*`; global 429 honouring `retry_after`; a
  single serialised worker per channel; **edits prioritised over publishes**, because a stale button
  is worse than a late notification. A publish still queued when its ask closes is dropped unsent.
- **Authorization data handed up:** `{ id, displayName }` from `member.user` (guild) or `user` (DM),
  plus `{ guildId, channelId }`. The transport resolves them; the service decides what they mean.
  The transport performs no authorisation of its own.
- **Formatting** (`format.ts`, pure): an embed — amber pending, green allowed, red denied, grey
  closed elsewhere. Title from `displayLabel` + the tool; fields for Repository / Branch / Worktree;
  the command in a `sh` code fence; the reason from `subject.summary`; buttons from `ask.choices`.
  On close, the same message edited with the outcome line and `components: []`.

```
AgentWrangler — Permission required
Agent      backend-api-cf              Repository  proj
Branch     feature/example             Worktree    proj-feature
Tool       Bash

Requested action
  git push origin feature/example

Reason
  Publish branch for PR creation

[ Allow once ]  [ Always allow Bash(git push:*) ]  [ Deny ]
```

closing to one of:

```
✅ Allowed — allow once · by @someone · 14:32:07
❌ Denied — by @someone · 14:32:07
↩︎ Answered in Agent Wrangler · 14:32:07
```

---

## 9. Security

Proportional to what this is: a remote UI for Agent Wrangler actions, not a second authority.

| Requirement | Design |
|---|---|
| Token storage | New `HostSecrets { get, store, delete }` on `HostServices`. VSCode: `context.secrets` (OS keychain). Electron: `safeStorage.encryptString`, refusing to store when `isEncryptionAvailable()` is false. **Never a setting** — settings are plaintext and synced. |
| Token handling | Read on connect, held in the transport only. Redact `Bot …` and any 24+ char token-shaped run from all log output. Never sent to a webview. |
| Authorisation | `remote.discord.authorizedUserIds`, compared as exact numeric snowflakes. **Never usernames** — mutable and re-assignable. An empty list means nobody is authorised and publishing is refused with a one-time warning: fails closed. |
| Scope | `guildId` + `channelId` both required; an invocation from anywhere else is discarded before lookup. |
| Opaque ids | `interactionId` from `crypto.randomBytes(16)`. The marker id (`<pid>-<pid>`) is guessable and never leaves the machine. Session ids, cwds and transcript paths never leave either. |
| Validity | Agent Wrangler re-derives the ask at press time (§4 step 8) and re-checks it again inside `HookLog.decide` via `expectedRequestId`. Discord is never trusted to know whether anything is still current. |
| Redaction | `redactForDisplay()` (pure, table-tested) over `summary`/`body` before publish: mask `KEY=value` for TOKEN/SECRET/PASSWORD/APIKEY/AUTH/CREDENTIAL/PRIVATE_KEY; `sk-…`, `ghp_…`, `github_pat_…`, `xox[baprs]-…`, `Bearer …`, `-----BEGIN … PRIVATE KEY-----`; anything after `--password`/`-p`/`Authorization:`. Replace the home directory prefix with `~`. Cap the body at 1200 chars (already 2000 from `permissionDetail`). Never publish transcript text, tool output or diffs. |
| Audit | One JSON line per publish / press (accepted **and** refused) / close to `~/.cache/agent-wrangler/remote/audit.log`, rotated at 2 MB: `{ts, event, interactionId, sessionKey, toolName, actorId, actorName, choiceId, outcome}`. **Ids and tool names, not command bodies** — the channel already has those. |
| Kill switches | `remote.enabled: false` disconnects and closes every mirrored message. *Disconnect Discord* additionally deletes the secret. |
| Blast radius | The only action exposed in v1 is answering a permission prompt Agent Wrangler is *already* offering locally. Discord can never reach an action the local UI does not currently render. |

---

## 10. Testing

Fakes follow `test/adoptQueue.test.ts:6-13` (a nine-line emitter-backed fake session source) and
`test/codexSubagents.test.ts:73-84` (an object-literal `AgentProvider`). Paths stay
`/Users/test/proj`-style; no real `~/.claude` reads; no token anywhere.

**Pure**

- `test/remoteAsk.test.ts` — `remoteAskFor`: blocked + id ⇒ an ask; no id ⇒ none; archived / paused /
  codex / ended ⇒ none; `alwaysAllow` present ⇒ three choices with the rule in the label, absent ⇒
  two; `askKey` changes when `requestId` changes.
- `test/remoteRedact.test.ts` — a table of every pattern, plus "leaves an ordinary command alone",
  plus home-directory masking.
- `test/discordIds.test.ts` — `custom_id` round-trip; rejects wrong prefix, overlong id, unknown
  choice, injected separators.
- `test/discordFormat.test.ts` — payload snapshots: with and without a suggestion, a multi-line
  command, a missing branch, each close outcome. Asserts `components: []` on every close and
  Discord's length limits.

**Service, with a `FakeTransport` and a fake `decidePermission`** — `test/remoteService.test.ts`:

- publishes once for a new ask, and **does not** republish on an identical store update;
- two concurrent asks on two sessions ⇒ two mirrors, no crosstalk;
- **stale**: publish A, resolve A locally, open B on the same session, press A's button ⇒
  `decidePermission` is never called, ephemeral reply, A's message closed;
- **local resolution reflected remotely**: the ask disappears ⇒ `close` called once with
  "Answered in Agent Wrangler";
- **remote resolution reflected locally**: a press ⇒
  `decidePermission(key, 'allow', {expectedRequestId})` called with exactly those arguments;
- **simultaneous**: `decidePermission` resolves `'gone'` ⇒ the close text says answered locally and
  no error is surfaced;
- unauthorised actor ⇒ no action, ephemeral refusal, audit entry, mirror still pending;
- wrong guild/channel ⇒ discarded silently;
- `remote.enabled` false mid-flight ⇒ all mirrors closed;
- transport disconnected ⇒ reconcile is a no-op and nothing throws.

**Persistence and leadership**

- `test/remoteMirrorStore.test.ts` — round-trip; corrupt file ⇒ empty; tmp + rename; stale entries
  dropped on load.
- `test/remoteLeader.test.ts` — acquire; a second instance is a follower; a stale heartbeat is
  stolen; a dead pid is stolen; release hands over. Injected clock and `isPidAlive`.
- **Failover** — construct service A, publish, drop it, construct service B over the same mirror
  file and a fresh `FakeTransport`, and assert B closes A's message when the ask disappears.

**Transport internals, fake socket / fake fetch**

- `test/discordGateway.test.ts` — HELLO → heartbeat cadence; READY captures `resume_gateway_url`;
  op 7 resumes with the right `seq`; op 9 re-identifies; **4004 is terminal and does not retry**;
  backoff grows and resets.
- `test/discordRest.test.ts` — 429 honours `retry_after`; edits pre-empt publishes; 404 on edit drops
  the mirror; the token never appears in a thrown error.

**Regression for §7** — `test/hookLog.test.ts`: `decide` with a mismatched `expectedRequestId`
returns false and writes no file.

Not automated: a real Discord round-trip. That is the phase-0b spike and the *Test Remote Control*
command.

---

## 11. Phases

Per `CLAUDE.md` the remote work is bigger than one sitting, so it gets its own worktree. Phase 0a is
a separate PR on `main`, first.

```bash
git worktree add ../AgentWrangler-remote -b feat/remote-control
ln -s ../AgentWrangler/node_modules ../AgentWrangler-remote/node_modules
```

| # | Where | Content | Proves |
|---|---|---|---|
| **0a** | `main` | §7.1 stale guard + §7.2 unify the pane + §7.3 pid-qualified tmp, with tests | The local UI is more correct today; nothing about Discord |
| **0b** | ~~throwaway~~ **done 2026-09-21** | Both halves answered; results in §0.1. The gate is open. | ✅ |
| **1** | `feat/remote-control` | `src/shared/remote.ts` + `src/remote/redact.ts` + their tests | The whole mirrored-view model is pure and reviewable on tests alone |
| **2** | ″ | `transport.ts` (interface), `mirrorStore.ts`, `audit.ts`, `service.ts`; `FakeTransport` tests; wired into `createApp` with **no transport constructed** | The core works, is testable without Discord, and is inert until a transport exists |
| **3** | ″ | `leader.ts` + tests; the leader is what calls `service.setTransport(...)` | One publisher per machine; failover covered |
| **4** | ″ | `discord/{ids,format,rest,gateway,transport}.ts` + fake-socket tests (no new dependency; see §0.1) | The adapter, still unreachable by a user |
| **5** | ″ | `HostSecrets` on both hosts; four settings in `settings.ts` + `package.json`; `config.ts`; three commands in `extension.ts` and the Electron menu; README | First user-visible phase; first one needing `install-local` and a reload |
| **6** | ″ | Hardening after a week of dogfooding: laptop-sleep reconnects, burst behaviour, a "enabled but not connected" chip | — |

Everything before phase 5 is provable by `npm test` alone. The network, the secret and the settings
— the three things that make a change hard to review and hard to revert — arrive last.

### Configuration (phase 5)

Four settings, in a new **Remote control** group in `src/shared/settings.ts` and the matching
`package.json` block (`test/settingsSchema.test.ts` enforces parity):

`remote.enabled` (boolean, `false`) · `remote.discord.guildId` (string) ·
`remote.discord.channelId` (string) · `remote.discord.authorizedUserIds` (comma-separated string —
`SettingSpec` models only string/boolean/number today, and widening it is a separate change).

Three commands: **Connect Discord…** (an input with `password: true` — add `password?` to
`InputOptions`; validate the token with `GET /users/@me` before storing), **Disconnect Discord**,
and **Test Remote Control** (connects, checks guild / channel / post permission / allowlist, posts a
self-resolving test card, reports each check — the thing that makes a wrong channel id diagnosable
in ten seconds).

No dashboard UI in v1. The bar is full at the 300 px the dashboard is actually docked at, and a
connection state nobody can act on is not worth the pixels.

### Deferred, explicitly

Slash commands · freeform chat · remotely starting or stopping agents · transcript browsing · Slack ·
cloud relay · mobile dashboard · questions and plan approvals (they need §6's cross-window story) ·
completion and failure notifications · any new permission classification or policy system.

---

## 12. Changes from the first version of this plan

| First version | Verdict |
|---|---|
| `RemoteInteraction` six-state machine (`pending/resolving/resolved/expired/cancelled/failed`) + `interaction.ts` + its test | **Deleted.** It duplicated Agent Wrangler's permission state. Replaced by a reconcile loop over `remoteAskFor` plus a small mapping record. |
| `events.ts` with `PermissionRequested` / `PermissionResolved` and four future kinds | **Deleted.** No events. `remoteAskFor` derives the desired set; the store's existing `onDidUpdate` is the trigger. |
| `permissionSource.ts` diffing snapshots into events | **Deleted.** Collapses into one pure function in `src/shared/remote.ts`. |
| `PermissionResolver` port | **Deleted.** `SessionActions.decidePermission` already is the application seam; widen it instead. |
| TTL (`remote.requestTtlMinutes`, a 27-minute cap, a sweep timer) | **Deleted.** The marker file is the expiry, and it is the authority. |
| `remote.notifyAfterSeconds` escalation timer | **Deleted from v1.** Publish when Agent Wrangler is blocked, full stop. |
| `remote.transport` enum setting | **Deleted.** One transport; the enum buys nothing until there are two. |
| `src/remote/core/` vs `src/remote/discord/` | **Simplified** to flat `src/remote/*` + `src/remote/discord/*`. |
| `pendingStore.ts` holding interaction state | **Simplified** to `mirrorStore.ts` holding identity, address and last press. |
| Leader election | **Retained, narrowed** to the transport, publishing and receiving. |
| `expectedRequestId` stale guard | **Retained and promoted.** Confirmed as a real bug affecting the *local* UI too (§7.1); lands on `main` first, and the conversation pane is unified onto the same action at the same time. |
| Discord findings — gateway/endpoint exclusivity, 3 s ACK, 15-min token vs 28-min prompt, channel `PATCH` for edits, 4004 terminal, no `discord.js` | **Retained, and now measured** rather than read off the docs — see §0.1. |
| `ws`, because Node 20 has no global `WebSocket` | **Dropped.** Both hosts run Node 24 and have one (§0.1). No new dependency. |
| Security — keychain via a new `HostSecrets`, snowflake allowlist, guild/channel scope, opaque ids, redaction, audit log, fail-closed empty allowlist | **Retained**, minus the TTL row. |
| Always-allow semantics — never invent "Allow for session"; label the real rule and destination; show it only when `alwaysAllow` exists | **Retained.** Now falls out of `remoteAskFor` mirroring `permissionRow`'s own condition. |
| Multi-window facts, `materialFingerprint` coverage, `pendingRequestExists` as the liveness signal, `~/.cache/agent-wrangler/` | **Retained.** |
| — | **Added:** `rowMenuItems` as the pattern to copy; the `notifyOnWaiting` wiring as the precedent; the §7.3 tmp-file collision. |
| Seven phases | **Simplified** to 0a / 0b + five. |

---

## 13. Definition of done for v1

1. **Agent Wrangler behaves exactly as before locally** with `remote.enabled: false` — no socket, no
   file, no behaviour change. The existing suite stays green.
2. A hook-backed permission prompt becomes actionable in the dashboard and the conversation pane
   exactly as today.
3. With Remote Control enabled, **one** Discord message mirrors that interaction, posted by **one**
   process, however many windows are open.
4. The message names the agent, repository, branch (and worktree when there is one), the tool, the
   command as it will run, and the reason when Claude gave one — redacted and truncated.
5. It offers **Allow once** and **Deny**, and **Always allow ‹rule›** only when Agent Wrangler is
   already offering it — the same condition `permissionRow` uses.
6. Pressing an authorised button invokes
   `actions.decidePermission(key, behavior, {expectedRequestId})` — the same call the dashboard
   button makes. **Agent Wrangler remains the only layer that talks to the provider:**
   `git grep -n discord src/` returns nothing outside `src/remote/discord/**`.
7. Resolving remotely resumes the agent within ~2 s and updates the local UI through the normal
   store path.
8. Resolving locally — dashboard, pane, or Claude Code's own dialog — closes the Discord message and
   removes its buttons.
9. **A stale Discord press cannot affect a newer interaction**, verified by the §10 stale test and
   by the `expectedRequestId` guard in `HookLog.decide`.
10. An unauthorised presser changes nothing, gets an ephemeral refusal, and appears in the audit log.
11. Killing the leader window with a message live: another window takes over within ~30 s and can
    still close that message.
12. **Discord being unavailable never affects local behaviour** — pull the network mid-prompt and the
    local buttons still work; the failure is logged, not toasted.
13. `npm run typecheck` and `npm test` green; the token appears in no log, setting, error message or
    webview message; no real project path, session title, prompt or hook payload in any committed
    file.
14. The README gains a *Remote control* section with the setup steps, the explicit "leave the
    Interactions Endpoint URL blank" instruction, the known simultaneous-answer race (§7.4), and an
    honest statement of what v1 cannot do — questions and plan approvals. Permission prompts in
    conversations Agent Wrangler runs itself **are** covered (§0.1).
15. `npm run install-local` run from the worktree that owns the change, and James told which window
    needs a reload.

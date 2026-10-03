# Browser-only Agent Wrangler: daemon core and web workbench

Spike for #120. Recorded 2026-10-02.

**Decision: go.** Agent Wrangler becomes a background daemon on the Mac that runs the agents,
plus a web workbench that any browser can open: on that Mac, or on a phone or laptop on the
same network. Electron is retired once the browser covers what the window does. Delivery is
tracked in the implementation epic linked from #120. The slices are in §12.

This revisits two recorded positions:

- `session-lifecycle-architecture.md` (Stage 7, #20): "the rest of the core stays in Electron
  main". That gate opens only when "a front end that is not Electron must work while the app is
  fully quit". A browser front end is exactly that case.
- `remote-agent-control.md` and the README: "no inbound port, no public URL". The daemon now
  listens on loopback by default, and on the LAN only after an explicit opt-in (§8). There is
  still no public URL, no port forwarding and no relay. Discord stays the away-from-home
  channel.

## 1. Terms

| Term | Meaning |
|---|---|
| **Daemon host** | The one Mac that runs the daemon, the session hosts, the agents, the repositories and any tool an agent drives (Unity, automation browsers). |
| **Daemon** | The long-lived process that owns application state: `createApp`, the stores, the control socket, the web server. It replaces Electron main. |
| **Browser client** | Any browser showing the web workbench. It may be on the daemon host or another device. It renders and sends commands; it never executes agent work. |
| **Connection** | One WebSocket from one browser tab. Short-lived; many per device. |
| **Device** | A browser that holds a paired device credential (§8). Revocable. |
| **Principal** | Who is acting. Today there is exactly one: the local owner (§9). |

## 2. What the spike found

### 2.1 The seams are real

| Seam | Where | Finding |
|---|---|---|
| Application core | `src/app/createApp.ts` | Takes only `HostServices`. Nothing outside `src/electron/` imports `electron`. |
| Host capabilities | `src/host/hostServices.ts` | One interface, one Electron implementation. Audited member by member in §6. |
| Pane hosts | `src/ui/dashboardHost.ts`, `src/ui/conversation/conversationHost.ts` | Written against the structural `EnvelopeTransport`. No Electron or window knowledge. |
| Renderer bridge | `src/shared/webviewBridge.ts`, `src/webview/common/paneApi.ts` | Uses `globalThis.agentWranglerHost` if a script defines it. That object is the whole renderer port. |
| CLI | `src/core/control/*`, `src/cli/*` | Socket JSON-RPC, independent of the window. Moves to the daemon unchanged. |
| Lifecycle precedents | `src/sessionHost/*`, `src/remoteDaemon/*` | Detached hosts that survive the app, a LaunchAgent daemon, socket and token files, build handshakes, replace-on-outdated. |

### 2.2 Prototype

The prototype is the `AW_WEB_PROTOTYPE=<port>` switch. It is off by default and serves the
workbench to a browser on 127.0.0.1 from the running app.

**Code**

| File | Role |
|---|---|
| `src/electron/webPrototype.ts` | HTTP and WebSocket server |
| `src/webview/webshim/main.ts` | Browser bridge |
| `src/core/web/wsFrames.ts` | Frame codec and request guards, tested in `test/wsFrames.test.ts` |
| `createWorkbenchHosts` in `workbenchWindow.ts` | Pane-host factory shared with the window |

**Running it**

```bash
osascript -e 'quit app "Agent Wrangler"'
open -g --env AW_WEB_PROTOTYPE=7391 -a "Agent Wrangler"
open "http://127.0.0.1:7391/?token=$(cat ~/Library/Application\ Support/Agent\ Wrangler/run/web.token)"
```

**Results**, against the installed app with live sessions:

| Check | Result |
|---|---|
| Existing bundles in Chrome | `workbench.js` ran **unchanged** with the shim loaded first. The table filled from the live store. A row click opened the conversation, with transcript, blocks and composer, in the browser. |
| Existing pane hosts per connection | `DashboardHost`/`ConversationHost` ran unchanged, one pair per WebSocket, over the one app. Two tabs plus the Electron window ran concurrently. |
| Request guards | A foreign `Host` got 421 (DNS rebinding). A foreign `Origin` on the upgrade got 403. A missing cookie got 401/403. |
| Dashboard traffic | One `snapshot` is about 85 KB of JSON for a store with ~45 sessions, and the whole snapshot is re-sent on every store change. With one agent busy that was 4 snapshots in 30 s, about 11 KB/s per client. Fine on a LAN, wasteful on cellular, and a parse cost on a phone. |
| Phone viewport (390×844) | The split puts two ~180 px panes side by side. The table folds to `#app.narrow` as designed, but the conversation is unusable at that width. **A mobile layout is required, not optional.** |

**App-wide state that is wrong for several clients.** The prototype worked around both of
these and recorded them:

1. **Navigation is app-wide.** `createApp` calls one `WorkbenchSurface` (`surface?.show`, about 25
   call sites). A row click in the browser therefore opened the conversation in the *Electron
   window*. The prototype overrides `smartOpen` per connection. New conversation, delegation and
   notification clicks still go to the window.
2. **Dialogs are app-wide.** `HostDialogs` confirmations, pickers and inputs appear as native
   dialogs on the Mac, whoever clicked.

**Reconnect.** The conversation pane keeps its session key in `setState`, but the host decides
what is shown, and `ready` does not carry the key. A reconnecting tab comes back to an empty
conversation. The window works because `main.ts` restores the key from `window.json`.

## 3. Recommendation summary

| Question | Recommendation |
|---|---|
| Go / no-go | **Go.** The seams make this a port, not a rewrite. The phone requirement cannot be met by the window. |
| Daemon | A LaunchAgent running `createApp` under a pinned Node inside a signed `.app` bundle (§4). Session hosts and Codex threads keep running in their own processes, so a daemon restart or update does not end agents. |
| UI | **Adapt the existing vanilla-TypeScript bundles.** Do not rewrite in a framework (§5). Add an app shell with routes, in-page modals and a stacked mobile layout. |
| API | One WebSocket per tab carrying today's `{pane, body}` envelopes, plus a `shell` channel. Use the `ws` package (pure JS, bundled) with permessage-deflate (§7). |
| Access | Loopback by default, with a token even on loopback. LAN only by opt-in, and only over TLS with paired device credentials (§8). |
| Accounts | A fixed `local-owner` principal, a `RequestContext` on every action, one `authorize()` entry point and audit attribution. No account features (§9). |
| Coexistence | During migration the Electron window becomes a client that loads the daemon's web UI. Retiring Electron then means deleting a thin shell (§11). |

## 4. Daemon ownership and lifecycle

**What moves into the daemon:** everything `src/electron/main.ts` builds except windows. That
includes:

- `createApp`, the stores and providers;
- the control socket;
- the quit policy;
- the power assertion (via `caffeinate -i -w <pid>` while agents work, replacing `powerSaveBlocker`);
- the sleep and wake handling (the remote daemon's timer-gap watcher replaces `powerMonitor`);
- the web server.

**What stays out:** agents keep running in session hosts and Codex app-server processes. This
answers the #20 objection that a daemon "moves the problem": an update restarts the daemon,
not the agents, which is the same contract the window has today. One prerequisite follows. The
in-process Claude path (`experimental.sessionHosts` is still `false` by default) must go,
otherwise a daemon restart ends conversations. See slice 1.

**Runtime.** A signed `Agent Wrangler.app` that contains a pinned official Node binary and
`dist/`. It no longer contains Electron.

- It stays a `.app` because macOS privacy grants (microphone for dictation, Automation for
  Terminal) attach to a signed bundle identity. #56 made that identity stable.
- Session hosts and the remote daemon already run from an APFS clone of the bundle
  (`sessionHostRuntime.ts`). The clone keeps working with `node` in place of
  `ELECTRON_RUN_AS_NODE`.
- Node single-executable applications are the alternative. They complicate the esbuild output
  and the signing, for no gain here. Decided as D1 (§12).

**Lifecycle**

| Event | Behaviour |
|---|---|
| Install / update | `install-app.sh` replaces the bundle, then `launchctl bootout` + `bootstrap` of `com.hammonjj.agentwrangler.core`. Hosts survive; the daemon reattaches through `HostSupervisor.scan`, exactly as the app does now. |
| Login | `RunAtLoad` when "Open at login" is on; otherwise started on demand by `aw daemon start` or by opening the app bundle. |
| Crash | `KeepAlive.SuccessfulExit=false` restarts it; hosts are unaffected. |
| Stop | `aw daemon stop` applies today's quit policy: hosts keep running. `aw daemon stop --all` is ⌥⌘Q. |
| Browsers close | Nothing happens. The daemon does not track browsers for liveness. |
| Single instance | launchd label plus a socket probe, as the remote daemon does now. |

**Secrets.** Electron `safeStorage` is unavailable, so secrets move to the login Keychain.

- The secret is written through `security -i` with the command on stdin, so it never appears
  in argv.
- A one-time migration must ship **while Electron still exists**, because only Electron can
  decrypt the old `secrets.json`. See slice 3.
- With secrets in the Keychain, the Discord daemon no longer waits for the app to be opened
  after a reboot, which removes a documented limitation.

**Remote daemon.** Folded into the core daemon (slice 17), so there is one LaunchAgent and one
feed. The app-feed / own-feed switch in `src/remote/daemon/sources.ts` collapses to the own
feed.

## 5. Browser UI: adapt, don't replace

The bundles are about 12k lines of vanilla TypeScript and CSS: dashboard ~5.2k, conversation
~5.0k, preferences ~2k. They run unchanged in a browser (§2.2).

| Option | Cost | Benefit | Verdict |
|---|---|---|---|
| Adapt the current bundles | Shell, routes, modals, mobile CSS: weeks, incremental, always shippable | Keeps the tuned streaming, caps, paging and narrow folding; the protocol and hosts already work | **Recommended** |
| Rewrite in React/Svelte/Lit | Re-implementing 75 message types' rendering, the streaming patch path and every narrow rule before parity | Component model, ecosystem | Not justified. Nothing measured is blocked by the absence of a framework. Revisit only if the shell work shows real component pain. |
| Keep the panes, replace the shell with a framework | Two paradigms in one document | Small | Not worth the mix. |

The adaptation:

- **App shell** (the `workbench` bundle grows up):
  - routes: Agents (table), Conversation, Missions, Analytics, Preferences;
  - the existing split above a breakpoint, one pane at a time with back navigation below it;
  - the shell may use the viewport; the panes still size off themselves, as CLAUDE.md requires.
- **In-page modal host** for `confirm`/`pick`/`input`, replacing the palette window and native
  dialogs. **Toast host**, replacing the preload's.
- **Conversation narrow mode**, matching the table's `ResizeObserver` class: composer, cards,
  tables, code blocks and diffs at 360 px, with 44 px touch targets.
- **Preferences** becomes a route of the same document, not a second window.
- **Accessibility**: modals trap focus and restore it; routes move focus to their heading;
  keyboard paths survive.

## 6. Capability audit: where each `HostServices` capability runs

**A** = daemon host, unchanged. **B** = browser-local interaction. **C** = needs a new workflow
for a remote client.

| Capability | Today | Class | Browser-era behaviour |
|---|---|---|---|
| `settings`, `globalState`, `workspaceState`, `sessionState`, `storageDir`, `dataDir`, `log` | JSON files in userData | A | Unchanged (`JsonStore` has no Electron import). |
| `sessionHosts`, `remoteDaemon` | Electron-binary runtime | A | Node runtime from the bundle (§4). |
| `secrets` | `safeStorage` | A | Keychain (§4). |
| `dialogs.info/warn/error` | Native message box | B | Modal on the **originating connection** (§7.3). With no originating connection, use a toast to every client and a non-interactive default. |
| `dialogs.flash` | Preload toast | B | `shell.toast` to the originating connection, or to all clients for app-wide notices. |
| `dialogs.input/pick` | Palette window | B | In-page modal over `shell.prompt`. |
| `dialogs.pickFolder` | Native folder dialog returning a local path | C | **Server-side folder browser** of daemon-host paths: known projects first, then a tree under `$HOME`. A path typed on a phone is a daemon-host path and is labelled so. |
| `shell.openExternal` | Default browser on the Mac | B | The URL goes back to the clicking browser (`window.open`). It never opens on the host. |
| `shell.openFile` (files, mission diffs) | Default app on the Mac | C | **In-browser viewer**: read-only file view and diff view served by the daemon. For a loopback client, an additional "Open on this Mac" action. |
| `shell.revealInFileManager` | Finder | C | Loopback: "Show in Finder" as today. Remote: copy the host path, or download the file. |
| `shell.runInTerminal` (Resume, Release) | Terminal.app via AppleScript | C | Loopback: as today. Remote: show and copy `claude --resume <id>` (`resumeCommand` already splits it out). A browser terminal (node-pty + xterm.js) is out of scope. |
| `clipboard.writeText` | Electron clipboard | B | `navigator.clipboard` in the browser. It needs a secure context, which is why the LAN requires TLS (§8). |
| `notify` | Electron `Notification` | B | The Web Notifications API in open tabs (secure context). Discord when away. With no tab open, `osascript display notification` on the host as a fallback (D3). |
| Tray / menu bar | Electron `Tray` | B | Dropped. The tab title and favicon carry the attention count (D4). A native helper only if it is missed. |
| Dictation | ffmpeg + whisper on the **host microphone** | C | Record in the browser (`MediaRecorder`, secure context), upload the audio, transcribe on the daemon with the same whisper. For a loopback client, recording on the host may stay as an option. |
| File drop / attach | Dropped OS paths read by the host | C | **Upload** over HTTP POST to a per-conversation staging directory on the host; the message references the host path. Images stay inline as today. Paths from a client are never treated as host paths. |
| Image paste | Inline base64 | B | Unchanged. |
| Downloads | None | C | `GET /files/...` limited to session working directories, worktrees and transcript directories; audited. |
| `workspaceFolders`, `subscribe`, `appName` | Trivial | A | Unchanged. |

**Host applications (Unity, automation browsers).** Agents start and drive these on the daemon
host through their own tools (MCP servers, CLIs), as they do now. Nothing about that depends on
where the user is. Seeing those windows is a separate matter:

- Screenshots an agent takes already appear in the transcript as images, which is enough to
  follow most workflows.
- Live viewing or interaction with a host window is **not supported** in the initial delivery.
  The documented workaround on a LAN is macOS Screen Sharing.
- A host window never becomes visible in the browser by itself, and the UI must not suggest
  otherwise.

## 7. API and synchronisation

### 7.1 Transport

- **One WebSocket per tab** at `/ws`, carrying today's `{pane, body}` envelopes unchanged, plus
  `pane: 'shell'` for everything that belongs to the document rather than a pane.
- **Server: the `ws` package.** It is pure JavaScript, bundled by esbuild like every other
  dependency. The prototype's hand-rolled codec is a spike artefact.
- **permessage-deflate** is on. The ~85 KB snapshot is repetitive JSON and compresses heavily.
- **Rejected:** SSE plus POST. It gives two channels for a protocol that is already
  bidirectional and request-id-correlated, and gains nothing on a LAN.

### 7.2 Messages

| Concern | Design |
|---|---|
| Handshake | `shell.hello {protocol, build}` from both sides. A build mismatch (a tab left open across an update) makes the client reload. Assets are served from the same build, so this is the only skew. |
| Initial state | Unchanged: `ready` gets `snapshot` / `init`. `ready` for the conversation gains an optional `key` so a reconnecting tab gets its conversation back. |
| Incremental | Unchanged: `snapshot` (table), `append`/`patch` and side channels (conversation). The table snapshot is **coalesced per connection** to at most one per second, and one per 10 s while the tab reports `hidden`. Deltas only if measurements after coalescing still demand them. |
| Reconnect | The client reconnects with backoff and re-sends `ready`. No page reload. Conversation `init` is tail-bounded (256 KB) so this stays cheap. |
| Acks | Every mutating message carries a client-generated `commandId`. The daemon keeps the result per device for 10 minutes, so a re-sent command after a drop returns the first result instead of acting twice (a double `send` is the case that matters). Existing `requestId` acks (`sendResult`, `missionAck`) carry over. |
| Stale actions | Already modelled: `decidePermission` checks `expectedRequestId` and returns `stale`. `answer`/`plan` require the request id. A second client approving the same ask gets `stale` and a toast saying it was already answered. |
| Backpressure | Each connection has a buffered-bytes ceiling. A client over it is closed and reconnects to a fresh snapshot. The session-host protocol uses the same model. |

### 7.3 Connection-scoped UI: the main structural change

`HostDialogs` and `WorkbenchSurface` are app-wide singletons today. They become **per request
context**:

- Every message from a connection is handled with a `RequestContext` (§9) that names its
  connection.
- `confirm`/`pick`/`input` started by that message go to that connection's modal host.
- `surface.show*` goes to that connection's conversation pane.
- If the connection drops, the prompt resolves as cancelled.
- Work the app starts by itself has no originating connection: notifications, quit confirmation,
  dictation setup. It is broadcast as a toast or notice and takes the existing non-interactive
  default. **It never waits on a modal nobody can see.**

`SessionActions` and the `launcher`/`projects` sources already take their dialogs through
`host.dialogs`. The change is to thread the context to that call. It is not a rewrite of each
action.

## 8. Access security

| Topic | Design |
|---|---|
| Default listener | `127.0.0.1` only. LAN listening is a Preferences opt-in, **off by default**, and shows the addresses it binds. |
| Loopback auth | Still required, because other local users and any web page can reach loopback. `aw web open` (and the app bundle when opened) mints a single-use, short-lived login link, which becomes the device credential cookie. This replaces the prototype's static token. |
| LAN transport | **TLS required.** Plain http on a LAN IP is not a secure context, which breaks clipboard, notifications and microphone, and it exposes the credential. Decided (D2): the daemon creates a local CA and a server certificate (SANs: `<host>.local` and current LAN IPs); each device trusts the CA once (an iOS/macOS configuration profile). A user-supplied certificate and key is supported as an alternative. |
| Pairing | From an already-authenticated client (the loopback browser) or `aw web pair`: a QR code and short code, valid 5 minutes and single use. The device exchanges it for a 256-bit device credential. The daemon stores only a hash (`devices.json`, 0600), with name, created and last-seen. |
| Cookies | `HttpOnly; Secure; SameSite=Strict; Path=/`. 30-day sliding expiry. The loopback cookie is separate from LAN ones. |
| Revocation | A device list in Preferences and `aw web devices [revoke <id>]`. Revoking closes that device's open connections immediately. |
| Origin / Host | Every request checks `Host` against the bound names (DNS-rebinding guard). Every WebSocket upgrade and every POST checks `Origin` equals the server. Both are proven in the prototype. |
| CSRF | No cookie-authenticated GET changes state. POSTs (uploads) need `Origin` plus a custom header, so a cross-site form cannot send them. All other mutations travel over the authenticated WebSocket. |
| Rate limits | Pairing-code attempts are capped per source IP with lockout; a failed-login counter is kept; upload size and rate are capped. |
| Audit | One append-only log, extending `FileAuditLog`: principal, device, connection, `via`, action, target ids, outcome. Ids only, never content, the same redaction as remote control. |
| Approvals | Browser approvals go through `SessionActions.decidePermission`/`answerQuestion`/`decidePlan`, the same funnel the window and Discord use. There is no browser-specific approval path. Transport authentication (who may connect) and action authorisation (§9) stay separate from agent approval (what an agent may do). |

**LAN deployment assumptions** (for the README): a trusted home network; the Mac's firewall
allows the port; no port forwarding; devices paired one by one. Anyone on that network can
reach the login page, but nothing behind it without a credential.

## 9. Principal model: accounts later, not now

```ts
type PrincipalId = string & { readonly __principal: true };
interface Principal { id: PrincipalId; kind: 'owner' }            // today: one, 'local-owner'
interface RequestContext {
  principal: Principal;
  via: 'browser' | 'cli' | 'discord' | 'daemon';                  // 'daemon' = the app acting on its own
  deviceId?: string;                                              // browser: which paired device
  connectionId?: string;                                          // browser: which tab; never an identity
}
authorize(ctx: RequestContext, action: ActionName, resource?: ResourceRef): 'allow' | 'deny';
```

- **Principal identity is separate** from device credentials, connections and Discord user ids.
  Pairing produces a device bound to a principal. A Discord `authorizedUserIds` entry maps to the
  owner principal.
- **`authorize`** is the single entry point, called by the WebSocket dispatcher, the control
  backend and the remote service before any `SessionActions` / orchestration call. The
  single-user policy allows the owner and denies everything else. The point is the call site,
  not the policy.
- **Audit** records `principal` and `via` on every mutating action (§8).
- **Ownership classification**, for whoever adds accounts:

| Host-wide (stays shared) | Potentially user-owned later |
|---|---|
| Agent runtimes, session hosts, hooks, Codex, local model endpoints, orchestration and routing policy, remote-control config, secrets, the web listener and devices list, nicknames (labels on shared sessions) | Column prefs, favourite and hidden projects, notification preferences, view state (already per browser), drafts. Arguably sessions/missions themselves (an `owner` field defaulting to `local-owner`). |

  Introducing accounts later would mean:
  1. a principal store and login;
  2. keying the right-hand column by principal, migrating existing values to `local-owner`;
  3. an `owner` on sessions and missions;
  4. a real `authorize` policy.

  None of that is built now.

**Built (#123, slice 2).** The types, the policy and the gate are `src/core/access.ts`; the
classification table above is repeated there as a doc comment. Each dispatcher authorises
before it acts: `DashboardHost` and `ConversationHost` once per message (`dashboardRequest`,
`conversationRequest`, both exhaustive over the message unions), the control backend once per
method (`via: 'cli'`), the remote service after its allowlist (`via: 'discord'`), and the
window's menu and tray, and the app's end of the remote daemon, through `guardSessionActions`.
Auto-pause is `via: 'daemon'`. Allowed mutations and all refusals go to
`~/.cache/agent-wrangler/access.log` (`FileAuditLog`, ids only); remote control's own lines in
`remote/audit.log` now carry `principal` and `via` too. `test/access.test.ts` enumerates the
entry points and drives each with a refusing `authorize`.

## 10. Web delivery and performance

- **Assets.** Hashed filenames (`workbench.<hash>.js`), `Cache-Control: immutable`. HTML is
  `no-store` and generated per request with a fresh nonce, as `renderWebviewHtml` does today.
- **CSP.** The current one plus `connect-src 'self' wss://<host>`, sent as a **header**
  (`frame-ancestors 'none'` cannot be set from a meta tag). No inline script or style; the
  existing rule holds.
- **Resource access.** Static files come only from `dist/webview`. Data files come only through
  the `/files` allowlist (§6).
- **Version compatibility.** §7.2.
- **Throughput.** Measured at ~11 KB/s per client while mostly idle, before compression and
  coalescing. Conversation streaming is already patch-based and tail-bounded.
- **Memory (#92, #95).** Each connection holds its own pane hosts, so the daemon's per-client
  cost is a `DashboardHost` + `ConversationHost` pair plus the conversation overflow budget
  (2 MB). That is bounded and released on disconnect; the prototype disposes both. On the client
  side, the conversation's DOM cap (400 nodes) only evicts while pinned to the bottom. That is
  #95's problem, unchanged by this move, and **more** pressing on a phone. A browser crash no
  longer takes the core with it, which is a reliability gain over the window.

## 11. Migration path

1. **Coexistence.** The daemon owns the core. The Electron window becomes a client: a
   `BrowserWindow` loading `http://127.0.0.1:<port>/` with the loopback credential. One code path
   for the UI from that point on.
2. **Parity.** Browser features reach the retirement checklist in slice 19.
3. **Retirement.** Delete `src/electron/`, the preload, the `aw://` scheme, the palette and
   preferences windows, Electron and electron-builder. The `.app` becomes the Node daemon bundle
   (§4).

**Retirement checklist** (all in a browser, local and on a paired phone):

- table and conversation;
- send, interrupt, approvals, questions and plans;
- new conversation with folder browse;
- missions and analytics;
- Preferences;
- uploads and downloads;
- notifications;
- dictation;
- Discord running from the daemon;
- `aw` CLI unchanged;
- daemon update with agents surviving.

## 12. Implementation slices

Effort uses the board's **Effort** field (XS < S < M < L < XL; roughly hours, a day, a few days,
a week, more). Blockers are real dependencies. Order beyond that is preference.

Each slice is written up as a GitHub-ready story in
`browser-workbench-stories.json`. Every entry has a purpose, scope, acceptance criteria, an
effort with its rationale, and its blockers, keyed by slice. They are filed as sub-issues of
the implementation epic, with native blocked-by links.

**Filed 2026-10-03:** epic #121, with slices 1–17 as #122–#138, 18a–18c as #139–#141, 19 as #142
and 20 as #143.

| # | Slice | Effort | Blocked by |
|---|---|---|---|
| 1 | Run every Claude conversation in a session host; remove the in-process path | M | — |
| 2 | Principal, `RequestContext`, central `authorize()` and audit attribution | M | — |
| 3 | Move secrets to the Keychain, with a one-time migration from `safeStorage` | S | — |
| 4 | Headless `HostServices` for plain Node | M | 3 |
| 5 | Connection-scoped prompts, toasts and navigation (replace app-wide `HostDialogs`/`WorkbenchSurface` for clients) | L | 2 |
| 6 | Web server: assets, CSP header, hashed assets, loopback listener, login link and device cookie | M | 2 |
| 7 | WebSocket API: `shell` channel, hello/version, reconnect without reload, `commandId` dedupe, `ready{key}`, backpressure, coalescing, deflate | L | 6 |
| 8 | Package the daemon runtime: signed `.app` with pinned Node; hosts and remote daemon run from it | L | — |
| 9 | Run the core in a LaunchAgent daemon: lifecycle, single instance, control socket, quit policy, power, sleep, `aw daemon` | L | 1, 4, 8 |
| 10 | Coexistence: the Electron window loads the daemon's web UI | M | 7, 9 |
| 11 | Multi-client convergence and approval resolution (tests plus fixes) | M | 5, 7 |
| 12 | App shell: routes, in-page modal and toast hosts, focus management | L | 5, 7 |
| 13 | Responsive mobile layouts for table, conversation and composer | L | 12 |
| 14 | Preferences, Missions and Analytics as routes | M | 12 |
| 15 | LAN opt-in listener with TLS | M | 6 |
| 16 | Device pairing, device list, revocation and rate limits | L | 6, 15 |
| 17 | Fold the Discord remote daemon into the core daemon | M | 3, 9 |
| 18a | File upload/download and server-side folder browser | M | 7 |
| 18b | Host-local actions vs remote alternatives: file/diff viewer, resume command, reveal | M | 7 |
| 18c | Browser notifications and browser-recorded dictation | M | 7 |
| 19 | Retire Electron | M | 10, 11, 13, 14, 16, 17, 18a, 18b, 18c |
| 20 | Docs: principles, README, CLAUDE.md, architecture, setup and troubleshooting | S | 19 |

**Can start in parallel now:** 1, 2, 3, 6, 8. Then 4, 5 and 7 as their single blockers land. The
UI track (12 → 13/14) and the remote-access track (15 → 16) run beside the daemon track
(8 → 9 → 10).

**Decisions** (accepted by James 2026-10-03, as recommended; no slice waits on them now):

| | Decision | Decided | Shapes |
|---|---|---|---|
| D1 | Daemon runtime | Pinned Node inside a signed `.app` (not a SEA, not Homebrew Node) | 8 |
| D2 | LAN TLS | Daemon-generated local CA plus a per-device trust profile; a user-supplied certificate as an option | 15 |
| D3 | Notifications with no tab open | Discord when enabled, otherwise an `osascript` notification on the host; no native helper | 18c |
| D4 | Menu-bar presence after Electron | Drop it (the tab title carries the count); revisit a tiny Swift helper only if missed | 19 |

**Biggest uncertainties:** slice 5 (how many of the ~25 `surface` call sites and the
dialog-driven actions need real redesign rather than context threading) and slice 13 (mobile
conversation ergonomics). Both are sized L and may split once started.

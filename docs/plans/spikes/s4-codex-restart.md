# Spike S4: can Codex threads survive an Agent Wrangler restart?

Issue #8 · playbook `docs/plans/session-lifecycle-architecture.md` §1.4, §1.7, §11 item 8,
§13 Stage 5, §19 (U7). Measured 2026-09-24. The harness is on branch `spike/s4-codex-restart`
under `spikes/s4/` and is not merged.

## TL;DR

- **Recommendation: (a).** AW launches its own detached `codex app-server --listen unix://<path>`
  from a pinned copy of the binary. Option (b), Codex's `app-server daemon`, runs **the same
  server** (`app-server --listen unix:// --managed-daemon`), so the reconnect semantics are
  identical. What (b) adds is things AW does not want: a machine-wide instance that the `codex`
  TUI attaches to by default, restarts that anyone on the machine can trigger, a package
  layout that the VS Code extension's binaries cannot start, and an automatic "recovery" turn
  after every restart.
- **A dropped client costs nothing on the server.** The turn keeps running with no client
  attached. Streaming continues, tools run, and a turn that finishes during the gap is on disk
  as `completed`. After reconnecting, `thread/resume` rejoins the running thread, and live
  notifications resume from that point.
- **Pending `requestApproval` and `requestUserInput` are re-sent, with the same JSON-RPC id,**
  to the connection that calls `thread/resume`. Answering the re-sent request completes the
  turn, and the approved command runs. They stayed pending through a 120 s gap with nobody
  connected. Nothing declines them on disconnect, and nothing times them out.
- **What a reconnect loses:** the deltas streamed during the gap (the item arrives whole in
  its `item/completed`), and `item/started` for any item that began during the gap.
- **What a server restart loses:** everything that was in flight. The turn is recorded as
  `interrupted`. Pending asks are gone and are never re-sent. The next turn works normally.
- **The writer lock is real and cross-process.** While one app-server has a thread loaded,
  `thread/resume` from any other app-server (such as the VS Code extension's) fails with
  `thread <id> already has an active writer`. The lock is released only when the thread is
  unloaded, which happens `thread_unload_delay_secs` (default 60 s) after it is idle with no
  subscribers. It is **not** released on disconnect or on `thread/unsubscribe`.
- **Stage 5 stands with amendments** (below). The biggest one: the socket speaks **WebSocket**,
  not NDJSON, so `CodexAppServer` needs a WebSocket client rather than `ndjsonPeer`.

## Setup

- Binaries: the two OpenAI VS Code extension bundles installed on this machine,
  `codex-cli 0.155.0-alpha.16.3` (the newest, which AW's `resolveCodexBinary` picks) and
  `0.155.0-alpha.16`. At the time, the VS Code extension was running one app-server from each
  bundle, and AW's own `--stdio` child used the newer one. So "two versions on one machine" is
  the normal state, not an edge case.
- **Nothing touched `~/.codex` or any Codex process the spike did not start.** Every server ran
  with an isolated `CODEX_HOME` under `/tmp/aw-spike-s4/`. Its `config.toml` pointed a custom
  `model_provider` at `mockResponses.ts`, a scripted stand-in for the Responses API (SSE). That
  gave real turns, real tool calls, real approvals and real questions, with no account, no auth
  and no cost, and every run was deterministic. The mock's scripts are "approve" (an
  `exec_command` call for `touch approved-marker.txt`, under `approvalPolicy: "untrusted"`),
  "ask" (a `request_user_input` call) and "slow" (a reply streamed over 20 s).
- **The daemon (b) was only ever started inside that isolated `CODEX_HOME`**, with the `pid`
  backend: no launchd, no `~/Library/LaunchAgents` entry, and nothing in `~/.codex`. Before
  starting it, `ps`, `lsof` and `~/.codex` were checked: no daemon was running, and
  `~/.codex/ipc/ipc.sock` belongs to the VS Code extension host, not to a daemon. `daemon update
  --from-cli` and `daemon restart` were run for real, on the isolated daemon only. Plain
  `daemon update`, which fetches production packages, was **not** run. What it does is
  described below from `--help`, from the binary's strings and from the `--from-cli` run.
- The client is `rpc.ts` plus `wsUnix.ts`: JSON-RPC over a minimal RFC 6455 client, on a Unix
  socket or on `proxy`'s stdio, logging every frame.

## Transport facts (these change the Stage 5 design)

1. **`--listen unix://PATH` speaks WebSocket over the socket, one JSON-RPC message per text
   frame.** Raw NDJSON is refused (the server logs `failed to upgrade control socket websocket
   connection`). A plain `GET /` upgrade with `Host: localhost` is accepted, and no token is
   needed on a Unix socket (`--ws-auth` only applies to non-loopback `ws://`).
2. **`app-server proxy [--sock PATH]` is a byte pipe, not a translator.** NDJSON into it gets no
   reply, and an HTTP upgrade into it gets `101 Switching Protocols`. So a client behind the
   proxy still speaks WebSocket. The proxy buys nothing over connecting to the socket directly.
   It does not isolate protocol versions either: an alpha.16 proxy in front of an alpha.16.3
   daemon worked, because only the client and the server speak the protocol.
3. **The listener puts the real socket in `/tmp/codex-daemon-<uid>/<sha256>`** (a 0700 directory,
   socket mode 0600, with a `.lock` beside it) and makes the requested path a symlink to it. The
   locks are left behind after the server exits. So "short path" is not a constraint: the long
   path the caller asks for is only a symlink.
4. **A detached listener outlives its parent.** It is reparented to launchd, and nothing tied it
   to the client connection.
5. **Signals.** `SIGTERM` to an idle listener exits it in about 0.1 s. `SIGTERM` with a turn in
   flight (here, waiting on an approval) **drains**, and it does not exit while that work is
   pending. One listener was still alive more than 30 minutes after `SIGTERM`, still accepting
   connections and still reporting `waitingOnApproval`. `SIGINT` exits at once, even mid-turn,
   and the rollout records that turn as `interrupted`.
6. **Server-request ids are per server process, monotonic across threads and connections.**
   With two threads waiting on approvals, the ids are 0 and 1 on the owning connection *and* on
   a second connection that resumes both. After a server restart the ids start again at 0.
7. **Any connection can answer any pending request by id**, even one that never subscribed to
   the thread: a fresh connection that sent `{id: 0, result: {decision: "accept"}}` without
   `thread/resume` ran the command. The socket's 0600 mode is the only access control, which
   matches the playbook's same-uid threat model (§12). Do not loosen the socket's permissions.
8. **`item/tool/requestUserInput` is only sent in `collaborationMode: plan`.** The tool is
   offered in default mode as well, but there the call fails inside Codex and no request reaches
   the client. That matches how AW's questions already arise.
9. **A thread with no turns cannot be resumed from another connection**
   (`no rollout found for thread id`), even on the same server. So after a core restart, a
   Codex conversation that was started but never sent a message is gone. Treat it as disposable.

## Reconnect semantics (the same for (a) and (b))

In each case the client was dropped abruptly (socket destroyed, or the proxy SIGKILLed), nobody
was connected for 3–120 s, then a new client ran `initialize`, `thread/loaded/list`,
`thread/read` and `thread/resume`.

| State at drop | While nobody is connected | New client after `thread/resume` |
|---|---|---|
| Streaming a reply | The turn keeps running and finishes if the gap is long enough | Live `item/agentMessage/delta` from the resume point on, then `item/completed` with the **full** text and `turn/completed`. The gap's deltas are not replayed, and the resume response's `turns[].items` holds only completed items (just `userMessage`) |
| `item/commandExecution/requestApproval` pending | `thread/read`: `active`, `activeFlags: ["waitingOnApproval"]`. Still pending at 120 s | **Re-sent, same id, same `itemId`**, right after the resume response. Answering it runs the command and completes the turn |
| `item/tool/requestUserInput` pending | `active`, `["waitingOnUserInput"]`. Still pending at 120 s | **Re-sent, same id.** The answer is accepted and the turn completes |
| Turn finished during the gap | The thread is `idle`, and the turn is `completed` on disk | No replay. `thread/resume` returns the completed turn with all its items |

**Multiple clients.** With a second subscriber attached (standing in for a second AW window, or
Discord through the core), **both receive the same request with the same id.** The first answer
wins, and the other subscriber gets `serverRequest/resolved {threadId, requestId}`. When the
first client drops, the second is not sent the request again, since it already has it.

**Server restart (not a reconnect).** Neither pending asks nor the in-flight turn survive the
app-server process:

- **Plain listener, (a):** `SIGINT`, then a fresh listener on the same `CODEX_HOME`.
  `thread/resume` shows the turn as `interrupted`, with nothing pending, and the thread `idle`.
  No request is re-sent and nothing resumes on its own. The next `turn/start` works.
- **Managed daemon, (b), `daemon restart` or `daemon update`:** the old daemon drains for about
  60 s, then stops. Its clients get `thread/status/changed → notLoaded` and `thread/closed`, and
  the pending approval dies unanswered. The new daemon then **starts a new turn by itself,
  before any client connects.** In the rollout, the interrupted tool call carries the output
  `"aborted"`, and a synthetic user message is injected:
  `<codex_internal_context source="daemon_recovery">The server restarted and interrupted the
  previous turn. Continue the unfinished work from the saved conversation. Check the current
  state before repeating actions that may already have completed.</codex_internal_context>`.
  The model re-decides, so a command that was only waiting on approval is proposed again, as a
  new request in a new turn with a new id. `thread/resume` then re-sends that new request.

## Writer conflict with the VS Code extension

This was tested with two app-servers on one `CODEX_HOME`, in both combinations of the two
binary versions. The spike never drove James's real extension.

- Server X has a thread loaded, whether busy or idle. Then `thread/resume` on server Y fails
  with `-32600 thread <id> already has an active writer`, and `turn/start` on Y fails with
  `thread not found`. X is unaffected. The lock lives in `CODEX_HOME/thread-writer-locks/`
  (`.coordination.lock`), so it applies across processes and across binary versions. **There is
  no silent fork of the rollout,** unlike Claude (S1).
- **The lock is released by unload, not by the client.** Dropping X's last client, calling
  `thread/unsubscribe` (it answers `unsubscribed`), or both, left the thread in X's
  `thread/loaded/list` and the lock held. Y's resume succeeded 60.7 s after X went idle with no
  subscribers (the default `thread_unload_delay_secs`). With `-c thread_unload_delay_secs=5` it
  succeeded after 5.1 s. After that, X is the one refused.
- A thread with a turn **waiting on an approval** is never idle, so it never unloads. The lock
  is held for as long as the ask is unanswered.
- **What that means for AW:**
  - Today (`--stdio`): an AW-run Codex thread is locked against the VS Code extension while AW
    runs, and is released about 60 s after AW's app-server exits or unloads it.
  - With a detached host, the lock outlives the AW window. That is the point, but it also means
    that opening the same thread in VS Code while AW's host has it loaded fails, and the reverse
    is true too. AW's reconnect must treat `already has an active writer` as "owned elsewhere"
    (show it, read-only), not as an error to retry.
  - Whether `thread/read` works across the lock was not tested.

## Two binary versions on one machine

- The extension bundles are version-named directories (`openai.chatgpt-<ver>-darwin-arm64`), and
  VS Code prunes old ones. A long-lived host started from "the newest bundle" today can find its
  executable deleted tomorrow.
- **Pin by copying.** Clone the extension's `bin/<platform>/` directory into an AW runtimes
  directory (the §11.7 pattern) and launch from that copy.
- Protocol compatibility is between AW's client and the server. alpha.16 and alpha.16.3
  interoperated in every direction tried: proxy → daemon, and writer-lock contention.
- Record `initialize.userAgent`, which carries the server version (`…/0.155.0-alpha.16.3 …`), in
  the host manifest.

## Option (b): what the daemon actually is, and why not

- **The extension's binaries cannot start it.** `daemon start` fails with `this CLI has no
  complete local package; install a packaged Codex CLI or use the standalone installer`. The
  extension flattens the package: `codex-package.json` says `entrypoint: bin/codex`, but the
  binary sits next to it. Rebuilding the layout by hand (the package JSON, `codex-resources/`,
  `codex-path/`, and `bin/{codex,codex-code-mode-host}`) made `daemon start` work. It then copies
  the package into `CODEX_HOME/packages/app-server-daemon/releases/…` and runs
  `…/current/bin/codex app-server --listen unix:// --managed-daemon`, with its socket at
  `CODEX_HOME/app-server-control/app-server-control.sock` and pid and state under
  `CODEX_HOME/app-server-daemon/`.
- **It is per `CODEX_HOME`, which for James means `~/.codex`: shared machine-wide.** The `codex`
  TUI attaches to it by default whenever it is running. The binary has a `--no-daemon` flag,
  "Run without the shared background server, even if it is already running", and a `/daemon`
  slash command. So if AW started it, James's terminal Codex would change behaviour.
- **Restarts are outside AW's control.** Any `codex app-server daemon restart` or `update`, from
  any terminal, restarts it. Plain `update` returns to "production updates", and the binary
  contains a managed updater (it fetches `chatgpt.com/codex/install.sh`, with an update loop and
  a `daemon-updater.pid`). That updater was not exercised. `update --from-cli` pins whichever
  CLI ran it: the spike downgraded alpha.16.3 → alpha.16 that way. Every restart costs the
  about-60 s drain, loses pending asks, and injects a recovery turn that AW neither asked for
  nor can suppress.
- **The only thing (b) has that (a) lacks** is that automatic recovery turn after a restart.
  For AW it is a liability (§13 principle: the user decides), and it hangs off the undocumented
  `--managed-daemon` flag.

## Verdicts

- **U7 (Codex pending approvals after a client disconnect): answered.** They are held
  server-side with no timeout, re-sent with the same id on `thread/resume`, and answerable from
  the new connection. They are lost only when the app-server process dies or restarts.
- **§11 item 8 is confirmed:** prefer (a), for the reasons listed there plus the ones above. Its
  "never `proxy` from a newer binary into an older server" is moot, because `proxy` is a byte
  pipe. Replace it with "the AW client must speak the server's protocol version; record it from
  `initialize`."
- **What to tell users:** "Codex approvals and questions survive an Agent Wrangler restart.
  They survive a Codex update only if the host keeps running: updating Codex restarts the
  host, which ends the running turn, and you re-send."

## Proposed amendment to §13 Stage 5 (for CP0; the playbook itself is not edited here)

> ### Stage 5: Codex execution decoupled
>
> - **Goal.** AW-run Codex threads, including in-flight turns and pending approvals and
>   questions, survive core restarts.
> - **Change (per S4).**
>   - The supervisor launches **one** detached `codex app-server --listen unix://<path>` (it
>     creates its real socket, mode 0600, under `/tmp/codex-daemon-<uid>/`, and `<path>` becomes
>     a symlink). It launches from a **pinned copy** of the extension's `bin/<platform>/`
>     directory under `runtimes/codex-<version>/`, never from the live extension directory,
>     which VS Code prunes. The manifest holds pid, socket path, binary path and the version
>     from `initialize.userAgent`. `stdout`/`stderr` go to a log file, never to a pipe.
>   - **The transport is WebSocket over the Unix socket** (one JSON-RPC message per text frame).
>     `CodexAppServer` gets a small in-repo RFC 6455 client (about 100 lines; see
>     `spikes/s4/wsUnix.ts`), with no new dependency. `ndjsonPeer` is not reused for this hop,
>     and `proxy` is not used.
>   - **On reconnect:** run `thread/loaded/list`, then `thread/resume` every registry-live
>     Codex thread that is still loaded (or on disk). Rebuild pending cards from the
>     `*requestApproval` / `requestUserInput` requests the server **re-sends after each resume,
>     with their original ids.** Dedupe by `(server instance, id)`, since ids restart at 0 when
>     the server restarts. Rebuild the transcript from `thread/turns/list` or `thread/items/list`
>     (`excludeTurns: true`, since full hydration is deprecated). Expect no replay of the gap's
>     deltas: create an item's block from its `item/completed` when no `item/started` was seen.
>   - **Handle `serverRequest/resolved`**, which `runner.ts` ignores today: another subscriber
>     (a second window, Discord, or a pre-restart core) may have answered first.
>   - **`already has an active writer` on resume** means the thread is open in another
>     app-server, usually the VS Code extension. Mark it "open elsewhere", read-only, and do not
>     retry. The lock frees about 60 s after the other side goes idle with no subscribers.
>   - **Host stop:** `SIGTERM` drains without limit while a turn is pending. The supervisor sends
>     `SIGTERM` only when no thread is `active`, and otherwise uses `SIGINT` (this interrupts
>     turns; say so in the UI). A **Codex version change** means a host restart, which loses
>     in-flight turns and pending asks. Do it only when idle, or on the user's command, and never
>     automatically mid-turn.
>   - A Codex conversation with no turns yet cannot be resumed after a restart. Drop it from the
>     registry instead of showing an error.
>   - **Not** the machine-wide `codex app-server daemon`. It cannot run from the extension's
>     binaries, the `codex` TUI attaches to it by default, anyone can restart or update it, and
>     each restart injects a recovery turn.
>   - Codex sessions are already in `SessionRegistry` from Stage 2.
> - **Files.** `src/codex/appServer.ts` (transport seam: stdio | ws-unix), `src/codex/wsClient.ts`
>   (new), `runner.ts` (replayed requests, `serverRequest/resolved`, completed-only items),
>   `codexHandle.ts`, `binary.ts` (copy and pin, version from `initialize`),
>   `src/core/session/hostSupervisor.ts`, `createApp.ts`, settings.
> - **Tests.** Reconnect with an injected transport; a resume-replay fixture (the request re-sent
>   with the same id after resume, then answered on the new connection); `serverRequest/resolved`
>   clears a card; the writer-lock error maps to "open elsewhere"; id dedupe across a server
>   restart.
> - **Manual.**
>   - Codex mid-stream → ⌘Q → relaunch → live, with the reply completing.
>   - Codex waiting on approval → ⌘Q → relaunch → the same card, still answerable.
>   - The same thread opened in the VS Code extension while AW's host has it loaded → "open
>     elsewhere", and after about 60 s idle it is resumable in VS Code.
> - **Risks.** Protocol drift between the pinned server and AW's client; the server version is
>   recorded in the manifest. An undrainable `SIGTERM`. The same-uid socket can answer any
>   approval (§12).
> - **Rollback.** A setting to go back to `--stdio`.
> - **PR.** Own PR. Can run in parallel with Stages 3–4 once Stages 1–2 have landed.

The model and effort block in the playbook can stay as it is. Approval re-delivery is no longer
ambiguous, so the "escalate if ambiguous" clause will not trigger.

## Open items (not blocking Stage 5)

- Whether `thread/read` works on a thread that another app-server holds.
- Behaviour across a Codex protocol break larger than alpha.16 → alpha.16.3. This is covered by
  recording the version, not by measuring it.
- Whether `thread_unload_delay_secs` should be lowered on AW's host (for example `-c
  thread_unload_delay_secs=10`), so a thread AW is done with is handed back to VS Code sooner.
  It is a product choice.

## Cleanup

- The spike killed every process it started by exact pid: listeners, proxies, the mock
  servers, and the isolated daemon (`daemon stop` in its own `CODEX_HOME`).
- It removed `/tmp/aw-spike-s4/` and the `/tmp/codex-daemon-<uid>/` sockets and locks its
  listeners had left. `lsof` showed no holder first.
- `~/.codex`, `~/Library/LaunchAgents`, the VS Code extension's Codex processes and AW's own
  app-server child were not touched.

# Remote control: when a remote tab is slow or hangs

Notes from the first time this was chased down (2026-10-21), so the next look starts from
here. The plan is `docs/plans/remote-control-supabase.md`; the setup is
`docs/remote-control-setup.md`; click latency has its own benchmark in `docs/relay-benchmark.md`.

If the loopback or LAN workbench is also empty or reconnecting, it is not the relay: see
`docs/workbench-wont-load.md`.

## Which front end is it?

"The web app" can mean two different things. Settle this first:

| What the user opened | What it is | Path |
|---|---|---|
| `http://127.0.0.1:7391/` or a LAN `https://` address | The workbench the daemon serves | A real WebSocket to the daemon. No manifest, so not installable (#162). |
| `agentwrangler.netlify.app`, or an app installed from it (Chrome "Install", iPhone Home Screen) | The relay loader (#175, #177) | Supabase Broadcast, end-to-end encrypted. Installable, and the usual subject of these reports. |

## The symptom that started this

The installed loader app (a Chrome PWA on the Mac) felt slow or frozen, mostly **after it had
been left idle**. Deleting the app and opening the URL in a fresh tab seemed to fix it. That is a
clue, not a coincidence: a fresh tab always starts with a live link, while a window left open
can be sitting on a dead one.

## What was wrong

Click latency over a live link was fine (traces around 200 ms). The time went to **finding out
that the link had died**:

1. The daemon's Supabase realtime socket drops routinely, every 30 to 120 minutes
   (`relay: channel error: socket closed: 1006`). supabase-js rejoins by itself.
2. If a tab's batch was being sent at that moment, the send failed and the daemon ended the tab
   **without telling it** (`virtualSocket.ts`: a failed send cannot deliver the `close`).
3. A hidden window's timers are throttled, and Chrome freezes a page that stays hidden.
   A frozen page cannot answer the daemon's pings, so the daemon drops it too.
4. The tab only found out from its own silence check: 180 s of quiet
   (`RELAY_SILENCE_MS`), then a probe with 15 s to answer. Every click in that window went into
   a channel nobody was listening on.

The underlying reason is architectural. Over Broadcast there is no transport-level "closed":
a `close` is just another message, and the failure that kills the link also stops it arriving.
Only silence shows a dead link, and the daemon's pings are slow on purpose because every message
is billed.

## What was changed (2026-10-21)

The rule now: **the tab owns liveness when the user returns.**

| Where | Behaviour |
|---|---|
| `src/webview/relayLoader/connection.ts` | On `visibilitychange` to visible, `focus`, `resume`, `pageshow` or `online`, a tab quiet for more than `RELAY_RESUME_QUIET_MS` (15 s) sends one probe and reconnects if there is no answer within `RELAY_RESUME_PROBE_MS` (5 s). A probe already out has its window shortened instead. |
| same | A `CHANNEL_ERROR` or `TIMED_OUT` on the tab's own channel after it subscribed probes at once. |
| `src/remote/relay/relayLink.ts` | A tab ended by a failed send (or whose `close` batch failed) keeps its channel and retries the `close` every 5 s for two minutes (`tellRetryMs`, `tellTries`), so it reconnects as soon as the link is back. |
| `src/webview/webshim/main.ts` | After a reconnect, the tab sends a `reconnected` shell message with why its last socket closed and how long it was down. The daemon logs it. |

The pure rules are `silenceVerdict` and `shouldProbeOnResume` in `src/shared/relay.ts`, tested
in `test/relayLiveness.test.ts`. The daemon side is tested in `test/relayLink.test.ts` and
`test/relaySocket.test.ts`.

The loader runs on Netlify, so a change under `src/webview/relayLoader/` is not live until the
site is redeployed (`docs/remote-control-setup.md` §4). The webshim ships with the daemon, so it
always matches the daemon's build.

## How to diagnose it next time

Logs: `~/Library/Application Support/Agent Wrangler/logs/core-daemon.log`.

1. **Is the daemon on the build you think it is?** `aw daemon status`. An old daemon is the most
   common reason a fix "did not work".
2. **Why did the tab reconnect?** Since the change above, every reconnect is logged:
   ```
   web: web-N (relay) is a tab back after its last socket closed (<reason>), down N.N s
   ```
   | Reason | Meaning |
   |---|---|
   | `resumed: no answer (quiet N s)` | The user came back and the probe went unanswered. The link died while the window was idle. |
   | `channel error: no answer …` / `channel timed out: no answer …` | The tab's own Supabase socket failed and the daemon did not answer the probe. |
   | `silent: no answer …` | Nothing heard for 180 s while the tab was in use. Look at the daemon side. |
   | `dropped` | The daemon dropped the tab and told it (`stopped answering`, or a failed send it later delivered). |
   | `send-failed` | The tab could not send to Supabase. |
3. **What happened on the daemon side around it?**
   ```bash
   grep -E 'relay:|stopped answering|tab back after' "$HOME/Library/Application Support/Agent Wrangler/logs/core-daemon.log" | tail -60
   ```
   | Line | Meaning |
   |---|---|
   | `relay: channel error: socket closed: 1006` | The daemon's Supabase socket dropped. Routine; supabase-js rejoins. |
   | `relay: tab closed (a send failed)` | A send failed and the tab was ended. Should be followed by `told a dropped tab to reconnect`. |
   | `relay: could not tell a dropped tab to reconnect` | The link stayed down for the whole retry window. The tab falls back to its own checks. |
   | `web: web-N stopped answering; dropping it` | The tab missed a pong for two ping periods. Usual for a frozen or sleeping tab. |
   | `relay: tab opened … ` shortly after `stopped answering` for the same device | The user gave up on a hung window and opened a new one. This pattern is the signature of the original bug. |
   | `trace: … relay click→recv N ms …` | Per-click timings. Over a live link these were about 200 ms. If these are slow, it is a throughput problem, not liveness: see `docs/relay-benchmark.md`. |
4. **Is it the browser?** Chrome DevTools on the app window (right-click › Inspect): the
   Console shows supabase-js socket errors, and Application › Service Workers shows `sw.js`.
   The service worker caches nothing, so a stale page is not the explanation; the workbench
   files are cached per build in IndexedDB and reload on a build mismatch.

## Things that were ruled out

- The service worker: it only shows push notifications.
- Batching and lanes (#189 to #195): click traces were fast whenever the link was alive.
- Backpressure: no `bytes unsent` closes.

## If it comes back

- Reconnect reasons that are mostly `resumed: …` with short `down` times mean the fix works and
  links are dying while idle. That is expected; the question is only how fast the tab recovers.
- Long `down` times with a `resumed` reason mean the reconnect itself is slow: look at the lobby
  (`relay: lobby …`, `the lobby did not hear its own probe`) and at `OPEN_TIMEOUT_MS` in
  `connection.ts`.
- Hangs with no reconnect line at all mean the tab never decided the link was dead: check that
  the deployed loader is current (`curl -s https://agentwrangler.netlify.app/loader.js | grep -c 'no answer (quiet'`
  should print 1) and that the events above fire in the browser.

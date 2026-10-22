# The workbench loads but shows nothing (or keeps reconnecting)

Notes from the first time this was chased down (2026-10-22), so the next look starts from here.
This is about the **loopback and LAN workbench** (`http://127.0.0.1:7391/`, the LAN `https://`
address, and a Chrome app pointed at either). For the Netlify relay PWA, see
`docs/relay-troubleshooting.md` instead. Follow-on hardening is tracked in #197.

## What it looked like

- The Sessions table said "No agent sessions found", the conversation pane was empty or stale.
- A Chrome app window and a normal browser tab behaved the same, so it was not one client.
- `aw status` was healthy, `curl http://127.0.0.1:7391/` answered, `aw daemon status` said running.
  Everything *looked* fine from outside. The page connected and was then thrown away.

## What it was (fixed in 442b791)

A scheduler hot loop. `TaskRunner.noteWait` (`src/orchestration/engine/taskRunner.ts`) writes why a
task is waiting. It skipped the write when the text was unchanged, but compared the wrong text for
a task with a pending escalation step, so it never matched. Each write saved the mission, fired a
change, and `put()` kicked the next scheduler step because a task was queued. About 100 steps a
second. Effects:

1. The core daemon sat at ~90% CPU.
2. Every browser got a stream of snapshots faster than it could read them.
3. The daemon closed each socket past `maxBufferedBytes` (8 MB, `browserConnections.ts`) with
   `backpressure`. The page reconnected, was sent the full snapshot, and was closed again about
   10 seconds later. It never got to render.

The trigger was a task whose attempt hit its wall clock (`retry-same`) while another mission held
an overlapping scope. Any long-lived wait with a pending escalation step would have done it:
fleet paused, usage window full, backoff, lease held.

## How to recognise it

Run these before anything else. All read-only.

```bash
aw daemon status                          # uptime and build
ps -o pid,%cpu,etime -p <daemon pid>      # a healthy idle daemon is single digits
LOG="$HOME/Library/Application Support/Agent Wrangler/logs/core-daemon.log"
grep -c 'waits (' "$LOG"                  # tens of thousands = the loop
grep 'bytes unsent' "$LOG" | tail         # closes on backpressure, one per reconnect
tail -n 400 "$LOG" | grep -v 'waits (' | tail -n 40   # the spam hides everything else
```

| Signal in `core-daemon.log` | Meaning |
|---|---|
| Thousands of identical `mission <id>: t1 waits (<reason>): …` lines, milliseconds apart | The loop. Same line, same mission, repeating. |
| `web: closing web-N: ~8390000 bytes unsent` then `browser disconnected` | The consequence. A socket was cut for backpressure. |
| `web-N (lan) is a tab back after its last socket closed (backpressure)` | The page reconnecting, then being cut again. |
| `0 remote tabs open` in `aw status` | The relay is not involved. |

A single `waits (…)` line when a task starts waiting is normal. The same line repeating is not.

## What to do

1. **Find the mission** from the repeating line (`mission <id>`), and read its state file under
   `~/Library/Application Support/Agent Wrangler/orchestration/missions/<id>.json`: the task's
   `state`, `stateReason` and `escalations`. Do not paste its contents into issues or commits
   (the repo is public).
2. **Do not just restart the core.** The loop returns on the next step if the mission is still in the same
   state. A restart is the right move only after the cause is fixed, or if you are cancelling the
   mission first.
3. **Stop the loop without code**: cancel the waiting mission from `#/missions`, or from the CLI if
   it has one. A cancelled mission produces no wait steps.
4. **If it is a different wait reason or a different path**, the shape to look for is the same: a
   code path that calls `put()` (which saves, fires a change and may `kickSoon()`) from inside
   `step()`, with a "skip if unchanged" guard that compares something other than what it writes.
   `noteWait` passes `{ kick: false }` now. Check any new caller of `put()` from the scheduler
   for the same pattern.

## What was changed

- `noteWait` compares the full text it would write, including the escalation prefix.
- `put()` takes `{ kick: false }`, and `noteWait` uses it: saying why a task waits frees nothing,
  so it must not schedule the step that would say it again.
- Regression test: `missionRunner.integration.test.ts`, "a task waiting with a pending escalation
  step says so once". It holds a wall-clock retry behind a fleet pause and counts wait lines and
  change events over 500 ms. Without the fix it sees ~200 lines.

## Things that were ruled out

- **The relay or Supabase.** No remote tabs, and loopback and LAN both failed.
- **The page or its build.** The same page worked the moment the loop stopped.
- **A stale daemon build.** Worth checking first (`aw daemon status`), but the build was current.
- **TLS, device cookies, pairing.** One `refused a loopback page load (no device cookie)` line
  appeared when a tab was opened without a sign-in link. That is expected and unrelated.

## If it comes back or looks different

- If CPU is high but there is no `waits (` spam, the loop is elsewhere. Sample the daemon
  (`sample <pid> 5`) and look for a hot function before guessing.
- If `bytes unsent` appears without a loop, something else is producing change events faster than
  a socket drains. #197 lists the missing guards: a step-rate watchdog and coalesced mission
  change events. Adding those is the next step, not another point fix.
- Log files are large (`agent-wrangler.log` reached 222 MB). `tail` and `grep -c` them; do not
  open them whole.

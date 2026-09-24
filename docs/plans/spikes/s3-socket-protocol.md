# S3: session-host socket protocol spike — findings

Status: done, 2026-09-24. Spike only; nothing here is built into the app. Answers issue
[hammonjj/AgentWrangler#7](https://github.com/hammonjj/AgentWrangler/issues/7), feeding playbook
§9 (IPC and protocol design) and §19 (U6).

Code: `spikes/s3/` in branch `spike/s3-socket-protocol` (throwaway, not merged). Two Node
processes (a synthetic "host" and a synthetic "core") talk NDJSON JSON-RPC 2.0 over a real Unix
domain socket in a temp directory. Messages are synthetic — shaped like SDK `stream_event`
deltas, not real Claude Code traffic. Machine: a single developer MacBook (Apple Silicon, macOS
Darwin 25.5.0, Node v26.3.0), so absolute numbers are order-of-magnitude, not a promise — the
qualitative behaviour (overflow → resync → catch-up without stalling the producer, clean
reconnect, sleep-safe heartbeat, path fallback) is the load-bearing result, not the exact
events/sec figure.

## Go/no-go

**Go on UDS + NDJSON JSON-RPC 2.0.** Nothing measured contradicts §9. Throughput has enormous
headroom over the ~2k/s target, 16 MiB frames round-trip correctly and over-limit frames are
rejected outright, the byte-bounded queue + resync design survives a fully stalled reader without
ever blocking the producer (once two paging bugs found during the spike are fixed — see below),
reconnect/resume-from-seq works both for the common case (ring still covers the gap) and the
degraded case (ring evicted the gap, forcing one resync), the heartbeat design correctly
distinguishes a real outage from a sleep using a monotonic clock, and the path-length fallback in
§9.1 is necessary and sufficient for the long-username case it was written for.

Two bugs were found and fixed in the spike's own protocol logic while measuring backpressure —
they're not failures of the UDS/NDJSON choice, but they are findings for whoever implements §9.4
for real (see "Contradicts / refines §9" below).

## 1. `stream_event` delta throughput and latency (~2k/s target)

Single client, subscribed from the start, deltas ~40 bytes of filler text each (a `content_block_delta`/`text_delta`-shaped envelope), sustained for 10s:

| Metric | Value |
|---|---|
| Requested rate | 2000/s |
| Actual delivered rate | 2025.6/s (20,256 events / 10s) |
| Latency p50 | 0 ms |
| Latency p99 | 28 ms |
| Latency max | 124 ms |

Ceiling (single client, host produces and enqueues as fast as it can in a tight loop, no
per-event timer): **~33,000–40,000 events/sec** sustained for 3s, client kept up with zero
resyncs. That's 16–20x the ~2k/s target, entirely on one loopback UDS connection with JSON
encode/decode and per-message queue bookkeeping on both ends — plenty of headroom.

**Producer-scheduling finding (synthetic-harness artifact, not a host property):** a naive
"one `setTimeout` per event" producer at a 0.5 ms nominal interval only achieved ~880 events/sec
in practice — Node's timer wheel doesn't hold sub-millisecond precision, so most of the requested
rate was silently lost to timer coalescing. Fixing this required a catch-up-loop producer
(`spikes/s3/host.ts`: compute how many events *should* exist given elapsed monotonic time each
5 ms tick, emit the shortfall in a batch) to hit the actual target rate. This doesn't affect the
real host, which is driven by SDK stdout `data` events rather than a self-scheduled timer, but it's
worth flagging because any future load-generation tooling for this protocol needs the same fix or
it will under-report.

## 2. 16 MiB frames

| Case | Result |
|---|---|
| At-limit frame (envelope ~16,777,074 bytes) | Delivered intact, byte-exact (`sentBytes === recvBytes` sans framing char), full round trip (produce → host encode → IPC → client decode/parse) in ~2.0–2.8s |
| Over-limit frame (17 MiB line, sent directly on the wire bypassing the host's own encoder) | Rejected: `LineFramer.onOversize()` fires, host destroys the socket, writer sees `EPIPE`. Never partially applied. |

The 2–2.8s figure is dominated by `JSON.parse`/`JSON.stringify` of a ~16 MB string and IPC
serialization overhead in the harness itself (the orchestrator round-trips through both child
processes' `process.send`), not by the socket. It's still a real number worth carrying forward:
synchronously `JSON.parse`-ing a 16 MiB line on a single-threaded event loop is a multi-second
stall if done in the same tick as anything else latency-sensitive. If the real core does this on
its main thread, a 16 MiB inline-image frame could visibly hang the UI for over a second; worth a
follow-up note in §9.2 that either the parse should be chunked/streamed or images this large should
be worth reconsidering as inline base64 at all. Framing itself (line detection, oversize
rejection) was not the bottleneck.

## 3. Slow/paused reader → overflow → resync → re-snapshot, producer never stalls

Setup: 2000/s deltas × 400 bytes each (~800 KB/s), 4 MiB per-client queue (the playbook's §9.7
default), client reader paused for 5s.

- Host kept producing the entire time the reader was paused: **+9,999–10,011 events over ~5.5s**,
  confirmed via host-side stats sampled every 500ms — `producedCount` climbed linearly and never
  stalled while the client's queue backed up and then overflowed.
- Per-client queue filled to **~4.19 MB** (right at the cap) and then overflowed exactly **once**:
  `overflowCount: 1`, `dropped: 7530` (queued-but-undelivered messages discarded in that one
  event).
- Host sent `resync`; on resume, client called `snapshot` then paged `messages` (**7 pages** of
  1 MiB each) and caught back up cleanly: `resyncs: 1` (after the fix below), no gap, no
  duplicate delivery once caught up.

**Bugs found and fixed in the spike while chasing this (both real findings for §9.4/§9.7):**

1. **`ring.from(fromSeq)` false-positived "needs resync."** The first implementation returned
   `null` (meaning "resync") whenever `fromSeq` was less than the oldest entry currently held —
   but early in a connection's life the ring hasn't evicted anything yet, it just hasn't produced
   that low a seq. Fix: track a `evictedThrough` high-water mark and only treat `fromSeq` as stale
   once real eviction has happened past it. Without this, `subscribe({fromSeq: 0})` right after
   connecting to a host that had already produced a handful of events spuriously resynced on
   every test run.
2. **Resync storm: `messages` paging returned the wrong `nextSeq`, and the reply size wasn't
   bounded by the client's own queue budget.** The host's `messages(fromSeq, maxBytes)` handler
   capped the *number of items* it returned at `maxBytes`, but reported `nextSeq` as the host's
   current global seq regardless of whether the page actually reached it. A client that asked for
   a 16 MiB page (matching the framing max, not the 4 MiB queue budget) got a multi-MB reply that
   immediately overflowed its own 4 MiB queue — triggering another `resync`, another oversized
   `messages` call, another overflow, on and on (`resyncs: 296` in one run before the fix).
   Fix: (a) `nextSeq` in the `messages` result now reflects where that page actually stopped, not
   the host's live seq, so the client knows to loop; (b) the client pages with a `maxBytes` well
   under the per-client queue cap (1 MiB against a 4 MiB queue in the spike) and loops `messages`
   calls until caught up. After both fixes: one overflow, one resync, seven small pages, clean
   catch-up, producer never stalled throughout.

**This is the one finding worth writing into §9.4/§9.7 directly:** the `messages` paging cap must
be documented as bounded by (and meaningfully smaller than) the per-client queue budget, not by
the 16 MiB frame limit, and the result's `nextSeq` must be "where this page stopped," not "the
host's current seq" — otherwise a client recovering from overflow can overflow again on the
recovery reply itself and loop.

## 4. Reconnect and resume from seq

Two sub-scenarios, 2000/s × 100-byte deltas, client disconnects and reconnects with `fromSeq =
lastSeq` it had before dropping:

| Scenario | Ring | Disconnect | Result |
|---|---|---|---|
| Clean resume | 16 MiB (covers the whole gap) | 500ms | `lastSeq` 2226 → 4239/4240 after reconnect, `resyncs: 0` — contiguous, no gap, no duplicate |
| Forced resync | 64 KiB (deliberately tiny) | 2000ms | Host evicted the resume point during the gap; client correctly got `resync`, caught up via paging to `lastSeq: 7244` with `resyncs: 1`. `received` (3492) is lower than the seq range because some history was genuinely evicted — expected and correct: the transcript, not the ring, is the durable record for anything the ring already dropped, per §9.7's "the transcript covers anything older." |

Both paths behaved as designed: gap-free resume when the ring covers it, a single clean resync
when it doesn't. Confirms the 16 MiB ring default (§9.7) comfortably covers realistic reconnect
gaps — even a 2s outage at 2000/s × 100B (~200 KB) is nowhere near evicting from a 16 MiB ring.

## 5. Heartbeat across a simulated sleep

Proxy for machine/app sleep: `SIGSTOP` a real child process for N seconds (a true OS-level freeze,
not a simulated clock jump), then `SIGCONT` it. The synthetic core's pinger (`spikes/s3/pinger.ts`)
pings on a monotonic clock (`process.hrtime.bigint()`) at an accelerated 300ms interval (proxy for
the real 10s) with a 3-miss threshold, and treats any tick whose measured gap exceeds
`interval × resumeFactor (3)` as a resume: it resets the miss counter and lets one fresh ping
decide, instead of counting the whole frozen span as misses.

| Scenario | Result |
|---|---|
| Baseline, no sleep | 5/5 pings answered, 0 resume events |
| Core process itself frozen 4s, host stays up | 1 `resumeDetected` (gap 4186ms vs 300ms interval), **0 misses accumulated**, never declared unreachable |
| Both host and core frozen together 4s (true laptop-sleep proxy) | 2 `resumeDetected` events, **0 misses**, never declared unreachable |
| Host genuinely killed (real outage, not a sleep) | Correctly declared unreachable after exactly 3 consecutive real misses (~1.5s at the accelerated interval; ≈30s at the real 10s/3-miss config) |

Two things worth carrying into §9.8:

- **A recursive `setTimeout` (not `setInterval`) already avoids a "miss storm" on wake.** Because
  the next tick is scheduled only after the current one finishes, a frozen process doesn't queue
  up N missed ticks to fire back-to-back on resume — it just runs one tick late. `setInterval`
  callbacks can catch up and fire in a burst instead; if the real implementation uses `setInterval`
  anywhere in this path, the elapsed-time/resume check in §9.8 is load-bearing, not decorative.
- **The elapsed-time check is what tells sleep apart from a hang, and it worked cleanly against a
  real SIGSTOP/SIGCONT freeze**, not just a mocked clock. In the real app this maps to Electron's
  `powerMonitor` `resume` event as documented in §9.8; the spike's `gapMs > interval × factor`
  heuristic is a reasonable fallback/cross-check even where `powerMonitor` is available, since it
  requires no OS API and catches the same class of event.

## 6. `sun_path` length and the fallback directory

Empirical bind boundary in a temp directory on this machine (macOS, Node v26.3.0): paths up to and
including **104 bytes** bound successfully; **105 bytes failed with `EINVAL`**. That's one byte
more headroom than the playbook's "104-byte `sun_path` including the NUL terminator ⇒ 103 usable"
would suggest — worth noting as a discrepancy, but not one to design against: treating 103 as the
practical ceiling (as §9.1 already does) stays safely under the empirical failure point on this
Node/macOS combination, and `sun_path` length limits are not guaranteed portable across OS/kernel
versions, so keeping the conservative number is correct regardless of the extra byte observed
here.

Realistic-path check, `hostId` = `k3q9x2mz` (8-char base32, per the playbook's §9.3 example):

| Case | Path | Length (bytes) | Fits in 104? |
|---|---|---|---|
| Primary, typical 12-char username | `/Users/<12 chars>/Library/Application Support/Agent Wrangler/run/k3q9x2mz.sock` | 80 | yes |
| Primary, 60-char username | `/Users/<60 a's>/Library/Application Support/Agent Wrangler/run/k3q9x2mz.sock` | 128 | **no** |
| Fallback, 60-char username | `/Users/<60 a's>/.agentwrangler/run/k3q9x2mz.sock` | 100 | yes |

Confirms §9.1's claim directly: the primary path is fine for a typical username but genuinely
exceeds the limit for a long one (128 > 104), and the documented fallback
(`~/.agentwrangler/run/`) recovers it (100 < 104) with room to spare. The length check needs to
happen before `bind()`, since `EINVAL` doesn't distinguish "path too long" from other bind
failures in a way that's safe to pattern-match on — measure `Buffer.byteLength(path)` against 103
and fall back proactively rather than trying-then-catching.

## Chosen sizes, with reasoning

| Parameter | Chosen value | Reasoning |
|---|---|---|
| Per-client outbound queue | **4 MiB** (confirms §9.7's default) | At the ~2k/s × ~100–400B target rate this holds several seconds of backlog before overflowing — enough to absorb normal jitter (UI thread hiccups, GC pauses) without ever resyncing in the common case, while still overflowing fast enough (≤~5s of a fully stalled reader) that a genuinely wedged client doesn't accumulate unbounded memory. The spike measured exactly one overflow after ~9000 messages backed up under a full stall, which is the intended behaviour, not a problem. |
| Ring size | **16 MiB** (confirms §9.7's default) | Comfortably covers realistic reconnect gaps (a 2s outage at 2000/s × 100B is ~200 KB, three orders of magnitude under the ring) while staying small enough that a resync's `messages` replay is fast. Only got forced into a resync in the spike by deliberately shrinking the ring to 64 KiB. |
| `messages` per-page cap | **New: must be ≤ per-client queue budget, not the 16 MiB frame limit** | Not previously specified in §9.4/§9.7 as a distinct value from the queue or frame caps; the spike shows it needs to be its own, smaller number (spike used 1 MiB against a 4 MiB queue) or recovery can overflow the queue it's trying to refill. Recommend adding this explicitly to §9.4's `messages` row. |
| Heartbeat interval / miss threshold | **10s / 3 misses (confirms §9.8)** | Not independently re-derived here — the spike validates the *shape* of the resume logic (monotonic clock, reset-on-resume, one fresh ping decides) works against a real process freeze, not that 10s/3 is optimal. No evidence found to change it. |
| Socket path length budget | **103 usable bytes (confirms §9.1)** | Matches the empirical failure point minus one byte of margin; the primary-path-then-fallback strategy is necessary (not just defensive) for realistically long macOS usernames. |

## Anything else contradicting §9

Nothing else. The transport, framing, handshake, and versioning sections all held up under the
measurements taken. The two paging bugs above are refinements to §9.4 (`messages`) and §9.7
(what "byte-bounded" needs to mean when a resync reply itself has to fit the budget it's
recovering from), not contradictions of the overall design.

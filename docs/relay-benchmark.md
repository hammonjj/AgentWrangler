# Remote relay: measuring it, and the gates it has to pass

Part of the remote-performance epic (#188): #190 (diagnostics) and #194 (this). The result tables
are in `docs/relay-benchmark-results.md`; the decision they feed is `docs/plans/remote-transport-adr.md` (#195).

There are two ways to look at the relay's speed, and they answer different questions.

| | What it is | What it answers | Deterministic |
|---|---|---|---|
| **The model** (`test/bench/relaySim.ts`) | The daemon's real queueing, lanes, snapshot coalescing, conversation window and tracing, on a virtual clock, over a simulated network | Did a change make the relay slower or chattier? Which stage owns a delay? | Yes: seeded, no wall clock |
| **The click trace** (`trace:` lines in `agent-wrangler.log`) | One real row click, followed from the click in a real browser to its first paint | How long does it take for James, today, on this phone? | No: it is the real network |

Use the model to protect the code, and the trace to check the model against life.

## The model

`runScenario(scenario)` builds one tab and runs it for a virtual two minutes (plus fifty seconds for
the last acknowledgements to land). Everything is deterministic: timers are virtual, the jitter and
the loss come from a seeded generator, and nothing reads a real project (blocks are generated from a
word list).

**Real code:** `createBrowserConnections` (acks, backpressure, snapshot coalescing and dedupe,
hidden-pane handling), `RelaySocket` (batching, lanes, per-stream order, batch bounds),
`InteractionTracer` and `ClickTrace` (#190), `recentWindow` (#192), the relay's connection limits.

**Modelled** (constants at the top of `relaySim.ts`):

| Piece | Model |
|---|---|
| Network | A sealed part is acknowledged, and arrives, after `2 × toSupabaseMs` plus jitter, as a Broadcast with `ack: true` does. Parts of a batch go one after another. A LAN tab is one WebSocket hop with no batching or acknowledgement. |
| Loss | A lost part's acknowledgement never comes; after ten seconds (the supabase-js default) the send fails, the tab is dropped, and the browser reconnects (four round trips) and resends what it had not seen answered. |
| Daemon work | `source.init` takes 12 ms for a small conversation and 85 ms for a large one; `smartOpen` 2 ms. |
| Browser | Decoding a batch 0.35 ms per sealed KB; rendering 14 ms plus 0.09 ms per block. |
| Codec | `sealedBytes`: deflate, then base64 and a tag per part. Crypto is **not** in the virtual time: WebCrypto completes on the real event loop, which a virtual clock does not wait for, and a CI machine's speed must not move a threshold. |

The codec's real cost is measured separately, on real time, by `test/bench/measureCodec.ts`, and is
printed at the foot of the results as CPU.

### What the columns mean

| Column | Meaning |
|---|---|
| click→recv, click→first, click→interactive | The browser's own clock: the click to the conversation's `init` reaching the page, to the first frame painted after it, and to the page idle again. p50 / p95. |
| Command→ack | A small mutating message sent to the daemon's acknowledgement arriving: what a typed message or an approval feels like, especially during a transfer. |
| Daemon p50 | `smartOpen` plus `source.init`, from the tracer. |
| Queue p50 | How long the click's batch waited in the relay's queue. |
| Send+ack p50 | Handing that batch to Supabase, acknowledgements included. |
| Render p50 | The page drawing what arrived. |
| KB down, Parts down | What the daemon sent over the run, sealed, and in how many Broadcast messages (the free-tier budget). |
| Snapshots sent/built | Table snapshots sent, against the ones the host built; the rest were unchanged, coalesced, or held while the table was out of sight. |
| Reconnects | Tabs dropped and reopened. |

The report separates the three places time goes: **daemon work** (Daemon), **relay network**
(Queue, Send+ack, and the residual between them and click→recv), and **browser** (Render, and
click→first less click→recv).

### Scenarios

`matrix()` in `test/bench/relayReport.ts`: LAN, a good relay link (40 ms to Supabase, 10 ms jitter)
and a poor one (150 ms, 60 ms jitter, 1% of parts lost), each with 1, 5 and 20 active sessions, a
small (24 blocks) and a large (2,000 blocks) conversation, an idle tab, a hidden tab, a burst of
large pages of history, and, for the relay, a dropped connection. Two more run the burst with the
relay's queue as it was before lanes (`fifo`), to show what the lanes buy.

`fifo` turns off the lanes only. It is not the code as it was before the epic: the heartbeat,
snapshot dedupe and the conversation window are all still in.

## The gates

`test/relayBenchmark.test.ts` runs in the ordinary test suite (about four seconds) and holds:

| Gate | Threshold |
|---|---|
| LAN, large conversation | click→first p95 ≤ 200 ms; command→ack p95 ≤ 10 ms |
| Good link, any load or size | click→first p50 ≤ 350 ms, p95 ≤ 560 ms; no reconnects; ≤ 2 MB down in the run |
| Large conversation | the remote tab is sent under a fifth of what a LAN tab is |
| Idle or hidden tab, 20 sessions | at most one snapshot in the run, however many the host builds |
| Active table | at most one snapshot every five seconds |
| Commands during a 360 KB transfer every 2 s | command→ack p95 ≤ 260 ms and within 80 ms of the quiet case; the lane-less queue is more than twice as slow |
| Poor link | reconnects, but at most eight; at least 18 of 30 clicks land; click→first p50 ≤ 1.5 s |
| A dropped connection | one reconnect; at least 29 of 30 clicks land |
| Determinism | the same seed gives identical results; another seed moves only the jitter |

The thresholds are measured values with headroom. Tighten them when the results improve. When a
change has to move one the other way, say why in the commit and regenerate the results.

## Running it

```bash
npm test                      # the gates, with everything else
npm run bench:relay           # the full matrix, written to docs/relay-benchmark-results.md
RELAY_BENCH_REPORT=/tmp/x.md npx vitest run test/relayBenchmark.report.test.ts   # elsewhere
```

## Comparing LAN with the real Netlify page

The model cannot say what a phone on a train does, and it must not be read as if it could. To
compare a real remote tab with a real LAN one:

1. Open the workbench both ways (`aw web open`, and the Netlify page on a paired device).
2. Click through the same ten or so rows in each, small conversations and large ones.
3. Read the `trace:` lines in `~/Library/Application Support/Agent Wrangler/logs/agent-wrangler.log`.
   Each is one click, with the transport (`lan` or `relay`), the browser's three times, and the
   stages the daemon and the relay measured (`smartOpen`, `init`, `queue`, `seal`, `send+ack`, the
   residual, `render`) and the batch's size. Every twentieth line is a p50/p95 summary per transport.
4. The daily `relay:` line carries batches, seal and send time, and tabs opened (the reconnect count).

A line holds an id, stage names and numbers, and never any transcript text, path, title or key.

### Reading a trace line

`click→recv` is what the user waits for before anything can be drawn. Subtract the daemon's stages
and the relay's (`smartOpen`, `init`, `queue`, `seal`, `send+ack`): what is left is `other`, the
browser's own send, Supabase's transit both ways and the browser's decode. It mixes two clocks, so
it is a residual and not a measurement. `render` is the page drawing what arrived.

| If this is large | The cause is likely | Look at |
|---|---|---|
| `init` | Reading a long transcript | `readTranscriptTail`, the window (#192) |
| `queue` | The click waited behind a batch in flight | Lanes and batch bounds (#193); `bulkBatchBytes` |
| `send+ack` | Supabase's acknowledgement is slow, or the batch is several parts | Parts and KB on the same line; the network |
| `other` | The up path (browser to daemon) or the browser's decode | The browser's connection; decode scales with KB |
| `render` | The page drawing a big window | The window size |

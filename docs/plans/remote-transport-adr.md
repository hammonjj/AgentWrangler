# ADR: keep the Supabase relay; do not move to a WebSocket tunnel yet

Status: **proposed, for James's approval** · 2026-10-19 · Epic #188, story #195
Supersedes nothing. Builds on `remote-control-supabase.md` and `docs/relay-benchmark.md`.

## Decision

**No-go on a cutover, and no prototype now.** Keep the optimized Supabase Broadcast relay. Collect
real click traces for two weeks (#190), and revisit only if a trigger below fires. If one does, run
the spike described under "If a trigger fires" before anything is switched.

No production cutover happens without James's approval, whatever the spike shows.

## Why

The epic's question was whether Netlify-hosted Agent Wrangler can approach direct LAN performance
without giving up remote security or free-tier operation. After #189–#193 the relay's numbers are,
in the benchmark model (`docs/relay-benchmark-results.md`, deterministic, 40 ms to Supabase):

| | LAN | Relay, good link | Relay, poor link (150 ms, 1% loss) |
|---|---|---|---|
| Click to first content, p50 / p95 | 131 / 131 ms | about 277 / 440 ms | about 1.2 s / 1.3 s |
| Command to acknowledgement, p50 / p95 | 3 / 3 ms | about 190 / 215 ms, also during a 360 KB transfer every 2 s | about 780 / 860 ms |
| Bytes sent to open a large conversation | about 360 KB | about 40 KB | same |
| Idle or hidden tab | one snapshot | one snapshot | one snapshot |

On a good link the relay is about two round trips to Supabase slower than the LAN, and most of that
is the network (two 80 ms hops and an acknowledgement), not anything the code can still remove. The
tail that used to come from a reply waiting behind a transcript or a batch window is gone (#193, and
the window fix in #194). What remains is the physics of a hosted broker.

A tunnel would take out one hop's worth of that, perhaps 60 to 120 ms of a 277 ms click. That is not
nothing, but it is small against what it costs (below), and these are modelled numbers: the real
Netlify comparison has not been taken. The model is not evidence that a tunnel is unnecessary on
James's phone; it is evidence that the cost of the relay is now mostly the broker's round trip, which
is the thing to measure for real before spending a security property to remove it.

## Options compared

| | Supabase Broadcast (today) | Cloudflare Tunnel with Access | Tailscale |
|---|---|---|---|
| Any browser, anywhere | Yes: a static page on Netlify | Yes: a hostname on a domain James owns on Cloudflare | **Serve**: tailnet devices only, so the Tailscale app on the phone. **Funnel**: public, any browser |
| Daemon connects outbound only | Yes | Yes (`cloudflared`) | Yes |
| Who can read the traffic | **Nobody but the two ends**: end-to-end AES-GCM under a per-device key; Supabase sees ciphertext and metadata | **Cloudflare**: it terminates TLS at its edge and could read everything. Closing that needs a second encryption layer, which is the relay's codec again | Serve: WireGuard end to end, and nothing on a relay can read it. Funnel: Tailscale's relay terminates TLS for the public hostname |
| Device pairing and revocation | Built (§3, §3.1): per-device keys, QR, revoke in Preferences | Access policies and service tokens or an identity provider; revocation is a policy change at Cloudflare. A second system alongside the paired-device store | Tailnet device approval and ACLs; Funnel has no login of its own (`Tailscale does no login check`), so the app's own device auth would still be needed |
| Origin and host-local protections | Unchanged: `deviceScope: 'relay'`, `pathAllowlist` | A new listener on the daemon, so it would need a new scope and origin check. Today's rule is "never add another listener" | Same: a new listener, or Serve proxying to the loopback one, which would make remote traffic look like loopback unless the scope is carried through |
| Latency | Two acknowledged hops per part; batching | One proxied WebSocket; no per-part acknowledgement | Direct path where NAT allows, else a relay |
| Cost | Free tier: 200 concurrent connections, 100 messages/s, 256 KB per message, with a monthly message and egress quota that the daemon counts daily (§4) | Cloudflare account and a domain; Access is reported free up to 50 users (check Cloudflare's pricing page: the source for this was not Cloudflare's own) | Personal plan free; Funnel is subject to bandwidth limits that are not published as numbers |
| Idle behaviour | Heartbeat every 60 s (#189) | Cloudflare closes an idle WebSocket after a period it does not publish (enterprise can change it): needs the same heartbeat | The connection is a tunnel; none |
| Asset delivery | The loader fetches the workbench from the Mac over the relay | Served by the daemon over the same hostname, which is simpler | Same |
| Operational surface | Supabase project and a Netlify site, both already built | A third account, a domain, a `cloudflared` service on the Mac | A client on every device, or Funnel |

Facts about Cloudflare and Tailscale above were checked against their documentation on 2026-10-19:
[Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets), [Tailscale Funnel](https://tailscale.com/kb/1311/funnel),
[Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits). The Cloudflare Access free-tier user
count and Tailscale's Funnel bandwidth figure were not found on an official page; verify both before relying on them.

## The security argument

The relay's central property is that **the broker cannot read the traffic**. Supabase is a hosted
service James does not run, and `remote-control-supabase.md` §5 is written around that: a compromised
Supabase sees ciphertext, topic ids, sizes and timing. A Cloudflare Tunnel inverts it. Cloudflare's
edge terminates TLS, so Cloudflare, or anyone who compromises that account, could read and alter every
conversation and every approval, and approvals can run code on the Mac. Closing that means encrypting
the payload inside the tunnel, which is rebuilding `RelayCodec` over a WebSocket: the cost saved is
the Supabase hop, and the cost paid is a new listener, a new auth system and a second revocation path.

Tailscale Serve keeps the property and removes the hop, but it does not meet the requirement that any
browser can be the client: the phone needs the Tailscale app and a tailnet login. Funnel meets it and
loses the property. Both add a listener to the daemon, which the hard rules forbid without a change to
`CLAUDE.md` and to the plan's §5.

So the two options that remove latency either give up end-to-end confidentiality (Cloudflare,
Funnel) or give up browser-anywhere (Serve). Neither is a free improvement, and the benefit is
bounded by the data above.

## Triggers to revisit

Revisit this decision if **any** of these holds over two weeks of real `trace:` lines (see
`docs/relay-benchmark.md`, "Comparing LAN with the real Netlify page"):

| Trigger | Threshold |
|---|---|
| The relay is slow for James on a good link | click→first p50 above 600 ms, or p95 above 1.5 s, with `send+ack` or `other` the larger part |
| The relay is unreliable | more than one reconnect per hour of use (`tabs opened` in the daily line), after #189 |
| The free tier is at risk | the daily message count projects past half the monthly Realtime quota |
| The broker is the limit, not the code | the benchmark gates are all met and the real numbers are still above the triggers |

If the first fires with `queue` or `init` the larger part, the fix is in the code (#192, #193), not in
the transport.

## If a trigger fires: the spike

Prototype only then, and only the option the data points at. Scope, in order, stopping at the first
no:

1. **Measure the floor.** A throwaway WebSocket echo through the candidate (Cloudflare quick tunnel,
   or Tailscale Serve) against the same click, with the daemon's trace. If it does not beat the relay's
   p50 by at least 40%, stop: the transport is not the problem.
2. **Keep the codec.** Run `RelayCodec` over the tunnel's WebSocket through the existing virtual socket
   seam (`RelaySocket`'s `ClientSocket` interface, `relayLink.ts`'s `attach`). Confidentiality does not
   depend on the tunnel, and `browserConnections` is unchanged: one more implementation of the socket
   interface, and the page's `agentWranglerSocket` factory is the other half of the seam.
3. **Auth.** Pairing and revocation stay the relay's (device keys, `devices.relayKeyOf`); the tunnel
   authenticates nothing the daemon relies on. A revoked device's key stops working at the codec,
   whatever the tunnel does.
4. **Listener.** A listener bound to loopback only, reached through the tunnel agent on the same Mac,
   with its own `deviceScope` (`'relay'`, so nothing host-local is offered) and an `Origin` check. This
   needs a `CLAUDE.md` change, approved by James, before it is written.

## Threat model for the spike's candidate

| Threat | With the codec kept |
|---|---|
| The tunnel provider reads traffic | Sees ciphertext only |
| The provider's account is compromised | Can drop or delay traffic, and can serve a hostile page if it also serves the loader (so the loader stays on Netlify, or is pinned by hash) |
| A stolen hostname or token | Reaches the listener, which refuses anything that does not authenticate under a device key |
| Cross-site use of the listener | `Origin` allowlist; no cookies; the listener speaks only the codec |
| Host-local actions | `deviceScope: 'relay'`; `pathAllowlist` applies |
| Lost phone | Revoke in Preferences: the key stops working at the codec |

## Runbook, migration and rollback (if ever adopted)

**Deploy.** Install `cloudflared` (or enable Tailscale Serve) as a LaunchAgent next to the core
daemon; add the loopback listener and a setting `remote.tunnel.enabled`, off by default; a loader
build that tries the tunnel first and falls back to Supabase.

**Migration.** Run both transports at once. The loader picks the tunnel when it answers within a
second and the relay otherwise, so a Mac that is off the tunnel still works. Pair no device twice:
the device key is the same on both.

**Rollback.** Turn off `remote.tunnel.enabled` and stop the agent. The relay never stopped, so there
is nothing to restore and no device to re-pair. The loader falls back by itself.

**Not changed by this decision.** Nothing in the daemon, the loader or the plan. The go/no-go is no-go.

## Consequences

- The relay stays the only remote path, and `CLAUDE.md`'s rules stand: no second relay, no inbound port.
- The epic's remaining unproven claim, LAN versus Netlify on real hardware, is a measurement James
  can take with the `trace:` lines; this ADR says what to read and what would change the answer.
- The virtual-socket seam stays the way a second transport would be added, and is why a spike would be
  days, not weeks.

# Remote control over Supabase + Netlify

Epic: #112. Status: **planned**, nothing built. Slice 0 (#171) turns this into an approved
design and changes the hard rule it conflicts with.

Use Agent Wrangler from a phone or another computer without routing any traffic to the Mac.
The Mac makes outbound connections only. Supabase is the meeting point; Netlify serves a static
copy of the workbench. Both run on their **free tiers**, and the design has to stay there.

This builds on [remote-agent-control.md](remote-agent-control.md) (Discord as a remote
presentation layer: no agent semantics in the transport, one approval path, redaction, audit)
and [browser-workbench.md](browser-workbench.md) (the workbench and its wire protocol). Those
rules still hold. What changes is *where the browser can be*: anywhere, instead of loopback or
the home LAN.

## Shape

```
Phone / browser (static PWA on Netlify)
        ⇅  websocket (wss), end-to-end encrypted payloads
Supabase: Auth (GitHub OAuth) · Realtime Broadcast · small Postgres
        ⇅  websocket (wss), outbound from the Mac
Mac: core daemon → src/remote/supabase/ transport

Mac daemon → Apple / Google / Mozilla push service → phone   (Web Push, notifications only)
```

| Part | Decision |
|---|---|
| Transport | `src/remote/supabase/`, behind `src/remote/transport.ts`, beside `discord/`. Outbound only. Off by default. |
| Live traffic | Realtime **Broadcast** on a private channel per user: agent table, conversation deltas, commands. Not stored. |
| Durable state | Postgres: paired devices, pending approvals, a command queue with idempotency keys, a daemon heartbeat. **No transcripts, ever.** |
| Auth | Supabase Auth, **GitHub OAuth** only for now. RLS on every table. The daemon signs in as its own revocable user; the `service_role` key never lives on the Mac. |
| Encryption | End to end. Pairing (a QR code, like LAN pairing) gives the device a key; Supabase stores and relays ciphertext only. |
| Approvals | Every remote action goes through `src/app/approvals.ts` and `authorize()` (`src/core/access.ts`). No transport-specific shortcut. |
| Frontend | The existing workbench bundle with a new shim (beside `src/webview/webshim`) that carries the current wire protocol over Supabase. Reuse, not a rewrite. |
| Notifications | The daemon sends Web Push (VAPID) straight to the browser's push service. Supabase can only reach an open page, so it cannot wake a phone. On iOS this needs the installed PWA. |
| Commands | The command registry from #59 is transport-agnostic, so the web client gets the same commands as Discord. |

### Why both Postgres and Broadcast

| Option | Problem |
|---|---|
| Broadcast only | A command sent while the Mac sleeps is lost, and with no DB activity Supabase pauses the project. |
| Postgres + Postgres Changes only | Every streamed delta becomes a row: burns the 500 MB and is the slowest Realtime path. |
| **Hybrid (chosen)** | Postgres for what must survive, Broadcast for the live stream. The heartbeat writes also keep the project awake. |

## Rules that keep later options open

The iOS app, other sign-in methods and an App Review demo login are **not** planned. These
rules only make sure nothing built now has to be torn out to get them.

| Rule | Keeps open |
|---|---|
| Key everything on the Supabase user ID, never a GitHub username or ID. | Email/password or Sign in with Apple as extra providers, with no schema change. |
| Sign-in and pairing are separate. Sign-in says who you are; pairing grants a daemon. | Any future login (a demo login included) reuses pairing as is. |
| The client talks to one "daemon connection" interface, not to Supabase calls spread through the UI. | A simulated daemon (demo, tests) is another implementation of that interface. |
| Each user row has a `role`/`flags` column that RLS checks, from day one. | A restricted account is a flag value, not a migration. |
| Every per-user row cascades from the user ID. | In-app account deletion (an App Store requirement) is one delete. |
| The frontend is a static bundle with no Netlify-specific runtime. | Wrapping it with Capacitor for a store app. |

## Free-tier guardrails

Numbers are from third-party summaries in 2026-10; slice 0 checks the official pricing pages.

| Limit | Guardrail |
|---|---|
| Supabase pauses a free project after about 7 days of low **database** activity. | Daemon heartbeat writes to Postgres. |
| Realtime: about 2M messages/month, 200 concurrent connections. | Stream only while a client is watching (Presence); coalesce deltas (about 250 ms). Nothing is sent with no viewer. |
| Database: 500 MB. | No transcripts; prune the queue and audit rows. |
| Supabase: 2 active free projects. | One project for Agent Wrangler. |
| Netlify: 300 credits/month, hard cap; about 15 per production deploy; every site pauses when they run out. | **Auto-deploy off.** Deploy by hand or from a tag. No Netlify Functions. |

## Security

- **Hard rule change.** CLAUDE.md says "never add a listener, a relay or anything public".
  Supabase is a relay. Slice 0 rewrites the rule to allow exactly this relay, with the threat
  model below, before any code lands.
- **Threat model to write in slice 0:** a stolen GitHub session (stopped by pairing), a leaked
  Supabase anon key (stopped by RLS), Supabase itself reading data (stopped by E2E), a revoked
  device, replayed commands (idempotency keys + expiry), and a lost phone.
- Redaction (`src/remote/redact.ts`) still applies to anything that leaves the Mac in clear
  text, such as push notification bodies.
- The Mac stays the execution host: paths from a remote client are never host paths
  (`src/core/web/pathAllowlist.ts`), and "Open on this Mac" stays loopback-only.

## Slices

Each lands on its own. Issues are sub-issues of #112.

| # | Issue | Slice | Done when |
|---|---|---|---|
| 0 | #171 | Design spike + hard-rule change | This doc is approved, the threat model is written, CLAUDE.md is updated. |
| 1 | #172 | Supabase project: schema, RLS, GitHub OAuth | RLS tests pass; a second user can read nothing. Migrations are in the repo. |
| 2 | #173 | Daemon transport | Outbound connection survives sleep/wake; heartbeat writes; `aw status` shows the link; off by default. |
| 3 | #174 | Pairing + E2E crypto | QR pairing; per-device keys; revoking a device cuts it off; Supabase holds ciphertext only. |
| 4 | #175 | Read-only remote workbench on Netlify | Live agent table and conversations from a phone; streaming only while viewed; auto-deploy off. |
| 5 | #176 | Remote actions | Send messages and answer permission/question/plan prompts through `approvals.ts`; audited. |
| 6 | #177 | PWA + Web Push | Installable; a lock-screen notification opens the right conversation. |
| 7 | #178 | Commands in the web client | The #59 registry's commands work from the web client as well as Discord. Also needs #59. |
| Future | — | iOS app | Not filed. The rules above keep it possible. |

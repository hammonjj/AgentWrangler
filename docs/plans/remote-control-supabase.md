# Remote control over Supabase + Netlify

Epic: #112. Design spike: #171 (this revision). Status: **designed**, slices 1–7 to build.

Use Agent Wrangler from a phone or another computer without routing any traffic to the Mac.
The Mac makes outbound connections only. Supabase is the meeting point; Netlify serves a small
static loader. Both run on their **free tiers**, and the design has to stay there.

This builds on [remote-agent-control.md](remote-agent-control.md) (a remote surface is a
presentation layer: no agent semantics in the transport, one approval path, redaction, audit)
and [browser-workbench.md](browser-workbench.md) (the workbench, its wire protocol and
`browserConnections`). Those rules still hold. What changes is where the browser can be:
anywhere, instead of loopback or the home LAN.

## 1. Shape

```
Phone / browser ── https://agentwrangler.netlify.app (static loader + service worker)
   │  GitHub sign-in (Supabase Auth)
   │  wss: Realtime Broadcast, private channels, payloads AES-GCM encrypted per device
Supabase (free): Auth · Realtime · small Postgres (profiles, daemon heartbeat)
   │  wss, outbound from the Mac
Mac: core daemon ── relay link (src/remote/relay/) ── browserConnections (unchanged)

Mac daemon ── HTTPS ──► Apple / Google / Mozilla push service ──► phone   (Web Push only)
```

### 1.1 The relay is a tunnel for the existing workbench protocol

The spike's main finding. `RemoteTransport` (`src/remote/transport.ts`) is the wrong seam: it
mirrors *asks* as cards (Discord). Remote control wants the whole workbench, and the workbench
already has a transport-neutral server side: `createBrowserConnections().attach(ws, device)`
takes a socket and does handshake, acks, exactly-once mutations, snapshot coalescing,
backpressure, liveness, per-connection pane hosts and `authorize()`.

So the relay link presents each remote tab to `browserConnections` as a **virtual socket**: an
object with the slice of the `ws` API that `attach` uses (`send`, `bufferedAmount`, `readyState`,
`ping`, `close`, `terminate`, `on('message'|'pong'|'close'|'error')`), whose bytes go through
Supabase. Everything above it is reused unchanged, including the approval path: an approval
from a phone is the same pane message as one from a LAN tab, and goes through
`src/app/approvals.ts` and `authorize()` the same way.

On the browser side, the webshim's `new WebSocket(url)` becomes a socket factory the page can
supply (`globalThis.agentWranglerSocket`). The Netlify loader supplies a relay socket with the
`WebSocket` API (`readyState`, `send`, `addEventListener('open'|'message'|'close')`). The rest
of the webshim (reconnect, resend, notices, host views) is reused.

A remote device's context is `ownerContext('browser', {deviceId, connectionId,
deviceScope: 'relay'})`. `'relay'` is a third `deviceScope`: not loopback, so "Open on this
Mac" is refused, and paths it sends are never host paths (`pathAllowlist.ts`), as for LAN.

### 1.2 The loader fetches the workbench from the Mac

A Netlify page cannot carry the workbench bundle itself. The daemon is rebuilt after nearly
every change (`app:install`), the shim's `hello` requires page build = daemon build, and every
Netlify production deploy costs about 15 of 300 monthly credits. A bundled page would either
reload forever or burn the credit budget.

So Netlify serves only a **loader** (sign-in, pairing, crypto, relay socket, service worker).
After connecting, the loader asks the daemon for its build's assets (`theme.css`,
`workbench.css`, `webshim.js`, `workbench.js` and the body markup from `src/ui/html.ts`),
received over the encrypted channel, compressed and chunked under the 256 KB payload cap. It
caches them in IndexedDB keyed by build hash, and injects them as `blob:` URLs. A daemon
rebuild costs one download (about 200 KB compressed) per device. A Netlify deploy is needed only
when the loader changes.

This is safe because only the paired daemon holds the device key: assets that do not decrypt
and authenticate are discarded. The loader page's CSP allows `script-src 'self' blob:`,
`style-src 'self' blob:` and `connect-src` to the Supabase project only.

### 1.3 HTTP-backed features over the relay

These panes call daemon HTTP routes directly, which a relay page cannot reach:

| Feature | Route | v1 over relay |
|---|---|---|
| File view | `fileViewUrl` (`hostView.ts`) | Unavailable; say so |
| Folder browser | `DIRS_PATH` (`folderBrowser.ts`) | Unavailable; say so |
| Upload | `UPLOAD_PATH` (`upload.ts`) | Unavailable; say so |
| Dictation | `DICTATION_PATH` | Browser dictation only |
| LAN pairing pages | `/pair/*` | Not applicable |

The page learns this from a capability in the shell `hello` (or a `relay` marker the panes
read through `paneApi`), so each control is hidden or explains itself instead of failing.
Tunnelling these routes is a later issue, not v1.

## 2. Supabase

### 2.1 Auth

- **GitHub OAuth** only. Supabase Auth's built-in GitHub provider.
- **Sign-ups closed** after James's first sign-in (Auth setting "Allow new users to sign up" off),
  so a stranger with a GitHub account cannot create a user.
- **Profiles gate RLS.** `profiles(user_id, role)`, created by a trigger on sign-up with
  `role = 'none'`. James's row is set to `'owner'` once by SQL. Every policy requires
  `role = 'owner'`. This is also where a future restricted account would be a flag value.
- **The daemon signs in as the same user.** Preferences › Remote has "Connect": it opens the
  GitHub sign-in (PKCE) with a loopback redirect (`http://127.0.0.1:7391/remote/callback`), and
  the daemon keeps the refresh token in its data dir (mode 0600). Supabase revokes it on
  "Disconnect". Same user, so one RLS rule covers both ends; the daemon is told apart by the
  messages it sends, not by identity.
- Nothing is keyed on a GitHub username or id; everything is keyed on `auth.uid()`.

### 2.2 Realtime: private Broadcast channels

| Topic | Who joins | Carries |
|---|---|---|
| `aw:<uid>:lobby` | the daemon always; a device while connecting | `connect` requests from devices (device id in clear, the rest encrypted), Presence for the daemon's own online state, and the daemon's `probe` (a random nonce, nothing else) |
| `aw:<uid>:c:<random>` | one device tab and the daemon | that tab's workbench traffic |

**The lobby checks itself (#186).** A dead Realtime socket can leave the daemon joined to a
lobby it no longer hears, while the REST heartbeat keeps succeeding. On 2026-10-17 that left
phones on "Your Mac is not answering" until the daemon was restarted. So every 5 minutes, on
wake from sleep, and 10 s after the lobby reports an error or closes, the daemon posts a
`probe` to the lobby over REST, the way a phone posts `connect`. The REST send did not come from
the lobby's socket, so `self: false` does not filter it, and the lobby hears it while the
socket works. If two probes in a row go unanswered (15 s each), the service rebuilds the link.
The first rebuild happens at once; if the new link fails its check too, the next waits 30 s,
doubling to an hour. `aw status` and Preferences say when the lobby last answered. A channel
error alone does not trigger a rebuild, because supabase-js usually rejoins by itself, and a
rebuild closes the open tabs.

One channel per tab, so a phone does not receive (and pay egress for) another tab's frames.
Authorisation is RLS on `realtime.messages`: a user may join and send on topics starting
`aw:` || `auth.uid()` || `:` when their profile is `owner`. Channels are `private: true`.

### 2.3 Postgres

| Table | Columns | Why |
|---|---|---|
| `profiles` | `user_id` (pk, → `auth.users` on delete cascade), `role` | RLS gate (§2.1) |
| `daemons` | `id`, `user_id` (→ `auth.users` cascade), `last_seen_at`, `build` | The loader can say "Mac last seen 3 h ago" while it is offline. The heartbeat write also keeps the free project from pausing. |

No transcripts, no device keys, no command queue. A queue was in the first draft. It is
dropped because a remote command while the Mac is offline has nothing to act on: prompts are
live, and the loader says the Mac is offline instead. Device records and keys stay on the Mac.

Every per-user row cascades from `auth.users`, so deleting the account is one delete.

## 3. Pairing and encryption

- **Pairing.** From the local workbench (Preferences › Remote › Pair a device), the daemon
  creates a device id and a random 256-bit key, and shows a QR code of
  `https://agentwrangler.netlify.app/#pair=<deviceId>.<key>`. The fragment is never sent to
  Netlify. The loader imports the key into WebCrypto as **non-extractable** and keeps it in
  IndexedDB. The phone then signs in with GitHub. The key is the device's whole authority to
  talk to this Mac. GitHub sign-in alone grants nothing.
- **Cipher.** AES-256-GCM (WebCrypto in the browser, `node:crypto` on the Mac), a random 96-bit
  nonce per frame. Additional data: `direction | deviceId | channel topic | seq`.
- **Replay.** `seq` increases per direction per channel. A receiver drops anything not above
  the last it accepted. A `connect` carries a timestamp and the daemon refuses one older than
  2 minutes or already seen.
- **Revocation.** The daemon deletes the device's key and closes its channels
  (`browserConnections.closeDevice`). A revoked device can still join its user's topics,
  because RLS is per user, not per device, but nothing it sends decrypts and nothing is sent to it.
- **Rotation.** Re-pair. Per-device frame counts stay far below AES-GCM's random-nonce bound.

### 3.1 Password sign-in that enrolls the device (#187)

QR pairing fails for the case it was built for. iOS gives a Home Screen web app its own storage,
so a key saved by Safari is not there. Nothing can open the pairing link inside the installed
app, and the GitHub redirect can leave it. So the phone gets one form, email and password, that
signs in **and** enrolls the device. The result is the same per-device key as QR pairing, so
everything below enrollment (cipher, replay, revocation, `connect`) is unchanged. QR pairing
stays as a fallback.

**One password, two values.** Supabase must never hold anything that enrolls a device, so the
password itself is never sent. Both ends derive the following values:

```
master    = PBKDF2-SHA-256(password, salt = "aw-v1|" + lowercase(email), 600 000 iterations, 512 bits)
authValue = hex(HKDF-SHA-256(master, info = "aw auth",   256 bits))   → the Supabase password
enrollKey =     HKDF-SHA-256(master, info = "aw enroll", 256 bits)    → AES-256-GCM key, never sent
```

PBKDF2 and HKDF are in WebCrypto and `node:crypto`, so no library is needed. The two HKDF
outputs are independent: knowing `authValue` does not give `enrollKey`. It does let someone test
password guesses offline (see §5).

**Setting it (the Mac).** Preferences › Remote › Password sign-in is a loopback-only action
(`authorize()`). James enters the password twice, with a minimum of 12 characters. The daemon
derives both values. It sets `authValue` as the Supabase password of the user it is already
signed in as (`auth.updateUser`, same `auth.uid()`, so no schema change, as §6 planned) and keeps
`enrollKey` in its data dir (mode 0600), like the device keys. It never stores the password.
Preferences shows the account email as the user name. Changing the password replaces both
values and leaves enrolled devices working. Turning password sign-in off deletes `enrollKey`,
after which the daemon refuses every enrollment.

**Enrolling (the phone, over the lobby):**

1. The loader derives both values and signs in with `signInWithPassword(email, authValue)`.
2. It makes an ephemeral ECDH P-256 key pair and joins the reply topic `aw:<uid>:c:<t>` for a
   random id `t`. Then it posts `enroll` to the lobby over REST. The request holds `t` in clear,
   plus `{pub, ts, label}` sealed under `enrollKey` with additional data
   `"enroll" | lobby topic | t`. The label is a short device description, such as
   "iPhone Home Screen app".
3. The daemon opens the request with `enrollKey`. It refuses the request if it does not
   authenticate, if `ts` is more than 2 minutes off, or if `t` was already seen. After 5 refusals
   in an hour it stops accepting enrollments for an hour and logs it. A refused request gets no
   answer.
4. The daemon creates a device id and a random 256-bit key, as QR pairing does. It lists the
   device as "<label> (password)". It joins the reply topic and sends `enrolled`: its own
   ephemeral ECDH public key in clear, and `{deviceId, key}` sealed under
   `HKDF(ikm = ECDH shared secret, salt = enrollKey, info = "aw enroll reply|" + t)`, with
   additional data binding uid, `t` and both public keys.
5. The loader imports the key as non-extractable, stores it the way QR pairing does, and goes on
   to the normal `connect`.

The ECDH step means that a recorded enrollment exchange does not reveal the device key, even if
the password is cracked later. `enrollKey` authenticates both ends, so Supabase cannot swap in
its own key.

**Loader states:**

| State | What the user sees |
|---|---|
| No device, no session | Email and password form, then enroll and connect. |
| Device stored, no session (expired, or signed out) | The same form. It only signs in. |
| Device stored, session valid | Connects, as now. |
| Device revoked | The device is forgotten and the form comes back, which enrolls a new device. |

The "Not paired yet" dead end goes away. GitHub sign-in and the `#pair=` link still work.

**Which project.** A device with nothing stored cannot learn the project from a pairing link.
So the loader reads `/project.json`, which `npm run build` writes into `dist/relay-site/` from
the building Mac's `remote.relay.url` and `remote.relay.anonKey`. Both are public values, and
the file is never committed.

**Supabase setup.** Turn on the Email provider and keep sign-ups closed. Leave "Secure password
change" off, so the daemon can set the password with its stored session
(`docs/remote-control-setup.md` §2).

## 4. Budget: staying on the free tiers

Supabase (official docs, 2026-10): 5 GB uncached egress, 2M Realtime messages, 200 concurrent
connections, 100 messages/s, 256 KB Broadcast payload, 500 MB database, 2 active projects; a
free project pauses after a week of low database activity. Realtime traffic counts toward
egress, and a Broadcast counts once when sent plus once per receiver. Over quota on Free means
a grace period, then restriction, not a bill.

Netlify (official pricing, 2026-10): 300 credits; a production deploy costs 15, bandwidth 20
per GB, and 2 per 10,000 requests. Netlify Functions are not used.

| Cost | Guardrail |
|---|---|
| Table snapshot (~85 KB JSON, up to 1/s over LAN) | Over the relay: at most every **5 s** while visible, **none** while hidden (the tab gets one on becoming visible), and skipped when unchanged apart from the clock, and held while the table's pane is off screen (#191). |
| Frame count | All envelopes due in a **250 ms** window go in one frame per direction. A busy viewer sends at most about 4 frames/s. Since #193 a reply to a click or approval is not held to the window or behind a transcript: it is `interactive` and goes when the batch in flight settles; snapshots, a conversation's opening and history pages are `bulk`, cut into batches of at most 192 KB, with per-pane order kept. |
| Conversation open | A remote tab opens on the last 60 blocks and pages older ones in on demand (#192). |
| Liveness | The daemon pings every 60 s; a tab that hears nothing for three periods pings back and gives the daemon 15 s before it ends (#189). The tab owns liveness when the user returns: shown, focused or unfrozen after 15 s of quiet, it probes and gives the daemon 5 s. A tab dropped by a failed send is sent its `close` again until the link is back. See `docs/relay-troubleshooting.md`. |
| Diagnostics | One `trace:` log line per row click, with stage timings, and a daily summary (#190). See `docs/relay-benchmark.md`. |
| Bytes | Every frame is deflate-compressed (`CompressionStream` / `zlib`) before encryption. JSON compresses about 5–10×. |
| Idle cost | Nothing streams with no tab connected. The daemon's lobby join and Presence are cheap; the lobby probe is about 2 × 288 messages a day. |
| Asset download | Cached per build in IndexedDB; about 200 KB compressed per device per daemon rebuild. |
| Project pause | Heartbeat upsert to `daemons` every 6 h while the link is on. |
| Netlify deploys | Auto-deploy **off**. Deploy only when `src/webview/relayLoader/` changes. |

Rough worst case, two hours of active phone use a day: about 30k messages and 30–60 MB a
day, so under 1M messages and 2 GB a month. The daemon logs a daily count of frames and bytes
sent over the relay so drift is visible before Supabase warns.

## 5. Threat model

| Threat | What stops it |
|---|---|
| Someone signs up to the Supabase project with their GitHub account | Sign-ups closed; RLS requires `profiles.role = 'owner'`. |
| James's GitHub session is stolen | Sign-in grants nothing without a device key. They can join his topics and see ciphertext. |
| The Supabase anon key leaks (it is public by design, shipped in the loader) | It only identifies the project; every table and topic needs an owner session (RLS). |
| Supabase, or anyone reading its database or logs, reads the traffic | End-to-end encryption; Supabase stores and relays ciphertext. It sees metadata: topic names (random ids), timing and sizes, and the heartbeat's build and last-seen time. |
| A paired phone is lost | Revoke it in Preferences › Remote. Its key stops working at once, and its open channels close. |
| Replay of a captured frame or `connect` | Per-channel sequence numbers in the authenticated data; timestamped, single-use `connect`. Mutations are also exactly-once by `commandId` (`CommandResults`). |
| A malicious script served as the loader (Netlify account or DNS compromise) | Residual risk: a replaced loader runs on a page that holds the device key. Mitigations: the key is non-extractable, the loader is small and built from this repo, and Netlify deploys are manual. Treat the Netlify account as sensitive (2FA). |
| Assets injected into the relay stream | Assets are accepted only if they decrypt and authenticate under the device key. |
| A remote device runs host-local actions or names host paths | `deviceScope: 'relay'` is not loopback ("Open on this Mac" refused); `pathAllowlist.ts` applies. |
| The daemon's Supabase refresh token is stolen from the Mac | It gives that user's Supabase access (ciphertext and topics), not device keys. Stored mode 0600 like the other secrets; Disconnect revokes it. |
| Supabase, or anyone with its database or logs, guesses the remote password offline (§3.1) | They hold `authValue` or its hash, so each guess costs 600 000 PBKDF2 iterations. A correct guess yields `enrollKey`, which can enroll a device. Residual risk, scaled by password strength: a minimum of 12 characters, a passphrase recommended. A new enrollment shows in Preferences › Remote with its label and time, and is revocable. |
| The remote password is stolen | The thief can enroll a device. Revoke it and change the password; existing devices keep working. |
| Online password guessing | Supabase Auth rate-limits sign-in. Without a session the lobby cannot be reached. The daemon stops enrolling for an hour after 5 refusals. |
| A recorded enrollment, decrypted after the password is cracked | The device key travels under an ephemeral ECDH secret, not under `enrollKey`. |
| Quota exhaustion (a bug, or a stolen session spamming topics) | Free tier restricts rather than bills; the daemon's frame and byte counts and Supabase's email warn. Disconnect in Preferences stops the daemon side. |

## 6. Rules that keep later options open

The iOS app, other sign-in methods and an App Review demo login are **not** planned. These
rules make sure nothing built now has to be torn out to get them.

| Rule | Keeps open |
|---|---|
| Key everything on `auth.uid()`, never a GitHub username or id. | Email/password or Sign in with Apple as extra providers, with no schema change. |
| Sign-in and pairing are separate. | Any future login (a demo login included) reuses pairing as is. |
| The page talks to the daemon through one socket interface (the relay socket). | A simulated daemon (demo, tests) is another implementation of it. |
| `profiles.role` gates RLS from day one. | A restricted account is a flag value, not a migration. |
| Every per-user row cascades from `auth.users`. | In-app account deletion is one delete. |
| The loader is a static bundle with no Netlify-specific runtime. | Wrapping it with Capacitor for a store app. |

## 7. Deploying

- Supabase: migrations in `supabase/migrations/`, applied with the Supabase CLI
  (`npx supabase db push`) or pasted in the SQL editor. The project URL and anon key are
  settings (`remote.relay.url`, `remote.relay.anonKey`), which are public values. The
  `service_role` key is never used by the app.
- Netlify: the loader builds to `dist/relay-site/`. Deploy it by hand with the Netlify CLI or
  the Netlify MCP server (`npx -y @netlify/mcp`) using a personal access token kept outside
  the repo. Site: `agentwrangler.netlify.app`.
- Auth redirect allowlist: `https://agentwrangler.netlify.app/**` and
  `http://127.0.0.1:7391/remote/callback`.

## 8. Slices

| # | Issue | Slice | Done when |
|---|---|---|---|
| 0 | #171 | Design spike + hard-rule change | This revision; CLAUDE.md updated. |
| 1 | #172 | Supabase: migrations (profiles, daemons, Realtime policies), GitHub OAuth setup doc | RLS tests pass against a local Supabase: a second user and a `none` profile read and join nothing. |
| 2 | #173 | Relay link in the daemon: Supabase sign-in from Preferences, lobby, virtual sockets into `browserConnections`, heartbeat, budget limits | A test client over a local Supabase gets `hello` and a snapshot through `browserConnections`; off by default; `aw status` shows the link. |
| 3 | #174 | Pairing + E2E: device keys, QR, AES-GCM frames, replay checks, revoke | A frame from an unpaired or revoked device is dropped; Supabase payloads are ciphertext. |
| 4 | #175 | Netlify loader: sign-in, pairing, relay socket, asset fetch and cache, webshim socket factory | The workbench runs at agentwrangler.netlify.app against the Mac, read-only features verified on a phone. |
| 5 | #176 | Remote actions + relay capability | Send, answer prompts and plans from the phone; HTTP-backed features hidden or explained. |
| 6 | #177 | PWA + Web Push from the daemon | Installable loader; a lock-screen notice opens the conversation. |
| 7 | #178 | Commands in the web client | The #59 registry's commands work over the relay and Discord. |
| 8 | #187 | Password sign-in that enrolls the device (§3.1) | A Home Screen app on a phone with no stored device signs in with email and password and reaches the workbench. A wrong password, a replayed `enroll`, or one sent with password sign-in off enrolls nothing. |

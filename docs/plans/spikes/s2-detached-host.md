# Spike S2: detached session host on macOS (#6)

Stage 0 spike for the session-lifecycle epic (#4). Answers U3, U4, U5 and U9 in
`../session-lifecycle-architecture.md` §19. This file is the findings only. The playbook is not
edited here; the §11/§12 changes it implies are listed under "Contradictions" and are for
whoever folds this into the playbook.

Run 2026-09-24 on macOS 26.5.1 (25F80), Apple silicon, Electron 44.4.3, Agent SDK 0.3.268,
Claude Code 2.1.236, `haiku`. Code is in `spikes/s2/` (commit A on `spike/s2-detached-host`).

**Verdict: go.** A detached host spawned from an APFS-cloned, renamed runtime survived every
scenario that could be run unattended, and a new build of the core reattached to it with a
token. Two of the playbook's assumptions are wrong, and both need fixing before Stage 3:
`safeStorage` for host tokens (§12) and a `process.on('SIGTERM')` handler (§11.10). See
"Contradictions".

## Setup

- **Test app, never the real one.** `spikes/s2/electron-builder.yml` packages a stand-in core
  as **"AW Spike S2"**, bundle id `com.hammonjj.agentwrangler.spike-s2`. It uses the real
  app's signing settings (ad-hoc `identity: "-"`, the same entitlements, no hardened runtime),
  keeps userData under `/tmp/aw-spike-s2/userData`, and holds its own single-instance lock and
  Keychain item. It went to the worktree's `spikes/s2/out/`, was copied to
  `/tmp/aw-spike-s2/builds/b{1,2}/`, and was "installed" at `/tmp/aw-spike-s2/apps/`.
  It was launched with `open -g`. Every `osascript` quit targeted
  `application id "com.hammonjj.agentwrangler.spike-s2"`.
  `/Applications/Agent Wrangler.app` and the running app were never touched: the same pid and
  start time before and after.
- **Core (`main.ts`).** At `spawnHost` it `cp -c -R`s its own bundle to
  `runtimes/<build>/AW Spike S2 Host.app` and renames `Contents/MacOS/AW Spike S2` to
  `AW Spike S2 Host`. `Info.plist` is not edited, so the clone's CFBundleExecutable is stale.
  It then runs
  `spawn(cloneExe, [<clone>/Contents/Resources/app.asar/spikes/s2/dist/host.js, …],
  {detached: true, stdio: ['pipe', logFd, logFd], env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}})`,
  writes the 256-bit token as the first stdin line, ends stdin and calls `unref()`. The token
  is stored twice: in a 0600 file under `run/` (0700), and as `safeStorage` ciphertext.
- **Host (`host.ts`).** Reads the token, destroys stdin, and listens on `run/<id>.sock` (0600).
  It writes a manifest, then runs one SDK `query()` with a streaming input queue, so every
  `send` is a turn on the same live `Query` and `claude`. Settings:
  - `settingSources: []`, so none of James's hooks run;
  - an explicit env with `ELECTRON_*` and `AW_*` removed;
  - an allow-all `canUseTool`;
  - a SIGTERM handler that ends the input, waits ≤5 s for `claude`, then exits.
- **Survival check (`drive.ts check`).** Both pids are alive. A fresh client reconnects with
  the token (`hello`), and a real turn (`Reply with exactly: pong`) completes on the original
  session id.
- **Hosts:**
  - `h1`: from the b1 clone, cwd `/tmp/aw-spike-s2/proj`.
  - `h2`: from the b1 clone, cwd `~/Documents/aw-spike-s2/proj`, a scratch directory deleted
    afterwards.
  - `h0`: the control. Spawned from the installed bundle itself (no clone), with **no**
    explicit env.

## 1. Survival table

"Survived" means the host pid, the `claude` pid and the SDK session were unchanged, a new
client reconnected with the token, and a turn completed (0.7–1.8 s for `pong`). After the core
was gone, both hosts had ppid 1 and their own pgid (the host's pid). `claude` shares the
host's pgid.

| # | Scenario (how it was done) | Core | h1 (clone) | h2 (clone, cwd in ~/Documents) | h0 (control: no clone) | Quit hook seen by core |
|---|---|---|---|---|---|---|
| 1 | Window close (`win.close()`) | keeps running, 0 windows | survived | n/a (spawned later) | survived | `window-all-closed` only |
| 2 | Menu quit (Quit item's click handler via `MenuItem.click()`; see §6 for real ⌘Q) | exited 0 | survived | n/a | survived | `before-quit source=menu` |
| 3 | `osascript -e 'tell application id "…spike-s2" to quit'` | exited 0 | survived | n/a | survived | `before-quit` **unflagged** |
| 4a | `kill -TERM <core>`, no Node handler | exited 0 (graceful) | survived | n/a | survived | `before-quit` **unflagged** |
| 4b | `kill -TERM`, `process.on('SIGTERM')` installed at module load | exited 0 (graceful) | survived | n/a | survived | handler **never fired**; `before-quit` unflagged |
| 4c | `kill -TERM`, handler installed after `whenReady` (+1 s) | exited 0 | survived | survived | survived | handler fired; `before-quit source=signal:SIGTERM` |
| 5 | `kill -9 <core>` | killed, no hooks; the helpers went with it | survived | n/a | survived | none |
| 6 | Crash (`process.crash()` in main) | crashed; a DiagnosticReports `.ips` was written | survived | n/a | survived | none |
| 7 | Install: `osascript` quit → `sleep 2` → `rm -rf` bundle → `cp -R` build b2 (the new cdhash) → `open` b2 | b1 quit; b2 started | survived; b2 core reattached (file token) and ran a turn | survived; b2 reattached; ~/Documents still readable | **survived** (its executable was deleted under it); b2 reattached | b1: `before-quit` unflagged |
| 8 | Sleep/wake | — | manual, pending (§6) | | | |
| 9 | Logout | — | manual, pending (§6). Proxy measured: SIGTERM to each host → graceful exit, `claude` exited on stdin EOF in **832 ms** | **1336 ms** | **1332 ms** | |
| 10 | The agent session driving the spike died (its parent Claude Code session ended mid-run) | kept running | survived, pong | survived, pong | survived, pong | none (not involved) |

Scenarios 2 to 7 ran in sequence against the same h1 and h0 processes. h1 survived nine
core deaths across two builds and ran all its turns on one `claude` process.

## 2. "Also verify" measurements

| Item | Result |
|---|---|
| **Quit source in Electron 44** (U4) | There is no API: `before-quit`, `will-quit` and `quit` carry no reason. Measured: a custom Quit menu item (not `role: 'quit'`) can flag itself; an Apple Event quit is unflagged; **SIGTERM is turned into a graceful quit by Electron's own handler**, so without help it looks exactly like an Apple Event. A Node SIGTERM handler registered at module load is **overridden** by Electron's and never runs. Registered after `whenReady`, it runs and can flag the quit. Details and decision in §3.3. |
| **Renamed exe, ad-hoc signature** | Runs. `cp -c -R` of the 290 MB bundle takes **89 ms** (an APFS clone, with blocks shared). The clone's static signature is **broken**: `codesign --verify` of the bundle gives "code object is not signed at all" (CFBundleExecutable points at a missing file), and of the exe gives "invalid Info.plist". It still launches, and runs for 50+ minutes, because the kernel checks the Mach-O's embedded code directory, and that and its cdhash are unchanged (b1 `376efd91…` in both copies). `ELECTRON_RUN_AS_NODE` loads `host.js` straight out of the clone's `app.asar`. The packaged fuses: `RunAsNode` Enabled, `EnableNodeOptionsEnvironmentVariable` Enabled, `OnlyLoadAppFromAsar` Disabled. Re-signing the clone ad-hoc (after fixing CFBundleExecutable) takes 585 ms and verifies, but gives a new cdhash and drops the entitlements unless they are passed again. Not needed. |
| **LaunchServices / name matching** | `lsappinfo` lists only the core. No host, not even h0, is registered as an app, and `open` launched b2 normally while h0 was running the installed bundle's own executable. `pgrep -f "AW Spike S2.app/Contents/MacOS/AW Spike S2"` and `pgrep -x "AW Spike S2"` both **matched h0** (the uncloned host) and neither matched h1 or h2. The real `install-app.sh` guard is `pgrep -f "/Applications/Agent Wrangler.app/Contents/MacOS/Agent Wrangler"`, and a `killall "Agent Wrangler"` would do the same. |
| **TCC, repo under ~/Documents, after bundle replace** | The host and `claude` have the **core as their responsible process** while the core lives (`responsibility_get_pid_responsible_for_pid`). Once the core dies, **each becomes its own responsible process**. That is still the b1 identity (bundle id plus the unchanged b1 cdhash). After b1 was deleted and replaced by b2: h2 (cwd in `~/Documents`) `readdir` succeeded in 3 ms, `claude` in h2 ran `cat hello.txt` fine, and h1's `claude` read the file with the Read tool. **Open question answered: replacing the bundle did not change or revoke access for processes running from a clone of the old build.** Caveat: the **b2 core's** first `~/Documents` access took **13.5 s**, then 0 ms. b1's first access took 10–13 ms. That fits TCC re-evaluating (and probably showing a consent dialog) for the new ad-hoc cdhash. James to confirm whether he saw an "AW Spike S2 would like to access files in your Documents folder" dialog at about 15:35 UTC. The TCC database and the tccd log were not readable without Full Disk Access. |
| **safeStorage after rebuild** (U5) | Same build: encrypt 0–7 ms, decrypt after relaunch 2 ms, no prompt. **New build (b2, new cdhash): the first safeStorage call, even `isEncryptionAvailable()`, blocked the main thread** in `SecKeychainItemCopyContent` while `SecurityAgent` put up a Keychain dialog. The core's control socket stopped answering until the process was killed. The dialog was not waited on (instructed). Killing the core did not end SecurityAgent right away. |
| **App Nap / powerSaveBlocker** (U9) | **No throttling observed** in any phase. The core was launched with `open -g` and never frontmost. Every phase used 1 s `setInterval` timers in the core and in host h1; results are core / host. A: window open, 150 s: max 1002 / 1002 ms, 0 ticks over 1.5 s. B: window closed and `app.dock.hide()`, 150 s: max 1002 / 1002 ms, avg 996, 0 over 1.5 s. C: as B plus `powerSaveBlocker.start('prevent-app-suspension')`, 126 s: max 1002 / 1002 ms, 0 over 1.5 s. `pmset -g assertions` shows the blocker as `NoIdleSleepAssertion named: "Electron"` for the core's pid, so it also prevents idle system sleep, not just App Nap. **Decision:** U9 is not a blocker. Keep the blocker only while an agent is busy, as §11.10 says, because it also holds off idle sleep. Unmeasured: much longer idle periods (App Nap can escalate after minutes) and running on battery. |
| **fd leaks into `claude`** (`lsof`) | None. `claude` has fds 0–2 (the SDK's socketpairs, dup'd to 4/5), kqueues, its own TLS sockets and its own `/tmp/cc-socks/<pid>.sock`. There is no host listening socket, no log file and nothing under `/tmp/aw-spike-s2/{run,logs}`. The host inherited **none** of the core's 55 fds: 0 is the (destroyed) stdin, 1–2 the log file, then its own Electron files, the asar, its socket and `claude`'s pipes. |
| **`ELECTRON_*` in `claude`'s env** (`ps -E`) | With the explicit env: no `ELECTRON_*`, no `AW_*`. Control h0 (no `env`): **`ELECTRON_RUN_AS_NODE=1` and `AW_HOST_ID` reached `claude`**, as §11.6 predicted. Also inherited either way, and worth stripping: `__CFBundleIdentifier=<app id>` and `XPC_SERVICE_NAME=application.<app id>.<n>.<n>` (both from the LaunchServices launch). |
| **Host RSS** | **22–64 MB.** About 58–64 MB in the first minutes after spawn and a first turn. It falls to 22–31 MB at idle once macOS compresses the idle pages (h1 over 50 min). Heap used is about 7 MB. For comparison: `claude` 140–355 MB, core (one tiny window) 100–150 MB. §5.3's estimate of ~40–70 MB holds as an upper bound. |

## 3. Decisions

### 3.1 Host runtime location: **cloned runtime**, for different reasons than §11.7 gives

Spawn hosts from `runtimes/<buildId>/<Name> Host.app` (`cp -c -R` + rename, 89 ms, close to no
disk). No re-sign, and no Info.plist edit.

Why. The measurement **contradicts §11.7's first reason**. The control host running from the
installed bundle **also survived `rm -rf` + `cp -R`**: deleted files stay mapped and open
through their inodes. The clone is still right, for these reasons:

1. **Name and path matching.** The uncloned host matched `pgrep -f <bundle exe path>` and
   `pgrep -x <exe name>`, which are the install script's guard and the `killall` pattern. The
   cloned host matched neither.
2. **Lazy loads.** A host lives for days. Anything it opens from its bundle after a
   `rm -rf` (a new asar read, a helper binary, a framework resource not yet mapped) fails on
   the uncloned path. The clone removes the whole class of failure. Not observed failing;
   it is a risk only.
3. **Stable identity.** The clone keeps the build's cdhash, which is the identity TCC used
   once the core was gone (§2).

Keep the playbook's "RunAsNode fuse must stay enabled" note.

### 3.2 Host-token storage: **0600 file in the 0700 `run/` dir, not safeStorage**

The measurement **contradicts §12** ("Stored in safeStorage"). Every `app:install` produces a
new ad-hoc cdhash, and the first safeStorage call after it **blocks the Electron main thread
on a Keychain dialog**. That happens during core startup, which is exactly when the core needs
the tokens to readopt hosts. It would happen several times a day.

- A 0600 token file next to the 0600 socket and manifest adds no exposure: any same-user
  process that can read it can already reach the socket, and §12 already concedes same-uid.
- Store the token in the manifest's sibling `<id>.token`, never in the manifest a person
  might paste.
- The host keeps its copy in memory only.

The same finding applies to the **existing Discord token** (`src/electron/secrets.ts`). Any
code path that reads it after an install prompts. Worth an issue: either accept "Always Allow"
per build, or move to a stable signing identity. A real (self-signed or Developer ID)
certificate would make the Keychain ACL and TCC grants survive rebuilds, and would remove the
13.5 s TCC re-evaluation as well.

### 3.3 Quit-source detection: **flag the sources we own; everything else is "external"**

Electron 44 exposes no reason. Detect it like this:

- **menu:** a custom `Quit` menu item with `accelerator: 'CmdOrCtrl+Q'` and a `click` that
  sets `quitSource = 'menu'` before `app.quit()`. Do **not** use `role: 'quit'`, which
  bypasses the handler.
- **signal:** `process.on('SIGTERM', …)` installed **inside `whenReady`**. Installed at module
  load it is silently replaced by Electron's handler (measured 4b vs 4c). It was measured
  installed 1 s after ready; installing it synchronously in the `whenReady` callback is
  untested.
- **external** = `before-quit` with no flag: `osascript` / Apple Event quit, Dock → Quit,
  logout, shutdown.
- **install:** don't infer it. Have `install-app.sh` announce itself before quitting, for
  example by writing `run/quit-intent` (or a core-socket `quit {reason:'install'}` once the
  Stage 8 socket exists), then send the Apple Event as today.
- **logout vs osascript:** `powerMonitor` `'shutdown'` (darwin) is documented to fire before
  shutdown or reboot, and is expected to precede `before-quit` on logout. Unverified; see the
  §6 manual procedure.

Because hosts are detached, **no quit source kills a hosted session**. The source only decides
UI: whether to show "N agents keep running" on a menu quit. It is not a survival question.

## 4. Contradictions with the playbook (loud)

1. **§12 "Stored in safeStorage": do not.** It blocks core startup on a Keychain dialog after
   every rebuild (§3.2). Use a 0600 file.
2. **§11.10 / U4, SIGTERM:** Electron already converts SIGTERM into a graceful quit that runs
   `before-quit`. A `process.on('SIGTERM')` added at the top of `main.ts` **never fires**. The
   current `before-quit` teardown therefore also runs on SIGTERM, and §1.3's "no
   `process.on('SIGTERM')`" is not a gap in itself.
3. **§11.7, the clone's rationale:** `rm -rf` of the bundle does **not** kill an uncloned host.
   Keep the clone, for name matching, lazy loads and a stable identity (§3.1).
4. **§11.7, "renamed executable still runs with the ad-hoc signature":** true at runtime, but
   the clone **fails `codesign --verify`**. Nothing may verify the runtime bundle statically
   (for example as a GC or health check); check the exe's cdhash instead.
5. **§11.6 env:** also strip `__CFBundleIdentifier` and `XPC_SERVICE_NAME`, not only
   `ELECTRON_*` and `AW_*`.

§11.6's CLOEXEC claim, §11.10's detached/setsid, reparent-to-launchd and no-SIGHUP facts, and
§5.3's RSS estimate were all confirmed.

## 5. Not measured / residual risk

- A real keyboard ⌘Q and a real menu click; Dock → Quit. Sending synthetic input needs
  Accessibility, and a stray ⌘Q would land on whatever app is frontmost, possibly the real
  Agent Wrangler, so it was not attempted.
- `claude` behaviour mid-tool or mid-ask when its host dies (S1).
- Whether TCC keys the core's grant on the cdhash (it looks that way: 13.5 s), which would
  mean every install re-asks for `~/Documents`.

## 6. Manual procedures for James (pending)

Use the spike app only. Build it from this branch: `node --no-warnings spikes/s2/build.ts m1`,
copy `spikes/s2/out/mac-arm64/AW Spike S2.app` to `/tmp/aw-spike-s2/apps/`, and
`open -g` it. Then:

```
node --no-warnings spikes/s2/drive.ts core '{"method":"spawnHost","params":{"id":"m1"}}'
node --no-warnings spikes/s2/drive.ts check m1
```

**M1 — real ⌘Q and Dock Quit.** Click the AW Spike S2 window, press ⌘Q, then run
`grep before-quit /tmp/aw-spike-s2/logs/core.log | tail -1`. Expect `source=menu`. Relaunch,
right-click its Dock icon → Quit, and grep again: expect `UNFLAGGED`. Run `check m1` after
each; expect `pong`.

**M2 — sleep/wake.** With m1 running, run
`node --no-warnings spikes/s2/drive.ts host m1 '{"method":"timers","params":{"reset":true}}'`.
Apple menu → Sleep, wait 2 minutes, wake. Then:

- `check m1`: expect `pong`;
- `grep powerMonitor /tmp/aw-spike-s2/logs/core.log`: expect `suspend` and `resume`;
- `drive.ts host m1 '{"method":"timers"}'`: `maxMs` ≈ the sleep length, which proves the host
  was suspended rather than killed.

Also try it with a long turn in flight (`"text":"Count slowly from 1 to 200, one per line"`)
and note whether the turn finishes after wake.

**M3 — logout (once, expect death).** With m1 running and the core open, log out and log back
in. Then:

- `tail /tmp/aw-spike-s2/logs/host-m1.log`: expect `graceful exit (SIGTERM)` and
  `claude exited after N ms`;
- `grep -E "powerMonitor shutdown|before-quit" /tmp/aw-spike-s2/logs/core.log | tail -2`:
  records whether `shutdown` precedes `before-quit`, which is the logout-vs-osascript
  discriminator;
- `ls ~/.claude/sessions/` for a leftover `<claudePid>.json` (an orphan).

Note that logout also quits the real Agent Wrangler.

**M4 — TCC dialog check.** Did an "AW Spike S2 would like to access files in your
Documents/Desktop/Downloads folder" dialog appear on 2026-09-24 at about 14:50 or 15:35 UTC?
If one did, the cdhash-keyed TCC hypothesis stands (§5).

Cleanup after the manual runs:

- `node --no-warnings spikes/s2/drive.ts host m1 '{"method":"shutdown"}'`;
- quit the spike app by bundle id;
- `rm -rf /tmp/aw-spike-s2`;
- `tccutil reset All com.hammonjj.agentwrangler.spike-s2`.

## 7. Cleanup done

- Every spike process was ended by exact pid or bundle-id `osascript`, and `ps` confirmed none
  remain. That covers the three hosts (SIGTERM, graceful), their three `claude` children and
  the spike core with its helpers. `~/.claude/sessions` held no leftover entries for the
  spike's `claude` pids.
- Deleted:
  - `/tmp/aw-spike-s2`;
  - `~/Documents/aw-spike-s2`;
  - the two spike transcript dirs under `~/.claude/projects/`;
  - the spike crash report in `~/Library/Logs/DiagnosticReports`;
  - the spike's preferences plist;
  - the worktree's `spikes/s2/{out,dist}`.
- TCC: `tccutil reset All com.hammonjj.agentwrangler.spike-s2`.
- **Left in place:** the Keychain item `AW Spike S2 Safe Storage` (account `AW Spike S2 Key`).
  Deleting it could itself raise a prompt. To remove it:
  `security delete-generic-password -s "AW Spike S2 Safe Storage"`. If a Keychain dialog
  naming AW Spike S2 is still on screen, click Deny.
- The real app: `/Applications/Agent Wrangler.app` was never read, run or written by the
  spike. Its bundle mtime (14:41 UTC) is earlier than the spike's first launch. The real
  app's own log shows it quit gracefully at 15:44:16 UTC and restarted 5 s later (pid
  5871 → 19890). That was outside this spike: every signal the spike sent went to a pid
  checked against the spike's own logs, `lsappinfo` or its bundle id, and every `osascript`
  targeted the spike's bundle id.

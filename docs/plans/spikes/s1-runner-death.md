# Spike S1: what happens to a Claude runner when the process holding it dies

Issue #5 · playbook `docs/plans/session-lifecycle-architecture.md` §1.3, §5.1, §7.3, §11, §19 (U1, U2).
Measured 2026-09-24. The harness is on branch `spike/s1-runner-death` under `spikes/s1/` and is not merged.

## TL;DR

- **Orphans are real, and they keep working.** When the holder dies without running the SDK's
  `process.on('exit')` handler (SIGKILL, Node's default SIGTERM, a crash), `claude` is reparented
  to launchd within about 55 ms. It does **not** exit on stdin EOF until its **current turn
  ends**. At idle it exits in about 0.7 s. Mid-stream it finishes the reply (about 19 s). Mid-ask,
  the ask fails and the model carries on for 6–14 s. Mid-Bash, it waits out the whole 120 s
  command and then runs another model call.
  **§11.5 is confirmed, and the reality is worse than it says:** the orphan is not stuck on
  EPIPE. It runs the rest of the turn, including tools that need no permission.
- **Every orphan exited on its own** once the turn was over, removed its `sessions/<pid>.json`,
  and ran `SessionEnd`. None lived indefinitely. Its lifetime is "the rest of the turn", which has
  no upper bound in principle (long tools, long agentic turns under `acceptEdits` or `bypass`).
- **The CLI has no single-owner lock.** A second `Query` with `resume: <id>` succeeds while the
  first CLI is still alive. Both append to the same transcript, which **silently forks**: two
  entries end up with the same `parentUuid`, and neither process sees the other's turn. **The
  §7.3 orphan sweep is the only guard.** It is sufficient, but only with the amendments in
  "Verdicts".
- **uuid dedupe works.** SDK `assistant` and `user` message uuids are the transcript entry uuids.
  A `uuid` the host sets on an `SDKUserMessage` it sends is kept as that entry's transcript uuid.
- **stdin EOF during a pending `can_use_tool` resolves at once, as a tool error.** It does not
  hang and it does not end the turn. The model continues, and every later permission check fails
  instantly without reaching `canUseTool`.
- **§1.3 needs one correction:** stdin EOF is a backstop only at idle, not mid-turn.
  Contradictions are flagged below.

## Setup

- `@anthropic-ai/claude-agent-sdk` 0.3.268, driving its bundled binary
  `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (2.1.268).
- The SDK is used the way `RunnerSession.start` uses it: a streaming-input `query`, a
  `canUseTool`, `includePartialMessages`, and `pathToClaudeCodeExecutable`. The model is `haiku`,
  in the default permission mode, running in a scratch project `/tmp/aw-spike-s1/proj`.
- **The holder** (`holder.ts`) is a plain Node process standing in for the future host. It is
  spawned `detached` by the driver and gets the agent into the target state before it is hit.
  - `SIGKILL` and `SIGTERM` are left at Node's defaults. So SIGTERM kills the holder **without**
    running `process.on('exit')`, exactly like SIGKILL, and the rows confirm it.
  - "clean" means the holder calls `process.exit(0)`. That runs the SDK's exit handler, which
    SIGTERMs the child.
- **The `eof*` modes** keep the holder alive and still reading stdout, and end the child's stdin
  directly. Their child is spawned through `spawnClaudeCodeProcess`, which mirrors the SDK's own
  spawn.
- **Deviations from production:**
  - `settingSources: []`, with a scratch `Stop`/`SessionEnd` hook in place of the user hook set,
    so the spike never talked to the running app;
  - the claude env is stripped of `CLAUDE*`;
  - no `PermissionRequest` hook (see open item 1).
- **Recorded for each case:**
  - the exit time of every pid in the holder's tree;
  - the ppid transitions;
  - `~/.claude/sessions/<pid>.json` before, during (sampled) and after;
  - transcript integrity (every line parses, and the file ends in a newline) and the lines added
    after the hit;
  - hook events;
  - the shape of the transcript after the hit.

## Results

Times are ms after the hit. "Orphan" means `ppid` became 1. "Tx intact" means every line parsed
and the file ended with a newline. "+N lines" counts transcript lines written after the hit.
Every cell below was run at least once with the agent verifiably in the named state. Cells
marked ×2 were repeated and agreed within a few hundred ms. Runs whose setup failed (haiku
answered the streaming prompt with a tool; the CLI blocked `sleep 120 && …` and the model
backgrounded it) are excluded.

| Agent state | Hit | `claude` exits | Orphan | Shells | Transcript after the hit | `sessions/<pid>.json` | `SessionEnd` |
|---|---|---|---|---|---|---|---|
| idle | SIGKILL ×2 | +684 / +721 | yes, +55 | n/a | intact, +0 lines | present → removed | yes |
| idle | SIGTERM | +736 | yes, +61 | n/a | intact, +0 | removed | yes |
| idle | clean ×3 | +682…+757 | yes, +56 (holder gone first) | n/a | intact, +0 | removed | yes |
| streaming | SIGKILL | +19 359 | yes, +61 | n/a | intact, +4: **the full reply (10 k chars) written ~17 s after the hit** | present at 1/5/15 s → removed | yes |
| streaming | SIGTERM ×2 | +19 205 / +19 759 | yes, +55 | n/a | intact, +4–6: full reply | present → removed | yes |
| streaming | clean | +2 731 | yes | n/a | intact, +1: **the in-flight assistant message is lost** (the SDK had yielded its thinking block; the transcript never got it) | removed | yes |
| pending ask | SIGKILL ×2 | +8 828 / +14 410 | yes, +55 | n/a | intact, +20–22: ask → `tool_result` error "Tool permission request failed: AbortError: Tool permission stream closed before response"; **the model retried Bash 1–2×** (instant "Stream closed" errors), then ended the turn | present at 1/5 s → removed | yes |
| pending ask | SIGTERM | +6 047 | yes, +57 | n/a | intact, +12: same, 0 retries | removed | yes |
| pending ask | clean | +693 | yes | n/a | intact, +1: turn cut; `tool_use` left without a `tool_result` | removed | yes |
| 120 s fg Bash | SIGKILL ×2 | +120 931 / +121 264 | yes, +55 | **the command ran to natural completion** (+116.7 s) | intact, +12: `tool_result` (success) then a new model call and a final answer | present at 1/5/15/60/110 s → removed | yes |
| 120 s fg Bash | SIGTERM | +121 197 | yes, +59 | ran to completion (+116.6 s) | intact, +12: same | removed | yes |
| 120 s fg Bash | clean | +2 739 | yes | **killed at once** (+54); `tool_result` "Exit code 137" | intact, +9 | removed | yes |
| `run_in_background` shell (idle) | SIGKILL ×2 | +7 833 / +8 163 | yes, +55 | **killed by the CLI at ~+5.1 s** | intact, +1 | present at 1/5 s → removed | yes |
| `run_in_background` shell (idle) | SIGTERM | +7 757 | yes, +58 | killed at +5.1 s | intact, +1 | removed | yes |
| `run_in_background` shell (idle) | clean | +2 729 | yes | **killed at once** (+56) | intact, +2 | removed | yes |
| pending ask | stdin EOF only (holder alive) | +5 544 after EOF | no | n/a | intact, +16: same as SIGKILL; the host kept receiving the stream through to `result/success` | removed | yes |
| 120 s fg Bash | stdin EOF only | +119 194 | no | ran to completion | intact, +12 | removed | yes |
| bg shell (idle) | stdin EOF only | +5 700 after EOF | no | killed ~5.1 s after EOF (the SDK saw `task_updated` + `task_notification`) | intact, +1 | removed | yes |
| fg Bash, orphaned | SIGKILL holder, then **SIGTERM the orphan at +5 s** (a §7.3 sweep) | +7 793 (2.8 s after the sweep) | yes | killed at the sweep (+5 079) | intact, +9 | present → removed | yes |
| pending ask, orphaned | same sweep | +7 738 (2.7 s after the sweep) | yes | n/a | intact, +19 (the orphan had kept retrying until the sweep) | present → removed | yes |

**An incidental run shows orphans take new turns.** In one excluded run the "bash" case had
turned into a background `sleep 120`. That sleep finished about 4 s after the holder was killed,
inside the bg-shell grace window. The orphaned CLI injected the task notification as a user
turn, **ran a new model turn with an auto-allowed `Read`**, and exited 10 s after the hit.

**Other observations:**

- **Transcript integrity.** Across all ~35 runs, no line was torn. Every line parsed, and every
  file ended in a newline, including SIGTERM mid-stream. The damage is **semantic, not
  syntactic**:
  - an in-flight assistant message is dropped on SIGTERM;
  - a `tool_use` is left without its `tool_result`;
  - an orphan's post-death work lands in the transcript, and no client ever saw it.
- **`sessions/<pid>.json`** exists for the orphan's whole life (sampled up to 110 s). It is removed
  on every exit seen here, including a SIGTERM sweep. The CLI itself was never SIGKILLed or
  OOM-killed in these runs, so a stale file left by a dead pid was not observed, but it has to be
  expected.
  - The file carries `procStart` (the same format as `ps -o lstart`, but in UTC), which a
    start-time check can match.
  - It also carries `messagingSocketPath` (`/tmp/cc-socks/<pid>.sock`), a CLI peer-messaging
    socket. This spike did not probe it.
- **SIGTERM to the CLI is prompt in every state:** 0.7 s idle, about 2.7–2.8 s busy. It kills
  foreground and background shells at once, and `SessionEnd` runs.
- **stdin EOF with a background shell at idle:** the CLI waits a fixed ~5 s, then kills the
  shell, then exits about 3 s later. A shell that finishes inside those ~5 s triggers a model
  turn first.

## Confirmations

1. **A new SDK `Query` cannot attach to a running CLI.**
   - `Options` has nothing that connects to an existing process. `spawnClaudeCodeProcess` is a
     spawn hook: the SDK still sends `initialize` and passes fresh args. `bridge` is the claude.ai
     CCR transport.
   - The only thing a second `Query` can do is `resume: <id>`. Measured with holder A idle on
     session S and holder B running `resume: S`:
     - B's CLI started, got `init` with `session_id` S, answered, and stayed alive alongside A.
     - Both `sessions/<pid>.json` files named S.
     - A then took another turn, and the transcript **forked**: B's turn and A's next turn both
       hang off the same parent entry.
   - There is **no lock and no error**. The `spawnClaudeCodeProcess` relay stays ruled out
     (§11.3), and a double owner is a silent conversation fork, not a crash.
2. **SDK uuids match transcript uuids (U2).** Joined over every run:

   | SDK message | Seen | uuid in the transcript |
   |---|---|---|
   | `assistant` | 83 | 82 (the miss is the message SIGTERM dropped mid-stream, above) |
   | `user` (tool results, task notifications) | 17 | 17 |
   | a host send with `uuid` set on the `SDKUserMessage` | 1 | 1: the CLI keeps the caller's uuid |
   | `stream_event`, `system/*` (init, status, thinking_tokens, task_*), `result`, `rate_limit_event` | 2 300+ | 0: ephemeral, never in the transcript |

   The transcript also holds many entries that never appear on the SDK stream: attachments,
   `ai-title`/`last-prompt`/`atis-latch` rows, the user's own prompts when sent without a uuid,
   and whatever an orphan wrote.
3. **`sessionId` works for fresh sessions.** In every fresh run (about 30) the `init` `session_id`, the
   `sessions/<pid>.json` `sessionId` and the transcript filename all equalled the uuid that was
   passed in.
   - A fresh `sessionId` that already has a transcript is refused: `Error: Session ID … is
     already in use.`, exit 1 within about 350 ms. That happens **even after every process on it
     has exited**, so the check is on whether a transcript exists, not on whether a process is
     alive. Fresh ids must really be fresh. Continuing an id is always `resume`.

## The open question: stdin EOF during a pending `can_use_tool`

**It resolves at once. It neither hangs nor ends the turn.**

- Within about 5 ms of EOF, the pending ask becomes (when the holder was killed instead, the
  transcript shows it about 0.3 s after the kill) a `tool_result` with `is_error` and the message
  "Tool permission request failed: AbortError: Tool permission stream closed before response".
- The model then continues the turn. Each later tool that needs permission fails instantly
  ("…AbortError: Stream closed"), and `canUseTool` is never called for it. Auto-allowed tools
  would run.
- The turn ends with `result/success`, and the CLI exits about 0.7 s later with code 0.
- On the host side, the `canUseTool` `AbortSignal` fired **only when the child exited**, about
  5 s after EOF. It does not fire at EOF.

In effect, EOF works as a deny, though the model is not told it was a deny and may retry.

## Verdicts

**Orphan risk (U1): confirmed, and bounded by the turn, not by EOF.**

- A host that dies by SIGKILL, crash, OOM, or a SIGTERM it does not handle leaves `claude`
  running as a launchd orphan for the rest of its turn:
  - it holds the session id;
  - it writes to the transcript;
  - it spends tokens;
  - it runs every auto-allowed tool, and in `acceptEdits` or bypass mode that includes edits and
    Bash;
  - background-task completions inside the ~5 s grace start new turns.
- It then exits cleanly on its own. The practical worst case is a long foreground tool or a
  long permission-free agentic turn.

**Is the §7.3 orphan sweep sufficient? Yes, with four amendments.** The mechanism works: find the
entry by `sessionId`, check the pid is alive, SIGTERM it. The orphan died 2.7–2.8 s after SIGTERM
in every busy state, and its shells died at once. The amendments:

1. **Sweep before every resume or adopt of an id, not only in the startup "host dead, no exit
   record" path.** The CLI never refuses a second owner (Confirmation 1), so the sweep is the
   only guard. That includes a host that dies while the core is up (the supervisor sees the exit
   → `lost` → sweep → then offer Resume), `resumeLastRunner`, and `adoptAndSend` migration.
2. **Wait for the exit before resuming.**
   - SIGTERM, then poll for about 5 s, then escalate to SIGKILL, then re-read the transcript.
     Until the orphan is gone it may still be writing.
   - Loading history before the sweep completes misses the orphan's tail. The tail is legitimate
     conversation, and resuming after it is correct.
3. **Check identity with `procStart`** from `sessions/<pid>.json` against the pid's start time.
   Also tolerate a stale file for a dead pid: none was observed, but a SIGKILLed or OOM'd CLI
   cannot clean up.
4. **The host should handle SIGTERM** by SIGTERMing its `claude` and then exiting. The SDK
   installs no SIGTERM handler, and Node's default skips `process.on('exit')`. This makes logout
   and `kill <host>` produce the prompt "clean" row instead of an orphan. It cannot cover SIGKILL
   or a crash, so the sweep stays mandatory.

A host-side watchdog (a kqueue `NOTE_EXIT` on the host from a third process) is not worth it.
Orphans end on their own, and the sweep catches the rest.

**uuid dedupe (U2): confirmed.**

- The §5.1 reattach rule works as written: the transcript, plus the ring messages whose uuid is
  **not** in the transcript, plus the pending asks. It only works in that one direction; the
  transcript has many entries the stream never carries.
- **Refinements:**
  - **Only `assistant` and `user` messages dedupe by uuid.** `stream_event`, `system/*` and
    `result` never reach the transcript, so the ring treats them as ring-only, ordered by `seq`.
  - **Stdout can run ahead of the transcript,** and a message can be yielded but never persisted
    (SIGTERM mid-stream). The ring must not assume "yielded ⇒ on disk".
  - **Set `uuid` on every host send** so the host's own user messages dedupe too.

## Contradictions with the playbook

- **§1.3 (and §11.5): "the backstop is the SDK's exit handler … plus stdin EOF when the parent's
  pipe ends close." Only half true.**
  - stdin EOF is a backstop **only at idle**. Mid-turn, EOF lets the turn run to completion:
    about 19 s for a stream, the full 120 s for a Bash command, plus a follow-up model call.
  - The SDK exit handler is the only prompt path. Any AW exit that bypasses `process.on('exit')`
    leaves the current turn running headless. Today that is a crash or SIGKILL of Electron main;
    whether Electron's SIGTERM runs it is S2's question.
- **§11.5: "An EPIPE on stdout does not guarantee an exit" understates the risk.**
  - The orphan is not wedged on EPIPE. It keeps doing real work, including auto-allowed tool
    calls and new turns started by background tasks. That work lands in the transcript, and no
    UI ever showed it.
  - The design conclusion ("§7.3's orphan sweep … is mandatory") stands, strengthened by amendments
    1–4 above.
- **§7.3 step 2 scopes the sweep to startup "host dead, no exit record". Too narrow.** It must
  precede every resume or adopt of an id (amendment 1), because the CLI allows two live owners and
  forks the transcript silently.
- **§7.4: "Ending the CLI kills its `run_in_background` shells." Confirmed**, and the way the CLI
  ends matters:
  - SIGTERM kills the shells at once;
  - stdin EOF waits about 5 s first, and a shell that finishes in that window starts a turn.
  - So a migration should end with `interrupt` or SIGTERM, not just by closing stdin.
- **No contradiction** with §11.2/§11.3 (no reattach to stdio; the `Query` must live in the
  host) or with §5.1's uuid plan.

## Open items (not measured here)

1. **The `PermissionRequest` hook.** Production users have AW's `PermissionRequest` hook
   installed, with a 1800 s timeout. This spike ran without it.
   - If that hook fires for SDK-runner asks, a mid-ask orphan might wait on the hook for up to
     30 min instead of failing the ask at once, holding the session the whole time.
   - This is worth a short follow-up before Stage 3. It also decides whether hosts must run with
     that hook disabled.
2. **The `messagingSocketPath` peer socket** in `sessions/<pid>.json`. Not probed. Nothing
   suggests it carries stream-json or `can_use_tool`, but it is the one CLI-side channel this
   spike did not rule out.
3. **A stale `sessions/<pid>.json` after the CLI itself is SIGKILLed or OOM'd.** Expected, not
   observed. The sweep's pid and `procStart` check handles it.
4. **Single model (haiku), one CLI version.** Timings such as the ~5 s bg-shell grace and the
   ~2.7 s busy SIGTERM exit are version-coupled. `hello` should report `cliVersion` (§19,
   standing risks).

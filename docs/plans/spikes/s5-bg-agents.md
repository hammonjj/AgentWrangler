# Spike S5 — can Claude background agents replace the AW Claude host?

Issue: hammonjj/AgentWrangler#9. Playbook refs: §5, §11 item 9 (U8), §19.
Date: 2026-09-24. Timebox: half a day.

## Verdict

**No.** `claude --bg` background agents are a PTY-hosted, headless-terminal
feature, not a structured-I/O one. There is no stream-json + `canUseTool`
surface for them: `--bg` and `--print` (the only mode that supports
`--output-format stream-json` / `--input-format stream-json`) are mutually
exclusive at the CLI's own argument-parsing level. `claude logs <id>` and
`claude attach <id>` both replay raw terminal bytes (ANSI cursor/color escapes
and box-drawing glyphs), not JSON. This matches §11 item 9's framing exactly:
the feature exists, but it does not offer the protocol the thin-host design
in §5 needs. The provider-shaped host abstraction in §5 stays correct as
written — Claude gets a per-session host that speaks the SDK's own
stream-json protocol over stdio, not a wrapper around `claude --bg`.

## Method

Own worktree `../AgentWrangler-spike-s5` (branch `spike/s5-bg-agents`), binary
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (SDK-bundled,
**v2.1.268** — the system `/opt/homebrew/bin/claude` on this machine is
**v2.1.236**; the two are not interchangeable for this kind of probing since
CLI flags/behaviour change between them). All agents launched from
`/tmp/aw-spike-s5/proj`, model `haiku` (cheapest), tiny one-line prompts.
Identified "mine" strictly by `cwd` starting with `/tmp/aw-spike-s5` and by
the `id`s this session printed; every other row `claude agents --json` listed
(6 of James's live interactive sessions) was left untouched. Throwaway probe
script: `spikes/s5/probe.sh`.

## Evidence

**1. Which process hosts a bg agent — a three-level tree, not one process.**

```
claude daemon run --origin transient --spawned-by {...}   (ppid=1 / launchd)
  └─ claude bg-pty-host --bg-pty-host <dir>/<id>.pty.sock 200 50 -- ...
       └─ claude --bg-spare <dir>/<id>.claim.sock     (the actual agent)
            ├─ (its own MCP servers, e.g. project-configured ones)
            └─ caffeinate -i -t 300
```

The daemon is a per-user singleton at `/tmp/cc-daemon-501/<hash>/`, holding a
`control.sock`, a `pty/` dir and a `spare/` dir of pre-warmed pty hosts. It is
not one-process-per-agent; multiple `--bg` sessions share the daemon, each
agent gets its own `bg-pty-host` (which owns the pty) and `bg-spare`
(the CLI loop). This is heavier and more layered than the design in §5,
which is one thin host process per Claude session.

**2. Survival past its launcher — yes.**

The `claude --bg ...` invocation itself exits immediately after printing the
id (this is the point of `--bg`). Its pid (captured from the daemon's
`--spawned-by` json) was confirmed gone from `ps` seconds later, while the
daemon (`ppid=1`) and the agent process kept running. So a bg agent does
survive its own launching process — same property §11.9 says the design
needs — but it inherits that from the daemon, not from anything AW would
control (AW does not own `/tmp/cc-daemon-501`, its lifetime, or its version).

**3. Structured I/O — no.**

- `--bg` and `--print`/`--output-format stream-json` are mutually exclusive;
  the CLI's own error says so: *"--bg and --print conflict: --print never
  starts the interactive session that `claude agents` attaches to."*
- `claude logs <id>` output is raw terminal bytes: `\x1b7`, `\x1b8`,
  `\x1b[2J`, 24-bit-color SGR sequences, and UTF-8 box-drawing glyphs
  (▛█▜▝ etc. rendering the "Claude Code" banner) — a captured terminal
  screen, not a message log.
- `claude attach <id>` documents itself as "open the background session in
  this terminal" — a PTY reattach for a human, not a machine channel.
- Direct probes of the agent's own sockets
  (`/tmp/cc-daemon-501/<hash>/rv/<id>.sock`, `/tmp/cc-socks/<pid>.sock`)
  got no response to a bare newline or a hand-written JSON-RPC `hello` —
  consistent with an internal/undocumented protocol, not something AW could
  build against without reverse-engineering and re-verifying on every CLI
  update (exactly the risk §11.3 already rejected for the `spawnClaudeCodeProcess`
  relay).

**4. Permission prompts and questions — hook-driven, same as today; no
`canUseTool` equivalent.**

A `default`-permission-mode bg agent asked to delete a file blocked for real:
`claude agents --json` showed `"status":"waiting","waitingFor":"permission
prompt","state":"blocked"` and stayed there across repeated polls. The only
way found to resolve it programmatically was the **existing PreToolUse /
PermissionRequest hook path** — this machine's already-installed AW hook
auto-resolved the prompt, and the replayed terminal log showed `⎿ Allowed by
PermissionRequest hook`. That confirms hooks fire for bg agents exactly as
they do for interactive ones (useful — it's the same side channel §11.9
already assumes AW would keep using), but it is **not** the SDK's structured
`canUseTool` callback: there is no equivalent to receiving `{requestId,
toolName, input, suggestions}` and answering with a `PermissionResult` over a
documented channel. Answering "for real" (not via the hook) means either the
hook trick or literally opening a PTY with `attach` and driving a human-style
TUI (arrow keys / `1`/`2`/`3` menu choices), which is what §11.1 already rules
out ("do not introduce PTYs").

## Why this doesn't change §5

§5's host design was chosen because the `Query` (the SDK's own client object:
handshake state, `can_use_tool` request ids and resolvers, hook callbacks)
has to live somewhere that survives the core, and stdio to a `claude -p
--input-format stream-json --output-format stream-json` process is the one
channel that's documented, versioned, and already exchanged with `canUseTool`
today. `claude --bg` solves a related but different problem (detached
*interactive* sessions for a human to `attach` back into later) and gets
there via a heavier daemon/pty-host/spare-pool architecture with no
structured surface. Building on it would mean depending on undocumented
sockets and PTY byte-replay instead of the schema Anthropic already
publishes — worse than the `spawnClaudeCodeProcess` relay §11.3 rejected, not
better.

## Cleanup confirmation

All three probe agents (`67779809`, `f01824e4`, `4a93428b`) were `stop`ped
and `rm`'d; `claude agents --json` no longer lists any of them or any process
under `/tmp/aw-spike-s5`. `ps` shows no leftover `bg-pty-host`/`bg-spare`/
`claude daemon run` processes tied to this spike, and `/tmp/cc-daemon-501/`
cleaned itself up once idle. No agent belonging to James's real sessions was
stopped, attached, or messaged.

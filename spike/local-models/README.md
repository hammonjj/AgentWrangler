# Spike #50: local models behind Codex and Claude Code (never merged)

Throwaway experiment code for #50. The findings are in
`docs/plans/intelligent-orchestration.md` §19 on `main`. Nothing here ships.

Run on 2026-09-25: Apple M5 Pro, 24 GB. `mlx-lm` 0.31.3 (`mlx` 0.32.2) in a throwaway venv under
`/tmp`, serving MLX 4-bit Qwen models from a local folder on `127.0.0.1:18080`. Claude Code
2.1.236, Codex CLI 0.155.0-alpha.16.3. The venv, scratch repository and logs were deleted
afterwards.

- `probe.ts`: capability probe of an OpenAI-compatible server (listing, health, `/props`,
  `/slots`, `/metrics`, usage fields, streaming TTFT and tokens/s, tool calls, a tool round trip,
  `response_format: json_schema`, 4-way concurrency).
- `json-by-prompt.ts`: JSON by instruction only (no constrained decoding), validated.
- `shim.ts`: loopback translator. It serves Anthropic `/v1/messages` (Claude Code) and OpenAI
  `/v1/responses` (Codex) and forwards to `chat/completions`, calling upstream without streaming
  and replaying the reply as SSE. It logs sizes and outcomes only.

Harness runs (the scripts lived in `/tmp`):

- **Claude Code**: `CLAUDE_CONFIG_DIR=<tmp>`, `ANTHROPIC_BASE_URL=http://127.0.0.1:18090`,
  `ANTHROPIC_API_KEY=<dummy>`, `claude -p … --model local-model --permission-mode acceptEdits
  --allowedTools "Bash(node test.js)" Read Edit Write Glob Grep`.
- **Codex**: `CODEX_HOME=<tmp>`, `codex exec --json --sandbox workspace-write -c
  model_provider=aw50 -c 'model_providers.aw50={name="…",base_url="http://127.0.0.1:18090/v1",wire_api="responses"}'
  -m local-model`, optionally `-c model_catalog_json="<file>"`. The file holds one entry cloned
  from `codex debug models`' `gpt-5.4`, with `slug` changed, `context_window` set and
  `apply_patch_tool_type: "freeform"`.
- The task, in a scratch git repository: fix four seeded bugs in a two-function `stats.js` until
  `node test.js` prints `ok`, without editing the test.

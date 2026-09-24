/**
 * A scripted stand-in for the SDK's `query`, for process-level tests of the
 * session host (`AW_SESSION_HOST_FAKE=1`). No `claude` is spawned and nothing
 * costs anything. It answers each user message in the SDK's own message shapes:
 *
 * - any text: an `init` (first turn only), an assistant reply `echo: <text>`, a `result`;
 * - text containing `ask`: first asks permission for `Bash ls` through
 *   `canUseTool`, then says whether it was allowed;
 * - text containing `slow`: waits 2 s before replying, so a turn can be caught mid-flight.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanUseTool, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * A stand-in `claude` process for orphan tests (`AW_FAKE_CLAUDE_SESSIONS_DIR`
 * set as well as `AW_SESSION_HOST_FAKE`). It does nothing but stay alive, as a
 * mid-turn CLI does after its host dies: stdin EOF does not stop it. Its
 * `<pid>.json` is written in Claude Code's shape (`pid`, `sessionId`,
 * `procStart`) by the host, and removed by the process itself on SIGTERM, as
 * the real CLI removes its own; a SIGKILL leaves it behind, stale.
 */
export function spawnFakeAgent(
  dir: string,
  sessionId: string,
  startTimeOf: (pid: number) => string | undefined,
): ChildProcess {
  const script = [
    "const fs = require('fs');",
    "const file = require('path').join(process.argv[1], process.pid + '.json');",
    "process.on('SIGTERM', () => { try { fs.rmSync(file, { force: true }); } catch {} process.exit(0); });",
    "process.stdin.on('data', () => undefined);",
    "process.stdin.on('end', () => undefined);",
    'setInterval(() => undefined, 1000);',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['-e', script, dir], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1' },
  });
  if (child.pid) {
    fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId, procStart: startTimeOf(child.pid) }));
  }
  return child;
}

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query {
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const sessionId = options.resume ?? options.sessionId ?? randomUUID();
  const push = (m: unknown) => {
    out.push(m);
    wake?.();
    wake = undefined;
  };
  const finish = () => {
    done = true;
    wake?.();
    wake = undefined;
  };

  void (async () => {
    let turn = 0;
    for await (const msg of prompt) {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      if (turn++ === 0) push({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', permissionMode: 'default' });
      if (text.includes('slow')) await new Promise((r) => setTimeout(r, 2000));
      let reply = `echo: ${text}`;
      if (text.includes('ask')) {
        const canUseTool = options.canUseTool as CanUseTool | undefined;
        const decision = await canUseTool?.('Bash', { command: 'ls' }, {
          signal: new AbortController().signal,
          requestId: `fake-${turn}`,
          toolUseID: `toolu_fake_${turn}`,
        } as never);
        reply = decision?.behavior === 'allow' ? 'allowed' : 'denied';
      }
      push({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { id: `m${turn}`, role: 'assistant', model: 'fake', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' },
      });
      push({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sessionId, queued_turn_count: 0 });
    }
    finish();
  })();

  const stream = (async function* () {
    for (;;) {
      if (out.length > 0) {
        yield out.shift();
        continue;
      }
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  })();

  return Object.assign(stream, {
    interrupt: async () => undefined,
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    supportedModels: async () => [{ value: 'fake', displayName: 'Fake' }],
    supportedCommands: async () => [],
    getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1000 }),
    close: () => finish(),
  }) as unknown as Query;
}

/**
 * A scripted stand-in for the SDK's `query`, for process-level tests of the
 * session host (`AW_SESSION_HOST_FAKE=1`). No `claude` runs and nothing costs
 * anything, but there is a real agent process: when the host passes its
 * `spawnClaudeCodeProcess` (it always does), the fake spawns a dummy child
 * through it, exactly as the SDK spawns `claude`. So the host knows an agent
 * pid, the child gets the host's explicit environment, and killing, orphaning
 * and draining it are real (playbook §16, level I).
 *
 * The dummy child writes its environment to `agent-env-<pid>.json` in its cwd
 * (for the env-hygiene test), and takes one-line JSON commands on stdin. Like
 * the CLI, it exits on stdin EOF when idle and ignores EOF mid-turn until the
 * turn ends. What each user message does:
 *
 * - any text: an `init` (first turn only), an assistant reply `echo: <text>`, a `result`;
 * - `ask`: first asks permission for `Bash ls` through `canUseTool`, then says
 *   whether it was allowed (an interrupt aborts the ask: `denied`);
 * - `slow`: waits 2 s before replying (an interrupt cuts it short: `interrupted`);
 * - `hold`: a turn that lasts until an interrupt ends it (`interrupted`);
 * - `stubborn`: like `hold`, but the interrupt is ignored too; only SIGTERM ends it;
 * - `wedge`: like `stubborn`, and SIGTERM is ignored too; only SIGKILL ends it;
 * - `crash`: the child writes to stderr and exits with code 3, mid-turn;
 * - `flood:<count>:<bytes>`: the child writes `count` stream deltas of about
 *   `bytes` each to its stdout, honouring backpressure, then `flood done`. The
 *   host must drain the pipe at full speed however slow its clients are, so
 *   the flood finishes whether or not anyone is reading;
 * - `big:<bytes>`: a tool result of `bytes` characters, then `big done`;
 * - `policy?`: replies `policy: <json>`, the launch-policy SDK options this
 *   start was given (the launch-policy tests, #71).
 *
 * Every `result` echoes the message's `uuid` as `user_message_uuid(s)`, as the CLI does.
 *
 * A first message that starts with a simulation script (`<aw-sim>…</aw-sim>`,
 * the simulated harness's, #30) turns all of that off: every turn of the
 * session is played from the script by `simulatedAgent.ts`, and `crash` in
 * the script kills the dummy child, as above.
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { CanUseTool, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { readSimDirective, type SimAttempt } from '../shared/orchestration/simulation';
import { emptyTotals, playSimStep, simStepFor } from './simulatedAgent';

/** The dummy agent, run as `node -e`. Plain JS: it is a string. */
const DUMMY_AGENT = `
const fs = require('fs');
const path = require('path');
fs.writeFileSync(path.join(process.cwd(), 'agent-env-' + process.pid + '.json'), JSON.stringify(process.env), { mode: 0o600 });
let busy = false;
process.stdin.on('end', () => { if (!busy) process.exit(0); });
process.stdin.on('error', () => {});
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
async function flood(count, bytes) {
  const pad = 'x'.repeat(bytes);
  for (let n = 0; n < count; n++) {
    if (!out({ type: 'delta', n, text: pad })) await new Promise((r) => process.stdout.once('drain', r));
  }
  out({ type: 'flood-done', count });
}
function handle(c) {
  if (c.cmd === 'crash') { process.stderr.write('fake agent: boom\\n'); process.exit(3); }
  // Busy: a timer keeps it alive once stdin has closed, as a running tool keeps the CLI alive.
  if (c.cmd === 'hold') { if (!busy) busy = setInterval(() => {}, 60000); if (c.ignoreTerm) process.on('SIGTERM', () => {}); }
  if (c.cmd === 'release') { clearInterval(busy); busy = false; if (process.stdin.readableEnded) process.exit(0); }
  if (c.cmd === 'flood') void flood(c.count, c.bytes);
}
`;

/** The launch-policy options the agent was started with (`policy?`), and whether anything unsafe was set. */
function policyOptionsOf(options: Options): Record<string, unknown> {
  const keys = ['allowedTools', 'disallowedTools', 'maxTurns', 'maxBudgetUsd', 'fallbackModel', 'outputFormat', 'permissionMode', 'allowDangerouslySkipPermissions'] as const;
  return Object.fromEntries(keys.filter((k) => options[k] !== undefined).map((k) => [k, options[k]]));
}

/** After `close()`, how long before the fake SIGKILLs a child that ignored SIGTERM: the SDK's own escalation. */
const CLOSE_KILL_MS = 5000;

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query {
  const out: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  let closing = false;
  let inputEnded = false;
  const sessionId = options.resume ?? options.sessionId ?? randomUUID();
  const push = (m: unknown) => {
    out.push(m);
    wake?.();
    wake = undefined;
  };
  const finish = (err?: Error) => {
    if (done) return;
    done = true;
    failure = err;
    wake?.();
    wake = undefined;
  };

  // The agent process, spawned the way the SDK spawns `claude`.
  const abort = new AbortController();
  const child = options.spawnClaudeCodeProcess?.({
    command: process.execPath,
    args: ['-e', DUMMY_AGENT],
    cwd: options.cwd,
    env: options.env ?? {},
    signal: abort.signal,
  }) as unknown as ChildProcess | undefined;
  let childExited = !child;
  const exitWaiters: (() => void)[] = [];
  const toChild = (cmd: Record<string, unknown>) => {
    if (child && !childExited && child.stdin?.writable) child.stdin.write(`${JSON.stringify(cmd)}\n`);
  };
  let floodDone: (() => void) | undefined;
  if (child) {
    child.stdin?.on('error', () => undefined);
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line) as { type: string; n?: number; text?: string };
        if (m.type === 'delta') {
          push({
            type: 'stream_event',
            uuid: randomUUID(),
            session_id: sessionId,
            parent_tool_use_id: null,
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: m.text } },
          });
        } else if (m.type === 'flood-done') {
          floodDone?.();
        }
      }
    });
    // `close`, not `exit`: by then its stderr has been read, so the exit record's tail is complete.
    child.once('close', (code, signal) => {
      childExited = true;
      for (const w of exitWaiters.splice(0)) w();
      // An agent that dies when nobody asked it to is a failure, as the SDK reports it.
      if (closing || inputEnded) finish();
      else finish(new Error(`Claude Code process exited with code ${code ?? signal}`));
    });
  }
  const childGone = () => new Promise<void>((r) => (childExited ? r() : exitWaiters.push(r)));

  // The turn in flight: what an interrupt does to it.
  let onInterrupt: (() => void) | undefined;
  const interrupted = () => new Promise<'interrupted'>((r) => (onInterrupt = () => r('interrupted')));

  // Input is read on its own, as the SDK does: when it ends, the agent's stdin
  // is closed at once, mid-turn or not, and a busy agent is free to ignore it.
  const inbox: SDKUserMessage[] = [];
  let inboxWake: (() => void) | undefined;
  void (async () => {
    for await (const msg of prompt) {
      inbox.push(msg);
      inboxWake?.();
    }
    inputEnded = true;
    inboxWake?.();
    if (!child || childExited) finish();
    else child.stdin?.end();
  })();
  async function* messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (inbox.length > 0) {
        yield inbox.shift()!;
        continue;
      }
      if (inputEnded || childExited) return;
      await new Promise<void>((r) => (inboxWake = r));
      inboxWake = undefined;
    }
  }

  void (async () => {
    let turn = 0;
    let sim: SimAttempt | undefined;
    const simTotals = emptyTotals();
    for await (const msg of messages()) {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      if (turn++ === 0) {
        push({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake', permissionMode: 'default' });
        sim = readSimDirective(text)?.attempt;
      }
      // A scripted attempt (the simulated harness, #30): the scenario decides
      // every turn, and none of the keyword commands below apply.
      if (sim) {
        toChild({ cmd: 'hold' });
        const how = await playSimStep(
          simStepFor(sim, turn - 1),
          {
            cwd: options.cwd ?? process.cwd(),
            sessionId,
            model: options.model ?? 'claude-simulated',
            totals: simTotals,
            push,
            canUseTool: options.canUseTool as CanUseTool | undefined,
            interrupted: interrupted().then(() => undefined),
            crash: async () => {
              toChild({ cmd: 'crash' });
              await childGone();
            },
          },
          turn - 1,
        );
        onInterrupt = undefined;
        if (how === 'crashed') break;
        toChild({ cmd: 'release' });
        continue;
      }
      let reply = `echo: ${text}`;
      const flood = /flood:(\d+):(\d+)/.exec(text);
      const big = /big:(\d+)/.exec(text);
      if (text.includes('crash')) {
        toChild({ cmd: 'crash' });
        await childGone();
        break;
      }
      // Mid-turn, like the CLI, the agent ignores stdin EOF until the turn ends (spike S1).
      toChild({ cmd: 'hold', ignoreTerm: text.includes('wedge') });
      if (text.includes('stubborn') || text.includes('wedge')) {
        await childGone(); // ignores the interrupt: only a signal ends it
        break;
      } else if (text.includes('slow')) {
        const how = await Promise.race([interrupted(), sleep(2000)]);
        if (how === 'interrupted') reply = 'interrupted';
      } else if (text.includes('hold')) {
        await Promise.race([interrupted(), childGone()]);
        reply = 'interrupted';
      } else if (flood) {
        await Promise.race([
          new Promise<void>((r) => {
            floodDone = r;
            toChild({ cmd: 'flood', count: Number(flood[1]), bytes: Number(flood[2]) });
          }),
          childGone(),
        ]);
        reply = 'flood done';
      } else if (big) {
        const id = `toolu_big_${turn}`;
        push({
          type: 'assistant',
          uuid: randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          message: { id: `mb${turn}`, role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'cat big' } }] },
        });
        push({
          type: 'user',
          uuid: randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(Number(big[1])) }] },
        });
        reply = 'big done';
      } else if (text.startsWith('policy?')) {
        reply = `policy: ${JSON.stringify(policyOptionsOf(options))}`;
      }
      onInterrupt = undefined;
      if (text.includes('ask')) {
        // An interrupt aborts a pending ask, as the SDK does.
        const askAbort = new AbortController();
        onInterrupt = () => askAbort.abort();
        const canUseTool = options.canUseTool as CanUseTool | undefined;
        const decision = await canUseTool?.('Bash', { command: 'ls' }, {
          signal: askAbort.signal,
          requestId: `fake-${turn}`,
          toolUseID: `toolu_fake_${turn}`,
        } as never);
        onInterrupt = undefined;
        reply = decision?.behavior === 'allow' ? 'allowed' : 'denied';
      }
      toChild({ cmd: 'release' });
      push({
        type: 'assistant',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { id: `m${turn}`, role: 'assistant', model: 'fake', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' },
      });
      // The CLI echoes the client's message uuid on the turn's result; so does this.
      const uuid = (msg as { uuid?: unknown }).uuid;
      push({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: reply,
        session_id: sessionId,
        queued_turn_count: 0,
        ...(typeof uuid === 'string' ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}),
      });
    }
  })();

  const stream = (async function* () {
    for (;;) {
      if (out.length > 0) {
        yield out.shift();
        continue;
      }
      if (done) {
        if (failure) throw failure;
        return;
      }
      await new Promise<void>((r) => (wake = r));
    }
  })();

  return Object.assign(stream, {
    interrupt: async () => {
      onInterrupt?.();
    },
    setPermissionMode: async () => undefined,
    setModel: async () => undefined,
    supportedModels: async () => [{ value: 'fake', displayName: 'Fake' }],
    supportedCommands: async () => [],
    getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1000 }),
    // The SDK's close(): SIGTERM the agent (the host's spawn honours the abort), SIGKILL it 5 s later.
    close: () => {
      closing = true;
      if (!child || childExited) return finish();
      abort.abort();
      setTimeout(() => {
        if (!childExited) child.kill('SIGKILL');
      }, CLOSE_KILL_MS).unref();
    },
  }) as unknown as Query;
}

function sleep(ms: number): Promise<'slept'> {
  return new Promise((r) => setTimeout(() => r('slept'), ms));
}

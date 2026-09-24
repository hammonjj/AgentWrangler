/**
 * Spike S1 (#5): the process that holds a `claude` runner, playing the part of
 * the future session host. Throwaway; never merged.
 *
 *   node spikes/s1/holder.ts --mode <idle|stream|ask|bash|bg|eofask|eofbash|eofbg> \
 *        --out <dir> --cwd <dir> [--session <uuid>] [--resume <uuid>] [--prompt <text>]
 *
 * It drives the SDK the way `RunnerSession` does (streaming-input `query`, a
 * `canUseTool` callback, partial messages, `pathToClaudeCodeExecutable`), gets
 * the agent into the requested state, writes `READY` to <out>/events.jsonl and
 * then waits to be killed. Signals from the driver:
 *   SIGUSR2  clean exit: `process.exit(0)`, so the SDK's `process.on('exit')`
 *            handler runs (it SIGTERMs the child).
 *   SIGUSR1  push another user message ("Reply with just: again").
 *   SIGTERM / SIGKILL are left at Node's defaults on purpose.
 * The `eof*` modes keep the holder alive and instead end the child's stdin
 * directly once READY, so stdin EOF can be observed with stdout still read.
 */
import { query, type SDKUserMessage, type Options, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const mode = args.get('mode') ?? 'idle';
const out = args.get('out')!;
const cwd = args.get('cwd')!;
fs.mkdirSync(out, { recursive: true });
const eventsFile = path.join(out, 'events.jsonl');
const t0 = Date.now();

function ev(kind: string, extra: Record<string, unknown> = {}): void {
  fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now() - t0, at: Date.now(), kind, ...extra }) + '\n');
}

const binary = path.resolve(import.meta.dirname, '../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');

// The shell running this spike is itself inside Claude Code; its CLAUDE* vars
// must not reach the child (AW's runner does not have them either).
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^(CLAUDE|ANTHROPIC_|ELECTRON_|AW_|NODE_OPTIONS)/.test(k) || k === 'CLAUDECODE') continue;
  env[k] = v;
}

// ---- input queue, same shape as RunnerSession's InputQueue -----------------
const waiting: ((m: IteratorResult<SDKUserMessage>) => void)[] = [];
const buffered: SDKUserMessage[] = [];
let inputDone = false;
function push(text: string): void {
  // With --send-uuid on, every send carries a uuid, to test whether the CLI
  // keeps it for the transcript entry (dedupe of the host's own sends).
  const uuid = args.get('send-uuid') ? randomUUID() : undefined;
  const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...(uuid ? { uuid } : {}) } as SDKUserMessage;
  ev('send', { text, uuid });
  const w = waiting.shift();
  if (w) w({ value: msg, done: false });
  else buffered.push(msg);
}
const input: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]() {
    return {
      next(): Promise<IteratorResult<SDKUserMessage>> {
        const b = buffered.shift();
        if (b) return Promise.resolve({ value: b, done: false });
        if (inputDone) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => waiting.push(r));
      },
    };
  },
};

// ---- prompts per mode -------------------------------------------------------
const base = mode.replace(/^eof/, '');
const prompts: Record<string, string> = {
  idle: 'Reply with just: ok',
  stream: 'Write the whole numbers from one to five hundred as English words, one per line, nothing else.',
  ask: 'Use the Bash tool to run exactly this command and nothing else: touch spike-ask.txt',
  // Not `sleep 120 && …`: the CLI blocks a leading long `sleep` and the model
  // then backgrounds it, which turns this case into the bg case.
  bash: "Use the Bash tool in the foreground (run_in_background false) with timeout 300000 to run exactly this command and nothing else: perl -e 'sleep 120'; echo spike-done",
  bg: 'Use the Bash tool with run_in_background set to true to run exactly this command: sleep 600 . Do not wait for it. Then reply with just: started',
};
const prompt = args.get('prompt') ?? prompts[base];

let ready = false;
function markReady(why: string): void {
  if (ready) return;
  ready = true;
  ev('READY', { why });
  if (mode.startsWith('eof')) setTimeout(endStdin, base === 'ask' ? 1000 : 3000);
}

let child: ChildProcess | undefined;
function endStdin(): void {
  ev('end_stdin', { pid: child?.pid });
  child?.stdin?.end();
}

const canUseTool: CanUseTool = (toolName, toolInput, options) => {
  ev('can_use_tool', { toolName, input: toolInput, toolUseID: options.toolUseID });
  options.signal.addEventListener('abort', () => ev('can_use_tool_aborted', { toolUseID: options.toolUseID }));
  if (base === 'ask') {
    markReady('ask pending');
    return new Promise(() => { /* never answered */ });
  }
  if (base === 'bash') setTimeout(() => markReady('bash allowed + 3s'), 3000);
  return Promise.resolve({ behavior: 'allow', updatedInput: toolInput });
};

const options: Options = {
  cwd,
  model: 'haiku',
  permissionMode: 'default',
  pathToClaudeCodeExecutable: binary,
  canUseTool,
  includePartialMessages: true,
  env,
  // Isolation: James's user settings carry AW's hooks, which would talk to the
  // live app. A SessionEnd/Stop hook to a scratch dir stands in for them so any
  // shutdown-time hook cost is still paid.
  settingSources: [],
  settings: {
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: `cat >> "${out}/hook-$PPID.jsonl"`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `cat >> "${out}/hook-$PPID.jsonl"`, timeout: 5 }] }],
    },
  } as Options['settings'],
  stderr: (d) => ev('stderr', { d: d.slice(0, 500) }),
};
// Streaming case: no tools, or haiku writes the list to a file instead.
if (base === 'stream') options.tools = [];
if (args.get('session')) options.sessionId = args.get('session');
if (args.get('resume')) options.resume = args.get('resume');
if (mode.startsWith('eof')) {
  // Same spawn the SDK's local transport does, but we keep the handle so the
  // test can end stdin itself.
  options.spawnClaudeCodeProcess = (o) => {
    child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr?.on('data', (d) => ev('stderr', { d: String(d).slice(0, 500) }));
    child.on('exit', (code, signal) => ev('child_exit', { code, signal }));
    return child as unknown as ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>>;
  };
}

process.on('SIGUSR2', () => { ev('clean_exit'); process.exit(0); });
process.on('SIGUSR1', () => push('Reply with just: again'));

ev('start', { pid: process.pid, mode, sessionOpt: options.sessionId, resume: options.resume });
const q = query({ prompt: input, options });
push(prompt);

let chars = 0;
let sawBgTool = false;
try {
  for await (const m of q) {
    const rec: Record<string, unknown> = { type: m.type, uuid: (m as { uuid?: string }).uuid, session_id: (m as { session_id?: string }).session_id };
    if ('subtype' in m) rec.subtype = (m as { subtype?: string }).subtype;
    if (m.type === 'stream_event') {
      const e = m.event as { type: string; delta?: { type: string; text?: string } };
      rec.event = e.type;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        chars += e.delta.text?.length ?? 0;
        if (base === 'stream' && chars > 200) markReady('streaming text');
      }
      // Stream events are numerous; keep the uuid list but not every line.
      if (e.type !== 'message_start' && e.type !== 'message_stop') { ev('sdk_stream', { uuid: rec.uuid }); continue; }
    }
    if (m.type === 'assistant') {
      const content = (m.message as { content: { type: string; name?: string; input?: { run_in_background?: boolean } }[] }).content;
      rec.content = content.map((c) => c.type + (c.name ? `:${c.name}` : ''));
      if (content.some((c) => c.type === 'tool_use' && c.input?.run_in_background)) sawBgTool = true;
      // A read-only-looking command may be auto-allowed without canUseTool.
      if (base === 'bash' && content.some((c) => c.type === 'tool_use' && c.name === 'Bash')) setTimeout(() => markReady('bash tool_use + 3s'), 3000);
    }
    if (m.type === 'result') rec.result = { is_error: m.is_error, subtype: m.subtype };
    ev('sdk', rec);
    if (m.type === 'result') {
      if (base === 'idle') markReady('idle after result');
      if (base === 'bg') markReady(sawBgTool ? 'result with bg shell' : 'result (no bg tool seen!)');
    }
  }
  ev('iterator_done');
} catch (err) {
  ev('iterator_error', { err: String(err).slice(0, 500) });
}
// eof modes: stay alive a while so the driver can observe the child.
if (mode.startsWith('eof')) setTimeout(() => { ev('holder_exit'); process.exit(0); }, 5000);

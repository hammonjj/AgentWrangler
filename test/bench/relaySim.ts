/**
 * A deterministic model of one remote tab (#194): the real daemon-side code (`browserConnections`,
 * `RelaySocket`, the snapshot coalescer, the interaction tracer, the click trace and the recent
 * window) run on a virtual clock, over a simulated network with a seeded latency, jitter and loss.
 *
 * What is real: every queueing, batching, lane, coalescing, windowing and tracing decision. What
 * is modelled, and named so a report can say which is which:
 *
 * - the **network**: a sealed part takes `2 × toSupabaseMs` (plus jitter) to be acknowledged and
 *   to arrive, as a Supabase Broadcast with `ack: true` does; a LAN tab is one WebSocket hop;
 * - the **daemon's work**: how long `source.init` takes, by conversation size;
 * - the **browser**: inflating and decrypting a batch, and rendering what arrived.
 *
 * Crypto and compression are not in the virtual time: WebCrypto completes on the real event loop,
 * which a virtual clock does not wait for, and a CI machine's speed must not move a threshold.
 * `sealedBytes` stands in for the codec (deflate, then base64 and a tag per part), and the codec
 * itself is measured separately, on real time, by `measureCodec`.
 *
 * Nothing here reads a real project: blocks are generated from a word list.
 */
import { deflateSync } from 'node:zlib';
import { vi } from 'vitest';
import { ownerContext } from '../../src/core/access';
import { ClientRegistry } from '../../src/core/clients';
import { createBrowserConnections, type ClientSocket } from '../../src/core/web/browserConnections';
import { InteractionTracer, type TraceEntry } from '../../src/core/web/interactionTrace';
import { RELAY_CONNECTION_LIMITS } from '../../src/app/webWorkbench';
import { RelaySocket } from '../../src/remote/relay/virtualSocket';
import { RELAY_BATCH_MS, RELAY_MAX_PART_BYTES, type RelayItem } from '../../src/shared/relay';
import type { ConvBlock } from '../../src/shared/conversation';
import { percentile } from '../../src/shared/trace';
import { MAX_INIT_BLOCKS } from '../../src/claude/transcriptHistory';
import { RELAY_INIT_BLOCKS, recentWindow } from '../../src/ui/conversation/initWindow';
import { ClickTrace } from '../../src/webview/common/clickTrace';

export interface NetProfile {
  name: string;
  /** Daemon or browser to Supabase, one way. A part is acknowledged, and arrives, after twice this. Ignored for LAN. */
  toSupabaseMs: number;
  jitterMs: number;
  /** Chance a part is lost: its acknowledgement never comes and the tab is dropped. */
  lossRate: number;
}

export const PROFILES = {
  lan: { name: 'lan', toSupabaseMs: 0.5, jitterMs: 0.2, lossRate: 0 },
  relayGood: { name: 'relay-good', toSupabaseMs: 40, jitterMs: 10, lossRate: 0 },
  relayPoor: { name: 'relay-poor', toSupabaseMs: 150, jitterMs: 60, lossRate: 0.01 },
} satisfies Record<string, NetProfile>;

export interface Scenario {
  name: string;
  transport: 'lan' | 'relay';
  profile: NetProfile;
  /** Rows in the table; all are active in `active` mode. */
  sessions: 1 | 5 | 20;
  conversation: 'small' | 'large';
  /** `active`: sessions change and the open conversation streams. `idle`: nothing changes. `background`: the tab is hidden. */
  mode: 'active' | 'idle' | 'background';
  clicks: number;
  /** Virtual run time. */
  durationMs: number;
  seed: number;
  /** Cut the connection at this time, once, to measure a reconnect. */
  dropAtMs?: number;
  /** A large page of history sent this often: the transfer a command has to get past. */
  burst?: { everyMs: number; kb: number };
  /** Send everything through one first-in first-out line, as the relay did before lanes (#193). */
  fifo?: boolean;
  /** Commands (a small mutating message each) sent at even intervals; the time to their acknowledgement is measured. Default 30. */
  commands?: number;
}

/** Conversation sizes: blocks in the transcript, and what reading them costs the daemon. */
const CONVERSATIONS = {
  small: { blocks: 24, initMs: 12 },
  large: { blocks: 2_000, initMs: 85 },
} as const;
const BLOCK_CHARS = 1_100;
const ROW_CHARS = 1_400;
const SMART_OPEN_MS = 2;
/** The browser: inflate and open a batch, per KB of sealed bytes; and render, per block drawn. */
const BROWSER_DECODE_MS_PER_KB = 0.35;
const BROWSER_RENDER_BASE_MS = 14;
const BROWSER_RENDER_MS_PER_BLOCK = 0.09;
/** A Broadcast whose acknowledgement does not come is given up on after this (supabase-js default). */
const ACK_TIMEOUT_MS = 10_000;
/** Opening a new channel and asking the daemon for it, after a drop. */
const RECONNECT_ROUNDTRIPS = 4;
const START = 1_700_000_000_000;

export interface ScenarioResult {
  scenario: Scenario;
  clicks: number;
  /** Click to the conversation's `init` reaching the page, first paint after it, and the page idle: the browser's own clock. */
  recvMs: Pctl;
  firstMs: Pctl;
  interactiveMs: Pctl;
  /** The daemon's share of a click (smartOpen + init), from the tracer. */
  daemonMs: Pctl;
  /** The relay's queue wait for the click's batch, and its send+acknowledgement time. */
  queueMs?: Pctl;
  sendAckMs?: Pctl;
  renderMs: Pctl;
  /** A command sent to its acknowledgement arriving: what a click's reply or a typed message feels like during a transfer. */
  commandMs: Pctl;
  /** Daemon to browser, over the run. */
  bytesDown: number;
  messagesDown: number;
  batchesDown: number;
  /** Table snapshots the host built, and the ones that were sent: the rest were unchanged, coalesced, or held while the table was out of sight. */
  snapshotsSent: number;
  snapshotsBuilt: number;
  reconnects: number;
  /** Real milliseconds the model's own JavaScript took (no crypto): a trend, never a gate. */
  cpuMs: number;
}

export interface Pctl {
  p50: number;
  p95: number;
}

const pctl = (values: number[]): Pctl => ({ p50: percentile(values, 0.5) ?? 0, p95: percentile(values, 0.95) ?? 0 });

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'the a of to and in that it is for was on with as be at by this have from or one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know get through back much before go good new write our me man too any day same right look think also around another came come work three word must because does part even place well such here take why help put different away again off went old number great tell men say small every found still between name should home big give air line set own under read last never us left end along while might next sound below saw something thought both few those always looked show large often together asked house don world going want school important until form food keep children feet land side without boy once animal life enough took sometimes four head above kind began almost live page got earth need far hand high year mother light country father let night picture being study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young sun thing whole hear example heard several change answer room sea against top turned learn point city play toward five using himself usually'.split(' ');

function text(random: () => number, chars: number): string {
  let out = '';
  while (out.length < chars) out += `${WORDS[Math.floor(random() * WORDS.length)]} `;
  return out.slice(0, chars);
}

function makeBlocks(random: () => number, count: number): ConvBlock[] {
  return Array.from({ length: count }, (_, i) => ({ kind: i % 2 === 0 ? 'user' : 'assistant', id: `t:${i}`, text: text(random, BLOCK_CHARS) }) as ConvBlock);
}

/** What the codec would put on the wire for these items: deflate, then per part base64 and a tag. */
export function sealedBytes(items: readonly RelayItem[]): { parts: number; bytes: number } {
  const packed = deflateSync(Buffer.from(JSON.stringify(items))).length;
  const parts = Math.max(1, Math.ceil(packed / RELAY_MAX_PART_BYTES));
  return { parts, bytes: Math.ceil((packed * 4) / 3) + parts * 64 };
}

/** One virtual-time tab. Call inside `vi.useFakeTimers`; `runScenario` does. */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  vi.useFakeTimers({ now: START });
  const cpuStart = process.cpuUsage();
  try {
    return await run(scenario, cpuStart);
  } finally {
    vi.useRealTimers();
  }
}

async function run(s: Scenario, cpuStart: NodeJS.CpuUsage): Promise<ScenarioResult> {
  const random = rng(s.seed);
  const jitter = (p: NetProfile) => (random() * 2 - 1) * p.jitterMs;
  const lan = s.transport === 'lan';
  /** Daemon <-> browser, one way, for what is not acknowledged: a LAN hop, or Supabase both sides. */
  const oneWay = (p: NetProfile) => Math.max(0.1, lan ? p.toSupabaseMs + jitter(p) : 2 * p.toSupabaseMs + jitter(p));
  const convo = CONVERSATIONS[s.conversation];
  const blocks = makeBlocks(random, convo.blocks);
  const window = lan ? { blocks: blocks.slice(-MAX_INIT_BLOCKS), trimmed: blocks.length > MAX_INIT_BLOCKS } : recentWindow(blocks, RELAY_INIT_BLOCKS);
  const rows = Array.from({ length: s.sessions }, (_, i) => ({ key: `claude:s${i}`, title: `Session ${i}`, note: text(random, ROW_CHARS), lastActivityAt: START }));

  const result = {
    bytesDown: 0,
    messagesDown: 0,
    batchesDown: 0,
    snapshotsSent: 0,
    snapshotsBuilt: 0,
    reconnects: 0,
  };
  const tracer = new InteractionTracer({ log: () => undefined, capacity: 10_000, summaryEvery: 0 });
  const renderMs: number[] = [];

  // ---- the browser's end ----
  let toDaemon: (line: string) => void = () => undefined;
  const clickTrace = new ClickTrace({
    now: () => Date.now(),
    afterPaint: (run) => void setTimeout(run, renderMs.at(-1) ?? 0),
    afterIdle: (run) => void setTimeout(run, 0),
    report: (r) => toDaemon(JSON.stringify({ pane: 'shell', body: { type: 'trace', ...r } })),
    reconnects: () => result.reconnects,
    random,
  });
  let clickSeq = 0;
  /** A click sent but not yet answered, so a drop can resend it as the shim does. */
  let unanswered: string | undefined;

  /** What reaches the page: the click trace sees `init`, and the render time is by the blocks it drew. */
  const commandSentAt = new Map<string, number>();
  const commandMs: number[] = [];
  const pageReceives = (line: string, sealedKb: number) => {
    const envelope = JSON.parse(line) as { pane?: string; body?: { type?: string; blocks?: unknown[]; ids?: string[] } };
    if (envelope.pane === 'shell' && envelope.body?.type === 'ack') {
      for (const id of envelope.body.ids ?? []) {
        const at = commandSentAt.get(id);
        if (at !== undefined) commandMs.push(Date.now() - at);
        commandSentAt.delete(id);
      }
    }
    if (envelope.pane === 'conversation' && envelope.body?.type === 'init') {
      unanswered = undefined;
      const drawn = envelope.body.blocks?.length ?? 0;
      const render = BROWSER_RENDER_BASE_MS + drawn * BROWSER_RENDER_MS_PER_BLOCK;
      renderMs.push(render);
      const decode = sealedKb * BROWSER_DECODE_MS_PER_KB;
      // The page spends `decode` before it has the message, then draws it.
      setTimeout(() => clickTrace.received(envelope), decode);
    }
    if (envelope.pane === 'dashboard' && envelope.body?.type === 'snapshot') result.snapshotsSent++;
  };

  // ---- the daemon's end ----
  let socketSeq = 0;
  let currentEnd: (() => void) | undefined;
  const conns = createBrowserConnections({
    clients: new ClientRegistry({ log: () => undefined }),
    log: () => undefined,
    build: () => 'b1',
    isMutating: () => false,
    tracer,
    limits: lan ? { pingIntervalMs: 0 } : { ...RELAY_CONNECTION_LIMITS, pingIntervalMs: 0 },
    createPanes: (transport) => {
      let open = false;
      // The table: a snapshot whenever a row changes, and once on `ready`.
      const snapshot = () => {
        result.snapshotsBuilt++;
        void transport.postMessage({ pane: 'dashboard', body: { type: 'snapshot', sessions: rows.map((r) => ({ ...r })), nowMs: Date.now(), usage: { windows: [{ id: 'five', usedPct: 12 }] } } });
      };
      const page = s.burst ? makeBlocks(random, Math.ceil((s.burst.kb * 1024) / BLOCK_CHARS)) : [];
      const burst = s.burst
        ? setInterval(() => void transport.postMessage({ pane: 'conversation', body: { type: 'archive', requestId: `a${Date.now()}`, blocks: page, more: true, query: '' } }), s.burst.everyMs)
        : undefined;
      const tick = setInterval(() => {
        if (s.mode === 'active') {
          const row = rows[Math.floor(random() * rows.length)];
          row.lastActivityAt = Date.now();
          snapshot();
        } else snapshot(); // idle: the host rebuilds the same table; the connection decides whether to send it
        if (open && s.mode === 'active') {
          void transport.postMessage({ pane: 'conversation', body: { type: 'append', blocks: [{ kind: 'assistant', id: `live:${Date.now()}`, text: text(random, BLOCK_CHARS) }] } });
        }
      }, 1_000);
      transport.onDidReceiveMessage((m) => {
        const msg = m as { pane?: string; body?: { type?: string } };
        if (msg.pane === 'dashboard' && msg.body?.type === 'ready') snapshot();
        if (msg.pane === 'dashboard' && msg.body?.type === 'rowClick') {
          open = true;
          setTimeout(() => {
            void transport.postMessage({ pane: 'shell', body: { type: 'navigate', target: 'conversation', key: 'claude:s0' } });
            setTimeout(() => void transport.postMessage({ pane: 'conversation', body: { type: 'init', session: { key: 'claude:s0' }, blocks: window.blocks, truncated: window.trimmed } }), convo.initMs);
          }, SMART_OPEN_MS);
        }
      });
      return {
        dashboard: {
          dispose: () => {
            clearInterval(tick);
            if (burst) clearInterval(burst);
          },
        },
        conversation: { dispose() {} } as never,
      };
    },
  });

  /** A socket for the daemon to talk through, and the tab's way back into it. */
  const connect = (): void => {
    const id = ++socketSeq;
    const live = () => id === socketSeq;
    let socket: ClientSocket;
    if (lan) {
      const listeners: ((d: Buffer, bin: boolean) => void)[] = [];
      socket = {
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send: (line: string) => {
          result.messagesDown++;
          result.bytesDown += line.length;
          const wait = oneWay(s.profile);
          setTimeout(() => live() && pageReceives(line, 0), wait);
        },
        ping() {},
        close() {},
        terminate() {},
        on: (event: string, l: unknown) => {
          if (event === 'message') listeners.push(l as (d: Buffer, bin: boolean) => void);
          return socket;
        },
      } as unknown as ClientSocket;
      toDaemon = (line) => {
        const wait = oneWay(s.profile);
        setTimeout(() => live() && listeners.forEach((l) => l(Buffer.from(line), false)), wait);
      };
      currentEnd = undefined;
    } else {
      const relay: RelaySocket = new RelaySocket({
        batchMs: RELAY_BATCH_MS,
        send: async (items, traced) => {
          const started = Date.now();
          const sealed = sealedBytes(items);
          result.batchesDown++;
          const lines: string[] = [];
          for (const i of items) if (i.k === 'data') lines.push(i.line);
          for (let part = 0; part < sealed.parts; part++) {
            if (random() < s.profile.lossRate) {
              await new Promise((r) => setTimeout(r, ACK_TIMEOUT_MS));
              throw new Error('timed out');
            }
            await new Promise((r) => setTimeout(r, oneWay(s.profile)));
            result.messagesDown++;
          }
          result.bytesDown += sealed.bytes;
          const finished = Date.now();
          for (const t of traced) {
            tracer.relayBatch(t.cid, { items: items.length, queueDepth: t.queueDepth, behindBatch: t.behindBatch, queuedMs: t.queuedMs, sealMs: 0, sendMs: finished - started, parts: sealed.parts, bytes: sealed.bytes });
          }
          if (live()) for (const line of lines) pageReceives(line, sealed.bytes / 1024);
        },
        onEnd: () => {
          if (!live()) return;
          // The tab cannot tell until its own silence check, or its next send fails: reconnect after a handshake.
          socketSeq++;
          result.reconnects++;
          const handshake = RECONNECT_ROUNDTRIPS * 2 * (2 * s.profile.toSupabaseMs);
          setTimeout(() => {
            connect();
            // The shim: a fresh `ready`, then what was unacknowledged is sent again.
            toDaemon(JSON.stringify({ pane: 'dashboard', commandId: `r${socketSeq}`, body: { type: 'ready' } }));
            if (unanswered) toDaemon(unanswered);
          }, handshake);
        },
      });
      // Before lanes: one line, so `conns` finds no `sendWith` and uses plain `send`.
      socket = s.fifo
        ? new Proxy(relay, {
            get: (target, prop) => {
              if (prop === 'sendWith') return undefined;
              const value = Reflect.get(target, prop, target) as unknown;
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
            },
          })
        : relay;
      toDaemon = (line) => {
        const wait = oneWay(s.profile);
        setTimeout(() => live() && relay.receive([{ k: 'data', line }]), wait);
      };
      currentEnd = () => relay.terminate();
    }
    conns.attach(socket, ownerContext('browser', { deviceId: 'dev', deviceScope: lan ? 'loopback' : 'relay' }));
  };

  connect();
  toDaemon(JSON.stringify({ pane: 'dashboard', commandId: 'r0', body: { type: 'ready' } }));
  toDaemon(JSON.stringify({ pane: 'shell', body: { type: 'visibility', hidden: s.mode === 'background', table: s.mode !== 'background' } }));

  // ---- the clicks ----
  const gap = Math.floor(s.durationMs / (s.clicks + 1));
  for (let i = 1; i <= s.clicks; i++) {
    setTimeout(() => {
      const stamped = clickTrace.stamp({ pane: 'dashboard', commandId: `c${++clickSeq}`, body: { type: 'rowClick', key: `claude:s${i % s.sessions}` } });
      unanswered = JSON.stringify(stamped);
      toDaemon(unanswered);
    }, i * gap);
  }
  const commands = s.commands ?? 30;
  const commandGap = Math.floor(s.durationMs / (commands + 1));
  for (let i = 1; i <= commands; i++) {
    setTimeout(() => {
      const commandId = `cmd-${i}`;
      commandSentAt.set(commandId, Date.now());
      toDaemon(JSON.stringify({ pane: 'conversation', commandId, body: { type: 'setModel', model: 'm' } }));
    }, i * commandGap + 137);
  }
  if (s.dropAtMs !== undefined) setTimeout(() => currentEnd?.(), s.dropAtMs);

  await vi.advanceTimersByTimeAsync(s.durationMs + 5 * ACK_TIMEOUT_MS);
  // Closing the connection at the end is not a reconnect.
  socketSeq++;
  conns.dispose();

  const done: readonly TraceEntry[] = tracer.recent();
  const relayed = done.flatMap((e) => (e.relay ? [e.relay] : []));
  const cpu = process.cpuUsage(cpuStart);
  return {
    scenario: s,
    clicks: done.length,
    recvMs: pctl(done.map((e) => e.recvMs)),
    firstMs: pctl(done.map((e) => e.firstMs)),
    interactiveMs: pctl(done.map((e) => e.interactiveMs)),
    daemonMs: pctl(done.map((e) => (e.smartOpenMs ?? 0) + (e.initMs ?? 0))),
    ...(relayed.length > 0 ? { queueMs: pctl(relayed.map((r) => r.queuedMs)), sendAckMs: pctl(relayed.map((r) => r.sendMs)) } : {}),
    renderMs: pctl(done.map((e) => e.renderMs)),
    commandMs: pctl(commandMs),
    bytesDown: result.bytesDown,
    messagesDown: result.messagesDown,
    batchesDown: result.batchesDown,
    snapshotsSent: result.snapshotsSent,
    snapshotsBuilt: result.snapshotsBuilt,
    reconnects: result.reconnects,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  };
}

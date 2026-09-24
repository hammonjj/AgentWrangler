/**
 * Shared harness for the session-host process tests (playbook §16, level I):
 * real detached hosts over real Unix sockets, with the fake agent
 * (`AW_SESSION_HOST_FAKE=1`, `src/sessionHost/fakeQuery.ts`) and its dummy
 * child in place of `claude`. macOS and Linux only.
 *
 * Each test file makes one `HostHarness` in its own temp dir. `cleanup()` runs
 * after each test and kills everything the manifests name (hosts and agents),
 * plus any agent a test registered itself, so a failing test cannot leave
 * processes behind for the next one.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import esbuild from 'esbuild';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunnerView } from '../../src/claude/runner/runnerView';
import { isSameProcessAlive, startTimeOf } from '../../src/core/procStart';
import { HostSupervisor } from '../../src/core/session/hostSupervisor';
import { readManifests } from '../../src/core/session/manifestFile';
import { adoptHostedClaude, spawnHostedClaude } from '../../src/core/session/remoteClaudeHandle';
import { NdjsonPeer } from '../../src/core/rpc/ndjsonPeer';
import { MAX_FRAME_BYTES, type EventsResult, type HostEvent, type HostManifest, type HostSnapshot } from '../../src/shared/sessionProtocol';

export const noHistory = async () => ({ blocks: [], truncated: false });

export async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

export async function untilAsync(cond: () => Promise<boolean>, ms = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The parent pid of a live process, or undefined. */
export function ppidOf(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? Number(out) : undefined;
  } catch {
    return undefined;
  }
}

export function argsOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

export const texts = (v: RunnerView) => v.blocks.map((b) => ('text' in b ? b.text : `[${b.kind}]`));

export const sessionId = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A user message as the core sends it (the view sets the same fields). */
export function userMessage(text: string, uuid: string = randomUUID()): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid } as SDKUserMessage;
}

export interface HarnessOptions {
  /** Extra environment for hosts beyond `AW_SESSION_HOST_FAKE`. */
  hostEnv?: Record<string, string>;
}

export class HostHarness {
  // Short: socket paths must stay under macOS's 104-byte limit.
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awh-')));
  readonly runDir = path.join(this.root, 'run');
  readonly logDir = path.join(this.root, 'logs');
  readonly bundle = path.join(this.root, 'host.js');
  /** Processes a test knows about beyond the manifests, with their start times. */
  private extraPids = new Map<number, string | undefined>();
  private expected = new Set<number>();
  private clients = new Set<RawClient>();

  constructor(private opts: HarnessOptions = {}) {}

  /** Bundle the host entry the way `esbuild.mjs` does. Call from `beforeAll`. */
  async build(): Promise<void> {
    await esbuild.build({
      entryPoints: ['src/sessionHost/main.ts'],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      outfile: this.bundle,
      define: { 'import.meta.url': '__aw_import_meta_url', AW_SDK_VERSION: '"test"' },
      banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
      logLevel: 'silent',
    });
  }

  supervisor(o: { log?: (msg: string) => void; hostEnv?: Record<string, string> } = {}): HostSupervisor {
    return new HostSupervisor({
      runDir: this.runDir,
      fallbackRunDir: path.join(this.root, 'fb'),
      logDir: this.logDir,
      runtime: { buildId: 'test', prepare: async () => ({ exe: process.execPath, entry: this.bundle }) },
      log: o.log ?? (() => undefined),
      build: 'test',
      hostEnv: { AW_SESSION_HOST_FAKE: '1', ...this.opts.hostEnv, ...o.hostEnv },
    });
  }

  /** A new hosted session, started. `resume` starts it as a resume of `id`. */
  spawn(id: string, o: { cwd?: string; resume?: boolean; supervisor?: HostSupervisor; log?: (m: string) => void } = {}): RunnerView {
    const view = spawnHostedClaude(
      { cwd: o.cwd ?? this.root, ...(o.resume ? { resume: id } : { sessionId: id }) },
      { supervisor: o.supervisor ?? this.supervisor(), binary: '/fake', log: o.log ?? (() => undefined), loadHistory: noHistory },
    );
    view.start();
    return view;
  }

  /** What a new core does at startup: scan, then reattach to the host for `id`. */
  adopt(id: string, sup: HostSupervisor = this.supervisor()): RunnerView {
    const manifest = sup.scan().alive.find((m) => m.sessionId === id);
    if (!manifest) throw new Error(`no live host for ${id}`);
    const view = adoptHostedClaude(manifest, {}, { supervisor: sup, binary: '/fake', log: () => undefined, loadHistory: noHistory });
    view.start();
    return view;
  }

  manifest(id: string): HostManifest | undefined {
    return readManifests(this.runDir).find((m) => m.manifest.sessionId === id)?.manifest;
  }

  async manifestWithAgent(id: string): Promise<HostManifest> {
    await until(() => this.manifest(id)?.agentPid !== undefined, 10_000, `the agent pid of ${id}`);
    return this.manifest(id)!;
  }

  token(m: HostManifest): string {
    return fs.readFileSync(path.join(this.runDir, `${m.hostId}.token`), 'utf8').trim();
  }

  hostLog(m: HostManifest): string {
    try {
      return fs.readFileSync(path.join(this.logDir, `host-${m.hostId}.log`), 'utf8');
    } catch {
      return '';
    }
  }

  /** The environment the fake agent was started with (it writes it to its cwd). */
  agentEnv(agentPid: number, cwd = this.root): Record<string, string> {
    return JSON.parse(fs.readFileSync(path.join(cwd, `agent-env-${agentPid}.json`), 'utf8')) as Record<string, string>;
  }

  /** A process to clean up that no manifest names (a test core, an orphan). */
  track(pid: number): void {
    this.extraPids.set(pid, startTimeOf(pid));
  }

  /** The test leaves this process running on purpose (an orphan it made): cleanup kills it without calling it a stray. */
  leaveRunning(pid: number): void {
    this.track(pid);
    this.expected.add(pid);
  }

  /** A raw protocol client, for what the core's client does not expose. */
  async connect(m: HostManifest, o: { token?: string; role?: string; protocol?: { min: number; max: number } } = {}): Promise<RawClient> {
    const c = await RawClient.open(m.socketPath);
    this.clients.add(c);
    if (o.token !== '') {
      await c.peer.request('hello', {
        client: { role: o.role ?? 'core', build: 'test', pid: process.pid },
        protocol: o.protocol ?? { min: 1, max: 1 },
        token: o.token ?? this.token(m),
      });
    }
    return c;
  }

  /**
   * Every host and agent a manifest or a test named that is still the same
   * process: checked against its recorded start time, so a pid the system has
   * since reused for something else is never touched.
   */
  running(): number[] {
    const found = new Map(this.extraPids);
    for (const { manifest } of readManifests(this.runDir, true)) {
      found.set(manifest.hostPid, manifest.hostStartTime);
      if (manifest.agentPid) found.set(manifest.agentPid, manifest.agentStartTime);
    }
    return [...found].filter(([pid, start]) => start !== undefined && isSameProcessAlive(pid, start)).map(([pid]) => pid);
  }

  /**
   * `afterEach`: give whatever is exiting a moment (a host drains after its
   * agent exits), then kill everything by manifest. Returns what had to be
   * killed that the test did not declare with `leaveRunning`.
   */
  async cleanup(): Promise<number[]> {
    for (const c of this.clients) c.close();
    this.clients.clear();
    const expected = new Set(this.expected);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && this.running().some((p) => !expected.has(p))) await sleep(50);
    const left = this.running();
    for (const pid of left) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone meanwhile
      }
    }
    this.extraPids.clear();
    this.expected.clear();
    return left.filter((p) => !expected.has(p));
  }

  /** `afterAll`: nothing may be left running, and the temp dir goes. */
  async dispose(): Promise<void> {
    await this.cleanup();
    await until(() => this.running().length === 0, 5000, 'every process to exit');
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

/** One NDJSON JSON-RPC connection to a host, recording what it is sent. */
export class RawClient {
  readonly events: HostEvent[] = [];
  resyncs = 0;
  closed = false;

  private constructor(
    readonly socket: net.Socket,
    readonly peer: NdjsonPeer,
  ) {}

  static open(socketPath: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const peer = new NdjsonPeer({ jsonrpc: true, maxLineBytes: MAX_FRAME_BYTES, write: (l) => socket.write(l) });
      const c = new RawClient(socket, peer);
      socket.on('data', (chunk: Buffer) => peer.feed(chunk));
      socket.on('close', () => {
        c.closed = true;
        peer.close(new Error('socket closed'));
      });
      socket.once('error', reject);
      peer.onNotification((n) => {
        if (n.method === 'event') c.events.push((n.params as { event: HostEvent }).event);
        else if (n.method === 'resync') c.resyncs++;
      });
      socket.once('connect', () => {
        socket.off('error', reject);
        socket.on('error', () => undefined);
        resolve(c);
      });
    });
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<T> {
    return this.peer.request<T>(method, params, { timeoutMs });
  }

  /** The text of the host's last `result`, from a snapshot: needs no event stream, so no resync can hide it. */
  async lastResult(): Promise<string | undefined> {
    const snap = await this.request<HostSnapshot>('snapshot');
    return (snap.latest?.result as { result?: string } | undefined)?.result;
  }

  /** Every event the host still holds after `fromSeq`, paged as the core pages them. */
  async page(fromSeq = 0): Promise<{ events: HostEvent[]; pages: EventsResult[] }> {
    const snap = await this.request<HostSnapshot>('snapshot');
    const events: HostEvent[] = [];
    const pages: EventsResult[] = [];
    let cursor = Math.max(fromSeq, snap.ring.fromSeq);
    for (;;) {
      const page = await this.request<EventsResult>('events', { fromSeq: cursor, maxBytes: 64 * 1024 * 1024, epoch: snap.epoch });
      pages.push(page);
      events.push(...page.events);
      if (page.done || page.nextSeq === cursor) return { events, pages };
      cursor = page.nextSeq;
    }
  }

  /** Assistant reply texts seen in `message` events. */
  replies(): string[] {
    const out: string[] = [];
    for (const e of this.events) {
      if (e.type !== 'message') continue;
      const m = e.msg as { type?: string; message?: { content?: { type?: string; text?: string }[] } };
      if (m.type !== 'assistant') continue;
      for (const part of m.message?.content ?? []) if (part.type === 'text' && part.text) out.push(part.text);
    }
    return out;
  }

  close(): void {
    this.socket.destroy();
  }
}

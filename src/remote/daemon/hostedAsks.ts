/**
 * What every live session host is asking, followed from outside the app (#74).
 *
 * A hosted session's permission, question and plan asks never reach the hook
 * file (`AGENTWRANGLER_HOSTED` switches that off), so once the app has gone the
 * only way to see them, or answer them, is the host's own socket. This follows
 * each live host as a **passive** core client (`CLIENT_CAPABILITY_PASSIVE`): it
 * may answer an ask, and it is not counted by the idle-orphan rule, so a host
 * nobody is looking at still parks when it should.
 *
 * It never ends, configures, sends to or migrates a host. It reads the
 * manifests the app's `HostSupervisor` and the hosts write, attaches to the
 * ones whose process is alive, and lets go of each once it has gone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Disposable } from '../../core/events';
import { isSameProcessAlive } from '../../core/procStart';
import { HostClient } from '../../core/session/hostClient';
import { readManifest, readManifests } from '../../core/session/manifestFile';
import { askKind, pendingViews, permissionResult, planResult, questionResult, type AskInput } from '../../claude/runner/askResults';
import type { HostEvent, HostManifest, HostSnapshot, RawPermissionResult, RespondOutcome } from '../../shared/sessionProtocol';

/** Just what this needs of a `HostClient`, so a test can hand in a fake. */
export interface HostLink {
  snapshot(): HostSnapshot;
  subscribe(fromSeq: number, listener: (event: HostEvent) => void): Disposable;
  onLink?(listener: (state: 'connecting' | 'live' | 'unreachable') => void): Disposable;
  start(): void;
  respondAsk(requestId: string, result: RawPermissionResult): Promise<RespondOutcome>;
  detach(): void;
}

export interface HostedAsksOptions {
  runDir: string;
  build: string;
  log: (message: string) => void;
  /** How often the run directory is re-read for hosts that came or went. */
  scanIntervalMs?: number;
  /** Tests: a fake link instead of a socket. */
  connect?: (manifest: HostManifest, token: string) => HostLink;
  /** Tests: whether a manifest's host process is alive. */
  isAlive?: (manifest: HostManifest) => boolean;
}

interface Followed {
  manifest: HostManifest;
  link: HostLink;
  subs: Disposable[];
  state: 'connecting' | 'live' | 'unreachable';
}

export type AskOutcome = 'applied' | 'stale' | 'gone';

export class HostedAsks implements Disposable {
  private followed = new Map<string, Followed>();
  private timer?: ReturnType<typeof setInterval>;
  private emitter = new Emitter<void>();
  private disposed = false;

  readonly onDidChange = (listener: () => void): Disposable => this.emitter.event(listener);

  constructor(private opts: HostedAsksOptions) {}

  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.opts.scanIntervalMs ?? 3000);
    this.timer.unref?.();
  }

  /** Hosts followed right now. */
  get count(): number {
    return this.followed.size;
  }

  /**
   * Resolves once every host found so far has connected or given up, or after
   * `maxMs`: until then its asks are unknown, and an unknown ask must not read
   * as a settled one.
   */
  async whenSettled(maxMs = 5000): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && [...this.followed.values()].some((f) => f.state === 'connecting')) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Read the run directory: follow new live hosts, let go of gone ones. */
  scan(): void {
    if (this.disposed) return;
    const alive = this.opts.isAlive ?? ((m: HostManifest) => isSameProcessAlive(m.hostPid, m.hostStartTime));
    const seen = new Set<string>();
    for (const { manifest } of readManifests(this.opts.runDir)) {
      if (manifest.exit || !alive(manifest)) continue;
      seen.add(manifest.hostId);
      if (!this.followed.has(manifest.hostId)) this.follow(manifest);
    }
    let changed = false;
    for (const [hostId, f] of this.followed) {
      if (seen.has(hostId)) continue;
      this.letGo(hostId, f);
      changed = true;
    }
    if (changed) this.emitter.fire();
  }

  /** The session id a host is running now: a `/clear` inside it moves it on. */
  private sessionIdOf(f: Followed): string | undefined {
    return f.link.snapshot().sessionId ?? f.manifest.sessionId;
  }

  private find(sessionId: string | undefined): Followed | undefined {
    if (!sessionId) return undefined;
    const id = sessionId.toLowerCase();
    for (const f of this.followed.values()) {
      if (this.sessionIdOf(f)?.toLowerCase() === id) return f;
    }
    return undefined;
  }

  /** A live host runs this session, so its asks are answered here and not through the hook. */
  owns(sessionId: string | undefined): boolean {
    return this.find(sessionId) !== undefined;
  }

  views(sessionId: string | undefined): ReturnType<typeof pendingViews> {
    const f = this.find(sessionId);
    return f ? pendingViews(f.link.snapshot().pendingAsks, f.manifest.cwd) : {};
  }

  /**
   * Answer a permission. With no request named, only a lone pending one, so
   * the answer cannot land on the wrong prompt (the app's rule).
   */
  decide(sessionId: string, decision: 'allow' | 'always' | 'deny', expected?: string): Promise<AskOutcome> {
    return this.respond(sessionId, 'permission', expected, (ask) => permissionResult(ask, decision));
  }

  answer(sessionId: string, requestId: string, answers: Record<string, string>): Promise<AskOutcome> {
    return this.respond(sessionId, 'question', requestId, (ask) => questionResult(ask, answers));
  }

  decidePlan(sessionId: string, requestId: string, approve: boolean, feedback?: string): Promise<AskOutcome> {
    return this.respond(sessionId, 'plan', requestId, (ask) => planResult(ask, approve, feedback));
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    for (const [hostId, f] of this.followed) this.letGo(hostId, f);
    this.emitter.dispose();
  }

  private async respond(
    sessionId: string,
    kind: 'permission' | 'question' | 'plan',
    requestId: string | undefined,
    result: (ask: AskInput) => RawPermissionResult,
  ): Promise<AskOutcome> {
    const f = this.find(sessionId);
    if (!f) return 'gone';
    const pending = f.link.snapshot().pendingAsks.filter((a) => askKind(a.toolName) === kind);
    const ask = requestId !== undefined ? pending.find((a) => a.requestId === requestId) : pending.length === 1 ? pending[0] : undefined;
    if (!ask) return 'stale';
    try {
      const outcome = await f.link.respondAsk(ask.requestId, result(ask));
      return outcome === 'applied' ? 'applied' : 'stale';
    } catch (err) {
      this.opts.log(`host ${f.manifest.hostId}: respondAsk failed: ${String(err)}`);
      return 'gone';
    }
  }

  private follow(manifest: HostManifest): void {
    let token = '';
    try {
      token = fs.readFileSync(path.join(this.opts.runDir, `${manifest.hostId}.token`), 'utf8').trim();
    } catch (err) {
      this.opts.log(`host ${manifest.hostId}: token unreadable (${String(err)})`);
      return;
    }
    const link = (this.opts.connect ?? ((m, t) => this.connect(m, t)))(manifest, token);
    const f: Followed = { manifest, link, subs: [], state: 'connecting' };
    f.subs.push(
      link.subscribe(0, (event) => {
        if (event.type === 'message') return; // the conversation is the app's business
        this.emitter.fire();
      }),
    );
    if (link.onLink) {
      f.subs.push(
        link.onLink((state) => {
          f.state = state;
          this.emitter.fire();
        }),
      );
    } else {
      f.state = 'live';
    }
    this.followed.set(manifest.hostId, f);
    link.start();
    this.opts.log(`following host ${manifest.hostId}`);
  }

  private connect(manifest: HostManifest, token: string): HostLink {
    return new HostClient({
      hostId: manifest.hostId,
      socketPath: manifest.socketPath,
      token,
      cwd: manifest.cwd,
      startedAt: manifest.startedAt,
      hostPid: () => manifest.hostPid,
      hostStartTime: () => manifest.hostStartTime,
      readTombstone: () => readManifest(path.join(this.opts.runDir, `${manifest.hostId}.json`))?.exit,
      // Adopting, with no transcript read: the ring's messages are passed over, not shown.
      mode: 'adopt',
      transcriptUuids: Promise.resolve(new Set<string>()),
      build: this.opts.build,
      log: (m) => this.opts.log(m),
      // No `orphanIdleHours`: the app owns that setting, and pushes it itself.
      passive: true,
    });
  }

  private letGo(hostId: string, f: Followed): void {
    for (const s of f.subs) s.dispose();
    f.link.detach();
    this.followed.delete(hostId);
    this.opts.log(`stopped following host ${hostId}`);
  }
}

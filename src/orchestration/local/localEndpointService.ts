/**
 * The local endpoints Agent Wrangler routes to (`docs/plans/intelligent-orchestration.md`
 * §19; #51): the registry in settings, each endpoint's last probe, its health,
 * its slots, its key, and what its models measured in qualification.
 *
 * - **Registry** in `orchestration.localEndpoints` (settings; no key there).
 *   A non-loopback endpoint is off until the user turns it on, and is never
 *   contacted while off — not even to probe it.
 * - **Keys** in `safeStorage`, under `localEndpoint:<id>`. Storing refuses
 *   when the OS cannot encrypt.
 * - **Health** is read every `healthIntervalMs` from the runtime's cheapest
 *   route. One miss is `degraded`; two in a row is `down`, and `onDown` fires
 *   so a running attempt on it can be ended as `infra` and failed over (§15.1).
 *   A call that loses the server asks for a read at once (`checkNow`).
 * - **Slots are concurrency** (§19.2): `acquire` holds one for a direct call
 *   and queues when none is free; the wait is the call's queue delay. Agentic
 *   attempts are counted by the caller (`statuses(busy)`), since their session
 *   outlives any single request.
 * - **Qualification** results are facts (`measured`) and are kept with the
 *   last probe in global state, so the tier map still shows them after a restart.
 */
import { Emitter, type Disposable, type Listener } from '../../core/events';
import type { KeyValueStorage } from '../../core/archive';
import { isKnown, UNKNOWN, known, tierRank, type CapabilityCatalogView, type CatalogEntry } from '../../shared/orchestration/catalog';
import { contextLimits } from '../policy/repoContext';
import {
  addEndpoint,
  DATA_LEAVES_MACHINE,
  endpointEnabled,
  endpointIdOf,
  endpointKeyRef,
  endpointSource,
  endpointIsLocal,
  isLoopbackUrl,
  isPrivateNetworkUrl,
  LOCAL_ENDPOINTS_KEY,
  parseLocalEndpoints,
  type LocalEndpointChange,
  type LocalEndpointConfig,
  type LocalEndpointModelView,
  type LocalEndpointView,
} from '../../shared/orchestration/localEndpoints';
import { localModelReports, shortModelName, type EndpointProbe, type LocalModelReport, type Qualification } from '../../shared/orchestration/localModels';
import type { HealthState, SourceHealth, SourceStatus } from '../../shared/orchestration/sourceHealth';
import type { LocalCallRecord, LocalRunMetrics, TelemetryRecord } from '../../shared/orchestration/telemetry';
import { TELEMETRY_SCHEMA_VERSION } from '../../shared/orchestration/telemetry';
import type { ModelSourceId } from '../../shared/orchestration/types';
import type { HarnessId } from '../../shared/orchestration/types';
import type { ClaudeLocalProvider, CodexModelProvider } from '../../shared/launchPolicy';
import { LocalStructuredCompletion, type LocalCompletionTarget, type SlotLease } from '../completion/localCompletion';
import type { StructuredCompletion } from '../completion/structuredCompletion';
import { PLANNER_LOCAL_MIN_TIER, plannerMinRank } from '../../shared/orchestration/localReadiness';
import {
  parseTaskQualification,
  summariseTaskRuns,
  taskQualificationText,
  type TaskQualification,
  type TaskRun,
} from '../../shared/orchestration/localQualification';
import type { FetchFn } from './openaiWire';
import { checkHealth, probeEndpoint, qualifyModel, type QualifyOptions } from './probe';

const STORAGE_KEY = 'agentWrangler.localEndpoints';
const HEALTH_INTERVAL_MS = 30_000;
const REPROBE_INTERVAL_MS = 10 * 60_000;
/** Consecutive failed reads before an endpoint is `down`. One is a blip. */
const DOWN_AFTER = 2;

interface Stored {
  v: 1;
  probes: Record<string, EndpointProbe>;
  qualifications: Record<string, Record<string, Partial<Record<HarnessId, Qualification>>>>;
  /** Stage 2 (§19.6), per endpoint then model. Optional: stored state from before stage 2 has none. */
  tasks?: Record<string, Record<string, Partial<Record<HarnessId, TaskQualification>>>>;
}

/** Runs stage 2 for one model through its selected native harness. */
export type TaskQualifier = (req: {
  source: ModelSourceId;
  model: string;
  /** Before the first run: how many there will be (fixtures × k), for the progress line. */
  onStart: (total: number) => void;
  onRun: (run: TaskRun) => void;
  /** Cancel (#160): the run in progress is ended, and no more start. */
  signal?: AbortSignal;
}) => Promise<{
  runs: TaskRun[];
  /** Runs per fixture. */
  k: number;
  /** It stopped early, or could not start. */
  error?: string;
}>;

interface EndpointState {
  health: SourceHealth;
  failures: number;
  inFlight: number;
  waiters: { resolve: () => void; since: number }[];
  checking?: Promise<HealthState>;
}

export interface EndpointSettings {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Promise<void>;
  onDidChange(listener: (affects: (key: string) => boolean) => void): Disposable;
}

export interface EndpointSecrets {
  readonly available: boolean;
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface LocalEndpointServiceDeps {
  settings: EndpointSettings;
  secrets?: EndpointSecrets;
  storage?: KeyValueStorage;
  fetch?: FetchFn;
  now?: () => number;
  log?: (msg: string) => void;
  healthIntervalMs?: number;
  reprobeIntervalMs?: number;
  /** Where `local-call` records go. */
  telemetry?: { append(record: TelemetryRecord): boolean };
  /** Asks the user for a key (a password field). Absent: keys cannot be set from here. */
  promptKey?: (endpoint: LocalEndpointConfig) => Promise<string | undefined>;
  /** Qualification run sizes; tests make them small. */
  qualifyRuns?: QualifyOptions['runs'];
}

function unknownHealth(reason: string): SourceHealth {
  return { state: 'unknown', reason };
}

export class LocalEndpointService implements Disposable {
  private readonly emitter = new Emitter<void>();
  private readonly downEmitter = new Emitter<ModelSourceId>();
  private readonly states = new Map<string, EndpointState>();
  private readonly probing = new Map<string, Promise<void>>();
  private readonly qualifying = new Set<string>();
  /** Stage 2 running, per `<id>\0<model>`: runs done of the total. */
  private readonly qualifyingTasks = new Map<string, { done: number; passed: number; total?: number; cancel: AbortController }>();
  private taskQualifiers: Partial<Record<HarnessId, TaskQualifier>> = {};
  private stored: Stored;
  private timer?: ReturnType<typeof setInterval>;
  private sub?: Disposable;
  private lastReprobe = 0;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private deps: LocalEndpointServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
    this.stored = parseStored(deps.storage?.get<unknown>(STORAGE_KEY, undefined));
    this.lastReprobe = this.now();
    this.sub = deps.settings.onDidChange((affects) => {
      if (affects(LOCAL_ENDPOINTS_KEY)) void this.configChanged();
    });
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);
  /** An endpoint has just been read as `down`: the source whose attempts should be failed over. */
  readonly onDown = (listener: Listener<ModelSourceId>): Disposable => this.downEmitter.event(listener);

  endpoints(): LocalEndpointConfig[] {
    return parseLocalEndpoints(this.deps.settings.get<unknown>(LOCAL_ENDPOINTS_KEY, undefined));
  }

  endpoint(idOrSource: string): LocalEndpointConfig | undefined {
    const id = endpointIdOf(idOrSource) ?? idOrSource;
    return this.endpoints().find((e) => e.id === id);
  }

  /** Probe every endpoint that is on, then read health on a timer. */
  start(): void {
    if (this.timer) return;
    void this.probeAll();
    this.timer = setInterval(() => void this.tick(), this.deps.healthIntervalMs ?? HEALTH_INTERVAL_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async probeAll(): Promise<void> {
    this.lastReprobe = this.now();
    await Promise.all(this.endpoints().filter(endpointEnabled).map((e) => this.probe(e.id)));
    this.changed();
  }

  /** Probe one endpoint now. A second call while one runs waits for it. */
  probe(id: string): Promise<void> {
    const running = this.probing.get(id);
    if (running) return running;
    const p = (async () => {
      const cfg = this.endpoint(id);
      if (!cfg) return;
      const key = await this.key(id);
      const probe = await probeEndpoint(cfg, { fetch: this.deps.fetch, key, now: this.now });
      // A failed re-probe keeps the last good one: its models stay in the tier
      // map (and their tiers in force) while the server is down; health says why.
      const prev = this.stored.probes[id];
      if (probe.reachable || !prev?.reachable) {
        this.stored = { ...this.stored, probes: { ...this.stored.probes, [id]: probe } };
        this.save();
      }
      const st = this.state(id);
      const was = st.health.state;
      if (probe.reachable) {
        st.failures = 0;
        st.health = { state: 'reachable', reason: reachableReason(probe), at: probe.at };
      } else {
        st.failures++;
        st.health = { state: st.failures >= DOWN_AFTER ? 'down' : 'degraded', reason: `Not answering: ${probe.error ?? 'unreachable'}`, at: probe.at };
      }
      this.log(`local: probed ${id}: ${probe.reachable ? `${probe.models.length} model(s)` : `unreachable (${probe.error})`}`);
      this.changed();
      if (st.health.state === 'down' && was !== 'down') this.downEmitter.fire(endpointSource(id));
    })().finally(() => {
      this.probing.delete(id);
      this.changed();
    });
    this.probing.set(id, p);
    // Preferences draws Probe as "Probing…" from `busy`: say so now, not when the probe is over.
    this.changed();
    return p;
  }

  /** One health pass over every endpoint that is on. Public so tests step it. */
  async tick(): Promise<void> {
    const reprobe = this.now() - this.lastReprobe >= (this.deps.reprobeIntervalMs ?? REPROBE_INTERVAL_MS);
    if (reprobe) this.lastReprobe = this.now();
    await Promise.all(
      this.endpoints()
        .filter(endpointEnabled)
        .map(async (e) => {
          const probe = this.stored.probes[e.id];
          // Never probed, or it was not answering when it was: probe, which also reads health.
          if (!probe || !probe.reachable || reprobe) return this.probe(e.id);
          await this.checkNow(endpointSource(e.id));
        }),
    );
  }

  /** Read one endpoint's health now. Fires `onDown` on the read that makes it `down`. */
  checkNow(source: ModelSourceId): Promise<HealthState> {
    const id = endpointIdOf(source);
    const cfg = id ? this.endpoint(id) : undefined;
    if (!id || !cfg) return Promise.resolve('unknown');
    const st = this.state(id);
    if (st.checking) return st.checking;
    st.checking = (async () => {
      const path = this.stored.probes[id]?.healthPath ?? '/v1/models';
      const key = await this.key(id);
      const r = await checkHealth(cfg, path, { fetch: this.deps.fetch, key });
      const at = this.now();
      const was = st.health.state;
      if (r.ok) {
        st.failures = 0;
        const probe = this.stored.probes[id];
        st.health = { state: 'reachable', reason: probe?.reachable ? reachableReason(probe) : 'Answering', at };
        // Back from being unreachable at probe time: find out what it serves.
        if (!probe?.reachable) void this.probe(id);
      } else if (r.loading) {
        st.health = { state: 'degraded', reason: 'Loading a model', at };
      } else {
        st.failures++;
        st.health = { state: st.failures >= DOWN_AFTER ? 'down' : 'degraded', reason: `Not answering: ${r.error}`, at };
      }
      if (st.health.state !== was) {
        this.log(`local: ${id} ${was} → ${st.health.state} (${st.health.reason})`);
        this.changed();
        if (st.health.state === 'down') this.downEmitter.fire(endpointSource(id));
      }
      return st.health.state;
    })().finally(() => (st.checking = undefined));
    return st.checking;
  }

  /** A call lost the server: read twice now, so a dead server is `down` without waiting for the timer. */
  async connectionLost(source: ModelSourceId): Promise<void> {
    const first = await this.checkNow(source);
    if (first !== 'reachable' && first !== 'down') await this.checkNow(source);
  }

  /** The catalog's input: every model every endpoint reported, on or off. */
  reports(): LocalModelReport[] {
    return this.endpoints().flatMap((e) => localModelReports(e, this.stored.probes[e.id], this.stored.qualifications[e.id], this.stored.tasks?.[e.id]));
  }

  /** Slots the server has, as known: probed, else declared. */
  private slotsOf(id: string): number | undefined {
    const probe = this.stored.probes[id];
    if (probe && isKnown(probe.slots)) return probe.slots.value;
    return this.endpoint(id)?.maxConcurrency;
  }

  /** One source's health and capacity. `busy`: agentic attempts running on it now. */
  status(source: ModelSourceId, busy = 0): SourceStatus {
    const id = endpointIdOf(source) ?? source;
    const cfg = this.endpoint(id);
    const st = this.states.get(id);
    const health = !cfg ? unknownHealth('Not registered') : !endpointEnabled(cfg) ? unknownHealth(endpointIsLocal(cfg) ? 'Off' : `Off (${DATA_LEAVES_MACHINE})`) : (st?.health ?? unknownHealth('Not probed yet'));
    const slots = this.slotsOf(id);
    const used = (st?.inFlight ?? 0) + busy;
    return {
      source: endpointSource(id),
      health,
      capacity: { windowPercent: UNKNOWN, freeSlots: slots !== undefined ? known(Math.max(0, slots - used), 'probed') : UNKNOWN },
    };
  }

  statuses(busy: Record<string, number> = {}): Record<string, SourceStatus> {
    const out: Record<string, SourceStatus> = {};
    for (const e of this.endpoints()) {
      const s = endpointSource(e.id);
      out[s] = this.status(s, busy[s] ?? 0);
    }
    return out;
  }

  /** Hold a server slot for one direct call, waiting for one when all are busy. */
  acquire(source: ModelSourceId, signal?: AbortSignal): Promise<SlotLease> {
    const id = endpointIdOf(source) ?? source;
    const st = this.state(id);
    const since = this.now();
    const lease = (): SlotLease => {
      let released = false;
      return {
        queuedMs: Math.max(0, this.now() - since),
        release: () => {
          if (released) return;
          released = true;
          st.inFlight = Math.max(0, st.inFlight - 1);
          const next = st.waiters.shift();
          if (next) next.resolve();
        },
      };
    };
    const slots = this.slotsOf(id);
    if (slots === undefined || st.inFlight < slots) {
      st.inFlight++;
      return Promise.resolve(lease());
    }
    return new Promise<SlotLease>((resolve, reject) => {
      const waiter = {
        since,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          st.inFlight++;
          resolve(lease());
        },
      };
      const onAbort = () => {
        st.waiters = st.waiters.filter((w) => w !== waiter);
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      st.waiters.push(waiter);
    });
  }

  /** The endpoint's key from `safeStorage`, if it has one. */
  async key(id: string): Promise<string | undefined> {
    const cfg = this.endpoint(id);
    if (!cfg?.hasKey || !this.deps.secrets) return undefined;
    return this.deps.secrets.get(endpointKeyRef(id));
  }

  /** How Codex reaches a local model (§19.6 slice B): a model provider on the endpoint's `/v1`, Responses wire. */
  codexProvider(source: ModelSourceId, model?: string): CodexModelProvider | undefined {
    const id = endpointIdOf(source);
    const cfg = id ? this.endpoint(id) : undefined;
    if (!id || !cfg || !endpointEnabled(cfg)) return undefined;
    const report = model ? this.reports().find((r) => r.descriptor.source === source && r.descriptor.modelId === model) : undefined;
    const window = report && isKnown(report.descriptor.contextWindow) ? report.descriptor.contextWindow.value : undefined;
    const maxOut = report && isKnown(report.descriptor.maxOutputTokens) ? report.descriptor.maxOutputTokens.value : undefined;
    return {
      id: `aw-${id}`,
      name: `Agent Wrangler: ${cfg.name}`,
      baseUrl: `${cfg.url}/v1`,
      ...(window ? { contextWindow: window } : {}),
      ...(maxOut ? { maxOutputTokens: maxOut } : {}),
      ...(cfg.hasKey ? { keyRef: endpointKeyRef(id) } : {}),
      ...(cfg.codexModelCatalog ? { modelCatalog: cfg.codexModelCatalog } : {}),
    };
  }

  /** Session-scoped native Messages endpoint. The key itself stays in safeStorage. */
  claudeProvider(source: ModelSourceId, model: string): ClaudeLocalProvider | undefined {
    const id = endpointIdOf(source);
    const cfg = id ? this.endpoint(id) : undefined;
    const probe = id ? this.stored.probes[id] : undefined;
    if (!id || !cfg || !endpointEnabled(cfg) || !probe || !isKnown(probe.routes.messages) || probe.routes.messages.value !== true) return undefined;
    const report = this.reports().find((r) => r.descriptor.source === source && r.descriptor.modelId === model);
    if (!report || !isKnown(report.descriptor.contextWindow)) return undefined;
    return {
      source,
      // Claude Code appends /v1/messages to ANTHROPIC_BASE_URL itself.
      baseUrl: cfg.url,
      model,
      contextWindow: report.descriptor.contextWindow.value,
      ...(isKnown(report.descriptor.maxOutputTokens) ? { maxOutputTokens: report.descriptor.maxOutputTokens.value } : {}),
      ...(cfg.hasKey ? { keyRef: endpointKeyRef(id) } : {}),
    };
  }

  /** What an attempt record says about a run on this endpoint's model: runtime, device, context window. */
  runFacts(source: ModelSourceId, model: string): Omit<LocalRunMetrics, 'source'> | undefined {
    const id = endpointIdOf(source);
    const cfg = id ? this.endpoint(id) : undefined;
    if (!id || !cfg) return undefined;
    const probe = this.stored.probes[id];
    const report = this.reports().find((r) => r.descriptor.source === source && r.descriptor.modelId === model);
    return {
      ...(probe && isKnown(probe.runtime) ? { runtime: probe.runtime.value } : {}),
      ...(cfg.device ? { device: cfg.device } : {}),
      ...(report && isKnown(report.descriptor.contextWindow) ? { contextWindow: report.descriptor.contextWindow.value } : {}),
      ...(endpointIsLocal(cfg) ? {} : { external: true }),
    };
  }

  /** A key by its ref, for the Codex runner to put on a thread's provider. Never stored with the thread. */
  keyByRef(ref: string): Promise<string | undefined> {
    const id = ref.startsWith('localEndpoint:') ? ref.slice('localEndpoint:'.length) : undefined;
    return id ? this.key(id) : Promise.resolve(undefined);
  }

  /** The completion client for one catalog entry. */
  completionFor(entry: CatalogEntry): StructuredCompletion {
    const d = entry.descriptor;
    const id = endpointIdOf(d.source)!;
    const cfg = this.endpoint(id)!;
    const probe = this.stored.probes[id];
    const target: LocalCompletionTarget = {
      source: d.source,
      baseUrl: cfg.url,
      model: d.modelId,
      ...(isKnown(d.structuredOutput) ? { structuredOutput: d.structuredOutput.value } : {}),
      ...(isKnown(d.contextWindow) ? { contextWindow: d.contextWindow.value } : {}),
      ...(probe && isKnown(probe.runtime) ? { runtime: probe.runtime.value } : {}),
      ...(cfg.device ? { device: cfg.device } : {}),
      ...(endpointIsLocal(cfg) ? {} : { external: true }),
      key: () => this.key(id),
    };
    return new LocalStructuredCompletion(target, {
      fetch: this.deps.fetch,
      acquire: (s, signal) => this.acquire(s, signal),
      onConnectionLost: (s) => void this.connectionLost(s),
      log: this.log,
    });
  }

  /**
   * The local model completions go to now, if any (§6.1: completions route to
   * the weakest tier): one serving completions at that tier, on an endpoint
   * that is not down. Constrained decoding first, then catalog order.
   */
  pickCompletion(catalog: CapabilityCatalogView): CatalogEntry | undefined {
    const weakest = catalog.tiers[0]?.name;
    const candidates = catalog.entries.filter(
      (e) => e.completions && e.tier === weakest && this.status(e.descriptor.source).health.state !== 'down',
    );
    const rank = (e: CatalogEntry) => (isKnown(e.descriptor.structuredOutput) && e.descriptor.structuredOutput.value === 'schema' ? 0 : 1);
    return candidates.sort((a, b) => rank(a) - rank(b))[0];
  }

  /** The local model the planner uses now, if any (§11.5): `pickPlannerEntry` over this service's health. */
  pickPlanner(catalog: CapabilityCatalogView, opts: { excludeSources?: readonly ModelSourceId[] } = {}): LocalPlannerPick | undefined {
    return pickPlannerEntry(catalog, (s) => this.status(s).health.state !== 'reachable', opts);
  }

  /** Record a direct call's outcome in telemetry. */
  recordCall(record: Omit<LocalCallRecord, 'v' | 'type' | 'at' | 'id'> & { id?: string }): void {
    const at = this.now();
    const full: LocalCallRecord = {
      v: TELEMETRY_SCHEMA_VERSION,
      type: 'local-call',
      at,
      id: record.id ?? `local-call:${at}:${Math.random().toString(36).slice(2, 10)}`,
      ...record,
    };
    try {
      this.deps.telemetry?.append(full);
    } catch (e) {
      this.log(`local: could not write a call record: ${String(e)}`);
    }
  }

  /** Apply a change from Preferences. Lines are what the window shows beside the endpoint. */
  async apply(change: LocalEndpointChange): Promise<{ ok: boolean; lines: string[] }> {
    const list = this.endpoints();
    switch (change.op) {
      case 'add': {
        const r = addEndpoint(list, change);
        if (!r.ok) return { ok: false, lines: [`✗  ${r.error}`] };
        await this.write(r.list);
        const e = r.endpoint;
        if (!endpointIsLocal(e)) {
          const own = isPrivateNetworkUrl(e.url) ? ' If it is your own machine on this network, mark it as yours to treat it as local.' : '';
          return { ok: true, lines: [`Added ${e.name}. It is not on this machine, so it is off: ${DATA_LEAVES_MACHINE} once you turn it on.${own}`] };
        }
        await this.probe(e.id);
        return { ok: true, lines: [`Added ${e.name}.`] };
      }
      case 'remove': {
        const cfg = list.find((e) => e.id === change.id);
        if (!cfg) return { ok: false, lines: ['✗  No such endpoint.'] };
        await this.write(list.filter((e) => e.id !== change.id));
        if (cfg.hasKey) await this.deps.secrets?.delete(endpointKeyRef(cfg.id)).catch(() => undefined);
        const { [cfg.id]: _p, ...probes } = this.stored.probes;
        const { [cfg.id]: _q, ...qualifications } = this.stored.qualifications;
        const { [cfg.id]: _t, ...tasks } = this.stored.tasks ?? {};
        this.stored = { ...this.stored, probes, qualifications, tasks };
        this.save();
        this.states.delete(cfg.id);
        this.changed();
        return { ok: true, lines: [`Removed ${cfg.name}. Its tier choices stay in settings in case it comes back.`] };
      }
      case 'enable': {
        const cfg = list.find((e) => e.id === change.id);
        if (!cfg) return { ok: false, lines: ['✗  No such endpoint.'] };
        const next = list.map((e) => {
          if (e.id !== change.id) return e;
          const { enabled: _e, ...rest } = e;
          // Stored by absence when it matches the default (local on, anything else off).
          return change.enabled === endpointIsLocal(e) ? rest : { ...rest, enabled: change.enabled };
        });
        await this.write(next);
        if (change.enabled) await this.probe(change.id);
        else this.changed();
        return { ok: true, lines: [] };
      }
      case 'setLocal': {
        const cfg = list.find((e) => e.id === change.id);
        if (!cfg) return { ok: false, lines: ['✗  No such endpoint.'] };
        if (change.local && !isPrivateNetworkUrl(cfg.url)) {
          return { ok: false, lines: ['✗  Only an endpoint on a private address or home network name can be treated as local.'] };
        }
        // On or off stays as it was: the default moves with the location, so store it when it no longer matches.
        const on = endpointEnabled(cfg);
        const { location: _l, enabled: _e, ...rest } = cfg;
        const moved: LocalEndpointConfig = change.local ? { ...rest, location: 'local' } : rest;
        const next = on === endpointIsLocal(moved) ? moved : { ...moved, enabled: on };
        await this.write(list.map((e) => (e.id === cfg.id ? next : e)));
        if (on) await this.probe(cfg.id);
        else this.changed();
        return { ok: true, lines: [change.local ? `${cfg.name} is treated as local: its data stays on your network.` : `${cfg.name} is treated as external again: ${DATA_LEAVES_MACHINE}.`] };
      }
      case 'setKey': {
        const cfg = list.find((e) => e.id === change.id);
        if (!cfg) return { ok: false, lines: ['✗  No such endpoint.'] };
        if (!this.deps.secrets?.available) return { ok: false, lines: ['✗  This system cannot store secrets securely, so no key was saved.'] };
        const key = await this.deps.promptKey?.(cfg);
        if (key === undefined) return { ok: false, lines: [] };
        if (key.trim() === '') return { ok: false, lines: ['✗  No key was entered.'] };
        await this.deps.secrets.store(endpointKeyRef(cfg.id), key.trim());
        await this.write(list.map((e) => (e.id === cfg.id ? { ...e, hasKey: true } : e)));
        if (endpointEnabled(cfg)) await this.probe(cfg.id);
        return { ok: true, lines: ['Key stored in the system keychain.'] };
      }
      case 'clearKey': {
        const cfg = list.find((e) => e.id === change.id);
        if (!cfg) return { ok: false, lines: ['✗  No such endpoint.'] };
        await this.deps.secrets?.delete(endpointKeyRef(cfg.id));
        await this.write(list.map((e) => (e.id === cfg.id ? (({ hasKey: _k, ...rest }) => rest)(e) : e)));
        return { ok: true, lines: ['Key removed.'] };
      }
      case 'probe': {
        const cfg = list.find((e) => e.id === change.id);
        if (!cfg) return { ok: false, lines: ['✗  No such endpoint.'] };
        if (!endpointEnabled(cfg)) return { ok: false, lines: ['✗  Turn it on first.'] };
        await this.probe(cfg.id);
        const p = this.stored.probes[cfg.id];
        return p?.reachable ? { ok: true, lines: [reachableReason(p)] } : { ok: false, lines: [`✗  ${p?.error ?? 'unreachable'}`] };
      }
      case 'qualify':
        return this.qualify(change.id, change.model, change.harness ?? 'codex');
      case 'qualifyTasks':
        return this.qualifyTasks(change.id, change.model, change.harness ?? 'codex');
      case 'cancelQualifyTasks':
        return this.cancelQualifyTasks(change.id, change.model);
    }
  }

  /** Stage 2's runner for a native harness. Without one, stage 2 says it is unavailable. */
  useTaskQualifier(q: TaskQualifier | undefined, harness: HarnessId = 'codex'): void {
    this.taskQualifiers[harness] = q;
  }

  /** Stage 2's stored result for one model. */
  taskQualification(id: string, model: string, harness: HarnessId = 'codex'): TaskQualification | undefined {
    return this.stored.tasks?.[id]?.[model]?.[harness];
  }

  /**
   * Stage 2 of §19.6's qualification for one model: the scratch-repo fixtures,
   * k = 3 each, through the selected harness on this endpoint. Results are `measured`,
   * stored beside stage 1's, and each run is a `local-call` record with
   * purpose `qualification`. Nothing here, or anywhere, sets a tier from them.
   *
   * An endpoint without that harness's native route cannot run it, so stage 2 is
   * recorded as not runnable, with no pass rate.
   */
  async qualifyTasks(id: string, model: string, harness: HarnessId = 'codex'): Promise<{ ok: boolean; lines: string[] }> {
    const cfg = this.endpoint(id);
    const probe = this.stored.probes[id];
    if (!cfg || !probe?.models.some((m) => m.id === model)) return { ok: false, lines: ['✗  That model is not listed by the endpoint.'] };
    if (!endpointEnabled(cfg)) return { ok: false, lines: ['✗  Turn the endpoint on first.'] };
    const flag = `${id}\0${model}\0${harness}`;
    if (this.qualifyingTasks.has(flag) || this.qualifying.has(flag)) return { ok: false, lines: ['Already running.'] };
    const route = harness === 'codex' ? probe.routes.responses : probe.routes.messages;
    const supported = isKnown(route) ? route.value : undefined;
    const routeName = harness === 'codex' ? '/v1/responses' : '/v1/messages';
    if (supported !== true) {
      const q: TaskQualification = {
        model,
        at: this.now(),
        runnable: false,
        reason: supported === false ? `no ${routeName}` : `no ${routeName} (the probe could not tell; probe again)`,
      };
      this.storeTasks(id, model, harness, q);
      this.changed();
      return { ok: false, lines: [taskQualificationText(q)] };
    }
    const s1 = this.stored.qualifications[id]?.[model]?.[harness];
    if (s1 && !s1.error && s1.verdict === 'completion-only') {
      return { ok: false, lines: ['✗  Stage 1 found it completion-only (its tool calls do not parse), so the tasks would not be run.'] };
    }
    const run = this.taskQualifiers[harness];
    if (!run) return { ok: false, lines: [`✗  Task qualification is not available: there is no ${harness} harness to run it through.`] };

    const progress: { done: number; passed: number; total?: number; cancel: AbortController } = { done: 0, passed: 0, cancel: new AbortController() };
    this.qualifyingTasks.set(flag, progress);
    this.changed();
    const source = endpointSource(id);
    let lease: SlotLease | undefined;
    try {
      // One slot for the whole stage: one agent at a time on the server, and direct calls wait their turn.
      lease = await this.acquire(source);
      const queuedMs = lease.queuedMs;
      const cancelled = () => ({ ok: false, lines: [`Cancelled after ${progress.done} run${progress.done === 1 ? '' : 's'}. The last result stands.`] });
      if (progress.cancel.signal.aborted) return cancelled();
      const result = await run({
        source,
        model,
        signal: progress.cancel.signal,
        onRun: (r) => {
          progress.done++;
          if (r.pass) progress.passed++;
          this.recordCall({
            source,
            model,
            purpose: 'qualification',
            qualificationStage: 2,
            fixture: r.fixture,
            run: r.n,
            ok: r.pass,
            ...(r.pass ? {} : { failure: r.infra ? 'error' : 'failed-check' }),
            ...(r.infra ? { infra: true } : {}),
            ...(r.inputTokens !== undefined ? { inputTokens: r.inputTokens } : {}),
            ...(r.outputTokens !== undefined ? { outputTokens: r.outputTokens } : {}),
            durationMs: r.wallMs,
            attempts: 1,
            local: {
              source,
              ...(isKnown(probe.runtime) ? { runtime: probe.runtime.value } : {}),
              ...(cfg.device ? { device: cfg.device } : {}),
              ...(progress.done === 1 && queuedMs ? { queueMs: queuedMs } : {}),
              ...(endpointIsLocal(cfg) ? {} : { external: true }),
            },
          });
          this.changed();
        },
        onStart: (total) => {
          progress.total = total;
          this.changed();
        },
      }).catch((e: unknown) => ({ runs: [] as TaskRun[], k: 0, error: String((e as Error)?.message ?? e) }));
      // A part-run stage is not a result: it would be judged on whichever fixtures came first.
      if (progress.cancel.signal.aborted) return cancelled();
      if (result.runs.length === 0) {
        // Nothing ran: the last result, if any, still stands.
        return { ok: false, lines: [`✗  Task qualification could not run: ${result.error ?? 'no fixtures'}`] };
      }
      const q = summariseTaskRuns(model, this.now(), result.k, result.runs, result.error);
      this.storeTasks(id, model, harness, q);
      return { ok: !result.error, lines: [taskQualificationText(q)] };
    } finally {
      lease?.release();
      this.qualifyingTasks.delete(flag);
      this.changed();
    }
  }

  /**
   * Stop a running stage 2 for one model (#160). The run in progress is
   * interrupted and its session ended; no more start; nothing is stored, so
   * the last result stands.
   */
  cancelQualifyTasks(id: string, model: string): { ok: boolean; lines: string[] } {
    const running = (['codex', 'claude-code'] as const).map((h) => this.qualifyingTasks.get(`${id}\0${model}\0${h}`)).filter((p) => p !== undefined);
    if (running.length === 0) return { ok: false, lines: ['Task qualification is not running.'] };
    for (const p of running) p.cancel.abort();
    return { ok: true, lines: ['Cancelling: the current run is being ended.'] };
  }

  private storeTasks(id: string, model: string, harness: HarnessId, q: TaskQualification): void {
    const tasks = this.stored.tasks ?? {};
    this.stored = { ...this.stored, tasks: { ...tasks, [id]: { ...tasks[id], [model]: { ...tasks[id]?.[model], [harness]: q } } } };
    this.save();
  }

  /** Stage 1 of §19.6's qualification for one model: tool calls, round trips, JSON. Results are `measured` facts. */
  async qualify(id: string, model: string, harness: HarnessId = 'codex'): Promise<{ ok: boolean; lines: string[] }> {
    if (harness === 'claude-code') return { ok: false, lines: ['Claude Code qualification runs through Qualify tasks on native /v1/messages.'] };
    const cfg = this.endpoint(id);
    const probe = this.stored.probes[id];
    if (!cfg || !probe?.models.some((m) => m.id === model)) return { ok: false, lines: ['✗  That model is not listed by the endpoint.'] };
    if (!endpointEnabled(cfg)) return { ok: false, lines: ['✗  Turn the endpoint on first.'] };
    const route = harness === 'codex' ? probe.routes.responses : probe.routes.messages;
    if (!isKnown(route) || route.value !== true) return { ok: false, lines: [`✗  ${harness} needs its native endpoint route.`] };
    const flag = `${id}\0${model}\0${harness}`;
    if (this.qualifying.has(flag) || this.qualifyingTasks.has(flag)) return { ok: false, lines: ['Already running.'] };
    this.qualifying.add(flag);
    this.changed();
    const started = this.now();
    let lease: SlotLease | undefined;
    try {
      lease = await this.acquire(endpointSource(id));
      const q = await qualifyModel(cfg, model, {
        fetch: this.deps.fetch,
        key: await this.key(id),
        structuredOutput: isKnown(probe.structuredOutput) ? probe.structuredOutput.value : undefined,
        runs: this.deps.qualifyRuns,
        now: this.now,
      });
      this.stored = {
        ...this.stored,
        qualifications: { ...this.stored.qualifications, [id]: { ...this.stored.qualifications[id], [model]: { ...this.stored.qualifications[id]?.[model], [harness]: q } } },
      };
      this.save();
      this.recordCall({
        source: endpointSource(id),
        model,
        purpose: 'qualification',
        ok: !q.error,
        ...(q.error ? { failure: 'error' } : {}),
        durationMs: Math.max(0, this.now() - started),
        attempts: 1,
        local: {
          source: endpointSource(id),
          ...(isKnown(probe.runtime) ? { runtime: probe.runtime.value } : {}),
          ...(cfg.device ? { device: cfg.device } : {}),
          ...(q.throughput ? { ttftMs: q.throughput.ttftMs, outTokPerSec: q.throughput.outTokPerSec, tokPerSecFrom: 'client' as const } : {}),
          ...(lease.queuedMs ? { queueMs: lease.queuedMs } : {}),
        },
      });
      return { ok: !q.error, lines: [qualificationText(q)] };
    } finally {
      lease?.release();
      this.qualifying.delete(flag);
      this.changed();
    }
  }

  /** What Preferences shows. */
  view(catalog?: CapabilityCatalogView): LocalEndpointView[] {
    return this.endpoints().map((e) => {
      const probe = this.stored.probes[e.id];
      const source = endpointSource(e.id);
      const status = this.status(source);
      const loopback = isLoopbackUrl(e.url);
      const local = endpointIsLocal(e);
      const slots = this.slotsOf(e.id);
      const quals = this.stored.qualifications[e.id] ?? {};
      return {
        id: e.id,
        name: e.name,
        url: e.url,
        source,
        enabled: endpointEnabled(e),
        loopback,
        ...(!loopback && isPrivateNetworkUrl(e.url) ? { trustable: true } : {}),
        ...(!loopback && local ? { trustedLocal: true } : {}),
        ...(local ? {} : { warning: DATA_LEAVES_MACHINE }),
        hasKey: !!e.hasKey,
        health: status.health,
        ...(probe && isKnown(probe.runtime) ? { runtime: `${probe.runtime.value} (${probe.runtime.from})` } : {}),
        ...(slots !== undefined ? { slots: `${slots} (${probe && isKnown(probe.slots) ? 'probed' : 'declared'})` } : {}),
        routes: probe ? routesText(probe) : 'not probed',
        ...(probe && isKnown(probe.routes.responses) ? { responses: probe.routes.responses.value } : {}),
        ...(probe && isKnown(probe.routes.messages) ? { messages: probe.routes.messages.value } : {}),
        ...(probe ? { probedAt: probe.at } : {}),
        ...(probe?.error ? { error: probe.error } : {}),
        busy: this.probing.has(e.id),
        models: (probe?.models ?? []).map((m): LocalEndpointModelView => {
          const key = `${source}:${m.id}`;
          const byHarness = quals[m.id] ?? {};
          const q = byHarness.codex ?? byHarness['claude-code'];
          const tasks = this.stored.tasks?.[e.id]?.[m.id];
          const t = tasks?.codex ?? tasks?.['claude-code'];
          const running = this.qualifyingTasks.get(`${e.id}\0${m.id}\0codex`) ?? this.qualifyingTasks.get(`${e.id}\0${m.id}\0claude-code`);
          const entry = catalog?.entries.find((x) => x.key === key);
          const window = entry && isKnown(entry.descriptor.contextWindow) ? entry.descriptor.contextWindow.value : undefined;
          return {
            id: m.id,
            label: entry?.descriptor.label ?? shortModelName(m.id),
            harnesses: entry?.harnesses.filter((h): h is 'codex' | 'claude-code' => h === 'codex' || h === 'claude-code'),
            qualifications: Object.fromEntries(Object.entries(byHarness).filter((pair): pair is [string, Qualification] => pair[1] !== undefined).map(([h, result]) => [h, qualificationText(result)])),
            taskQualifications: Object.fromEntries(Object.entries(tasks ?? {}).filter((pair): pair is [string, TaskQualification] => pair[1] !== undefined).map(([h, result]) => [h, taskQualificationText(result)])),
            key,
            ...(q ? { qualification: Object.entries(byHarness).filter((pair): pair is [string, Qualification] => pair[1] !== undefined).map(([h, result]) => `${h}: ${qualificationText(result)}`).join(' · '), stage1: { verdict: q.verdict, toolCalls: q.toolCalls, ...(q.error ? { error: q.error } : {}) } } : {}),
            ...(this.qualifying.has(`${e.id}\0${m.id}\0codex`) || this.qualifying.has(`${e.id}\0${m.id}\0claude-code`) ? { qualifying: true } : {}),
            ...(t ? { tasks: taskQualificationText(t) } : {}),
            ...(running ? { tasksRunning: `Running tasks: ${running.done}${running.total ? `/${running.total}` : ''} done, ${running.passed} passed` } : {}),
            plannerWindowFits: window !== undefined && contextLimits(window) !== undefined,
          };
        }),
      };
    });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.sub?.dispose();
    this.emitter.dispose();
    this.downEmitter.dispose();
  }

  private async configChanged(): Promise<void> {
    // A new endpoint, or one just turned on: probe it. One turned off: forget its health.
    for (const e of this.endpoints()) {
      if (endpointEnabled(e) && !this.stored.probes[e.id]) void this.probe(e.id);
      if (!endpointEnabled(e)) this.states.delete(e.id);
    }
    this.changed();
  }

  private async write(list: LocalEndpointConfig[]): Promise<void> {
    await this.deps.settings.update(LOCAL_ENDPOINTS_KEY, list.length > 0 ? list : undefined);
  }

  private state(id: string): EndpointState {
    let st = this.states.get(id);
    if (!st) {
      st = { health: unknownHealth('Not probed yet'), failures: 0, inFlight: 0, waiters: [] };
      this.states.set(id, st);
    }
    return st;
  }

  private save(): void {
    void this.deps.storage?.update(STORAGE_KEY, this.stored);
  }

  private changed(): void {
    this.emitter.fire();
  }
}

/**
 * The tier a local model must have to plan (§11.5): `standard` or above.
 * Completions go to the weakest tier because assessment is a small,
 * well-bounded judgement. A plan is not: it has to read an excerpt of a
 * repository and scope work, so a `basic` model is not asked. `expert` is not
 * required either, because the plan is checked deterministically, repaired
 * once, falls back to the hosted planner on failure, and is always reviewed by
 * the user before anything runs. With a tier list that has no `standard`, the
 * weakest tier is the one left out. Declared in `shared/orchestration/localReadiness.ts`,
 * so Preferences' status line applies the same rule.
 */
export { PLANNER_LOCAL_MIN_TIER };
/** The local planner's model, and the window its budget is sized to. */
export interface LocalPlannerPick {
  entry: CatalogEntry;
  contextWindow: number;
  /** The window is the catalog's (`probed`, `declared` or `measured`). */
  windowKnown: boolean;
}

/**
 * Pick the local model the planner uses (§11.5), or none. A candidate serves
 * completions (an endpoint's model, the endpoint on: loopback, or an external
 * one the user turned on), is enabled, has a tier
 * of at least `PLANNER_LOCAL_MIN_TIER`, is not on an endpoint that is down,
 * and has a window a repository excerpt fits in (`contextLimits`). Among
 * those: the lowest sufficient tier, then constrained decoding, then the largest known
 * window (an unknown one is ineligible), then
 * catalog order. Pure.
 */
export function pickPlannerEntry(
  catalog: CapabilityCatalogView,
  isDown: (source: ModelSourceId) => boolean,
  opts: { excludeSources?: readonly ModelSourceId[] } = {},
): LocalPlannerPick | undefined {
  const min = plannerMinRank(catalog.tiers);
  const excluded = new Set(opts.excludeSources ?? []);
  const picks = catalog.entries
    .map((entry, order) => {
      const d = entry.descriptor;
      const windowKnown = isKnown(d.contextWindow);
      const contextWindow = isKnown(d.contextWindow) ? d.contextWindow.value : 0;
      return { entry, order, windowKnown, contextWindow, rank: tierRank(catalog.tiers, entry.tier) };
    })
    .filter(
      (c) =>
        c.entry.completions === true &&
        c.windowKnown &&
        c.entry.enabled &&
        c.entry.tier !== undefined &&
        c.rank >= min &&
        !excluded.has(c.entry.descriptor.source) &&
        !isDown(c.entry.descriptor.source) &&
        contextLimits(c.contextWindow) !== undefined,
    );
  const schema = (e: CatalogEntry) => (isKnown(e.descriptor.structuredOutput) && e.descriptor.structuredOutput.value === 'schema' ? 0 : 1);
  picks.sort(
    (a, b) =>
      a.rank - b.rank ||
      schema(a.entry) - schema(b.entry) ||
      Number(b.windowKnown) - Number(a.windowKnown) ||
      b.contextWindow - a.contextWindow ||
      a.order - b.order,
  );
  const p = picks[0];
  return p ? { entry: p.entry, contextWindow: p.contextWindow, windowKnown: p.windowKnown } : undefined;
}

function reachableReason(p: EndpointProbe): string {
  const runtime = isKnown(p.runtime) ? p.runtime.value : 'server';
  return `${runtime} · ${p.models.length} model${p.models.length === 1 ? '' : 's'}`;
}

function routesText(p: EndpointProbe): string {
  const one = (name: string, k: EndpointProbe['routes']['responses']) => `${name} ${isKnown(k) ? (k.value ? 'yes' : 'no') : 'unknown'}`;
  return `${one('/v1/responses (Codex)', p.routes.responses)} · ${one('/v1/messages (Claude Code)', p.routes.messages)}`;
}

export function qualificationText(q: Qualification): string {
  if (q.error) return `Qualification stopped: ${q.error}`;
  const parts = [
    `tool calls ${q.toolCalls.ok}/${q.toolCalls.runs}`,
    `round trips ${q.roundTrips.ok}/${q.roundTrips.runs}`,
    `JSON ${q.json.ok}/${q.json.runs}`,
    ...(q.throughput ? [`${q.throughput.outTokPerSec} tok/s`, `TTFT ${q.throughput.ttftMs} ms`] : []),
  ];
  return `${q.verdict === 'agentic' ? 'Agentic' : 'Completion only'}: ${parts.join(' · ')} (measured)`;
}

function parseStored(raw: unknown): Stored {
  const empty: Stored = { v: 1, probes: {}, qualifications: {} };
  if (!raw || typeof raw !== 'object') return empty;
  const s = raw as Partial<Stored>;
  if (s.v !== 1) return empty;
  const probes: Record<string, EndpointProbe> = {};
  for (const [id, p] of Object.entries(s.probes ?? {})) {
    if (p && typeof p === 'object' && typeof p.at === 'number' && Array.isArray(p.models) && p.routes && p.runtime && p.slots && p.structuredOutput) {
      probes[id] = { ...p, healthPath: typeof p.healthPath === 'string' ? p.healthPath : '/v1/models' };
    }
  }
  const qualifications: Stored['qualifications'] = {};
  for (const [id, byModel] of Object.entries(s.qualifications ?? {})) {
    if (!byModel || typeof byModel !== 'object') continue;
    const ok: Record<string, Partial<Record<HarnessId, Qualification>>> = {};
    for (const [model, q] of Object.entries(byModel)) {
      if (!q || typeof q !== 'object') continue;
      const legacy = q as unknown as Qualification;
      const saved = q as Partial<Record<HarnessId, Qualification>>;
      const valid = (v: Qualification | undefined) => v && (v.toolCalling === 'basic' || v.toolCalling === 'none' || v.toolCalling === 'reliable');
      ok[model] = legacy.toolCalling ? { codex: legacy } : { ...(valid(saved.codex) ? { codex: saved.codex } : {}), ...(valid(saved['claude-code']) ? { 'claude-code': saved['claude-code'] } : {}) };
    }
    qualifications[id] = ok;
  }
  const tasks: NonNullable<Stored['tasks']> = {};
  for (const [id, byModel] of Object.entries(s.tasks ?? {})) {
    if (!byModel || typeof byModel !== 'object') continue;
    const ok: Record<string, Partial<Record<HarnessId, TaskQualification>>> = {};
    for (const [model, q] of Object.entries(byModel)) {
      const legacy = parseTaskQualification(q);
      const saved = q as Partial<Record<HarnessId, TaskQualification>>;
      ok[model] = legacy ? { codex: legacy } : { ...(parseTaskQualification(saved?.codex) ? { codex: saved.codex } : {}), ...(parseTaskQualification(saved?.['claude-code']) ? { 'claude-code': saved['claude-code'] } : {}) };
    }
    tasks[id] = ok;
  }
  return { v: 1, probes, qualifications, tasks };
}

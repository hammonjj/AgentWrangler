/**
 * Live check of the Codex local-provider path (plan §19.7): a Codex thread on
 * a local server's native `/v1/responses`, driven through the same code the
 * app uses — `CodexHarness` → `CodexRunnerService` → `codexThreadParams` —
 * against a real `codex app-server --stdio`.
 *
 * It answers §19.7's three questions:
 *   (a) thread/start and thread/resume accept `modelProvider` plus a
 *       free-form `config.model_providers.<id>`;
 *   (b) `experimental_bearer_token` on that per-thread provider is sent;
 *   (c) `model_catalog_json` adds to Codex's catalog or replaces it.
 *
 * Isolation: it refuses to run unless CODEX_HOME is a directory under the
 * system temp dir, and the URL is loopback. It writes only under CODEX_HOME
 * and the scratch dir it is given. It installs and starts nothing but the
 * app-server child, which exits with it.
 *
 * Usage (see docs/plans/intelligent-orchestration.md §19.7 for the full run):
 *   CODEX_HOME=$(mktemp -d) AW_LIVE_KEY=<key the server was started with> \
 *     npx vite-node scripts/local-models/codex-live-check.ts -- \
 *     --url http://127.0.0.1:18431 --model local-qwen --cwd <scratch dir> [--context 32768]
 *
 * `codex` is found as the app finds it (`resolveCodexBinary`); set
 * CODEX_BINARY to use another.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer, type RpcNotification } from '../../src/codex/appServer';
import { resolveCodexBinary } from '../../src/codex/binary';
import { CodexRunnerService } from '../../src/codex/runner';
import { CodexHarness } from '../../src/orchestration/harness/codexHarness';
import type { CodexModelProvider, LaunchPolicy } from '../../src/shared/launchPolicy';
import { endpointKeyRef, isLoopbackUrl, normaliseEndpointUrl } from '../../src/shared/orchestration/localEndpoints';

type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'INFO';
const results: { check: string; verdict: Verdict; detail: string }[] = [];
function report(check: string, verdict: Verdict, detail: string): void {
  results.push({ check, verdict, detail });
  console.log(`[${verdict}] ${check}: ${detail}`);
}

function args(): Record<string, string> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = 'true';
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const opts = args();
const codexHome = process.env.CODEX_HOME;
if (!codexHome) fail('Set CODEX_HOME to a fresh temp dir (CODEX_HOME=$(mktemp -d)). This never runs against ~/.codex.');
const realHome = realpathSync(codexHome);
if (!realHome.startsWith(realpathSync(tmpdir())) && !realHome.startsWith('/private/tmp/') && !realHome.startsWith('/tmp/')) {
  fail(`CODEX_HOME must be under the temp dir, not ${realHome}.`);
}
if (realHome === join(homedir(), '.codex')) fail('CODEX_HOME must not be ~/.codex.');
const url = normaliseEndpointUrl(opts.url ?? '');
if (!url || !isLoopbackUrl(url)) fail('--url must be a loopback http URL, e.g. http://127.0.0.1:18431');
const model = opts.model ?? fail('--model is required (the id the server answers to; llama-server takes any).');
const cwd = opts.cwd ?? fail('--cwd is required: a scratch directory for the thread.');
const contextWindow = opts.context ? Number(opts.context) : undefined;
const key = process.env.AW_LIVE_KEY || undefined;
const binary = resolveCodexBinary(process.env.CODEX_BINARY ?? 'codex');
const TURN_TIMEOUT_MS = Number(opts.timeout ?? 240_000);

console.log(`codex: ${execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()}`);
console.log(`server: ${url} · model: ${model} · key: ${key ? 'set' : 'none'} · CODEX_HOME: temp`);

// ---- (c) catalog: what `model_catalog_json` does to Codex's list -------------------

/** Codex's own catalog, as `codex debug models` renders it, optionally with config overrides. */
function catalogSlugs(overrides: string[] = []): string[] {
  const out = execFileSync(binary, ['debug', 'models', ...overrides.flatMap((o) => ['-c', o])], { encoding: 'utf8', env: process.env });
  return (JSON.parse(out).models as { slug: string }[]).map((m) => m.slug);
}

/**
 * A one-model catalog for the local model, cloned from a non-lite hosted entry
 * with `apply_patch_tool_type: "freeform"` (§19.6: the only shape that parses).
 */
function writeLocalCatalog(): string {
  const all = JSON.parse(execFileSync(binary, ['debug', 'models'], { encoding: 'utf8', env: process.env })).models as Record<string, unknown>[];
  const base = all.find((m) => m.use_responses_lite === false && m.apply_patch_tool_type === 'freeform') ?? all[0];
  const entry = {
    ...base,
    slug: model,
    display_name: model,
    description: 'Local model (Agent Wrangler live check)',
    apply_patch_tool_type: 'freeform',
    use_responses_lite: false,
    ...(contextWindow ? { context_window: contextWindow, max_context_window: contextWindow } : {}),
  };
  const file = join(realHome, 'aw-local-catalog.json');
  writeFileSync(file, JSON.stringify({ models: [entry] }, null, 2));
  console.log(`catalog: one entry cloned from ${String(base.slug)}`);
  return file;
}

const hosted = catalogSlugs();
const catalogFile = writeLocalCatalog();
const withCatalog = catalogSlugs([`model_catalog_json=${JSON.stringify(catalogFile)}`]);
const kept = hosted.filter((s) => withCatalog.includes(s));
report(
  '(c) model_catalog_json, config level',
  'INFO',
  kept.length === 0
    ? `replaces: ${hosted.length} built-in models → ${withCatalog.length} (${withCatalog.join(', ')})`
    : `adds: ${hosted.length} built-in models → ${withCatalog.length}, ${kept.length} kept`,
);

// ---- the app's own code, on a real app-server ------------------------------------

interface Watch {
  server: CodexAppServer;
  events: RpcNotification[];
  stop(): void;
}

function openServer(): Watch {
  const events: RpcNotification[] = [];
  const server = new CodexAppServer(() => binary, (m) => { if (opts.verbose) console.log(m); });
  const sub = server.onNotification((e) => events.push(e));
  return { server, events, stop: () => { sub.dispose(); server.dispose(); } };
}

/**
 * Records the params the runner sent, key redacted, so the report shows
 * exactly what went over the wire. `extraConfig` is merged into a thread
 * call's `config` for the one experiment the app does not do itself
 * (a per-thread `model_catalog_json`).
 */
function recordRequests(server: CodexAppServer, sink: { method: string; params: unknown }[], extraConfig?: Record<string, unknown>): void {
  const original = server.request.bind(server);
  server.request = (async (method: string, params?: any) => {
    if (method.startsWith('thread/')) {
      if (extraConfig) params = { ...params, config: { ...params?.config, ...extraConfig } };
      sink.push({ method, params: JSON.parse(JSON.stringify(params ?? {}).replaceAll(key ?? '\u0000', '<redacted>')) });
    }
    return original(method, params);
  }) as typeof server.request;
}

function provider(withKey: boolean): CodexModelProvider {
  return {
    id: 'aw-live',
    name: 'Agent Wrangler: live check',
    baseUrl: `${url}/v1`,
    ...(contextWindow ? { contextWindow } : {}),
    ...(withKey ? { keyRef: endpointKeyRef('live') } : {}),
  };
}

function harnessOn(
  w: Watch,
  keyToSend: string | undefined,
  p: CodexModelProvider,
  sent: { method: string; params: unknown }[],
  extraConfig?: Record<string, unknown>,
) {
  recordRequests(w.server, sent, extraConfig);
  const service = new CodexRunnerService(w.server, undefined, { endpointKey: async () => keyToSend });
  const harness = new CodexHarness({ sessions: { launch: (r) => service.launch(r) }, models: () => [], localProvider: () => p });
  return { service, harness };
}

const POLICY: LaunchPolicy = { codex: { sandbox: 'read-only', approvalPolicy: 'never' } };
const ORIGIN = { kind: 'orchestration' as const, missionId: 'live-check', taskId: 'live-check', attemptId: 'live-check' };

interface TurnOutcome { status: string; text: string; errors: string[]; warnings: string[]; methods: string[] }

async function runTurn(
  w: Watch,
  harness: CodexHarness,
  prompt: string,
  resume?: string,
): Promise<{ threadId: string; outcome: TurnOutcome }> {
  const mark = w.events.length;
  const handle = await harness.launch({
    cwd,
    prompt,
    target: { harness: 'codex', model, source: 'local:live', effortNative: 'none' },
    origin: ORIGIN,
    policy: POLICY,
    ...(resume ? { resume } : {}),
  });
  const threadId = handle.sessionId!;
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    const mine = w.events.slice(mark).filter((e) => !e.params?.threadId || e.params.threadId === threadId);
    const done = mine.find((e) => e.method === 'turn/completed');
    if (done || Date.now() > deadline) {
      const text = mine
        .filter((e) => e.method === 'item/completed' && e.params?.item?.type === 'agentMessage')
        .map((e) => String(e.params.item.text ?? ''))
        .join('\n');
      const errors = mine.filter((e) => e.method === 'error').map((e) => JSON.stringify(e.params?.error ?? e.params).slice(0, 400));
      if (done?.params?.turn?.error) errors.push(JSON.stringify(done.params.turn.error).slice(0, 400));
      const warnings = mine.filter((e) => /warning/i.test(e.method)).map((e) => `${e.method}: ${JSON.stringify(e.params).slice(0, 300)}`);
      return {
        threadId,
        outcome: {
          status: done ? String(done.params?.turn?.status ?? 'completed') : 'timeout',
          text,
          errors,
          warnings,
          methods: [...new Set(mine.map((e) => e.method))],
        },
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function describe(o: TurnOutcome): string {
  return `status ${o.status}; reply ${JSON.stringify(o.text.slice(0, 80))}${o.errors.length ? `; errors ${o.errors.join(' | ')}` : ''}${o.warnings.length ? `; warnings ${o.warnings.join(' | ')}` : ''}`;
}

const ok = (o: TurnOutcome) => o.status === 'completed' && o.errors.length === 0 && o.text.trim() !== '';

async function main(): Promise<void> {
  mkdirSync(cwd, { recursive: true });
  const PROMPT = 'Reply with the single word OK and nothing else. Do not run any tools.';

  // (a) thread/start with modelProvider + config.model_providers, through CodexHarness.
  const sentA: { method: string; params: unknown }[] = [];
  const a = openServer();
  const { harness: hA } = harnessOn(a, key, provider(!!key), sentA);
  const start = await runTurn(a, hA, PROMPT);
  console.log(`thread/start params: ${JSON.stringify(sentA.find((s) => s.method === 'thread/start')?.params)}`);
  report('(a) thread/start: modelProvider + model_providers', ok(start.outcome) ? 'PASS' : 'FAIL', describe(start.outcome));
  a.stop();

  // (a) thread/resume on a new app-server process: the provider has to come from the params again.
  const sentB: { method: string; params: unknown }[] = [];
  const b = openServer();
  const { harness: hB } = harnessOn(b, key, provider(!!key), sentB);
  const resumed = await runTurn(b, hB, 'Reply with the single word AGAIN and nothing else.', start.threadId);
  console.log(`thread/resume params: ${JSON.stringify(sentB.find((s) => s.method === 'thread/resume')?.params)}`);
  report(
    '(a) thread/resume (new app-server process): modelProvider + model_providers',
    ok(resumed.outcome) && resumed.threadId === start.threadId ? 'PASS' : 'FAIL',
    describe(resumed.outcome),
  );
  b.stop();

  // (b) experimental_bearer_token on the per-thread provider: a wrong key and no key must both be refused.
  if (key) {
    const c = openServer();
    const { harness: hWrong } = harnessOn(c, 'wrong-key', provider(true), []);
    const wrong = await runTurn(c, hWrong, PROMPT);
    const refused = !ok(wrong.outcome) && /401|unauthori[sz]ed|invalid api key/i.test(wrong.outcome.errors.join(' '));
    report('(b) per-thread bearer: wrong key refused by the server', refused ? 'PASS' : 'FAIL', describe(wrong.outcome));
    const { harness: hNone } = harnessOn(c, undefined, provider(false), []);
    const none = await runTurn(c, hNone, PROMPT);
    const refusedNone = !ok(none.outcome) && /401|unauthori[sz]ed|invalid api key/i.test(none.outcome.errors.join(' '));
    report('(b) per-thread bearer: no key refused by the server', refusedNone ? 'PASS' : 'FAIL', describe(none.outcome));
    report('(b) per-thread bearer: right key accepted', ok(start.outcome) ? 'PASS' : 'FAIL', 'the (a) thread/start run above carried it');
    c.stop();
  } else {
    report('(b) per-thread bearer', 'SKIP', 'start the server with --api-key and set AW_LIVE_KEY to check it');
  }

  // Without a catalog entry: what Codex says about the unknown model (§19.6).
  const metadataMissing = (o: TurnOutcome) => o.warnings.some((w) => /metadata .* not found/i.test(w));
  const d = openServer();
  const { harness: hNoCat } = harnessOn(d, key, provider(!!key), []);
  const noCat = await runTurn(d, hNoCat, PROMPT);
  report('(c) no catalog entry for the model', 'INFO', describe(noCat.outcome));

  // (c) The catalog in the thread's own config (the app does not send it; this is the experiment).
  const sentCat: { method: string; params: unknown }[] = [];
  const { harness: hThreadCat } = harnessOn(d, key, provider(!!key), sentCat, { model_catalog_json: catalogFile });
  const threadCat = await runTurn(d, hThreadCat, PROMPT);
  report(
    '(c) catalog in thread/start config',
    'INFO',
    `${metadataMissing(threadCat.outcome) ? 'IGNORED: metadata still not found' : 'USED: metadata found'}; ${describe(threadCat.outcome)}`,
  );
  const listed = await d.server.request<any>('model/list', {});
  const listSlugs: string[] = (listed?.data ?? listed?.models ?? []).map((m: any) => m.model ?? m.slug ?? m.id);
  report('(c) catalog in thread/start config: model/list afterwards', 'INFO', `${listSlugs.length} models: ${listSlugs.join(', ')}`);
  d.stop();

  // The same catalog at server level (config.toml in the temp CODEX_HOME), for comparison.
  const toml = join(realHome, 'config.toml');
  writeFileSync(toml, `model_catalog_json = ${JSON.stringify(catalogFile)}\n`);
  try {
    const e = openServer();
    const { harness: hSrv } = harnessOn(e, key, provider(!!key), []);
    const srv = await runTurn(e, hSrv, PROMPT);
    report('(c) catalog at server level: local model metadata found', metadataMissing(srv.outcome) ? 'FAIL' : 'PASS', describe(srv.outcome));
    const listedSrv = await e.server.request<any>('model/list', {});
    const slugsSrv: string[] = (listedSrv?.data ?? listedSrv?.models ?? []).map((m: any) => m.model ?? m.slug ?? m.id);
    report('(c) catalog at server level: model/list', 'INFO', `${slugsSrv.length} models: ${slugsSrv.join(', ')}`);
    e.stop();
  } finally {
    rmSync(toml, { force: true });
  }

  console.log('\nSummary');
  for (const r of results) console.log(`  ${r.verdict.padEnd(4)} ${r.check}`);
  process.exit(results.some((r) => r.verdict === 'FAIL') ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

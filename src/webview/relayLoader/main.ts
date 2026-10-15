/**
 * The remote-control loader (#175; `docs/plans/remote-control-supabase.md` §1.2).
 *
 * The only thing Netlify serves. It knows nothing about any particular Mac or project: the
 * pairing link brings the project and the device key, GitHub sign-in (Supabase Auth) says who
 * is asking, and the Mac itself supplies the workbench: after connecting, the loader asks for
 * the files of the daemon's build, caches them, and builds the same page the Mac serves on
 * loopback, with the webshim's sockets carried over the relay.
 *
 * States, in order: not paired → paired, not signed in → connecting → (Mac unreachable) →
 * running the workbench. Each says what to do next.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { importRelayKey, parsePairingFragment } from '../../shared/relay';
import { RelayConnection, RelayWebSocket, type RelayDevice } from './connection';
import { forgetDevice, loadAssets, loadDevice, saveAssets, saveDevice, type StoredAssets, type StoredDevice } from './store';

const root = document.getElementById('loader') as HTMLElement;

function show(title: string, lines: string[], actions: { label: string; run: () => void; tone?: 'primary' | 'quiet' }[] = []): void {
  root.textContent = '';
  const h = document.createElement('h1');
  h.textContent = title;
  root.appendChild(h);
  for (const line of lines) {
    const p = document.createElement('p');
    p.textContent = line;
    root.appendChild(p);
  }
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.className = a.tone ?? 'primary';
    b.addEventListener('click', a.run);
    root.appendChild(b);
  }
}

async function pairFromFragment(): Promise<StoredDevice | undefined> {
  const pairing = parsePairingFragment(location.hash);
  if (!pairing) return undefined;
  // Out of the address bar and the history at once: the key must not linger there.
  history.replaceState(null, '', location.pathname + location.search);
  const device: StoredDevice = {
    deviceId: pairing.deviceId,
    key: await importRelayKey(pairing.key),
    project: pairing.project,
    pairedAt: Date.now(),
  };
  await saveDevice(device);
  return device;
}

function supabaseFor(device: StoredDevice): SupabaseClient {
  return createClient(device.project.url, device.project.anonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

async function signIn(client: SupabaseClient): Promise<void> {
  await client.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: `${location.origin}${location.pathname}` } });
}

/** The daemon's files for `build`: from the cache, or over `conn`. */
async function assetsFor(conn: RelayConnection, build: string): Promise<StoredAssets> {
  const cached = await loadAssets().catch(() => undefined);
  if (cached?.build === build) return cached;
  show('Loading Agent Wrangler…', ['Fetching the workbench from your Mac. This happens once per update.']);
  const files = await new Promise<StoredAssets['files']>((resolve, reject) => {
    const got: StoredAssets['files'] = [];
    conn.onClose((reason) => reject(new Error(reason)));
    conn.onAsset((i) => {
      if (i.build !== build) return;
      got.push({ name: i.name, type: i.type, text: i.text });
      if (i.last) resolve(got);
    });
    conn.send({ k: 'assets', build });
  });
  const assets = { build, files };
  await saveAssets(assets).catch(() => undefined);
  return assets;
}

/** Build the workbench page from the daemon's files, with the first connection already open. */
function startWorkbench(assets: StoredAssets, first: RelayConnection, next: () => Promise<RelayConnection>): void {
  const file = (name: string) => assets.files.find((f) => f.name === name);
  const page = JSON.parse(file('page.json')?.text ?? '{}') as { body?: string; bodyClass?: string; styles?: string[]; scripts?: string[] };
  const url = (name: string) => {
    const f = file(name);
    if (!f) throw new Error(`missing ${name}`);
    return URL.createObjectURL(new Blob([f.text], { type: f.type }));
  };

  const meta = document.createElement('meta');
  meta.name = 'aw-build';
  meta.content = assets.build;
  document.head.appendChild(meta);
  for (const s of page.styles ?? []) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url(s);
    document.head.appendChild(link);
  }
  document.getElementById('loaderStyle')?.remove();
  document.body.className = page.bodyClass ?? '';
  // The daemon's own markup for this build (`src/ui/html.ts`): a few empty roots, no script.
  document.body.innerHTML = page.body ?? '';

  // The webshim asks for a socket each time it (re)connects: the first is the one already open.
  let pending: RelayConnection | undefined = first;
  (globalThis as { agentWranglerSocket?: () => WebSocket }).agentWranglerSocket = () => {
    const conn = pending ? Promise.resolve(pending) : next();
    pending = undefined;
    return new RelayWebSocket(
      conn,
      (build) => {
        if (build !== assets.build) location.reload();
      },
      (reason) => {
        if (reason === 'revoked') void forgetDevice().then(() => location.reload());
      },
    ) as unknown as WebSocket;
  };

  // In order: the webshim must define the bridge before the workbench looks for it.
  const scripts = page.scripts ?? [];
  const load = (i: number) => {
    if (i >= scripts.length) return;
    const el = document.createElement('script');
    el.src = url(scripts[i]);
    el.onload = () => load(i + 1);
    document.body.appendChild(el);
  };
  load(0);
}

async function main(): Promise<void> {
  const device = (await pairFromFragment()) ?? (await loadDevice().catch(() => undefined));
  if (!device) {
    show('Not paired yet', [
      'This page opens Agent Wrangler on your Mac from anywhere.',
      'On the Mac, open Preferences › Experimental › Remote control and press “Pair a device…”, then scan the code with this device’s camera.',
    ]);
    return;
  }
  const client = supabaseFor(device);
  const { data } = await client.auth.getSession();
  if (!data.session) {
    show('Sign in', ['This device is paired. Sign in with the GitHub account the Mac is signed in with.'], [
      { label: 'Sign in with GitHub', run: () => void signIn(client) },
      { label: 'Forget this pairing', tone: 'quiet', run: () => void forgetDevice().then(() => location.reload()) },
    ]);
    return;
  }
  await client.realtime.setAuth(data.session.access_token);
  const uid = data.session.user.id;
  const relayDevice: RelayDevice = { deviceId: device.deviceId, key: device.key };
  const live = new Set<RelayConnection>();
  const connect = async () => {
    const c = new RelayConnection(client, uid, relayDevice);
    live.add(c);
    c.onClose(() => live.delete(c));
    await c.open();
    return c;
  };
  // A closed or reloaded tab says so, rather than leaving the Mac to notice at the next ping.
  window.addEventListener('pagehide', () => {
    for (const c of live) c.close();
  });

  show('Connecting…', ['Reaching your Mac.']);
  let first: RelayConnection;
  try {
    first = await connect();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (why === 'not-owner') {
      show('Not allowed', ['Supabase refused this account. Sign in with the account that owns the project.'], [
        { label: 'Sign out', run: () => void client.auth.signOut().then(() => location.reload()) },
      ]);
      return;
    }
    const seen = await client.from('daemons').select('last_seen_at').order('last_seen_at', { ascending: false }).limit(1);
    const last = seen.data?.[0]?.last_seen_at as string | undefined;
    show(
      'Your Mac is not answering',
      [
        last ? `It last checked in ${new Date(last).toLocaleString()}.` : 'It has not checked in yet.',
        'Make sure it is awake, Agent Wrangler is running, and Remote control is on and signed in. If this device was revoked, pair it again.',
      ],
      [{ label: 'Try again', run: () => location.reload() }],
    );
    return;
  }
  const assets = await assetsFor(first, first.build);
  startWorkbench(assets, first, connect);
}

// A pairing link opened in a tab that already shows this page changes only the hash.
window.addEventListener('hashchange', () => {
  if (parsePairingFragment(location.hash)) location.reload();
});

void main().catch((e) => show('Something went wrong', [e instanceof Error ? e.message : String(e)], [{ label: 'Reload', run: () => location.reload() }]));

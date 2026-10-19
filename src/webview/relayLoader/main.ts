/**
 * The remote-control loader (#175; `docs/plans/remote-control-supabase.md` §1.2).
 *
 * The only thing Netlify serves. It knows nothing about any particular Mac or project: the
 * pairing link brings the project and the device key, GitHub sign-in (Supabase Auth) says who
 * is asking, and the Mac itself supplies the workbench: after connecting, the loader asks for
 * the files of the daemon's build, caches them, and builds the same page the Mac serves on
 * loopback, with the webshim's sockets carried over the relay.
 *
 * States, in order: not signed in (an email and password form, which also sets up a device
 * that has no key yet, #187) → connecting → (Mac unreachable) → running the workbench. Each
 * says what to do next. A QR pairing link still works and skips the setup.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { importRelayKey, parsePairingFragment, type RelayProject } from '../../shared/relay';
import { RelayConnection, RelayWebSocket, type RelayDevice } from './connection';
import { signInWithPassword } from './enroll';
import { pushOnConnect, watchPush } from './push';
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

/**
 * The Supabase project this site talks through: `project.json`, written beside the loader when
 * it is built for deploying (public values). A paired device also carries it.
 */
async function siteProject(): Promise<RelayProject | undefined> {
  try {
    const res = await fetch('/project.json', { cache: 'no-store' });
    if (!res.ok) return undefined;
    const p = (await res.json()) as { url?: unknown; anonKey?: unknown };
    return typeof p.url === 'string' && /^https:\/\/[^\s/]+$/.test(p.url) && typeof p.anonKey === 'string' && p.anonKey.length >= 20 ? { url: p.url, anonKey: p.anonKey } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The email and password form (#187). With no device stored it also sets this device up;
 * with one, it only signs in. Reloads the page once it has.
 */
function passwordForm(client: SupabaseClient, project: RelayProject, device: StoredDevice | undefined, error?: string): void {
  show(
    'Sign in',
    [
      device
        ? 'Sign in with the email and remote password set on your Mac.'
        : 'Sign in with your email and the remote password set on your Mac (Preferences › Remote control › Set password…). This also sets up this device.',
    ],
    [],
  );
  if (error) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = error;
    root.appendChild(p);
  }
  const form = document.createElement('form');
  const field = (label: string, input: HTMLInputElement) => {
    const l = document.createElement('label');
    l.textContent = label;
    l.htmlFor = input.id;
    form.append(l, input);
  };
  const email = document.createElement('input');
  email.id = 'email';
  email.type = 'email';
  email.autocomplete = 'username';
  email.required = true;
  email.value = localStorage.getItem('aw-email') ?? '';
  const password = document.createElement('input');
  password.id = 'password';
  password.type = 'password';
  password.autocomplete = 'current-password';
  password.required = true;
  field('Email', email);
  field('Password', password);
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'primary';
  submit.textContent = 'Sign in';
  form.appendChild(submit);
  root.appendChild(form);
  (email.value ? password : email).focus();

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    submit.textContent = device ? 'Signing in…' : 'Signing in and setting up…';
    void (async () => {
      const r = await signInWithPassword(client, email.value, password.value, !device);
      if (!r.ok) {
        const messages: Record<typeof r.why, string> = {
          credentials: 'Wrong email or password.',
          'not-owner': 'Supabase refused this account: it is not the project’s owner.',
          unreachable: 'Could not reach Supabase. Check the connection and try again.',
          'mac-silent':
            'Signed in, but your Mac did not set this device up. Make sure it is awake with Remote control connected, and that password sign-in is on (Preferences › Remote control). After 5 wrong attempts it pauses for an hour.',
          refused: 'Your Mac’s answer did not check out. Set the password on the Mac again, then retry.',
        };
        passwordForm(client, project, device, messages[r.why]);
        return;
      }
      localStorage.setItem('aw-email', email.value.trim());
      if (r.device) await saveDevice({ deviceId: r.device.deviceId, key: await importRelayKey(r.device.key), project, pairedAt: Date.now() });
      location.reload();
    })().catch((e) => passwordForm(client, project, device, e instanceof Error ? e.message : String(e)));
  });

  const github = document.createElement('button');
  github.type = 'button';
  github.className = 'quiet';
  github.textContent = 'Sign in with GitHub instead';
  github.title = 'Only for a device paired with a QR code.';
  github.addEventListener('click', () => void signIn(client));
  if (device) root.appendChild(github);
  if (device) {
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'quiet';
    forget.textContent = 'Forget this device';
    forget.addEventListener('click', () => void forgetDevice().then(() => location.reload()));
    root.appendChild(forget);
  }
}

async function main(): Promise<void> {
  const device = (await pairFromFragment()) ?? (await loadDevice().catch(() => undefined));
  const project = device?.project ?? (await siteProject());
  if (!project) {
    show('Not set up', [
      'This page opens Agent Wrangler on your Mac from anywhere, but this copy of it does not say which Supabase project to use.',
      'Pair with the QR code from the Mac (Preferences › Remote control › Pair with QR code…), or redeploy the site with its project.json.',
    ]);
    return;
  }
  const client = createClient(project.url, project.anonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data } = await client.auth.getSession();
  if (!device || !data.session) {
    // Signed in (by GitHub, say) but with no device: sign out first, so the form sets it up.
    if (!device && data.session) await client.auth.signOut({ scope: 'local' });
    passwordForm(client, project, device);
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
    pushOnConnect(c);
    return c;
  };
  watchPush();
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

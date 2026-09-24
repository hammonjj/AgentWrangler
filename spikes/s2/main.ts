/**
 * Spike S2 (#6): a stand-in for the Agent Wrangler core. THROWAWAY.
 *
 * Packaged as "AW Spike S2" (bundle id com.hammonjj.agentwrangler.spike-s2)
 * so it can never collide with the real app: its own name, its own userData
 * under /tmp, its own single-instance lock and its own Keychain item.
 *
 * Driven over a control socket (`/tmp/aw-spike-s2/run/core.sock`) by
 * `drive.ts`. It clones its own bundle into a runtime dir, spawns detached
 * hosts from the clone, stores host tokens (safeStorage and a 0600 file), and
 * records which quit path fired.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { app, BrowserWindow, Menu, powerMonitor, powerSaveBlocker, safeStorage } from 'electron';

declare const S2_BUILD: string;

const ROOT = '/tmp/aw-spike-s2';
const RUN = path.join(ROOT, 'run');
const LOGS = path.join(ROOT, 'logs');
const RUNTIMES = path.join(ROOT, 'runtimes');
const CLAUDE = '/opt/homebrew/bin/claude';

app.setName('AW Spike S2');
app.setPath('userData', path.join(ROOT, 'userData'));

fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
fs.chmodSync(RUN, 0o700);

const CORE_LOG = path.join(LOGS, 'core.log');
function log(msg: string): void {
  // Synchronous: the interesting lines are written while the process is dying.
  fs.appendFileSync(CORE_LOG, `[${new Date().toISOString()}] core ${process.pid} b=${S2_BUILD}: ${msg}\n`);
}

/** `sigtermHandler`: true = `process.on('SIGTERM')` at module load; 'afterReady' = inside whenReady. */
type Config = { sigtermHandler?: boolean | 'afterReady' };
let config: Config = {};
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'core-config.json'), 'utf8')) as Config;
} catch {
  /* defaults */
}

log(`start electron=${process.versions.electron} execPath=${process.execPath} config=${JSON.stringify(config)}`);

if (!app.requestSingleInstanceLock()) {
  log('second instance; quitting');
  app.quit();
}

// ---- quit-source instrumentation ---------------------------------------------------
let quitSource: string | undefined;
function installSigterm(when: string): void {
  process.on('SIGTERM', () => {
    quitSource = 'signal:SIGTERM';
    log(`process SIGTERM handler fired (installed ${when})`);
    app.quit();
  });
  log(`SIGTERM handler installed ${when}`);
}
if (config.sigtermHandler === true) installSigterm('at module load');
if (config.sigtermHandler === 'afterReady') {
  void app.whenReady().then(() => setTimeout(() => installSigterm('after ready + 1 s'), 1000));
}
app.on('before-quit', () => log(`before-quit source=${quitSource ?? 'UNFLAGGED (Apple Event / other)'}`));
app.on('will-quit', () => log(`will-quit source=${quitSource ?? 'UNFLAGGED'}`));
app.on('quit', (_e, code) => log(`quit exitCode=${code}`));
app.on('window-all-closed', () => log('window-all-closed (not quitting)'));
process.on('exit', (c) => log(`process exit ${c}`));
for (const ev of ['suspend', 'resume', 'shutdown', 'lock-screen', 'unlock-screen'] as const) {
  app.whenReady().then(() => powerMonitor.on(ev as 'suspend', () => log(`powerMonitor ${ev}`)));
}

// ---- timer drift ---------------------------------------------------------------------
const drift = { last: Date.now(), n: 0, max: 0, over1500: 0, sum: 0 };
setInterval(() => {
  const now = Date.now();
  const d = now - drift.last;
  drift.last = now;
  drift.n++;
  drift.sum += d;
  if (d > drift.max) drift.max = d;
  if (d > 1500) drift.over1500++;
}, 1000);

// ---- hosts -----------------------------------------------------------------------------
function bundlePath(): string {
  // .../X.app/Contents/MacOS/X → .../X.app
  return path.resolve(path.dirname(process.execPath), '..', '..');
}

function cloneRuntime(): { exe: string; appDir: string; ms: number; reused: boolean } {
  const dest = path.join(RUNTIMES, S2_BUILD, 'AW Spike S2 Host.app');
  const exe = path.join(dest, 'Contents', 'MacOS', 'AW Spike S2 Host');
  if (fs.existsSync(exe)) return { exe, appDir: dest, ms: 0, reused: true };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const t0 = Date.now();
  execFileSync('/bin/cp', ['-c', '-R', bundlePath(), dest]);
  fs.renameSync(path.join(dest, 'Contents', 'MacOS', 'AW Spike S2'), exe);
  return { exe, appDir: dest, ms: Date.now() - t0, reused: false };
}

const secretsFile = path.join(app.getPath('userData'), 'secrets.json');
function vault(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(secretsFile, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function spawnHost(p: { id: string; clone?: boolean; cwd?: string; leakEnv?: boolean }): unknown {
  const runtime = p.clone === false ? { exe: process.execPath, appDir: bundlePath(), ms: 0, reused: true } : cloneRuntime();
  const hostJs = path.join(runtime.appDir, 'Contents', 'Resources', 'app.asar', 'spikes', 's2', 'dist', 'host.js');
  const token = crypto.randomBytes(32).toString('base64url');
  const logFd = fs.openSync(path.join(LOGS, `host-${p.id}.log`), 'a');
  const args = [hostJs, '--id', p.id, '--run', RUN, '--cwd', p.cwd ?? path.join(ROOT, 'proj'), '--claude', CLAUDE];
  if (p.leakEnv) args.push('--leak-env');
  const child = spawn(runtime.exe, args, {
    detached: true,
    stdio: ['pipe', logFd, logFd],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AW_HOST_ID: p.id },
  });
  child.stdin!.end(`${token}\n`);
  child.unref();
  fs.closeSync(logFd);
  // Two stores, so a later build can test both.
  fs.writeFileSync(path.join(RUN, `${p.id}.token`), token, { mode: 0o600 });
  let safeMs = -1;
  let safeErr: string | undefined;
  try {
    const t0 = Date.now();
    const v = vault();
    v[p.id] = safeStorage.encryptString(token).toString('base64');
    fs.writeFileSync(secretsFile, JSON.stringify(v), { mode: 0o600 });
    safeMs = Date.now() - t0;
  } catch (err) {
    safeErr = String(err);
  }
  log(`spawned host ${p.id} pid=${child.pid} exe=${runtime.exe} cloneMs=${runtime.ms} reused=${runtime.reused}`);
  return { pid: child.pid, exe: runtime.exe, cloneMs: runtime.ms, reused: runtime.reused, safeEncryptMs: safeMs, safeErr };
}

/** Reattach from this core: read the token (file or safeStorage), hello, one call. */
async function hostCall(p: { id: string; tokenFrom: 'file' | 'safe'; call: { method: string; params?: unknown } }): Promise<unknown> {
  const t0 = Date.now();
  const token =
    p.tokenFrom === 'file'
      ? fs.readFileSync(path.join(RUN, `${p.id}.token`), 'utf8')
      : safeStorage.decryptString(Buffer.from(vault()[p.id], 'base64'));
  const tokenMs = Date.now() - t0;
  const manifest = JSON.parse(fs.readFileSync(path.join(RUN, `${p.id}.json`), 'utf8')) as { socket: string };
  const replies = await rpc(manifest.socket, [
    { id: 1, method: 'hello', params: { hostId: p.id, token } },
    { id: 2, ...p.call },
  ]);
  return { tokenFrom: p.tokenFrom, tokenMs, replies };
}

function rpc(sock: string, reqs: object[], timeoutMs = 120000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    const out: unknown[] = [];
    let buf = '';
    const timer = setTimeout(() => {
      c.destroy();
      reject(new Error('rpc timeout'));
    }, timeoutMs);
    c.setEncoding('utf8');
    c.on('connect', () => reqs.forEach((r) => c.write(`${JSON.stringify(r)}\n`)));
    c.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
      if (out.length >= reqs.length) {
        clearTimeout(timer);
        c.end();
        resolve(out);
      }
    });
    c.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ---- window, menu, control socket ------------------------------------------------------
let win: BrowserWindow | undefined;
let psbId: number | undefined;

function openWindow(): void {
  if (win && !win.isDestroyed()) return;
  win = new BrowserWindow({ width: 320, height: 160, show: false, title: 'AW Spike S2' });
  void win.loadURL('data:text/html,<body style="font:14px system-ui">AW Spike S2 (throwaway test app)</body>');
  win.once('ready-to-show', () => win?.showInactive());
  win.on('closed', () => {
    log('window closed');
    win = undefined;
  });
}

async function control(req: { method: string; params?: Record<string, unknown> }): Promise<unknown> {
  const p = (req.params ?? {}) as Record<string, unknown>;
  switch (req.method) {
    case 'status':
      return {
        pid: process.pid,
        build: S2_BUILD,
        execPath: process.execPath,
        windows: BrowserWindow.getAllWindows().length,
        safeAvailable: safeStorage.isEncryptionAvailable(),
        psb: psbId !== undefined ? powerSaveBlocker.isStarted(psbId) : false,
        rssKb: Math.round(process.memoryUsage().rss / 1024),
      };
    case 'spawnHost':
      return spawnHost(p as { id: string });
    case 'hostCall':
      return hostCall(p as Parameters<typeof hostCall>[0]);
    case 'closeWindow':
      win?.close();
      return { ok: true };
    case 'openWindow':
      openWindow();
      return { ok: true };
    case 'menuQuit': {
      const item = Menu.getApplicationMenu()?.getMenuItemById('quit');
      setTimeout(() => item?.click(), 50);
      return { ok: !!item };
    }
    case 'crash':
      setTimeout(() => process.crash(), 50);
      return { ok: true };
    case 'dock':
      if (p.hide) app.dock?.hide();
      else void app.dock?.show();
      return { ok: true };
    case 'psb':
      if (p.on) psbId = powerSaveBlocker.start('prevent-app-suspension');
      else if (psbId !== undefined) powerSaveBlocker.stop(psbId);
      return { id: psbId, started: psbId !== undefined ? powerSaveBlocker.isStarted(psbId) : false };
    case 'timers':
      if (p.reset) Object.assign(drift, { last: Date.now(), n: 0, max: 0, over1500: 0, sum: 0 });
      return { n: drift.n, maxMs: drift.max, over1500: drift.over1500, avgMs: drift.n ? Math.round(drift.sum / drift.n) : 0 };
    case 'readdir': {
      const t0 = Date.now();
      const timeoutMs = Number(p.timeoutMs ?? 15000);
      try {
        const names = await Promise.race([
          fsp.readdir(String(p.path)),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutMs} ms (TCC prompt?)`)), timeoutMs)),
        ]);
        return { ok: true, count: names.length, ms: Date.now() - t0 };
      } catch (err) {
        return { ok: false, error: String(err), ms: Date.now() - t0 };
      }
    }
    case 'safeRoundTrip': {
      // A throwaway value under this app's own Keychain item.
      const t0 = Date.now();
      const plain = safeStorage.decryptString(safeStorage.encryptString('aw-spike-s2-probe'));
      return { ok: plain === 'aw-spike-s2-probe', ms: Date.now() - t0 };
    }
    default:
      throw new Error(`unknown ${req.method}`);
  }
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'AW Spike S2',
        submenu: [
          {
            id: 'quit',
            label: 'Quit AW Spike S2',
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
              quitSource = 'menu';
              log('menu Quit clicked');
              app.quit();
            },
          },
        ],
      },
    ]),
  );
  openWindow();
  app.on('activate', () => openWindow());

  const sockPath = path.join(RUN, 'core.sock');
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* none */
  }
  net
    .createServer((s) => {
      let buf = '';
      s.setEncoding('utf8');
      s.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const req = JSON.parse(line) as { method: string; params?: Record<string, unknown> };
          log(`control ${req.method}`);
          control(req).then(
            (result) => s.write(`${JSON.stringify({ result })}\n`),
            (err: unknown) => s.write(`${JSON.stringify({ error: String(err) })}\n`),
          );
        }
      });
      s.on('error', () => undefined);
    })
    .listen(sockPath, () => {
      fs.chmodSync(sockPath, 0o600);
      log(`control socket ${sockPath}`);
    });
});

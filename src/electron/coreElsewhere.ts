/**
 * Whether this app runs the core, or the core daemon does (#130).
 *
 * Never two cores at once: two would be two session registries willing to
 * resume the same session id. So before `createApp`:
 *
 * - `experimental.coreDaemon` **on**: the app does not run the core. It makes
 *   sure the daemon is running (installing or updating its LaunchAgent when
 *   packaged), says where the core is, and quits. Until the window becomes a
 *   client of the daemon (#131) there is nothing for it to show.
 * - **off**: the app runs the core as it always has, unless a daemon already
 *   answers on `run/core.sock`. Then it says so and quits instead.
 *
 * The setting is read once, here: switching it takes a restart of the app.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { app, dialog } from 'electron';
import { socketAnswers } from '../core/control/probe';
import { CORE_DAEMON_SETTING, coreDaemonPaths, describeCoreHolder, findCoreHolder, readSetting } from '../core/daemon/coreDaemon';
import { createSessionHostRuntime } from '../core/session/sessionHostRuntime';
import { createCoreDaemonAgent } from '../node/coreDaemonAgent';

export interface CoreElsewhereOptions {
  userDataDir: string;
  appRoot: string;
  log: (message: string) => void;
}

/** True: the core is elsewhere and this process is quitting; the caller returns. */
export async function coreRunsElsewhere(opts: CoreElsewhereOptions): Promise<boolean> {
  const { userDataDir, log } = opts;
  const fallbackRunDir = path.join(os.homedir(), '.agentwrangler', 'run');
  const paths = coreDaemonPaths(userDataDir, fallbackRunDir);
  const quietly = app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin;

  if (!readSetting(userDataDir, CORE_DAEMON_SETTING, false)) {
    const holder = await findCoreHolder({ socketPath: paths.socketPath, manifestPath: paths.manifestPath, probe: socketAnswers });
    if (holder.kind === 'none') return false;
    log(`not running the core: ${describeCoreHolder(holder)}`);
    await dialog.showMessageBox({
      type: 'warning',
      message: 'Agent Wrangler is already running in the background',
      detail:
        `${capitalise(describeCoreHolder(holder))}, so this window will not start a second one.\n\n` +
        'Run "aw daemon stop" in a terminal to stop it (your conversations keep running), then open Agent Wrangler again. ' +
        'Or turn on "Run the core in the background" (experimental.coreDaemon) to keep using the daemon.',
      buttons: ['Quit'],
    });
    app.quit();
    return true;
  }

  log('experimental.coreDaemon is on: the core runs in the core daemon, not here');
  const agent = createCoreDaemonAgent({
    dataDir: userDataDir,
    fallbackRunDir,
    runtime: createSessionHostRuntime({ userDataDir, appRoot: opts.appRoot, isPackaged: app.isPackaged, execPath: process.execPath, log }),
    isPackaged: app.isPackaged,
    log,
  });
  try {
    const { outcome, manifest } = await agent.ensure();
    log(`core daemon: ${outcome}, pid ${manifest.pid}, build ${manifest.build}`);
    if (!quietly) {
      await dialog.showMessageBox({
        type: 'info',
        message: 'Agent Wrangler runs in the background',
        detail:
          `Its core is running as a background service (pid ${manifest.pid}), and keeps running when this window is closed. ` +
          'Open it in your browser with "aw web open" in a terminal; "aw status" and the other aw commands work as before.\n\n' +
          'To go back to running it in this window, turn off experimental.coreDaemon in settings.json, run "aw daemon stop", and open Agent Wrangler again.',
        buttons: ['OK'],
      });
    }
  } catch (err) {
    log(`core daemon: could not start it: ${String(err)}`);
    await dialog.showMessageBox({
      type: 'error',
      message: 'The Agent Wrangler background service did not start',
      detail: `${err instanceof Error ? err.message : String(err)}\n\nSee ${paths.logFile}.`,
      buttons: ['Quit'],
    });
  }
  app.quit();
  return true;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The layout of `Agent Wrangler.app` (#142), in one place: the packaging
 * script builds it, and the daemon, `aw`, the launcher and the session-host
 * runtime find their way around it.
 *
 * ```
 * Agent Wrangler.app/Contents/
 *   Info.plist                      bundle id com.hammonjj.agentwrangler
 *   MacOS/Agent Wrangler            the launcher (a small signed Mach-O)
 *   Resources/icon.icns
 *   Resources/node/bin/node         the pinned Node (#129, decision D1)
 *   Resources/app/dist/<program>/   daemon, sessionHost, cli, launcher, webview, …
 * ```
 *
 * No asar: everything is plain files the bundled Node reads directly.
 * Pure: no Node imports beyond `path`, no side effects.
 */
import * as path from 'node:path';

export const APP_NAME = 'Agent Wrangler';
/**
 * Kept from the Electron builds: macOS privacy grants (the microphone,
 * Automation for Terminal) are keyed by this id plus the signing certificate,
 * so changing it would silently drop them.
 */
export const BUNDLE_ID = 'com.hammonjj.agentwrangler';

/** `Contents/Resources/app`: the root the programs' `dist/` sits in. */
export const BUNDLE_APP_DIR = ['Contents', 'Resources', 'app'] as const;
/** `Contents/Resources/node/bin`: where the pinned Node is. */
export const BUNDLE_NODE_DIR = ['Contents', 'Resources', 'node', 'bin'] as const;
/** `Contents/MacOS`: the launcher, named after the app. */
export const BUNDLE_MACOS_DIR = ['Contents', 'MacOS'] as const;

/**
 * How a plain-Node program of ours (`dist/<name>/main.js`: the daemon, `aw`,
 * the launcher) was installed, from the directory it runs in:
 * `X.app/Contents/Resources/app/dist/<name>` in a bundle or a runtime clone of
 * one, `<checkout>/dist/<name>` otherwise. `appRoot` is the directory `dist/`
 * is in; `bundle` is the `.app` to clone.
 */
export function locateInstall(dir: string): { isPackaged: boolean; appRoot: string; bundle?: string } {
  const appRoot = path.resolve(dir, '..', '..');
  const parts = appRoot.split(/[\\/]/);
  const n = parts.length;
  if (n >= 4 && parts[n - 1] === 'app' && parts[n - 2] === 'Resources' && parts[n - 3] === 'Contents' && parts[n - 4].endsWith('.app')) {
    return { isPackaged: true, appRoot, bundle: path.resolve(appRoot, '..', '..', '..') };
  }
  return { isPackaged: false, appRoot };
}

/**
 * Packaging without electron-builder (#142): the pure half of
 * scripts/package-app.ts. What goes into Agent Wrangler.app and where, its
 * Info.plist, and the codesign and clang commands. Nothing here builds,
 * copies or signs anything.
 */
import { describe, expect, it } from 'vitest';
import {
  bundleManifest,
  clangArgs,
  codesignSteps,
  distEntries,
  LAUNCHER_PATH,
  missingFromManifest,
  renderInfoPlist,
  verifyArgs,
} from '../scripts/packaging/appBundle';
import { cloneLaunch } from '../src/core/session/sessionHostRuntime';
import { coreDaemonEntryFor, locateInstall } from '../src/core/daemon/coreDaemon';

/** What `dist/` holds after `npm run build` in a checkout that once built Electron. */
const DIST = [
  'daemon/main.js',
  'daemon/main.js.map',
  'sessionHost/main.js',
  'cli/main.js',
  'launcher/main.js',
  'webview/workbench.js',
  'webview/workbench.css',
  'webview/webshim.js',
  'webview/theme.css',
  'webview/dashboard.js',
  'webview/workbench.js.map',
  'qualification-fixtures/day-ranges/fixture.json',
  'qualification-fixtures/day-ranges/repo/src/days.ts',
  // Left over from Electron builds: never shipped.
  'electron/main.js',
  'electron/preload.js',
  'remoteDaemon/main.js',
  'extension.js',
];

describe('Info.plist', () => {
  const text = renderInfoPlist({ version: '0.0.1', build: 'mabc123', copyright: 'Copyright © 2026 James Hammond' });
  const value = (key: string) => new RegExp(`<key>${key}</key>\\n  (<string>([^<]*)</string>|<(true|false)/>)`).exec(text)?.slice(2).find(Boolean);

  it('keeps the bundle id privacy grants and Keychain items are keyed by', () => {
    expect(value('CFBundleIdentifier')).toBe('com.hammonjj.agentwrangler');
  });

  it('names the launcher as the executable, and the icon', () => {
    expect(value('CFBundleExecutable')).toBe('Agent Wrangler');
    expect(LAUNCHER_PATH).toBe('Contents/MacOS/Agent Wrangler');
    expect(value('CFBundleIconFile')).toBe('icon.icns');
    expect(value('CFBundlePackageType')).toBe('APPL');
  });

  it('has no Dock icon, and says why it may use the microphone', () => {
    expect(value('LSUIElement')).toBe('true');
    expect(value('NSMicrophoneUsageDescription')).toMatch(/Dictation/);
  });

  it('carries the version and the build', () => {
    expect(value('CFBundleShortVersionString')).toBe('0.0.1');
    expect(value('AWBuildID')).toBe('mabc123');
  });

  it('has nothing of Electron', () => {
    expect(text).not.toMatch(/Electron|AtomApplication|asar/i);
  });

  it('is a well-formed plist and escapes what it is given', () => {
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
    expect(text.trim().endsWith('</dict>\n</plist>')).toBe(true);
    expect(renderInfoPlist({ version: '1<2', build: 'b&c' })).toContain('<string>1&lt;2</string>');
    expect(renderInfoPlist({ version: '1', build: 'b&c' })).toContain('<string>b&amp;c</string>');
  });
});

describe('the file layout', () => {
  it('ships each program, the web page and the fixtures, under Contents/Resources/app/dist', () => {
    expect(distEntries(DIST).map((e) => e.to)).toEqual([
      'Contents/Resources/app/dist/cli/main.js',
      'Contents/Resources/app/dist/daemon/main.js',
      'Contents/Resources/app/dist/launcher/main.js',
      'Contents/Resources/app/dist/qualification-fixtures/day-ranges/fixture.json',
      'Contents/Resources/app/dist/qualification-fixtures/day-ranges/repo/src/days.ts',
      'Contents/Resources/app/dist/sessionHost/main.js',
      'Contents/Resources/app/dist/webview/dashboard.js',
      'Contents/Resources/app/dist/webview/theme.css',
      'Contents/Resources/app/dist/webview/webshim.js',
      'Contents/Resources/app/dist/webview/workbench.css',
      'Contents/Resources/app/dist/webview/workbench.js',
    ]);
  });

  it('never ships source maps or what Electron builds left in dist/', () => {
    const tos = distEntries(DIST).map((e) => e.to).join('\n');
    expect(tos).not.toMatch(/\.map$|electron|remoteDaemon|extension\.js/m);
  });

  it('adds the pinned Node (executable), its licence and the icon', () => {
    const m = bundleManifest(DIST);
    expect(m.slice(0, 3)).toEqual([
      { from: '.node-runtime/bin/node', to: 'Contents/Resources/node/bin/node', exec: true },
      { from: '.node-runtime/LICENSE', to: 'Contents/Resources/node/LICENSE' },
      { from: 'build/icon.icns', to: 'Contents/Resources/icon.icns' },
    ]);
    expect(missingFromManifest(m)).toEqual([]);
  });

  it('names what is missing from a half-built dist/', () => {
    const missing = missingFromManifest(bundleManifest(DIST.filter((f) => !f.startsWith('launcher/') && f !== 'webview/webshim.js')));
    expect(missing).toEqual(['Contents/Resources/app/dist/launcher/main.js', 'Contents/Resources/app/dist/webview/webshim.js']);
  });

  it('is the layout the runtime, the daemon and aw expect', () => {
    const app = '/Applications/Agent Wrangler.app';
    const m = bundleManifest(DIST).map((e) => `${app}/${e.to}`);
    // The session-host runtime clones the bundle and runs these (renamed in the clone).
    const clone = cloneLaunch(app);
    expect(m).toContain(clone.entry);
    expect(m).toContain(coreDaemonEntryFor(clone.entry));
    expect(m).toContain(`${app}/Contents/Resources/node/bin/node`);
    // Each program, run from where it was put, knows it is packaged and in which bundle.
    expect(locateInstall(`${app}/Contents/Resources/app/dist/launcher`)).toEqual({
      isPackaged: true,
      appRoot: `${app}/Contents/Resources/app`,
      bundle: app,
    });
  });
});

describe('build and signing commands', () => {
  it('compiles the launcher for the pinned Node’s architecture, warnings as errors', () => {
    expect(clangArgs('src/launcher/launcher.c', '/o', 'arm64')).toEqual([
      '-O2', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0', '-arch', 'arm64', '-o', '/o', 'src/launcher/launcher.c',
    ]);
    expect(clangArgs('s.c', '/o', 'x64')).toContain('x86_64');
  });

  it('signs the Node first, then the bundle, with the identity, no timestamp and no hardened runtime', () => {
    const steps = codesignSteps({ identity: 'Agent Wrangler Local Signing', bundle: '/r/Agent Wrangler.app', entitlements: '/e.plist' });
    expect(steps).toHaveLength(2);
    expect(steps[0].at(-1)).toBe('/r/Agent Wrangler.app/Contents/Resources/node/bin/node');
    expect(steps[1].at(-1)).toBe('/r/Agent Wrangler.app');
    for (const s of steps) {
      expect(s).toEqual(expect.arrayContaining(['--force', '--sign', 'Agent Wrangler Local Signing', '--timestamp=none', '--entitlements', '/e.plist']));
      expect(s.join(' ')).not.toMatch(/--options|runtime/);
    }
    expect(verifyArgs('/r/Agent Wrangler.app')).toEqual(['--verify', '--deep', '--strict', '--verbose=2', '/r/Agent Wrangler.app']);
  });
});

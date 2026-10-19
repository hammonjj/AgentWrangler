/**
 * The pure half of `scripts/package-app.ts` (#142): what goes into
 * `Agent Wrangler.app` and where, its Info.plist, and the codesign commands.
 * No file system, no processes, so it is tested (`test/packageApp.test.ts`).
 *
 * The layout is `src/core/appBundle.ts`'s; this decides which files from
 * `dist/` fill it.
 */
import { APP_NAME, BUNDLE_APP_DIR, BUNDLE_ID, BUNDLE_MACOS_DIR, BUNDLE_NODE_DIR } from '../../src/core/appBundle';

/** The plain-Node programs the bundle runs, each `dist/<name>/main.js`. */
export const PROGRAMS = ['daemon', 'sessionHost', 'cli', 'launcher'] as const;

/** Oldest macOS the bundle claims; the pinned Node 22 needs 11, the launcher is built for this. */
export const MIN_MACOS = '13.0';

export interface InfoPlistInput {
  /** `package.json`'s version. */
  version: string;
  /** The esbuild build id the bundles carry (`AW_BUILD_ID`), for diagnosis. */
  build: string;
  /** Default `© <year> James Hammond`. */
  copyright?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * `Contents/Info.plist`.
 *
 * - `CFBundleIdentifier` is the Electron builds' id on purpose: the
 *   microphone grant (host dictation's ffmpeg) and any Automation grant are
 *   keyed by it and the signing certificate.
 * - `LSUIElement`: no Dock icon. The launcher runs for a second or so and the
 *   browser is the app's window; a Dock icon would bounce and vanish.
 */
export function renderInfoPlist(input: InfoPlistInput): string {
  const entries: [string, string | boolean][] = [
    ['CFBundleDevelopmentRegion', 'en'],
    ['CFBundleDisplayName', APP_NAME],
    ['CFBundleExecutable', APP_NAME],
    ['CFBundleIconFile', 'icon.icns'],
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleName', APP_NAME],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleShortVersionString', input.version],
    ['CFBundleVersion', input.version],
    ['AWBuildID', input.build],
    ['LSApplicationCategoryType', 'public.app-category.developer-tools'],
    ['LSMinimumSystemVersion', MIN_MACOS],
    ['LSUIElement', true],
    ['NSHumanReadableCopyright', input.copyright ?? `Copyright © ${new Date().getFullYear()} James Hammond`],
    ['NSMicrophoneUsageDescription', 'Dictation can record from this Mac’s microphone when you ask it to.'],
  ];
  const body = entries.flatMap(([k, v]) => [
    `  <key>${esc(k)}</key>`,
    typeof v === 'boolean' ? `  <${v}/>` : `  <string>${esc(v)}</string>`,
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...body,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** One file to put in the bundle: `from` relative to the repo, `to` relative to the `.app`. */
export interface BundleEntry {
  from: string;
  to: string;
  /** Make it executable. */
  exec?: boolean;
}

/**
 * Which of the built files go into the bundle, and where. `distFiles` are
 * paths relative to `dist/` (as `fs.readdirSync(dist, { recursive: true })`
 * gives them, files only).
 *
 * In: each program's `main.js`; `webview/` (the page the daemon serves);
 * `qualification-fixtures/` (copied out per run, plan §19.6). Out: source
 * maps, and anything else a checkout's `dist/` has collected, such as the
 * Electron builds' `dist/electron/` and `dist/remoteDaemon/`.
 */
export function distEntries(distFiles: readonly string[]): BundleEntry[] {
  const appDist = [...BUNDLE_APP_DIR, 'dist'].join('/');
  const wanted = (f: string): boolean => {
    if (f.endsWith('.map')) return false;
    if ((PROGRAMS as readonly string[]).some((p) => f === `${p}/main.js`)) return true;
    return f.startsWith('webview/') || f.startsWith('qualification-fixtures/');
  };
  return distFiles
    .map((f) => f.split('\\').join('/'))
    .filter(wanted)
    .sort()
    .map((f) => ({ from: `dist/${f}`, to: `${appDist}/${f}` }));
}

/**
 * Everything but the launcher (which is compiled into place) and Info.plist:
 * the dist entries, the pinned Node staged by `scripts/fetch-node.mjs`, and
 * the icon.
 */
export function bundleManifest(distFiles: readonly string[]): BundleEntry[] {
  const nodeDir = BUNDLE_NODE_DIR.join('/');
  return [
    { from: '.node-runtime/bin/node', to: `${nodeDir}/node`, exec: true },
    { from: '.node-runtime/LICENSE', to: `${BUNDLE_NODE_DIR.slice(0, -1).join('/')}/LICENSE` },
    { from: 'build/icon.icns', to: 'Contents/Resources/icon.icns' },
    ...distEntries(distFiles),
  ];
}

/** What a bundle cannot run without; the script refuses to sign one missing any. */
export function missingFromManifest(entries: readonly BundleEntry[]): string[] {
  const have = new Set(entries.map((e) => e.to));
  const appDist = [...BUNDLE_APP_DIR, 'dist'].join('/');
  const required = [
    `${BUNDLE_NODE_DIR.join('/')}/node`,
    ...PROGRAMS.map((p) => `${appDist}/${p}/main.js`),
    `${appDist}/webview/workbench.js`,
    `${appDist}/webview/workbench.css`,
    `${appDist}/webview/webshim.js`,
    `${appDist}/webview/theme.css`,
  ];
  return required.filter((r) => !have.has(r));
}

/** Where the launcher goes. */
export const LAUNCHER_PATH = [...BUNDLE_MACOS_DIR, APP_NAME].join('/');

/** `clang` for the launcher, for one architecture (the pinned Node's). */
export function clangArgs(source: string, output: string, arch: 'arm64' | 'x64'): string[] {
  return ['-O2', '-Wall', '-Wextra', '-Werror', `-mmacosx-version-min=${MIN_MACOS}`, '-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-o', output, source];
}

/**
 * The codesign steps, innermost first: the Node (in `Resources`, so not
 * nested code `--deep` would find) gets its own signature, then the bundle,
 * which signs the launcher and seals every resource. Hardened runtime stays
 * off, as in the Electron builds; the entitlements are theirs too.
 */
export function codesignSteps(opts: { identity: string; bundle: string; entitlements: string }): string[][] {
  const base = ['--force', '--sign', opts.identity, '--timestamp=none', '--entitlements', opts.entitlements];
  return [
    [...base, '--identifier', 'node', `${opts.bundle}/${BUNDLE_NODE_DIR.join('/')}/node`],
    [...base, opts.bundle],
  ];
}

/** The check after signing. */
export function verifyArgs(bundle: string): string[] {
  return ['--verify', '--deep', '--strict', '--verbose=2', bundle];
}

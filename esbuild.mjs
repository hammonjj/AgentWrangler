import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');

/**
 * Baked into the main process and the session host. The build id is what a
 * host reports in `hello` and what names its cloned runtime, so two builds are
 * never mistaken for each other; the SDK version is part of the host
 * protocol's compatibility story (playbook §9.6).
 */
const BUILD_ID = `${Date.now().toString(36)}`;
const SDK_VERSION = JSON.parse(
  readFileSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'),
).version;
const buildDefines = {
  AW_BUILD_ID: JSON.stringify(BUILD_ID),
  AW_SDK_VERSION: JSON.stringify(SDK_VERSION),
};

// The tasks.json background problem matcher keys on these exact strings.
const watchLogger = {
  name: 'watch-logger',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const e of result.errors) {
        const loc = e.location ? `${e.location.file}:${e.location.line}:${e.location.column}` : '';
        console.error(`✘ [ERROR] ${e.text} ${loc}`);
      }
      console.log('[watch] build finished');
    });
  },
};

/**
 * Electron main process and preload.
 *
 * Two bundles because they run in two processes with different privileges: the
 * preload is what the renderer is given, so nothing but the three bridge
 * methods may be reachable from it, and bundling it with the main process would
 * put the whole application in the renderer's address space.
 *
 * `electron` is external in both — it is supplied by the runtime, the way
 * `vscode` is by the editor. The Agent SDK's `import.meta.url` workaround is
 * the same one the extension bundle needs, for the same reason.
 */
const electronMain = {
  entryPoints: ['src/electron/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  outfile: 'dist/electron/main.js',
  sourcemap: true,
  minify: false,
  define: { 'import.meta.url': '__aw_import_meta_url', ...buildDefines },
  banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
  plugins: [watchLogger],
};

/**
 * The session host (playbook §5, Stage 3): a plain Node program the app runs
 * detached, from a clone of its own bundle with `ELECTRON_RUN_AS_NODE=1`. It
 * owns one Claude session and outlives the app. No `electron` import at all.
 */
const sessionHost = {
  entryPoints: ['src/sessionHost/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/sessionHost/main.js',
  sourcemap: true,
  minify: false,
  define: { 'import.meta.url': '__aw_import_meta_url', ...buildDefines },
  banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
  plugins: [watchLogger],
};

const electronPreload = {
  entryPoints: ['src/electron/preload.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  outfile: 'dist/electron/preload.js',
  sourcemap: true,
  minify: false,
  plugins: [watchLogger],
};

/** Browser bundles, one per webview. entryNames '[dir]' collapses
 * src/webview/dashboard/main.ts -> dist/webview/dashboard.js (+ dashboard.css).
 * The theme entry is a bare stylesheet — the 56 `--vscode-*` values VSCode
 * injects and a desktop window has to be given — and collapses the same way,
 * to dist/webview/theme.css. */
const web = {
  entryPoints: [
    'src/webview/dashboard/main.ts',
    'src/webview/conversation/main.ts',
    'src/webview/workbench/main.ts',
    'src/webview/preferences/main.ts',
    'src/webview/palette/main.ts',
    'src/webview/theme/vscodeTokens.css',
  ],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outdir: 'dist/webview',
  entryNames: '[dir]',
  sourcemap: true,
  minify: false,
  plugins: [watchLogger],
};

const configs = [web, electronMain, electronPreload, sessionHost];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

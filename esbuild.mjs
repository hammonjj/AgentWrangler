import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

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

/** Extension-host bundle (Node). */
const host = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
  minify: false,
  // The Claude Agent SDK ships as ESM and calls `createRequire(import.meta.url)`
  // at load. Bundled to CJS that expression is empty and the module throws
  // before it exports anything, so point it at this file's own URL.
  define: { 'import.meta.url': '__aw_import_meta_url' },
  banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
  plugins: [watchLogger],
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
  external: ['electron', 'vscode'],
  outfile: 'dist/electron/main.js',
  sourcemap: true,
  minify: false,
  define: { 'import.meta.url': '__aw_import_meta_url' },
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

const configs = [host, web, electronMain, electronPreload];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

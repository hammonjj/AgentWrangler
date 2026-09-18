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

/** Browser bundles, one per webview. entryNames '[dir]' collapses
 * src/webview/dashboard/main.ts -> dist/webview/dashboard.js (+ dashboard.css). */
const web = {
  entryPoints: ['src/webview/dashboard/main.ts', 'src/webview/conversation/main.ts', 'src/webview/workbench/main.ts'],
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

if (watch) {
  const [hostCtx, webCtx] = await Promise.all([esbuild.context(host), esbuild.context(web)]);
  await Promise.all([hostCtx.watch(), webCtx.watch()]);
} else {
  await Promise.all([esbuild.build(host), esbuild.build(web)]);
}

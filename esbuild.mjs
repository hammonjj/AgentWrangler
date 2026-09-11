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
  plugins: [watchLogger],
};

/** Browser bundles, one per webview. entryNames '[dir]' collapses
 * src/webview/dashboard/main.ts -> dist/webview/dashboard.js (+ dashboard.css). */
const web = {
  entryPoints: ['src/webview/dashboard/main.ts', 'src/webview/conversation/main.ts'],
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

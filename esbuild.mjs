import esbuild from 'esbuild';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * Every program is plain Node, run on the app bundle's pinned Node
 * (scripts/fetch-node.mjs, #129; keep `target` in step with its version).
 * Electron was retired in #142.
 *
 * The session host (playbook §5, Stage 3): a program the core daemon runs
 * detached, from a clone of its own bundle. It owns one Claude session and
 * outlives the daemon. The Agent SDK needs the `import.meta.url` workaround
 * in a CommonJS bundle.
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

/**
 * The core daemon (#130): `createApp`, the control socket and the web
 * workbench, run by launchd from the same cloned runtime, on its bundled Node.
 */
const coreDaemon = {
  ...sessionHost,
  entryPoints: ['src/daemon/main.ts'],
  outfile: 'dist/daemon/main.js',
};

/**
 * The `aw` command-line client (#21): `bin/aw` runs it on the installed app's
 * bundled Node, from `Contents/Resources/app/dist/cli`.
 */
const cli = {
  entryPoints: ['src/cli/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/cli/main.js',
  sourcemap: true,
  minify: false,
  define: buildDefines,
  plugins: [watchLogger],
};

/**
 * The app bundle's launcher script (#142): `Contents/MacOS/Agent Wrangler`
 * execs the bundled Node on it. Makes sure the core daemon runs, then opens
 * the browser on a sign-in link.
 */
const launcher = {
  ...cli,
  entryPoints: ['src/launcher/main.ts'],
  outfile: 'dist/launcher/main.js',
};

/** Browser bundles. entryNames '[dir]' collapses
 * src/webview/dashboard/main.ts -> dist/webview/dashboard.js (+ dashboard.css).
 * The page the web server renders loads `workbench` (which imports the
 * dashboard, conversation and preferences panes) after `webshim`; the
 * standalone dashboard and conversation bundles are for
 * scripts/verify-conversation-ui.ts. The theme entry is a bare stylesheet —
 * the 56 `--vscode-*` values VSCode injects and a browser has to be given —
 * and collapses the same way, to dist/webview/theme.css. */
const web = {
  entryPoints: [
    'src/webview/dashboard/main.ts',
    'src/webview/conversation/main.ts',
    'src/webview/workbench/main.ts',
    'src/webview/webshim/main.ts',
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

/**
 * The remote-control loader (#175): the static site Netlify serves, `dist/relay-site/`.
 * One bundle (with supabase-js) plus the files in `static/`. It holds no workbench code:
 * the Mac sends that over the relay.
 */
const relaySite = {
  entryPoints: { loader: 'src/webview/relayLoader/main.ts' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outdir: 'dist/relay-site',
  sourcemap: false,
  minify: true,
  plugins: [watchLogger],
};

const configs = [web, relaySite, sessionHost, coreDaemon, cli, launcher];

rmSync('dist/relay-site', { recursive: true, force: true });
cpSync('src/webview/relayLoader/static', 'dist/relay-site', { recursive: true });

/**
 * The web icons (#162): one set, made from the app icon by `scripts/make-web-icons.sh`.
 * The workbench serves them from `dist/webview/icons/` (`src/shared/installable.ts`);
 * the relay site has them at its root, where its manifest and `sw.js` expect them.
 */
rmSync('dist/webview/icons', { recursive: true, force: true });
cpSync('src/webview/icons', 'dist/webview/icons', { recursive: true });
cpSync('src/webview/icons', 'dist/relay-site', { recursive: true });
writeRelayProject();

/**
 * The loader's `project.json` (#187): which Supabase project a device with nothing stored
 * signs in to. Taken from this Mac's own settings (`remote.relay.url`, `remote.relay.anonKey`,
 * both public values) so it is never committed. Absent when they are not set.
 */
function writeRelayProject() {
  const file = join(process.env.HOME ?? '', 'Library/Application Support/Agent Wrangler/settings.json');
  if (!existsSync(file)) return;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    const url = String(s['remote.relay.url'] ?? '').trim().replace(/\/+$/, '');
    const anonKey = String(s['remote.relay.anonKey'] ?? '').trim();
    if (url && anonKey) writeFileSync('dist/relay-site/project.json', `${JSON.stringify({ url, anonKey })}\n`);
  } catch {
    // An unreadable settings file leaves the site without one, as on another machine.
  }
}

/**
 * Qualification stage 2's scratch-repo fixtures (plan §19.6), which the core
 * copies into a temp dir per run. Plain files, not bundled: they are the repos
 * an agent works in. `createApp` finds them at `dist/qualification-fixtures`,
 * beside `dist/daemon`.
 */
rmSync('dist/qualification-fixtures', { recursive: true, force: true });
cpSync('src/orchestration/local/qualification-fixtures', 'dist/qualification-fixtures', { recursive: true });

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

/**
 * Spike S2: bundle the spike core + host and package "AW Spike S2.app" into
 * spikes/s2/out/ (never /Applications). THROWAWAY.
 *
 *   node spikes/s2/build.ts <buildId>
 *
 * The build id is baked into both bundles, so two builds differ in content and
 * therefore in their ad-hoc cdhash, like two `app:install`s of the real app.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..', '..');
const buildId = process.argv[2] ?? `b${Date.now()}`;

const common = {
  bundle: true,
  format: 'cjs' as const,
  platform: 'node' as const,
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  define: { 'import.meta.url': '__aw_import_meta_url', S2_BUILD: JSON.stringify(buildId) },
  banner: { js: "var __aw_import_meta_url = require('url').pathToFileURL(__filename).href;" },
};

await esbuild.build({ ...common, entryPoints: [path.join(root, 'spikes/s2/main.ts')], outfile: path.join(root, 'spikes/s2/dist/main.js') });
await esbuild.build({ ...common, entryPoints: [path.join(root, 'spikes/s2/host.ts')], outfile: path.join(root, 'spikes/s2/dist/host.js') });

execFileSync(path.join(root, 'node_modules/.bin/electron-builder'), ['--config', 'spikes/s2/electron-builder.yml', '--mac', '--dir'], {
  cwd: root,
  stdio: 'inherit',
});
console.log(`built ${buildId}`);

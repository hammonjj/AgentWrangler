/**
 * Stage the pinned Node runtime the app bundle ships (#129, decision D1).
 *
 * Everything in the app runs on this Node, from
 * `Contents/Resources/node/bin/node`: the launcher, the core daemon, session
 * hosts and `bin/aw`. It is an official nodejs.org build, pinned here by
 * version and SHA-256 (from that release's SHASUMS256.txt), so a build never
 * picks up whatever Node happens to be on the machine.
 *
 * The version follows the bundles' esbuild target (`node22`). To move it:
 * change NODE_VERSION, copy the two darwin `.tar.gz` lines from
 * https://nodejs.org/dist/v<version>/SHASUMS256.txt into SHA256, and change
 * the esbuild targets with it.
 *
 * - The tarball is cached in `node_modules/.cache/agent-wrangler-node/`:
 *   ignored by git, and shared by every worktree through their
 *   `node_modules` symlink, so rebuilds and new worktrees do not download it
 *   again. A cached file is checked against the pinned hash each time.
 * - Only `bin/node` and the licence are staged, into `.node-runtime/`
 *   (ignored by git), which scripts/package-app.ts copies to
 *   `Resources/node` and signs with the rest of the bundle.
 *
 * Usage: `node scripts/fetch-node.mjs` (the host's arch; `AW_NODE_ARCH=x64`
 * for the other one). Run by `npm run app:package` before scripts/package-app.ts.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_VERSION = '22.23.3';
export const SHA256 = {
  arm64: '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53',
  x64: '8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8',
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = path.join(root, 'node_modules', '.cache', 'agent-wrangler-node');
const stageDir = path.join(root, '.node-runtime');

const arch = process.env.AW_NODE_ARCH || process.arch;
const expected = SHA256[arch];
if (!expected) {
  console.error(`fetch-node: no pinned Node for darwin-${arch}`);
  process.exit(1);
}
const name = `node-v${NODE_VERSION}-darwin-${arch}`;
const tarball = path.join(cacheDir, `${name}.tar.gz`);
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`;
const stamp = `${name} ${expected}\n`;
const stampFile = path.join(stageDir, 'STAMP');

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp && existsSync(path.join(stageDir, 'bin', 'node'))) {
  console.log(`fetch-node: ${name} already staged`);
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });
if (existsSync(tarball) && sha256(tarball) !== expected) {
  console.warn(`fetch-node: cached ${name}.tar.gz does not match the pinned hash; downloading it again`);
  rmSync(tarball, { force: true });
}
if (!existsSync(tarball)) {
  console.log(`fetch-node: downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`fetch-node: ${url} answered ${res.status}`);
    process.exit(1);
  }
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== expected) {
    console.error(`fetch-node: ${name}.tar.gz has SHA-256 ${got}, pinned ${expected}. Not using it.`);
    process.exit(1);
  }
  // Into place in one step: another worktree may be reading the cache.
  const tmp = `${tarball}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, tarball);
}

const tmpStage = `${stageDir}.tmp-${process.pid}`;
rmSync(tmpStage, { recursive: true, force: true });
mkdirSync(tmpStage, { recursive: true });
execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', tmpStage, '--strip-components=1', `${name}/bin/node`, `${name}/LICENSE`]);
if (arch === process.arch) {
  const v = execFileSync(path.join(tmpStage, 'bin', 'node'), ['--version'], { encoding: 'utf8' }).trim();
  if (v !== `v${NODE_VERSION}`) {
    console.error(`fetch-node: the staged node says ${v}, expected v${NODE_VERSION}`);
    process.exit(1);
  }
}
writeFileSync(path.join(tmpStage, 'STAMP'), stamp);
rmSync(stageDir, { recursive: true, force: true });
renameSync(tmpStage, stageDir);
console.log(`fetch-node: staged ${name} in .node-runtime/`);

/**
 * Assemble and sign `release/Agent Wrangler.app` (#142), with no Electron
 * and no electron-builder: the pinned Node, the built programs, a compiled
 * launcher and an Info.plist (`scripts/packaging/appBundle.ts` says what goes
 * where).
 *
 * `npm run app:package` runs `npm run build` and `scripts/fetch-node.mjs`
 * first, then this, bundled by esbuild into `release/.package-app.cjs`.
 *
 * Signs with the self-signed "Agent Wrangler Local Signing" certificate
 * (`npm run app:signing-setup`; `AW_SIGN_IDENTITY` names another). A missing
 * identity is an error, not an unsigned bundle: macOS privacy grants are
 * keyed by the signature (#56), and an unsigned build would silently lose
 * them. Then `codesign --verify --deep --strict`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_NAME } from '../src/core/appBundle';
import {
  bundleManifest,
  clangArgs,
  codesignSteps,
  LAUNCHER_PATH,
  missingFromManifest,
  renderInfoPlist,
  verifyArgs,
} from './packaging/appBundle';

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const bundle = path.join(release, `${APP_NAME}.app`);
const identity = process.env.AW_SIGN_IDENTITY || 'Agent Wrangler Local Signing';
const arch = (process.env.AW_NODE_ARCH || process.arch) as 'arm64' | 'x64';

function fail(message: string): never {
  process.stderr.write(`package-app: ${message}\n`);
  process.exit(1);
}

function step(message: string): void {
  process.stdout.write(`package-app: ${message}\n`);
}

const tool = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---- Inputs ----
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'launcher', 'main.js'))) fail('dist/ is not built (or is from before #142): run npm run build');
if (!fs.existsSync(path.join(root, '.node-runtime', 'bin', 'node'))) fail('no staged Node: run node scripts/fetch-node.mjs');
if (arch !== 'arm64' && arch !== 'x64') fail(`no launcher build for ${arch}`);

const distFiles = (fs.readdirSync(dist, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(dist, f)).isFile());
const manifest = bundleManifest(distFiles);
const missing = missingFromManifest(manifest);
if (missing.length) fail(`the bundle would be missing ${missing.join(', ')}`);

const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
const build = /build (\S+),/.exec(tool(path.join(root, '.node-runtime', 'bin', 'node'), [path.join(dist, 'daemon', 'main.js'), '--version']))?.[1];
if (!build) fail('could not read the build id from dist/daemon/main.js --version');

const identities = tool('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
if (!identities.includes(`"${identity}"`)) {
  fail(`no valid code-signing identity "${identity}" in the keychain. Create it once with npm run app:signing-setup.`);
}

// ---- Assemble ----
step(`assembling ${path.relative(root, bundle)} (build ${build}, ${arch})`);
fs.rmSync(bundle, { recursive: true, force: true });
fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), renderInfoPlist({ version, build }));
fs.writeFileSync(path.join(bundle, 'Contents', 'PkgInfo'), 'APPL????');

for (const e of manifest) {
  const to = path.join(bundle, e.to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, e.from), to);
  if (e.exec) fs.chmodSync(to, 0o755);
}
step(`copied ${manifest.length} files`);

const launcher = path.join(bundle, LAUNCHER_PATH);
try {
  tool('/usr/bin/clang', clangArgs(path.join(root, 'src', 'launcher', 'launcher.c'), launcher, arch));
} catch (err) {
  fail(`could not compile the launcher with clang (install the Xcode command line tools: xcode-select --install): ${String((err as { stderr?: string }).stderr ?? err)}`);
}
step('compiled the launcher');

// ---- Sign and verify ----
const entitlements = path.join(root, 'build', 'entitlements.mac.plist');
for (const args of codesignSteps({ identity, bundle, entitlements })) {
  try {
    tool('/usr/bin/codesign', args);
  } catch (err) {
    fail(`codesign ${args[args.length - 1]} failed: ${String((err as { stderr?: string }).stderr ?? err)}`);
  }
}
try {
  execFileSync('/usr/bin/codesign', verifyArgs(bundle), { stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  fail(`the signed bundle does not verify: ${String((err as { stderr?: Buffer }).stderr ?? err)}`);
}
step(`signed as "${identity}" and verified: ${bundle}`);

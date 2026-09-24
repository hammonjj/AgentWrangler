// Spike S4 (#8): option (b), Codex's own `app-server daemon`, run ONLY inside an isolated
// CODEX_HOME (/tmp/aw-spike-s4/home-b) so James's ~/.codex, his VS Code extension and any
// real daemon are untouched. The mock model server is started detached alongside it.
//
// Usage: node spikes/s4/daemon.ts up          start mock + `daemon start`, write daemon-state.json
//        node spikes/s4/daemon.ts <subcmd...> run `codex app-server daemon <subcmd...>` in home-b
//        node spikes/s4/daemon.ts down        `daemon stop`, kill the mock
// CODEX_BIN picks the binary (default: newest extension bundle).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, codexBinaries, makeHome, codexEnv, alive } from './env.ts';

const statePath = path.join(ROOT, 'daemon-state.json');
const binary = process.env.CODEX_BIN ?? codexBinaries()[0];
const [command = 'up', ...rest] = process.argv.slice(2);

function run(args: string[], home: string): void {
  const started = Date.now();
  const result = spawnSync(binary, ['app-server', 'daemon', ...args], { env: codexEnv(home), encoding: 'utf8', timeout: 120000, input: '' });
  console.log(JSON.stringify({ cmd: `daemon ${args.join(' ')}`, bin: path.basename(path.dirname(path.dirname(path.dirname(binary)))), status: result.status, ms: Date.now() - started, stdout: result.stdout?.trim(), stderr: result.stderr?.trim().slice(-2000) }, null, 1));
}

if (command === 'up') {
  fs.mkdirSync(ROOT, { recursive: true });
  const logFd = fs.openSync(path.join(ROOT, 'mock-daemon.log.out'), 'a');
  const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mockResponses.ts')], {
    env: { ...process.env, MOCK_LOG: path.join(ROOT, 'mock-daemon.log'), SLOW_MS: '20000', MOCK_PORT: '0' },
    stdio: ['ignore', 'pipe', logFd], detached: true,
  });
  const port = await new Promise<number>((resolve) => { mock.stdout!.setEncoding('utf8'); mock.stdout!.once('data', (d) => resolve(Number(String(d).trim()))); });
  mock.stdout!.destroy();
  mock.unref();
  const home = makeHome('home-b', port);
  fs.writeFileSync(statePath, JSON.stringify({ home, mockPort: port, mockPid: mock.pid }, null, 1));
  run(['start'], home);
  run(['version'], home);
} else {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (command === 'down') {
    run(['stop'], state.home);
    if (alive(state.mockPid)) process.kill(state.mockPid, 'SIGTERM');
  } else {
    run([command, ...rest], state.home);
  }
}

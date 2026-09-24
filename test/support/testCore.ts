/**
 * A stand-in for the app's core, run as its own process so a test can SIGKILL
 * it (playbook §16: "Core crashes"). Bundled by the test and run with Node.
 *
 * argv[2] is JSON: `{root, runDir, logDir, bundle, sessionId, then?}`. It
 * starts a hosted session, sends `hello`, waits for the echo, sends `then` if
 * given (without waiting for it), prints `READY`, and then waits to be killed.
 */
import * as path from 'node:path';
import { HostSupervisor } from '../../src/core/session/hostSupervisor';
import { spawnHostedClaude } from '../../src/core/session/remoteClaudeHandle';

interface Args {
  root: string;
  runDir: string;
  logDir: string;
  bundle: string;
  sessionId: string;
  then?: string;
}

async function main(): Promise<void> {
  const a = JSON.parse(process.argv[2]) as Args;
  const supervisor = new HostSupervisor({
    runDir: a.runDir,
    fallbackRunDir: path.join(a.root, 'fb'),
    logDir: a.logDir,
    runtime: { buildId: 'test', prepare: async () => ({ exe: process.execPath, entry: a.bundle }) },
    log: () => undefined,
    build: 'test',
    hostEnv: { AW_SESSION_HOST_FAKE: '1' },
  });
  const view = spawnHostedClaude(
    { cwd: a.root, sessionId: a.sessionId },
    { supervisor, binary: '/fake', log: () => undefined, loadHistory: async () => ({ blocks: [], truncated: false }) },
  );
  view.start();
  await view.send('hello');
  const deadline = Date.now() + 15_000;
  while (!view.blocks.some((b) => 'text' in b && b.text === 'echo: hello')) {
    if (Date.now() > deadline) throw new Error('no echo');
    await new Promise((r) => setTimeout(r, 25));
  }
  if (a.then) void view.send(a.then);
  await new Promise((r) => setTimeout(r, 100));
  process.stdout.write('READY\n');
  setInterval(() => undefined, 60_000);
}

main().catch((err) => {
  process.stderr.write(`test core failed: ${String(err)}\n`);
  process.exit(1);
});

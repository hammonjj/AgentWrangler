/**
 * Spike S2: App Nap / timer-drift phases on a windowless spike core, plus one
 * host, each `phaseS` long. THROWAWAY.
 *
 *   node appnap.ts <hostId> [phaseS]
 *
 * Phases: A window open (app launched with `open -g`, so not frontmost);
 * B window closed + Dock icon hidden (the §5.5 windowless core);
 * C as B + powerSaveBlocker('prevent-app-suspension').
 */
import { execFileSync } from 'node:child_process';

const [hostId, phaseArg] = process.argv.slice(2);
const phaseS = Number(phaseArg ?? 150);
const here = new URL('.', import.meta.url).pathname;

function drive(...args: string[]): string {
  return execFileSync('node', ['--no-warnings', `${here}drive.ts`, ...args], { encoding: 'utf8' }).trim();
}
const core = (m: string, p: object = {}): string => drive('core', JSON.stringify({ method: m, params: p }));
const host = (m: string, p: object = {}): string => drive('host', hostId, JSON.stringify({ method: m, params: p }));
const wait = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

async function phase(name: string): Promise<void> {
  core('timers', { reset: true });
  host('timers', { reset: true });
  await wait(phaseS);
  const c = core('timers');
  const h = JSON.parse(host('timers')) as { result?: unknown }[];
  console.log(`${name}: core ${c} | host ${JSON.stringify(h[1]?.result ?? h[1])}`);
}

core('openWindow');
await phase('A window open, app in background');
core('closeWindow');
core('dock', { hide: true });
await phase('B windowless, Dock hidden');
console.log(`psb: ${core('psb', { on: true })}`);
console.log(execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' }).split('\n').filter((l) => /AW Spike/i.test(l)).join('\n') || '(no pmset assertion line naming AW Spike)');
await phase('C windowless + powerSaveBlocker(prevent-app-suspension)');
console.log(`psb off: ${core('psb', { on: false })}`);

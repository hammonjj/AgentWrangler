/**
 * The environment `claude` runs with, built explicitly by the host.
 *
 * The host itself runs with `ELECTRON_RUN_AS_NODE=1` (that is how an Electron
 * binary runs a plain Node script), and inherits the LaunchServices variables
 * the app was started with. Left alone, all of it reaches `claude` and every
 * Bash or npm command it runs: an `electron` launched from a tool would then
 * behave as Node, and the tool would claim to be Agent Wrangler (spike S2,
 * playbook §11.6). Pure, so the rule is testable.
 */

const STRIPPED_EXACT = new Set(['__CFBundleIdentifier', 'XPC_SERVICE_NAME']);
const STRIPPED_PREFIXES = ['ELECTRON_', 'AW_'];

export function agentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (STRIPPED_EXACT.has(key)) continue;
    if (STRIPPED_PREFIXES.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}

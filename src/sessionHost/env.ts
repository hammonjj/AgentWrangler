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

/**
 * Set for every agent a host runs (Stage 4, decided §22). AW's
 * `PermissionRequest` hook script reads it: it still logs the prompt, so the
 * row shows the session waiting, but it does not wait for a decision file. A
 * hosted session's asks are then answerable only through its host, which only
 * a client holding the host's token can reach; a file any local process can
 * write is not a way in.
 */
export const HOSTED_ENV = 'AGENTWRANGLER_HOSTED';

export function agentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (STRIPPED_EXACT.has(key)) continue;
    if (STRIPPED_PREFIXES.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  out[HOSTED_ENV] = '1';
  return out;
}

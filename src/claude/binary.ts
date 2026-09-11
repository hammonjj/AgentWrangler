/**
 * Which `claude` to run.
 *
 * Three candidates, and they are routinely different versions: whatever the
 * user configured, the copy bundled inside the installed Claude Code VSCode
 * extension, and whatever is on `PATH`. The bundled one is what the Claude Code
 * panel itself runs, so it is the one whose behaviour matches what the user
 * sees everywhere else — a Homebrew `claude` can easily be several versions
 * behind. Prefer it, and fall back to `PATH` only when it is not there.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Version-sorted so "10" beats "9", which a plain string sort gets wrong. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const EXT_DIR_RE = /^anthropic\.claude-code-(\d+(?:\.\d+)*)-/;

/** The newest `claude` bundled with an installed Claude Code extension, if any. */
export function bundledClaudeBinary(extensionsDir = path.join(os.homedir(), '.vscode', 'extensions')): string | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(extensionsDir);
  } catch {
    return undefined;
  }
  const candidates: { version: string; binary: string }[] = [];
  for (const name of names) {
    const m = EXT_DIR_RE.exec(name);
    if (!m) continue;
    const binary = path.join(extensionsDir, name, 'resources', 'native-binary', 'claude');
    try {
      if (fs.statSync(binary).isFile()) candidates.push({ version: m[1], binary });
    } catch {
      // A partially installed or pruned extension directory; skip it.
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0].binary;
}

/**
 * @param configured `agentWrangler.claudeBinaryPath`. Anything other than the
 *   default `'claude'` is an explicit choice and wins outright.
 */
export function resolveClaudeBinary(configured: string, extensionsDir?: string): string {
  const trimmed = configured.trim();
  if (trimmed && trimmed !== 'claude') return trimmed;
  return bundledClaudeBinary(extensionsDir) ?? 'claude';
}

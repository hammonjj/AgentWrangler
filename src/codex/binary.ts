import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface BinaryOptions {
  extensionsDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** GUI hosts may not inherit the PATH containing the OpenAI extension's CLI. */
export function resolveCodexBinary(configured: string, options: BinaryOptions = {}): string {
  const explicit = configured.trim();
  if (explicit && explicit !== 'codex') return explicit;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const systems: Record<string, string> = { darwin: 'macos', linux: 'linux', win32: 'windows' };
  const cpus: Record<string, string> = { arm64: 'aarch64', x64: 'x86_64' };
  const system = systems[platform];
  const cpu = cpus[arch];
  if (!system || !cpu) return 'codex';
  const root = options.extensionsDir ?? path.join(os.homedir(), '.vscode', 'extensions');
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return 'codex'; }
  const candidates = names.flatMap((name) => {
    const match = /^openai\.chatgpt-(\d+(?:\.\d+)*)(?:-|$)/.exec(name);
    return match ? [{ name, version: match[1].split('.').map(Number) }] : [];
  });
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const difference = (b.version[i] ?? 0) - (a.version[i] ?? 0);
      if (difference) return difference;
    }
    return a.name.localeCompare(b.name);
  });
  for (const { name } of candidates) {
    const binary = path.join(root, name, 'bin', `${system}-${cpu}`, platform === 'win32' ? 'codex.exe' : 'codex');
    try {
      if (!fs.statSync(binary).isFile()) continue;
      fs.accessSync(binary, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return binary;
    } catch { /* Skip incomplete, pruned, or non-executable installations. */ }
  }
  return 'codex';
}

/** Load the allow/deny rules a Claude session runs under, from its settings files. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionRules } from './permissionPolicy';

/** Pull `permissions.allow` / `permissions.deny` out of one parsed settings file. Foreign JSON: be defensive. */
export function rulesFromSettings(json: unknown): PermissionRules {
  const perms = (json as { permissions?: unknown } | null)?.permissions;
  const pick = (k: 'allow' | 'deny'): string[] => {
    const v = (perms as Record<string, unknown> | undefined)?.[k];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  };
  return { allow: pick('allow'), deny: pick('deny') };
}

export function mergeRules(...all: PermissionRules[]): PermissionRules {
  return { allow: all.flatMap((r) => r.allow), deny: all.flatMap((r) => r.deny) };
}

/** User, project and local settings for a working directory. Missing or unreadable files count as empty. */
export function loadPermissionRules(cwd: string, env: NodeJS.ProcessEnv = process.env): PermissionRules {
  const userDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [
    path.join(userDir, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  return mergeRules(
    ...files.map((f) => {
      try {
        return rulesFromSettings(JSON.parse(fs.readFileSync(f, 'utf8')));
      } catch {
        return { allow: [], deny: [] };
      }
    }),
  );
}

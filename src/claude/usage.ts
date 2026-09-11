/**
 * Plan usage, read the way Claude Code's own `/usage` reads it: the OAuth
 * access token Claude Code keeps for the signed-in account, sent to the same
 * endpoint it uses (`GET /api/oauth/usage`, seen in the 2.1.227 binary as
 * `fetchUtilization`). Nothing here is written anywhere; the token is read,
 * used for one request, and dropped.
 *
 * Where the token lives:
 *  - macOS: the login Keychain, generic password service `Claude Code-credentials`,
 *    a JSON blob with `claudeAiOauth.accessToken`.
 *  - elsewhere: `~/.claude/.credentials.json`, same JSON shape.
 *
 * Claude Code refreshes the token itself whenever one of its sessions talks to
 * the API, so an expired token here is a passing state, not something to fix.
 */
import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { UsageLimit, UsageSnapshot } from '../shared/model';
import { claudeHome } from './paths';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const FETCH_TIMEOUT_MS = 15_000;

export interface OAuthToken {
  accessToken: string;
  /** ms epoch; undefined when the blob did not say. */
  expiresAtMs?: number;
}

/** Pull the access token out of the credentials JSON Claude Code writes. */
export function tokenFromCredentialsJson(text: string): OAuthToken | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth as
    | { accessToken?: unknown; expiresAt?: unknown }
    | undefined;
  if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) return undefined;
  return {
    accessToken: oauth.accessToken,
    expiresAtMs: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
  };
}

function readKeychain(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? undefined : stdout.trim()),
    );
  });
}

async function readCredentialsFile(): Promise<string | undefined> {
  try {
    return await fsp.readFile(path.join(claudeHome(), '.credentials.json'), 'utf8');
  } catch {
    return undefined;
  }
}

/** The signed-in account's token, or undefined when nobody is signed in here. */
export async function readOAuthToken(platform: NodeJS.Platform = process.platform): Promise<OAuthToken | undefined> {
  if (platform === 'darwin') {
    const fromKeychain = await readKeychain();
    if (fromKeychain) {
      const tok = tokenFromCredentialsJson(fromKeychain);
      if (tok) return tok;
    }
  }
  const fromFile = await readCredentialsFile();
  return fromFile ? tokenFromCredentialsJson(fromFile) : undefined;
}

// ---- response parsing ----

interface WindowJson {
  utilization?: number | null;
  resets_at?: string | null;
}

interface LimitJson {
  kind?: string;
  group?: string;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null; surface?: string | null } | null;
  is_active?: boolean | null;
}

export interface UsageResponseJson {
  five_hour?: WindowJson | null;
  seven_day?: WindowJson | null;
  seven_day_opus?: WindowJson | null;
  seven_day_sonnet?: WindowJson | null;
  limits?: LimitJson[] | null;
}

function toMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function labelFor(l: LimitJson): { id: string; label: string } {
  switch (l.kind) {
    case 'session':
      return { id: 'session', label: 'Session (5hr)' };
    case 'weekly_all':
      return { id: 'weekly_all', label: 'Weekly (7 day)' };
    case 'weekly_scoped': {
      const name = l.scope?.model?.display_name ?? l.scope?.surface ?? 'scoped';
      return { id: `weekly_scoped:${name}`, label: `Weekly ${name}` };
    }
    default: {
      const kind = l.kind ?? 'limit';
      return { id: kind, label: kind.replace(/_/g, ' ') };
    }
  }
}

/**
 * The `limits` array is what Claude Code renders and is already in display
 * order with labels attached, so it is the source when present. Older shapes
 * only have the per-window objects; those are mapped to the same three rows.
 */
export function parseUsageResponse(json: UsageResponseJson, nowMs: number): UsageSnapshot {
  const limits: UsageLimit[] = [];

  if (Array.isArray(json.limits) && json.limits.length > 0) {
    for (const l of json.limits) {
      if (typeof l.percent !== 'number') continue;
      const { id, label } = labelFor(l);
      limits.push({
        id,
        label,
        percent: Math.max(0, Math.round(l.percent)),
        severity: l.severity ?? 'normal',
        resetsAtMs: toMs(l.resets_at),
        isActive: l.is_active === true,
      });
    }
  } else {
    const fallback: [string, string, WindowJson | null | undefined][] = [
      ['session', 'Session (5hr)', json.five_hour],
      ['weekly_all', 'Weekly (7 day)', json.seven_day],
      ['weekly_scoped:Opus', 'Weekly Opus', json.seven_day_opus],
      ['weekly_scoped:Sonnet', 'Weekly Sonnet', json.seven_day_sonnet],
    ];
    for (const [id, label, w] of fallback) {
      if (!w || typeof w.utilization !== 'number') continue;
      limits.push({
        id,
        label,
        percent: Math.max(0, Math.round(w.utilization)),
        severity: 'normal',
        resetsAtMs: toMs(w.resets_at),
        isActive: false,
      });
    }
  }

  return { fetchedAtMs: nowMs, limits };
}

export class UsageFetchError extends Error {
  constructor(
    message: string,
    /** True when retrying soon is pointless (no token, token rejected). */
    readonly permanent = false,
  ) {
    super(message);
  }
}

/** One request. Throws `UsageFetchError` with a sentence fit for the dashboard. */
export async function fetchUsage(token: OAuthToken, nowMs = Date.now()): Promise<UsageSnapshot> {
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': 'agent-wrangler',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    throw new UsageFetchError(name === 'TimeoutError' ? 'the usage request timed out' : 'the usage request failed (offline?)');
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageFetchError(
      'Claude Code’s sign-in token was rejected; it refreshes the next time a session talks to the API',
      true,
    );
  }
  if (res.status === 429) throw new UsageFetchError('the usage endpoint asked us to slow down');
  if (!res.ok) throw new UsageFetchError(`the usage endpoint answered HTTP ${res.status}`);

  let json: UsageResponseJson;
  try {
    json = (await res.json()) as UsageResponseJson;
  } catch {
    throw new UsageFetchError('the usage endpoint returned something that was not JSON');
  }
  return parseUsageResponse(json, nowMs);
}

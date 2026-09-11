/**
 * Reads plan usage the way Claude Code's own `/usage` does: the OAuth access
 * token Claude Code stored at login, sent to `GET /api/oauth/usage`.
 *
 * Credentials are read, never written. Claude Code owns the token's lifecycle
 * (it refreshes on expiry when it next talks to the API); refreshing from here
 * would race it and could invalidate the refresh token, so a rejected token is
 * reported as `unauthorized` and simply retried later.
 *
 * Where the token lives (verified against Claude Code 2.1.x):
 *  - macOS: Keychain generic password, service "Claude Code-credentials",
 *    value = JSON `{ claudeAiOauth: { accessToken, … } }`.
 *  - elsewhere: `~/.claude/.credentials.json` with the same JSON.
 */
import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseUsage, type UsageError, type UsageSnapshot } from '../shared/usage';
import { claudeHome } from './paths';

const execFileP = promisify(execFile);

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const REQUEST_TIMEOUT_MS = 10_000;

interface StoredCredentials {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number };
}

async function readKeychain(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileP('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      timeout: 5000,
    });
    const s = stdout.trim();
    return s.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

async function readCredentialsFile(): Promise<string | undefined> {
  try {
    return await fsp.readFile(path.join(claudeHome(), '.credentials.json'), 'utf8');
  } catch {
    return undefined;
  }
}

/** The stored OAuth access token, or undefined when there is no Claude Code login here. */
export async function readAccessToken(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const raw = platform === 'darwin' ? (await readKeychain()) ?? (await readCredentialsFile()) : await readCredentialsFile();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as StoredCredentials;
    const tok = parsed.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok.length > 0 ? tok : undefined;
  } catch {
    return undefined;
  }
}

export type UsageFetchResult = { ok: true; snapshot: UsageSnapshot } | { ok: false; error: UsageError };

/** One read of plan usage. Never throws; every failure is a typed `UsageError`. */
export async function fetchUsage(nowMs = Date.now(), fetchImpl: typeof fetch = fetch): Promise<UsageFetchResult> {
  const token = await readAccessToken();
  if (!token) return { ok: false, error: { kind: 'no-credentials', atMs: nowMs } };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        Accept: 'application/json',
        'User-Agent': 'agent-wrangler',
      },
      signal: ctl.signal,
    });
  } catch (err) {
    return { ok: false, error: { kind: 'network', detail: shortError(err), atMs: nowMs } };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: { kind: 'unauthorized', detail: `HTTP ${res.status}`, atMs: nowMs } };
  }
  if (!res.ok) {
    return { ok: false, error: { kind: 'bad-response', detail: `HTTP ${res.status}`, atMs: nowMs } };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: { kind: 'bad-response', detail: 'not JSON', atMs: nowMs } };
  }
  const snapshot = parseUsage(body, nowMs);
  if (!snapshot) return { ok: false, error: { kind: 'bad-response', detail: 'no limits in body', atMs: nowMs } };
  return { ok: true, snapshot };
}

function shortError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'timed out';
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ?? err.message;
  }
  return String(err);
}

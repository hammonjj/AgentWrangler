/**
 * The daemon signing in to Supabase as the owner (#173; plan §2.1).
 *
 * GitHub OAuth with PKCE. Preferences › Remote control › Connect opens the authorise URL in
 * the browser that pressed it; GitHub and Supabase send that browser back to this daemon's
 * loopback listener at `/remote/callback?code=…`, and the daemon exchanges the code (with the
 * verifier it kept in memory) for a session. Only the refresh token is kept, in the Keychain.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const RELAY_CALLBACK_PATH = '/remote/callback';
/** The Keychain item (`HostSecrets`) holding the daemon's Supabase refresh token. */
export const RELAY_REFRESH_TOKEN_SECRET = 'remote.relay.refreshToken';
/** The Keychain item holding the enrollment key derived from the remote password (#187). */
export const RELAY_ENROLL_KEY_SECRET = 'remote.relay.enrollKey';
/** A sign-in not finished in this long is forgotten. */
const PENDING_MS = 10 * 60 * 1000;

/** A tiny storage for supabase-js: the PKCE verifier lives here between the two halves. */
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

export interface RelaySignIn {
  /** Where to send the browser. */
  url: string;
  /** Finish with the code the callback brought; resolves with the refresh token. */
  finish(code: string): Promise<string>;
  readonly startedAt: number;
}

export async function startRelaySignIn(opts: { url: string; anonKey: string; callbackUrl: string; now?: number }): Promise<RelaySignIn> {
  const client: SupabaseClient = createClient(opts.url, opts.anonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage: new MemoryStorage() },
  });
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: opts.callbackUrl, skipBrowserRedirect: true },
  });
  if (error || !data.url) throw new Error(error?.message ?? 'Supabase gave no sign-in address');
  return {
    url: data.url,
    startedAt: opts.now ?? Date.now(),
    async finish(code) {
      const r = await client.auth.exchangeCodeForSession(code);
      if (r.error || !r.data.session) throw new Error(r.error?.message ?? 'the sign-in did not complete');
      return r.data.session.refresh_token;
    },
  };
}

/** Whether a pending sign-in is still worth finishing. */
export function signInFresh(pending: RelaySignIn | undefined, now: number): pending is RelaySignIn {
  return !!pending && now - pending.startedAt < PENDING_MS;
}

/** Revoke a refresh token's session (Disconnect). Best effort: the token is forgotten either way. */
export async function signOutRelay(opts: { url: string; anonKey: string; refreshToken: string }): Promise<void> {
  const client = createClient(opts.url, opts.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data } = await client.auth.refreshSession({ refresh_token: opts.refreshToken });
  if (data.session) await client.auth.signOut({ scope: 'local' });
}

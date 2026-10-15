/**
 * The relay's network over Supabase (#173): Realtime Broadcast on private topics, and the
 * `public.daemons` heartbeat. Signed in as the owner with a refresh token the daemon keeps in
 * the Keychain (`relayAuth.ts`); supabase-js refreshes the access token, and every new refresh
 * token is handed back to be stored, since Supabase rotates them.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { RelayChannel, RelayNetwork } from './network';

export interface SupabaseNetworkOptions {
  url: string;
  anonKey: string;
  refreshToken: string;
  /** A rotated refresh token, to store in place of the old one. */
  onRefreshToken(token: string): void;
  /** The session ended (signed out elsewhere, or the token was refused). */
  onSignedOut(): void;
  log(line: string): void;
  joinTimeoutMs?: number;
}

/** Sign in with the stored refresh token. Rejects when it no longer works. */
export async function connectSupabaseNetwork(opts: SupabaseNetworkOptions): Promise<RelayNetwork & { login: string }> {
  const client: SupabaseClient = createClient(opts.url, opts.anonKey, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: { params: { log_level: 'error' } },
  });
  const { data, error } = await client.auth.refreshSession({ refresh_token: opts.refreshToken });
  if (error || !data.session || !data.user) {
    await client.removeAllChannels().catch(() => undefined);
    throw new Error(error?.message ?? 'the stored sign-in no longer works');
  }
  let current = data.session.refresh_token;
  opts.onRefreshToken(current);
  await client.realtime.setAuth(data.session.access_token);
  const sub = client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session) {
      opts.onSignedOut();
      return;
    }
    if (session.refresh_token && session.refresh_token !== current) {
      current = session.refresh_token;
      opts.onRefreshToken(current);
    }
    void client.realtime.setAuth(session.access_token);
  });

  const uid = data.user.id;
  const meta = data.user.user_metadata as { user_name?: unknown; preferred_username?: unknown } | undefined;
  const login = typeof meta?.user_name === 'string' ? meta.user_name : typeof meta?.preferred_username === 'string' ? meta.preferred_username : data.user.email ?? uid;
  const timeout = opts.joinTimeoutMs ?? 15_000;

  return {
    uid,
    login,
    join(topic, joinOpts) {
      const channel = client.channel(topic, { config: { private: true, broadcast: { self: false, ack: true }, presence: { key: '' } } });
      const listeners = new Map<string, ((p: unknown) => void)[]>();
      return new Promise<RelayChannel>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          void client.removeChannel(channel);
          reject(new Error(`joining ${topic.split(':').slice(0, 1)}:… timed out`));
        }, timeout);
        channel.subscribe((status, err) => {
          if (status === 'SUBSCRIBED' && !settled) {
            settled = true;
            clearTimeout(timer);
            if (joinOpts?.presence) void channel.track(joinOpts.presence);
            resolve({
              send: async (event, payload) => {
                const r = await channel.send({ type: 'broadcast', event, payload });
                if (r !== 'ok') throw new Error(`broadcast ${r}`);
              },
              on: (event, listener) => {
                const list = listeners.get(event);
                if (list) {
                  list.push(listener);
                  return;
                }
                listeners.set(event, [listener]);
                channel.on('broadcast', { event }, (m) => {
                  for (const l of listeners.get(event) ?? []) l(m.payload);
                });
              },
              leave: async () => {
                await client.removeChannel(channel);
              },
            });
          } else if ((status === 'CHANNEL_ERROR' || status === 'CLOSED') && !settled) {
            settled = true;
            clearTimeout(timer);
            void client.removeChannel(channel);
            reject(new Error(err?.message ?? `join ${status.toLowerCase()}`));
          } else if (status === 'CHANNEL_ERROR' && settled) {
            opts.log(`relay: channel error: ${err?.message ?? 'unknown'}`);
          }
        });
      });
    },
    async heartbeat(daemonId, build) {
      const { error: e } = await client.from('daemons').upsert({ id: daemonId, build: build.slice(0, 64), last_seen_at: new Date().toISOString() });
      if (e) throw new Error(e.message);
    },
    dispose() {
      sub.data.subscription.unsubscribe();
      void client.removeAllChannels().catch(() => undefined);
      client.auth.stopAutoRefresh().catch(() => undefined);
    },
  };
}
